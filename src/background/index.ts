import { callLlmForFill, getFreeOpenRouterModels } from "./llm";
import { clearApiKey, getApiKey, getSettings, saveApiKey, saveSettings } from "./storage";
import type { ExtensionSettings, FillSnapshot, LlmFillResponse } from "../shared/types";

chrome.runtime.onInstalled.addListener(() => {
  /* cold start */
});

function handleGetSettings(sendResponse: (r: unknown) => void): void {
  void (async () => {
    const settings = await getSettings();
    const k = await getApiKey();
    sendResponse({ settings, hasApiKey: !!(k && k.length > 0) });
  })();
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "fill-form") {
    void triggerFillOnActiveTab();
  }
});

async function triggerFillOnActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "RUN_FILL" });
  } catch {
    /* tab may not have content script */
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    handleGetSettings(sendResponse);
    return true;
  }
  if (message?.type === "LLM_FILL") {
    void handleLlmFill(message.snapshot as FillSnapshot).then(sendResponse);
    return true;
  }
  if (message?.type === "GET_OPENROUTER_MODELS") {
    void (async () => {
      const key = await getApiKey();
      const result = await getFreeOpenRouterModels(key);
      sendResponse(result);
    })();
    return true;
  }
  if (message?.type === "SAVE_SETTINGS") {
    void (async () => {
      const { settings } = message as { settings: Partial<ExtensionSettings> };
      await saveSettings(settings);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "SAVE_API_KEY") {
    void (async () => {
      const { apiKey, rememberAcrossRestarts } = message as {
        apiKey: string;
        rememberAcrossRestarts: boolean;
      };
      await saveSettings({ rememberKeyAcrossRestarts: rememberAcrossRestarts });
      if (apiKey.length > 0) await saveApiKey(apiKey, rememberAcrossRestarts);
      else await clearApiKey();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "CLEAR_API_KEY") {
    void clearApiKey().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

async function handleLlmFill(snapshot: FillSnapshot): Promise<LlmFillResponse> {
  const settings = await getSettings();
  if (settings.fillMode === "heuristics_only") {
    return { ok: true, values: {}, skipped: true };
  }
  const key = await getApiKey();
  if (!key) {
    return { ok: false, error: "No API key configured." };
  }
  const result = await callLlmForFill(snapshot, settings, key);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, values: result.values };
}
