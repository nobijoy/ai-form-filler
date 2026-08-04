import { runFillOrchestration, type OrchestrationResume } from "./fillOrchestrator";
import {
  checkpointMatchesPage,
  clearCheckpoint,
  loadCheckpoint,
  publishRunComplete,
  type FillCheckpoint,
} from "./runPersistence";
import { settle, waitForDomQuiet } from "./settle";
import type { ExtensionSettings, FillRunResult } from "../shared/types";

interface GetSettingsResponse {
  settings: ExtensionSettings;
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

/**
 * Forwards a progress line to anything listening (the side panel).
 *
 * Fire-and-forget: with no panel open there is no receiver, and that must not
 * interrupt the run.
 */
function reportProgress(message: string): void {
  console.debug("[AI Form Filler]", message);
  try {
    chrome.runtime.sendMessage({ type: "RUN_PROGRESS", message, at: Date.now() }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // Extension context invalidated mid-run.
  }
}

declare global {
  interface Window {
    __aiFormFillerListenerInstalled__?: boolean;
    __aiFormFillerRunInProgress__?: boolean;
  }
}

async function getOwnTabId(): Promise<number | undefined> {
  try {
    const res = await sendMessage<{ tabId?: number }>({ type: "GET_OWN_TAB_ID" });
    return res.tabId;
  } catch {
    return undefined;
  }
}

async function executeFill(resume?: OrchestrationResume): Promise<FillRunResult> {
  const { settings } = await sendMessage<GetSettingsResponse>({ type: "GET_SETTINGS" });
  return runFillOrchestration(settings, reportProgress, resume);
}

function resumeFromCheckpoint(checkpoint: FillCheckpoint): OrchestrationResume {
  return {
    nextStep: checkpoint.nextStep,
    maxSteps: checkpoint.maxSteps,
    stepsCompleted: checkpoint.stepsCompleted,
    fieldsFilled: checkpoint.fieldsFilled,
    warnings: checkpoint.warnings,
    context: checkpoint.context,
  };
}

/**
 * Full-page wizards often hydrate after document_idle. Starting too early makes
 * the step look empty, which used to click Continue again and loop the route.
 */
async function waitForHydratedDocument(): Promise<void> {
  await waitForDomQuiet({ quietMs: 200, timeoutMs: 4000 });
  await settle(300);
}

async function runResumedFill(checkpoint: FillCheckpoint): Promise<FillRunResult> {
  reportProgress(
    `Resuming on ${location.pathname}${location.search || ""} at step ${checkpoint.nextStep}…`,
  );
  await waitForHydratedDocument();
  return executeFill(resumeFromCheckpoint(checkpoint));
}

async function runWithCheckpoint(checkpoint: FillCheckpoint): Promise<FillRunResult> {
  try {
    const result = await runResumedFill(checkpoint);
    await publishRunComplete(result);
    return result;
  } catch (error) {
    await clearCheckpoint();
    const message = error instanceof Error ? error.message : String(error);
    reportProgress(`Run failed after navigation: ${message}`);
    const result: FillRunResult = {
      ok: false,
      warnings: [message],
      stepsCompleted: checkpoint.stepsCompleted,
      fieldsFilled: checkpoint.fieldsFilled,
    };
    await publishRunComplete(result);
    return result;
  }
}

async function maybeResumeAfterNavigation(): Promise<boolean> {
  if (window.__aiFormFillerRunInProgress__) return false;

  const checkpoint = await loadCheckpoint();
  const tabId = await getOwnTabId();
  if (!checkpoint || !checkpointMatchesPage(checkpoint, tabId)) return false;

  window.__aiFormFillerRunInProgress__ = true;
  try {
    await runWithCheckpoint(checkpoint);
    return true;
  } finally {
    window.__aiFormFillerRunInProgress__ = false;
  }
}

if (!window.__aiFormFillerListenerInstalled__) {
  window.__aiFormFillerListenerInstalled__ = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;

    const type = (message as { type?: string } | undefined)?.type;

    if (type === "PING") {
      sendResponse({ ok: true, runInProgress: !!window.__aiFormFillerRunInProgress__ });
      return false;
    }

    if (type === "RESUME_IF_PENDING") {
      void (async () => {
        if (window.__aiFormFillerRunInProgress__) {
          sendResponse({ ok: true, started: false, reason: "already-running" });
          return;
        }

        const checkpoint = await loadCheckpoint();
        const tabId = await getOwnTabId();
        if (!checkpoint || !checkpointMatchesPage(checkpoint, tabId)) {
          sendResponse({ ok: true, started: false, reason: "no-checkpoint" });
          return;
        }

        // Claim before answering so the document_idle auto-resume cannot start twice.
        window.__aiFormFillerRunInProgress__ = true;
        sendResponse({ ok: true, started: true, nextStep: checkpoint.nextStep });
        try {
          await runWithCheckpoint(checkpoint);
        } finally {
          window.__aiFormFillerRunInProgress__ = false;
        }
      })();
      return true;
    }

    if (type !== "RUN_FILL") return false;

    void (async () => {
      if (window.__aiFormFillerRunInProgress__) {
        sendResponse({ ok: false, error: "A fill run is already in progress on this page." });
        return;
      }

      // A fresh manual run replaces any leftover checkpoint from a prior attempt.
      await clearCheckpoint();

      window.__aiFormFillerRunInProgress__ = true;
      try {
        const result: FillRunResult = await executeFill();
        await publishRunComplete(result);
        sendResponse({
          ok: result.ok,
          warnings: result.warnings,
          stepsCompleted: result.stepsCompleted,
          fieldsFilled: result.fieldsFilled,
          error: result.ok ? undefined : result.warnings[result.warnings.length - 1],
        });
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error);
        reportProgress(`Run failed: ${errMessage}`);
        const result: FillRunResult = {
          ok: false,
          warnings: [errMessage],
          stepsCompleted: 0,
          fieldsFilled: 0,
        };
        await publishRunComplete(result);
        sendResponse({ ok: false, error: errMessage });
      } finally {
        window.__aiFormFillerRunInProgress__ = false;
      }
    })();

    return true;
  });

  // Full-page wizards destroy this document on "Continue". Resume from the
  // checkpoint once the next step's document has loaded (same tab only).
  void maybeResumeAfterNavigation();
}
