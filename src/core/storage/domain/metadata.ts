/**
 * Backup metadata sidecar serialization.
 *
 * Each RDSQL-managed backup object is accompanied by a sibling `<name>.meta.json`
 * describing what it is. This keeps the dump itself a clean `.sql[.gz]` while
 * letting the restore browser show engine/db/timestamp without re-reading the
 * (potentially huge) dump. The schema is versioned so future RDSQL versions
 * stay forward/backward compatible.
 *
 * SECURITY: never put credentials, connection strings, or signed URLs in
 * metadata. The type enforces this by construction — there is no field for it.
 */
import type { BackupMetadata } from './types';

export const METADATA_VERSION = 1 as const;
/** Suffix appended to a backup object key to form its sidecar metadata key. */
export const METADATA_SUFFIX = '.meta.json';

/** Serialize a `BackupMetadata` to a pretty JSON string ready to upload. */
export function serializeMetadata(meta: BackupMetadata): string {
  if (meta.version !== METADATA_VERSION) {
    throw new Error(`Unsupported backup metadata version: ${meta.version}`);
  }
  return JSON.stringify(meta, null, 2);
}

/** Parse a metadata sidecar string. Returns `null` for empty input. Throws on
 *  malformed JSON or unsupported version so callers can surface the error. */
export function parseMetadata(raw: string): BackupMetadata | null {
  if (!raw || !raw.trim()) return null;
  const obj = JSON.parse(raw) as BackupMetadata;
  if (obj.version !== METADATA_VERSION) {
    throw new Error(`Unsupported backup metadata version: ${obj.version}`);
  }
  if (obj.type !== 'database-backup') {
    throw new Error(`Unexpected metadata type: ${obj.type}`);
  }
  return obj;
}

/** Derive the sidecar metadata key for a given backup object key.
 *  `backup-2026-08-09.sql.gz` → `backup-2026-08-09.sql.gz.meta.json`. */
export function metadataKeyFor(backupKey: string): string {
  return `${backupKey}${METADATA_SUFFIX}`;
}

/** Inverse: given a key, return true if it is a metadata sidecar. */
export function isMetadataKey(key: string): boolean {
  return key.endsWith(METADATA_SUFFIX);
}

/** Given a metadata key, return the backup object key it describes. */
export function backupKeyForMetadata(metaKey: string): string {
  if (!isMetadataKey(metaKey)) return metaKey;
  return metaKey.slice(0, -METADATA_SUFFIX.length);
}
