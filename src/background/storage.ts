import { PROVIDER_IDS, isProviderId } from "../shared/providers";
import {
  DEFAULT_SETTINGS,
  MAX_FORM_STEPS,
  type ExtensionSettings,
  type LlmProviderId,
} from "../shared/types";
import { decryptSecret, encryptSecret, isEncryptedBlob } from "./keyVault";

const SETTINGS_KEY = "aff_settings";
/** Keys that survive a browser restart. */
const KEYS_PERSISTENT = "aff_apiKeysByProvider";
/**
 * Keys for this browser session only. Stored in `local` rather than `session`
 * because `chrome.storage.session` is wiped on every extension reload, which
 * would discard the key on each dev rebuild. Cleared explicitly on browser start.
 */
const KEYS_EPHEMERAL = "aff_apiKeysByProviderEphemeral";

/** Legacy single-key entries, migrated on first read. */
const LEGACY_KEYS = ["aff_apiKey", "aff_apiKeyEphemeral"] as const;

type StoredSecret = string | { v: 1; iv: string; ct: string };
type SecretMap = Partial<Record<LlmProviderId, StoredSecret>>;

export function normalizeApiKey(key: string): string {
  return key
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

/** Called from `onStartup`: drops keys the user asked not to persist. */
export async function clearEphemeralBrowserSessionKey(): Promise<void> {
  await chrome.storage.local.remove([KEYS_EPHEMERAL, ...LEGACY_KEYS]);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function sanitizeSettings(stored: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  const merged = { ...DEFAULT_SETTINGS, ...stored };

  const provider = isProviderId(merged.provider) ? merged.provider : DEFAULT_SETTINGS.provider;

  const fallbackProviders = Array.isArray(merged.fallbackProviders)
    ? merged.fallbackProviders.filter(
        (id, index, all) => isProviderId(id) && id !== provider && all.indexOf(id) === index,
      )
    : [];

  return {
    ...merged,
    provider,
    baseUrl: (merged.baseUrl ?? "").trim(),
    model: (merged.model ?? "").trim(),
    fillLanguage: merged.fillLanguage === "override" ? "override" : "auto",
    fillLocaleOverride: (merged.fillLocaleOverride ?? "").trim().slice(0, 35),
    customRequest: (merged.customRequest ?? "").slice(0, 2000),
    maxRounds: clamp(merged.maxRounds, 1, 60, DEFAULT_SETTINGS.maxRounds),
    settleMs: clamp(merged.settleMs, 0, 3000, DEFAULT_SETTINGS.settleMs),
    autoNextEnabled: merged.autoNextEnabled !== false,
    autoNextMaxSteps: clamp(
      merged.autoNextMaxSteps,
      1,
      MAX_FORM_STEPS,
      DEFAULT_SETTINGS.autoNextMaxSteps,
    ),
    fillEmptyOnly: merged.fillEmptyOnly !== false,
    rememberKeyAcrossRestarts: merged.rememberKeyAcrossRestarts !== false,
    fallbackProviders,
    encryptKeys: merged.encryptKeys === true,
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(raw[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined);
}

export async function saveSettings(partial: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...partial });

  // Moving a key between persistent and session storage has to follow the toggle.
  const rememberChanged =
    partial.rememberKeyAcrossRestarts !== undefined &&
    next.rememberKeyAcrossRestarts !== current.rememberKeyAcrossRestarts;
  const existingKey = rememberChanged ? await getApiKey(next.provider) : undefined;

  await chrome.storage.local.set({ [SETTINGS_KEY]: next });

  if (rememberChanged && existingKey) {
    await saveApiKey(next.provider, existingKey, next.rememberKeyAcrossRestarts, next.encryptKeys);
  }
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function readSecretMap(raw: unknown): SecretMap {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: SecretMap = {};

  for (const provider of PROVIDER_IDS) {
    const value = source[provider];
    if (typeof value === "string") {
      const normalized = normalizeApiKey(value);
      if (normalized) out[provider] = normalized;
    } else if (isEncryptedBlob(value)) {
      out[provider] = value;
    }
  }
  return out;
}

async function loadMaps(): Promise<{ persistent: SecretMap; ephemeral: SecretMap }> {
  const bag = await chrome.storage.local.get([KEYS_PERSISTENT, KEYS_EPHEMERAL]);
  return {
    persistent: readSecretMap(bag[KEYS_PERSISTENT]),
    ephemeral: readSecretMap(bag[KEYS_EPHEMERAL]),
  };
}

async function resolveSecret(secret: StoredSecret | undefined): Promise<string | undefined> {
  if (secret === undefined) return undefined;
  if (typeof secret === "string") return secret;
  const decrypted = await decryptSecret(secret);
  return decrypted ?? undefined;
}

export async function getApiKey(provider: LlmProviderId): Promise<string | undefined> {
  const { persistent, ephemeral } = await loadMaps();
  return (
    (await resolveSecret(persistent[provider])) ?? (await resolveSecret(ephemeral[provider]))
  );
}

/** Whether a key exists, without decrypting it. Safe to answer while locked. */
export async function hasApiKey(provider: LlmProviderId): Promise<boolean> {
  const { persistent, ephemeral } = await loadMaps();
  return persistent[provider] !== undefined || ephemeral[provider] !== undefined;
}

export async function isKeyEncrypted(provider: LlmProviderId): Promise<boolean> {
  const { persistent, ephemeral } = await loadMaps();
  return isEncryptedBlob(persistent[provider]) || isEncryptedBlob(ephemeral[provider]);
}

export async function saveApiKey(
  provider: LlmProviderId,
  key: string,
  rememberAcrossRestarts: boolean,
  encrypt = false,
): Promise<void> {
  const trimmed = normalizeApiKey(key);
  if (!trimmed) {
    await clearApiKey(provider);
    return;
  }

  const secret: StoredSecret = encrypt ? await encryptSecret(trimmed) : trimmed;
  const { persistent, ephemeral } = await loadMaps();

  if (rememberAcrossRestarts) {
    delete ephemeral[provider];
    persistent[provider] = secret;
  } else {
    delete persistent[provider];
    ephemeral[provider] = secret;
  }

  await chrome.storage.local.set({
    [KEYS_PERSISTENT]: persistent,
    [KEYS_EPHEMERAL]: ephemeral,
  });
}

export async function clearApiKey(provider?: LlmProviderId): Promise<void> {
  if (!provider) {
    await chrome.storage.local.remove([KEYS_PERSISTENT, KEYS_EPHEMERAL, ...LEGACY_KEYS]);
    return;
  }

  const { persistent, ephemeral } = await loadMaps();
  delete persistent[provider];
  delete ephemeral[provider];

  await chrome.storage.local.set({
    [KEYS_PERSISTENT]: persistent,
    [KEYS_EPHEMERAL]: ephemeral,
  });
}

/** Re-wraps every stored key when the user turns encryption on or off. */
export async function reencryptStoredKeys(encrypt: boolean): Promise<void> {
  const { persistent, ephemeral } = await loadMaps();

  const convert = async (map: SecretMap): Promise<SecretMap> => {
    const out: SecretMap = {};
    for (const provider of PROVIDER_IDS) {
      const secret = map[provider];
      if (secret === undefined) continue;
      const plaintext = await resolveSecret(secret);
      // A key we cannot read (vault locked) is left exactly as it is.
      if (plaintext === undefined) {
        out[provider] = secret;
        continue;
      }
      out[provider] = encrypt ? await encryptSecret(plaintext) : plaintext;
    }
    return out;
  };

  await chrome.storage.local.set({
    [KEYS_PERSISTENT]: await convert(persistent),
    [KEYS_EPHEMERAL]: await convert(ephemeral),
  });
}

export async function getAllApiKeys(): Promise<Partial<Record<LlmProviderId, string>>> {
  const out: Partial<Record<LlmProviderId, string>> = {};
  for (const provider of PROVIDER_IDS) {
    const key = await getApiKey(provider);
    if (key) out[provider] = key;
  }
  return out;
}
