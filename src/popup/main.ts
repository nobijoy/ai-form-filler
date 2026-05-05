import type { ExtensionSettings, FillMode, OpenRouterModelOption } from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/types";
import { buildPersonaJsonFromUi, splitPersonaJsonForUi } from "../shared/personaSettings";

function t(id: string): string {
  return chrome.i18n.getMessage(id) || id;
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
}

interface GetOpenRouterModelsResponse {
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

function applyI18n(): void {
  byId("heading").textContent = t("popupTitle");
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
  byId("lblFillEmpty").textContent = t("labelFillEmptyOnly");
  byId("btnSave").textContent = t("btnSave");
  byId("btnClearKey").textContent = t("btnClearKey");
  byId("btnFill").textContent = t("btnFill");
  byId("keyHint").textContent = t("keyHint");
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

async function loadModelOptions(selectedModelId: string): Promise<void> {
  byId("modelHint").textContent = t("modelHintLoading");
  const select = byId("model") as HTMLSelectElement;
  select.disabled = true;

  let res: GetOpenRouterModelsResponse | undefined;
  try {
    res = await sendMessage<GetOpenRouterModelsResponse>({
      type: "GET_OPENROUTER_MODELS",
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
  const { settings, hasApiKey } = await sendMessage<GetSettingsResponse>({
    type: "GET_SETTINGS",
  });
  const s = { ...DEFAULT_SETTINGS, ...settings };
  (byId("baseUrl") as HTMLInputElement).value = s.baseUrl;
  await loadModelOptions(s.model);
  (byId("fillMode") as HTMLSelectElement).value = s.fillMode;
  const personaUi = splitPersonaJsonForUi(s.personaJson);
  (byId("personaEmail") as HTMLInputElement).value = personaUi.email;
  (byId("personaFirstName") as HTMLInputElement).value = personaUi.firstName;
  (byId("personaLastName") as HTMLInputElement).value = personaUi.lastName;
  (byId("personaPhone") as HTMLInputElement).value = personaUi.phone;
  (byId("personaAdvanced") as HTMLTextAreaElement).value = personaUi.advancedJson;
  (byId("maxRounds") as HTMLInputElement).value = String(s.maxRounds);
  (byId("settleMs") as HTMLInputElement).value = String(s.settleMs);
  (byId("fillEmptyOnly") as HTMLInputElement).checked = s.fillEmptyOnly;
  (byId("rememberKey") as HTMLInputElement).checked = s.rememberKeyAcrossRestarts;
  (byId("apiKey") as HTMLInputElement).value = "";
  (byId("apiKey") as HTMLInputElement).placeholder = hasApiKey ? "•••••••• (saved)" : "";
  setStatus(t("statusIdle"));
}

async function saveSettingsOnly(): Promise<void> {
  const settings: Partial<ExtensionSettings> = {
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
    fillEmptyOnly: (byId("fillEmptyOnly") as HTMLInputElement).checked,
    rememberKeyAcrossRestarts: (byId("rememberKey") as HTMLInputElement).checked,
  };
  await sendMessage({ type: "SAVE_SETTINGS", settings });
}

async function saveKeyIfProvided(): Promise<void> {
  const key = (byId("apiKey") as HTMLInputElement).value;
  const remember = (byId("rememberKey") as HTMLInputElement).checked;
  if (key.length > 0) {
    await sendMessage({
      type: "SAVE_API_KEY",
      apiKey: key,
      rememberAcrossRestarts: remember,
    });
  }
}

async function onSave(): Promise<void> {
  try {
    await saveSettingsOnly();
    await saveKeyIfProvided();
    setStatus("Saved.");
    (byId("apiKey") as HTMLInputElement).value = "";
    await load();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : t("errGeneric"), true);
  }
}

async function onClearKey(): Promise<void> {
  try {
    await sendMessage({ type: "CLEAR_API_KEY" });
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
      setStatus(res.error || t("errGeneric"), true);
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
