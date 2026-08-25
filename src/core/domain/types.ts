export type DatabaseEngine =
  | 'postgres'
  | 'cockroachdb'
  | 'yugabytedb'
  | 'mysql'
  | 'mariadb'
  | 'tidb'
  | 'planetscale'
  | 'sqlite'
  | 'duckdb'
  | 'cloudflare-d1'
  | 'mssql'
  | 'redis'
  | 'mongodb';

/** The wire-protocol families the backend actually implements. Every
 *  supported engine maps onto exactly one of these. */
export type EngineFamily = 'postgres' | 'mysql' | 'sqlite' | 'duckdb' | 'mssql';

/** Optional SSH tunnel / jump-server configuration. When set, the backend
 *  opens an SSH tunnel to `sshHost:sshPort` (optionally via a jump/bastion
 *  host) and routes the database connection through `127.0.0.1:<localPort>`. */
export interface SshTunnelConfig {
  sshHost: string;
  sshPort?: number;
  sshUser: string;
  /** Path to a private key file on disk (preferred). Leave empty for password auth. */
  sshKeyPath?: string;
  /** SSH password (used when no key path is given). */
  sshPassword?: string;
  /** Optional bastion / jump host, in `user@host:port` or `host:port` form. */
  jumpHost?: string;
}

export interface DatabaseConnection {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  filePath?: string;
  sslMode?: string;
  colorTag?: string;
  isFavorite?: boolean;
  /** Cloudflare D1: account ID (hex, from the Cloudflare dashboard URL). */
  cfAccountId?: string;
  /** Cloudflare D1: API token with D1 read/write scope. */
  cfApiToken?: string;
  /** Cloudflare D1: database UUID. */
  cfDatabaseId?: string;
  /** Redis logical database index (`SELECT n`, 0-15 by default server config). */
  redisDbIndex?: number;
  /** MongoDB `authSource` (the database a user's credentials are defined in,
   *  when different from the connection's target database). */
  mongoAuthSource?: string;
  /** MongoDB replica set name (`replicaSet` URI option). */
  mongoReplicaSet?: string;
  /** Full MongoDB connection string override — required for `mongodb+srv://`
   *  (Atlas) connections, which have no fixed host/port. When set, takes
   *  precedence over host/port/username/password/database/mongoAuthSource/
   *  mongoReplicaSet and bypasses the SSH tunnel (a `+srv` URI resolves its
   *  own real hosts via DNS). */
  mongoConnectionString?: string;
  /** SSH tunnel / jump-server config (postgres/mysql/mssql/redis/mongodb; not
   *  available for file-based engines or Cloudflare D1). */
  ssh?: SshTunnelConfig;
  /** Environment/group tag id (points to a ConnectionTag). null/undefined = untagged. */
  tagId?: string | null;
  /** Compare & Sync only: when set, limits schema/data comparison and DDL
   *  application to this single database (MySQL/MariaDB, where one connection
   *  can see many databases). Ignored on single-DB engines (postgres, sqlite, d1). */
  scopeDatabase?: string;
  /** Per-connection override for "show system schemas" (pg_catalog /
   *  information_schema on Postgres; mysql/sys/performance_schema on MySQL).
   *  Undefined = inherit the global Settings default. */
  showSystemSchemas?: boolean;
}

/** A reusable environment/group tag shown as a colored badge on connections and
 *  driving the folder grouping in the Explorer sidebar. The four built-in tags
 *  ship out of the box; users can add custom ones with any name + color. */
export interface ConnectionTag {
  id: string;
  label: string;
  color: string;
  /** True for the preset tags — they can be recolored but not deleted. */
  builtin?: boolean;
}

export interface SchemaColumnNode {
  name: string;
  node_type: 'column';
  data_type?: string;
  is_primary_key?: boolean;
  is_foreign_key?: boolean;
  /** Undefined means "unknown" (older backend build) — validation should
   *  only enforce a required field when this is explicitly false. */
  is_nullable?: boolean;
  /** True for columns with a DEFAULT, identity/auto-increment columns, etc. —
   *  the database will fill these in even when NOT NULL, so they aren't
   *  "required" from the user's point of view. */
  has_default?: boolean;
}

export interface SchemaTableNode {
  name: string;
  /** `'collection'` is MongoDB's analogue of a table — see
   *  `commands::mongo::fetch_mongo_schema`. It never has `children`
   *  (documents are schemaless, unlike SQL columns). */
  node_type: 'table' | 'view' | 'collection';
  row_count?: number | null;
  size_bytes?: number | null;
  children: SchemaColumnNode[];
}

export interface SchemaGroupNode {
  name: string;
  node_type: 'database' | 'schema';
  children: SchemaTableNode[];
}

export interface QueryColumn {
  name: string;
  data_type: string;
  is_primary_key?: boolean;
  is_foreign_key?: boolean;
  /** Postgres `CREATE TYPE ... AS ENUM` columns — the type's allowed labels,
   *  so the grid can render a dropdown of real values instead of free text.
   *  Absent/null for every other column and engine. */
  enum_values?: string[] | null;
}

export interface QueryResultData {
  columns: QueryColumn[];
  rows: (string | number | boolean | null)[][];
  execution_time_ms: number;
  affected_rows: number;
  status_message: string;
}

/** One entry in a SQL-editor tab's result set list. A buffer containing multiple
 *  statements (separated by `;`) produces one `QueryResultSet` per statement —
 *  each shown as its own sub-tab in the bottom Result panel. The backend only
 *  ever executes a single statement per call, so the frontend splits and loops. */
export interface QueryResultSet {
  id: string;
  /** The exact statement that produced this result (also used as a refresh key). */
  statement: string;
  status: 'success' | 'error';
  result?: QueryResultData;
  error?: string;
  /** Inferred single-table source when the statement is a simple single-table
   *  SELECT — the result grid becomes editable against this table. `undefined`
   *  for joins, aggregates, CTEs, unions, etc. → the grid renders read-only. */
  editableTable?: { name: string; schema?: string };
}

export interface ErdSchemaContext {
  connectionId: string;
  connectionName: string;
  schemaName: string;
  tables: SchemaTableNode[];
  /** Table to focus on when the diagram opens (Focus Mode root). If omitted,
   *  the diagram falls back to its own default (most-connected table, or an
   *  explicit "Show All" prompt for small schemas). */
  focusTableName?: string;
}

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  /** `sql_editor` tabs only — absolute path this buffer was opened from or
   *  last saved to. When set, the editor's Save button/shortcut writes back
   *  to this path directly instead of prompting a Save As dialog. */
  filePath?: string;
  /** `storage_browser` opens an embedded S3 object browser for a storage
   *  connection (the `connectionId` points at a `S3ConnectionConfig` in
   *  `useStorageStore`, not a DB connection). `redis_browser` opens the Redis
   *  key browser — unlike storage_browser, its `connectionId` points at a
   *  normal `DatabaseConnection` (engine `'redis'`) in `useConnectionStore`.
   *  `mongo_documents` opens the MongoDB document browser for one
   *  database+collection (`schemaName`/`tableName` carry the database name
   *  and collection name respectively — same fields `table_data` uses for
   *  schema/table, reused rather than adding Mongo-specific ones). */
  tabType:
    | 'table_data'
    | 'sql_editor'
    | 'erd'
    | 'users'
    | 'storage_browser'
    | 'redis_browser'
    | 'mongo_documents'
    | 'object_editor';
  tableName?: string;
  /** Schema/database the table lives in. Needed to qualify queries when the
   *  connection was opened without a default database selected. */
  schemaName?: string;
  connectionId?: string;
  /** `redis_browser` only — which of Redis's logical databases (0-15) this
   *  tab is currently browsing. Set/updated by `openRedisBrowserTab`'s
   *  `dbIndex` param (e.g. clicking "DB n" in the Explorer's Databases tree);
   *  `undefined` falls back to the connection's own configured
   *  `redisDbIndex` (or 0). Session-only — never written back to the saved
   *  connection. */
  redisDbIndex?: number;
  isDirty?: boolean;
  result?: QueryResultData;
  /** Per-statement results when the editor buffer holds multiple statements.
   *  `result` mirrors `resultSets[0].result` for single-statement tabs so legacy
   *  consumers keep working. */
  resultSets?: QueryResultSet[];
  executing?: boolean;
  error?: string;
  /** Backend id of the query currently running on this tab (used by Stop). */
  currentQueryId?: string;
  currentPage?: number;
  totalRows?: number;
  erdSchema?: ErdSchemaContext;
  /** `object_editor` tabs only — drives the structured HeidiSQL-style editor
   *  (name field + metadata + body + Save button) for View/Trigger/Procedure/
   *  Event. Lives in a tab, not a modal. */
  objectEditor?: ObjectEditorContext;
}

/** The object kinds the structured object-editor tab manages. */
export type ObjectKind = 'view' | 'trigger' | 'procedure' | 'event';

/** Payload carried by an `object_editor` tab. */
export interface ObjectEditorContext {
  /** Which kind of object this editor manages. */
  kind: ObjectKind;
  /** `create` seeds an empty form (engine-correct defaults); `edit` loads the
   *  existing object's definition into the form on mount. */
  mode: 'create' | 'edit';
  /** Existing object name — required for `edit`, empty for `create`. */
  name?: string;
  /** Schema/database the object belongs to (qualifies the generated DDL). */
  schemaName?: string;
  /** Trigger only — the table the trigger is attached to (needed to fetch/edit
   *  the definition and to scope `DROP TRIGGER ... ON <table>`). */
  tableName?: string;
}

export type ActiveView =
  | 'explorer'
  | 'migration'
  | 'pgMigrate'
  | 'transfer'
  | 'ai'
  | 'health'
  | 'plugins'
  | 'storage';

// ---------------------------------------------------------------------------
// Database Compare & Sync (Tools menu)
// ---------------------------------------------------------------------------

/** Coarse status of a compared object (table or column). */
export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export interface DiffSummary {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
}

export interface ColumnDiff {
  name: string;
  status: DiffStatus;
  dataType?: string;
  sourceDataType?: string;
  targetDataType?: string;
  isNullable?: boolean;
  sourceIsNullable?: boolean;
  targetIsNullable?: boolean;
  isPrimaryKey?: boolean;
  sourceIsPrimaryKey?: boolean;
  targetIsPrimaryKey?: boolean;
  /** Human-readable description of what changed, e.g. "type: int → bigint". */
  changeDescription?: string;
}

/** The kind of schema object a diff entry describes. The comparison engine
 *  only walks tables and views — indexes, foreign keys, triggers and routines
 *  are not part of the schema tree, so they are not diffed. */
export type DiffObjectType = 'table' | 'view';

export interface TableDiff {
  schema?: string;
  name: string;
  /** "table" or "view", carried through from the schema tree. Older backends
   *  may omit it; treat a missing value as "table". */
  objectType?: DiffObjectType;
  status: DiffStatus;
  rowCountSource?: number | null;
  rowCountTarget?: number | null;
  columns: ColumnDiff[];
}

export interface SchemaDiffResult {
  sourceEngine: string;
  targetEngine: string;
  summary: DiffSummary;
  tables: TableDiff[];
}

/** One row that differs between source and target databases. */
export interface RowDifference {
  /** PK tuple joined as a string for display. Null when the table has no PK. */
  key: string | null;
  sourceRow?: (string | number | boolean | null)[];
  targetRow?: (string | number | boolean | null)[];
}

export interface DataDiffResult {
  schema?: string;
  table: string;
  columns: string[];
  hasPrimaryKey: boolean;
  /** Names of the primary-key columns (empty when no PK). */
  pkColumns: string[];
  onlyInSource: RowDifference[];
  onlyInTarget: RowDifference[];
  different: RowDifference[];
  matchedCount: number;
  /** True when the row cap was hit — the diff is partial. */
  truncated: boolean;
}

export type SyncOperation =
  | 'createtable'
  | 'droptable'
  | 'addcolumn'
  | 'dropcolumn'
  | 'altercolumn'
  | 'raw';

export interface SyncStatement {
  operation: SyncOperation;
  description: string;
  /** Fully-qualified target DDL statement. */
  sql: string;
  /** `schema.table` of the affected object, for grouping in the UI. */
  targetObject: string;
}

export interface SyncScript {
  targetEngine: string;
  statements: SyncStatement[];
  /** False when one or more statements can't be applied as-is (e.g. SQLite
   *  can't ALTER a column type in place). The UI must warn before applying. */
  canApply: boolean;
  warnings: string[];
}

export interface ApplyResult {
  applied: number;
  failed: number;
  errors: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Cross-engine database migration wizard (Tools menu)
//
// Supported directions: MySQL/PostgreSQL/SQL Server as a source,
// PostgreSQL/MySQL as a target, source family ≠ target family (same-engine
// sync is Compare & Sync's job). Backed by `commands::migrate` — a
// canonical type/value layer shared by every source/target adapter, so
// these DTOs describe one generic plan/run shape regardless of which two
// engines are actually involved.
// ---------------------------------------------------------------------------

export interface DbMigrateTableRef {
  schema?: string;
  table: string;
}

export interface DbMigrateColumnPlanView {
  name: string;
  nativeType: string;
  targetType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
}

export interface DbMigrateTablePlan {
  schema?: string;
  table: string;
  columns: DbMigrateColumnPlanView[];
  /** User-editable DDL preview — columns only. Always unqualified (no
   *  schema prefix): the target table is created wherever the target
   *  connection already points, mirroring `stripSchemaQualifiers`'s
   *  rationale in `src/core/backup/backupSql.ts`. PK/index/sequence
   *  creation is deferred until after the bulk data load for Postgres
   *  targets (see the backend's module doc for why); MySQL targets declare
   *  them inline since this app doesn't discover secondary indexes to defer
   *  in the first place. */
  createTableSql: string;
  postLoadSql: string[];
  warnings: string[];
  rowCountEstimate?: number | null;
}

export interface DbMigrateTableRunInput {
  schema?: string;
  table: string;
  createTableSql: string;
}

export interface DbMigrateTableRunResult {
  schema?: string;
  table: string;
  rowsMigrated: number;
  warnings: string[];
  error?: string | null;
  durationMs: number;
}

export interface DbMigrateRunSummary {
  tables: DbMigrateTableRunResult[];
  totalRows: number;
  durationMs: number;
  cancelled: boolean;
}

export interface DbMigrateProgress {
  migrationId: string;
  schema?: string;
  table: string;
  rowsDone: number;
  rowsTotal?: number | null;
  phase: 'creating' | 'copying' | 'finalizing' | 'done' | 'error';
}

