/**
 * Engine-aware Trigger SQL generators. Mirrors `tableActions.ts`/`viewActions.ts`
 * (pure functions, no SQL executed here). Definitions come from
 * `triggerIntrospection.ts` (list + fetch); this module only builds statements.
 *
 * Postgres triggers always call a separate FUNCTION — there's no "just the
 * trigger" DDL the way MySQL/SQLite have it, so create/replace here always
 * returns an array of statements (`[functionSql, triggerSql]` on Postgres,
 * `[triggerSql]` elsewhere). Callers execute them in order.
 */
import { quoteIdent, qualifiedTable } from './ident';
import { isMysqlFamily, isPostgresFamily } from '../connection/engines';

export interface TriggerDef {
  name: string;
  schema?: string;
  table: string;
  /** BEFORE / AFTER / INSTEAD OF (INSTEAD OF only valid on views). */
  timing: string;
  /** INSERT / UPDATE / DELETE. MySQL/SQLite only support one event per trigger;
   *  Postgres allows `OR`-combining more than one. */
  events: string[];
  /** ROW / STATEMENT — ignored on MySQL/SQLite (always row-level). */
  level?: string;
  /** The action body, verbatim — see `TriggerDefinition.body` for the exact
   *  shape expected per engine (inner `CREATE FUNCTION` body on Postgres, the
   *  action statement(s) on MySQL/SQLite). */
  body: string;
  /** Postgres only: name for the backing function. Defaults to `<table>_<name>_fn`. */
  functionName?: string;
}

/** Default deterministic Postgres function name, so Drop can find and offer to
 *  remove the paired function without guessing. */
export function defaultTriggerFunctionName(def: Pick<TriggerDef, 'table' | 'name'>): string {
  return `${def.table}_${def.name}_fn`;
}

/** `CREATE TRIGGER` (+ paired `CREATE OR REPLACE FUNCTION` on Postgres). One
 *  statement per array entry — execute in order. */
export function createTriggerSql(engine: string, def: TriggerDef): string[] {
  if (isPostgresFamily(engine)) return createPostgresTriggerSql(engine, def);
  if (isMysqlFamily(engine)) return [createMysqlTriggerSql(engine, def)];
  return [createSqliteTriggerSql(engine, def)];
}

/** Edit-in-place: MySQL/SQLite have no `CREATE OR REPLACE TRIGGER`, so this is
 *  always DROP + CREATE (+ `CREATE OR REPLACE FUNCTION` first on Postgres,
 *  which *does* support replacing the function safely). */
export function replaceTriggerSql(engine: string, def: TriggerDef): string[] {
  const drop = dropTriggerSql(engine, def.name, def.table, def.schema);
  return [...drop, ...createTriggerSql(engine, def)];
}

/** `DROP TRIGGER`, engine-appropriate shape. `dropFunction` (Postgres only)
 *  also drops the paired function — surfaced as an opt-in checkbox in the UI
 *  so a shared/reused function is never removed silently. */
export function dropTriggerSql(
  engine: string,
  name: string,
  table: string,
  schema?: string,
  dropFunction?: { functionName: string }
): string[] {
  if (isPostgresFamily(engine)) {
    const stmts = [`DROP TRIGGER IF EXISTS ${quoteIdent(engine, name)} ON ${qualifiedTable(engine, table, schema)};`];
    if (dropFunction) {
      const fnRef = schema
        ? `${quoteIdent(engine, schema)}.${quoteIdent(engine, dropFunction.functionName)}`
        : quoteIdent(engine, dropFunction.functionName);
      stmts.push(`DROP FUNCTION IF EXISTS ${fnRef}();`);
    }
    return stmts;
  }
  if (isMysqlFamily(engine)) {
    // MySQL trigger names live in the schema/database namespace, not qualified
    // by table — `schema.trigger`, never `schema.table.trigger`.
    const ref = schema ? `${quoteIdent(engine, schema)}.${quoteIdent(engine, name)}` : quoteIdent(engine, name);
    return [`DROP TRIGGER IF EXISTS ${ref};`];
  }
  // SQLite: same schema-qualified-by-name rule as MySQL (no ON <table> clause).
  return [`DROP TRIGGER IF EXISTS ${quoteIdent(engine, name)};`];
}

function eventsClause(events: string[]): string {
  return events.filter(Boolean).join(' OR ') || 'INSERT';
}

function createPostgresTriggerSql(engine: string, def: TriggerDef): string[] {
  const fnName = def.functionName || defaultTriggerFunctionName(def);
  const fnRef = def.schema ? `${quoteIdent(engine, def.schema)}.${quoteIdent(engine, fnName)}` : quoteIdent(engine, fnName);
  const body = def.body.trim() || 'BEGIN\n  RETURN NEW;\nEND;';
  const fnSql = `CREATE OR REPLACE FUNCTION ${fnRef}()
RETURNS TRIGGER AS $$
${body}
$$ LANGUAGE plpgsql;`;

  const level = def.level === 'STATEMENT' ? 'STATEMENT' : 'ROW';
  const triggerSql = `CREATE TRIGGER ${quoteIdent(engine, def.name)}
${def.timing} ${eventsClause(def.events)} ON ${qualifiedTable(engine, def.table, def.schema)}
FOR EACH ${level}
EXECUTE FUNCTION ${fnRef}();`;

  return [fnSql, triggerSql];
}

function createMysqlTriggerSql(engine: string, def: TriggerDef): string {
  // MySQL only allows exactly one event per trigger.
  const event = (def.events[0] || 'INSERT').toUpperCase();
  const ref = def.schema ? `${quoteIdent(engine, def.schema)}.${quoteIdent(engine, def.name)}` : quoteIdent(engine, def.name);
  const body = def.body.trim() || 'BEGIN\nEND';
  return `CREATE TRIGGER ${ref}
${def.timing} ${event} ON ${qualifiedTable(engine, def.table, def.schema)}
FOR EACH ROW
${body};`;
}

function createSqliteTriggerSql(engine: string, def: TriggerDef): string {
  const event = (def.events[0] || 'INSERT').toUpperCase();
  const body = def.body.trim() || 'BEGIN\nEND';
  return `CREATE TRIGGER ${quoteIdent(engine, def.name)}
${def.timing} ${event} ON ${qualifiedTable(engine, def.table, def.schema)}
FOR EACH ROW
${body};`;
}
