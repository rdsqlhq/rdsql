import { DatabaseConnection } from '../domain/types';
import type { S3ConnectionConfig } from '../storage/domain/types';
import { decryptSecret } from '../storage/secrets';

export interface EncryptedPackage {
  version: string;
  format: 'rdsql-encrypted-connections';
  algorithm: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // hex
  iv: string;   // hex
  cipherText: string; // hex
  exportedAt: string;
  /**
   * v1.2: when `true`, the file was exported WITHOUT a user-supplied password.
   * The envelope is still AES-256-GCM encrypted, but the key was derived from a
   * randomly generated passphrase that is embedded in the file (in
   * `embeddedKey`, hex). Importing such a file never prompts for a password —
   * the importer reads `embeddedKey` and derives the same AES key. This keeps
   * every exported file encrypted at rest while letting users skip the password
   * step if they don't want one.
   */
  noUserPassword?: boolean;
  embeddedKey?: string; // hex — only present when noUserPassword === true
}

/** Decrypted payload — both database and (optionally) storage connections.
 *  v1.1 files decrypt to this object shape. Legacy v1.0 files decrypt to a
 *  bare `DatabaseConnection[]`, which `decryptPackage` normalizes into
 *  `{ databases: [...], storage: [] }`. */
export interface DecryptedConnections {
  databases: DatabaseConnection[];
  storage: S3ConnectionConfig[];
}

/** Internal ciphertext payload (v1.1). Never seen unencrypted outside this
 *  module. `storage` secrets are stored as PLAINTEXT inside the passphrase-
 *  encrypted envelope (decrypted from the per-device KEK at export time, then
 *  re-sealed on import so they bind to the importing device's KEK). */
interface PackagePayload {
  databases: DatabaseConnection[];
  storage: S3ConnectionConfig[];
}

// Convert ArrayBuffer to Hex string
function bufToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Convert Hex string to Uint8Array
function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// Derive AES-256 Key from Master Password + Salt using PBKDF2.
// Accepts the key material either as a UTF-8 string (user password) or as raw
// bytes (the auto-generated embedded key used when the user chooses no
// password). Passing the Uint8Array directly as a BufferSource avoids the
// fragile `.buffer` slice assumption when the view is a sub-view.
async function deriveKey(
  password: string | Uint8Array,
  salt: Uint8Array,
  iterations = 100000,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial =
    typeof password === 'string' ? enc.encode(password) : password;
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    keyMaterial as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Generate a cryptographically strong random passphrase (32 bytes → 64 hex
 * chars). Used when the user exports WITHOUT a password: the envelope is still
 * encrypted, but the key is this random value which we embed in the file. The
 * hex is returned as a Uint8Array (raw key material) plus its hex string form
 * (to store in `embeddedKey`).
 */
function generateRandomKeyMaterial(): { bytes: Uint8Array; hex: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { bytes, hex: bufToHex(bytes.buffer) };
}

/**
 * At export time the stored S3 `secretAccessKey` (and optional `sessionToken`)
 * are KEK-bound ciphertext. To make the exported file portable across devices,
 * decrypt them to plaintext here — the plaintext lives only inside the
 * passphrase-encrypted envelope. Best-effort: if a secret can't be decrypted
 * (e.g. corrupted KEK), fall back to an empty string rather than failing the
 * whole export.
 */
async function withPlaintextSecrets(
  conn: S3ConnectionConfig,
): Promise<S3ConnectionConfig> {
  try {
    const secretAccessKey = await decryptSecret(conn.secretAccessKey);
    let sessionToken: string | undefined;
    if (conn.sessionToken) sessionToken = await decryptSecret(conn.sessionToken);
    return { ...conn, secretAccessKey, sessionToken };
  } catch {
    return { ...conn, secretAccessKey: '', sessionToken: undefined };
  }
}

/**
 * Encrypts database connections (and optionally S3 storage connections) into a
 * single passphrase-protected `EncryptedPackage`. Storage connections have
 * their KEK-bound secrets decrypted to plaintext before sealing so the file is
 * portable; the plaintext is recoverable only with the passphrase.
 *
 * The passphrase is OPTIONAL: if omitted (or empty), a strong random key is
 * generated and embedded in the file (`noUserPassword: true`, `embeddedKey`).
 * The file is STILL encrypted with AES-256-GCM — it just doesn't require a
 * password to reopen. This satisfies "password optional, but file still
 * encrypted". If a passphrase is provided, it is required at import time.
 *
 * For backward compatibility, when `storageConnections` is empty/omitted the
 * ciphertext still encodes a `{ databases, storage: [] }` object — the v1.0
 * `decryptConnections` legacy path is preserved separately below.
 */
export async function encryptConnections(
  connections: DatabaseConnection[],
  passphrase: string | undefined | null,
  storageConnections: S3ConnectionConfig[] = [],
): Promise<EncryptedPackage> {
  const hasUserPassword = !!passphrase && passphrase.trim().length > 0;

  const plaintextStorage = await Promise.all(
    storageConnections.map(withPlaintextSecrets),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // When the user supplies no password, derive the AES key from a random
  // 32-byte value that we embed in the envelope. The file is still fully
  // encrypted; importing just doesn't need to ask for a password.
  let embeddedKeyHex: string | undefined;
  const keyMaterial: string | Uint8Array = hasUserPassword
    ? (passphrase as string)
    : (() => {
        const { bytes, hex } = generateRandomKeyMaterial();
        embeddedKeyHex = hex;
        return bytes;
      })();

  const key = await deriveKey(keyMaterial, salt, 100000);

  const payload: PackagePayload = {
    databases: connections,
    storage: plaintextStorage,
  };
  const jsonStr = JSON.stringify(payload, null, 2);
  const enc = new TextEncoder();
  const encodedData = enc.encode(jsonStr);

  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
    },
    key,
    encodedData,
  );

  return {
    version: '1.2',
    format: 'rdsql-encrypted-connections',
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: 100000,
    salt: bufToHex(salt.buffer),
    iv: bufToHex(iv.buffer),
    cipherText: bufToHex(encryptedBuffer),
    exportedAt: new Date().toISOString(),
    ...(hasUserPassword
      ? {}
      : { noUserPassword: true, embeddedKey: embeddedKeyHex }),
  };
}

/**
 * Decrypts an `EncryptedPackage` and returns both database and storage
 * connections. Handles two ciphertext shapes transparently:
 *  - v1.1/v1.2 object payload `{ databases, storage }`
 *  - v1.0 legacy bare array `DatabaseConnection[]` (storage defaults to [])
 *
 * Password handling:
 *  - v1.2 files with `noUserPassword: true` carry an `embeddedKey`; the
 *    passphrase argument is IGNORED for these files (they decrypt without a
 *    user password, but are still AES-256-GCM encrypted).
 *  - All other files require a user-supplied passphrase.
 *
 * The returned storage connections have PLAINTEXT secrets (as decrypted from
 * the envelope); the caller MUST re-seal them with `encryptSecret` before
 * persisting into `useStorageStore`.
 */
export async function decryptPackage(
  pkg: EncryptedPackage,
  passphrase: string | undefined | null,
): Promise<DecryptedConnections> {
  if (pkg.format !== 'rdsql-encrypted-connections') {
    throw new Error('Invalid file format. Expected "rdsql-encrypted-connections".');
  }

  // Files exported without a user password embed their own key material.
  const isPasswordless = pkg.noUserPassword === true && !!pkg.embeddedKey;

  // Only require a passphrase for files that were actually password-protected.
  if (!isPasswordless && (!passphrase || passphrase.trim().length === 0)) {
    throw new Error('Passphrase cannot be empty.');
  }

  const salt = hexToBuf(pkg.salt);
  const iv = hexToBuf(pkg.iv);
  const cipherText = hexToBuf(pkg.cipherText);

  // Derive the AES key. For passwordless files we feed the embedded raw bytes
  // directly; for normal files we feed the user's passphrase string.
  let key: CryptoKey;
  try {
    if (isPasswordless) {
      key = await deriveKey(hexToBuf(pkg.embeddedKey!), salt, pkg.iterations || 100000);
    } else {
      key = await deriveKey(passphrase as string, salt, pkg.iterations || 100000);
    }
  } catch {
    // Key derivation never throws on a wrong password (PBKDF2 always produces
    // a key), but be defensive: report it as a crypto failure, NOT a payload
    // shape error.
    throw new Error('Incorrect password or file integrity check failed.');
  }

  // AES-GCM decrypt. This is the ONLY step that fails on a wrong password —
  // the GCM auth tag check throws an OperationError. Keep this isolated from
  // the JSON/shape validation below so that a shape problem is never
  // misreported as a password problem.
  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
      },
      key,
      cipherText as BufferSource,
    );
  } catch {
    throw new Error('Incorrect password or file integrity check failed.');
  }

  const dec = new TextDecoder();
  const jsonStr = dec.decode(decryptedBuffer);
  const parsed = JSON.parse(jsonStr);

  // v1.1/v1.2 object payload.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const databases = Array.isArray(parsed.databases) ? parsed.databases : [];
    const storage = Array.isArray(parsed.storage) ? parsed.storage : [];
    if (databases.length === 0 && storage.length === 0) {
      // NOTE: this is a payload problem, NOT a password problem. Phrased
      // without the word "decrypt" so it can never be misclassified.
      throw new Error('The backup file does not contain any connections.');
    }
    return { databases, storage };
  }

  // v1.0 legacy: bare DatabaseConnection[].
  if (Array.isArray(parsed)) {
    return { databases: parsed, storage: [] };
  }

  throw new Error('The backup file contents are not a valid connections payload.');
}

/**
 * Returns `true` if the package was exported without a user password and can
 * therefore be decrypted without prompting. The file is still encrypted — the
 * key is embedded in the package.
 */
export function isPasswordlessPackage(pkg: EncryptedPackage): boolean {
  return pkg.noUserPassword === true && !!pkg.embeddedKey;
}

/**
 * Legacy decrypt — returns ONLY database connections. Kept for callers that
 * haven't migrated to `decryptPackage` yet; internally delegates to
 * `decryptPackage` and discards storage (if any).
 *
 * @deprecated Prefer `decryptPackage` to receive storage connections too.
 */
export async function decryptConnections(
  pkg: EncryptedPackage,
  passphrase: string | undefined | null,
): Promise<DatabaseConnection[]> {
  const { databases } = await decryptPackage(pkg, passphrase);
  return databases;
}
