/**
 * SQL risk classification — a lightweight heuristic that decides whether a
 * statement is safe to auto-run (read-only) or destructive (needs a confirm
 * dialog before the AI Assistant executes it).
 *
 * This is defense-in-depth UX, NOT a security boundary. A determined user can
 * always run anything from the editor directly. The classifier's job is to
 * keep the AI from quietly running `DROP TABLE` on a prod database: destructive
 * verbs always gate behind a confirmation dialog that shows the exact SQL and
 * target connection.
 *
 * The approach mirrors the backend's own verb detection
 * (`sql.to_uppercase().starts_with("SELECT")` in query.rs) and the existing
 * `ResultGrid` read-only prefix check — extended to cover every common verb.
 */
import { splitSqlStatements } from '../backup/backupSql';

export type SQLRisk = 'safe' | 'destructive';

/** Verbs that only READ data — never modify schema or rows. Safe to auto-run. */
const SAFE_VERBS = [
  'SELECT',
  'SHOW',
  'EXPLAIN',
  'DESC',
  'DESCRIBE',
  'PRAGMA',
  'WITH', // CTE — WITH ... SELECT ..., always read-only in our context
  'TABLE', // `TABLE foo;` is SQL-standard shorthand for `SELECT * FROM foo`
  'VALUES', // bare VALUES is a read-only row constructor in most engines
  'USE', // switch database context (MySQL) — no data change
] as const;

/** Verbs that WRITE or modify data/schema — require confirmation. */
const DESTRUCTIVE_VERBS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'TRUNCATE',
  'ALTER',
  'CREATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'MERGE',
  'REPLACE',
  'CALL', // may execute a stored procedure that mutates
  'SET', // session/config mutation
  'VACUUM',
  'ANALYZE', // Postgres ANALYZE mutates planner stats; harmless but not read-only
  'REINDEX',
  'REFRESH', // REFRESH MATERIALIZED VIEW
  'COMMENT',
  'COPY', // bulk import/export
  'LOAD',
] as const;

export interface SQLClassification {
  /** Overall risk across all statements in the batch. */
  risk: SQLRisk;
  /** Destructive verbs found, in order of appearance (deduplicated). */
  destructiveVerbs: string[];
}

/** Extract the leading SQL verb from a single statement, skipping leading
 *  comments, whitespace, and parentheses (e.g. `( SELECT ... )`). Returns the
 *  uppercase verb or '' if none can be determined. */
function leadingVerb(sql: string): string {
  // Strip block comments /* ... */ and line comments -- ...
  let s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  // Skip leading parens/whitespace so `(SELECT ...)` still classifies.
  while (s.startsWith('(')) s = s.slice(1).trim();
  // The verb is the first run of [A-Z_] characters.
  const m = s.match(/^([A-Za-z_]+)/);
  return m ? m[1].toUpperCase() : '';
}

/**
 * Classify a SQL batch (one or more ;-separated statements). The batch is
 * destructive if ANY statement is destructive — we never partially auto-run.
 */
export function classifySQL(sql: string): SQLClassification {
  const statements = splitSqlStatements(sql || '');
  const verbs = new Set<string>();
  let isDestructive = false;

  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    const verb = leadingVerb(trimmed);
    if (!verb) continue;
    if ((DESTRUCTIVE_VERBS as readonly string[]).includes(verb)) {
      isDestructive = true;
      verbs.add(verb);
    }
  }

  return {
    risk: isDestructive ? 'destructive' : 'safe',
    destructiveVerbs: [...verbs],
  };
}

/** Convenience: true when every statement in the batch is read-only. */
export function isReadOnlySQL(sql: string): boolean {
  return classifySQL(sql).risk === 'safe';
}
