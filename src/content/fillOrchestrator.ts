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
  const ids = fields.map((f) => f.syntheticId).sort().join(",");
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

function maybeClickNextControl(): boolean {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button, input[type='button'], input[type='submit'], a[role='button'], [role='button']",
    ),
  ).filter(isElementInteractable);

  const positive = /\b(next|continue|proceed|go to next|next step|weiter|fortfahren|continue application)\b/i;
  const negative = /\b(submit|finish|complete|send|save|cancel|back|previous|reset)\b/i;

  for (const el of candidates) {
    const txt = textForNext(el);
    if (!txt) continue;
    if (!positive.test(txt) || negative.test(txt)) continue;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
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

      if (!resp.ok) {
        onStatus?.(resp.error || "LLM request failed.");
        return;
      }

      if (resp.values && Object.keys(resp.values).length > 0) {
        applyValuesToTargets(scan1.targets, resp.values);
      }

      await settle(settings.settleMs);
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

    await settle(Math.max(250, settings.settleMs + 150));
    const afterScan = scanFormFields();
    const afterCandidates = filterCandidates(afterScan.fields, settings);
    const afterSig = signatureForProgress(afterCandidates);
    if (beforeSig === afterSig) {
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
