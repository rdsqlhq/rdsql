/**
 * Storage domain types — provider-agnostic.
 *
 * The storage abstraction is intentionally not AWS-specific. S3 is the first
 * (and currently only) provider, but every type here speaks in terms of
 * "objects", "prefixes", and "connections" so a future LocalStorageProvider
 * or other backend can reuse the same shapes and UI.
 *
 * NOTE: `S3ConnectionConfig` is the shape persisted in the Zustand store AND
 * the shape passed to the Rust S3 commands. The `secretAccessKey` / optional
 * `sessionToken` are stored **encrypted at rest** (see `core/storage/secrets`)
 * and decrypted in-memory only for the duration of a transfer, then forwarded
 * to Rust per-call. Rust never persists or logs them.
 */

/** The storage provider a connection targets. `'s3'` covers all S3-compatible
 *  services (AWS S3, Cloudflare R2, MinIO, B2, Wasabi, …). */
export type StorageProviderType = 's3';

/** S3-compatible provider presets — purely for UI prefetch of connection
 *  fields. Every preset uses the SAME `s3` provider implementation. */
export type S3ProviderPreset =
  | 'aws-s3'
  | 'cloudflare-r2'
  | 'minio'
  | 'digitalocean-spaces'
  | 'backblaze-b2'
  | 'wasabi'
  | 'custom';

/** A configured S3-compatible storage connection. `id` is the stable handle
 *  referenced by transfers, backups, and the browser. */
export interface S3ConnectionConfig {
  id: string;
  name: string;
  /** Which preset this connection was created from (drives defaults only). */
  preset: S3ProviderPreset;
  /** Provider discriminator. Always `'s3'` today; reserved for future
   *  non-S3 providers. */
  provider: StorageProviderType;
  /** Region (required for AWS S3; often ignored by R2/MinIO but accepted). */
  region: string;
  /** Bucket name. */
  bucket: string;
  /** Optional custom endpoint URL. Required for R2/MinIO/B2/Wasabi/Spaces;
   *  omitted for AWS S3 (region-derived). */
  endpoint?: string;
  /** Access key id — treated as non-secret (username-equivalent). Persisted
   *  in plaintext alongside the connection, like a DB username. */
  accessKeyId: string;
  /** Secret access key — stored ENCRYPTED at rest (see `secrets.ts`). When
   *  this field is read from the store it is the ciphertext blob; callers
   *  must decrypt before forwarding to Rust. Empty string = "unchanged on
   *  edit" sentinel so we never clobber an existing secret with an empty
   *  masked input. */
  secretAccessKey: string;
  /** Optional temporary session token (STS). Same encryption rules as
   *  `secretAccessKey`. */
  sessionToken?: string;
  /** Virtual-host vs path-style addressing. true for MinIO and most
   *  self-hosted S3; false for AWS S3 / R2. */
  forcePathStyle: boolean;
  /** Root prefix RDSQL owns within the bucket. All RDSQL-managed operations
   *  are scoped under this prefix (e.g. `rdsql/`) unless the user explicitly
   *  browses elsewhere. Enforced by `validatePrefixSafety`. */
  pathPrefix: string;
  /** Optional tag id for grouping in the Explorer sidebar. Mirrors
   *  `DatabaseConnection.tagId` so storage connections can live in the same
   *  tag folders as database connections. null/undefined = untagged. */
  tagId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single object (file) returned by `s3_list_objects`. */
export interface StorageObject {
  /** Full object key, including prefix. */
  key: string;
  /** Object key with the current browse prefix stripped — what the table shows. */
  name: string;
  size: number;
  /** ISO 8601 last-modified timestamp. */
  lastModified: string;
  etag?: string;
  contentType?: string;
  /** True when the object key looks like RDSQL backup metadata (`*.meta.json`). */
  isMetadata?: boolean;
}

/** A "folder" (common prefix) returned by `s3_list_objects`. */
export interface StoragePrefix {
  /** Full prefix, including the browse prefix. */
  prefix: string;
  /** Display name with the trailing slash and browse prefix stripped. */
  name: string;
}

/** `s3_list_objects` result. Pagination via `continuationToken`. */
export interface ListObjectsResult {
  objects: StorageObject[];
  prefixes: StoragePrefix[];
  isTruncated: boolean;
  continuationToken?: string;
}

/** `s3_head_object` result (null when the object does not exist). */
export interface ObjectMetadata {
  key: string;
  size: number;
  lastModified: string;
  etag?: string;
  contentType?: string;
}

/** `s3_test_connection` result. */
export interface TestStorageResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

// ── Transfers ──────────────────────────────────────────────────────────────

export type TransferDirection = 'upload' | 'download';
export type TransferStatus =
  | 'queued'
  | 'preparing'
  | 'active'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'canceled';

/** A single tracked transfer (upload or download). Lives in the
 *  `TransferManager`; the UI subscribes via `useTransferManager`. */
export interface TransferTask {
  id: string;
  direction: TransferDirection;
  /** Storage connection id used for the transfer. */
  connectionId: string;
  /** Bucket-scoped object key. */
  key: string;
  /** Local filesystem path (source for upload, destination for download). */
  localPath: string;
  status: TransferStatus;
  /** Bytes confirmed transferred. */
  bytesDone: number;
  /** Total bytes (best-effort; unknown for streaming uploads until HEAD). */
  totalBytes: number | null;
  /** Smoothed speed in bytes/sec. */
  speedBps: number;
  /** Estimated seconds remaining, or null when unknown. */
  etaSec: number | null;
  /** Epoch ms timestamps for progress UI + history. */
  startedAt: number;
  finishedAt?: number;
  /** Last error message (status === 'failed'). Scrubbed of secrets. */
  error?: string;
  /** Incremental retry attempts so far. */
  attempt: number;
}

// ── Backup metadata (sidecar `.meta.json`) ─────────────────────────────────

/** Versioned metadata describing an RDSQL-managed backup object. Stored as a
 *  sibling `.meta.json` next to the dump; never contains credentials. */
export interface BackupMetadata {
  version: 1;
  type: 'database-backup';
  engine: string;
  database: string;
  connectionName?: string;
  createdAt: string;
  /** Compression applied to the dump, or `'none'`. */
  compression: 'none' | 'gzip';
  /** Encryption marker only ('none' today); ciphertext/key never stored here. */
  encryption: 'none';
  size: number;
  /** Best-effort content checksum (e.g. md5 hex) when available. */
  checksum?: string;
  /** RDSQL version that produced the backup. */
  rdsqlVersion?: string;
}

// ── Normalized storage errors ──────────────────────────────────────────────

/** Discriminated union mirroring the Rust `StorageErrorKind`. The `kind`
 *  drives the UI error banner; `message`/`hint` are human-facing and already
 *  scrubbed of credentials. */
export type StorageErrorKind =
  | 'auth'
  | 'authorization'
  | 'notFound'
  | 'network'
  | 'timeout'
  | 'config'
  | 'upload'
  | 'download'
  | 'multipart'
  | 'unknown';

export interface StorageError {
  kind: StorageErrorKind;
  message: string;
  hint?: string;
}

// ── Retention ──────────────────────────────────────────────────────────────

/** Retention policy applied to a set of RDSQL-managed backup objects. At
 *  least one arm must be set; an empty policy = keep everything. */
export interface RetentionPolicy {
  /** Keep the N most recent backups regardless of age. */
  keepLast?: number;
  /** Keep the N most recent daily backups (newest per UTC day). */
  keepDaily?: number;
  /** Keep the N most recent weekly backups (newest per ISO week). */
  keepWeekly?: number;
  /** Keep the N most recent monthly backups (newest per calendar month). */
  keepMonthly?: number;
}

/** Result of applying a retention policy to a candidate list. `keep` and
 *  `delete` partition the input; the UI always confirms `delete` before any
 *  S3 delete is issued. */
export interface RetentionSelection {
  keep: StorageObject[];
  delete: StorageObject[];
}
