import type { FillRunResult, RunContext } from "../shared/types";

/**
 * Lets a fill survive full-page navigations between wizard steps
 * (e.g. /reload-wizard?step=1 → ?step=2), which destroy the content script.
 */

const STORAGE_KEY = "fillCheckpoint";
const VARIATION_SEQUENCE_KEY = "variationSequence";
const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Allocates a monotonically increasing run number.
 *
 * Random selection can legitimately repeat; a test-data tool should avoid that
 * across adjacent runs. The sequence lets profile pools rotate deterministically
 * while a random suffix still varies unconstrained model output.
 */
export async function reserveVariationSeed(): Promise<string> {
  let sequence = 1;
  try {
    const stored = await chrome.storage.local.get(VARIATION_SEQUENCE_KEY);
    const previous = Number(stored[VARIATION_SEQUENCE_KEY]);
    sequence = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
    await chrome.storage.local.set({ [VARIATION_SEQUENCE_KEY]: sequence });
  } catch {
    sequence = Date.now();
  }

  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `v${sequence}-${random[0].toString(36)}`;
}

export interface FillCheckpoint {
  version: 1;
  /** Same-document identity: origin + pathname, ignoring query/hash. */
  formKey: string;
  /** Tab that started the run; resume only continues on this tab. */
  tabId?: number;
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

export function checkpointMatchesPage(
  checkpoint: FillCheckpoint,
  tabId?: number,
): boolean {
  if (checkpoint.formKey !== formKeyFromLocation()) return false;
  // Older checkpoints without tabId are not auto-resumed (safer boundary).
  if (typeof checkpoint.tabId !== "number") return false;
  if (typeof tabId === "number" && checkpoint.tabId !== tabId) return false;
  return true;
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
