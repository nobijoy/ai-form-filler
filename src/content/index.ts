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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RUN_FILL") {
    void (async () => {
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
      }
    })();
    return true;
  }
  return false;
});
