import { applyValuesToTargets } from "./apply";
import type { ScanResult } from "./scan";
import { resolveDocumentLocale, resolveFillLocale, scanFormFields } from "./scan";
import { parsePersona, tryHeuristicValue } from "../shared/heuristics";
import type {
  ChunkDescriptor,
  ExtensionSettings,
  FieldDescriptor,
  FillSnapshot,
  FormMemory,
  LlmFillResponse,
} from "../shared/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 8;

const SECTION_ORDER = [
  "basic_info",
  "work_salary",
  "benefits_holidays",
  "candidate_requirements",
  "appeal_selection_contact",
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
  | "rate_limited"
  | "completed"
  | "partial"
  | "failed";

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
  const bySection: Record<string, string[]> = {};
  for (const s of SECTION_ORDER) bySection[s] = [];

  for (const f of fields) {
    const section = detectSection(f);
    bySection[section].push(f.syntheticId);
  }

  return SECTION_ORDER.filter((s) => bySection[s].length > 0).map((s) => ({
    sectionName: s,
    fieldSids: bySection[s],
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

/**
 * Extract the suggested retry delay (ms) from a rate-limit error message.
 * Falls back to 10 s when no delay is embedded.
 */
function extractRetryAfterMs(errMsg: string): number {
  const secMatch = errMsg.match(/try again in (\d+\.?\d*)\s*s/i);
  if (secMatch) return Math.ceil(parseFloat(secMatch[1]) * 1000) + 500;
  const msMatch = errMsg.match(/retry[- ]?after[: ]+(\d+)\s*ms/i);
  if (msMatch) return parseInt(msMatch[1], 10) + 500;
  return 10_000;
}

function isFieldEmpty(f: FieldDescriptor): boolean {
  if (f.inputType === "checkbox") return f.currentValue !== "true";
  if (f.inputType === "radio") return !f.currentValue?.trim();
  return !String(f.currentValue ?? "").trim();
}

function filterCandidates(
  fields: FieldDescriptor[],
  settings: ExtensionSettings,
): FieldDescriptor[] {
  return fields.filter(
    (f) => f.visible && !f.disabled && (!settings.fillEmptyOnly || isFieldEmpty(f)),
  );
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, ms);
    });
  });
}

function signatureForProgress(fields: FieldDescriptor[]): string {
  const ids = fields
    .map((f) => `${f.syntheticId}:${f.labelText ?? ""}:${f.formPurpose ?? ""}`)
    .sort()
    .join(",");
  return `${location.href}|${document.title}|${ids}`;
}

function requiredUnfilledCount(fields: FieldDescriptor[]): number {
  return fields.filter((f) => f.required && f.visible && !f.disabled && isFieldEmpty(f)).length;
}

function textForNext(el: Element): string {
  return (
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.textContent ||
    (el instanceof HTMLInputElement ? el.value : "") ||
    ""
  )
    .toLowerCase()
    .trim();
}

function attrBag(el: Element): string {
  const bits = [
    el.getAttribute("id") || "",
    el.getAttribute("name") || "",
    el.getAttribute("class") || "",
    el.getAttribute("data-testid") || "",
    el.getAttribute("data-test") || "",
    el.getAttribute("data-action") || "",
    el.getAttribute("aria-label") || "",
    el.getAttribute("title") || "",
  ];
  return bits.join(" ").toLowerCase();
}

function isElementInteractable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if ((el as HTMLButtonElement).disabled) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function detectActiveForm(): HTMLFormElement | null {
  const forms = Array.from(document.querySelectorAll<HTMLFormElement>("form"));
  if (forms.length === 0) return null;
  let best: { form: HTMLFormElement; score: number } | null = null;
  for (const form of forms) {
    const controls = Array.from(
      form.querySelectorAll<HTMLElement>("input, select, textarea, button"),
    ).filter(isElementInteractable);
    const score = controls.length;
    if (!best || score > best.score) best = { form, score };
  }
  return best?.form ?? null;
}

function maybeClickNextControl(): boolean {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button, input[type='button'], input[type='submit'], a[role='button'], [role='button'], a[rel='next']",
    ),
  ).filter(isElementInteractable);

  if (candidates.length === 0) return false;

  const activeForm = detectActiveForm();
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 1;
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 1;

  const scored = candidates
    .map((el) => {
      let score = 0;
      const attrs = attrBag(el);
      const txt = textForNext(el);
      const rect = el.getBoundingClientRect();

      if (activeForm && activeForm.contains(el)) score += 5;
      if (el instanceof HTMLButtonElement && (el.type || "submit") === "submit") score += 2;
      if (el instanceof HTMLInputElement && el.type === "submit") score += 2;
      if (el.matches("[rel='next'], [data-next], [data-step-next], [aria-controls]")) score += 3;

      score += (rect.left + rect.width / 2) / viewportW;
      score += (rect.top + rect.height / 2) / viewportH;

      if (/\b(back|prev|previous|cancel|reset)\b/.test(attrs)) score -= 6;
      if (/\b(submit|finish|complete|done|final|place-order|checkout)\b/.test(attrs)) score -= 4;

      if (/\b(next|continue|proceed|suivant|continuer|weiter)\b/i.test(txt)) score += 2;
      if (/^(next|continue|suivant|continuer|weiter|volgende|seguinte)\b/i.test(txt)) score += 2;
      if (/\b(submit|finish|complete|send|back|previous|cancel|soumettre|terminer|retour)\b/i.test(txt))
        score -= 3;

      return { el, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 1.5) return false;

  try {
    best.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    if (best.el instanceof HTMLElement) best.el.click();
    return true;
  } catch {
    return false;
  }
}

async function waitForProgressChange(
  beforeSig: string,
  settleMs: number,
  timeoutMs = 3500,
): Promise<boolean> {
  const waitMs = Math.max(250, settleMs);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await settle(waitMs);
    const scan = scanFormFields();
    const currentSig = signatureForProgress(scan.fields.filter((f) => f.visible && !f.disabled));
    if (currentSig !== beforeSig) return true;
  }
  return false;
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
]);

function isPlaceholderValue(value: string, field: FieldDescriptor): boolean {
  const v = value.trim();
  if (!v) return true;
  if (field.placeholder && v === field.placeholder.trim()) return true;
  return PLACEHOLDER_BLOCKLIST.has(v);
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
): Promise<void> {
  const maxSteps = settings.autoNextEnabled ? Math.max(1, settings.autoNextMaxSteps) : 1;
  const safeMaxRounds = Math.min(Math.max(1, settings.maxRounds), MAX_ROUNDS);

  for (let step = 0; step < maxSteps; step++) {
    await runFillStep(settings, safeMaxRounds, step, maxSteps, onStatus);

    if (!settings.autoNextEnabled || step >= maxSteps - 1) break;

    const finalScan = scanFormFields();
    const finalCandidates = filterCandidates(finalScan.fields, settings);
    const requiredLeft = requiredUnfilledCount(finalCandidates);
    if (requiredLeft > 0) {
      onStatus?.(`Stopped auto-next: ${requiredLeft} required field(s) still empty.`);
      return;
    }

    const beforeSig = signatureForProgress(finalCandidates);
    if (!maybeClickNextControl()) {
      onStatus?.("No next-step button found. Auto-next stopped.");
      return;
    }

    const changed = await waitForProgressChange(beforeSig, settings.settleMs);
    if (!changed) {
      onStatus?.("Next-step click did not change the page. Auto-next stopped.");
      return;
    }
  }

  onStatus?.(
    settings.autoNextEnabled
      ? `Auto-next stopped after ${Math.max(1, settings.autoNextMaxSteps)} step limit.`
      : "Fill complete.",
  );
}

// ---------------------------------------------------------------------------
// Per-step fill loop with chunk state machine
// ---------------------------------------------------------------------------

async function runFillStep(
  settings: ExtensionSettings,
  safeMaxRounds: number,
  step: number,
  maxSteps: number,
  onStatus?: (s: string) => void,
): Promise<void> {
  const docLocale = resolveDocumentLocale();
  const fillLocale = resolveFillLocale("auto", "", docLocale);

  // ── Heuristics pass (hybrid / heuristics_only modes) ────────────────────
  if (settings.fillMode !== "ai_only") {
    const scan0: ScanResult = scanFormFields();
    const candidates0 = filterCandidates(scan0.fields, settings);
    const persona = parsePersona(settings.personaJson);
    const heuristicVals: Record<string, string> = {};
    for (const f of candidates0) {
      const v = tryHeuristicValue(f, persona);
      if (v !== null) heuristicVals[f.syntheticId] = v;
    }
    if (Object.keys(heuristicVals).length > 0) {
      applyValuesToTargets(scan0.targets, heuristicVals);
      await settle(settings.settleMs);
    }
  }

  if (settings.fillMode === "heuristics_only") return;

  // ── Initial scan → build chunk states ───────────────────────────────────
  const scanInit: ScanResult = scanFormFields();
  const initCandidates = filterCandidates(scanInit.fields, settings);

  if (initCandidates.length === 0) {
    onStatus?.(`Step ${step + 1}/${maxSteps}: no fillable fields found.`);
    return;
  }

  const formMemory: FormMemory = {
    locale: fillLocale || docLocale || undefined,
    pageTitle: document.title || undefined,
  };

  const chunks: ChunkState[] = buildChunks(initCandidates).map((d, i) =>
    makeChunkState(i, d),
  );

  let aiErrorCount = 0;
  const aiErrorMessages: string[] = [];

  console.debug("[AI Form Filler] starting fill step", {
    step,
    safeMaxRounds,
    chunks: chunks.map((c) => ({ id: c.id, fieldCount: c.fieldSids.length })),
  });

  // ── Round loop ───────────────────────────────────────────────────────────
  for (let round = 0; round < safeMaxRounds; round++) {
    const scan: ScanResult = scanFormFields();
    const candidates = filterCandidates(scan.fields, settings);

    if (candidates.length === 0) {
      onStatus?.(`Step ${step + 1}/${maxSteps}: done after ${round} round(s) — all fields filled.`);
      return;
    }

    // Select the next chunk to work on
    const activeChunk = findNextChunk(chunks);
    if (!activeChunk) {
      onStatus?.(`Step ${step + 1}/${maxSteps}: done after ${round} round(s) — all chunks resolved.`);
      return;
    }

    const isRetry = activeChunk.status === "partial";
    const prevStatus = activeChunk.status;
    activeChunk.status = "in_progress";

    // Determine which sids to send this round
    const sidSet = new Set(candidates.map((f) => f.syntheticId));
    const targetSids = (isRetry ? activeChunk.retrySids : activeChunk.fieldSids).filter((sid) =>
      sidSet.has(sid),
    );
    const chunkFields = candidates.filter((f) => targetSids.includes(f.syntheticId));

    if (chunkFields.length === 0) {
      // All fields in this chunk are already filled or gone from DOM
      activeChunk.status = "completed";
      logChunk(activeChunk, { reason: "all fields already resolved or gone" });
      continue;
    }

    const sectionName = isRetry ? "retry" : activeChunk.sectionName;

    onStatus?.(
      `Step ${step + 1}/${maxSteps} — round ${round + 1}/${safeMaxRounds} [${activeChunk.id}${isRetry ? "/retry" : ""}] (${chunkFields.length} fields)…`,
    );

    logChunk(activeChunk, {
      round,
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
      retryOnly: isRetry ? targetSids : undefined,
    };

    const resp = await sendMessage<LlmFillResponse>({ type: "LLM_FILL", snapshot });

    // ── Error handling ───────────────────────────────────────────────────
    if (!resp.ok) {
      const errMsg = resp.error ?? "LLM request failed.";
      const isRateLimit = /rate.?limit|429|too many request/i.test(errMsg);

      if (isRateLimit) {
        const backoffMs = extractRetryAfterMs(errMsg);
        // Restore previous status so this chunk is retried on the next round
        activeChunk.status = prevStatus;
        logChunk(activeChunk, { errorType: "rate_limit", backoffMs, errMsg: errMsg.slice(0, 200) });
        onStatus?.(`Rate limit — waiting ${(backoffMs / 1000).toFixed(1)} s before retry…`);
        await settle(backoffMs);
        continue;
      }

      activeChunk.status = "failed";
      aiErrorCount += 1;
      aiErrorMessages.push(errMsg);
      logChunk(activeChunk, { errorType: "api_error", errMsg: errMsg.slice(0, 300) });
      onStatus?.(`AI error ${aiErrorCount}/3: ${errMsg}`);

      if (aiErrorCount >= 3) {
        const details = aiErrorMessages
          .map((m, idx) => `${idx + 1}. ${m}`)
          .slice(0, 3)
          .join("\n");
        throw new Error(`Stopped after 3 failed AI requests.\n${details}`);
      }
      await settle(settings.settleMs);
      continue;
    }

    // ── Process successful response ──────────────────────────────────────
    const rawValues = resp.values ?? {};

    // Extract _ctx (serialized as JSON string by parseLlmValues)
    const ctxString = rawValues["_ctx"];
    const valuesWithoutCtx: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawValues)) {
      if (k !== "_ctx") valuesWithoutCtx[k] = v;
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
    );

    if (Object.keys(valid).length > 0) {
      applyValuesToTargets(scan.targets, valid);
    }

    // Update chunk tracking
    const appliedNow = Object.keys(valid);
    activeChunk.appliedSids = [...new Set([...activeChunk.appliedSids, ...appliedNow])];
    activeChunk.rejectedSids = [...new Set([...activeChunk.rejectedSids, ...rejectedSids])];
    activeChunk.missingRequiredSids = missingRequiredSids;
    activeChunk.retrySids = [...new Set([...rejectedSids, ...missingRequiredSids])];

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
      retrySids: activeChunk.retrySids,
    });

    await settle(settings.settleMs);

    // Done when every chunk is resolved
    const allResolved = chunks.every(
      (c) => c.status === "completed" || c.status === "failed",
    );
    if (allResolved) {
      onStatus?.(`Step ${step + 1}/${maxSteps}: done after ${round + 1} round(s).`);
      return;
    }
  }

  onStatus?.(`Step ${step + 1}/${maxSteps}: reached round limit (${safeMaxRounds}).`);
}
