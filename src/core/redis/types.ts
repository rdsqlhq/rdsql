/**
 * Redis domain types — mirror the DTOs returned by `commands::redis` in
 * `src-tauri/src/commands/redis.rs` field-for-field.
 *
 * Deliberately separate from `QueryResultData`/`SchemaGroupNode`: Redis has
 * no schema/columns, so none of the SQL-engine result/tree shapes apply.
 * The connection itself, though, is a normal `DatabaseConnection` (engine
 * `'redis'`) — see `core/domain/types.ts` — not a parallel config type like
 * `S3ConnectionConfig`.
 */

/** One key from a `SCAN` page, enriched with its type/TTL (fetched server-side
 *  via one pipelined round trip for the whole page — see `redis_scan_keys`). */
export interface RedisKeyEntry {
  key: string;
  keyType: string;
  /** Milliseconds remaining, or `undefined` when the key has no TTL. */
  ttlMs?: number;
}

/** A page of keys from `redis_scan_keys`. `cursor` is opaque — pass it
 *  back verbatim to continue the scan; `done` is true once Redis's own SCAN
 *  cursor returns to 0 (end of keyspace, not "page full"). */
export interface RedisScanResult {
  entries: RedisKeyEntry[];
  cursor: number;
  done: boolean;
}

/** Per-database key counts from `redis_keyspace_info` (`INFO keyspace`).
 *  A DB absent from the backend's response is empty — treat it as `0` keys. */
export interface RedisDbInfo {
  dbIndex: number;
  keys: number;
  expires: number;
}

/** A key's value, tagged by `valueType` so the viewer can be picked without
 *  a second round trip. `truncated` (collections only) means the server-side
 *  fetch was capped — more elements exist than were returned. */
export type RedisValueDto =
  | { valueType: 'string'; value: string }
  | { valueType: 'hash'; entries: [string, string][] }
  | { valueType: 'list'; items: string[]; truncated: boolean }
  | { valueType: 'set'; members: string[]; truncated: boolean }
  | { valueType: 'zset'; members: [string, number][]; truncated: boolean };

/** Full detail for one key, as returned by `redis_get_key_detail`. */
export interface RedisKeyDetail {
  key: string;
  keyType: string;
  /** Milliseconds remaining, or `undefined` when the key has no TTL. */
  ttlMs?: number;
  /** `MEMORY USAGE` — `undefined` when the server doesn't support it. */
  memoryBytes?: number;
  /** `OBJECT ENCODING` — `undefined` when the server doesn't support it. */
  encoding?: string;
  value: RedisValueDto;
}
