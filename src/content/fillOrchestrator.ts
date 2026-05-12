import { applyValuesToTargets, reconcileAppliedValues } from "./apply";
import { getUnresolvedCandidates } from "./candidates";
import { advanceFormStep, detectMultiStepHints, inferWizardStepCount } from "./navigation";
import type { ScanResult } from "./scan";
import { resolveDocumentLocale, resolveFillLocale, scanFormFields } from "./scan";
import { parsePersona, tryHeuristicValue } from "../shared/heuristics";
import { isFillableField } from "../shared/fillable";
import type {
  ChunkDescriptor,
  ExtensionSettings,
  FieldDescriptor,
  FillSnapshot,
  FormMemory,
  FillRunResult,
  LlmFillResponse,
} from "../shared/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 8;
const AI_ONLY_MAX_FORM_STEPS = 10;

const IDENTITY_FIELD_PATTERN =
  /first.?name|last.?name|given.?name|family.?name|full.?name|prénom|prenom|nom|e-?mail|courriel|téléphone|telephone|phone|mobile|sms/i;
const CONTACT_FIELD_PATTERN =
  /address|adresse|postal|zip|ville|city|pays|country|street|rue|code postal|complément/i;
const PAYMENT_FIELD_PATTERN = /card|cvv|cvc|payment|paiement|billing|facturation|iban/i;

const SECTION_ORDER = [
  "basic_info",
  "work_salary",
  "benefits_holidays",
  "candidate_requirements",
  "appeal_selection_contact",
] as const;

const FIELD_BUCKET_ORDER = [
  "required_priority",
  "required_other",
  "optional_priority",
  ...SECTION_ORDER,
] as const;

const SECTION_CONTEXT_DEPENDENCIES: Record<string, (keyof FormMemory)[]> = {
  basic_info: [],
  work_salary: ["jobCategory", "employmentType", "location"],
  benefits_holidays: ["jobCategory", "employmentType", "salaryType", "workStyle"],
  candidate_requirements: ["jobCategory", "employmentType", "location"],
  appeal_selection_contact: ["jobCategory", "employmentType", "companySummary", "candidateProfile"],
  retry: [],
};

const SECTION_PATTERNS: Array<{ section: string; pattern: RegExp }> = [
  {
    section: "work_salary",
    pattern:
      /salary|wage|pay|overtime|work.?hour|work.?style|work.?schedul|勤務|給与|賃金|残業|時間外|固定残業|月給|時給|就業|雇用形態|就業形態|給与補足|給与.*条件/i,
  },
  {
    section: "benefits_holidays",
    pattern:
      /benefit|insurance|holiday|vacation|leave|welfare|休日|休暇|保険|福利|手当|年次|待遇|社会保険|有給/i,
  },
  {
    section: "candidate_requirements",
    pattern:
      /candidate|requirement|condition|gender|age|qualification|skill|experience|応募|条件|要件|性別|年齢|年代|資格|経験|不問|国籍|外国籍|年齢層/i,
  },
  {
    section: "appeal_selection_contact",
    pattern:
      /appeal|description|selection|contact|email|phone|flow|アピール|職種内容|選考|連絡先|メールアドレス|電話番号|仕事内容|PR|職場環境|PRポイント|特徴|フロー/i,
  },
];

// Checkbox group max patterns (kept in sync with llm.ts)
/** max 1 — mutually exclusive groups */
const CBG_EXCLUSIVE_TITLE =
  /性別|国籍|外国籍|雇用形態|就業形態|勤務スタイル|不採用条件/i;
/** max 1 — detected from label content when group is small */
const CBG_EXCLUSIVE_LABELS =
  /gender|性別|male|female|男性|女性|問わず|불문|yes.{0,5}no|はい.{0,5}いいえ|あり.{0,5}なし|有.{0,5}無/i;
/** max 2 — age bands, welfare items, appeal points */
const CBG_TWO_MAX_TITLE = /年代|年齢層|福利厚生|アピールポイント/i;
/** max 3 — small-selection groups */
const CBG_SMALL_MAX_TITLE =
  /給与.*補足|選考フロー|職場環境|フロー|PRポイント|アピール|勤務形態|就業形態|働き方|応募条件|採用条件/i;
/** max 4 — insurance options */
const CBG_INSURANCE_TITLE = /保険|insurance/i;
/** max 3 — holiday / leave types */
const CBG_HOLIDAY_TITLE = /休日|holiday|休暇/i;

// ---------------------------------------------------------------------------
// Chunk state machine
// ---------------------------------------------------------------------------

type ChunkStatus =
  | "pending"
  | "in_progress"
  | "retry_pending"
  | "rate_limited"
  | "completed"
  | "partial"
  | "failed";

const RATE_LIMIT_BACKOFF_MS = 30_000;

interface ChunkState {
  id: string;
  sectionName: string;
  /** All field sids originally assigned to this chunk */
  fieldSids: string[];
  status: ChunkStatus;
  retryCount: number;
  /** Sids successfully applied this session */
  appliedSids: string[];
  /** Required sids rejected by validation (bad value) */
  rejectedSids: string[];
  /** Required sids not returned by AI at all */
  missingRequiredSids: string[];
  /** Union of rejectedSids + missingRequiredSids — sent in the next retry round */
  retrySids: string[];
}

function makeChunkState(idx: number, desc: ChunkDescriptor): ChunkState {
  return {
    id: `chunk-${idx}-${desc.sectionName}`,
    sectionName: desc.sectionName,
    fieldSids: desc.fieldSids,
    status: "pending",
    retryCount: 0,
    appliedSids: [],
    rejectedSids: [],
    missingRequiredSids: [],
    retrySids: [],
  };
}

/** Pick the next chunk to process: partial chunks first, then pending. */
function findNextChunk(chunks: ChunkState[]): ChunkState | null {
  return (
    chunks.find((c) => c.status === "partial") ??
    chunks.find((c) => c.status === "retry_pending") ??
    chunks.find((c) => c.status === "pending") ??
    null
  );
}

function logChunk(chunk: ChunkState, detail?: Record<string, unknown>): void {
  console.debug(`[AI Form Filler] chunk [${chunk.id}] → ${chunk.status}`, {
    retryCount: chunk.retryCount,
    appliedSids: chunk.appliedSids,
    rejectedSids: chunk.rejectedSids,
    missingRequiredSids: chunk.missingRequiredSids,
    retrySids: chunk.retrySids,
    ...detail,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fieldHintText(field: FieldDescriptor): string {
  return [
    field.labelText,
    field.ariaLabel,
    field.placeholder,
    field.name,
    field.id,
    field.autoComplete,
    field.surroundingText,
    field.formPurpose,
  ]
    .filter(Boolean)
    .join(" ");
}

function isPriorityFieldHint(hint: string): boolean {
  return (
    IDENTITY_FIELD_PATTERN.test(hint) ||
    CONTACT_FIELD_PATTERN.test(hint) ||
    PAYMENT_FIELD_PATTERN.test(hint)
  );
}

function classifyFieldBucket(field: FieldDescriptor): string {
  const hint = fieldHintText(field);
  const priority = isPriorityFieldHint(hint);
  if (field.required) return priority ? "required_priority" : "required_other";
  if (priority) return "optional_priority";
  return detectSection(field);
}

function detectSection(f: FieldDescriptor): string {
  const text = [f.labelText, f.surroundingText, f.formPurpose, f.placeholder]
    .filter(Boolean)
    .join(" ");
  for (const { section, pattern } of SECTION_PATTERNS) {
    if (pattern.test(text)) return section;
  }
  return "basic_info";
}

function buildChunks(fields: FieldDescriptor[]): ChunkDescriptor[] {
  const byBucket: Record<string, string[]> = {};
  for (const field of fields) {
    const bucket = classifyFieldBucket(field);
    if (!byBucket[bucket]) byBucket[bucket] = [];
    byBucket[bucket].push(field.syntheticId);
  }

  const orderedBuckets = [...new Set([...FIELD_BUCKET_ORDER, ...SECTION_ORDER])];
  return orderedBuckets
    .filter((bucket) => (byBucket[bucket]?.length ?? 0) > 0)
    .map((bucket) => ({
      sectionName: bucket,
      fieldSids: byBucket[bucket]!,
    }));
}

function pickCtxForSection(sectionName: string, memory: FormMemory): Partial<FormMemory> {
  const deps = SECTION_CONTEXT_DEPENDENCIES[sectionName] ?? [];
  if (deps.length === 0) return {};
  const ctx: Partial<FormMemory> = {};
  for (const key of deps) {
    if (memory[key] !== undefined) (ctx as Record<string, string>)[key] = memory[key] as string;
  }
  return ctx;
}

/**
 * Determine the max number of selections allowed for a checkbox group.
 * Mirrors the logic in llm.ts so validation and payload generation agree.
 */
function maxForCbGroup(groupTitle: string, itemCount: number, allLabels: string[]): number {
  if (CBG_EXCLUSIVE_TITLE.test(groupTitle)) return 1;
  const combined = [groupTitle, ...allLabels].join(" ");
  if (itemCount <= 4 && CBG_EXCLUSIVE_LABELS.test(combined)) return 1;
  if (CBG_TWO_MAX_TITLE.test(groupTitle)) return Math.min(itemCount, 2);
  if (CBG_INSURANCE_TITLE.test(groupTitle)) return Math.min(itemCount, 4);
  if (CBG_HOLIDAY_TITLE.test(groupTitle)) return Math.min(itemCount, 3);
  if (CBG_SMALL_MAX_TITLE.test(groupTitle)) return Math.min(itemCount, 3);
  return itemCount;
}

function filterCandidates(
  fields: FieldDescriptor[],
  settings: ExtensionSettings,
  appliedValues: Record<string, string> = {},
): FieldDescriptor[] {
  return getUnresolvedCandidates(fields, settings, appliedValues);
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, ms);
    });
  });
}

function requiredUnfilledCount(
  fields: FieldDescriptor[],
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
): number {
  return getUnresolvedCandidates(fields, settings, appliedValues).filter((field) => field.required)
    .length;
}

function detectAppliedFieldResets(
  fields: FieldDescriptor[],
  appliedValues: Record<string, string>,
): string[] {
  const fieldMap = new Map(fields.map((f) => [f.syntheticId, f]));
  const resetSids: string[] = [];

  for (const [sid, value] of Object.entries(appliedValues)) {
    const field = fieldMap.get(sid);
    if (!field) continue;
    if (field.inputType === "checkbox") {
      if (value === "true" && field.currentValue !== "true") resetSids.push(sid);
      continue;
    }
    if (field.currentValue !== value) resetSids.push(sid);
  }

  return resetSids;
}

function appendRemainingChunk(
  chunks: ChunkState[],
  candidates: FieldDescriptor[],
): ChunkState[] {
  const candidateSids = candidates.map((field) => field.syntheticId);
  const openChunk = chunks.find(
    (chunk) =>
      (chunk.status === "pending" ||
        chunk.status === "partial" ||
        chunk.status === "retry_pending") &&
      chunk.fieldSids.some((sid) => candidateSids.includes(sid)),
  );
  if (openChunk) return chunks;

  const chunkKey = candidateSids.slice().sort().join("|");
  if (
    chunks.some(
      (chunk) => chunk.fieldSids.slice().sort().join("|") === chunkKey,
    )
  ) {
    return chunks;
  }

  return [
    ...chunks,
    makeChunkState(chunks.length, {
      sectionName: "retry",
      fieldSids: candidateSids,
    }),
  ];
}

function reopenChunksForCandidates(
  chunks: ChunkState[],
  candidates: FieldDescriptor[],
): ChunkState[] | null {
  const candidateSids = new Set(candidates.map((field) => field.syntheticId));
  let touched = false;

  const next = chunks.map((chunk) => {
    const overlap = chunk.fieldSids.filter((sid) => candidateSids.has(sid));
    if (overlap.length === 0) return chunk;
    if (chunk.status !== "completed" && chunk.status !== "failed") return chunk;

    touched = true;
    return {
      ...chunk,
      status: "partial" as const,
      retrySids: overlap,
    };
  });

  return touched ? next : null;
}

function shouldAutoAdvance(settings: ExtensionSettings): boolean {
  if (settings.fillMode === "ai_only") return true;
  if (settings.autoNextEnabled) return true;
  return detectMultiStepHints().length > 0 || inferWizardStepCount() > 1;
}

function resolveMaxFormSteps(settings: ExtensionSettings): number {
  const detectedSteps = inferWizardStepCount();
  if (!shouldAutoAdvance(settings)) {
    return 1;
  }

  const configured =
    settings.fillMode === "ai_only"
      ? Math.max(settings.autoNextMaxSteps, AI_ONLY_MAX_FORM_STEPS)
      : Math.max(1, settings.autoNextMaxSteps);

  return Math.max(configured, detectedSteps > 0 ? detectedSteps : 0, 4);
}

function pruneAppliedValuesForScan(
  appliedValues: Record<string, string>,
  scan: ScanResult,
): void {
  const activeIds = new Set(scan.fields.map((field) => field.syntheticId));
  for (const sid of Object.keys(appliedValues)) {
    if (!activeIds.has(sid)) delete appliedValues[sid];
  }
}

async function waitForStepFields(
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
  settleMs: number,
  timeoutMs = 12000,
): Promise<ScanResult> {
  const waitMs = Math.max(400, settleMs);
  const startedAt = Date.now();
  let latest = scanFormFields();

  while (Date.now() - startedAt < timeoutMs) {
    await settle(waitMs);
    latest = scanFormFields();
    if (getUnresolvedCandidates(latest.fields, settings, appliedValues).length > 0) {
      return latest;
    }
  }

  return latest;
}

// ---------------------------------------------------------------------------
// FormMemory
// ---------------------------------------------------------------------------

const FORM_MEMORY_KEYS: ReadonlyArray<keyof FormMemory> = [
  "formType",
  "locale",
  "pageTitle",
  "jobCategory",
  "employmentType",
  "hiringCount",
  "agencyJob",
  "countryLanguage",
  "companySummary",
  "location",
  "transfer",
  "workStyle",
  "salaryType",
  "monthlyWorkHours",
  "overtime",
  "candidateProfile",
];

function mergeCtxIntoMemory(
  ctx: Record<string, unknown> | undefined,
  memory: FormMemory,
): void {
  if (!ctx || typeof ctx !== "object") return;
  for (const key of FORM_MEMORY_KEYS) {
    const v = ctx[key];
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (trimmed.length > 50) continue;
    (memory as Record<string, string>)[key] = trimmed;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PLACEHOLDER_BLOCKLIST = new Set([
  "入力してください",
  "その他の情報を入力してください",
  "固定額を入力",
  "最低額を入力",
  "最高額を入力",
  "テキストを入力",
  "ここに入力",
  "Enter text",
  "Type here",
  "Code porte, etc.",
  "Code porte",
  "Exemple",
  "Example",
  "Saisir",
  "Saisissez",
  "Votre texte",
]);

function isPlaceholderValue(value: string, field: FieldDescriptor): boolean {
  const v = value.trim();
  if (!v) return true;
  if (field.placeholder && v === field.placeholder.trim()) return true;
  if (field.placeholder && v.toLowerCase() === field.placeholder.trim().toLowerCase()) return true;
  if (PLACEHOLDER_BLOCKLIST.has(v)) return true;
  if (PLACEHOLDER_BLOCKLIST.has(v.toLowerCase())) return true;
  if (/^code porte\b/i.test(v)) return true;
  if (/^exemple\b/i.test(v)) return true;
  return false;
}

/**
 * Validate the AI response against the current chunk fields.
 *
 * Returns:
 *  - `valid`: values safe to apply to the DOM
 *  - `rejectedSids`: required sids where AI returned an invalid/empty value
 *  - `missingRequiredSids`: required sids the AI did not return at all
 *
 * Checkbox handling:
 *  - Non-boolean values ("30", "問わず") are silently dropped.
 *  - "true" values are grouped by formPurpose; per-group max is enforced.
 *  - Excess selections beyond max are dropped without error (they are optional).
 *  - "false" values are accepted for explicit unchecking.
 */
function validateAiResponse(
  rawValues: Record<string, string>,
  chunkFields: FieldDescriptor[],
  appliedValues: Record<string, string> = {},
): {
  valid: Record<string, string>;
  rejectedSids: string[];
  missingRequiredSids: string[];
} {
  const fieldMap = new Map<string, FieldDescriptor>(chunkFields.map((f) => [f.syntheticId, f]));
  const valid: Record<string, string> = {};
  const rejectedSids: string[] = [];

  // ── Checkbox pass: group by formPurpose, enforce cbg max ─────────────────

  // Build per-group metadata from all checkbox fields in this chunk
  const cbgGroups = new Map<
    string,
    { items: FieldDescriptor[]; trueReturned: string[] }
  >();
  const ungroupedCheckboxes: FieldDescriptor[] = [];

  for (const f of chunkFields) {
    if (f.inputType !== "checkbox") continue;
    const grp = f.formPurpose?.trim() ?? "";
    if (grp) {
      if (!cbgGroups.has(grp)) cbgGroups.set(grp, { items: [], trueReturned: [] });
      cbgGroups.get(grp)!.items.push(f);
    } else {
      ungroupedCheckboxes.push(f);
    }
  }

  // Collect "true" responses per group
  for (const [sid, value] of Object.entries(rawValues)) {
    if (sid === "_ctx") continue;
    const field = fieldMap.get(sid);
    if (!field || field.inputType !== "checkbox") continue;
    if (value !== "true" && value !== "false") {
      console.debug("[AI Form Filler] validate: non-boolean checkbox rejected", {
        sid,
        value,
        required: field.required,
      });
      if (field.required) rejectedSids.push(sid);
      continue;
    }
    if (value !== "true") continue;
    const grp = field.formPurpose?.trim() ?? "";
    if (grp && cbgGroups.has(grp)) {
      cbgGroups.get(grp)!.trueReturned.push(sid);
    } else if (!grp) {
      valid[sid] = "true";
    }
  }

  // Enforce per-group max
  for (const [grp, { items, trueReturned }] of cbgGroups) {
    const labels = items.map((f) => f.labelText ?? "");
    const max = maxForCbGroup(grp, items.length, labels);
    const approved = trueReturned.slice(0, max);
    const dropped = trueReturned.slice(max);

    for (const sid of approved) valid[sid] = "true";

    if (dropped.length > 0) {
      console.debug("[AI Form Filler] cbg max enforced", {
        grp,
        max,
        approved,
        dropped,
      });
    }
  }

  // Handle explicit "false" values for any checkbox not already marked "true"
  for (const [sid, value] of Object.entries(rawValues)) {
    if (sid === "_ctx") continue;
    const field = fieldMap.get(sid);
    if (!field || field.inputType !== "checkbox") continue;
    if (value === "false" && !valid[sid]) {
      valid[sid] = "false";
    }
  }

  // ── Non-checkbox pass ─────────────────────────────────────────────────────

  const returnedSids = new Set(Object.keys(rawValues).filter((k) => k !== "_ctx"));

  for (const [sid, value] of Object.entries(rawValues)) {
    if (sid === "_ctx") continue;
    const field = fieldMap.get(sid);
    if (!field) continue;
    if (field.inputType === "checkbox") continue; // handled above
    if (typeof value !== "string") continue;

    if (field.controllingCheckboxSid) {
      const controllerValue =
        valid[field.controllingCheckboxSid] ??
        rawValues[field.controllingCheckboxSid] ??
        appliedValues[field.controllingCheckboxSid];
      if (controllerValue !== "true") {
        console.debug("[AI Form Filler] validate: dependent text skipped without selected checkbox", {
          sid,
          controllerSid: field.controllingCheckboxSid,
        });
        continue;
      }
    }

    // Empty string and placeholder copies
    if (isPlaceholderValue(value, field)) {
      console.debug("[AI Form Filler] validate: placeholder/empty rejected", {
        sid,
        value,
        required: field.required,
      });
      if (field.required) rejectedSids.push(sid);
      continue;
    }

    // Select option must exist exactly
    if (field.inputType === "select-one" || field.tag === "select") {
      const opts = field.options?.map((o) => o.value) ?? [];
      if (opts.length > 0 && !opts.includes(value)) {
        console.debug("[AI Form Filler] validate: select option not found", {
          sid,
          value,
          opts: opts.slice(0, 10),
        });
        if (field.required) rejectedSids.push(sid);
        continue;
      }
    }

    // Radio choice must exist exactly
    if (field.inputType === "radio") {
      const choices = field.radioChoices?.map((o) => o.value) ?? [];
      if (choices.length > 0 && !choices.includes(value)) {
        console.debug("[AI Form Filler] validate: radio choice not found", { sid, value });
        if (field.required) rejectedSids.push(sid);
        continue;
      }
    }

    // Pattern
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(value)) {
          console.debug("[AI Form Filler] validate: pattern mismatch", {
            sid,
            value,
            pattern: field.pattern,
          });
          if (field.required) rejectedSids.push(sid);
          continue;
        }
      } catch {
        // Malformed regex — skip check
      }
    }

    const trimmed =
      field.maxLength && field.maxLength > 0 ? value.slice(0, field.maxLength) : value;
    valid[sid] = trimmed;
  }

  // ── Missing required fields (AI returned nothing for them) ────────────────

  const missingRequiredSids: string[] = [];
  for (const f of chunkFields) {
    if (!f.required) continue;
    if (f.inputType === "checkbox") continue; // unchecked = valid default for optional checkboxes
    if (returnedSids.has(f.syntheticId)) continue; // AI returned a value (valid or rejected)
    if (valid[f.syntheticId] !== undefined) continue; // already valid (shouldn't happen here)
    missingRequiredSids.push(f.syntheticId);
    console.debug("[AI Form Filler] validate: required field not returned by AI", {
      sid: f.syntheticId,
      label: f.labelText,
    });
  }

  return { valid, rejectedSids, missingRequiredSids };
}

// ---------------------------------------------------------------------------
// Messaging
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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runFillOrchestration(
  settings: ExtensionSettings,
  onStatus?: (s: string) => void,
): Promise<FillRunResult> {
  const safeMaxRounds = Math.min(Math.max(1, settings.maxRounds), MAX_ROUNDS);
  const appliedValues: Record<string, string> = {};
  const warnings: string[] = [];
  const reportStatus = (message: string): void => {
    warnings.push(message);
    onStatus?.(message);
  };

  await runFillStep(settings, safeMaxRounds, appliedValues, reportStatus);

  const incomplete = warnings.some((message) =>
    /unresolved|stopped|round limit|no fillable fields found|did not change|could not be queued/i.test(
      message,
    ),
  );
  if (!incomplete) {
    reportStatus("Fill complete.");
  }

  return { ok: !incomplete, warnings };
}

// ---------------------------------------------------------------------------
// Per-step fill loop with chunk state machine
// ---------------------------------------------------------------------------

async function runFillStep(
  settings: ExtensionSettings,
  safeMaxRounds: number,
  appliedValues: Record<string, string>,
  onStatus?: (s: string) => void,
): Promise<void> {
  const docLocale = resolveDocumentLocale();
  const fillLocale = resolveFillLocale("auto", "", docLocale);
  const allowFinalSubmit = settings.autoNextEnabled;
  const maxFormSteps = resolveMaxFormSteps(settings);
  const autoAdvance = shouldAutoAdvance(settings);

  const formMemory: FormMemory = {
    locale: fillLocale || docLocale || undefined,
    pageTitle: document.title || undefined,
  };

  let screenIndex = 0;

  while (screenIndex < maxFormSteps) {
    screenIndex++;
    if (settings.fillMode !== "ai_only" && screenIndex === 1) {
      const scan0: ScanResult = scanFormFields();
      const candidates0 = filterCandidates(scan0.fields, settings, appliedValues);
      const persona = parsePersona(settings.personaJson);
      const heuristicVals: Record<string, string> = {};
      for (const field of candidates0) {
        const value = tryHeuristicValue(field, persona);
        if (value !== null) heuristicVals[field.syntheticId] = value;
      }
      if (Object.keys(heuristicVals).length > 0) {
        const heuristicApply = await applyValuesToTargets(scan0.targets, heuristicVals);
        for (const [sid, value] of Object.entries(heuristicApply.applied)) {
          appliedValues[sid] = value;
        }
        await settle(settings.settleMs);
      }
    }

    if (settings.fillMode === "heuristics_only") return;

    let scanInit: ScanResult = scanFormFields();
    pruneAppliedValuesForScan(appliedValues, scanInit);
    let initCandidates = getUnresolvedCandidates(scanInit.fields, settings, appliedValues);

    if (initCandidates.length === 0) {
      scanInit = await waitForStepFields(settings, appliedValues, settings.settleMs);
      pruneAppliedValuesForScan(appliedValues, scanInit);
      initCandidates = getUnresolvedCandidates(scanInit.fields, settings, appliedValues);
    }

    if (initCandidates.length === 0) {
      const visibleFillable = scanInit.fields.filter((field) => isFillableField(field));
      const requiredLeft = requiredUnfilledCount(scanInit.fields, settings, appliedValues);
      if (requiredLeft > 0) {
        onStatus?.(`Form step ${screenIndex}: ${requiredLeft} required field(s) still unresolved.`);
        return;
      }
      if (visibleFillable.length > 0) {
        onStatus?.(
          `Form step ${screenIndex}: ${visibleFillable.length} visible field(s) could not be queued for AI fill.`,
        );
        return;
      }
      if (!autoAdvance || screenIndex >= maxFormSteps) {
        onStatus?.(`Form step ${screenIndex}: no fillable fields found.`);
        return;
      }

      const advanced = await advanceFormStep(
        settings,
        appliedValues,
        allowFinalSubmit,
        fillLocale,
        docLocale,
        onStatus,
      );
      if (!advanced) {
        onStatus?.("No next-step button found. Fill stopped.");
        return;
      }
      scanInit = await waitForStepFields(settings, appliedValues, settings.settleMs);
      pruneAppliedValuesForScan(appliedValues, scanInit);
      continue;
    }

    let chunks: ChunkState[] = buildChunks(initCandidates).map((descriptor, index) =>
      makeChunkState(index, descriptor),
    );

    let aiErrorCount = 0;
    const aiErrorMessages: string[] = [];

    console.debug("[AI Form Filler] starting form step", {
      formStep: screenIndex,
      safeMaxRounds,
      chunks: chunks.map((chunk) => ({ id: chunk.id, fieldCount: chunk.fieldSids.length })),
    });

    let stepComplete = false;

    for (let round = 0; round < safeMaxRounds; round++) {
      const scan: ScanResult = scanFormFields();
      const candidates = getUnresolvedCandidates(scan.fields, settings, appliedValues);

      const resetSids = detectAppliedFieldResets(scan.fields, appliedValues);
      if (resetSids.length > 0) {
        console.debug("[AI Form Filler] applied fields reset before reconcile", {
          round,
          formStep: screenIndex,
          resetSids,
          appliedValues,
        });
      }

      await reconcileAppliedValues(scan.targets, appliedValues, {
        fields: scan.fields,
        settleMs: settings.settleMs,
      });

      if (candidates.length === 0) {
        const waitedScan = await waitForStepFields(settings, appliedValues, settings.settleMs);
        pruneAppliedValuesForScan(appliedValues, waitedScan);
        const retried = getUnresolvedCandidates(waitedScan.fields, settings, appliedValues);
        if (retried.length === 0) {
          stepComplete = true;
          break;
        }
        continue;
      }

      const activeChunk = findNextChunk(chunks);
      if (!activeChunk) {
        if (candidates.length > 0) {
          const nextChunks = appendRemainingChunk(chunks, candidates);
          if (nextChunks === chunks) {
            const reopened = reopenChunksForCandidates(chunks, candidates);
            if (reopened) {
              chunks = reopened;
              continue;
            }
            break;
          }
          chunks = nextChunks;
          continue;
        }
        stepComplete = true;
        break;
      }

      const isRetry =
        activeChunk.status === "partial" || activeChunk.status === "retry_pending";
      const isRateLimitRetry = activeChunk.status === "retry_pending";
      const prevStatus = activeChunk.status;
      activeChunk.status = "in_progress";

      const sidSet = new Set(candidates.map((field) => field.syntheticId));
      const targetSids = (
        isRetry && !isRateLimitRetry && activeChunk.retrySids.length > 0
          ? activeChunk.retrySids
          : activeChunk.fieldSids
      ).filter((sid) => sidSet.has(sid));
      const chunkFields = candidates.filter((field) => targetSids.includes(field.syntheticId));

      if (chunkFields.length === 0) {
        activeChunk.status = "completed";
        logChunk(activeChunk, { reason: "all fields already resolved or gone" });
        continue;
      }

      const sectionName =
        prevStatus === "partial" && activeChunk.retrySids.length > 0
          ? "retry"
          : activeChunk.sectionName;

      onStatus?.(
        `Form step ${screenIndex} — round ${round + 1}/${safeMaxRounds} [${activeChunk.id}${isRetry ? "/retry" : ""}] (${chunkFields.length} fields)…`,
      );

      logChunk(activeChunk, {
        round,
        formStep: screenIndex,
        isRetry,
        sectionName,
        targetSids,
      });

      const chunkCtx = pickCtxForSection(sectionName, formMemory);

      const snapshot: FillSnapshot = {
        pageTitle: document.title,
        pageUrl: `${location.origin}${location.pathname}`,
        documentLocale: docLocale,
        fillLocale,
        roundIndex: round,
        maxRounds: safeMaxRounds,
        fields: chunkFields,
        chunkSection: sectionName,
        chunkCtx: Object.keys(chunkCtx).length > 0 ? chunkCtx : undefined,
        retryOnly:
          prevStatus === "partial" && activeChunk.retrySids.length > 0 ? targetSids : undefined,
      };

      const resp = await sendMessage<LlmFillResponse>({ type: "LLM_FILL", snapshot });

      if (!resp.ok) {
        const errMsg = resp.error ?? "LLM request failed.";
        const isRateLimit = /rate.?limit|429|too many request/i.test(errMsg);

        if (isRateLimit) {
          console.debug("[AI Form Filler] rate limit — preserving appliedValues", {
            chunkSection: activeChunk.sectionName,
            appliedValuesBefore: { ...appliedValues },
          });
          activeChunk.status = "retry_pending";
          logChunk(activeChunk, {
            errorType: "rate_limit",
            backoffMs: RATE_LIMIT_BACKOFF_MS,
            errMsg: errMsg.slice(0, 200),
            appliedValuesBefore: { ...appliedValues },
          });
          onStatus?.(`Rate limit — waiting ${(RATE_LIMIT_BACKOFF_MS / 1000).toFixed(0)} s before retry…`);
          await settle(RATE_LIMIT_BACKOFF_MS);
          const rescan = scanFormFields();
          await reconcileAppliedValues(rescan.targets, appliedValues, {
            fields: rescan.fields,
            settleMs: settings.settleMs,
          });
          console.debug("[AI Form Filler] rate limit — appliedValues after wait", {
            chunkSection: activeChunk.sectionName,
            appliedValuesAfter: { ...appliedValues },
          });
          continue;
        }

        activeChunk.status = "failed";
        aiErrorCount += 1;
        aiErrorMessages.push(errMsg);
        logChunk(activeChunk, { errorType: "api_error", errMsg: errMsg.slice(0, 300) });
        onStatus?.(`AI error ${aiErrorCount}/3: ${errMsg}`);

        if (aiErrorCount >= 3) {
          const details = aiErrorMessages
            .map((message, idx) => `${idx + 1}. ${message}`)
            .slice(0, 3)
            .join("\n");
          throw new Error(`Stopped after 3 failed AI requests.\n${details}`);
        }
        await settle(settings.settleMs);
        continue;
      }

      const rawValues = resp.values ?? {};
      const ctxString = rawValues["_ctx"];
      const valuesWithoutCtx: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawValues)) {
        if (key !== "_ctx") valuesWithoutCtx[key] = value;
      }

      if (ctxString) {
        try {
          const ctxObj = JSON.parse(ctxString) as Record<string, unknown>;
          mergeCtxIntoMemory(ctxObj, formMemory);
        } catch {
          // Not valid JSON — ignore
        }
      }

      const { valid, rejectedSids, missingRequiredSids } = validateAiResponse(
        valuesWithoutCtx,
        chunkFields,
        appliedValues,
      );

      let applyResult = { applied: {} as Record<string, string>, failed: [] as string[] };
      if (Object.keys(valid).length > 0) {
        applyResult = await applyValuesToTargets(scan.targets, valid, {
          fields: chunkFields,
          settleMs: settings.settleMs,
        });
        for (const [sid, value] of Object.entries(applyResult.applied)) {
          appliedValues[sid] = value;
        }
      }

      const appliedNow = Object.keys(applyResult.applied);
      const applyFailedSids = applyResult.failed;
      const unresolvedSids = [
        ...new Set([...rejectedSids, ...missingRequiredSids, ...applyFailedSids]),
      ];

      activeChunk.appliedSids = [...new Set([...activeChunk.appliedSids, ...appliedNow])];
      activeChunk.rejectedSids = [
        ...new Set([...activeChunk.rejectedSids, ...rejectedSids, ...applyFailedSids]),
      ];
      activeChunk.missingRequiredSids = missingRequiredSids;
      activeChunk.retrySids = unresolvedSids;

      if (activeChunk.retrySids.length === 0) {
        activeChunk.status = "completed";
      } else {
        activeChunk.status = "partial";
        activeChunk.retryCount += 1;
      }

      logChunk(activeChunk, {
        appliedNow,
        rejectedSids,
        missingRequiredSids,
        applyFailedSids,
        retrySids: activeChunk.retrySids,
        appliedValues: { ...appliedValues },
        resolvedFields: appliedNow,
      });

      await settle(settings.settleMs);

      const postScan = scanFormFields();
      await reconcileAppliedValues(postScan.targets, appliedValues, {
        fields: postScan.fields,
        settleMs: settings.settleMs,
      });
    }

    const finalScan = scanFormFields();
    const unresolved = getUnresolvedCandidates(finalScan.fields, settings, appliedValues);
    const requiredLeft = unresolved.filter((field) => field.required).length;

    if (requiredLeft > 0) {
      onStatus?.(`Form step ${screenIndex}: ${requiredLeft} required field(s) still unresolved.`);
      return;
    }

    if (!stepComplete) {
      if (requiredLeft === 0 && autoAdvance && screenIndex < maxFormSteps) {
        const advancedAfterLimit = await advanceFormStep(
          settings,
          appliedValues,
          allowFinalSubmit,
          fillLocale,
          docLocale,
          onStatus,
        );
        if (advancedAfterLimit) {
          await waitForStepFields(settings, appliedValues, settings.settleMs);
          pruneAppliedValuesForScan(appliedValues, scanFormFields());
          continue;
        }
      }
      onStatus?.(`Form step ${screenIndex}: reached round limit (${safeMaxRounds}).`);
      return;
    }

    if (!autoAdvance || screenIndex >= maxFormSteps) {
      return;
    }

    const advanced = await advanceFormStep(
      settings,
      appliedValues,
      allowFinalSubmit,
      fillLocale,
      docLocale,
      onStatus,
    );
    if (!advanced) {
      onStatus?.("No next-step button found. Fill stopped.");
      return;
    }
    await waitForStepFields(settings, appliedValues, settings.settleMs);
    pruneAppliedValuesForScan(appliedValues, scanFormFields());
  }
}
