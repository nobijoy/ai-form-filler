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
  for (let round = 0; round < settings.maxRounds; round++) {
    const scan0: ScanResult = scanFormFields();
    let candidates = filterCandidates(scan0.fields, settings);

    if (candidates.length === 0) {
      onStatus?.(`Done after ${round} round(s).`);
      return;
    }

    onStatus?.(`Pass ${round + 1}/${settings.maxRounds}…`);

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

  onStatus?.(`Reached max rounds (${settings.maxRounds}).`);
}
