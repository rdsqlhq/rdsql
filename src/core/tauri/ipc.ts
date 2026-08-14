import { invoke } from '@tauri-apps/api/core';
import { useQueryLogStore } from '../../store/useQueryStore';
import type { QuerySource } from '../../store/useQueryStore';

/** True when running inside the actual Tauri app (vs. a plain browser, e.g.
 *  `make dev-web`). Shared so every "is a native API even reachable here"
 *  check stays consistent instead of re-implementing the same window check. */
export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Optional metadata callers can attach to an invocation so the IPC-layer
 *  logger classifies the query accurately. When omitted, the query is logged
 *  as `source: 'system'` (filtered out unless "Show system" is on). */
export interface ExecuteQueryMeta {
  /** Origin of the query for log classification. */
  source?: QuerySource;
  /** When true, skip logging this query entirely. Defaults to false. */
  skipLog?: boolean;
}

/** A connection config as it appears inside command args. */
interface ConnConfig {
  id?: string;
  engine?: string;
  database?: string;
  name?: string;
}

/** The args shape for `execute_query`: `{ request: { config, sql }, queryId }`,
 *  optionally extended with our private `__meta` for log classification. */
interface ExecuteQueryArgs {
  request?: { config?: ConnConfig; sql?: string };
  queryId?: string;
  __meta?: ExecuteQueryMeta;
}

/** The args shape for `fetch_schema_tree` and similar introspection commands:
 *  `{ config }`. */
interface ConfigArgs {
  config?: ConnConfig;
  __meta?: ExecuteQueryMeta;
}

/** Human-readable SQL representations for the non-SQL introspection commands
 *  that still hit the database (information_schema queries, etc.). These are
 *  shown in the query log instead of a bare label so users can see the real
 *  query shape. `labelFor` reads the command args (e.g. the connection config)
 *  to produce a query that reflects the engine/database being introspected. */

/** The canonical introspection query each engine runs. Kept short but faithful
 *  — the backend builds the real string server-side; this is the representative
 *  form surfaced in the log. */
const SCHEMA_TREE_QUERIES: Record<string, string> = {
  postgres: `-- Fetch schema tree (PostgreSQL)
SELECT t.table_schema, t.table_name, t.table_type,
       pg_total_relation_size(...) AS size_bytes,
       c_est.reltuples::bigint AS row_count,
       col.column_name, col.data_type, pk.column_name IS NOT NULL AS is_pk,
       col.is_nullable, col.column_default, col.is_identity
FROM information_schema.tables t
LEFT JOIN pg_class c_est ON ...
JOIN information_schema.columns col ON ...
LEFT JOIN (... PRIMARY KEY ...) pk ON ...
WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY t.table_schema, t.table_name, col.ordinal_position;
-- + SELECT COUNT(*) FROM <schema>.<table> for tables with reltuples = 0`,
  mysql: `-- Fetch schema tree (MySQL)
SELECT s.SCHEMA_NAME FROM information_schema.SCHEMATA s
WHERE s.SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys');
SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH, ...
FROM information_schema.TABLES;
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_KEY, ...
FROM information_schema.COLUMNS;`,
  sqlite: `-- Fetch schema tree (SQLite)
SELECT name, type FROM sqlite_master
WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%';
PRAGMA table_info("<table>");
SELECT COUNT(*) FROM "<table>";`,
  mssql: `-- Fetch schema tree (SQL Server)
SELECT name FROM sys.databases
WHERE state = 0 AND name NOT IN ('master','tempdb','model','msdb');
USE [<database>];
SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.DATA_TYPE, ...
FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t ON ...;
-- + PK (INFORMATION_SCHEMA.TABLE_CONSTRAINTS/KEY_COLUMN_USAGE),
--   identity (sys.identity_columns), row/size stats (sys.dm_db_partition_stats)`,
};

/** Redis commands worth surfacing in the log — a representative command
 *  string built from the args, mirroring what `SCHEMA_TREE_QUERIES` does for
 *  SQL introspection. Deliberately excludes `redis_get_key_detail` (fires on
 *  every key-list selection, too noisy) — only mutations and the SCAN itself. */
function redisLabelFor(command: string, args: Record<string, unknown> | undefined): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const key = typeof a.key === 'string' ? JSON.stringify(a.key) : undefined;
  switch (command) {
    case 'redis_scan_keys': {
      const pattern = typeof a.pattern === 'string' ? a.pattern : '*';
      return `SCAN ${a.cursor ?? 0} MATCH ${pattern}`;
    }
    case 'redis_set_string_value':
      return key ? `SET ${key} ...` : null;
    case 'redis_set_hash_field':
      return key && typeof a.field === 'string' ? `HSET ${key} ${JSON.stringify(a.field)} ...` : null;
    case 'redis_delete_hash_field':
      return key && typeof a.field === 'string' ? `HDEL ${key} ${JSON.stringify(a.field)}` : null;
    case 'redis_delete_key':
      return key ? `DEL ${key}` : null;
    case 'redis_set_ttl':
      return key ? (a.ttlSeconds ? `EXPIRE ${key} ${a.ttlSeconds}` : `PERSIST ${key}`) : null;
    case 'redis_list_push':
      return key ? `${a.left ? 'LPUSH' : 'RPUSH'} ${key} ...` : null;
    case 'redis_set_add':
      return key ? `SADD ${key} ...` : null;
    case 'redis_zset_add':
      return key ? `ZADD ${key} ${a.score ?? 0} ...` : null;
    default:
      return null;
  }
}

/** Build the log SQL text for an introspection command, reading args to tailor
 *  it to the engine/database in play. Falls back to a generic label for unknown
 *  engines/commands. */
function labelFor(command: string, args: Record<string, unknown> | undefined): string | null {
  if (command === 'fetch_schema_tree') {
    const cfg = (args ?? {}) as ConfigArgs;
    const engine = (cfg.config?.engine || 'postgres').toLowerCase();
    const db = cfg.config?.database;
    const base = SCHEMA_TREE_QUERIES[engine] || SCHEMA_TREE_QUERIES.postgres;
    return db ? base.replace(/^-- Fetch schema tree \((.+)\)$/, `-- Fetch schema tree ($1) — ${db}`) : base;
  }
  if (command.startsWith('redis_')) {
    return redisLabelFor(command, args);
  }
  return null;
}

function pushLog(
  sql: string,
  cfg: ConnConfig | undefined,
  durationMs: number,
  status: 'success' | 'error',
  source: QuerySource,
  errorMessage?: string,
  rowCount?: number
) {
  if (!sql.trim()) return;
  useQueryLogStore.getState().addLog({
    sql,
    database: cfg?.database || cfg?.name,
    engine: cfg?.engine,
    connectionId: cfg?.id,
    durationMs,
    rowsAffected: rowCount ?? 0,
    status,
    errorMessage,
    source,
  });
}

/** Decide whether + how to log a command. Returns void — logging is fire-and-
 *  forget and never affects the caller's flow. */
function logCommand(
  command: string,
  args: Record<string, unknown> | undefined,
  durationMs: number,
  status: 'success' | 'error',
  errorMessage?: string,
  rowCount?: number
) {
  const meta = (args as { __meta?: ExecuteQueryMeta } | undefined)?.__meta;
  if (meta?.skipLog) return;
  const source: QuerySource = meta?.source ?? 'system';

  if (command === 'execute_query') {
    const a = (args ?? {}) as ExecuteQueryArgs;
    const sql = a.request?.sql;
    if (sql) pushLog(sql, a.request?.config, durationMs, status, source, errorMessage, rowCount);
    return;
  }

  // Non-SQL introspection commands that still run queries on the server.
  const label = labelFor(command, args);
  if (label) {
    const cfg = (args ?? {}) as ConfigArgs;
    pushLog(label, cfg.config, durationMs, status, source, errorMessage, rowCount);
  }
}

/** Commands whose results are idempotent per-connection (schema introspection).
 *  Concurrent calls for the same connection are coalesced into a single IPC
 *  round-trip — this is what stops the startup storm of duplicate
 *  `fetch_schema_tree` calls (Explorer effect + SQLEditor effect + StrictMode
 *  double-fire all racing before any cache is warm). */
const DEDUPLICATED_COMMANDS = new Set(['fetch_schema_tree']);

/** In-flight promise cache keyed by `${command}::${connId}`. The first caller
 *  fires the real IPC; everyone else awaits the same promise. Cleared on both
 *  success and failure so a later, genuine re-fetch always goes through. */
const inFlight = new Map<string, Promise<unknown>>();

function dedupeKey(command: string, args: Record<string, unknown> | undefined): string | null {
  if (!DEDUPLICATED_COMMANDS.has(command)) return null;
  const a = (args ?? {}) as { config?: { id?: string; name?: string; database?: string }; request?: { config?: { id?: string; name?: string; database?: string } } };
  const cfg = a.config ?? a.request?.config;
  if (!cfg) return null;
  const connId = cfg.id || cfg.name || cfg.database || 'default';
  return `${command}::${connId}`;
}

export async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Coalesce concurrent introspection calls for the same connection so N
  // components firing `fetch_schema_tree` at startup share one round-trip.
  const key = dedupeKey(command, args);
  if (key) {
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = doInvoke<T>(command, args).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }
  return doInvoke<T>(command, args);
}

async function doInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const startedAt = Date.now();
  // Peel off our private `__meta` (log classification) so it's never forwarded
  // to the Tauri command — only used by the logger below.
  const { __meta, ...invokeArgs } = (args ?? {}) as Record<string, unknown>;
  try {
    if (inTauri()) {
      const result = await invoke<T>(command, invokeArgs);
      // Single interception point: log EVERY database-hitting command so the
      // SQL log captures all queries (COUNT, pagination, ANALYZE, GRANT,
      // schema introspection, etc.) regardless of which component fired them.
      logCommand(command, args, Date.now() - startedAt, 'success', undefined, extractRowCount(result));
      return result;
    }
  } catch (err: any) {
    logCommand(command, args, Date.now() - startedAt, 'error', err?.message || String(err));
    console.warn(`[Tauri IPC Error on '${command}']`, err);
    throw new Error(err?.message || String(err));
  }

  // Graceful fallback ONLY for non-Tauri browser preview environments
  return fallbackInvoke<T>(command, invokeArgs);
}

/** Best-effort row count extraction from an execute_query result. */
function extractRowCount(result: unknown): number | undefined {
  if (result && typeof result === 'object') {
    const r = result as { rows?: unknown[]; affected_rows?: number };
    if (typeof r.affected_rows === 'number') return r.affected_rows;
    if (Array.isArray(r.rows)) return r.rows.length;
  }
  return undefined;
}

function fallbackInvoke<T>(command: string, args?: Record<string, unknown>): T {
  console.log(`[Dev Browser Simulation] Command '${command}' called with:`, args);
  switch (command) {
    case 'test_connection':
      return {
        success: true,
        message: 'Successfully validated connection (Browser Preview mode)',
        latency_ms: 8,
        server_version: 'rdSQL Native Dev Server v1.0',
      } as unknown as T;
    case 'fetch_schema_tree':
      return [] as unknown as T;
    case 'execute_query':
      return {
        columns: [
          { name: 'status', data_type: 'TEXT' },
          { name: 'info', data_type: 'TEXT' },
        ],
        rows: [
          ['OK', 'Native Tauri Desktop execution active. Add a real connection to query your database.'],
        ],
        execution_time_ms: 2,
        affected_rows: 1,
        status_message: 'Executed in browser simulation',
      } as unknown as T;
    case 'get_database_overview':
      return {
        engine: 'browser',
        connectionStatus: 'Connected (preview)',
        latencyMs: 4,
        sizeBytes: 0,
        schemaCount: 0,
        tableCount: 0,
        viewCount: 0,
        indexCount: 0,
        sequenceCount: 0,
        constraintCount: 0,
      } as unknown as T;
    case 'get_database_statistics':
      return {
        sizeBytes: 0,
        tableCount: 0,
        indexCount: 0,
        schemaCount: 0,
      } as unknown as T;
    case 'run_diagnostics':
      return [] as unknown as T;
    case 'get_activity':
      return { supported: false } as unknown as T;
    case 'get_index_statistics':
    case 'get_table_statistics':
      return [] as unknown as T;
    case 'get_table_auto_increment':
      return null as unknown as T;
    case 'compare_schema':
      return {
        sourceEngine: 'postgres',
        targetEngine: 'postgres',
        summary: { added: 0, removed: 0, modified: 0, unchanged: 0 },
        tables: [],
      } as unknown as T;
    case 'compare_table_data':
      return {
        table: '',
        columns: [],
        hasPrimaryKey: true,
        pkColumns: [],
        onlyInSource: [],
        onlyInTarget: [],
        different: [],
        matchedCount: 0,
        truncated: false,
      } as unknown as T;
    case 'generate_schema_sync_sql':
      return {
        targetEngine: 'postgres',
        statements: [],
        canApply: true,
        warnings: [],
      } as unknown as T;
    case 'apply_schema_sync':
      return { applied: 0, failed: 0, errors: [], durationMs: 0 } as unknown as T;
    // ── S3 storage (browser-preview mocks). Real S3 requires the Tauri runtime;
    //    these keep the UI navigable in pure-browser dev without credentials.
    case 's3_test_connection':
      return { success: true, message: 'Storage reachable (preview)', latencyMs: 4 } as unknown as T;
    case 's3_list_objects':
      return { objects: [], prefixes: [], isTruncated: false } as unknown as T;
    case 's3_head_object':
      return null as unknown as T;
    case 's3_presign_get':
      return 'https://example.com/presigned-preview-url' as unknown as T;
    case 's3_get_object_bytes':
      return { contentBase64: '', contentType: 'text/plain', size: 0, truncated: false } as unknown as T;
    case 's3_get_object_acl':
      return { owner: { id: 'owner-id' }, grants: [] } as unknown as T;
    case 's3_put_object_acl':
      return true as unknown as T;
    case 's3_upload_object':
      return { key: '', size: 0, etag: '' } as unknown as T;
    case 's3_download_object':
      return { size: 0 } as unknown as T;
    case 's3_delete_object':
    case 's3_delete_objects':
      return { deleted: 0 } as unknown as T;
    case 's3_copy_object':
      return { key: '' } as unknown as T;
    case 's3_create_prefix':
    case 's3_abort_multipart':
    case 's3_cancel_transfer':
      return { success: true } as unknown as T;
    case 's3_gzip_compress':
    case 's3_gzip_decompress':
      return { size: 0 } as unknown as T;
    // ── Redis (browser-preview mocks) — a few example keys of each type so
    //    the key browser UI is navigable without a real Redis server.
    case 'redis_test_connection':
      return { success: true, message: 'Connected to Redis at 127.0.0.1:6379 (preview).', latencyMs: 3 } as unknown as T;
    case 'redis_scan_keys':
      return {
        entries: [
          { key: 'session:abc123', keyType: 'string', ttlMs: 3600_000 },
          { key: 'user:42', keyType: 'hash', ttlMs: undefined },
          { key: 'user:42:roles', keyType: 'set', ttlMs: undefined },
          { key: 'leaderboard:global', keyType: 'zset', ttlMs: undefined },
        ],
        cursor: 0,
        done: true,
      } as unknown as T;
    case 'redis_keyspace_info':
      return [
        { dbIndex: 0, keys: 4, expires: 1 },
        { dbIndex: 1, keys: 0, expires: 0 },
      ] as unknown as T;
    case 'redis_get_key_detail': {
      const key = (args?.key as string) || '';
      if (key.endsWith(':roles')) {
        return { key, keyType: 'set', ttlMs: undefined, memoryBytes: 96, encoding: 'listpack', value: { valueType: 'set', members: ['admin', 'editor'], truncated: false } } as unknown as T;
      }
      if (key.startsWith('leaderboard')) {
        return { key, keyType: 'zset', ttlMs: undefined, memoryBytes: 128, encoding: 'listpack', value: { valueType: 'zset', members: [['alice', 980], ['bob', 750]], truncated: false } } as unknown as T;
      }
      if (key.startsWith('user:')) {
        return { key, keyType: 'hash', ttlMs: undefined, memoryBytes: 112, encoding: 'listpack', value: { valueType: 'hash', entries: [['name', 'Ada'], ['plan', 'pro']] } } as unknown as T;
      }
      return { key, keyType: 'string', ttlMs: 3600_000, memoryBytes: 56, encoding: 'embstr', value: { valueType: 'string', value: 'preview-value' } } as unknown as T;
    }
    case 'redis_set_string_value':
    case 'redis_set_hash_field':
    case 'redis_delete_hash_field':
    case 'redis_delete_key':
    case 'redis_set_ttl':
    case 'redis_list_push':
    case 'redis_set_add':
    case 'redis_zset_add':
      return undefined as unknown as T;
    // ── MongoDB (browser-preview mocks) — one seeded database/collection so
    //    the document browser UI is navigable without a real Mongo server.
    case 'mongo_test_connection':
      return { success: true, message: 'Connected to MongoDB (preview).', latencyMs: 4 } as unknown as T;
    case 'mongo_list_databases':
      return [{ name: 'rdsql_preview', sizeOnDisk: 40960, empty: false }] as unknown as T;
    case 'mongo_list_collections':
      return [{ name: 'widgets', docCount: 2, isView: false }] as unknown as T;
    case 'mongo_count_documents':
      return 2 as unknown as T;
    case 'mongo_find_documents':
    case 'mongo_run_aggregation':
      return {
        documents: [
          { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'Widget A', qty: 5 },
          { _id: { $oid: '507f1f77bcf86cd799439012' }, name: 'Widget B', qty: 12 },
        ],
        hasMore: false,
      } as unknown as T;
    case 'mongo_get_document':
      return { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'Widget A', qty: 5 } as unknown as T;
    case 'mongo_insert_document':
      return { $oid: '507f1f77bcf86cd799439099' } as unknown as T;
    case 'mongo_update_document':
    case 'mongo_delete_document':
    case 'mongo_create_collection':
    case 'mongo_drop_collection':
    case 'mongo_drop_database':
    case 'mongo_drop_index':
      return undefined as unknown as T;
    case 'mongo_delete_documents':
      return 0 as unknown as T;
    case 'mongo_list_indexes':
      return [{ name: '_id_', keys: { _id: 1 }, unique: false, sparse: false }] as unknown as T;
    case 'mongo_create_index':
      return 'field_1' as unknown as T;
    case 'mongo_infer_schema':
      return {
        sampled: 2,
        fields: [
          { name: '_id', types: [{ bsonType: 'objectId', count: 2, percentage: 100 }] },
          { name: 'name', types: [{ bsonType: 'string', count: 2, percentage: 100 }] },
          { name: 'qty', types: [{ bsonType: 'int', count: 2, percentage: 100 }] },
        ],
      } as unknown as T;
    case 'mongo_collection_stats':
      return { count: 2, size: 256, avgObjSize: 128, storageSize: 4096, totalIndexSize: 4096, indexCount: 1 } as unknown as T;
    case 'mongo_database_stats':
      return { collections: 1, views: 0, objects: 2, dataSize: 256, storageSize: 4096, indexes: 1, indexSize: 4096 } as unknown as T;
    default:
      return { success: true } as unknown as T;
  }
}
