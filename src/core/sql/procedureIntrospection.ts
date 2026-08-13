/**
 * Live Stored Procedure introspection — sibling to `triggerIntrospection.ts`,
 * same `execute_query` IPC + engine-dispatch pattern. SQLite has no stored
 * procedures at all, so every function here is a no-op/throw on that family
 * (gated earlier in the UI via `getObjectCapabilities` too — see `objectActions.ts`).
 */

import { DatabaseConnection } from '../domain/types';
import { isPostgresFamily, isMysqlFamily } from '../connection/engines';
import { safeInvoke } from '../tauri/ipc';

type Cell = string | number | boolean | null;
interface QueryPayload {
  columns: { name: string }[];
  rows: Cell[][];
}

const normEngine = (engine: string): string => engine.toLowerCase();
const str = (c: Cell): string => (c === null || c === undefined ? '' : String(c));

interface SchemaFetchArgs {
  config: DatabaseConnection;
  engine: string;
  schema?: string;
}

const resolveSchemaConfig = ({ config, engine, schema }: SchemaFetchArgs): DatabaseConnection => {
  if (isMysqlFamily(engine) && schema && schema !== config.database) {
    return { ...config, database: schema };
  }
  return config;
};

// ───────────────────────── Schema-level list (Explorer "Procedures" folder) ─────────────────────────

export interface ProcedureListItem {
  name: string;
  /** 'FUNCTION' or 'PROCEDURE' (Postgres/MySQL both distinguish). Used by the
   *  UI to label the row; the folder lists both kinds so users see everything
   *  they created — Postgres users in particular almost always create
   *  FUNCTIONs, not PROCEDUREs. */
  type?: string;
}

export async function fetchSchemaProcedures(args: SchemaFetchArgs): Promise<ProcedureListItem[]> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchSchemaProceduresMysql(args, engine);
  if (isPostgresFamily(engine)) return fetchSchemaProceduresPostgres(args);
  return [];
}

async function fetchSchemaProceduresMysql(args: SchemaFetchArgs, engine: string): Promise<ProcedureListItem[]> {
  const schema = args.schema || args.config.database || '';
  // List BOTH functions and procedures — the folder is a "routines" browser so
  // whatever the user created shows up. (Previously filtered to PROCEDURE only,
  // which hid every FUNCTION.)
  const sql = `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES
  WHERE ROUTINE_SCHEMA = '${schema.replace(/'/g, "''")}'
  ORDER BY ROUTINE_TYPE, ROUTINE_NAME;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine }), sql },
    queryId: `proc_list_mysql_${schema}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => ({ name: str(row[0]), type: str(row[1]) || undefined }));
}

async function fetchSchemaProceduresPostgres(args: SchemaFetchArgs): Promise<ProcedureListItem[]> {
  const schema = args.schema || 'public';
  // information_schema.routines covers both FUNCTION and PROCEDURE. Postgres
  // users overwhelmingly create FUNCTIONs, so listing all routines is what
  // makes "what I created" actually visible.
  const sql = `SELECT routine_name, routine_type FROM information_schema.routines
  WHERE routine_schema = '${schema.replace(/'/g, "''")}'
  ORDER BY routine_type, routine_name;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine: 'postgres' }), sql },
    queryId: `proc_list_pg_${schema}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => ({ name: str(row[0]), type: str(row[1]) || undefined }));
}

// ───────────────────────── Single-procedure definition (Edit prefill) ─────────────────────────

export interface ProcedureParam {
  name: string;
  /** IN / OUT / INOUT. Postgres `CREATE PROCEDURE` only accepts IN/INOUT. */
  mode: 'IN' | 'OUT' | 'INOUT';
  type: string;
}

export interface ProcedureDefinition {
  name: string;
  schema?: string;
  params: ProcedureParam[];
  /** The body, verbatim, exactly as it belongs inside the engine's
   *  `CREATE PROCEDURE` statement — callers splice this back in unmodified. */
  body: string;
  /** 'PROCEDURE' or 'FUNCTION' — drives which CREATE/DROP keyword and which
   *  Options-tab fields (Returns, etc.) apply when editing. */
  routineType?: 'PROCEDURE' | 'FUNCTION';
  /** FUNCTION only. */
  returnType?: string;
  /** MySQL only — the raw `'user'@'host'` (or similar) DEFINER value. */
  definer?: string;
  comment?: string;
  sqlSecurity?: 'DEFINER' | 'INVOKER';
  /** MySQL only. */
  deterministic?: boolean;
  /** MySQL only. */
  dataAccess?: string;
}

interface DefinitionFetchArgs extends SchemaFetchArgs {
  name: string;
}

export async function fetchProcedureDefinition(args: DefinitionFetchArgs): Promise<ProcedureDefinition> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchProcedureDefinitionMysql(args, engine);
  if (isPostgresFamily(engine)) return fetchProcedureDefinitionPostgres(args);
  throw new Error(`Stored procedures aren't supported on ${args.engine}.`);
}

function normalizeParamMode(raw: string): ProcedureParam['mode'] {
  const m = raw.toUpperCase();
  return m === 'OUT' || m === 'INOUT' ? m : 'IN';
}

async function fetchProcedureDefinitionMysql(args: DefinitionFetchArgs, engine: string): Promise<ProcedureDefinition> {
  const schema = args.schema || args.config.database || '';
  const escSchema = schema.replace(/'/g, "''");
  const escName = args.name.replace(/'/g, "''");
  const config = resolveSchemaConfig({ ...args, engine });

  // No ROUTINE_TYPE filter here — the folder lists both PROCEDUREs and
  // FUNCTIONs, so Edit needs to load either. A PROCEDURE and a FUNCTION can
  // share a name (different namespaces in MySQL); on that rare collision we
  // take the first row, same best-effort tradeoff the old PROCEDURE-only
  // filter made in the other direction.
  const bodySql = `SELECT ROUTINE_DEFINITION, ROUTINE_TYPE, DEFINER, SQL_DATA_ACCESS, SECURITY_TYPE, ROUTINE_COMMENT, IS_DETERMINISTIC, DTD_IDENTIFIER
  FROM information_schema.ROUTINES
  WHERE ROUTINE_SCHEMA = '${escSchema}' AND ROUTINE_NAME = '${escName}';`;
  const bodyResult = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql: bodySql },
    queryId: `proc_def_mysql_body_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  if (bodyResult.rows.length === 0) throw new Error(`Routine \`${args.name}\` was not found.`);
  const [definition, routineTypeRaw, definer, dataAccess, securityType, comment, isDeterministic, returnType] = bodyResult.rows[0];
  const routineType: 'PROCEDURE' | 'FUNCTION' = str(routineTypeRaw) === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';

  const paramSql = `SELECT PARAMETER_NAME, PARAMETER_MODE, DTD_IDENTIFIER
  FROM information_schema.PARAMETERS
  WHERE SPECIFIC_SCHEMA = '${escSchema}' AND SPECIFIC_NAME = '${escName}' AND ROUTINE_TYPE = '${routineType}'
  ORDER BY ORDINAL_POSITION;`;
  const paramResult = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql: paramSql },
    queryId: `proc_def_mysql_params_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });

  return {
    name: args.name,
    schema,
    routineType,
    returnType: str(returnType) || undefined,
    definer: str(definer) || undefined,
    comment: str(comment) || undefined,
    sqlSecurity: str(securityType) === 'INVOKER' ? 'INVOKER' : 'DEFINER',
    deterministic: str(isDeterministic) === 'YES',
    dataAccess: str(dataAccess) || undefined,
    params: paramResult.rows
      .filter((row) => str(row[0])) // MySQL includes a NULL-named row for the return value on FUNCTIONs — not relevant here, but stay defensive
      .map((row) => ({ name: str(row[0]), mode: normalizeParamMode(str(row[1])), type: str(row[2]) })),
    body: str(definition),
  };
}

async function fetchProcedureDefinitionPostgres(args: DefinitionFetchArgs): Promise<ProcedureDefinition> {
  const schema = args.schema || 'public';
  const escSchema = schema.replace(/'/g, "''");
  const escName = args.name.replace(/'/g, "''");
  const config = resolveSchemaConfig({ ...args, engine: 'postgres' });

  const paramSql = `SELECT p.parameter_name, p.parameter_mode, p.data_type
  FROM information_schema.routines r
  JOIN information_schema.parameters p
    ON p.specific_schema = r.specific_schema AND p.specific_name = r.specific_name
  WHERE r.routine_schema = '${escSchema}' AND r.routine_name = '${escName}'
  ORDER BY p.ordinal_position;`;
  const paramResult = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql: paramSql },
    queryId: `proc_def_pg_params_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });

  // information_schema.routines.routine_definition is unreliable for plpgsql
  // across versions — pg_get_functiondef(oid) is the authoritative source for
  // BOTH functions and procedures (same approach as the trigger function body
  // fetch). No prokind filter: match by name so a FUNCTION loads just like a
  // PROCEDURE. prosecdef/obj_description/prokind/pg_get_function_result ride
  // along in the same query since they're all keyed off the same pg_proc row.
  const bodySql = `SELECT pg_get_functiondef(p.oid), p.prosecdef, obj_description(p.oid, 'pg_proc'), p.prokind, pg_get_function_result(p.oid)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = '${escSchema}' AND p.proname = '${escName}';`;
  const bodyResult = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql: bodySql },
    queryId: `proc_def_pg_body_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const [defRaw, prosecdef, comment, prokind, returnType] = bodyResult.rows[0] || [];
  const functionDef = str(defRaw);
  if (!functionDef) throw new Error(`Routine "${args.name}" was not found.`);

  return {
    name: args.name,
    schema,
    routineType: prokind === 'p' ? 'PROCEDURE' : 'FUNCTION',
    returnType: str(returnType) || undefined,
    comment: str(comment) || undefined,
    sqlSecurity: prosecdef === true || prosecdef === 'true' || prosecdef === 't' ? 'DEFINER' : 'INVOKER',
    params: paramResult.rows.map((row) => ({ name: str(row[0]), mode: normalizeParamMode(str(row[1])), type: str(row[2]) })),
    body: extractDollarQuotedBody(functionDef) ?? functionDef,
  };
}

/** Same best-effort dollar-quote extraction as `triggerIntrospection.ts` —
 *  duplicated rather than imported to keep each introspection module
 *  independently readable (matches this codebase's existing per-file style,
 *  e.g. `resolveConfig` is likewise re-declared per file, not shared). */
function extractDollarQuotedBody(def: string): string | null {
  const asIdx = def.search(/\bAS\b/i);
  if (asIdx === -1) return null;
  const rest = def.slice(asIdx + 2).trimStart();
  if (!rest.startsWith('$')) return null;
  const tagEnd = rest.indexOf('$', 1);
  if (tagEnd === -1) return null;
  const tag = rest.slice(0, tagEnd + 1);
  const afterTag = rest.slice(tag.length);
  const closeIdx = afterTag.indexOf(tag);
  if (closeIdx === -1) return null;
  return afterTag.slice(0, closeIdx).trim();
}
