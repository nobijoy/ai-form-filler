import { callLlmForFill, callLlmForNavigation, getProviderModels, testProviderKey } from "./llm";
import { PROVIDERS, PROVIDER_IDS, isProviderId } from "../shared/providers";
import { isVaultUnlocked, lockVault, unlockVault } from "./keyVault";
import {
  clearApiKey,
  clearEphemeralBrowserSessionKey,
  getAllApiKeys,
  getApiKey,
  getSettings,
  hasApiKey,
  isKeyEncrypted,
  normalizeApiKey,
  reencryptStoredKeys,
  saveApiKey,
  saveSettings,
} from "./storage";
import type {
  ExtensionSettings,
  FillSnapshot,
  LlmFillResponse,
  LlmNavigationResponse,
  LlmProviderId,
  NavigationSnapshot,
} from "../shared/types";

const MENU_ID = "aff_fill_now";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void setupContextMenu();
  void enableSidePanelOnActionClick();
});

chrome.runtime.onStartup.addListener(() => {
  void clearEphemeralBrowserSessionKey();
  void setupContextMenu();
  void enableSidePanelOnActionClick();
});

void enableSidePanelOnActionClick();
void setupContextMenu();

async function enableSidePanelOnActionClick(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Side panel API unavailable on this Chrome version.
  }
}

async function setupContextMenu(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });
  chrome.contextMenus.create(
    { id: MENU_ID, title: "Fill this form with AI", contexts: ["page", "editable"] },
    () => void chrome.runtime.lastError,
  );
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  void runFillOnTab(tab.id);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "fill-form") return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await runFillOnTab(tab.id);
  })();
});

async function runFillOnTab(tabId: number): Promise<void> {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "RUN_FILL" });
  } catch {
    // Restricted page, missing host access, or inject failure.
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch {
    // Inject below.
  }

  const files =
    chrome.runtime
      .getManifest()
      .content_scripts?.flatMap((entry) => entry.js ?? [])
      .filter((file): file is string => typeof file === "string" && file.length > 0) ?? [];

  if (files.length === 0) return;

  await chrome.scripting.executeScript({ target: { tabId }, files });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

type Responder = (response: unknown) => void;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = (message as { type?: string } | undefined)?.type;
  if (!type) return false;

  switch (type) {
    case "GET_SETTINGS":
      void handleGetSettings(sendResponse);
      return true;

    case "SAVE_SETTINGS":
      void handleSaveSettings(message as { settings: Partial<ExtensionSettings> }, sendResponse);
      return true;

    case "SAVE_API_KEY":
      void handleSaveApiKey(message as SaveKeyMessage, sendResponse);
      return true;

    case "CLEAR_API_KEY":
      void handleClearApiKey(
        (message as { provider?: LlmProviderId }).provider,
        sendResponse,
      );
      return true;

    case "TEST_API_KEY":
      void handleTestApiKey(message as TestKeyMessage, sendResponse);
      return true;

    case "GET_PROVIDER_MODELS":
      void handleGetProviderModels(
        message as { provider: LlmProviderId; baseUrl?: string },
        sendResponse,
      );
      return true;

    case "UNLOCK_VAULT":
      void handleUnlockVault(message as { passphrase: string }, sendResponse);
      return true;

    case "LOCK_VAULT":
      void lockVault().then(() => sendResponse({ ok: true }));
      return true;

    case "LLM_FILL":
      void handleLlmFill((message as { snapshot: FillSnapshot }).snapshot).then(sendResponse);
      return true;

    case "LLM_NAVIGATION":
      void handleLlmNavigation(
        (message as { snapshot: NavigationSnapshot }).snapshot,
        !!(message as { allowFinalSubmit?: boolean }).allowFinalSubmit,
      ).then(sendResponse);
      return true;

    // RUN_PROGRESS is broadcast by the content script and reaches the side panel
    // directly; re-sending it here would only duplicate every log line.

    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface SaveKeyMessage {
  provider: LlmProviderId;
  apiKey: string;
  rememberAcrossRestarts: boolean;
}

/**
 * Key *presence* is reported, never key material. The previous implementation
 * returned the first six characters of each key to the popup, which leaked
 * secrets into a context that has no need for them.
 */
async function handleGetSettings(sendResponse: Responder): Promise<void> {
  const settings = await getSettings();
  const hasKeys: Partial<Record<LlmProviderId, boolean>> = {};
  const encrypted: Partial<Record<LlmProviderId, boolean>> = {};

  for (const provider of Object.keys(PROVIDERS) as LlmProviderId[]) {
    hasKeys[provider] = await hasApiKey(provider);
    if (hasKeys[provider]) encrypted[provider] = await isKeyEncrypted(provider);
  }

  sendResponse({
    settings,
    hasKeys,
    encryptedKeys: encrypted,
    vaultUnlocked: await isVaultUnlocked(),
  });
}

async function handleSaveSettings(
  message: { settings: Partial<ExtensionSettings> },
  sendResponse: Responder,
): Promise<void> {
  const before = await getSettings();
  const nextProvider =
    message.settings.provider && isProviderId(message.settings.provider)
      ? message.settings.provider
      : before.provider;
  const encryptionChanges =
    message.settings.encryptKeys !== undefined &&
    message.settings.encryptKeys !== before.encryptKeys;
  const retentionChanges =
    message.settings.rememberKeyAcrossRestarts !== undefined &&
    message.settings.rememberKeyAcrossRestarts !== before.rememberKeyAcrossRestarts;

  try {
    if (
      retentionChanges &&
      (await isKeyEncrypted(nextProvider)) &&
      !(await isVaultUnlocked())
    ) {
      sendResponse({
        ok: false,
        error: "Unlock the vault before changing whether this encrypted key persists across browser restarts.",
      });
      return;
    }

    if (encryptionChanges) {
      let encryptedKeysExist = false;
      for (const provider of PROVIDER_IDS) {
        if (await isKeyEncrypted(provider)) {
          encryptedKeysExist = true;
          break;
        }
      }

      const enabling = message.settings.encryptKeys === true;
      const unlockRequired = enabling || encryptedKeysExist;
      if (unlockRequired && !(await isVaultUnlocked())) {
        sendResponse({
          ok: false,
          error: enabling
            ? "Enter a vault passphrase and unlock the vault before enabling encryption."
            : "Unlock the vault before disabling encryption, so stored keys can be decrypted safely.",
        });
        return;
      }

      // Convert the stored material before changing the setting. This prevents
      // encryptKeys=true with plaintext keys (or the inverse) after a failure.
      await reencryptStoredKeys(message.settings.encryptKeys === true);
    }

    await saveSettings(message.settings);
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Could not save settings.",
    });
  }
}

async function handleSaveApiKey(message: SaveKeyMessage, sendResponse: Responder): Promise<void> {
  if (!isProviderId(message.provider)) {
    sendResponse({ ok: false, error: "Unknown provider." });
    return;
  }

  try {
    const settings = await getSettings();
    await saveSettings({ rememberKeyAcrossRestarts: message.rememberAcrossRestarts });

    if (message.apiKey.length > 0) {
      await saveApiKey(
        message.provider,
        message.apiKey,
        message.rememberAcrossRestarts,
        settings.encryptKeys,
      );
    } else {
      await clearApiKey(message.provider);
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Could not save the API key.",
    });
  }
}

async function handleClearApiKey(
  provider: LlmProviderId | undefined,
  sendResponse: Responder,
): Promise<void> {
  if (provider !== undefined && !isProviderId(provider)) {
    sendResponse({ ok: false, error: "Unknown provider." });
    return;
  }

  try {
    await clearApiKey(provider);
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Could not clear the API key.",
    });
  }
}

interface TestKeyMessage {
  provider: LlmProviderId;
  /** Key typed into the panel but not yet saved. Preferred over the stored one. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Tests a key without requiring it to be saved first: the panel sends whatever
 * is currently typed, so "paste, test, then save" works in that order.
 */
async function handleTestApiKey(
  message: TestKeyMessage,
  sendResponse: Responder,
): Promise<void> {
  const provider = message.provider;
  if (!isProviderId(provider)) {
    sendResponse({ ok: false, error: "Unknown provider." });
    return;
  }

  const typed = normalizeApiKey(message.apiKey ?? "");
  const key = typed || (await getApiKey(provider));

  if (!key) {
    const encryptedButLocked = (await hasApiKey(provider)) && !(await isVaultUnlocked());
    sendResponse({
      ok: false,
      error: encryptedButLocked
        ? "This key is encrypted and the vault is locked. Enter your passphrase first."
        : "Enter an API key in the field above, then press Test.",
    });
    return;
  }

  const settings = await getSettings();
  const fallbackBaseUrl =
    settings.provider === provider ? settings.baseUrl : PROVIDERS[provider].defaultBaseUrl;
  const fallbackModel =
    settings.provider === provider ? settings.model : PROVIDERS[provider].defaultModel;

  sendResponse(
    await testProviderKey(
      provider,
      key,
      message.baseUrl?.trim() || fallbackBaseUrl,
      message.model?.trim() || fallbackModel,
    ),
  );
}

async function handleGetProviderModels(
  message: { provider: LlmProviderId; baseUrl?: string },
  sendResponse: Responder,
): Promise<void> {
  if (!isProviderId(message.provider)) {
    sendResponse({ models: [], fromFallback: true });
    return;
  }
  const key = await getApiKey(message.provider);
  sendResponse(await getProviderModels(message.provider, key, message.baseUrl));
}

async function handleUnlockVault(
  message: { passphrase: string },
  sendResponse: Responder,
): Promise<void> {
  try {
    const encryptedProviders: LlmProviderId[] = [];
    for (const provider of PROVIDER_IDS) {
      if (await isKeyEncrypted(provider)) encryptedProviders.push(provider);
    }

    await unlockVault(message.passphrase);

    // Deriving a key always succeeds, even for the wrong passphrase. Verify it
    // against every encrypted API key before reporting the vault as unlocked.
    for (const provider of encryptedProviders) {
      if (await getApiKey(provider)) continue;
      await lockVault();
      sendResponse({ ok: false, error: "Incorrect vault passphrase." });
      return;
    }

    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Could not unlock the vault.",
    });
  }
}

async function handleLlmFill(snapshot: FillSnapshot): Promise<LlmFillResponse> {
  const settings = await getSettings();
  if (settings.fillMode === "heuristics_only") {
    return { ok: true, values: {}, skipped: true };
  }

  const apiKeys = await getAllApiKeys();
  if (!apiKeys[settings.provider]) {
    const locked = (await hasApiKey(settings.provider)) && !(await isVaultUnlocked());
    return {
      ok: false,
      error: locked
        ? `The ${PROVIDERS[settings.provider].label} key is encrypted and the vault is locked. Unlock it in the side panel.`
        : `No ${PROVIDERS[settings.provider].label} API key saved.`,
    };
  }

  const result = await callLlmForFill(snapshot, settings, apiKeys);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, values: result.values };
}

async function handleLlmNavigation(
  snapshot: NavigationSnapshot,
  allowFinalSubmit: boolean,
): Promise<LlmNavigationResponse> {
  const settings = await getSettings();
  if (settings.fillMode === "heuristics_only") {
    return { ok: false, error: "AI navigation is off in heuristics-only mode." };
  }

  const apiKeys = await getAllApiKeys();
  if (!apiKeys[settings.provider]) {
    return { ok: false, error: "No API key saved for the selected provider." };
  }

  const result = await callLlmForNavigation(snapshot, allowFinalSubmit, settings, apiKeys);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, decision: { ...result.decision, source: "ai" } };
}
