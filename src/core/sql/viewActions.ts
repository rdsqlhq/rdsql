/**
 * Engine-aware View SQL generators + live definition fetch.
 *
 * Mirrors `tableActions.ts` (SQL builders, pure/unit-testable) plus the
 * `execute_query`-via-`safeInvoke` introspection idiom used by
 * `triggerIntrospection.ts` / `indexIntrospection.ts` (definition fetch, hits
 * the live connection). All identifiers are quoted via `quoteIdent`/
 * `qualifiedTable` — no SQL is built from raw user input elsewhere.
 */
import { DatabaseConnection } from '../domain/types';
import { qualifiedTable } from './ident';
import { isMysqlFamily, isPostgresFamily, isSqliteFamily } from '../connection/engines';
import { safeInvoke } from '../tauri/ipc';

// ───────────────────────── Capabilities ─────────────────────────

/** True if the engine supports `CREATE OR REPLACE VIEW` (edit-in-place).
 *  SQLite has no `OR REPLACE` for views — callers must DROP + CREATE instead. */
export function supportsReplaceView(engine: string): boolean {
  return !isSqliteFamily(engine);
}

// ───────────────────────── SQL builders ─────────────────────────

export interface ViewDef {
  name: string;
  schema?: string;
  /** The `SELECT ...` body (without the `CREATE VIEW ... AS` prefix). */
  selectSql: string;
}

function viewBody(def: ViewDef): string {
  return def.selectSql.trim().replace(/;+\s*$/, '');
}

/** `CREATE VIEW <name> AS <select>;` */
export function createViewSql(engine: string, def: ViewDef): string {
  const tbl = qualifiedTable(engine, def.name, def.schema);
  return `CREATE VIEW ${tbl} AS\n${viewBody(def)};`;
}

/** Edit-in-place SQL: `CREATE OR REPLACE VIEW` where supported, else `null`
 *  (caller should DROP + CREATE instead — see `supportsReplaceView`). */
export function replaceViewSql(engine: string, def: ViewDef): string | null {
  if (!supportsReplaceView(engine)) return null;
  const tbl = qualifiedTable(engine, def.name, def.schema);
  return `CREATE OR REPLACE VIEW ${tbl} AS\n${viewBody(def)};`;
}

/** `DROP VIEW [IF EXISTS] <name>;` */
export function dropViewSql(engine: string, name: string, schema?: string): string {
  return `DROP VIEW IF EXISTS ${qualifiedTable(engine, name, schema)};`;
}

// ───────────────────────── Live definition fetch (for Edit prefill) ─────────────────────────

type Cell = string | number | boolean | null;
interface QueryPayload {
  columns: { name: string }[];
  rows: Cell[][];
}

interface FetchArgs {
  config: DatabaseConnection;
  engine: string;
  schema?: string;
  view: string;
}

const str = (c: Cell): string => (c === null || c === undefined ? '' : String(c));

/** Mirrors `resolveConfig` in triggerIntrospection.ts / indexIntrospection.ts —
 *  MySQL groups are databases, so override `config.database` to reach non-default DBs. */
function resolveConfig({ config, engine, schema }: FetchArgs): DatabaseConnection {
  if (isMysqlFamily(engine) && schema && schema !== config.database) {
    return { ...config, database: schema };
  }
  return config;
}

/** Fetch the current `SELECT` body of an existing view, for populating the
 *  Edit designer. Throws on query errors so the caller can surface a banner. */
export async function fetchViewDefinition(args: FetchArgs): Promise<string> {
  const engine = args.engine.toLowerCase();
  if (isMysqlFamily(engine)) return fetchMysqlViewDefinition(args);
  if (isPostgresFamily(engine)) return fetchPostgresViewDefinition(args);
  if (isSqliteFamily(engine)) return fetchSqliteViewDefinition(args);
  return '';
}

async function fetchMysqlViewDefinition(args: FetchArgs): Promise<string> {
  const schema = args.schema || args.config.database || '';
  const sql = `SELECT VIEW_DEFINITION FROM information_schema.VIEWS
  WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
    AND TABLE_NAME = '${args.view.replace(/'/g, "''")}';`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine: 'mysql' }), sql },
    queryId: `view_def_mysql_${args.view}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return str(result.rows[0]?.[0]);
}

async function fetchPostgresViewDefinition(args: FetchArgs): Promise<string> {
  const schema = args.schema || 'public';
  // pg_get_viewdef returns a full, already-formatted `SELECT ...;` body —
  // information_schema.views.view_definition strips the trailing semicolon
  // inconsistently across versions, so prefer the catalog function.
  const sql = `SELECT pg_get_viewdef(c.oid, true)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = '${schema.replace(/'/g, "''")}'
    AND c.relname = '${args.view.replace(/'/g, "''")}'
    AND c.relkind = 'v';`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine: 'postgres' }), sql },
    queryId: `view_def_pg_${args.view}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return str(result.rows[0]?.[0]).replace(/;\s*$/, '');
}

async function fetchSqliteViewDefinition(args: FetchArgs): Promise<string> {
  const sql = `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = '${args.view.replace(/'/g, "''")}';`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine: 'sqlite' }), sql },
    queryId: `view_def_sqlite_${args.view}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const full = str(result.rows[0]?.[0]);
  // Strip the `CREATE VIEW <name> AS` prefix so the modal shows just the SELECT,
  // same shape as the MySQL/Postgres paths. Best-effort — falls back to the
  // full text (still valid to re-save verbatim) if the prefix doesn't match.
  const match = /^\s*CREATE\s+VIEW\s+.*?\bAS\b/is.exec(full);
  return match ? full.slice(match[0].length).trim() : full;
}
