import { applyValuesToTargets } from "./apply";
import type { ScanResult } from "./scan";
import { resolveDocumentLocale, resolveFillLocale, scanFormFields } from "./scan";
import { parsePersona, tryHeuristicValue } from "../shared/heuristics";
import type {
  ExtensionSettings,
  FieldDescriptor,
  FillSnapshot,
  LlmFillResponse,
} from "../shared/types";

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

      // Structural hints (language-agnostic)
      if (activeForm && activeForm.contains(el)) score += 5;
      if (el instanceof HTMLButtonElement && (el.type || "submit") === "submit") score += 2;
      if (el instanceof HTMLInputElement && el.type === "submit") score += 2;
      if (el.matches("[rel='next'], [data-next], [data-step-next], [aria-controls]")) score += 3;

      // Primary action placement: typically right/lower area
      score += (rect.left + rect.width / 2) / viewportW;
      score += (rect.top + rect.height / 2) / viewportH;

      // Generic unsafe/final/back indicators (attribute-level)
      if (/\b(back|prev|previous|cancel|reset)\b/.test(attrs)) score -= 6;
      if (/\b(submit|finish|complete|done|final|place-order|checkout)\b/.test(attrs)) score -= 4;

      // Text hints are only weak boosts/penalties now.
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

function sendMessage<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response as T);
    });
  });
}

export async function runFillOrchestration(
  settings: ExtensionSettings,
  onStatus?: (s: string) => void,
): Promise<void> {
  const maxSteps = settings.autoNextEnabled ? Math.max(1, settings.autoNextMaxSteps) : 1;
  const maxAiRequestsPerRun = Math.max(1, settings.maxRounds) * Math.max(1, maxSteps);
  let aiRequestsMade = 0;
  let aiErrorCount = 0;
  const aiErrorMessages: string[] = [];

  for (let step = 0; step < maxSteps; step++) {
    for (let round = 0; round < settings.maxRounds; round++) {
    const scan0: ScanResult = scanFormFields();
    let candidates = filterCandidates(scan0.fields, settings);

    if (candidates.length === 0) {
        onStatus?.(`Done after ${round} round(s).`);
        return;
      }

      onStatus?.(`Step ${step + 1}/${maxSteps} - pass ${round + 1}/${settings.maxRounds}…`);

    const persona = parsePersona(settings.personaJson);
    const heuristicSummary: { syntheticId: string; value: string }[] = [];
    const heuristicVals: Record<string, string> = {};

    if (settings.fillMode !== "ai_only") {
      for (const f of candidates) {
        const v = tryHeuristicValue(f, persona);
        if (v !== null) {
          heuristicVals[f.syntheticId] = v;
          heuristicSummary.push({ syntheticId: f.syntheticId, value: v });
        }
      }
      if (Object.keys(heuristicVals).length > 0) {
        applyValuesToTargets(scan0.targets, heuristicVals);
      }
    }

      await settle(settings.settleMs);

      const scan1 = scanFormFields();
      candidates = filterCandidates(scan1.fields, settings);

      if (settings.fillMode === "heuristics_only") {
        await settle(settings.settleMs);
        continue;
      }

      if (candidates.length === 0) {
        await settle(settings.settleMs);
        continue;
      }

      const docLocale = resolveDocumentLocale();
      const fillLocale = resolveFillLocale("auto", "", docLocale);

      const snapshot: FillSnapshot = {
        pageTitle: document.title,
        pageUrl: `${location.origin}${location.pathname}`,
        documentLocale: docLocale,
        fillLocale,
        roundIndex: round,
        maxRounds: settings.maxRounds,
        fields: candidates,
        heuristicSummary,
      };

      const resp = await sendMessage<LlmFillResponse>({
        type: "LLM_FILL",
        snapshot,
      });
      aiRequestsMade += 1;

      if (!resp.ok) {
        const errMsg = resp.error || "LLM request failed.";
        aiErrorCount += 1;
        aiErrorMessages.push(errMsg);
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

      if (resp.values && Object.keys(resp.values).length > 0) {
        applyValuesToTargets(scan1.targets, resp.values);
      }

      await settle(settings.settleMs);
      if (aiRequestsMade >= maxAiRequestsPerRun) {
        onStatus?.("Stopped at AI request safety limit for this run.");
        return;
      }
    }

    if (!settings.autoNextEnabled || step >= maxSteps - 1) {
      break;
    }

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
      : `Reached max rounds (${settings.maxRounds}).`,
  );
}
