/**
 * Live trigger introspection for a single table — sibling to
 * `indexIntrospection.ts`, same `execute_query` IPC + engine-dispatch pattern.
 * Used by the ERD table detail drawer's "Triggers" tab.
 */

import { DatabaseConnection } from '../domain/types';
import { isPostgresFamily, isMysqlFamily, isSqliteFamily } from '../connection/engines';
import { safeInvoke } from '../tauri/ipc';

export interface TriggerInfo {
  name: string;
  /** BEFORE / AFTER / INSTEAD OF */
  timing?: string;
  /** INSERT / UPDATE / DELETE — joined with " OR " when a trigger fires on more than one. */
  events: string[];
  /** ROW / STATEMENT, when known. */
  level?: string;
  /** The trigger body / action statement, when the engine exposes it. */
  statement?: string;
}

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
const str = (c: Cell): string => (c === null || c === undefined ? '' : String(c));

/** Mirrors `resolveConfig` in indexIntrospection.ts — MySQL groups are
 *  databases, so override `config.database` to reach non-default DBs. */
const resolveConfig = ({ config, engine, schema }: FetchArgs): DatabaseConnection => {
  if (isMysqlFamily(engine) && schema && schema !== config.database) {
    return { ...config, database: schema };
  }
  return config;
};

/**
 * Fetch the triggers defined on a table. Returns an empty array on engines we
 * don't introspect. Throws on query errors so the caller can surface a banner.
 */
export async function fetchTableTriggers(args: FetchArgs): Promise<TriggerInfo[]> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchMysqlTriggers(args, engine);
  if (isPostgresFamily(engine)) return fetchPostgresTriggers(args);
  if (isSqliteFamily(engine)) return fetchSqliteTriggers(args, engine);
  return [];
}

function indexByLower(names: string[]): Map<string, number> {
  const m = new Map<string, number>();
  names.forEach((n, i) => m.set(n.toLowerCase(), i));
  return m;
}

/**
 * Postgres: `information_schema.triggers` emits one row per event for
 * multi-event triggers (e.g. `AFTER INSERT OR UPDATE`) — merge rows sharing a
 * name into a single entry with a combined event list.
 */
async function fetchPostgresTriggers(args: FetchArgs): Promise<TriggerInfo[]> {
  const schema = args.schema || 'public';
  const sql = `SELECT trigger_name, action_timing, event_manipulation, action_orientation, action_statement
  FROM information_schema.triggers
  WHERE event_object_schema = '${schema.replace(/'/g, "''")}'
    AND event_object_table = '${args.table.replace(/'/g, "''")}'
  ORDER BY trigger_name;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine: 'postgres' }), sql },
    queryId: `trg_pg_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const colIdx = indexByLower(result.columns.map((c) => c.name));
  const map = new Map<string, TriggerInfo>();
  for (const row of result.rows) {
    const name = str(row[colIdx.get('trigger_name') ?? 0]);
    const timing = str(row[colIdx.get('action_timing') ?? 1]);
    const event = str(row[colIdx.get('event_manipulation') ?? 2]);
    const level = str(row[colIdx.get('action_orientation') ?? 3]);
    const statement = str(row[colIdx.get('action_statement') ?? 4]);
    const entry = map.get(name) ?? { name, timing, events: [], level, statement };
    if (event && !entry.events.includes(event)) entry.events.push(event);
    map.set(name, entry);
  }
  return [...map.values()];
}

/** MySQL: `information_schema.TRIGGERS` — one row per trigger (single event each). */
async function fetchMysqlTriggers(args: FetchArgs, engine: string): Promise<TriggerInfo[]> {
  const schema = args.schema || args.config.database || '';
  const sql = `SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORIENTATION, ACTION_STATEMENT
  FROM information_schema.TRIGGERS
  WHERE TRIGGER_SCHEMA = '${schema.replace(/'/g, "''")}'
    AND EVENT_OBJECT_TABLE = '${args.table.replace(/'/g, "''")}'
  ORDER BY TRIGGER_NAME;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveConfig({ ...args, engine }), sql },
    queryId: `trg_mysql_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const colIdx = indexByLower(result.columns.map((c) => c.name));
  return result.rows.map((row) => ({
    name: str(row[colIdx.get('trigger_name') ?? 0]),
    timing: str(row[colIdx.get('action_timing') ?? 1]) || undefined,
    events: [str(row[colIdx.get('event_manipulation') ?? 2])].filter(Boolean),
    level: str(row[colIdx.get('action_orientation') ?? 3]) || undefined,
    statement: str(row[colIdx.get('action_statement') ?? 4]) || undefined,
  }));
}

/** SQLite/D1: `sqlite_master` stores the whole `CREATE TRIGGER ...` statement —
 *  parse timing/event out of it, same best-effort regex approach as the
 *  Postgres index-definition parser in indexIntrospection.ts. */
async function fetchSqliteTriggers(args: FetchArgs, engine: string): Promise<TriggerInfo[]> {
  const config = resolveConfig({ ...args, engine });
  const sql = `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '${args.table.replace(/'/g, "''")}';`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql },
    queryId: `trg_sqlite_${args.table}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => {
    const name = str(row[0]);
    const def = str(row[1]);
    const timingMatch = /\b(BEFORE|AFTER|INSTEAD\s+OF)\b/i.exec(def);
    const eventMatch = /\b(INSERT|UPDATE|DELETE)\b/gi.exec(def);
    const events = eventMatch ? [eventMatch[1].toUpperCase()] : [];
    return {
      name,
      timing: timingMatch ? timingMatch[1].toUpperCase().replace(/\s+/g, ' ') : undefined,
      events,
      statement: def || undefined,
    };
  });
}

// ───────────────────────── Schema-level list (Explorer "Triggers" folder) ─────────────────────────

export interface TriggerListItem {
  name: string;
  /** Table the trigger is defined on — needed to build `DROP TRIGGER ... ON <table>`
   *  (MySQL/SQLite) and to disambiguate same-named triggers on different tables
   *  (Postgres trigger names are only unique per-table, not per-schema). */
  table: string;
}

interface SchemaFetchArgs {
  config: DatabaseConnection;
  engine: string;
  schema?: string;
}

/** List every trigger in a schema/database, across all its tables — used to
 *  populate the Explorer's "Triggers" tree folder. Unlike `fetchTableTriggers`
 *  this has no `table` filter. */
export async function fetchSchemaTriggers(args: SchemaFetchArgs): Promise<TriggerListItem[]> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchSchemaTriggersMysql(args, engine);
  if (isPostgresFamily(engine)) return fetchSchemaTriggersPostgres(args);
  if (isSqliteFamily(engine)) return fetchSchemaTriggersSqlite(args, engine);
  return [];
}

const resolveSchemaConfig = ({ config, engine, schema }: SchemaFetchArgs): DatabaseConnection => {
  if (isMysqlFamily(engine) && schema && schema !== config.database) {
    return { ...config, database: schema };
  }
  return config;
};

async function fetchSchemaTriggersPostgres(args: SchemaFetchArgs): Promise<TriggerListItem[]> {
  const schema = args.schema || 'public';
  // Query pg_trigger directly rather than information_schema.triggers, which is
  // unreliable/empty on some Postgres versions. `NOT tgisinternal` drops the
  // system-generated triggers that constraints (FK/PK) create under the hood.
  const sql = `SELECT t.tgname, c.relname AS table_name
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = '${schema.replace(/'/g, "''")}' AND NOT t.tgisinternal
  ORDER BY t.tgname;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine: 'postgres' }), sql },
    queryId: `trg_list_pg_${schema}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => ({ name: str(row[0]), table: str(row[1]) }));
}

async function fetchSchemaTriggersMysql(args: SchemaFetchArgs, engine: string): Promise<TriggerListItem[]> {
  const schema = args.schema || args.config.database || '';
  const sql = `SELECT DISTINCT TRIGGER_NAME, EVENT_OBJECT_TABLE
  FROM information_schema.TRIGGERS
  WHERE TRIGGER_SCHEMA = '${schema.replace(/'/g, "''")}'
  ORDER BY TRIGGER_NAME;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine }), sql },
    queryId: `trg_list_mysql_${schema}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => ({ name: str(row[0]), table: str(row[1]) }));
}

async function fetchSchemaTriggersSqlite(args: SchemaFetchArgs, engine: string): Promise<TriggerListItem[]> {
  const config = resolveSchemaConfig({ ...args, engine });
  const sql = `SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql },
    queryId: `trg_list_sqlite_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => ({ name: str(row[0]), table: str(row[1]) }));
}

// ───────────────────────── Single-trigger definition (Edit prefill) ─────────────────────────

export interface TriggerDefinition {
  name: string;
  schema?: string;
  table: string;
  /** BEFORE / AFTER / INSTEAD OF */
  timing: string;
  /** INSERT / UPDATE / DELETE */
  events: string[];
  /** ROW / STATEMENT — MySQL/SQLite triggers are always ROW-level. */
  level?: string;
  /** The action body, verbatim, exactly as it belongs inside the engine's
   *  `CREATE TRIGGER`/`CREATE FUNCTION` statement (see `triggerActions.ts` —
   *  callers splice this back in unmodified, so it round-trips safely). */
  body: string;
  /** Postgres only: the function the trigger calls (`EXECUTE FUNCTION <name>()`). */
  functionName?: string;
}

interface DefinitionFetchArgs extends SchemaFetchArgs {
  name: string;
  /** Table the trigger belongs to. Required on Postgres (trigger names are
   *  only unique per-table) and used to scope the MySQL/SQLite lookups too. */
  table: string;
}

/** Fetch full details for one existing trigger, to prefill the Edit designer.
 *  Throws (query error, or "not found") so the caller can surface a banner. */
export async function fetchTriggerDefinition(args: DefinitionFetchArgs): Promise<TriggerDefinition> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchTriggerDefinitionMysql(args, engine);
  if (isPostgresFamily(engine)) return fetchTriggerDefinitionPostgres(args);
  if (isSqliteFamily(engine)) return fetchTriggerDefinitionSqlite(args, engine);
  throw new Error(`Trigger editing isn't supported on ${args.engine}.`);
}

async function fetchTriggerDefinitionMysql(args: DefinitionFetchArgs, engine: string): Promise<TriggerDefinition> {
  const schema = args.schema || args.config.database || '';
  const sql = `SELECT ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT
  FROM information_schema.TRIGGERS
  WHERE TRIGGER_SCHEMA = '${schema.replace(/'/g, "''")}'
    AND TRIGGER_NAME = '${args.name.replace(/'/g, "''")}';`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine }), sql },
    queryId: `trg_def_mysql_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const row = result.rows[0];
  if (!row) throw new Error(`Trigger \`${args.name}\` was not found.`);
  return {
    name: args.name,
    schema,
    table: str(row[2]) || args.table,
    timing: str(row[0]),
    events: [str(row[1])].filter(Boolean),
    level: 'ROW',
    body: str(row[3]),
  };
}

async function fetchTriggerDefinitionSqlite(args: DefinitionFetchArgs, engine: string): Promise<TriggerDefinition> {
  const config = resolveSchemaConfig({ ...args, engine });
  const sql = `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = '${args.name.replace(/'/g, "''")}';`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql },
    queryId: `trg_def_sqlite_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const def = str(result.rows[0]?.[0]);
  if (!def) throw new Error(`Trigger "${args.name}" was not found.`);
  const timingMatch = /\b(BEFORE|AFTER|INSTEAD\s+OF)\b/i.exec(def);
  const eventMatch = /\b(INSERT|UPDATE|DELETE)\b/i.exec(def);
  // Body is everything after the FOR EACH ROW / WHEN clause up to (and
  // including) the trailing statement — best-effort, same regex-parsing
  // convention as `fetchSqliteTriggers` above. Falls back to the full
  // `CREATE TRIGGER ...` text (still valid to inspect, though re-saving it
  // verbatim would double the header) if the shape doesn't match.
  const bodyMatch = /\bBEGIN\b([\s\S]*)\bEND\b\s*;?\s*$/i.exec(def);
  return {
    name: args.name,
    table: args.table,
    timing: timingMatch ? timingMatch[1].toUpperCase().replace(/\s+/g, ' ') : 'AFTER',
    events: eventMatch ? [eventMatch[1].toUpperCase()] : [],
    body: bodyMatch ? bodyMatch[1].trim() : def,
  };
}

/** Best-effort extraction of the body between a Postgres dollar-quoted string
 *  (`$$ ... $$` or `$tag$ ... $tag$`) in a `pg_get_functiondef()` result.
 *  Returns `null` if the shape doesn't match (caller falls back to the raw text). */
function extractDollarQuotedBody(def: string): string | null {
  const asIdx = def.search(/\bAS\b/i);
  if (asIdx === -1) return null;
  const rest = def.slice(asIdx + 2).trimStart();
  if (!rest.startsWith('$')) return null;
  const tagEnd = rest.indexOf('$', 1);
  if (tagEnd === -1) return null;
  const tag = rest.slice(0, tagEnd + 1); // e.g. "$$" or "$function$"
  const afterTag = rest.slice(tag.length);
  const closeIdx = afterTag.indexOf(tag);
  if (closeIdx === -1) return null;
  return afterTag.slice(0, closeIdx).trim();
}

async function fetchTriggerDefinitionPostgres(args: DefinitionFetchArgs): Promise<TriggerDefinition> {
  const schema = args.schema || 'public';
  const escName = args.name.replace(/'/g, "''");
  const escSchema = schema.replace(/'/g, "''");
  const escTable = args.table.replace(/'/g, "''");

  const metaSql = `SELECT trigger_name, action_timing, event_manipulation, action_orientation
  FROM information_schema.triggers
  WHERE trigger_schema = '${escSchema}' AND trigger_name = '${escName}' AND event_object_table = '${escTable}';`;
  const metaResult = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine: 'postgres' }), sql: metaSql },
    queryId: `trg_def_pg_meta_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  if (metaResult.rows.length === 0) throw new Error(`Trigger "${args.name}" was not found.`);
  const events = [...new Set(metaResult.rows.map((r) => str(r[2])).filter(Boolean))];
  const [, timing, , level] = metaResult.rows[0].map(str);

  // information_schema.triggers doesn't expose the trigger's function body —
  // only pg_catalog does, via the function's OID.
  const fnSql = `SELECT p.proname, pg_get_functiondef(p.oid)
  FROM pg_trigger tg
  JOIN pg_class c ON c.oid = tg.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = tg.tgfoid
  WHERE n.nspname = '${escSchema}' AND tg.tgname = '${escName}' AND c.relname = '${escTable}' AND NOT tg.tgisinternal;`;
  const fnResult = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine: 'postgres' }), sql: fnSql },
    queryId: `trg_def_pg_fn_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const fnRow = fnResult.rows[0];
  const functionName = fnRow ? str(fnRow[0]) : undefined;
  const functionDef = fnRow ? str(fnRow[1]) : '';
  const body = functionDef ? extractDollarQuotedBody(functionDef) ?? functionDef : '';

  return { name: args.name, schema, table: args.table, timing, events, level, body, functionName };
}
