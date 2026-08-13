/**
 * Event SQL generators for the two engines that have a scheduled-job concept:
 * MySQL's native Event Scheduler, and Postgres via the `pg_cron` extension
 * (see `eventIntrospection.ts` for why these two are paired in one feature).
 * Pure functions, mirrors `triggerActions.ts`/`procedureActions.ts`.
 */
import { quoteIdent } from './ident';
import { EventDefinition } from './eventIntrospection';

export interface EventDef {
  name: string;
  schema?: string;
  scheduleType: 'ONE TIME' | 'RECURRING';
  intervalValue?: string;
  intervalField?: string;
  executeAt?: string;
  starts?: string;
  ends?: string;
  onCompletionPreserve: boolean;
  status: 'ENABLED' | 'DISABLED';
  /** Postgres/pg_cron only: standard 5-field cron expression. */
  cronSchedule?: string;
  body: string;
}

function mysqlScheduleClause(def: EventDef): string {
  if (def.scheduleType === 'ONE TIME') {
    return `AT '${(def.executeAt || '').replace(/'/g, "''")}'`;
  }
  const parts = [`EVERY ${def.intervalValue || '1'} ${def.intervalField || 'DAY'}`];
  if (def.starts) parts.push(`STARTS '${def.starts.replace(/'/g, "''")}'`);
  if (def.ends) parts.push(`ENDS '${def.ends.replace(/'/g, "''")}'`);
  return parts.join(' ');
}

function mysqlRef(engine: string, def: Pick<EventDef, 'name' | 'schema'>): string {
  return def.schema ? `${quoteIdent(engine, def.schema)}.${quoteIdent(engine, def.name)}` : quoteIdent(engine, def.name);
}

/** `CREATE EVENT`. */
export function createEventSql(engine: string, def: EventDef): string {
  const ref = mysqlRef(engine, def);
  const completion = def.onCompletionPreserve ? 'ON COMPLETION PRESERVE' : 'ON COMPLETION NOT PRESERVE';
  const status = def.status === 'DISABLED' ? 'DISABLE' : 'ENABLE';
  const body = def.body.trim() || 'DO NOTHING';
  return `CREATE EVENT ${ref}
ON SCHEDULE ${mysqlScheduleClause(def)}
${completion}
${status}
DO
  ${body};`;
}

/** `ALTER EVENT` — MySQL supports editing every clause in place, no drop+create needed. */
export function alterEventSql(engine: string, def: EventDef): string {
  const ref = mysqlRef(engine, def);
  const completion = def.onCompletionPreserve ? 'ON COMPLETION PRESERVE' : 'ON COMPLETION NOT PRESERVE';
  const status = def.status === 'DISABLED' ? 'DISABLE' : 'ENABLE';
  const body = def.body.trim() || 'DO NOTHING';
  return `ALTER EVENT ${ref}
ON SCHEDULE ${mysqlScheduleClause(def)}
${completion}
${status}
DO
  ${body};`;
}

/** `DROP EVENT`. */
export function dropEventSql(engine: string, name: string, schema?: string): string {
  return `DROP EVENT IF EXISTS ${mysqlRef(engine, { name, schema })};`;
}

// ───────────────────────── Postgres / pg_cron ─────────────────────────

function escLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

/** `SELECT cron.schedule(name, schedule, command);` — command is dollar-quoted
 *  so embedded quotes in the SQL body don't need manual escaping. */
export function pgCronScheduleSql(def: Pick<EventDef, 'name' | 'cronSchedule' | 'body'>): string {
  const schedule = escLiteral(def.cronSchedule || '* * * * *');
  return `SELECT cron.schedule('${escLiteral(def.name)}', '${schedule}', $$${def.body.trim()}$$);`;
}

/** Edit: pg_cron has no "alter by name" for the schedule *and* command
 *  together across all versions — unschedule + reschedule under the same
 *  name is the version-portable way to do it. */
export function pgCronReplaceSql(def: Pick<EventDef, 'name' | 'cronSchedule' | 'body'>): string[] {
  return [pgCronUnscheduleSql(def.name), pgCronScheduleSql(def)];
}

export function pgCronUnscheduleSql(name: string): string {
  return `SELECT cron.unschedule('${escLiteral(name)}');`;
}

/** Adapt a fetched `EventDefinition` into the builder's input shape (fills in
 *  the required fields the definition type leaves optional for MySQL/Postgres
 *  cross-reuse). */
export function eventDefFromDefinition(name: string, schema: string | undefined, def: EventDefinition): EventDef {
  return {
    name,
    schema,
    scheduleType: def.scheduleType || 'RECURRING',
    intervalValue: def.intervalValue,
    intervalField: def.intervalField,
    executeAt: def.executeAt,
    starts: def.starts,
    ends: def.ends,
    onCompletionPreserve: def.onCompletionPreserve ?? true,
    status: def.status || 'ENABLED',
    cronSchedule: def.cronSchedule,
    body: def.body,
  };
}
