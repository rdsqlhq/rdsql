/**
 * Engine-aware table-action SQL generators + capability map.
 *
 * This module is the single place where table-level DDL/DML (DROP, TRUNCATE,
 * reset auto-increment, maintenance) SQL is generated. React components call
 * these functions — they never build engine-specific SQL themselves (spec §6).
 *
 * All identifiers are quoted/escaped via the existing `quoteIdent` /
 * `qualifiedTable` helpers, so table names containing quotes, backticks, or
 * dots are safe (spec §7: avoid SQL injection through table names).
 *
 * No SQL is executed here — these are pure functions, unit-tested in
 * `__tests__/tableActions.test.ts`.
 */
import { DatabaseEngine } from '../domain/types';
import type { SchemaColumnNode } from '../domain/types';
import { quoteIdent, qualifiedTable } from './ident';
import { isDuckdbFamily, isMysqlFamily, isPostgresFamily } from '../connection/engines';

// ───────────────────────── Engine normalization ─────────────────────────

/** Normalize the engine string the same way the backend does. */
export function normalizeEngine(engine: string): string {
  return engine.toLowerCase();
}

/** True for SQLite-family engines (SQLite + Cloudflare D1). */
function isSqliteFamily(engine: string): boolean {
  const e = normalizeEngine(engine);
  return e === 'sqlite' || e === 'cloudflare-d1' || e === 'd1';
}

// ───────────────────────── Capabilities ─────────────────────────

export type MaintenanceOp = 'analyze' | 'vacuum' | 'optimize' | 'check' | 'reindex' | 'checkpoint';

export interface TableCapabilities {
  /** True if the engine has a real `TRUNCATE TABLE` statement. SQLite/D1 do not. */
  supportsTruncate: boolean;
  /** True if an auto-increment / sequence value can be reset to a custom value. */
  supportsResetAutoIncrement: boolean;
  /** Maintenance operations that make sense for this engine. */
  maintenanceOps: MaintenanceOp[];
}

/** Per-engine capability map. Built from `normalizeEngine` so 'mariadb' (stored
 *  as 'mysql') and 'd1'/'cloudflare-d1' all resolve correctly. */
export function getTableCapabilities(engine: string): TableCapabilities {
  const e = normalizeEngine(engine);
  switch (e) {
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      return {
        supportsTruncate: true,
        supportsResetAutoIncrement: true,
        maintenanceOps: ['analyze', 'vacuum', 'reindex'],
      };
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return {
        supportsTruncate: true,
        supportsResetAutoIncrement: true,
        maintenanceOps: ['analyze', 'optimize', 'check'],
      };
    case 'sqlite':
    case 'cloudflare-d1':
    case 'd1':
      return {
        supportsTruncate: false, // SQLite has no TRUNCATE statement
        supportsResetAutoIncrement: true, // via sqlite_sequence
        maintenanceOps: ['analyze'],
      };
    case 'duckdb':
      // DuckDB has TRUNCATE (≥0.9) but no auto-increment/sequence concept.
      // CHECKPOINT compacts the WAL (≈ VACUUM/OPTIMIZE); ANALYZE refreshes stats.
      return {
        supportsTruncate: true,
        supportsResetAutoIncrement: false,
        maintenanceOps: ['checkpoint', 'analyze'],
      };
    case 'mssql':
    case 'sqlserver':
      return {
        supportsTruncate: true,
        supportsResetAutoIncrement: true,
        maintenanceOps: ['check'],
      };
    default:
      // duckdb + unknown engines: be conservative, expose nothing destructive.
      return {
        supportsTruncate: false,
        supportsResetAutoIncrement: false,
        maintenanceOps: [],
      };
  }
}

// ───────────────────────── DROP TABLE ─────────────────────────

/** Generate `DROP TABLE` SQL. Never adds CASCADE — the user must opt in. */
export function dropTableSql(engine: string, table: string, schema?: string): string {
  return `DROP TABLE ${qualifiedTable(engine, table, schema)};`;
}

// ───────────────────────── TRUNCATE TABLE ─────────────────────────

/**
 * Generate the engine-appropriate "remove all rows" SQL.
 *
 * - Postgres: `TRUNCATE TABLE <t> RESTART IDENTITY;` (resets owned sequences too)
 * - MySQL/MariaDB: `TRUNCATE TABLE <t>;`
 * - SQLite/D1: no TRUNCATE statement — emit `DELETE FROM <t>;` (use
 *   `resetAutoIncrementSql` separately to reset sqlite_sequence)
 *
 * Returns `null` for engines with no row-removal path.
 */
export function truncateTableSql(engine: string, table: string, schema?: string): string | null {
  const e = normalizeEngine(engine);
  const qt = qualifiedTable(engine, table, schema);
  switch (e) {
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      return `TRUNCATE TABLE ${qt} RESTART IDENTITY;`;
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return `TRUNCATE TABLE ${qt};`;
    case 'sqlite':
    case 'cloudflare-d1':
    case 'd1':
      // SQLite has no TRUNCATE; DELETE keeps the structure & indexes.
      return `DELETE FROM ${qt};`;
    case 'duckdb':
      // DuckDB supports TRUNCATE (no TABLE keyword, no RESTART IDENTITY).
      return `TRUNCATE ${qt};`;
    case 'mssql':
    case 'sqlserver':
      return `TRUNCATE TABLE ${qt};`;
    default:
      return null;
  }
}

// ───────────────────────── RESET AUTO INCREMENT ─────────────────────────

export interface AutoIncrementMeta {
  columnName: string;
  /** Current MAX(column) across existing rows, or null when the table is empty. */
  currentMax: number | null;
  /** The next value the auto-increment/sequence would yield, when known. */
  currentValue: number | null;
  /** Postgres sequence name (schema-qualified), when applicable. */
  sequenceName?: string;
}

/**
 * Generate the SQL to set the next auto-increment value.
 *
 * - Postgres: `SELECT setval('<seq>', <value - 1>, false);` — the third arg
 *   `false` means "next nextval returns exactly <value>". (The backend resolves
 *   the sequence name from metadata.)
 * - MySQL/MariaDB: `ALTER TABLE <t> AUTO_INCREMENT = <value>;`
 * - SQLite/D1: `UPDATE sqlite_sequence SET seq = <value - 1> WHERE name = '<table>';`
 *   (sqlite_sequence stores the *last* issued value, so the next is `seq + 1`.)
 *
 * `nextValue` is the value the user wants the NEXT insert to receive.
 */
export function resetAutoIncrementSql(
  engine: string,
  table: string,
  nextValue: number,
  meta?: AutoIncrementMeta
): string | null {
  const e = normalizeEngine(engine);
  const qt = qualifiedTable(engine, table, meta?.sequenceName ? undefined : undefined);
  switch (e) {
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb': {
      const seq = meta?.sequenceName;
      if (!seq) return null; // need the sequence name from metadata
      // setval to value-1 with is_called=false → next nextval() returns `nextValue`.
      return `SELECT setval('${seq}', ${nextValue - 1}, false);`;
    }
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return `ALTER TABLE ${qt} AUTO_INCREMENT = ${nextValue};`;
    case 'sqlite':
    case 'cloudflare-d1':
    case 'd1':
      // sqlite_sequence.seq is the last issued value; next issued = seq + 1.
      return `UPDATE sqlite_sequence SET seq = ${nextValue - 1} WHERE name = '${table.replace(/'/g, "''")}';`;
    case 'mssql':
    case 'sqlserver': {
      // DBCC CHECKIDENT RESEEDs to the *last issued* value; next issued = value + 1.
      const objName = qt.replace(/'/g, "''");
      return `DBCC CHECKIDENT ('${objName}', RESEED, ${nextValue - 1});`;
    }
    default:
      return null;
  }
}

// ───────────────────────── Maintenance ─────────────────────────

/** `ANALYZE` — refresh planner statistics. Supported by all real engines. */
export function analyzeTableSql(engine: string, table: string, schema?: string): string | null {
  const e = normalizeEngine(engine);
  const qt = qualifiedTable(engine, table, schema);
  switch (e) {
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
    case 'sqlite':
    case 'cloudflare-d1':
    case 'd1':
    case 'duckdb':
      return `ANALYZE ${qt};`;
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return `ANALYZE TABLE ${qt};`;
    default:
      return null;
  }
}

/** `VACUUM` — reclaim dead tuples / pages. Postgres + SQLite only.
 *  DuckDB maps this onto CHECKPOINT (compacts the WAL). */
export function vacuumTableSql(engine: string, table: string, schema?: string): string | null {
  const e = normalizeEngine(engine);
  switch (e) {
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      return `VACUUM (ANALYZE) ${qualifiedTable(engine, table, schema)};`;
    // SQLite VACUUM is whole-database (no per-table syntax).
    case 'sqlite':
    case 'cloudflare-d1':
    case 'd1':
      return `VACUUM;`;
    case 'duckdb':
      return `CHECKPOINT;`;
    default:
      return null;
  }
}

/** `OPTIMIZE TABLE` — MySQL/MariaDB. DuckDB maps this onto CHECKPOINT. */
export function optimizeTableSql(engine: string, table: string, schema?: string): string | null {
  const e = normalizeEngine(engine);
  if (isMysqlFamily(e)) {
    return `OPTIMIZE TABLE ${qualifiedTable(engine, table, schema)};`;
  }
  if (isDuckdbFamily(e)) {
    return `CHECKPOINT;`;
  }
  return null;
}

/** `CHECK TABLE` — MySQL/MariaDB. DuckDB maps this onto CHECKPOINT. SQL Server
 *  maps this onto `DBCC CHECKTABLE`. */
export function checkTableSql(engine: string, table: string, schema?: string): string | null {
  const e = normalizeEngine(engine);
  if (isMysqlFamily(e)) {
    return `CHECK TABLE ${qualifiedTable(engine, table, schema)};`;
  }
  if (isDuckdbFamily(e)) {
    return `CHECKPOINT;`;
  }
  if (e === 'mssql' || e === 'sqlserver') {
    const objName = qualifiedTable(engine, table, schema).replace(/'/g, "''");
    return `DBCC CHECKTABLE ('${objName}');`;
  }
  return null;
}

/** `REINDEX TABLE` — Postgres only (rebuild all indexes on the table). */
export function reindexTableSql(engine: string, table: string, schema?: string): string | null {
  const e = normalizeEngine(engine);
  if (isPostgresFamily(e)) {
    return `REINDEX TABLE ${qualifiedTable(engine, table, schema)};`;
  }
  return null;
}

/** Look up the SQL for a maintenance op by key. Returns null if unsupported. */
export function maintenanceOpSql(
  op: MaintenanceOp,
  engine: string,
  table: string,
  schema?: string
): string | null {
  switch (op) {
    case 'analyze': return analyzeTableSql(engine, table, schema);
    case 'vacuum': return vacuumTableSql(engine, table, schema);
    case 'optimize': return optimizeTableSql(engine, table, schema);
    case 'check': return checkTableSql(engine, table, schema);
    case 'reindex': return reindexTableSql(engine, table, schema);
    case 'checkpoint':
      // DuckDB only — CHECKPOINT compacts the WAL.
      return isDuckdbFamily(engine) ? `CHECKPOINT;` : null;
  }
}

/** Human-readable label for a maintenance op (for buttons/toasts). */
export function maintenanceOpLabel(op: MaintenanceOp): string {
  switch (op) {
    case 'analyze': return 'Analyze Table';
    case 'vacuum': return 'Vacuum';
    case 'optimize': return 'Optimize Table';
    case 'check': return 'Check Table';
    case 'reindex': return 'Reindex Table';
    case 'checkpoint': return 'Checkpoint';
  }
}

// ───────────────────────── Auto-increment column detection ─────────────────────────

/**
 * Best-effort detection of the auto-increment / identity / sequence-backed
 * column on a table, from the schema-tree column nodes.
 *
 * Heuristics (conservative — returns null when in doubt, spec §3):
 * - SQLite: `INTEGER PRIMARY KEY` (a rowid alias) — `is_primary_key && type contains INT`
 * - Postgres: `is_identity` is folded into `has_default` by the backend; a PK
 *   column of type `serial`/`bigserial`/`int`/`int4`/`int8` with `has_default`
 *   is treated as sequence-backed.
 * - MySQL: `extra contains auto_increment` is folded into `has_default`; a PK
 *   integer column with `has_default` is treated as AUTO_INCREMENT.
 *
 * Returns the column name, or null when no compatible column is found.
 */
export function detectAutoIncrementColumn(
  engine: string,
  columns: SchemaColumnNode[]
): string | null {
  const e = normalizeEngine(engine);
  const isIntType = (t?: string) => {
    if (!t) return false;
    const dt = t.toLowerCase();
    return (
      dt.includes('int') ||
      dt.includes('serial') ||
      dt === 'int4' ||
      dt === 'int8' ||
      dt === 'integer'
    );
  };

  // SQLite: INTEGER PRIMARY KEY is the auto-increment rowid alias.
  if (isSqliteFamily(e)) {
    const pk = columns.find((c) => c.is_primary_key && isIntType(c.data_type));
    return pk?.name ?? null;
  }

  // Postgres / MySQL / SQL Server: a PK integer column with a default
  // (identity / sequence / auto_increment — the backend folds SQL Server's
  // IDENTITY flag into `has_default` the same way it does MySQL's AUTO_INCREMENT).
  if (isPostgresFamily(e) || isMysqlFamily(e) || e === 'mssql' || e === 'sqlserver') {
    const pk = columns.find(
      (c) => c.is_primary_key && isIntType(c.data_type) && c.has_default
    );
    return pk?.name ?? null;
  }

  return null;
}
