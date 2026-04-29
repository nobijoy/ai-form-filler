import type { ExtensionSettings, FillMode, FillLanguagePolicy } from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/types";

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
  byId("lblFillMode").textContent = t("labelFillMode");
  byId("optHybrid").textContent = t("modeHybrid");
  byId("optAi").textContent = t("modeAiOnly");
  byId("optHeur").textContent = t("modeHeuristicsOnly");
  byId("lblFillLang").textContent = t("labelFillLanguage");
  byId("optLangAuto").textContent = t("fillLangAuto");
  byId("optLangOverride").textContent = t("fillLangOverride");
  byId("lblLocaleOverride").textContent = t("labelLocaleOverride");
  byId("lblPersona").textContent = t("labelPersona");
  byId("lblMaxRounds").textContent = t("labelMaxRounds");
  byId("lblSettle").textContent = t("labelSettleMs");
  byId("lblFillEmpty").textContent = t("labelFillEmptyOnly");
  byId("btnSave").textContent = t("btnSave");
  byId("btnClearKey").textContent = t("btnClearKey");
  byId("btnFill").textContent = t("btnFill");
  byId("keyHint").textContent = t("keyHint");
}

async function load(): Promise<void> {
  const { settings, hasApiKey } = await sendMessage<GetSettingsResponse>({
    type: "GET_SETTINGS",
  });
  const s = { ...DEFAULT_SETTINGS, ...settings };
  (byId("baseUrl") as HTMLInputElement).value = s.baseUrl;
  (byId("model") as HTMLInputElement).value = s.model;
  (byId("fillMode") as HTMLSelectElement).value = s.fillMode;
  (byId("fillLanguage") as HTMLSelectElement).value = s.fillLanguage;
  (byId("localeOverride") as HTMLInputElement).value = s.fillLocaleOverride;
  (byId("persona") as HTMLTextAreaElement).value = s.personaJson;
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
    model: (byId("model") as HTMLInputElement).value.trim() || DEFAULT_SETTINGS.model,
    fillMode: (byId("fillMode") as HTMLSelectElement).value as FillMode,
    fillLanguage: (byId("fillLanguage") as HTMLSelectElement).value as FillLanguagePolicy,
    fillLocaleOverride: (byId("localeOverride") as HTMLInputElement).value.trim(),
    personaJson: (byId("persona") as HTMLTextAreaElement).value,
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
