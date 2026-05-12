import { reconcileAppliedValues } from "./apply";
import { getUnresolvedCandidates, visibleFillableFields } from "./candidates";
import { scanFormFields } from "./scan";
import type {
  ExtensionSettings,
  FieldDescriptor,
  LlmNavigationResponse,
  NavigationControlDescriptor,
  NavigationDecision,
  NavigationSnapshot,
} from "../shared/types";

const navElementIds = new WeakMap<Element, string>();
let navIdCounter = 0;

const FORWARD_MARKER_PATTERN =
  /(next|continue|proceed|forward|step|suivant|continuer|weiter|volgende|seguinte|次へ|继续|繼續|다음|التالي)/i;
const BACK_MARKER_PATTERN =
  /(back|prev|previous|cancel|reset|retour|précédent|precedent|戻る|返回|취소|إلغاء)/i;
const FINAL_MARKER_PATTERN =
  /(place.?order|pay now|commander|payer|order now|complete order|finish order|finaliser|confirmer la commande|valider la commande|checkout|submit order)/i;

const HEURISTIC_CONFIDENT_SCORE = 7;
const HEURISTIC_FALLBACK_SCORE = 3;
const AI_CONFIDENCE_THRESHOLD = 0.65;

function syntheticNavIdFor(el: Element): string {
  let id = navElementIds.get(el);
  if (!id) {
    id = `n_${++navIdCounter}`;
    navElementIds.set(el, id);
  }
  return id;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, ms);
    });
  });
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
    el.getAttribute("id") || "",
    el.getAttribute("name") || "",
    el.getAttribute("class") || "",
    el.getAttribute("data-testid") || "",
    el.getAttribute("data-test") || "",
    el.getAttribute("data-action") || "",
    el.getAttribute("aria-label") || "",
    el.getAttribute("title") || "",
    el.getAttribute("type") || "",
    el.getAttribute("role") || "",
  ]
    .join(" ")
    .toLowerCase();
}

function isElementInteractable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
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

function controlPosition(el: HTMLElement, form: HTMLFormElement | null): "start" | "middle" | "end" {
  const scope = form ?? document.body;
  const controls = Array.from(
    scope.querySelectorAll<HTMLElement>(
      "button, input[type='button'], input[type='submit'], a[role='button'], [role='button']",
    ),
  ).filter(isElementInteractable);
  const index = controls.indexOf(el);
  if (index < 0) return "middle";
  if (index === 0) return "start";
  if (index >= controls.length - 1) return "end";
  return "middle";
}

function markerScoreFor(el: HTMLElement): number {
  const combined = `${controlLabel(el)} ${controlAttrBag(el)}`;
  let score = 0;
  if (el.matches("[rel='next'], [data-next], [data-step-next], [aria-controls]")) score += 4;
  if (FORWARD_MARKER_PATTERN.test(combined)) score += 3;
  if (BACK_MARKER_PATTERN.test(combined)) score -= 5;
  if (FINAL_MARKER_PATTERN.test(combined)) score -= 4;
  return score;
}

export function scanNavigationCandidates(): {
  controls: NavigationControlDescriptor[];
  targets: Map<string, HTMLElement>;
} {
  const activeForm = detectActiveForm();
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button, input[type='button'], input[type='submit'], a[role='button'], [role='button'], a[rel='next']",
    ),
  ).filter(isElementInteractable);

  const controls: NavigationControlDescriptor[] = [];
  const targets = new Map<string, HTMLElement>();

  for (const el of nodes) {
    const sid = syntheticNavIdFor(el);
    targets.set(sid, el);
    const tag = el.tagName.toLowerCase();
    const inputType = el instanceof HTMLInputElement ? el.type || "button" : undefined;
    const isSubmit =
      (el instanceof HTMLButtonElement && (el.type || "submit") === "submit") ||
      (el instanceof HTMLInputElement && el.type === "submit");

    controls.push({
      sid,
      tag,
      inputType,
      labelText: controlLabel(el).slice(0, 120),
      ariaLabel: el.getAttribute("aria-label") || undefined,
      name: el.getAttribute("name") || undefined,
      role: el.getAttribute("role") || undefined,
      inActiveForm: !!(activeForm && activeForm.contains(el)),
      isSubmit,
      markerScore: markerScoreFor(el),
      position: controlPosition(el, activeForm),
    });
  }

  return { controls, targets };
}

export function inferWizardStepCount(): number {
  let best = 0;

  const countNodes = (selector: string): void => {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length > best) best = nodes.length;
  };

  countNodes("[role='tablist'] [role='tab']");
  countNodes(".wizard-steps li, .steps li, ol.steps > li, ul.steps > li");
  countNodes("[data-step], [data-step-index]");

  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-total-steps], [data-max-step], [data-step-total]",
    ),
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

  return best;
}

export function detectMultiStepHints(): string[] {
  const hints: string[] = [];
  if (
    document.querySelector(
      "[role='tablist'], [data-step], [data-step-index], .step, .wizard, .multi-step",
    )
  ) {
    hints.push("step-ui");
  }
  if (document.querySelector("[aria-current='step'], [aria-current='page']")) {
    hints.push("aria-current-step");
  }
  if (
    document.querySelector(
      'input[type="hidden"][name*="step"], input[type="hidden"][name*="Step"], input[type="hidden"][name*="stage"], input[type="hidden"][name*="Stage"]',
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

function signatureForProgress(fields: FieldDescriptor[]): string {
  const ids = fields
    .map((field) => `${field.syntheticId}:${field.labelText ?? ""}:${field.formPurpose ?? ""}`)
    .sort()
    .join(",");
  return `${location.href}|${document.title}|${ids}`;
}

function scoreNavigationControl(
  control: NavigationControlDescriptor,
  allowFinalSubmit: boolean,
): number {
  let score = control.markerScore;
  if (control.inActiveForm) score += 5;
  if (control.position === "end") score += 2;
  if (control.isSubmit && control.markerScore < 2) score -= 2;
  if (FINAL_MARKER_PATTERN.test(`${control.labelText} ${control.name || ""}`)) {
    score -= allowFinalSubmit ? 1 : 8;
  }
  return score;
}

function heuristicNavigationDecision(
  controls: NavigationControlDescriptor[],
  allowFinalSubmit: boolean,
  multiStepHints: string[],
): NavigationDecision | null {
  if (controls.length === 0) return null;

  const ranked = controls
    .map((control) => ({ control, score: scoreNavigationControl(control, allowFinalSubmit) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;

  const best = ranked[0];
  const second = ranked[1];
  const ambiguous = !!second && second.score >= best.score - 1;
  const isMultiStep = multiStepHints.length > 0 || controls.some((control) => control.markerScore > 0);
  const isFinalSubmit =
    FINAL_MARKER_PATTERN.test(best.control.labelText) ||
    (best.control.isSubmit && best.control.markerScore < 1);

  if (ambiguous || best.score < HEURISTIC_CONFIDENT_SCORE) return null;
  if (isFinalSubmit && !allowFinalSubmit) return null;

  return {
    isMultiStep,
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
): NavigationDecision | null {
  const ranked = controls
    .map((control) => ({ control, score: scoreNavigationControl(control, allowFinalSubmit) }))
    .filter((entry) => entry.score >= HEURISTIC_FALLBACK_SCORE)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return null;

  const isFinalSubmit =
    FINAL_MARKER_PATTERN.test(best.control.labelText) ||
    (best.control.isSubmit && best.control.markerScore < 1);
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

function buildNavigationSnapshot(
  fields: FieldDescriptor[],
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
  fillLocale: string,
  documentLocale: string,
): NavigationSnapshot {
  const { controls } = scanNavigationCandidates();
  const unresolved = getUnresolvedCandidates(fields, settings, appliedValues);
  return {
    pageTitle: document.title,
    pageUrl: `${location.origin}${location.pathname}`,
    documentLocale,
    fillLocale,
    visibleFillableFieldCount: visibleFillableFields(fields).length,
    unresolvedRequiredCount: unresolved.filter((field) => field.required).length,
    multiStepHints: detectMultiStepHints(),
    controls,
  };
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
): Promise<NavigationDecision | null> {
  const heuristic = heuristicNavigationDecision(
    snapshot.controls,
    allowFinalSubmit,
    snapshot.multiStepHints,
  );
  if (heuristic) return heuristic;

  if (settings.fillMode === "heuristics_only") {
    return fallbackHeuristicDecision(snapshot.controls, allowFinalSubmit, snapshot.multiStepHints);
  }

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
      decision.confidence >= AI_CONFIDENCE_THRESHOLD &&
      (!decision.isFinalSubmit || allowFinalSubmit)
    ) {
      return { ...decision, source: "ai" };
    }
  }

  return fallbackHeuristicDecision(snapshot.controls, allowFinalSubmit, snapshot.multiStepHints);
}

function clickNavigationControl(sid: string, targets: Map<string, HTMLElement>): boolean {
  const el = targets.get(sid);
  if (!el || !isElementInteractable(el)) return false;
  try {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    el.click();
    console.debug("[AI Form Filler] clicked navigation control", {
      sid,
      label: controlLabel(el).slice(0, 80),
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForFormStepChange(
  beforeFieldIds: Set<string>,
  beforeSig: string,
  settleMs: number,
  timeoutMs = 8000,
): Promise<boolean> {
  const startUrl = location.href;
  const waitMs = Math.max(250, settleMs);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await settle(waitMs);
    if (location.href !== startUrl) return true;

    const scan = scanFormFields();
    const visibleFields = visibleFillableFields(scan.fields);
    const currentIds = new Set(visibleFields.map((field) => field.syntheticId));
    for (const sid of currentIds) {
      if (!beforeFieldIds.has(sid)) return true;
    }
    if (currentIds.size !== beforeFieldIds.size) return true;
    if (signatureForProgress(visibleFields) !== beforeSig) return true;
  }

  return false;
}

function pruneAppliedValuesForScan(
  appliedValues: Record<string, string>,
  fields: FieldDescriptor[],
): void {
  const activeIds = new Set(fields.map((field) => field.syntheticId));
  for (const sid of Object.keys(appliedValues)) {
    if (!activeIds.has(sid)) delete appliedValues[sid];
  }
}

export async function advanceFormStep(
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
  allowFinalSubmit: boolean,
  fillLocale: string,
  documentLocale: string,
  onStatus?: (s: string) => void,
): Promise<boolean> {
  const scan = scanFormFields();
  await reconcileAppliedValues(scan.targets, appliedValues, {
    fields: scan.fields,
    settleMs: settings.settleMs,
  });

  const unresolved = getUnresolvedCandidates(scan.fields, settings, appliedValues);
  const requiredLeft = unresolved.filter((field) => field.required).length;
  if (requiredLeft > 0) {
    console.debug("[AI Form Filler] advance blocked by required fields", { requiredLeft });
    return false;
  }

  const visibleFields = visibleFillableFields(scan.fields);
  const beforeFieldIds = new Set(visibleFields.map((field) => field.syntheticId));
  const beforeSig = signatureForProgress(visibleFields);
  const { targets } = scanNavigationCandidates();
  const snapshot = buildNavigationSnapshot(
    scan.fields,
    settings,
    appliedValues,
    fillLocale,
    documentLocale,
  );

  const decision = await resolveNavigationDecision(snapshot, settings, allowFinalSubmit);
  if (!decision?.shouldAdvanceAfterFill || !decision.nextControlSid) {
    console.debug("[AI Form Filler] no navigation decision", { decision });
    return false;
  }

  if (!clickNavigationControl(decision.nextControlSid, targets)) {
    return false;
  }

  onStatus?.(
    decision.source === "ai"
      ? "Advancing to the next form step (AI navigation)…"
      : "Advancing to the next form step…",
  );
  await settle(Math.max(settings.settleMs, 400));
  const changed = await waitForFormStepChange(beforeFieldIds, beforeSig, settings.settleMs);
  if (!changed) {
    onStatus?.("Next-step click did not change the visible form.");
    return false;
  }

  const afterScan = scanFormFields();
  pruneAppliedValuesForScan(appliedValues, afterScan.fields);
  await reconcileAppliedValues(afterScan.targets, appliedValues, {
    fields: afterScan.fields,
    settleMs: settings.settleMs,
  });
  return true;
}
