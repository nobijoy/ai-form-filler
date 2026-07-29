/**
 * Optional encryption-at-rest for API keys.
 *
 * By default keys sit in `chrome.storage.local` in the clear, which is readable
 * by anyone with filesystem access to the browser profile. With `encryptKeys`
 * enabled they are wrapped with AES-GCM under a key derived from a user
 * passphrase; the derived key lives in `chrome.storage.session` so it survives
 * service-worker restarts but not a browser restart.
 */

const PBKDF2_ITERATIONS = 250_000;
const SALT_KEY = "aff_kdfSalt";
const SESSION_KEY = "aff_sessionKek";

interface EncryptedBlob {
  v: 1;
  iv: string;
  ct: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getOrCreateSalt(): Promise<Uint8Array> {
  const stored = await chrome.storage.local.get(SALT_KEY);
  const existing = stored[SALT_KEY];
  if (typeof existing === "string" && existing.length > 0) return fromBase64(existing);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  await chrome.storage.local.set({ [SALT_KEY]: toBase64(salt) });
  return salt;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

/** Derives the wrapping key from a passphrase and holds it for this browser session. */
export async function unlockVault(passphrase: string): Promise<void> {
  if (!passphrase.trim()) throw new Error("Passphrase must not be empty.");
  const salt = await getOrCreateSalt();
  const key = await deriveKey(passphrase, salt);
  const exported = await crypto.subtle.exportKey("raw", key);
  await chrome.storage.session.set({ [SESSION_KEY]: toBase64(new Uint8Array(exported)) });
}

export async function lockVault(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}

export async function isVaultUnlocked(): Promise<boolean> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return typeof stored[SESSION_KEY] === "string";
}

async function loadSessionKey(): Promise<CryptoKey | null> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const raw = stored[SESSION_KEY];
  if (typeof raw !== "string") return null;

  return crypto.subtle.importKey("raw", fromBase64(raw) as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as EncryptedBlob).v === 1 &&
    typeof (value as EncryptedBlob).iv === "string" &&
    typeof (value as EncryptedBlob).ct === "string"
  );
}

export async function encryptSecret(plaintext: string): Promise<EncryptedBlob> {
  const key = await loadSessionKey();
  if (!key) throw new Error("Key vault is locked. Enter your passphrase to save keys.");

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) };
}

/** Returns null when the vault is locked or the passphrase does not match. */
export async function decryptSecret(blob: EncryptedBlob): Promise<string | null> {
  const key = await loadSessionKey();
  if (!key) return null;

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(blob.iv) as BufferSource },
      key,
      fromBase64(blob.ct) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
