import { runFillOrchestration } from "./fillOrchestrator";
import type { ExtensionSettings } from "../shared/types";

interface GetSettingsResponse {
  settings: ExtensionSettings;
  hasApiKey: boolean;
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

declare global {
  interface Window {
    __aiFormFillerListenerInstalled__?: boolean;
    __aiFormFillerRunInProgress__?: boolean;
  }
}

if (!window.__aiFormFillerListenerInstalled__) {
  window.__aiFormFillerListenerInstalled__ = true;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RUN_FILL") {
    void (async () => {
      if (window.__aiFormFillerRunInProgress__) {
        sendResponse({
          ok: false,
          error: "A fill run is already in progress on this page.",
        });
        return;
      }
      window.__aiFormFillerRunInProgress__ = true;
      try {
        const { settings } = await sendMessage<GetSettingsResponse>({
          type: "GET_SETTINGS",
        });
        await runFillOrchestration(settings, () => {
          /* optional dev status */
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        window.__aiFormFillerRunInProgress__ = false;
      }
    })();
    return true;
  }
  return false;
});
}
