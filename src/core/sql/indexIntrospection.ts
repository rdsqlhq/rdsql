/**
 * Live introspection + DDL builders for table indexes and foreign keys.
 *
 * The Structure modal and the DataGrid header both need to know which columns
 * are indexed / part of a foreign key. `SchemaColumnNode` carries PK/FK flags
 * (best-effort), but has no notion of secondary indexes or real FK targets, so
 * both UIs query the live database here.
 *
 * Each `fetch*` helper runs engine-specific SQL through `execute_query` and
 * normalizes the rows into a stable shape. The DDL builders mirror the style
 * of `tableActions.ts` — pure functions returning a SQL string (or `null` when
 * the engine doesn't support the operation).
 */

import { DatabaseConnection } from '../domain/types';
import { isPostgresFamily, isMysqlFamily, isSqliteFamily } from '../connection/engines';
import { safeInvoke } from '../tauri/ipc';
import { quoteIdent, qualifiedTable } from './ident';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  /** Index method when known (BTREE / HASH / GIN …). */
  method?: string;
}

export interface ForeignKeyInfo {
  constraintName: string;
  column: string;
  referencedSchema?: string;
  referencedTable: string;
  referencedColumn: string;
  onUpdate?: string;
  onDelete?: string;
}

/** Row value as returned by `execute_query` — a primitive or null. */
type Cell = string | number | boolean | null;

interface QueryPayload {
  columns: { name: string }[];
  rows: Cell[][];
}

interface FetchArgs {
  config: DatabaseConnection;
  engine: string;
  schema?: string;
  table: string;
}

const normEngine = (engine: string): string => engine.toLowerCase();

/** Stringify a cell defensively — numeric/boolean booleans become text. */
const str = (c: Cell): string => (c === null || c === undefined ? '' : String(c));

const truthy = (c: Cell): boolean => {
  if (c === null || c === undefined) return false;
  if (typeof c === 'boolean') return c;
  const s = String(c).toLowerCase();
  return s === '1' || s === 'true' || s === 't' || s === 'yes';
};

/** Resolve the connection config that should actually run the introspection
 *  query — MySQL groups are databases, so override `config.database` to reach
 *  tables in a non-default DB. Postgres groups are schemas (no override). */
const resolveConfig = ({ config, engine, schema }: FetchArgs): DatabaseConnection => {
  if (isMysqlFamily(engine) && schema && schema !== config.database) {
    return { ...config, database: schema };
  }
  return config;
};

// ─── Fetch indexes ──────────────────────────────────────────────────────────

/**
 * Fetch the indexes for a table. Returns an empty array on engines we don't
 * introspect (the UI shows a "not available" note). Throws on query errors so
 * the caller can surface a banner.
 */
export async function fetchTableIndexes(args: FetchArgs): Promise<IndexInfo[]> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchMysqlIndexes(args, engine);
  if (isPostgresFamily(engine)) return fetchPostgresIndexes(args);
  if (isSqliteFamily(engine)) return fetchSqliteIndexes(args, engine);
  return [];
}

/** SHOW INDEX FROM <table> → grouped by Key_name (Seq_in_index orders columns). */
async function fetchMysqlIndexes(args: FetchArgs, engine: string): Promise<IndexInfo[]> {
  const sql = `SHOW INDEX FROM ${qualifiedTable(engine, args.table, args.schema)};`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine }), sql },
    queryId: `idx_mysql_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const colIdx = indexByLower(result.columns.map((c) => c.name));
  const map = new Map<string, IndexInfo>();
  for (const row of result.rows) {
    const keyName = str(row[colIdx.get('key_name') ?? 1]);
    const columnName = str(row[colIdx.get('column_name') ?? 4]);
    const nonUnique = truthy(row[colIdx.get('non_unique') ?? 1]);
    const indexType = str(row[colIdx.get('index_type') ?? 6]);
    const isPrimary = keyName === 'PRIMARY';
    const entry =
      map.get(keyName) ??
      ({ name: keyName, columns: [], isUnique: !nonUnique, isPrimary, method: indexType || 'BTREE' } as IndexInfo);
    entry.columns.push(columnName);
    map.set(keyName, entry);
  }
  return [...map.values()];
}

/**
 * Postgres: `pg_indexes` gives the definition (CREATE INDEX …). We parse the
 * column list out of the definition — that's what psql itself does, and the
 * canonical `pg_index` join is verbose and engine-version-sensitive.
 */
async function fetchPostgresIndexes(args: FetchArgs): Promise<IndexInfo[]> {
  const schema = args.schema || 'public';
  const sql = `SELECT schemaname, indexname, indexdef FROM pg_indexes WHERE schemaname = '${schema.replace(/'/g, "''")}' AND tablename = '${args.table.replace(/'/g, "''")}';`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine: 'postgres' }), sql },
    queryId: `idx_pg_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => {
    const def = str(row[2]);
    // indexdef looks like:
    //   CREATE UNIQUE INDEX foo_idx ON public.tbl USING btree (a, b)
    const isUnique = /CREATE UNIQUE INDEX/i.test(def);
    const isPrimary = /is_primary_key|_pkey$/i.test(str(row[1])) || /PRIMARY KEY/i.test(def);
    const methodMatch = /USING\s+(\w+)/i.exec(def);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'BTREE';
    const colsMatch = /\(([^)]+)\)(?:\s+WHERE|$)/i.exec(def);
    const columns = colsMatch
      ? colsMatch[1].split(',').map((c) => c.trim().replace(/^["]|["]$/g, ''))
      : [];
    return { name: str(row[1]), columns, isUnique, isPrimary, method };
  });
}

/** SQLite/D1: PRAGMA index_list + index_info for each index. */
async function fetchSqliteIndexes(args: FetchArgs, engine: string): Promise<IndexInfo[]> {
  const config = resolveConfig({ ...args, engine });
  const listSql = `PRAGMA index_list(${quoteIdent('sqlite', args.table)});`;
  const list = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql: listSql },
    queryId: `idx_sqlite_list_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const out: IndexInfo[] = [];
  for (const row of list.rows) {
    const name = str(row[1]);
    const isUnique = truthy(row[2]);
    // 4th column (origin) === 'pk' means the index backs a PRIMARY KEY constraint.
    const origin = str(row[3]).toLowerCase();
    const isPrimary = origin === 'pk';
    const info = await safeInvoke<QueryPayload>('execute_query', {
      request: { config, sql: `PRAGMA index_info(${quoteIdent('sqlite', name)});` },
      queryId: `idx_sqlite_info_${name}_${Date.now()}`,
      __meta: { source: 'introspection' },
    });
    const columns = info.rows.map((r) => str(r[2]));
    out.push({ name, columns, isUnique, isPrimary, method: undefined });
  }
  return out;
}

// ─── Fetch foreign keys ─────────────────────────────────────────────────────

export async function fetchTableForeignKeys(args: FetchArgs): Promise<ForeignKeyInfo[]> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchMysqlForeignKeys(args, engine);
  if (isPostgresFamily(engine)) return fetchPostgresForeignKeys(args);
  if (isSqliteFamily(engine)) return fetchSqliteForeignKeys(args, engine);
  return [];
}

/**
 * MySQL: the INFORMATION_SCHEMA.KEY_COLUMN_USAGE join with
 * REFERENTIAL_CONSTRAINTS gives us both the column mapping and the referential
 * actions in a single round-trip.
 */
async function fetchMysqlForeignKeys(args: FetchArgs, engine: string): Promise<ForeignKeyInfo[]> {
  const schema = args.schema || args.config.database || '';
  const sql = `SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
       kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
       rc.UPDATE_RULE, rc.DELETE_RULE
  FROM information_schema.KEY_COLUMN_USAGE kcu
  LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
   AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
  WHERE kcu.TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
    AND kcu.TABLE_NAME = '${args.table.replace(/'/g, "''")}'
    AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
  ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine }), sql },
    queryId: `fk_mysql_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const colIdx = indexByLower(result.columns.map((c) => c.name));
  // Multiple rows per constraint when a composite FK is involved — merge.
  const map = new Map<string, ForeignKeyInfo>();
  for (const row of result.rows) {
    const cname = str(row[colIdx.get('constraint_name') ?? 0]);
    const column = str(row[colIdx.get('column_name') ?? 1]);
    const entry =
      map.get(cname) ??
      ({
        constraintName: cname,
        column,
        referencedSchema: str(row[colIdx.get('referenced_table_schema') ?? 2]) || undefined,
        referencedTable: str(row[colIdx.get('referenced_table_name') ?? 3]),
        referencedColumn: str(row[colIdx.get('referenced_column_name') ?? 4]),
        onUpdate: str(row[colIdx.get('update_rule') ?? 5]) || undefined,
        onDelete: str(row[colIdx.get('delete_rule') ?? 6]) || undefined,
      } as ForeignKeyInfo);
    // For composite FKs the first column is the representative one.
    if (!entry.column) entry.column = column;
    map.set(cname, entry);
  }
  return [...map.values()];
}

/**
 * Postgres: `pg_constraint` (contype = 'f') + `pg_get_constraintdef` to parse
 * the referenced table/column and the ON UPDATE / ON DELETE actions.
 */
async function fetchPostgresForeignKeys(args: FetchArgs): Promise<ForeignKeyInfo[]> {
  const schema = args.schema || 'public';
  const sql = `SELECT con.conname, pg_get_constraintdef(con.oid)
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
  WHERE nsp.nspname = '${schema.replace(/'/g, "''")}'
    AND cls.relname = '${args.table.replace(/'/g, "''")}'
    AND con.contype = 'f'
  ORDER BY con.conname;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine: 'postgres' }), sql },
    queryId: `fk_pg_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => {
    const constraintName = str(row[0]);
    const def = str(row[1]);
    // def shape: FOREIGN KEY (col) REFERENCES ref_tbl(ref_col) [ON DELETE …] [ON UPDATE …]
    const localMatch = /FOREIGN KEY\s*\(([^)]+)\)/i.exec(def);
    const refMatch = /REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i.exec(def);
    const onDeleteMatch = /ON DELETE\s+(\w+(?:\s+\w+)?)/i.exec(def);
    const onUpdateMatch = /ON UPDATE\s+(\w+(?:\s+\w+)?)/i.exec(def);
    const column = localMatch ? localMatch[1].split(',')[0].trim().replace(/^["]|["]$/g, '') : '';
    let refTable = refMatch ? refMatch[1].replace(/^["]|["]$/g, '') : '';
    let refSchema: string | undefined;
    if (refTable.includes('.')) {
      const [s, t] = refTable.split('.');
      refSchema = s.replace(/^["]|["]$/g, '');
      refTable = t.replace(/^["]|["]$/g, '');
    }
    const refCol = refMatch ? refMatch[2].split(',')[0].trim().replace(/^["]|["]$/g, '') : '';
    return {
      constraintName,
      column,
      referencedSchema: refSchema,
      referencedTable: refTable,
      referencedColumn: refCol,
      onUpdate: onUpdateMatch ? onUpdateMatch[1].toUpperCase() : undefined,
      onDelete: onDeleteMatch ? onDeleteMatch[1].toUpperCase() : undefined,
    };
  });
}

/** SQLite/D1: PRAGMA foreign_key_list — returns one row per FK column. */
async function fetchSqliteForeignKeys(args: FetchArgs, engine: string): Promise<ForeignKeyInfo[]> {
  const config = resolveConfig({ ...args, engine });
  const sql = `PRAGMA foreign_key_list(${quoteIdent('sqlite', args.table)});`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql },
    queryId: `fk_sqlite_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  // Columns: id, seq, table, from, to, on_update, on_delete, match
  return result.rows.map((row) => ({
    constraintName: `fk_${args.table}_${str(row[3])}`,
    column: str(row[3]),
    referencedTable: str(row[2]),
    referencedColumn: str(row[4]) || 'id',
    onUpdate: str(row[5]).toUpperCase() || undefined,
    onDelete: str(row[6]).toUpperCase() || undefined,
  }));
}

// ─── DDL builders ───────────────────────────────────────────────────────────

export interface CreateIndexInput {
  engine: string;
  schema?: string;
  table: string;
  /** Index name. Empty → let the DB auto-generate. */
  name?: string;
  columns: string[];
  isUnique?: boolean;
  method?: string;
}

export function createIndexSql(input: CreateIndexInput): string {
  const { engine, schema, table, name, columns, isUnique, method } = input;
  if (!columns.length) return '';
  const e = normEngine(engine);
  const tbl = qualifiedTable(e, table, schema);
  const colList = columns.map((c) => quoteIdent(e, c)).join(', ');
  const namePart = name?.trim() ? quoteIdent(e, name.trim()) : '';
  const unique = isUnique ? 'UNIQUE ' : '';
  // SQLite doesn't support USING; Postgres/MySQL accept it but MySQL calls
  // it `USING BTREE`/`USING HASH` inline. Emit it only when provided.
  const using = method ? ` USING ${method.toUpperCase()}` : '';
  const nameClause = namePart ? `${namePart} ` : '';
  if (isSqliteFamily(e)) {
    return `CREATE ${unique}INDEX ${nameClause}ON ${tbl} (${colList});`;
  }
  return `CREATE ${unique}INDEX ${nameClause}ON ${tbl}${using} (${colList});`;
}

export function dropIndexSql(
  engine: string,
  schema: string | undefined,
  table: string,
  indexName: string
): string {
  const e = normEngine(engine);
  const ident = quoteIdent(e, indexName);
  // MySQL/MariaDB require `DROP INDEX <name> ON <table>` — the index name is
  // only unique within a table, not within the database.
  if (isMysqlFamily(e)) {
    return `DROP INDEX ${ident} ON ${qualifiedTable(e, table, schema)};`;
  }
  if (isPostgresFamily(e)) {
    return schema ? `DROP INDEX ${quoteIdent(e, schema)}.${ident};` : `DROP INDEX ${ident};`;
  }
  // SQLite / D1 — index names are global within the database file.
  return `DROP INDEX IF EXISTS ${ident};`;
}

export interface AddForeignKeyInput {
  engine: string;
  schema?: string;
  table: string;
  constraintName?: string;
  column: string;
  referencedSchema?: string;
  referencedTable: string;
  referencedColumn: string;
  onUpdate?: string;
  onDelete?: string;
}

export function addForeignKeySql(input: AddForeignKeyInput): string {
  const { engine, schema, table, constraintName, column, referencedSchema, referencedTable, referencedColumn, onUpdate, onDelete } = input;
  const e = normEngine(engine);
  const tbl = qualifiedTable(e, table, schema);
  const refTbl = referencedSchema
    ? qualifiedTable(e, referencedTable, referencedSchema)
    : quoteIdent(e, referencedTable);
  const name = constraintName?.trim() ? `CONSTRAINT ${quoteIdent(e, constraintName.trim())} ` : '';
  const actions: string[] = [];
  if (onUpdate && onUpdate.toUpperCase() !== 'NO ACTION') actions.push(`ON UPDATE ${onUpdate.toUpperCase()}`);
  if (onDelete && onDelete.toUpperCase() !== 'NO ACTION') actions.push(`ON DELETE ${onDelete.toUpperCase()}`);
  return `ALTER TABLE ${tbl} ADD ${name}FOREIGN KEY (${quoteIdent(e, column)}) REFERENCES ${refTbl}(${quoteIdent(e, referencedColumn)})${actions.length ? ' ' + actions.join(' ') : ''};`;
}

export function dropForeignKeySql(engine: string, schema: string | undefined, table: string, constraintName: string): string {
  const e = normEngine(engine);
  const tbl = qualifiedTable(e, table, schema);
  return `ALTER TABLE ${tbl} DROP CONSTRAINT ${quoteIdent(e, constraintName)};`;
}

// ─── Column comment builders ────────────────────────────────────────────────

/**
 * MySQL stores comments on the column itself via `MODIFY COLUMN` (the full type
 * must be re-stated). Postgres uses `COMMENT ON COLUMN`. SQLite/D1 have no
 * native column comments → returns null so the UI can disable the field.
 */
export function setColumnCommentSql(
  engine: string,
  schema: string | undefined,
  table: string,
  column: string,
  comment: string,
  currentType: string
): string | null {
  const e = normEngine(engine);
  if (isMysqlFamily(e)) {
    const escaped = comment.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `ALTER TABLE ${qualifiedTable(e, table, schema)} MODIFY COLUMN ${quoteIdent(e, column)} ${currentType} COMMENT '${escaped}';`;
  }
  if (isPostgresFamily(e)) {
    const qualifiedCol = `${qualifiedTable(e, table, schema)}.${quoteIdent(e, column)}`;
    const escaped = comment.replace(/'/g, "''");
    return `COMMENT ON COLUMN ${qualifiedCol} IS '${escaped}';`;
  }
  return null;
}

/** Whether the engine supports native column comments. */
export function supportsColumnComment(engine: string): boolean {
  const e = normEngine(engine);
  return isMysqlFamily(e) || isPostgresFamily(e);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function indexByLower(names: string[]): Map<string, number> {
  const m = new Map<string, number>();
  names.forEach((n, i) => m.set(n.toLowerCase(), i));
  return m;
}
