/**
 * Live scheduled-Event introspection. Two unrelated engines share this file
 * because they're the app's only two "Event" sources:
 *
 *  - MySQL/MariaDB: the native Event Scheduler (`information_schema.EVENTS`,
 *    `CREATE/ALTER/DROP EVENT`) — schema-scoped, always available.
 *  - Postgres: no built-in scheduler. `pg_cron`'s `cron.job` table is the
 *    closest equivalent, *if the extension is installed* — jobs are global to
 *    the database (not schema-scoped), and the extension may simply not be
 *    there. Callers must handle the `PGCRON_NOT_INSTALLED` sentinel error
 *    (thrown instead of a generic query failure) to show a clear "not
 *    installed" state rather than a scary red error banner.
 *
 * SQLite/D1 have no scheduler concept — not handled here at all (gated in the
 * UI before this module is ever called).
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

/** Thrown by the Postgres path when `cron.job` doesn't exist — i.e. pg_cron
 *  isn't installed on this server. Distinct from a real query failure. */
export const PGCRON_NOT_INSTALLED = 'PGCRON_NOT_INSTALLED';

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

// ───────────────────────── Schema-level list (Explorer "Events" folder) ─────────────────────────

export interface EventListItem {
  name: string;
}

export async function fetchSchemaEvents(args: SchemaFetchArgs): Promise<EventListItem[]> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchSchemaEventsMysql(args, engine);
  if (isPostgresFamily(engine)) return fetchSchemaEventsPostgres(args);
  return [];
}

async function fetchSchemaEventsMysql(args: SchemaFetchArgs, engine: string): Promise<EventListItem[]> {
  const schema = args.schema || args.config.database || '';
  const sql = `SELECT EVENT_NAME FROM information_schema.EVENTS
  WHERE EVENT_SCHEMA = '${schema.replace(/'/g, "''")}'
  ORDER BY EVENT_NAME;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine }), sql },
    queryId: `evt_list_mysql_${schema}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => ({ name: str(row[0]) }));
}

/** pg_cron jobs are global to the database, not per-schema — every schema
 *  group on a Postgres connection shows the same job list. Minor redundancy,
 *  accepted for simplicity (most Postgres connections only browse 1-2 schemas). */
async function fetchSchemaEventsPostgres(args: SchemaFetchArgs): Promise<EventListItem[]> {
  const sql = `SELECT jobname FROM cron.job ORDER BY jobname;`;
  try {
    const result = await safeInvoke<QueryPayload>('execute_query', {
      request: { config: resolveSchemaConfig({ ...args, engine: 'postgres' }), sql },
      queryId: `evt_list_pg_${Date.now()}`,
      __meta: { source: 'introspection' },
    });
    return result.rows.map((row) => ({ name: str(row[0]) }));
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/relation .*cron\.job.* does not exist/i.test(msg) || /schema "cron" does not exist/i.test(msg)) {
      throw new Error(PGCRON_NOT_INSTALLED);
    }
    throw err;
  }
}

// ───────────────────────── Single-event definition (Edit prefill) ─────────────────────────

export interface EventDefinition {
  name: string;
  schema?: string;
  /** MySQL only. */
  scheduleType?: 'ONE TIME' | 'RECURRING';
  /** MySQL RECURRING: numeric interval value, e.g. `1` in "EVERY 1 DAY". */
  intervalValue?: string;
  /** MySQL RECURRING: unit, e.g. DAY/HOUR/MINUTE. */
  intervalField?: string;
  /** MySQL ONE TIME: the `AT` timestamp. */
  executeAt?: string;
  starts?: string;
  ends?: string;
  onCompletionPreserve?: boolean;
  status?: 'ENABLED' | 'DISABLED';
  /** Postgres/pg_cron only: standard 5-field cron expression. */
  cronSchedule?: string;
  /** The body — MySQL: the `DO` clause statement(s). Postgres: the `command`
   *  pg_cron runs, verbatim. */
  body: string;
}

interface DefinitionFetchArgs extends SchemaFetchArgs {
  name: string;
}

export async function fetchEventDefinition(args: DefinitionFetchArgs): Promise<EventDefinition> {
  const engine = normEngine(args.engine);
  if (isMysqlFamily(engine)) return fetchEventDefinitionMysql(args, engine);
  if (isPostgresFamily(engine)) return fetchEventDefinitionPostgres(args);
  throw new Error(`Events aren't supported on ${args.engine}.`);
}

async function fetchEventDefinitionMysql(args: DefinitionFetchArgs, engine: string): Promise<EventDefinition> {
  const schema = args.schema || args.config.database || '';
  const sql = `SELECT EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD, STARTS, ENDS, STATUS, ON_COMPLETION, EVENT_DEFINITION
  FROM information_schema.EVENTS
  WHERE EVENT_SCHEMA = '${schema.replace(/'/g, "''")}' AND EVENT_NAME = '${args.name.replace(/'/g, "''")}';`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config: resolveSchemaConfig({ ...args, engine }), sql },
    queryId: `evt_def_mysql_${args.name}_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  const row = result.rows[0];
  if (!row) throw new Error(`Event \`${args.name}\` was not found.`);
  return {
    name: args.name,
    schema,
    scheduleType: str(row[0]) === 'ONE TIME' ? 'ONE TIME' : 'RECURRING',
    executeAt: str(row[1]) || undefined,
    intervalValue: str(row[2]) || undefined,
    intervalField: str(row[3]) || undefined,
    starts: str(row[4]) || undefined,
    ends: str(row[5]) || undefined,
    status: str(row[6]) === 'DISABLED' ? 'DISABLED' : 'ENABLED',
    onCompletionPreserve: str(row[7]) === 'PRESERVE',
    body: str(row[8]),
  };
}

async function fetchEventDefinitionPostgres(args: DefinitionFetchArgs): Promise<EventDefinition> {
  const sql = `SELECT schedule, command, active FROM cron.job WHERE jobname = '${args.name.replace(/'/g, "''")}';`;
  let result: QueryPayload;
  try {
    result = await safeInvoke<QueryPayload>('execute_query', {
      request: { config: resolveSchemaConfig({ ...args, engine: 'postgres' }), sql },
      queryId: `evt_def_pg_${args.name}_${Date.now()}`,
      __meta: { source: 'introspection' },
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/relation .*cron\.job.* does not exist/i.test(msg)) throw new Error(PGCRON_NOT_INSTALLED);
    throw err;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`Event "${args.name}" was not found.`);
  return {
    name: args.name,
    cronSchedule: str(row[0]),
    body: str(row[1]),
    status: row[2] ? 'ENABLED' : 'DISABLED',
  };
}
