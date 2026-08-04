import { scanFormFields } from "./scan";
import { visibleFillableFields } from "./candidates";
import { settle, waitForDomQuiet } from "./settle";
import type {
  ExtensionSettings,
  FieldDescriptor,
  LlmNavigationResponse,
  NavigationControlDescriptor,
  NavigationDecision,
  NavigationSnapshot,
  ValidationIssue,
} from "../shared/types";

const navElementIds = new WeakMap<Element, string>();
let navIdCounter = 0;

const FORWARD_MARKER_PATTERN =
  /(next|continue|proceed|forward|onward|go on|\bstep\b|suivant|continuer|weiter|fortfahren|volgende|seguinte|siguiente|continuar|avanti|prosegui|næste|następny|дальше|далее|次へ|次に|進む|继续|繼續|下一步|다음|التالي|متابعة)/i;
const BACK_MARKER_PATTERN =
  /(back|prev|previous|cancel|reset|clear|close|dismiss|retour|annuler|précédent|precedent|zurück|abbrechen|vorige|anterior|indietro|戻る|前へ|キャンセル|返回|上一步|取消|이전|취소|إلغاء|رجوع)/i;
const JUMP_MARKER_PATTERN =
  /(go to|jump to|edit|change|return to|aller à|aller a|modifier|éditer|editer|changer|revenir à|revenir a)/i;
/** Terminal actions the extension must not press during auto-advance. */
const FINAL_MARKER_PATTERN =
  /(place.?order|pay\s*now|payment|commander|payer|order\s*now|complete\s*order|finish\s*order|finaliser|confirmer\s+la\s+commande|valider\s+la\s+commande|checkout|submit(\s+(order|application|form))?$|submit\s+(order|application|form)|apply(\s+now)?|send\s+application|envoyer|soumettre|einreichen|jetzt\s+kaufen|bezahlen|購入|決済|注文|支払|\bsubmit\b)/i;

const HEURISTIC_CONFIDENT_SCORE = 7;
const HEURISTIC_FALLBACK_SCORE = 3;
const AI_CONFIDENCE_THRESHOLD = 0.6;

function syntheticNavIdFor(el: Element): string {
  let id = navElementIds.get(el);
  if (!id) {
    id = `n_${++navIdCounter}`;
    navElementIds.set(el, id);
  }
  return id;
}

function controlLabel(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const title = el.getAttribute("title")?.trim();
  if (title) return title;
  if (el instanceof HTMLInputElement) return (el.value || "").trim();
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

function controlAttrBag(el: Element): string {
  return [
    "id",
    "name",
    "class",
    "data-testid",
    "data-test",
    "data-action",
    "aria-label",
    "title",
    "type",
    "role",
  ]
    .map((attr) => el.getAttribute(attr) || "")
    .join(" ")
    .toLowerCase();
}

function isElementInteractable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest("[inert]")) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) === 0) return false;
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
    if (!best || controls.length > best.score) best = { form, score: controls.length };
  }
  return best?.form ?? null;
}

const NAV_CONTROL_SELECTOR =
  "button, input[type='button'], input[type='submit'], a[role='button'], [role='button'], a[rel='next'], [data-next], [data-step-next]";

const FILE_UPLOAD_PATTERN =
  /\b(upload|choose\s+file|select\s+file|browse\s+file|attach(?:ment)?|drop\s+(?:a\s+)?file)\b/i;

/**
 * Upload launchers and PhoneInput country selectors are interactive buttons,
 * but neither navigates a form. Keeping them out also guarantees auto-advance
 * never opens an OS file picker.
 */
function isAuxiliaryControl(el: HTMLElement): boolean {
  if (el.closest(".PhoneInput, [data-phone-input], [class*='phone-input' i]")) return true;
  if (el instanceof HTMLInputElement && el.type === "file") return true;
  if (el.querySelector('input[type="file"]')) return true;

  const container = el.closest(
    "label, [data-dropzone], [data-file-upload], [class*='dropzone' i], [class*='file-upload' i]",
  );
  if (container?.querySelector('input[type="file"]')) return true;

  const controls = el.getAttribute("aria-controls");
  if (controls) {
    for (const id of controls.split(/\s+/)) {
      const target = document.getElementById(id);
      if (target instanceof HTMLInputElement && target.type === "file") return true;
    }
  }

  return FILE_UPLOAD_PATTERN.test(`${controlLabel(el)} ${controlAttrBag(el)}`);
}

function controlPosition(
  el: HTMLElement,
  ordered: HTMLElement[],
): "start" | "middle" | "end" {
  const index = ordered.indexOf(el);
  if (index < 0) return "middle";
  if (index === 0) return "start";
  if (index >= ordered.length - 1) return "end";
  return "middle";
}

function markerScoreFor(el: HTMLElement): number {
  const combined = `${controlLabel(el)} ${controlAttrBag(el)}`;
  let score = 0;
  if (el.matches("[rel='next'], [data-next], [data-step-next]")) score += 4;
  if (FORWARD_MARKER_PATTERN.test(combined)) score += 3;
  if (BACK_MARKER_PATTERN.test(combined)) score -= 5;
  if (JUMP_MARKER_PATTERN.test(combined)) score -= 6;
  if (FINAL_MARKER_PATTERN.test(combined)) score -= 4;
  return score;
}

export function scanNavigationCandidates(): {
  controls: NavigationControlDescriptor[];
  targets: Map<string, HTMLElement>;
} {
  const activeForm = detectActiveForm();
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(NAV_CONTROL_SELECTOR)).filter(
    (el) => isElementInteractable(el) && !isAuxiliaryControl(el),
  );

  const controls: NavigationControlDescriptor[] = [];
  const targets = new Map<string, HTMLElement>();

  for (const el of nodes) {
    const sid = syntheticNavIdFor(el);
    targets.set(sid, el);
    const isSubmit =
      (el instanceof HTMLButtonElement && (el.type || "submit") === "submit") ||
      (el instanceof HTMLInputElement && el.type === "submit");

    controls.push({
      sid,
      tag: el.tagName.toLowerCase(),
      inputType: el instanceof HTMLInputElement ? el.type || "button" : undefined,
      labelText: controlLabel(el).slice(0, 120),
      ariaLabel: el.getAttribute("aria-label") || undefined,
      name: el.getAttribute("name") || undefined,
      role: el.getAttribute("role") || undefined,
      inActiveForm: !!(activeForm && activeForm.contains(el)),
      isSubmit,
      markerScore: markerScoreFor(el),
      position: controlPosition(el, nodes),
    });
  }

  return { controls, targets };
}

// ---------------------------------------------------------------------------
// Wizard detection
// ---------------------------------------------------------------------------

export function inferWizardStepCount(): number {
  let best = 0;

  const countNodes = (selector: string): void => {
    const count = document.querySelectorAll(selector).length;
    if (count > best) best = count;
  };

  countNodes("[role='tablist'] [role='tab']");
  countNodes(".wizard-steps li, .steps li, ol.steps > li, ul.steps > li, .stepper li");
  countNodes("[data-step], [data-step-index]");

  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>("[data-total-steps], [data-max-step], [data-step-total]"),
  )) {
    const total = Number(
      el.getAttribute("data-total-steps") ||
        el.getAttribute("data-max-step") ||
        el.getAttribute("data-step-total"),
    );
    if (Number.isFinite(total) && total > best) best = total;
  }

  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-step-index]"))) {
    const index = Number(el.getAttribute("data-step-index"));
    if (Number.isFinite(index) && index >= 0 && index + 1 > best) best = index + 1;
  }

  // "Step 2 of 5" style copy.
  const bodyText = document.body?.innerText?.slice(0, 4000) ?? "";
  const ofMatch = bodyText.match(/(?:step|schritt|étape|ステップ|단계)\s*\d+\s*(?:of|\/|von|sur|\|)\s*(\d+)/i);
  if (ofMatch) {
    const total = Number(ofMatch[1]);
    if (Number.isFinite(total) && total > best) best = total;
  }

  return best;
}

export function detectMultiStepHints(): string[] {
  const hints: string[] = [];
  if (
    document.querySelector(
      "[role='tablist'], [data-step], [data-step-index], .step, .wizard, .multi-step, .stepper",
    )
  ) {
    hints.push("step-ui");
  }
  if (document.querySelector("[aria-current='step'], [aria-current='page']")) {
    hints.push("aria-current-step");
  }
  if (
    document.querySelector(
      'input[type="hidden"][name*="step" i], input[type="hidden"][name*="stage" i]',
    )
  ) {
    hints.push("hidden-step-field");
  }
  const fieldsets = Array.from(document.querySelectorAll("fieldset"));
  if (fieldsets.some((fieldset) => !isElementInteractable(fieldset))) {
    hints.push("fieldset-visibility");
  }
  if (document.querySelector("form [rel='next'], form [data-next], form [data-step-next]")) {
    hints.push("explicit-next-marker");
  }
  return hints;
}

/** Text of the currently active step indicator, if the page exposes one. */
function activeStepMarker(): string {
  const active = document.querySelector<HTMLElement>(
    "[aria-current='step'], [aria-current='page'], [role='tab'][aria-selected='true'], .step.active, .stepper .active",
  );
  return (active?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * Content-derived signature of what is on screen.
 *
 * Deliberately excludes synthetic ids: those are namespaced per step, so they
 * differ on every scan and would report a change even when nothing moved. Labels,
 * types and option sets describe the step itself.
 */
export function fieldSetFingerprint(fields: FieldDescriptor[]): string {
  const parts = fields
    .map((field) =>
      [
        field.kind ?? field.tag,
        field.inputType ?? "",
        (field.labelText ?? field.ariaLabel ?? field.name ?? "").replace(/\s+/g, " ").slice(0, 60),
        field.options?.length ?? field.radioChoices?.length ?? 0,
      ].join(":"),
    )
    .sort();

  return [
    location.pathname,
    location.search,
    activeStepMarker(),
    String(parts.length),
    parts.join("|"),
  ].join("~");
}

// ---------------------------------------------------------------------------
// Validation feedback
// ---------------------------------------------------------------------------

/**
 * Errors the page is currently reporting. After clicking "next" this is how we
 * distinguish "the wizard refused to advance" from "nothing happened".
 */
export function collectValidationErrors(fields: FieldDescriptor[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const field of fields) {
    if (!field.ariaInvalid && !field.validationMessage) continue;
    issues.push({
      sid: field.syntheticId,
      message:
        field.validationMessage ||
        `${field.labelText ?? field.name ?? "field"} was rejected by the page`,
    });
  }

  const globalAlerts = Array.from(
    document.querySelectorAll<HTMLElement>("[role='alert'], [aria-live='assertive'], .form-error"),
  )
    .filter(isElementInteractable)
    .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0 && text.length < 300);

  for (const message of Array.from(new Set(globalAlerts)).slice(0, 5)) {
    if (issues.some((issue) => issue.message === message)) continue;
    issues.push({ message });
  }

  return issues.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

function controlSearchText(control: NavigationControlDescriptor): string {
  return `${control.labelText} ${control.ariaLabel || ""} ${control.name || ""}`;
}

function hasForwardIntent(control: NavigationControlDescriptor): boolean {
  return FORWARD_MARKER_PATTERN.test(controlSearchText(control));
}

/**
 * Terminal submit/apply controls.
 *
 * "Submit Application" is a final action even when it is a plain `<button type="submit">`
 * with no special payment wording. A submit that also says Next/Continue is treated as
 * forward navigation instead.
 */
function isFinalSubmitControl(control: NavigationControlDescriptor): boolean {
  const text = controlSearchText(control);
  if (FINAL_MARKER_PATTERN.test(text) && !hasForwardIntent(control)) return true;
  if (control.isSubmit && !hasForwardIntent(control)) return true;
  return false;
}

function scoreNavigationControl(
  control: NavigationControlDescriptor,
  allowFinalSubmit: boolean,
): number {
  let score = control.markerScore;
  if (control.inActiveForm) score += 5;
  else score -= 2;
  if (control.position === "end") score += 2;

  if (isFinalSubmitControl(control)) {
    score -= allowFinalSubmit ? 1 : 10;
  } else if (control.isSubmit && hasForwardIntent(control)) {
    // "Continue" that happens to be type=submit is a normal next control.
    score += 2;
  } else if (control.markerScore < 2) {
    score -= 2;
  }

  return score;
}

function rankControls(
  controls: NavigationControlDescriptor[],
  allowFinalSubmit: boolean,
): Array<{ control: NavigationControlDescriptor; score: number }> {
  return controls
    .map((control) => ({ control, score: scoreNavigationControl(control, allowFinalSubmit) }))
    .sort((a, b) => b.score - a.score);
}

/** True when the page has a forward/next control that is not a terminal submit. */
export function hasForwardNavigationControl(allowFinalSubmit = false): boolean {
  const { controls } = scanNavigationCandidates();
  return rankControls(controls, allowFinalSubmit).some(
    (entry) => entry.score > 0 && !isFinalSubmitControl(entry.control),
  );
}

function heuristicNavigationDecision(
  controls: NavigationControlDescriptor[],
  allowFinalSubmit: boolean,
  multiStepHints: string[],
  excludeSids: Set<string>,
): NavigationDecision | null {
  const ranked = rankControls(controls, allowFinalSubmit).filter(
    (entry) => entry.score > 0 && !excludeSids.has(entry.control.sid),
  );
  if (ranked.length === 0) return null;

  const best = ranked[0];
  const second = ranked[1];
  const ambiguous = !!second && second.score >= best.score - 1;
  const isFinalSubmit = isFinalSubmitControl(best.control);

  if (ambiguous || best.score < HEURISTIC_CONFIDENT_SCORE) return null;
  if (isFinalSubmit && !allowFinalSubmit) return null;

  return {
    isMultiStep: multiStepHints.length > 0 || controls.some((c) => c.markerScore > 0),
    shouldAdvanceAfterFill: true,
    nextControlSid: best.control.sid,
    isFinalSubmit,
    confidence: Math.min(1, best.score / 10),
    source: "heuristic",
  };
}

function fallbackHeuristicDecision(
  controls: NavigationControlDescriptor[],
  allowFinalSubmit: boolean,
  multiStepHints: string[],
  excludeSids: Set<string>,
): NavigationDecision | null {
  const ranked = rankControls(controls, allowFinalSubmit).filter(
    (entry) => entry.score >= HEURISTIC_FALLBACK_SCORE && !excludeSids.has(entry.control.sid),
  );
  const best = ranked[0];
  if (!best) return null;

  const isFinalSubmit = isFinalSubmitControl(best.control);
  if (isFinalSubmit && !allowFinalSubmit) return null;

  return {
    isMultiStep: multiStepHints.length > 0,
    shouldAdvanceAfterFill: true,
    nextControlSid: best.control.sid,
    isFinalSubmit,
    confidence: Math.min(1, best.score / 10),
    source: "heuristic",
  };
}

function aiChoiceLooksPlausible(
  decision: NavigationDecision,
  controls: NavigationControlDescriptor[],
  allowFinalSubmit: boolean,
): boolean {
  const chosen = controls.find((control) => control.sid === decision.nextControlSid);
  if (!chosen) return false;
  if (JUMP_MARKER_PATTERN.test(controlSearchText(chosen))) return false;
  // Trust local classification over the model's isFinalSubmit flag.
  if (!allowFinalSubmit && isFinalSubmitControl(chosen)) return false;
  return scoreNavigationControl(chosen, allowFinalSubmit) >= HEURISTIC_FALLBACK_SCORE;
}

function sendMessage<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response as T);
    });
  });
}

async function resolveNavigationDecision(
  snapshot: NavigationSnapshot,
  settings: ExtensionSettings,
  allowFinalSubmit: boolean,
  excludeSids: Set<string>,
): Promise<NavigationDecision | null> {
  const heuristic = heuristicNavigationDecision(
    snapshot.controls,
    allowFinalSubmit,
    snapshot.multiStepHints,
    excludeSids,
  );
  if (heuristic) return heuristic;

  if (settings.fillMode === "heuristics_only") {
    return fallbackHeuristicDecision(
      snapshot.controls,
      allowFinalSubmit,
      snapshot.multiStepHints,
      excludeSids,
    );
  }

  try {
    const resp = await sendMessage<LlmNavigationResponse>({
      type: "LLM_NAVIGATION",
      snapshot,
      allowFinalSubmit,
    });

    if (resp.ok && resp.decision) {
      const decision = resp.decision;
      if (
        decision.shouldAdvanceAfterFill &&
        decision.nextControlSid &&
        !excludeSids.has(decision.nextControlSid) &&
        decision.confidence >= AI_CONFIDENCE_THRESHOLD &&
        (!decision.isFinalSubmit || allowFinalSubmit) &&
        aiChoiceLooksPlausible(decision, snapshot.controls, allowFinalSubmit)
      ) {
        return { ...decision, source: "ai" };
      }
    }
  } catch {
    // Fall through to the heuristic ranking.
  }

  return fallbackHeuristicDecision(
    snapshot.controls,
    allowFinalSubmit,
    snapshot.multiStepHints,
    excludeSids,
  );
}

function clickNavigationControl(el: HTMLElement): boolean {
  if (!isElementInteractable(el)) return false;
  try {
    el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------

export interface AdvanceParams {
  settings: ExtensionSettings;
  allowFinalSubmit: boolean;
  fillLocale: string;
  documentLocale: string;
  beforeFields: FieldDescriptor[];
  unresolvedRequiredCount: number;
  /** Controls already tried this step, so a dead button is not clicked twice. */
  excludeSids?: Set<string>;
  onStatus?: (message: string) => void;
}

export interface AdvanceOutcome {
  advanced: boolean;
  reason?: string;
  clickedSid?: string;
  clickedLabel?: string;
  isFinalSubmit?: boolean;
  validationErrors?: ValidationIssue[];
}

function buildNavigationSnapshot(params: AdvanceParams, controls: NavigationControlDescriptor[]): NavigationSnapshot {
  return {
    pageTitle: document.title,
    pageUrl: `${location.origin}${location.pathname}`,
    documentLocale: params.documentLocale,
    fillLocale: params.fillLocale,
    visibleFillableFieldCount: visibleFillableFields(params.beforeFields, params.settings).length,
    unresolvedRequiredCount: params.unresolvedRequiredCount,
    multiStepHints: detectMultiStepHints(),
    controls,
  };
}

/**
 * Clicks the best forward control and reports what happened.
 *
 * Unlike the previous implementation this never refuses to act because required
 * fields remain: the caller owns that policy and needs the click result in order
 * to surface the page's own validation messages back to the model.
 */
export async function advanceFormStep(params: AdvanceParams): Promise<AdvanceOutcome> {
  const { controls, targets } = scanNavigationCandidates();
  if (controls.length === 0) {
    return { advanced: false, reason: "No navigation controls found on this page." };
  }

  const excludeSids = params.excludeSids ?? new Set<string>();
  const snapshot = buildNavigationSnapshot(params, controls);
  const decision = await resolveNavigationDecision(
    snapshot,
    params.settings,
    params.allowFinalSubmit,
    excludeSids,
  );

  if (!decision?.shouldAdvanceAfterFill || !decision.nextControlSid) {
    return { advanced: false, reason: "Could not identify a next-step control." };
  }

  const el = targets.get(decision.nextControlSid);
  if (!el) {
    return { advanced: false, reason: "Next-step control disappeared before it could be clicked." };
  }

  const label = controlLabel(el).slice(0, 60);
  const beforeFingerprint = fieldSetFingerprint(params.beforeFields);
  const beforeUrl = location.href;

  if (!clickNavigationControl(el)) {
    return { advanced: false, reason: `Could not click "${label}".`, clickedSid: decision.nextControlSid };
  }

  params.onStatus?.(
    decision.source === "ai"
      ? `Clicked "${label}" (chosen by the model).`
      : `Clicked "${label}".`,
  );

  const changed = await waitForStepChange(beforeFingerprint, beforeUrl, params.settings.settleMs);

  if (changed) {
    return {
      advanced: true,
      clickedSid: decision.nextControlSid,
      clickedLabel: label,
      isFinalSubmit: decision.isFinalSubmit,
    };
  }

  // The click landed but the step did not change: the page is most likely
  // reporting validation errors, which the caller can feed back to the model.
  const afterScan = scanFormFields();
  const validationErrors = collectValidationErrors(afterScan.fields);

  return {
    advanced: false,
    clickedSid: decision.nextControlSid,
    clickedLabel: label,
    isFinalSubmit: decision.isFinalSubmit,
    validationErrors,
    reason:
      validationErrors.length > 0
        ? `"${label}" was rejected: ${validationErrors[0].message}`
        : `"${label}" did not change the visible form.`,
  };
}

async function waitForStepChange(
  beforeFingerprint: string,
  beforeUrl: string,
  settleMs: number,
  timeoutMs = 8000,
): Promise<boolean> {
  const startedAt = Date.now();
  const pollMs = Math.max(120, settleMs);

  await waitForDomQuiet({ quietMs: 150, timeoutMs: 2000 });

  while (Date.now() - startedAt < timeoutMs) {
    if (location.href !== beforeUrl) return true;
    const scan = scanFormFields();
    if (fieldSetFingerprint(scan.fields) !== beforeFingerprint) return true;
    await settle(pollMs);
  }

  return false;
}
