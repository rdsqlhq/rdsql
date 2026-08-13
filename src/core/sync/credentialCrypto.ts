/**
 * Per-resource E2E credential encryption for cloud sync — AES-256-GCM via
 * Web Crypto, same algorithm as `core/crypto/encryptedConnections.ts` but a
 * different shape: that module bundles the *whole* connection list into one
 * ciphertext blob with a fresh random salt per export (fine for a one-shot
 * file). Sync needs the opposite — a STABLE key, reused across many
 * independent per-connection encrypt/decrypt calls so every device
 * encrypts/decrypts with the same key.
 *
 * There is no user-facing passphrase. The first device to enable sync
 * generates a random 256-bit key locally and caches it in the OS keychain —
 * the server never sees it, in any form. Additional devices don't invent
 * their own key (which would make every device unable to read the others'
 * synced data); instead they receive the SAME key from an already-set-up
 * device via the existing pairing-code flow: the source device wraps
 * (AES-GCM-encrypts) its raw key using a key derived from the one-time
 * pairing code, uploads only that ciphertext (`exportSyncKeyForPairing`),
 * and the redeeming device unwraps it locally using the same code
 * (`importSyncKeyFromPairing`) — see functions/api/pairing/{create,redeem}.ts.
 * The server only ever relays opaque ciphertext keyed by a code it also
 * never sees in a form it could use to decrypt (`pairing_codes.code_hash`).
 *
 * The server (`functions/api/sync/credentials/[resourceId].ts`) only ever
 * sees `{ciphertext, iv, tag}` for connection credentials — opaque to it by
 * design (zero-knowledge).
 */
import { safeInvoke } from '../tauri/ipc';

const KEY_MATERIAL_KEYCHAIN_KEY = 'rdsql_sync_key_material';
const PAIRING_WRAP_ITERATIONS = 100_000; // matches Cloudflare Workers' production PBKDF2 iteration cap

function bufToHex(buffer: ArrayBuffer | Uint8Array): string {
  return Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

async function importAesKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawBytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedField {
  ciphertext: string; // hex
  iv: string; // hex
  tag: string; // hex — last 16 bytes of the GCM output, split out for API clarity
}

const GCM_TAG_BYTES = 16;

async function aesEncrypt(key: CryptoKey, plaintextBytes: Uint8Array): Promise<EncryptedField> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintextBytes as BufferSource));
  const ciphertext = combined.slice(0, combined.length - GCM_TAG_BYTES);
  const tag = combined.slice(combined.length - GCM_TAG_BYTES);
  return { ciphertext: bufToHex(ciphertext), iv: bufToHex(iv), tag: bufToHex(tag) };
}

async function aesDecrypt(key: CryptoKey, field: EncryptedField): Promise<Uint8Array> {
  const combined = new Uint8Array([...hexToBuf(field.ciphertext), ...hexToBuf(field.tag)]);
  const iv = hexToBuf(field.iv);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, combined as BufferSource);
  return new Uint8Array(plainBuf);
}

/** Ensures this device has a local sync key, generating one if it's the
 *  first device ever to enable sync on this account. Safe to call
 *  repeatedly — a no-op once a key exists. */
export async function ensureSyncKey(): Promise<void> {
  if (await hasSyncKey()) return;
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  await safeInvoke('save_secure_credential', { key: KEY_MATERIAL_KEYCHAIN_KEY, value: bufToHex(rawKey) });
}

export async function hasSyncKey(): Promise<boolean> {
  const stored = await safeInvoke<string | null>('get_secure_credential', { key: KEY_MATERIAL_KEYCHAIN_KEY });
  return !!stored;
}

export async function clearSyncKey(): Promise<void> {
  await safeInvoke('delete_secure_credential', { key: KEY_MATERIAL_KEYCHAIN_KEY });
}

async function getCachedSyncKey(): Promise<CryptoKey> {
  const stored = await safeInvoke<string | null>('get_secure_credential', { key: KEY_MATERIAL_KEYCHAIN_KEY });
  if (!stored) throw new Error('Sync is not set up on this device yet.');
  return importAesKey(hexToBuf(stored));
}

/** A key derived from the pairing code's plaintext — known independently by
 *  both the pairing-code-creating device and the redeeming device, used
 *  ONLY to wrap/unwrap the sync key in transit through the server. */
async function deriveWrappingKey(code: string): Promise<CryptoKey> {
  const codeKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode('rdsql-pairing-sync-key-v1') as BufferSource, iterations: PAIRING_WRAP_ITERATIONS, hash: 'SHA-256' },
    codeKey,
    256,
  );
  return importAesKey(new Uint8Array(bits));
}

// Same alphabet/length as the server used to generate before this device
// took over code generation (functions/api/pairing/create.ts) — the server
// still validates against this exact pattern.
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Generates the pairing code CLIENT-side (rather than letting the server
 *  pick it) because the code's plaintext has to be known here before the
 *  create request, to derive the key that wraps the sync key below. */
export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
}

/** Called when generating a pairing code on a device that already has a
 *  sync key set up — wraps it for upload alongside the code. Returns `null`
 *  if this device has no sync key yet (nothing to hand off). */
export async function exportSyncKeyForPairing(code: string): Promise<EncryptedField | null> {
  const stored = await safeInvoke<string | null>('get_secure_credential', { key: KEY_MATERIAL_KEYCHAIN_KEY });
  if (!stored) return null;
  const wrappingKey = await deriveWrappingKey(code);
  return aesEncrypt(wrappingKey, hexToBuf(stored));
}

/** Called after a successful pairing-code redemption when the server
 *  returned a wrapped sync key — unwraps it with the same code and adopts
 *  it as this device's sync key. */
export async function importSyncKeyFromPairing(code: string, field: EncryptedField): Promise<void> {
  const wrappingKey = await deriveWrappingKey(code);
  const rawKey = await aesDecrypt(wrappingKey, field);
  await safeInvoke('save_secure_credential', { key: KEY_MATERIAL_KEYCHAIN_KEY, value: bufToHex(rawKey) });
}

/** Encrypts an arbitrary string (callers JSON.stringify a credentials object
 *  first) with the cached sync key. */
export async function encryptForSync(plaintext: string): Promise<EncryptedField> {
  const key = await getCachedSyncKey();
  return aesEncrypt(key, new TextEncoder().encode(plaintext));
}

export async function decryptFromSync(field: EncryptedField): Promise<string> {
  const key = await getCachedSyncKey();
  try {
    const plainBytes = await aesDecrypt(key, field);
    return new TextDecoder().decode(plainBytes);
  } catch {
    throw new Error('Failed to decrypt — this device\'s sync key does not match.');
  }
}
