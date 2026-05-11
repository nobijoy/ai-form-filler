import { callLlmForFill, getProviderModels, testProviderKey } from "./llm";
import { PROVIDERS } from "../shared/providers";
import {
  clearApiKey,
  clearEphemeralBrowserSessionKey,
  getApiKey,
  getSettings,
  saveApiKey,
  saveSettings,
} from "./storage";
import type { ExtensionSettings, FillMode, FillSnapshot, LlmFillResponse, LlmProviderId } from "../shared/types";

const MENU_ID = "aff_fill_now";
let contextMenuRefresh: Promise<void> = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void refreshContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  void clearEphemeralBrowserSessionKey();
  void refreshContextMenu();
});

function modeLabel(mode: FillMode): string {
  if (mode === "ai_only") return "AI only";
  if (mode === "heuristics_only") return "Heuristics only";
  return "Hybrid";
}

async function refreshContextMenu(): Promise<void> {
  contextMenuRefresh = contextMenuRefresh.then(async () => {
    const settings = await getSettings();
    const title = `Fill this page (${modeLabel(settings.fillMode)})`;

    chrome.contextMenus.update(MENU_ID, { title, contexts: ["page", "editable"] }, () => {
      const updateErr = chrome.runtime.lastError;
      if (!updateErr) {
        console.debug("[AI Form Filler] context menu updated:", title);
        return;
      }

      chrome.contextMenus.remove(MENU_ID, () => {
        const removeErr = chrome.runtime.lastError;
        if (removeErr) {
          console.debug("[AI Form Filler] contextMenus.remove warning:", removeErr);
        }
        chrome.contextMenus.create(
          {
            id: MENU_ID,
            title,
            contexts: ["page", "editable"],
          },
          () => {
            const createErr = chrome.runtime.lastError;
            if (createErr) {
              console.debug(
                "[AI Form Filler] contextMenus.create error:",
                createErr,
              );
            } else {
              console.debug("[AI Form Filler] context menu ready:", title);
            }
          },
        );
      });
    });
  });
  return contextMenuRefresh;
}

void refreshContextMenu();

function handleGetSettings(sendResponse: (r: unknown) => void): void {
  void (async () => {
    const settings = await getSettings();
    const hasKeys: Partial<Record<LlmProviderId, boolean>> = {};
    const keyPrefixes: Partial<Record<LlmProviderId, string>> = {};
    for (const provider of Object.keys(PROVIDERS) as LlmProviderId[]) {
      const key = await getApiKey(provider);
      hasKeys[provider] = !!(key && key.length > 0);
      if (key && key.length > 0) keyPrefixes[provider] = key.slice(0, 6);
    }
    sendResponse({ settings, hasApiKey: !!hasKeys[settings.provider], hasKeys, keyPrefixes });
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
  if (message?.type === "GET_PROVIDER_MODELS") {
    void (async () => {
      const { provider } = message as { provider: LlmProviderId };
      const key = await getApiKey(provider);
      const result = await getProviderModels(provider, key);
      sendResponse(result);
    })();
    return true;
  }
  if (message?.type === "SAVE_SETTINGS") {
    void (async () => {
      const { settings } = message as { settings: Partial<ExtensionSettings> };
      await saveSettings(settings);
      await refreshContextMenu();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "SAVE_API_KEY") {
    void (async () => {
      const { apiKey, rememberAcrossRestarts } = message as {
        provider: LlmProviderId;
        apiKey: string;
        rememberAcrossRestarts: boolean;
      };
      await saveSettings({ rememberKeyAcrossRestarts: rememberAcrossRestarts });
      const provider = (message as { provider: LlmProviderId }).provider;
      if (apiKey.length > 0) await saveApiKey(provider, apiKey, rememberAcrossRestarts);
      else await clearApiKey(provider);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "TEST_API_KEY") {
    void (async () => {
      const { provider } = message as { provider: LlmProviderId };
      const settings = await getSettings();
      const key = await getApiKey(provider);
      if (!key) {
        sendResponse({ ok: false, error: "No key saved for this provider. Enter a key and click Save first." });
        return;
      }
      const baseUrl =
        settings.provider === provider
          ? settings.baseUrl
          : PROVIDERS[provider].defaultBaseUrl;
      const model = PROVIDERS[provider].defaultModel;
      const keyPrefix = key.slice(0, 6);
      console.debug("[AI Form Filler] testing provider key", { provider, baseUrl, model, keyPrefix });
      const result = await testProviderKey(provider, key, baseUrl, model);
      sendResponse({ ...result, keyPrefix });
    })();
    return true;
  }
  if (message?.type === "CLEAR_API_KEY") {
    void clearApiKey((message as { provider?: LlmProviderId }).provider).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }
  return false;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  console.debug("[AI Form Filler] context menu clicked on tab:", tab.id);
  void chrome.tabs.sendMessage(tab.id, { type: "RUN_FILL" }).catch(() => {
    /* no content script on this tab */
  });
});

async function handleLlmFill(snapshot: FillSnapshot): Promise<LlmFillResponse> {
  const settings = await getSettings();
  if (settings.fillMode === "heuristics_only") {
    return { ok: true, values: {}, skipped: true };
  }
  const apiKeys: Partial<Record<LlmProviderId, string>> = {};
  for (const provider of Object.keys(PROVIDERS) as LlmProviderId[]) {
    const key = await getApiKey(provider);
    if (key) apiKeys[provider] = key;
  }
  if (!apiKeys[settings.provider]) {
    return { ok: false, error: "No API key configured." };
  }
  const result = await callLlmForFill(snapshot, settings, apiKeys);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, values: result.values };
}
