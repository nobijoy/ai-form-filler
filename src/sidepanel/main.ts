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
  panelTitle: "AI Form Filler",
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
  labelRememberKey: "Remember key across browser restarts",
  labelEncryptKeys: "Encrypt stored keys with a passphrase",
  btnUnlock: "Unlock",
  labelModel: "Model",
  labelBaseUrl: "API base URL",
  labelFallback: "Fallback providers (optional)",
  hintFallback:
    "Only used if the selected provider fails. Form contents are sent to each one you pick here.",
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
  btnSave: "Save settings",
  btnClearKey: "Clear key",
  statusIdle: "Ready.",
  statusNoTab: "No active tab.",
  keyHint:
    "Keys are stored by the extension and read only by its background worker. They are never exposed to web pages.",
  errGeneric: "Something went wrong.",
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
    ["lblRemember", "labelRememberKey"],
    ["lblEncryptKeys", "labelEncryptKeys"],
    ["btnUnlock", "btnUnlock"],
    ["lblModel", "labelModel"],
    ["lblBaseUrl", "labelBaseUrl"],
    ["lblFallback", "labelFallback"],
    ["hintFallback", "hintFallback"],
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
    ["btnSave", "btnSave"],
    ["btnClearKey", "btnClearKey"],
    ["keyHint", "keyHint"],
  ];

  for (const [nodeId, messageId] of text) el(nodeId).textContent = t(messageId);

  textarea("customRequest").placeholder = t("placeholderCustomRequest");
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

function renderFallbackSelect(active: LlmProviderId, selected: LlmProviderId[]): void {
  const node = select("fallbackProviders");
  node.replaceChildren();
  for (const id of PROVIDER_IDS) {
    if (id === active) continue;
    const option = document.createElement("option");
    option.value = id;
    option.textContent = PROVIDERS[id].label;
    option.selected = selected.includes(id);
    node.append(option);
  }
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
  const node = select("model");
  node.disabled = true;
  el("modelHint").textContent = "Loading models…";

  let response: { models: ModelOption[]; fromFallback: boolean } | undefined;
  try {
    response = await sendMessage({
      type: "GET_PROVIDER_MODELS",
      provider,
      baseUrl: input("baseUrl").value.trim() || undefined,
    });
  } catch {
    response = undefined;
  }

  modelOptions =
    response?.models && response.models.length > 0
      ? response.models
      : PROVIDERS[provider].fallbackModels;

  node.disabled = false;
  renderModelSelect(preferredModel);
  el("modelHint").textContent =
    !response || response.fromFallback
      ? "Showing the built-in list. Save a valid key to load the live one."
      : `${modelOptions.length} model(s) available.`;
}

function updateKeyUi(provider: LlmProviderId): void {
  el("lblApiKey").textContent = PROVIDERS[provider].keyLabel;
  input("baseUrl").placeholder = PROVIDERS[provider].defaultBaseUrl;

  const hasKey = keyPresence[provider] === true;
  input("apiKey").placeholder = hasKey ? "•••••••• saved" : "";

  const status = el("keyStatus");
  status.className = "subhint";

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

function updateVaultUi(): void {
  const enabled = input("encryptKeys").checked;
  el("vaultRow").classList.toggle("hidden", !enabled);

  const status = el("vaultStatus");
  if (!enabled) {
    status.textContent = "";
    return;
  }
  status.textContent = vaultUnlocked
    ? "Vault unlocked for this browser session."
    : "Vault locked. Enter your passphrase to read or save keys.";
  status.className = vaultUnlocked ? "subhint key-ok" : "subhint key-err";
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

async function load(): Promise<void> {
  const response = await sendMessage<SettingsResponse>({ type: "GET_SETTINGS" });
  const settings = { ...DEFAULT_SETTINGS, ...response.settings };

  keyPresence = response.hasKeys ?? {};
  encryptedKeys = response.encryptedKeys ?? {};
  vaultUnlocked = response.vaultUnlocked === true;

  renderProviderSelect(settings.provider);
  renderFallbackSelect(settings.provider, settings.fallbackProviders);

  input("baseUrl").value = settings.baseUrl || PROVIDERS[settings.provider].defaultBaseUrl;
  textarea("customRequest").value = settings.customRequest;
  select("fillMode").value = settings.fillMode;
  select("fillLanguage").value = settings.fillLanguage;
  input("fillLocaleOverride").value = settings.fillLocaleOverride;
  input("autoNextEnabled").checked = settings.autoNextEnabled;
  input("autoNextMaxSteps").value = String(settings.autoNextMaxSteps);
  input("maxRounds").value = String(settings.maxRounds);
  input("settleMs").value = String(settings.settleMs);
  input("fillEmptyOnly").checked = settings.fillEmptyOnly;
  input("rememberKey").checked = settings.rememberKeyAcrossRestarts;
  input("encryptKeys").checked = settings.encryptKeys;
  input("apiKey").value = "";

  await loadModels(settings.provider, settings.model);

  updateKeyUi(settings.provider);
  updateVaultUi();
  updateLanguageUi();
  updateProviderBadge();
  setStatus(t("statusIdle"));
}

function collectSettings(): Partial<ExtensionSettings> {
  const provider = currentProvider();
  const fallbackProviders = Array.from(select("fallbackProviders").selectedOptions).map(
    (option) => option.value as LlmProviderId,
  );

  return {
    provider,
    baseUrl: input("baseUrl").value.trim() || PROVIDERS[provider].defaultBaseUrl,
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
    rememberKeyAcrossRestarts: input("rememberKey").checked,
    fallbackProviders,
    encryptKeys: input("encryptKeys").checked,
  };
}

async function onSave(): Promise<void> {
  try {
    const result = await sendMessage<{ ok: boolean; error?: string }>({
      type: "SAVE_SETTINGS",
      settings: collectSettings(),
    });
    if (!result.ok) {
      setStatus(result.error ?? t("errGeneric"), "err");
      return;
    }

    const key = input("apiKey").value;
    if (key.length > 0) {
      const keyResult = await sendMessage<{ ok: boolean; error?: string }>({
        type: "SAVE_API_KEY",
        provider: currentProvider(),
        apiKey: key,
        rememberAcrossRestarts: input("rememberKey").checked,
      });
      if (!keyResult.ok) {
        setStatus(keyResult.error ?? t("errGeneric"), "err");
        return;
      }
    }

    setStatus("Settings saved.", "ok");
    await load();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : t("errGeneric"), "err");
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

  // The custom request must be persisted before the run so the worker sees it.
  try {
    await sendMessage({ type: "SAVE_SETTINGS", settings: collectSettings() });
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

el("btnSave").addEventListener("click", () => void onSave());
el("btnFill").addEventListener("click", () => void onFill());
el("btnClearLog").addEventListener("click", () => el("log").replaceChildren());

el("btnClearKey").addEventListener("click", () => {
  void (async () => {
    await sendMessage({ type: "CLEAR_API_KEY", provider: currentProvider() });
    setStatus("Key cleared.", "ok");
    await load();
  })();
});

select("provider").addEventListener("change", () => {
  void (async () => {
    const provider = currentProvider();
    input("baseUrl").value = PROVIDERS[provider].defaultBaseUrl;
    renderFallbackSelect(provider, []);
    await loadModels(provider, PROVIDERS[provider].defaultModel);
    updateKeyUi(provider);
    updateProviderBadge();
  })();
});

select("model").addEventListener("change", updateProviderBadge);
select("fillLanguage").addEventListener("change", updateLanguageUi);
input("encryptKeys").addEventListener("change", updateVaultUi);

el("btnTestKey").addEventListener("click", () => {
  void (async () => {
    const status = el("keyStatus");
    const button = el<HTMLButtonElement>("btnTestKey");
    status.className = "subhint";
    status.textContent = "Testing…";
    button.disabled = true;

    try {
      // The typed key is sent so testing works before saving.
      const result = await sendMessage<{ ok: boolean; error?: string }>({
        type: "TEST_API_KEY",
        provider: currentProvider(),
        apiKey: input("apiKey").value.trim() || undefined,
        baseUrl: input("baseUrl").value.trim() || undefined,
        model: select("model").value.trim() || undefined,
      });

      status.textContent = result.ok
        ? "Key is valid. Press Save settings to store it."
        : (result.error ?? "The key was rejected.");
      status.classList.add(result.ok ? "key-ok" : "key-err");
    } catch {
      status.textContent = "The test request could not be sent.";
      status.classList.add("key-err");
    } finally {
      button.disabled = false;
    }
  })();
});

el("btnUnlock").addEventListener("click", () => {
  void (async () => {
    const passphrase = input("passphrase").value;
    if (!passphrase) {
      setStatus("Enter a passphrase first.", "err");
      return;
    }
    const result = await sendMessage<{ ok: boolean; error?: string }>({
      type: "UNLOCK_VAULT",
      passphrase,
    });
    input("passphrase").value = "";
    if (!result.ok) {
      setStatus(result.error ?? "Could not unlock the vault.", "err");
      return;
    }
    setStatus("Vault unlocked.", "ok");
    await load();
  })();
});
