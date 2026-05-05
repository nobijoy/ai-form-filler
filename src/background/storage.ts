import { DEFAULT_SETTINGS, type ExtensionSettings } from "../shared/types";

const SETTINGS_KEY = "aff_settings";
const API_KEY_LOCAL = "aff_apiKey";
const API_KEY_SESSION = "aff_apiKey";

export async function getSettings(): Promise<ExtensionSettings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = raw[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    fillLanguage: "auto",
    fillLocaleOverride: "",
  };
}

export async function saveSettings(partial: Partial<ExtensionSettings>): Promise<void> {
  const cur = await getSettings();
  const prevRemember = cur.rememberKeyAcrossRestarts;
  const next = { ...cur, ...partial };
  const rememberChanged =
    partial.rememberKeyAcrossRestarts !== undefined &&
    partial.rememberKeyAcrossRestarts !== prevRemember;
  const existingKey = rememberChanged ? await getApiKey() : undefined;
  await chrome.storage.local.set({
    [SETTINGS_KEY]: next,
  });
  if (rememberChanged && existingKey) {
    await saveApiKey(existingKey, next.rememberKeyAcrossRestarts);
  }
}

export async function getApiKey(): Promise<string | undefined> {
  const session = await chrome.storage.session.get(API_KEY_SESSION);
  if (typeof session[API_KEY_SESSION] === "string" && session[API_KEY_SESSION].length > 0) {
    return session[API_KEY_SESSION];
  }
  const local = await chrome.storage.local.get(API_KEY_LOCAL);
  if (typeof local[API_KEY_LOCAL] === "string" && local[API_KEY_LOCAL].length > 0) {
    return local[API_KEY_LOCAL];
  }
  return undefined;
}

export async function saveApiKey(key: string, rememberAcrossRestarts: boolean): Promise<void> {
  if (rememberAcrossRestarts) {
    await chrome.storage.session.remove(API_KEY_SESSION);
    await chrome.storage.local.set({ [API_KEY_LOCAL]: key });
  } else {
    await chrome.storage.local.remove(API_KEY_LOCAL);
    await chrome.storage.session.set({ [API_KEY_SESSION]: key });
  }
}

export async function clearApiKey(): Promise<void> {
  await chrome.storage.local.remove(API_KEY_LOCAL);
  await chrome.storage.session.remove(API_KEY_SESSION);
}
