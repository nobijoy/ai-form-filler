import type { ExtensionSettings, FillMode, OpenRouterModelOption } from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/types";
import { buildPersonaJsonFromUi, splitPersonaJsonForUi } from "../shared/personaSettings";
import { PROVIDERS } from "../shared/providers";
import type { LlmProviderId } from "../shared/types";

const I18N_FALLBACKS: Record<string, string> = {
  popupTitle: "AI Form Filler",
  labelApiKey: "API key",
  labelProvider: "Provider",
  labelRememberKey: "Remember key across browser restarts",
  labelBaseUrl: "API base URL",
  labelModel: "Model",
  modelHintLoading: "Loading free OpenRouter models...",
  modelHintLoaded: "Pick a model from the list.",
  modelHintFallback: "Using fallback model list.",
  labelFillMode: "Fill mode",
  modeHybrid: "Hybrid (heuristics + AI)",
  modeAiOnly: "AI only",
  modeHeuristicsOnly: "Heuristics only",
  hintPersona: "Optional test identity for consistent fake data.",
  labelPersonaEmail: "Email",
  labelPersonaFirstName: "First name",
  labelPersonaLastName: "Last name",
  labelPersonaPhone: "Phone",
  labelPersonaAdvanced: "More fields (JSON)",
  hintPersonaAdvanced: "Optional extra persona keys.",
  labelMaxRounds: "Max rounds",
  labelSettleMs: "Settle delay (ms)",
  labelAutoNextEnabled: "Auto-next pages when current step is complete",
  labelAutoNextMaxSteps: "Max auto-next pages",
  labelFillEmptyOnly: "Fill empty fields only",
  btnSave: "Save settings",
  btnClearKey: "Clear API key",
  btnFill: "Fill this tab",
  keyHint: "Keys stay in extension storage.",
  statusIdle: "Ready.",
  statusNoTab: "No active tab.",
  statusSent: "Fill command sent.",
  errGeneric: "Something went wrong.",
};

function t(id: string): string {
  const msg = chrome.i18n.getMessage(id);
  if (msg && msg.trim().length > 0) return msg;
  return I18N_FALLBACKS[id] || id;
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

interface GetSettingsResponse {
  settings: ExtensionSettings;
  hasApiKey: boolean;
  hasKeys?: Partial<Record<LlmProviderId, boolean>>;
  keyPrefixes?: Partial<Record<LlmProviderId, string>>;
}

interface GetProviderModelsResponse {
  models: OpenRouterModelOption[];
  fromFallback: boolean;
}

let modelOptions: OpenRouterModelOption[] = [];

function byId(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error(`Missing #${id}`);
  return n;
}

function setStatus(text: string, err = false): void {
  const s = byId("status");
  s.textContent = text;
  s.classList.toggle("err", err);
}

function showErrorModal(message: string): void {
  const modal = byId("errorModal") as HTMLDialogElement;
  const body = byId("errorModalBody");
  body.textContent = message || t("errGeneric");
  if (typeof modal.showModal === "function" && !modal.open) {
    modal.showModal();
    return;
  }
  // Fallback for environments where dialog API is unavailable.
  alert(message || t("errGeneric"));
}

function applyI18n(): void {
  byId("heading").textContent = t("popupTitle");
  byId("lblProvider").textContent = t("labelProvider");
  byId("lblApiKey").textContent = t("labelApiKey");
  byId("lblRemember").textContent = t("labelRememberKey");
  byId("lblBaseUrl").textContent = t("labelBaseUrl");
  byId("lblModel").textContent = t("labelModel");
  byId("modelHint").textContent = t("modelHintLoading");
  byId("lblFillMode").textContent = t("labelFillMode");
  byId("optHybrid").textContent = t("modeHybrid");
  byId("optAi").textContent = t("modeAiOnly");
  byId("optHeur").textContent = t("modeHeuristicsOnly");
  byId("personaHint").textContent = t("hintPersona");
  byId("lblPersonaEmail").textContent = t("labelPersonaEmail");
  byId("lblPersonaFirstName").textContent = t("labelPersonaFirstName");
  byId("lblPersonaLastName").textContent = t("labelPersonaLastName");
  byId("lblPersonaPhone").textContent = t("labelPersonaPhone");
  byId("lblPersonaAdvanced").textContent = t("labelPersonaAdvanced");
  byId("personaAdvancedHint").textContent = t("hintPersonaAdvanced");
  (byId("personaAdvanced") as HTMLTextAreaElement).placeholder = t("placeholderPersonaAdvanced");
  byId("lblMaxRounds").textContent = t("labelMaxRounds");
  byId("lblSettle").textContent = t("labelSettleMs");
  byId("lblAutoNext").textContent = t("labelAutoNextEnabled");
  byId("lblAutoNextMaxSteps").textContent = t("labelAutoNextMaxSteps");
  byId("lblFillEmpty").textContent = t("labelFillEmptyOnly");
  byId("btnSave").textContent = t("btnSave");
  byId("btnClearKey").textContent = t("btnClearKey");
  byId("btnFill").textContent = t("btnFill");
  byId("keyHint").textContent = t("keyHint");
}

function selectedProvider(): LlmProviderId {
  return ((byId("provider") as HTMLSelectElement).value || DEFAULT_SETTINGS.provider) as LlmProviderId;
}

function renderProviderSelect(preferred: LlmProviderId): void {
  const select = byId("provider") as HTMLSelectElement;
  select.replaceChildren();
  (Object.keys(PROVIDERS) as LlmProviderId[]).forEach((provider) => {
    const opt = document.createElement("option");
    opt.value = provider;
    opt.textContent = PROVIDERS[provider].label;
    select.appendChild(opt);
  });
  select.value = preferred;
}

function renderModelSelect(preferredId: string): void {
  const select = byId("model") as HTMLSelectElement;
  select.replaceChildren();

  for (const model of modelOptions) {
    const opt = document.createElement("option");
    opt.value = model.id;
    opt.textContent = model.label;
    select.appendChild(opt);
  }

  const pick =
    modelOptions.find((m) => m.id === preferredId)?.id ??
    modelOptions.find((m) => m.id === DEFAULT_SETTINGS.model)?.id ??
    modelOptions[0]?.id;
  if (pick) select.value = pick;
}

function updateProviderUi(provider: LlmProviderId, hasKey: boolean, keyPrefix?: string): void {
  byId("lblApiKey").textContent = PROVIDERS[provider].keyLabel;
  (byId("baseUrl") as HTMLInputElement).placeholder = PROVIDERS[provider].defaultBaseUrl;
  (byId("apiKey") as HTMLInputElement).placeholder = hasKey ? "•••••••• (saved)" : "";
  const statusEl = byId("keyStatus");
  statusEl.className = "subhint";
  if (hasKey) {
    const hint = keyPrefix ? ` (starts with: ${keyPrefix}••••)` : "";
    statusEl.textContent = `Key saved${hint} — enter a new one above to replace.`;
  } else {
    statusEl.textContent = `No key saved. Get one: ${PROVIDERS[provider].docsUrl}`;
  }
}

async function loadModelOptions(provider: LlmProviderId, selectedModelId: string): Promise<void> {
  byId("modelHint").textContent = t("modelHintLoading");
  const select = byId("model") as HTMLSelectElement;
  select.disabled = true;

  let res: GetProviderModelsResponse | undefined;
  try {
    res = await sendMessage<GetProviderModelsResponse>({
      type: "GET_PROVIDER_MODELS",
      provider,
    });
  } catch {
    res = undefined;
  }

  const list = res?.models;
  modelOptions = Array.isArray(list) && list.length > 0 ? list : [];

  if (modelOptions.length === 0) {
    modelOptions = [
      {
        id: DEFAULT_SETTINGS.model,
        name: "Auto-Router (Free)",
        contextLength: 0,
        label: "Auto-Router (Free)",
      },
    ];
  }

  select.disabled = false;
  renderModelSelect(selectedModelId);
  const useFallbackHint =
    res == null || res.fromFallback || !Array.isArray(res.models) || res.models.length === 0;
  byId("modelHint").textContent = useFallbackHint ? t("modelHintFallback") : t("modelHintLoaded");
}

async function load(): Promise<void> {
  const { settings, hasApiKey, hasKeys, keyPrefixes } = await sendMessage<GetSettingsResponse>({
    type: "GET_SETTINGS",
  });
  const s = { ...DEFAULT_SETTINGS, ...settings };
  renderProviderSelect(s.provider);
  updateProviderUi(
    s.provider,
    Boolean(hasKeys?.[s.provider] ?? hasApiKey),
    keyPrefixes?.[s.provider],
  );
  (byId("baseUrl") as HTMLInputElement).value = s.baseUrl;
  await loadModelOptions(s.provider, s.model);
  (byId("fillMode") as HTMLSelectElement).value = s.fillMode;
  const personaUi = splitPersonaJsonForUi(s.personaJson);
  (byId("personaEmail") as HTMLInputElement).value = personaUi.email;
  (byId("personaFirstName") as HTMLInputElement).value = personaUi.firstName;
  (byId("personaLastName") as HTMLInputElement).value = personaUi.lastName;
  (byId("personaPhone") as HTMLInputElement).value = personaUi.phone;
  (byId("personaAdvanced") as HTMLTextAreaElement).value = personaUi.advancedJson;
  (byId("maxRounds") as HTMLInputElement).value = String(s.maxRounds);
  (byId("settleMs") as HTMLInputElement).value = String(s.settleMs);
  (byId("autoNextEnabled") as HTMLInputElement).checked = !!s.autoNextEnabled;
  (byId("autoNextMaxSteps") as HTMLInputElement).value = String(s.autoNextMaxSteps ?? 3);
  (byId("fillEmptyOnly") as HTMLInputElement).checked = s.fillEmptyOnly;
  (byId("rememberKey") as HTMLInputElement).checked = s.rememberKeyAcrossRestarts;
  (byId("apiKey") as HTMLInputElement).value = "";
  setStatus(t("statusIdle"));
}

async function saveSettingsOnly(): Promise<void> {
  const settings: Partial<ExtensionSettings> = {
    provider: selectedProvider(),
    baseUrl:
      (byId("baseUrl") as HTMLInputElement).value.trim() || DEFAULT_SETTINGS.baseUrl,
    model: (byId("model") as HTMLSelectElement).value.trim() || DEFAULT_SETTINGS.model,
    fillMode: (byId("fillMode") as HTMLSelectElement).value as FillMode,
    fillLanguage: "auto",
    fillLocaleOverride: "",
    personaJson: buildPersonaJsonFromUi(
      {
        email: (byId("personaEmail") as HTMLInputElement).value,
        firstName: (byId("personaFirstName") as HTMLInputElement).value,
        lastName: (byId("personaLastName") as HTMLInputElement).value,
        phone: (byId("personaPhone") as HTMLInputElement).value,
      },
      (byId("personaAdvanced") as HTMLTextAreaElement).value,
    ),
    maxRounds: Math.min(
      20,
      Math.max(
        1,
        Number((byId("maxRounds") as HTMLInputElement).value) || DEFAULT_SETTINGS.maxRounds,
      ),
    ),
    settleMs: Math.min(
      2000,
      Math.max(
        0,
        Number((byId("settleMs") as HTMLInputElement).value) || DEFAULT_SETTINGS.settleMs,
      ),
    ),
    autoNextEnabled: (byId("autoNextEnabled") as HTMLInputElement).checked,
    autoNextMaxSteps: Math.min(
      10,
      Math.max(
        1,
        Number((byId("autoNextMaxSteps") as HTMLInputElement).value) ||
          DEFAULT_SETTINGS.autoNextMaxSteps,
      ),
    ),
    fillEmptyOnly: (byId("fillEmptyOnly") as HTMLInputElement).checked,
    rememberKeyAcrossRestarts: (byId("rememberKey") as HTMLInputElement).checked,
  };
  await sendMessage({ type: "SAVE_SETTINGS", settings });
}

async function saveKeyIfProvided(): Promise<void> {
  const key = (byId("apiKey") as HTMLInputElement).value;
  const remember = (byId("rememberKey") as HTMLInputElement).checked;
  const provider = selectedProvider();
  if (key.length > 0) {
    await sendMessage({
      type: "SAVE_API_KEY",
      provider,
      apiKey: key,
      rememberAcrossRestarts: remember,
    });
  }
}

async function onSave(): Promise<void> {
  try {
    await saveSettingsOnly();
    await saveKeyIfProvided();
    setStatus("Settings saved.");
    (byId("apiKey") as HTMLInputElement).value = "";
    await load();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : t("errGeneric"), true);
  }
}

async function onClearKey(): Promise<void> {
  try {
    await sendMessage({ type: "CLEAR_API_KEY", provider: selectedProvider() });
    setStatus("API key cleared.");
    await load();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : t("errGeneric"), true);
  }
}

async function onFill(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus(t("statusNoTab"), true);
      return;
    }
    const r = await chrome.tabs.sendMessage(tab.id, { type: "RUN_FILL" });
    const res = r as { ok?: boolean; error?: string } | undefined;
    if (res && res.ok === false) {
      const msg = res.error || t("errGeneric");
      setStatus(msg, true);
      showErrorModal(msg);
      return;
    }
    setStatus(t("statusSent"));
  } catch {
    setStatus(
      "Could not reach this page. Try a normal https page (not chrome:// or the Web Store).",
      true,
    );
  }
}

applyI18n();
void load();

byId("btnSave").addEventListener("click", () => void onSave());
byId("btnClearKey").addEventListener("click", () => void onClearKey());
byId("btnFill").addEventListener("click", () => void onFill());
byId("provider").addEventListener("change", async () => {
  const provider = selectedProvider();
  let hasKey = false;
  let keyPrefix: string | undefined;
  try {
    const resp = await sendMessage<GetSettingsResponse>({ type: "GET_SETTINGS" });
    hasKey = Boolean(resp.hasKeys?.[provider]);
    keyPrefix = resp.keyPrefixes?.[provider];
  } catch { /* ignore */ }
  updateProviderUi(provider, hasKey, keyPrefix);
  (byId("baseUrl") as HTMLInputElement).value = PROVIDERS[provider].defaultBaseUrl;
  await loadModelOptions(provider, PROVIDERS[provider].defaultModel);
});
byId("btnTestKey").addEventListener("click", async () => {
  const statusEl = byId("keyStatus");
  statusEl.textContent = "Testing…";
  statusEl.className = "subhint";
  const provider = selectedProvider();
  try {
    const result = await sendMessage<{ ok: boolean; error?: string; keyPrefix?: string }>({
      type: "TEST_API_KEY",
      provider,
    });
    const prefix = result.keyPrefix ? ` (key: ${result.keyPrefix}••••)` : "";
    if (result.ok) {
      statusEl.textContent = `✓ Key valid${prefix}`;
      statusEl.className = "subhint key-ok";
    } else {
      statusEl.textContent = `✗ ${result.error ?? "Invalid key"}${prefix}`;
      statusEl.className = "subhint key-err";
    }
  } catch {
    statusEl.textContent = "✗ Test request failed";
    statusEl.className = "subhint key-err";
  }
});
byId("btnCloseErrorModal").addEventListener("click", () => {
  const modal = byId("errorModal") as HTMLDialogElement;
  if (modal.open) modal.close();
});
