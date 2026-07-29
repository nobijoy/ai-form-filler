/**
 * DOM settling primitives.
 *
 * A fixed delay after each write is either too short (the framework has not
 * re-rendered, so a conditional field is not visible yet) or wastefully long.
 * Observing mutations lets each wait finish as soon as the page actually stops
 * changing.
 */

const OBSERVER_CONFIG: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "style", "hidden", "disabled", "aria-hidden", "aria-invalid", "value"],
};

export interface QuietOptions {
  /** Uninterrupted still time required before resolving. */
  quietMs?: number;
  /** Hard ceiling, so an animation or polling widget cannot stall the run. */
  timeoutMs?: number;
}

/**
 * Resolves once the DOM has been still for `quietMs`, or at `timeoutMs`.
 * Returns whether quiet was reached rather than timing out.
 */
export function waitForDomQuiet(options: QuietOptions = {}): Promise<boolean> {
  const quietMs = Math.max(30, options.quietMs ?? 120);
  const timeoutMs = Math.max(quietMs, options.timeoutMs ?? 3000);

  return new Promise<boolean>((resolve) => {
    let quietTimer: number | undefined;
    let settled = false;

    const observer = new MutationObserver(() => {
      if (settled) return;
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(onQuiet, quietMs);
    });

    const finish = (reachedQuiet: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(quietTimer);
      window.clearTimeout(hardTimer);
      observer.disconnect();
      resolve(reachedQuiet);
    };

    function onQuiet(): void {
      finish(true);
    }

    const hardTimer = window.setTimeout(() => finish(false), timeoutMs);

    observer.observe(document.documentElement, OBSERVER_CONFIG);
    quietTimer = window.setTimeout(onQuiet, quietMs);
  });
}

/** Waits one animation frame plus an optional delay. */
export function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      if (ms <= 0) resolve();
      else setTimeout(resolve, ms);
    });
  });
}

/**
 * Waits for the DOM to quiet, then polls `probe` until it returns a value.
 *
 * Used after writing a value that may reveal dependent fields and after
 * clicking a next-step control: both need "wait until something new shows up,
 * but do not hang if nothing ever does".
 */
export async function waitForNewFields<T>(
  probe: () => T | null,
  options: { timeoutMs?: number; intervalMs?: number; quietMs?: number } = {},
): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? 6000;
  const intervalMs = Math.max(50, options.intervalMs ?? 150);
  const startedAt = Date.now();

  await waitForDomQuiet({ quietMs: options.quietMs ?? 100, timeoutMs: Math.min(timeoutMs, 1500) });

  let result = probe();
  if (result !== null) return result;

  while (Date.now() - startedAt < timeoutMs) {
    await settle(intervalMs);
    result = probe();
    if (result !== null) return result;
  }

  return null;
}
