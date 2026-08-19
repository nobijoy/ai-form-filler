import { PROVIDERS, PROVIDER_IDS } from "../shared/providers";
import { DEFAULT_SETTINGS, MAX_FORM_STEPS } from "../shared/types";
import type {
  ExtensionSettings,
  FillMode,
  FillLanguagePolicy,
  LlmProviderId,
  ModelOption,
} from "../shared/types";

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

const FALLBACKS: Record<string, string> = {
  panelTitle: "Autofill AI Ninja",
  labelCustomRequest: "Custom request (optional)",
  hintCustomRequest:
    "Leave empty for normal filling. Use it only when you need something specific, e.g. \"phone as 090-XXXX-XXXX\" or \"user names in Japanese\".",
  placeholderCustomRequest: "e.g. names in Japanese, phone as 090-XXXX-XXXX",
  btnFill: "Fill this page",
  labelProgress: "Progress",
  btnClearLog: "Clear",
  logEmpty: "No activity yet.",
  labelConnection: "Connection",
  labelProvider: "Provider",
  labelApiKey: "API key",
  btnTestKey: "Test",
  btnSaveKey: "Save key",
  btnReplaceKey: "Replace key",
  btnClearKey: "Remove key",
  btnShowKey: "Show",
  btnHideKey: "Hide",
  labelRememberKey: "Remember key across browser restarts",
  labelEncryptKeys: "Encrypt stored keys with a passphrase",
  btnUnlock: "Unlock",
  btnLock: "Lock",
  labelModel: "Model",
  labelBehavior: "Behavior",
  labelFillMode: "Fill mode",
  modeHybrid: "Hybrid (heuristics + AI)",
  modeAiOnly: "AI only",
  modeHeuristicsOnly: "Heuristics only (no API key)",
  labelLanguage: "Value language",
  langAuto: "Follow the page",
  langOverride: "Always use...",
  hintLanguage: "A field with its own lang attribute always wins over this setting.",
  labelAutoNextEnabled: "Advance through multi-step forms automatically",
  labelAutoNextMaxSteps: "Maximum steps",
  labelMaxRounds: "Maximum rounds per step",
  labelSettleMs: "Settle delay (ms)",
  labelFillEmptyOnly: "Fill empty fields only",
  warnFillEmptyOnly:
    "Warning: existing field values (up to 60 characters) may be sent to the LLM, including autofilled personal data.",
  labelExcludeSensitive: "Skip password and payment fields",
  hintExcludeSensitive:
    "When on, password and card fields are never filled and never sent to the AI.",
  hintSettingsAutosave: "Changes save automatically. API keys still need Save key.",
  statusIdle: "Ready.",
  statusNoTab: "No active tab.",
  keyHint:
    "Keys are stored by the extension and read only by its background worker. They are never exposed to web pages.",
  errGeneric: "Something went wrong.",
  passphraseConfirmPlaceholder: "Confirm passphrase",
};

function t(id: string): string {
  const message = chrome.i18n.getMessage(id);
  return message && message.trim() ? message : (FALLBACKS[id] ?? id);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
const select = (id: string): HTMLSelectElement => el<HTMLSelectElement>(id);
const textarea = (id: string): HTMLTextAreaElement => el<HTMLTextAreaElement>(id);

function sendMessage<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response as T);
    });
  });
}

function setStatus(text: string, tone: "idle" | "ok" | "err" = "idle"): void {
  const node = el("status");
  node.textContent = text;
  node.classList.toggle("err", tone === "err");
  node.classList.toggle("ok", tone === "ok");
}

function setKeyStatus(text: string, tone: "idle" | "ok" | "err" = "idle"): void {
  const node = el("keyStatus");
  node.textContent = text;
  node.className =
    tone === "ok" ? "subhint key-ok" : tone === "err" ? "subhint key-err" : "subhint";
}

function setVaultStatus(text: string, tone: "idle" | "ok" | "err" = "idle"): void {
  const node = el("vaultStatus");
  node.textContent = text;
  node.className =
    tone === "ok" ? "subhint key-ok" : tone === "err" ? "subhint key-err" : "subhint";
}

// ---------------------------------------------------------------------------
// Progress log
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 200;

function appendLog(message: string, isError = false): void {
  const list = el<HTMLOListElement>("log");
  const item = document.createElement("li");
  if (isError) item.className = "err";

  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const text = document.createElement("span");
  text.textContent = message;

  item.append(time, text);
  list.append(item);

  while (list.childElementCount > MAX_LOG_ENTRIES) list.firstElementChild?.remove();
  list.scrollTop = list.scrollHeight;
}

// Progress / completion are broadcast by the content script (and survive a
// full-page navigation between wizard steps).
chrome.runtime.onMessage.addListener((message) => {
  const payload = message as { type?: string; message?: string } | undefined;
  if (payload?.type !== "RUN_PROGRESS" || !payload.message) return;
  appendLog(payload.message, /error|failed|could not|stuck|rejected/i.test(payload.message));
});

function isNavigationDisconnect(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /back\/forward cache|message channel is closed|Receiving end does not exist|The page keeping the extension port|context invalidated|Frame with ID/i.test(
    message,
  );
}

function waitForRunComplete(timeoutMs = 180_000): Promise<FillResponse> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("Timed out waiting for the fill to finish after page navigation."));
    }, timeoutMs);

    function listener(message: unknown): void {
      const payload = message as { type?: string; result?: FillResponse } | undefined;
      if (payload?.type !== "RUN_COMPLETE" || !payload.result) return;
      window.clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(payload.result);
    }

    chrome.runtime.onMessage.addListener(listener);
  });
}

function applyFillOutcome(response: FillResponse | undefined): void {
  const summary =
    response?.fieldsFilled !== undefined
      ? `${response.fieldsFilled} field(s) across ${response.stepsCompleted ?? 0} step(s).`
      : "";

  if (response?.ok === false) {
    const message = response.error || response.warnings?.join("\n") || t("errGeneric");
    setStatus(message, "err");
    appendLog(message, true);
    return;
  }

  setStatus(`Done. ${summary}`.trim(), "ok");
}

// ---------------------------------------------------------------------------
// Static text
// ---------------------------------------------------------------------------

function applyI18n(): void {
  const text: Array<[string, string]> = [
    ["heading", "panelTitle"],
    ["lblCustomRequest", "labelCustomRequest"],
    ["hintCustomRequest", "hintCustomRequest"],
    ["btnFill", "btnFill"],
    ["lblProgress", "labelProgress"],
    ["btnClearLog", "btnClearLog"],
    ["lblConnection", "labelConnection"],
    ["lblProvider", "labelProvider"],
    ["lblApiKey", "labelApiKey"],
    ["btnTestKey", "btnTestKey"],
    ["btnSaveKey", "btnSaveKey"],
    ["btnClearKey", "btnClearKey"],
    ["btnToggleKey", "btnShowKey"],
    ["lblRemember", "labelRememberKey"],
    ["lblEncryptKeys", "labelEncryptKeys"],
    ["btnUnlock", "btnUnlock"],
    ["btnLock", "btnLock"],
    ["lblModel", "labelModel"],
    ["lblBehavior", "labelBehavior"],
    ["lblFillMode", "labelFillMode"],
    ["optHybrid", "modeHybrid"],
    ["optAi", "modeAiOnly"],
    ["optHeur", "modeHeuristicsOnly"],
    ["lblLanguage", "labelLanguage"],
    ["optLangAuto", "langAuto"],
    ["optLangOverride", "langOverride"],
    ["hintLanguage", "hintLanguage"],
    ["lblAutoNext", "labelAutoNextEnabled"],
    ["lblAutoNextMaxSteps", "labelAutoNextMaxSteps"],
    ["lblMaxRounds", "labelMaxRounds"],
    ["lblSettle", "labelSettleMs"],
    ["lblFillEmpty", "labelFillEmptyOnly"],
    ["fillEmptyOnlyWarn", "warnFillEmptyOnly"],
    ["lblExcludeSensitive", "labelExcludeSensitive"],
    ["hintExcludeSensitive", "hintExcludeSensitive"],
    ["hintSettingsAutosave", "hintSettingsAutosave"],
    ["keyHint", "keyHint"],
  ];

  for (const [nodeId, messageId] of text) el(nodeId).textContent = t(messageId);

  textarea("customRequest").placeholder = t("placeholderCustomRequest");
  input("passphraseConfirm").placeholder = t("passphraseConfirmPlaceholder");
  el<HTMLOListElement>("log").dataset.empty = t("logEmpty");
  input("autoNextMaxSteps").max = String(MAX_FORM_STEPS);
}

// ---------------------------------------------------------------------------
// Provider / model rendering
// ---------------------------------------------------------------------------

let modelOptions: ModelOption[] = [];
let keyPresence: Partial<Record<LlmProviderId, boolean>> = {};
let encryptedKeys: Partial<Record<LlmProviderId, boolean>> = {};
let vaultUnlocked = false;
let modelRequestId = 0;

function currentProvider(): LlmProviderId {
  return (select("provider").value || DEFAULT_SETTINGS.provider) as LlmProviderId;
}

function renderProviderSelect(selected: LlmProviderId): void {
  const node = select("provider");
  node.replaceChildren();
  for (const id of PROVIDER_IDS) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = PROVIDERS[id].label;
    node.append(option);
  }
  node.value = selected;
}

function renderModelSelect(preferred: string): void {
  const node = select("model");
  node.replaceChildren();

  for (const model of modelOptions) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    node.append(option);
  }

  const pick =
    modelOptions.find((model) => model.id === preferred)?.id ?? modelOptions[0]?.id ?? preferred;

  if (pick && !modelOptions.some((model) => model.id === pick)) {
    const option = document.createElement("option");
    option.value = pick;
    option.textContent = `${pick} (custom)`;
    node.append(option);
  }
  node.value = pick;
}

async function loadModels(provider: LlmProviderId, preferredModel: string): Promise<void> {
  const requestId = ++modelRequestId;
  const node = select("model");
  node.disabled = true;
  el("modelHint").textContent = "Loading models…";

  const hasKey = keyPresence[provider] === true;

  // Do not show the curated fallback catalog before a key exists — that list
  // looks like live models and is easy to save as a permanent selection.
  if (!hasKey) {
    if (requestId !== modelRequestId || provider !== currentProvider()) return;
    modelOptions = [];
    renderModelSelect(preferredModel);
    node.disabled = true;
    el("modelHint").textContent = "Save an API key to load available models.";
    return;
  }

  let response: { models: ModelOption[]; fromFallback: boolean } | undefined;
  try {
    response = await sendMessage({
      type: "GET_PROVIDER_MODELS",
      provider,
    });
  } catch {
    response = undefined;
  }

  // Ignore a slow response for a provider the user has already switched away from.
  if (requestId !== modelRequestId || provider !== currentProvider()) return;

  modelOptions =
    response?.models && response.models.length > 0
      ? response.models
      : PROVIDERS[provider].fallbackModels;

  node.disabled = false;
  renderModelSelect(preferredModel);
  el("modelHint").textContent =
    !response || response.fromFallback
      ? "Showing the built-in list (live catalog unavailable)."
      : `${modelOptions.length} model(s) available.`;
}

function updateKeyUi(provider: LlmProviderId): void {
  el("lblApiKey").textContent = PROVIDERS[provider].keyLabel;

  const hasKey = keyPresence[provider] === true;
  input("apiKey").placeholder = hasKey ? "•••••••• saved" : "";

  const status = el("keyStatus");
  status.className = "subhint";
  updateKeyControls();

  if (!hasKey) {
    status.textContent = `No key saved. Get one at ${PROVIDERS[provider].docsUrl}`;
    return;
  }

  if (encryptedKeys[provider] && !vaultUnlocked) {
    status.textContent = "Key saved and encrypted. Unlock the vault to use it.";
    status.classList.add("key-err");
    return;
  }

  status.textContent = "Key saved. Enter a new one above to replace it.";
  status.classList.add("key-ok");
}

function hasEncryptedKeys(): boolean {
  return Object.values(encryptedKeys).some(Boolean);
}

function updateKeyControls(): void {
  const provider = currentProvider();
  const hasKey = keyPresence[provider] === true;
  const hasTypedKey = input("apiKey").value.trim().length > 0;
  const currentKeyLocked = encryptedKeys[provider] === true && !vaultUnlocked;
  const encryptionNeedsUnlock = input("encryptKeys").checked && !vaultUnlocked;

  el<HTMLButtonElement>("btnSaveKey").disabled = !hasTypedKey || encryptionNeedsUnlock;
  el<HTMLButtonElement>("btnSaveKey").textContent = hasKey ? t("btnReplaceKey") : t("btnSaveKey");
  el<HTMLButtonElement>("btnTestKey").disabled =
    !hasTypedKey && (!hasKey || currentKeyLocked);
  el<HTMLButtonElement>("btnClearKey").disabled = !hasKey;
  el<HTMLButtonElement>("btnToggleKey").disabled = !hasTypedKey;
}

function updateVaultUi(): void {
  const enabled = input("encryptKeys").checked;
  const encryptedExists = hasEncryptedKeys();
  const showVault = enabled || encryptedExists || vaultUnlocked;
  el("vaultRow").classList.toggle("hidden", !showVault);
  input("passphrase").classList.toggle("hidden", vaultUnlocked);
  // Confirm is only needed when creating/unlocking with a new passphrase entry.
  input("passphraseConfirm").classList.toggle("hidden", vaultUnlocked);
  el("btnUnlock").classList.toggle("hidden", vaultUnlocked);
  el("btnLock").classList.toggle("hidden", !vaultUnlocked);

  const status = el("vaultStatus");
  if (!enabled && !encryptedExists) {
    status.textContent = "";
    status.className = "subhint";
    updateKeyControls();
    return;
  }

  if (vaultUnlocked) {
    status.textContent = enabled
      ? "Vault unlocked. New and existing keys will be encrypted."
      : "Vault unlocked. Turn encryption off to decrypt stored keys.";
  } else if (enabled && !encryptedExists) {
    status.textContent =
      "Enter a passphrase (min 8 characters), confirm it, then unlock before saving encrypted keys.";
  } else if (!enabled && encryptedExists) {
    status.textContent = "Unlock the vault before turning encryption off.";
  } else {
    status.textContent = "Vault locked. Unlock it to use or change encrypted keys.";
  }
  status.className = vaultUnlocked ? "subhint key-ok" : "subhint key-err";
  updateKeyControls();
}

function updateFillEmptyWarning(): void {
  el("fillEmptyOnlyWarn").classList.toggle("hidden", input("fillEmptyOnly").checked);
}

function updateLanguageUi(): void {
  const override = select("fillLanguage").value === "override";
  input("fillLocaleOverride").classList.toggle("hidden", !override);
}

function updateProviderBadge(): void {
  const provider = currentProvider();
  el("providerBadge").textContent = `${PROVIDERS[provider].label} · ${select("model").value || "no model"}`;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

interface SettingsResponse {
  settings: ExtensionSettings;
  hasKeys?: Partial<Record<LlmProviderId, boolean>>;
  encryptedKeys?: Partial<Record<LlmProviderId, boolean>>;
  vaultUnlocked?: boolean;
}

let settingsHydrating = false;
let persistTimer = 0;
let persistGeneration = 0;

async function load(resetStatus = true): Promise<void> {
  settingsHydrating = true;
  try {
    await hydrateSettings(resetStatus);
  } finally {
    settingsHydrating = false;
  }
}

async function hydrateSettings(resetStatus: boolean): Promise<void> {
  const response = await sendMessage<SettingsResponse>({ type: "GET_SETTINGS" });
  const settings = { ...DEFAULT_SETTINGS, ...response.settings };

  keyPresence = response.hasKeys ?? {};
  encryptedKeys = response.encryptedKeys ?? {};
  vaultUnlocked = response.vaultUnlocked === true;

  renderProviderSelect(settings.provider);

  textarea("customRequest").value = settings.customRequest;
  select("fillMode").value = settings.fillMode;
  select("fillLanguage").value = settings.fillLanguage;
  input("fillLocaleOverride").value = settings.fillLocaleOverride;
  input("autoNextEnabled").checked = settings.autoNextEnabled;
  input("autoNextMaxSteps").value = String(settings.autoNextMaxSteps);
  input("maxRounds").value = String(settings.maxRounds);
  input("settleMs").value = String(settings.settleMs);
  input("fillEmptyOnly").checked = settings.fillEmptyOnly;
  input("excludeSensitive").checked = settings.excludeSensitiveFields;
  input("rememberKey").checked = settings.rememberKeyAcrossRestarts;
  input("encryptKeys").checked = settings.encryptKeys;
  input("apiKey").value = "";
  input("apiKey").type = "password";
  el("btnToggleKey").textContent = t("btnShowKey");

  await loadModels(settings.provider, settings.model);

  updateKeyUi(settings.provider);
  updateVaultUi();
  updateLanguageUi();
  updateFillEmptyWarning();
  updateProviderBadge();
  if (resetStatus) setStatus(t("statusIdle"));
}

function collectSettings(): Partial<ExtensionSettings> {
  const provider = currentProvider();

  return {
    provider,
    // UI no longer exposes these; always use the provider default and no fan-out.
    baseUrl: PROVIDERS[provider].defaultBaseUrl,
    fallbackProviders: [],
    model: select("model").value.trim() || PROVIDERS[provider].defaultModel,
    fillMode: select("fillMode").value as FillMode,
    fillLanguage: select("fillLanguage").value as FillLanguagePolicy,
    fillLocaleOverride: input("fillLocaleOverride").value.trim(),
    customRequest: textarea("customRequest").value,
    maxRounds: Number(input("maxRounds").value) || DEFAULT_SETTINGS.maxRounds,
    settleMs: Number(input("settleMs").value) || DEFAULT_SETTINGS.settleMs,
    autoNextEnabled: input("autoNextEnabled").checked,
    autoNextMaxSteps: Number(input("autoNextMaxSteps").value) || DEFAULT_SETTINGS.autoNextMaxSteps,
    fillEmptyOnly: input("fillEmptyOnly").checked,
    excludeSensitiveFields: input("excludeSensitive").checked,
    rememberKeyAcrossRestarts: input("rememberKey").checked,
    encryptKeys: input("encryptKeys").checked,
  };
}

function schedulePersist(delayMs = 0): void {
  if (settingsHydrating) return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    void flushSettings();
  }, delayMs);
}

async function flushSettings(): Promise<boolean> {
  if (settingsHydrating) return true;
  window.clearTimeout(persistTimer);
  persistTimer = 0;
  const generation = ++persistGeneration;

  try {
    const result = await sendMessage<{ ok: boolean; error?: string }>({
      type: "SAVE_SETTINGS",
      settings: collectSettings(),
    });
    if (generation !== persistGeneration) return true;
    if (result.ok) return true;

    const message = result.error ?? t("errGeneric");
    if (/vault|passphrase|encrypt/i.test(message)) {
      setVaultStatus(message, "err");
      el<HTMLDetailsElement>("connectionCard").open = true;
    } else {
      setStatus(message, "err");
    }
    return false;
  } catch (error) {
    if (generation !== persistGeneration) return true;
    setStatus(error instanceof Error ? error.message : t("errGeneric"), "err");
    return false;
  }
}

async function persistVaultPolicy(): Promise<boolean> {
  const ok = await flushSettings();
  if (!ok) return false;
  try {
    const response = await sendMessage<SettingsResponse>({ type: "GET_SETTINGS" });
    keyPresence = response.hasKeys ?? {};
    encryptedKeys = response.encryptedKeys ?? {};
    vaultUnlocked = response.vaultUnlocked === true;
    updateVaultUi();
    updateKeyUi(currentProvider());
  } catch {
    // UI already reflects the intended toggles; flags can refresh on next load.
  }
  return true;
}

async function onSaveKey(): Promise<void> {
  const provider = currentProvider();
  const key = input("apiKey").value.trim();
  if (!key) {
    setKeyStatus("Enter an API key first.", "err");
    return;
  }

  const button = el<HTMLButtonElement>("btnSaveKey");
  button.disabled = true;
  button.textContent = "Saving…";

  try {
    // Persist the encryption and retention choices first so this key is stored
    // using exactly the policy currently shown in the UI.
    const settingsResult = await sendMessage<{ ok: boolean; error?: string }>({
      type: "SAVE_SETTINGS",
      settings: collectSettings(),
    });
    if (!settingsResult.ok) {
      const message = settingsResult.error ?? t("errGeneric");
      if (/vault|passphrase|encrypt/i.test(message)) setVaultStatus(message, "err");
      else setKeyStatus(message, "err");
      return;
    }

    const result = await sendMessage<{ ok: boolean; error?: string }>({
      type: "SAVE_API_KEY",
      provider,
      apiKey: key,
      rememberAcrossRestarts: input("rememberKey").checked,
    });
    if (!result.ok) {
      setKeyStatus(result.error ?? "Could not save the API key.", "err");
      return;
    }

    await load(false);
    setKeyStatus(`${PROVIDERS[provider].label} key saved.`, "ok");
  } catch (error) {
    setKeyStatus(error instanceof Error ? error.message : "Could not save the API key.", "err");
  } finally {
    button.disabled = false;
    updateKeyControls();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface FillResponse {
  ok?: boolean;
  error?: string;
  warnings?: string[];
  stepsCompleted?: number;
  fieldsFilled?: number;
}

async function onFill(): Promise<void> {
  const button = el<HTMLButtonElement>("btnFill");

  // Flush a pending autosave so the worker sees the latest custom request.
  try {
    await flushSettings();
  } catch {
    // Non-fatal: fall through and run with whatever is stored.
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus(t("statusNoTab"), "err");
    return;
  }

  if (tab.url && /^(chrome|chrome-extension|edge|about|devtools):/i.test(tab.url)) {
    const message =
      "This page cannot be filled (browser internal pages and the Web Store are off limits).";
    setStatus(message, "err");
    appendLog(message, true);
    return;
  }

  button.disabled = true;
  setStatus("Filling…");
  appendLog(`Starting on ${tab.title?.slice(0, 60) || tab.url || "this page"}`);

  try {
    await ensureContentScript(tab.id);
    const response = (await chrome.tabs.sendMessage(tab.id, { type: "RUN_FILL" })) as
      | FillResponse
      | undefined;
    applyFillOutcome(response);
  } catch (error) {
    if (isNavigationDisconnect(error)) {
      appendLog("Page navigated during the run; waiting for it to continue on the next step…");
      try {
        // Give the next document a moment to load, then re-attach and ask it to
        // resume from the checkpoint. Auto-resume at document_idle can race the
        // framework's hydration and miss the new step's fields.
        await new Promise((resolve) => setTimeout(resolve, 600));
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = active?.id ?? tab.id;
        await ensureContentScript(tabId);
        try {
          const resume = (await chrome.tabs.sendMessage(tabId, { type: "RESUME_IF_PENDING" })) as
            | { started?: boolean; nextStep?: number; reason?: string }
            | undefined;
          if (resume?.started) {
            appendLog(`Asked the new page to resume at step ${resume.nextStep ?? "?"}.`);
          } else if (resume?.reason === "no-checkpoint") {
            appendLog("No saved checkpoint on the new page; the run may have ended during navigation.");
          }
        } catch {
          // Listener will still catch RUN_COMPLETE if auto-resume already started.
        }

        const response = await waitForRunComplete();
        applyFillOutcome(response);
        return;
      } catch (waitError) {
        const detail = waitError instanceof Error ? waitError.message : String(waitError);
        const message = `The fill did not finish after navigation (${detail}).`;
        setStatus(message, "err");
        appendLog(message, true);
        return;
      }
    }

    const detail = error instanceof Error ? error.message : String(error);
    const message = `Could not reach this page (${detail}). Reload the extension at chrome://extensions, then reload the tab.`;
    setStatus(message, "err");
    appendLog(message, true);
  } finally {
    button.disabled = false;
  }
}

/**
 * Content scripts do not always survive an extension reload. Ping first; if the
 * page has no listener, inject the declared content-script files and try again.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch {
    // Not injected yet, or the old script was invalidated by a reload.
  }

  const files =
    chrome.runtime
      .getManifest()
      .content_scripts?.flatMap((entry) => entry.js ?? [])
      .filter((file): file is string => typeof file === "string" && file.length > 0) ?? [];

  if (files.length === 0) {
    throw new Error("No content script is declared in the extension manifest.");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files,
  });

  // Give the listener a tick to register before RUN_FILL is sent.
  await new Promise((resolve) => setTimeout(resolve, 50));

  await chrome.tabs.sendMessage(tabId, { type: "PING" });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

applyI18n();
void load();

el("btnSaveKey").addEventListener("click", () => void onSaveKey());
el("btnFill").addEventListener("click", () => void onFill());
el("btnClearLog").addEventListener("click", () => el("log").replaceChildren());

el("btnClearKey").addEventListener("click", () => {
  void (async () => {
    const provider = currentProvider();
    if (!keyPresence[provider]) return;
    if (!window.confirm(`Remove the saved ${PROVIDERS[provider].label} API key?`)) return;

    const button = el<HTMLButtonElement>("btnClearKey");
    button.disabled = true;
    try {
      const result = await sendMessage<{ ok: boolean; error?: string }>({
        type: "CLEAR_API_KEY",
        provider,
      });
      if (!result.ok) {
        setKeyStatus(result.error ?? "Could not remove the API key.", "err");
        return;
      }
      keyPresence[provider] = false;
      encryptedKeys[provider] = false;
      input("apiKey").value = "";
      updateKeyUi(provider);
      updateVaultUi();
      await loadModels(provider, PROVIDERS[provider].defaultModel);
      setKeyStatus(`${PROVIDERS[provider].label} key removed.`, "ok");
    } catch (error) {
      setKeyStatus(error instanceof Error ? error.message : "Could not remove the API key.", "err");
    } finally {
      updateKeyControls();
    }
  })();
});

select("provider").addEventListener("change", () => {
  void (async () => {
    const provider = currentProvider();
    // Never carry secret text across providers: it could otherwise be saved
    // under the wrong account after a provider switch.
    input("apiKey").value = "";
    input("apiKey").type = "password";
    el("btnToggleKey").textContent = t("btnShowKey");
    updateKeyUi(provider);
    updateProviderBadge();
    await loadModels(provider, PROVIDERS[provider].defaultModel);
    updateProviderBadge();
    schedulePersist();
  })();
});

select("model").addEventListener("change", () => {
  updateProviderBadge();
  schedulePersist();
});
select("fillMode").addEventListener("change", () => schedulePersist());
select("fillLanguage").addEventListener("change", () => {
  updateLanguageUi();
  schedulePersist();
});
input("encryptKeys").addEventListener("change", () => {
  updateVaultUi();
  // Enabling/disabling encryption needs an unlocked vault. Keep the checkbox
  // as intent and persist after Unlock when the vault is still locked.
  if (vaultUnlocked) void persistVaultPolicy();
});
input("rememberKey").addEventListener("change", () => {
  if (vaultUnlocked || !hasEncryptedKeys()) void persistVaultPolicy();
});
input("fillEmptyOnly").addEventListener("change", () => {
  updateFillEmptyWarning();
  schedulePersist();
});
input("autoNextEnabled").addEventListener("change", () => schedulePersist());
input("excludeSensitive").addEventListener("change", () => schedulePersist());

const DEBOUNCED_SETTING_IDS = [
  "customRequest",
  "fillLocaleOverride",
  "autoNextMaxSteps",
  "maxRounds",
  "settleMs",
] as const;

for (const id of DEBOUNCED_SETTING_IDS) {
  const node = el(id);
  node.addEventListener("input", () => schedulePersist(400));
  node.addEventListener("change", () => schedulePersist());
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushSettings();
});
window.addEventListener("pagehide", () => void flushSettings());
input("apiKey").addEventListener("input", () => {
  updateKeyControls();
  if (!input("apiKey").value.trim()) {
    updateKeyUi(currentProvider());
    return;
  }
  el("keyStatus").textContent = keyPresence[currentProvider()]
    ? "New key entered. Save it to replace the stored key."
    : "Key entered but not saved.";
  el("keyStatus").className = "subhint";
});

el("btnToggleKey").addEventListener("click", () => {
  const field = input("apiKey");
  const showing = field.type === "text";
  field.type = showing ? "password" : "text";
  const label = showing ? t("btnShowKey") : t("btnHideKey");
  el("btnToggleKey").textContent = label;
  el("btnToggleKey").setAttribute("aria-label", `${label} API key`);
  el("btnToggleKey").setAttribute("title", `${label} API key`);
});

el("btnTestKey").addEventListener("click", () => {
  void (async () => {
    const status = el("keyStatus");
    const button = el<HTMLButtonElement>("btnTestKey");
    status.className = "subhint";
    status.textContent = "Testing…";
    button.disabled = true;
    const testingTypedKey = input("apiKey").value.trim().length > 0;

    try {
      // The typed key is sent so testing works before saving.
      const result = await sendMessage<{ ok: boolean; error?: string }>({
        type: "TEST_API_KEY",
        provider: currentProvider(),
        apiKey: input("apiKey").value.trim() || undefined,
        model: select("model").value.trim() || undefined,
      });

      status.textContent = result.ok
        ? testingTypedKey
          ? "Key is valid. Save it when ready."
          : "Saved key is valid."
        : (result.error ?? "The key was rejected.");
      status.classList.add(result.ok ? "key-ok" : "key-err");
    } catch {
      status.textContent = "The test request could not be sent.";
      status.classList.add("key-err");
    } finally {
      updateKeyControls();
    }
  })();
});

el("btnUnlock").addEventListener("click", () => {
  void (async () => {
    const passphrase = input("passphrase").value;
    const confirm = input("passphraseConfirm").value;
    const desiredEncryption = input("encryptKeys").checked;
    if (!passphrase) {
      setVaultStatus("Enter a passphrase first.", "err");
      return;
    }
    if (passphrase.trim().length < 8) {
      setVaultStatus("Passphrase must be at least 8 characters.", "err");
      return;
    }
    if (passphrase !== confirm) {
      setVaultStatus("Passphrase and confirmation do not match.", "err");
      return;
    }
    const result = await sendMessage<{ ok: boolean; error?: string }>({
      type: "UNLOCK_VAULT",
      passphrase,
    });
    input("passphrase").value = "";
    input("passphraseConfirm").value = "";
    if (!result.ok) {
      setVaultStatus(result.error ?? "Could not unlock the vault.", "err");
      return;
    }
    vaultUnlocked = true;
    // Unlocking is often part of enabling/disabling encryption. Keep all
    // unsaved choices instead of reloading stored settings over the UI.
    input("encryptKeys").checked = desiredEncryption;
    updateVaultUi();
    updateKeyUi(currentProvider());
    await loadModels(currentProvider(), select("model").value);
    const saved = await persistVaultPolicy();
    if (saved) setVaultStatus("Vault unlocked for this browser session.", "ok");
  })();
});

el("btnLock").addEventListener("click", () => {
  void (async () => {
    try {
      await sendMessage({ type: "LOCK_VAULT" });
      vaultUnlocked = false;
      updateVaultUi();
      updateKeyUi(currentProvider());
      setVaultStatus("Vault locked.", "ok");
    } catch (error) {
      setVaultStatus(error instanceof Error ? error.message : "Could not lock the vault.", "err");
    }
  })();
});

input("passphrase").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  el<HTMLButtonElement>("btnUnlock").click();
});
