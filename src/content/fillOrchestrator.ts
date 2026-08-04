import { applyValuesToInstances, reconcileAppliedValues } from "./apply";
import { getUnresolvedCandidates, visibleFillableFields } from "./candidates";
import { buildChunks } from "./chunking";
import { advanceFormStep, detectMultiStepHints, hasForwardNavigationControl, inferWizardStepCount } from "./navigation";
import { RunState } from "./runState";
import type { ScanResult } from "./scan";
import { resolveDocumentLocale, resolveFillLocale, scanFormFields } from "./scan";
import { settle, waitForDomQuiet, waitForNewFields } from "./settle";
import { validateAiResponse } from "./validate";
import {
  clearCheckpoint,
  formKeyFromLocation,
  reserveVariationSeed,
  saveCheckpoint,
  type FillCheckpoint,
} from "./runPersistence";
import { buildSeededPersona, tryHeuristicValue } from "../shared/heuristics";
import { isFillableField } from "../shared/fillable";
import { MAX_FORM_STEPS } from "../shared/types";
import type {
  ChunkDescriptor,
  ExtensionSettings,
  FieldDescriptor,
  FillSnapshot,
  FillRunResult,
  LlmFillResponse,
  RunContext,
  ValidationIssue,
} from "../shared/types";

/** Hard ceiling so a pathological page cannot request forever. */
const MAX_ROUNDS_CEILING = 60;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_CONSECUTIVE_AI_ERRORS = 3;
/** Attempts on one chunk before it is declared stuck, so a bad field cannot loop forever. */
const MAX_CHUNK_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Chunk state machine
// ---------------------------------------------------------------------------

type ChunkStatus =
  | "pending"
  | "in_progress"
  | "rate_limited"
  | "completed"
  | "partial"
  | "failed";

interface ChunkState {
  id: string;
  sectionName: string;
  fieldSids: string[];
  status: ChunkStatus;
  attempts: number;
  appliedSids: string[];
  /** Unresolved sids to re-send on the next attempt. */
  retrySids: string[];
  /** Why the last attempt fell short, fed back to the model verbatim. */
  lastIssues: ValidationIssue[];
}

function makeChunkState(descriptor: ChunkDescriptor, index: number): ChunkState {
  return {
    id: `chunk-${index}`,
    sectionName: descriptor.sectionName,
    fieldSids: descriptor.fieldSids,
    status: "pending",
    attempts: 0,
    appliedSids: [],
    retrySids: [],
    lastIssues: [],
  };
}

/**
 * Visit every section once before retrying leftovers.
 *
 * Preferring partial chunks first burned the whole round budget on one stuck
 * field while later required sections (username, password, …) never got a turn.
 */
function findNextChunk(chunks: ChunkState[]): ChunkState | null {
  return (
    chunks.find((chunk) => chunk.status === "pending") ??
    chunks.find((chunk) => chunk.status === "rate_limited") ??
    chunks.find((chunk) => chunk.status === "partial" && chunk.attempts < MAX_CHUNK_ATTEMPTS) ??
    null
  );
}

/**
 * Long single-page forms easily produce more chunks than the user's configured
 * round setting. Scale the budget to cover one pass over every chunk plus a
 * small retry allowance, without exceeding the hard ceiling.
 */
function resolveMaxRounds(settings: ExtensionSettings, chunkCount: number): number {
  const configured = Math.min(MAX_ROUNDS_CEILING, Math.max(1, settings.maxRounds));
  const retryAllowance = Math.min(chunkCount, 10);
  const needed = Math.max(1, chunkCount + retryAllowance);
  return Math.min(MAX_ROUNDS_CEILING, Math.max(configured, needed));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendMessage<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response as T);
    });
  });
}

function shouldAutoAdvance(settings: ExtensionSettings): boolean {
  return settings.autoNextEnabled;
}

function resolveMaxFormSteps(settings: ExtensionSettings): number {
  if (!shouldAutoAdvance(settings)) return 1;
  const detected = inferWizardStepCount();
  const configured = Math.max(1, settings.autoNextMaxSteps);
  // The detected count raises the cap but never lowers it: step indicators are
  // often incomplete on the first step of a dynamically built wizard.
  return Math.min(MAX_FORM_STEPS, Math.max(configured, detected));
}

/**
 * A form is finished when nothing fillable is left. Reaching that state and then
 * finding no forward control is success, not the failure the previous
 * implementation reported: what remains is a final submit deliberately left to
 * the user.
 */
function isFormExhausted(
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
): boolean {
  const scan = scanFormFields();
  return getUnresolvedCandidates(scan.fields, settings, appliedValues).length === 0;
}

function requiredUnresolved(
  fields: FieldDescriptor[],
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
): FieldDescriptor[] {
  return getUnresolvedCandidates(fields, settings, appliedValues).filter((field) => field.required);
}

function describeField(field: FieldDescriptor): string {
  return (
    field.labelText?.trim() ||
    field.ariaLabel?.trim() ||
    field.placeholder?.trim() ||
    field.name ||
    field.syntheticId
  );
}

/**
 * Waits for fields to appear that we have not already resolved.
 *
 * A newly rendered step, or a field revealed by a checkbox, both surface here.
 */
async function waitForFillableFields(
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
  timeoutMs = 8000,
): Promise<ScanResult> {
  const probe = (): ScanResult | null => {
    const scan = scanFormFields();
    return getUnresolvedCandidates(scan.fields, settings, appliedValues).length > 0 ? scan : null;
  };

  const found = await waitForNewFields(probe, {
    timeoutMs,
    intervalMs: Math.max(150, settings.settleMs),
  });

  return found ?? scanFormFields();
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface OrchestrationResume {
  nextStep: number;
  maxSteps: number;
  stepsCompleted: number;
  fieldsFilled: number;
  warnings: string[];
  context: RunContext;
}

export async function runFillOrchestration(
  settings: ExtensionSettings,
  onStatus?: (message: string) => void,
  resume?: OrchestrationResume,
): Promise<FillRunResult> {
  const warnings: string[] = [...(resume?.warnings ?? [])];
  const report = (message: string): void => {
    warnings.push(message);
    onStatus?.(message);
  };

  const state = resume
    ? RunState.resumeFrom(resume.context, resume.nextStep)
    : new RunState(await reserveVariationSeed());
  const docLocale = resolveDocumentLocale();
  const fillLocale = resolveFillLocale(
    settings.fillLanguage,
    settings.fillLocaleOverride,
    docLocale,
  );

  // Concrete persona from the seed — heuristics and the LLM both reuse it, so
  // runs stop collapsing onto the model's favourite stock names.
  const persona = buildSeededPersona(state.context.variationSeed, fillLocale);
  state.seedPersona(persona.identity, persona.sketch);

  const maxSteps = resume?.maxSteps ?? resolveMaxFormSteps(settings);
  const autoAdvance = shouldAutoAdvance(settings);
  const startStep = resume?.nextStep ?? 1;

  let stepsCompleted = resume?.stepsCompleted ?? 0;
  let fieldsFilled = resume?.fieldsFilled ?? 0;
  let providerRequestsThisRun = 0;
  /** Set when the run ended early in a way the user should know about. */
  let stopReason: string | null = null;
  /** Set when the run ended cleanly at the end of the form. */
  let finishedNote: string | null = null;

  const trackUsage = (response: LlmFillResponse | { httpCallsUsed?: number }): void => {
    const used = response.httpCallsUsed ?? 0;
    if (used <= 0) return;
    providerRequestsThisRun += used;
    onStatus?.(
      `Provider requests this run: ${providerRequestsThisRun}` +
        (typeof (response as LlmFillResponse).promptChars === "number"
          ? ` (~${(response as LlmFillResponse).promptChars} prompt chars)`
          : ""),
    );
  };

  if (resume) {
    onStatus?.(
      `Resumed after page navigation at step ${startStep} (${fieldsFilled} field(s) filled so far).`,
    );
    // SPA/full-reload wizards often paint the shell before the step fields.
    // Waiting here prevents a false "empty step" that re-clicks Continue.
    await waitForFillableFields(settings, state.appliedValues, 12_000);
  }

  const persistBeforeNavigation = async (nextStep: number): Promise<void> => {
    let tabId: number | undefined;
    try {
      const res = await sendMessage<{ tabId?: number }>({ type: "GET_OWN_TAB_ID" });
      tabId = res.tabId;
    } catch {
      // Resume matching will fail closed without a tab id.
    }

    const checkpoint: FillCheckpoint = {
      version: 1,
      formKey: formKeyFromLocation(),
      tabId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nextStep,
      maxSteps,
      stepsCompleted,
      fieldsFilled,
      warnings: [...warnings],
      context: {
        variationSeed: state.context.variationSeed,
        facts: { ...state.context.facts },
        identity: { ...state.context.identity },
        stepSummaries: [...state.context.stepSummaries],
      },
    };
    await saveCheckpoint(checkpoint);
  };

  try {
    for (let step = startStep; step <= maxSteps; step++) {
      const outcome = await runSingleStep({
        settings,
        state,
        stepNumber: step,
        fillLocale,
        docLocale,
        onStatus,
        report,
        onUsage: trackUsage,
      });

      fieldsFilled += outcome.filledCount;

      if (outcome.fatalError) {
        await clearCheckpoint();
        return { ok: false, warnings, stepsCompleted, fieldsFilled };
      }

      stepsCompleted += 1;

      if (outcome.stuckMessage) {
        stopReason = outcome.stuckMessage;
        break;
      }

      if (!autoAdvance) {
        if (detectMultiStepHints().length > 0) {
          report(
            "This looks like a multi-step form, but automatic advancing is switched off in settings.",
          );
        }
        break;
      }

      if (step >= maxSteps) {
        stopReason = `Reached the ${maxSteps}-step limit.`;
        break;
      }

      // Review / confirmation steps often have nothing left to fill and only a
      // final Submit. Stop here instead of pressing it.
      if (
        isFormExhausted(settings, state.appliedValues) &&
        !hasForwardNavigationControl(false)
      ) {
        finishedNote =
          "Reached the end of the form. The final submit was left for you to press.";
        break;
      }

      // Persist before the click so a full-page navigation can resume on the
      // next document. Cleared again if we stay on this page.
      await persistBeforeNavigation(step + 1);

      const scan = scanFormFields();
      const advance = await advanceFormStep({
        settings,
        allowFinalSubmit: false,
        fillLocale,
        documentLocale: docLocale,
        beforeFields: scan.fields,
        unresolvedRequiredCount: requiredUnresolved(scan.fields, settings, state.appliedValues)
          .length,
        onStatus,
      });

      if (!advance.advanced) {
        await clearCheckpoint();

        // The wizard refused: give the model the page's own complaints and retry
        // this step once before giving up. Ignore "form submitted" style alerts —
        // those mean we already hit a terminal action, not a fixable field error.
        const repairableIssues = (advance.validationErrors ?? []).filter(
          (issue) =>
            !!issue.sid ||
            !/form submitted|already submitted|should normally stop|thank you for/i.test(
              issue.message,
            ),
        );

        if (repairableIssues.length > 0) {
          report(`Step ${step} was rejected by the page; retrying the flagged fields.`);
          const repaired = await runRepairPass({
            settings,
            state,
            fillLocale,
            docLocale,
            stepNumber: step,
            issues: repairableIssues,
            onStatus,
            onUsage: trackUsage,
          });
          fieldsFilled += repaired;

          await persistBeforeNavigation(step + 1);
          const retryScan = scanFormFields();
          const retryAdvance = await advanceFormStep({
            settings,
            allowFinalSubmit: false,
            fillLocale,
            documentLocale: docLocale,
            beforeFields: retryScan.fields,
            unresolvedRequiredCount: requiredUnresolved(
              retryScan.fields,
              settings,
              state.appliedValues,
            ).length,
            onStatus,
          });

          if (retryAdvance.advanced) {
            await clearCheckpoint();
            state.beginStep(`Step ${step} (${outcome.sectionSummary}) completed after a repair pass.`);
            continue;
          }
          stopReason = retryAdvance.reason ?? advance.reason ?? "Could not advance past this step.";
          break;
        }

        // Nothing left to fill and no forward control: the form is done and only
        // the final submit remains, which is deliberately left to the user.
        if (isFormExhausted(settings, state.appliedValues)) {
          finishedNote =
            "Reached the end of the form. The final submit was left for you to press.";
          break;
        }

        stopReason = advance.reason ?? "Could not advance to the next step.";
        break;
      }

      // Still on this document after the click (SPA / in-place step change).
      await clearCheckpoint();

      // Crossing the boundary starts a fresh sid namespace and a fresh applied
      // map, so nothing from this step can leak into the next one.
      state.beginStep(`Step ${step} (${outcome.sectionSummary}) completed.`);
      await waitForFillableFields(settings, state.appliedValues);
    }
  } catch (error) {
    // A full navigation mid-await rejects with a dead execution context. The
    // checkpoint is already stored; the next document will resume.
    const message = error instanceof Error ? error.message : String(error);
    if (/context|invalidat|navigat|back\/forward cache|message channel/i.test(message)) {
      onStatus?.("Page navigated; continuing on the next step…");
      return {
        ok: true,
        warnings,
        stepsCompleted,
        fieldsFilled,
      };
    }
    await clearCheckpoint();
    throw error;
  }

  await clearCheckpoint();

  if (stopReason) {
    report(stopReason);
  } else {
    if (finishedNote) report(finishedNote);
    report(`Filled ${fieldsFilled} field(s) across ${stepsCompleted} step(s).`);
  }

  return {
    ok: !stopReason,
    warnings,
    stepsCompleted,
    fieldsFilled,
  };
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

interface StepParams {
  settings: ExtensionSettings;
  state: RunState;
  stepNumber: number;
  fillLocale: string;
  docLocale: string;
  onStatus?: (message: string) => void;
  report: (message: string) => void;
  onUsage?: (response: LlmFillResponse) => void;
}

interface StepOutcome {
  filledCount: number;
  /** Set when the step cannot be completed, ending the run. */
  stuckMessage?: string;
  fatalError?: boolean;
  sectionSummary: string;
}

async function runSingleStep(params: StepParams): Promise<StepOutcome> {
  const { settings, state, stepNumber, onStatus, report } = params;
  let filledCount = 0;

  if (settings.fillMode !== "ai_only") {
    filledCount += await applyHeuristics(params);
  }

  if (settings.fillMode === "heuristics_only") {
    return { filledCount, sectionSummary: "heuristics only" };
  }

  let scan = scanFormFields();
  state.dropForeignEpochEntries();
  let candidates = getUnresolvedCandidates(scan.fields, settings, state.appliedValues);

  if (candidates.length === 0) {
    scan = await waitForFillableFields(settings, state.appliedValues);
    candidates = getUnresolvedCandidates(scan.fields, settings, state.appliedValues);
  }

  if (candidates.length === 0) {
    const visible = visibleFillableFields(scan.fields, settings);
    if (visible.length === 0) {
      onStatus?.(`Step ${stepNumber}: no fillable fields on this step.`);
    } else {
      onStatus?.(`Step ${stepNumber}: all ${visible.length} field(s) already satisfied.`);
    }
    return { filledCount, sectionSummary: "nothing to fill" };
  }

  let chunks = buildChunks(candidates).map(makeChunkState);
  const maxRounds = resolveMaxRounds(settings, chunks.length);
  const sections = Array.from(new Set(chunks.map((chunk) => chunk.sectionName))).slice(0, 4);

  onStatus?.(
    `Step ${stepNumber}: ${candidates.length} field(s) in ${chunks.length} group(s) (up to ${maxRounds} rounds).`,
  );

  let consecutiveAiErrors = 0;
  const aiErrors: string[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const roundScan = scanFormFields();
    const roundCandidates = getUnresolvedCandidates(
      roundScan.fields,
      settings,
      state.appliedValues,
    );

    // Re-assert only this step's values, and only where they actually drifted.
    if (state.isCurrentEpoch()) {
      await reconcileAppliedValues(roundScan.instances, state.appliedValues, {
        settleMs: settings.settleMs,
      });
    }

    if (roundCandidates.length === 0) break;

    // Conditional fields revealed mid-step get their own chunk.
    chunks = absorbNewCandidates(chunks, roundCandidates);

    const chunk = findNextChunk(chunks);
    if (!chunk) break;

    const availableSids = new Set(roundCandidates.map((field) => field.syntheticId));
    const targetSids = (chunk.retrySids.length > 0 ? chunk.retrySids : chunk.fieldSids).filter(
      (sid) => availableSids.has(sid),
    );
    const chunkFields = roundCandidates.filter((field) => targetSids.includes(field.syntheticId));

    if (chunkFields.length === 0) {
      chunk.status = "completed";
      continue;
    }

    chunk.status = "in_progress";
    chunk.attempts += 1;

    onStatus?.(
      `Step ${stepNumber} · ${chunk.sectionName} · round ${round + 1}/${maxRounds} (${chunkFields.length} field(s))`,
    );

    const snapshot: FillSnapshot = {
      pageTitle: document.title,
      pageUrl: `${location.origin}${location.pathname}`,
      documentLocale: params.docLocale,
      fillLocale: params.fillLocale,
      roundIndex: round,
      maxRounds,
      stepIndex: stepNumber,
      fields: chunkFields,
      chunkSection: chunk.sectionName,
      runContext: state.context,
      retryOnly: chunk.retrySids.length > 0 ? targetSids : undefined,
      validationErrors: chunk.lastIssues.length > 0 ? chunk.lastIssues : undefined,
    };

    let response: LlmFillResponse;
    try {
      response = await sendMessage<LlmFillResponse>({ type: "LLM_FILL", snapshot });
    } catch (error) {
      response = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    params.onUsage?.(response);

    if (!response.ok) {
      const message = response.error ?? "The AI request failed.";

      if (/rate.?limit|\b429\b|too many request/i.test(message)) {
        chunk.status = "rate_limited";
        onStatus?.(`Rate limited; waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s before retrying.`);
        await settle(RATE_LIMIT_BACKOFF_MS);
        continue;
      }

      chunk.status = "failed";
      consecutiveAiErrors += 1;
      aiErrors.push(message);
      onStatus?.(`AI error ${consecutiveAiErrors}/${MAX_CONSECUTIVE_AI_ERRORS}: ${message}`);

      if (consecutiveAiErrors >= MAX_CONSECUTIVE_AI_ERRORS) {
        report(
          `Stopped after ${MAX_CONSECUTIVE_AI_ERRORS} failed AI requests:\n${aiErrors
            .map((entry, index) => `${index + 1}. ${entry}`)
            .join("\n")}`,
        );
        return { filledCount, fatalError: true, sectionSummary: sections.join(", ") };
      }

      await settle(settings.settleMs);
      continue;
    }

    consecutiveAiErrors = 0;

    const rawValues = response.values ?? {};
    state.mergeFacts(readContextObject(rawValues));

    const { valid, rejected, missingRequired } = validateAiResponse(
      rawValues,
      chunkFields,
      state.appliedValues,
    );

    let appliedNow: string[] = [];
    let applyFailed: string[] = [];

    if (Object.keys(valid).length > 0) {
      const applyResult = await applyValuesToInstances(roundScan.instances, valid, {
        settleMs: settings.settleMs,
      });
      const fieldsBySid = new Map(chunkFields.map((field) => [field.syntheticId, field]));
      for (const [sid, value] of Object.entries(applyResult.applied)) {
        state.recordApplied(fieldsBySid.get(sid), sid, value);
      }
      appliedNow = Object.keys(applyResult.applied);
      applyFailed = applyResult.failed;
      filledCount += appliedNow.length;
    }

    chunk.appliedSids = Array.from(new Set([...chunk.appliedSids, ...appliedNow]));
    chunk.retrySids = Array.from(
      new Set([...rejected.map((entry) => entry.sid), ...missingRequired, ...applyFailed]),
    );
    chunk.lastIssues = buildIssueFeedback(rejected, missingRequired, applyFailed, chunkFields);

    if (chunk.retrySids.length === 0) {
      chunk.status = "completed";
    } else if (chunk.attempts >= MAX_CHUNK_ATTEMPTS) {
      // Leave the leftovers for the final required-field report, but do not keep
      // spending rounds here while later sections have not been visited.
      chunk.status = "failed";
      onStatus?.(
        `Step ${stepNumber}: leaving "${chunk.sectionName}" after ${chunk.attempts} attempt(s); continuing with other sections.`,
      );
    } else {
      chunk.status = "partial";
    }

    // Writing values often reveals dependent fields; let the page settle so the
    // next round's scan sees them.
    await waitForDomQuiet({ quietMs: Math.max(120, settings.settleMs), timeoutMs: 2500 });
  }

  const finalScan = scanFormFields();
  const stillRequired = requiredUnresolved(finalScan.fields, settings, state.appliedValues);

  if (stillRequired.length > 0) {
    const names = stillRequired.slice(0, 3).map(describeField).join(", ");
    const extra = stillRequired.length > 3 ? ` and ${stillRequired.length - 3} more` : "";
    return {
      filledCount,
      stuckMessage: `Step ${stepNumber}: could not fill required field(s): ${names}${extra}.`,
      sectionSummary: sections.join(", "),
    };
  }

  return { filledCount, sectionSummary: sections.join(", ") };
}

// ---------------------------------------------------------------------------
// Heuristics pass
// ---------------------------------------------------------------------------

async function applyHeuristics(params: StepParams): Promise<number> {
  const { settings, state } = params;
  const scan = scanFormFields();
  const candidates = getUnresolvedCandidates(scan.fields, settings, state.appliedValues);

  const values: Record<string, string> = {};
  for (const field of candidates) {
    const value = tryHeuristicValue(
      field,
      state.context.identity,
      state.context.variationSeed,
      params.fillLocale,
    );
    if (value !== null) values[field.syntheticId] = value;
  }

  if (Object.keys(values).length === 0) return 0;

  const result = await applyValuesToInstances(scan.instances, values, {
    settleMs: settings.settleMs,
  });

  const fieldsBySid = new Map(candidates.map((field) => [field.syntheticId, field]));
  for (const [sid, value] of Object.entries(result.applied)) {
    state.recordApplied(fieldsBySid.get(sid), sid, value);
  }

  await waitForDomQuiet({ quietMs: Math.max(120, settings.settleMs), timeoutMs: 2000 });
  return Object.keys(result.applied).length;
}

// ---------------------------------------------------------------------------
// Repair pass
// ---------------------------------------------------------------------------

interface RepairParams {
  settings: ExtensionSettings;
  state: RunState;
  fillLocale: string;
  docLocale: string;
  stepNumber: number;
  issues: ValidationIssue[];
  onStatus?: (message: string) => void;
  onUsage?: (response: LlmFillResponse) => void;
}

/**
 * Re-asks the model for just the fields the page complained about, quoting the
 * page's own error text so it can correct the format rather than guess again.
 */
async function runRepairPass(params: RepairParams): Promise<number> {
  const { settings, state, issues, stepNumber, onStatus } = params;
  const scan = scanFormFields();
  const flaggedSids = new Set(issues.map((issue) => issue.sid).filter(Boolean) as string[]);

  const fields = scan.fields.filter(
    (field) =>
      isFillableField(field, { excludeSensitive: settings.excludeSensitiveFields === true }) &&
      (flaggedSids.has(field.syntheticId) || field.ariaInvalid || !!field.validationMessage),
  );

  if (fields.length === 0) return 0;

  onStatus?.(`Step ${stepNumber}: repairing ${fields.length} rejected field(s).`);

  const snapshot: FillSnapshot = {
    pageTitle: document.title,
    pageUrl: `${location.origin}${location.pathname}`,
    documentLocale: params.docLocale,
    fillLocale: params.fillLocale,
    roundIndex: 0,
    maxRounds: 1,
    stepIndex: stepNumber,
    fields,
    chunkSection: "corrections",
    runContext: state.context,
    validationErrors: issues,
  };

  let response: LlmFillResponse;
  try {
    response = await sendMessage<LlmFillResponse>({ type: "LLM_FILL", snapshot });
  } catch {
    return 0;
  }
  params.onUsage?.(response);

  if (!response.ok || !response.values) return 0;

  const { valid } = validateAiResponse(response.values, fields, state.appliedValues);
  if (Object.keys(valid).length === 0) return 0;

  const result = await applyValuesToInstances(scan.instances, valid, {
    settleMs: settings.settleMs,
  });

  const fieldsBySid = new Map(fields.map((field) => [field.syntheticId, field]));
  for (const [sid, value] of Object.entries(result.applied)) {
    state.recordApplied(fieldsBySid.get(sid), sid, value);
  }

  await waitForDomQuiet({ quietMs: Math.max(150, settings.settleMs), timeoutMs: 2500 });
  return Object.keys(result.applied).length;
}

// ---------------------------------------------------------------------------
// Chunk bookkeeping
// ---------------------------------------------------------------------------

/** Folds fields that appeared after chunking (conditionals) into the plan. */
function absorbNewCandidates(
  chunks: ChunkState[],
  candidates: FieldDescriptor[],
): ChunkState[] {
  const known = new Set(chunks.flatMap((chunk) => chunk.fieldSids));
  const fresh = candidates.filter((field) => !known.has(field.syntheticId));
  if (fresh.length === 0) return chunks;

  const added = buildChunks(fresh).map((descriptor, index) =>
    makeChunkState(descriptor, chunks.length + index),
  );
  return [...chunks, ...added];
}

function buildIssueFeedback(
  rejected: { sid: string; reason: string }[],
  missingRequired: string[],
  applyFailed: string[],
  fields: FieldDescriptor[],
): ValidationIssue[] {
  const bySid = new Map(fields.map((field) => [field.syntheticId, field]));
  const issues: ValidationIssue[] = [];

  for (const entry of rejected) {
    issues.push({ sid: entry.sid, message: entry.reason });
  }
  for (const sid of missingRequired) {
    const field = bySid.get(sid);
    issues.push({
      sid,
      message: `required field "${field ? describeField(field) : sid}" had no value`,
    });
  }
  for (const sid of applyFailed) {
    issues.push({ sid, message: "the page would not accept this value" });
  }

  return issues.slice(0, 15);
}

/** The model may return a `_ctx` object of facts worth carrying between steps. */
function readContextObject(values: Record<string, string>): Record<string, unknown> | undefined {
  const raw = values["_ctx"];
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON; ignore.
  }
  return undefined;
}
