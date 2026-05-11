import { DEFAULT_SETTINGS, type ExtensionSettings, type LlmProviderId } from "../shared/types";

const SETTINGS_KEY = "aff_settings";
/** Persists when “remember across restarts” is enabled */
const API_KEY_LOCAL = "aff_apiKey";
/**
 * When remember is off: key is stored here so extension reload / dev rebuild does not wipe it
 * (chrome.storage.session is cleared on every extension update/reload). Cleared on browser start.
 */
const API_KEY_EPHEMERAL = "aff_apiKeyEphemeral";
const API_KEYS_BY_PROVIDER_LOCAL = "aff_apiKeysByProvider";
const API_KEYS_BY_PROVIDER_EPHEMERAL = "aff_apiKeysByProviderEphemeral";

/** Called from background onStartup — clears session-mode keys when the browser restarts */
export async function clearEphemeralBrowserSessionKey(): Promise<void> {
  await chrome.storage.local.remove([API_KEY_EPHEMERAL, API_KEYS_BY_PROVIDER_EPHEMERAL]);
}

export function normalizeApiKey(key: string): string {
  return key
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

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
  const existingKey = rememberChanged ? await getApiKey(next.provider) : undefined;
  await chrome.storage.local.set({
    [SETTINGS_KEY]: next,
  });
  if (rememberChanged && existingKey) {
    await saveApiKey(next.provider, existingKey, next.rememberKeyAcrossRestarts);
  }
}

function providerIds(): LlmProviderId[] {
  return ["openrouter", "groq", "google", "cerebras"];
}

function normalizeApiKeyMap(raw: unknown): Partial<Record<LlmProviderId, string>> {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const out: Partial<Record<LlmProviderId, string>> = {};
  for (const provider of providerIds()) {
    const value = obj[provider];
    if (typeof value !== "string") continue;
    const normalized = normalizeApiKey(value);
    if (normalized) out[provider] = normalized;
  }
  return out;
}

async function migrateLegacySingleKeyIfNeeded(): Promise<void> {
  try {
    const legacySession = await chrome.storage.session.get(API_KEY_LOCAL);
    const legacyVal = legacySession[API_KEY_LOCAL];
    if (typeof legacyVal === "string") {
      const t = normalizeApiKey(legacyVal);
      await chrome.storage.session.remove(API_KEY_LOCAL);
      if (t.length > 0) {
        const existing = await chrome.storage.local.get([API_KEY_LOCAL, API_KEY_EPHEMERAL]);
        if (!existing[API_KEY_LOCAL] && !existing[API_KEY_EPHEMERAL]) {
          await chrome.storage.local.set({ [API_KEY_EPHEMERAL]: t });
        }
      }
    }
  } catch {
    /* chrome.storage.session unavailable */
  }

  const bag = await chrome.storage.local.get([
    API_KEY_LOCAL,
    API_KEY_EPHEMERAL,
    API_KEYS_BY_PROVIDER_LOCAL,
    API_KEYS_BY_PROVIDER_EPHEMERAL,
  ]);
  const hasProviderMap =
    (bag[API_KEYS_BY_PROVIDER_LOCAL] && typeof bag[API_KEYS_BY_PROVIDER_LOCAL] === "object") ||
    (bag[API_KEYS_BY_PROVIDER_EPHEMERAL] && typeof bag[API_KEYS_BY_PROVIDER_EPHEMERAL] === "object");
  if (hasProviderMap) return;

  const persistent = bag[API_KEY_LOCAL];
  if (typeof persistent === "string") {
    const t = normalizeApiKey(persistent);
    if (t.length > 0) {
      await chrome.storage.local.set({ [API_KEYS_BY_PROVIDER_LOCAL]: { openrouter: t } });
    }
  }
  const ephemeral = bag[API_KEY_EPHEMERAL];
  if (typeof ephemeral === "string") {
    const t = normalizeApiKey(ephemeral);
    if (t.length > 0) {
      await chrome.storage.local.set({ [API_KEYS_BY_PROVIDER_EPHEMERAL]: { openrouter: t } });
    }
  }
}

export async function getApiKey(provider: LlmProviderId): Promise<string | undefined> {
  await migrateLegacySingleKeyIfNeeded();
  const bag = await chrome.storage.local.get([
    API_KEYS_BY_PROVIDER_LOCAL,
    API_KEYS_BY_PROVIDER_EPHEMERAL,
    API_KEY_LOCAL,
    API_KEY_EPHEMERAL,
  ]);
  const localMap = normalizeApiKeyMap(bag[API_KEYS_BY_PROVIDER_LOCAL]);
  const ephemeralMap = normalizeApiKeyMap(bag[API_KEYS_BY_PROVIDER_EPHEMERAL]);
  if (localMap[provider]) return localMap[provider];
  if (ephemeralMap[provider]) return ephemeralMap[provider];

  // Backward compatibility with pre-provider storage only for OpenRouter.
  // Other providers must not reuse legacy single-key storage, otherwise we can
  // accidentally send an OpenRouter key to Groq/Google/Cerebras and get 401.
  if (provider !== "openrouter") return undefined;

  const persistent = bag[API_KEY_LOCAL];
  if (typeof persistent === "string") {
    const t = normalizeApiKey(persistent);
    if (t.length > 0) return t;
  }
  const ephemeral = bag[API_KEY_EPHEMERAL];
  if (typeof ephemeral === "string") {
    const t = normalizeApiKey(ephemeral);
    if (t.length > 0) return t;
  }
  return undefined;
}

export async function saveApiKey(
  provider: LlmProviderId,
  key: string,
  rememberAcrossRestarts: boolean,
): Promise<void> {
  const trimmed = normalizeApiKey(key);
  if (!trimmed) {
    await clearApiKey(provider);
    return;
  }
  await migrateLegacySingleKeyIfNeeded();
  const bag = await chrome.storage.local.get([
    API_KEYS_BY_PROVIDER_LOCAL,
    API_KEYS_BY_PROVIDER_EPHEMERAL,
  ]);
  const localMap = normalizeApiKeyMap(bag[API_KEYS_BY_PROVIDER_LOCAL]);
  const ephemeralMap = normalizeApiKeyMap(bag[API_KEYS_BY_PROVIDER_EPHEMERAL]);
  if (rememberAcrossRestarts) {
    delete ephemeralMap[provider];
    localMap[provider] = trimmed;
  } else {
    delete localMap[provider];
    ephemeralMap[provider] = trimmed;
  }
  await chrome.storage.local.set({
    [API_KEYS_BY_PROVIDER_LOCAL]: localMap,
    [API_KEYS_BY_PROVIDER_EPHEMERAL]: ephemeralMap,
  });
}

export async function clearApiKey(provider?: LlmProviderId): Promise<void> {
  if (!provider) {
    await chrome.storage.local.remove([
      API_KEY_LOCAL,
      API_KEY_EPHEMERAL,
      API_KEYS_BY_PROVIDER_LOCAL,
      API_KEYS_BY_PROVIDER_EPHEMERAL,
    ]);
    return;
  }
  await migrateLegacySingleKeyIfNeeded();
  const bag = await chrome.storage.local.get([
    API_KEYS_BY_PROVIDER_LOCAL,
    API_KEYS_BY_PROVIDER_EPHEMERAL,
  ]);
  const localMap = normalizeApiKeyMap(bag[API_KEYS_BY_PROVIDER_LOCAL]);
  const ephemeralMap = normalizeApiKeyMap(bag[API_KEYS_BY_PROVIDER_EPHEMERAL]);
  delete localMap[provider];
  delete ephemeralMap[provider];
  await chrome.storage.local.set({
    [API_KEYS_BY_PROVIDER_LOCAL]: localMap,
    [API_KEYS_BY_PROVIDER_EPHEMERAL]: ephemeralMap,
  });
}
