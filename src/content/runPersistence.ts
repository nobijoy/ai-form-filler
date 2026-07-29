import type { FillRunResult, RunContext } from "../shared/types";

/**
 * Lets a fill survive full-page navigations between wizard steps
 * (e.g. /reload-wizard?step=1 → ?step=2), which destroy the content script.
 */

const STORAGE_KEY = "fillCheckpoint";
const MAX_AGE_MS = 5 * 60 * 1000;

export interface FillCheckpoint {
  version: 1;
  /** Same-document identity: origin + pathname, ignoring query/hash. */
  formKey: string;
  createdAt: number;
  updatedAt: number;
  nextStep: number;
  maxSteps: number;
  stepsCompleted: number;
  fieldsFilled: number;
  warnings: string[];
  context: RunContext;
}

export function formKeyFromLocation(
  loc: Pick<Location, "origin" | "pathname"> = location,
): string {
  const path = loc.pathname.replace(/\/+$/, "") || "/";
  return `${loc.origin}${path}`;
}

export async function saveCheckpoint(checkpoint: FillCheckpoint): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: checkpoint });
  } catch {
    // Session storage can be unavailable in rare contexts; navigation resume
    // simply will not work for this run.
  }
}

export async function loadCheckpoint(): Promise<FillCheckpoint | null> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY] as FillCheckpoint | undefined;
    if (!value || value.version !== 1) return null;
    if (Date.now() - value.updatedAt > MAX_AGE_MS) {
      await clearCheckpoint();
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function clearCheckpoint(): Promise<void> {
  try {
    await chrome.storage.session.remove(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function checkpointMatchesPage(checkpoint: FillCheckpoint): boolean {
  return checkpoint.formKey === formKeyFromLocation();
}

export async function publishRunComplete(result: FillRunResult): Promise<void> {
  try {
    chrome.runtime.sendMessage({ type: "RUN_COMPLETE", result, at: Date.now() }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // No listener (panel closed).
  }
}
