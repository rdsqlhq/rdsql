/**
 * Encrypted-at-rest storage for S3 secret access keys.
 *
 * Per the chosen design (encrypted in localStorage), the secret access key and
 * optional session token are encrypted with AES-256-GCM before they are written
 * into the persisted store. The wrapping key (KEK) is a random 256-bit key
 * generated once per device and persisted under a separate localStorage key.
 *
 * THREAT MODEL & HONEST LIMITATION:
 * This is defense-in-depth against casual localStorage inspection (e.g. a
 * shared machine, a stolen laptop with an unlocked browser, a malicious
 * browser extension reading localStorage). It is NOT equivalent to the OS
 * keychain — anything that can read localStorage can also read the KEK and
 * decrypt. The spec's stated preference is OS-keychain storage; the user
 * explicitly chose the encrypted-localStorage tradeoff for this build. The
 * `toStorageError`-style normalized errors never surface the KEK or ciphertext.
 *
 * The Rust side never sees the ciphertext — `decryptSecret()` is called in
 * memory immediately before a transfer, and the plaintext is passed per-call
 * into the S3 command and then dropped.
 */
import type { S3ConnectionConfig } from './domain/types';

/** AES-256-GCM + a per-device random KEK. Never logged. */
const KEK_STORAGE_KEY = 'rdsql_storage_kek_v1';

interface SealedSecret {
  /** Marker so we never confuse plaintext with ciphertext. */
  format: 'rdsql-sealed';
  algorithm: 'AES-256-GCM';
  iv: string; // hex
  cipherText: string; // hex
}

// ── Hex helpers (duplicated from encryptedConnections to keep the storage
//    module standalone and avoid coupling secret storage to the connection-
//    export crypto). ────────────────────────────────────────────────────────

function bufToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

// ── Per-device KEK ─────────────────────────────────────────────────────────

let cachedKey: CryptoKey | null = null;

/** Lazily create or load the per-device key-encryption key. Persisted under a
 *  dedicated localStorage key so it survives reloads. */
async function getKek(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const existing = localStorage.getItem(KEK_STORAGE_KEY);
  let raw: Uint8Array;
  if (existing) {
    raw = hexToBuf(existing);
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    localStorage.setItem(KEK_STORAGE_KEY, bufToHex(raw));
  }
  cachedKey = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return cachedKey;
}

/** Encrypt a plaintext secret string into a SealedSecret blob. */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  const kek = await getKek();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, kek, encoded);
  const sealed: SealedSecret = {
    format: 'rdsql-sealed',
    algorithm: 'AES-256-GCM',
    iv: bufToHex(iv),
    cipherText: bufToHex(cipherBuf),
  };
  return JSON.stringify(sealed);
}

/** Decrypt a SealedSecret blob back to plaintext. Returns '' for empty input.
 *  Throws on tampering / wrong KEK (e.g. KEK wiped from localStorage). */
export async function decryptSecret(sealedStr: string): Promise<string> {
  if (!sealedStr) return '';
  let sealed: SealedSecret;
  try {
    sealed = JSON.parse(sealedStr);
  } catch {
    throw new Error('Stored secret is corrupted.');
  }
  if (sealed.format !== 'rdsql-sealed') {
    throw new Error('Unrecognized secret format.');
  }
  const kek = await getKek();
  const iv = hexToBuf(sealed.iv);
  const cipher = hexToBuf(sealed.cipherText);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    kek,
    cipher as BufferSource,
  );
  return new TextDecoder().decode(plainBuf);
}

/** Mask an access key id for display, e.g. "AKIA••••1234". Keeps the first 4
 *  and last 4 characters; collapses everything between to dots. */
export function maskAccessKeyId(akid: string): string {
  if (!akid) return '';
  if (akid.length <= 8) return '••••';
  return `${akid.slice(0, 4)}••••${akid.slice(-4)}`;
}

/** Produce a copy of the connection config with the secret decrypted in
 *  memory, ready to forward to a Rust S3 command. The caller MUST NOT persist
 *  the returned object. */
export async function withDecryptedSecret(
  conn: S3ConnectionConfig,
): Promise<S3ConnectionConfig> {
  const secretAccessKey = await decryptSecret(conn.secretAccessKey);
  let sessionToken: string | undefined;
  if (conn.sessionToken) sessionToken = await decryptSecret(conn.sessionToken);
  return { ...conn, secretAccessKey, sessionToken };
}

/** Sentinel returned/stored when the user leaves the secret field unchanged
 *  on edit. The store treats this string as "keep existing ciphertext". */
export const UNCHANGED_SECRET = '<<unchanged>>';
