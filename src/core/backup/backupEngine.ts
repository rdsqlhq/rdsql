import type { DatabaseEngine, SchemaTableNode, QueryColumn } from '../domain/types';
import { generateCreateTableSql, generateInsertStatements } from './backupSql';
import { qualifiedTable } from '../sql/ident';
import { sortTablesByDependency } from './dependencyGraph';
import { isMysqlFamily, isDuckdbFamily } from '../connection/engines';

/**
 * Per-engine capability declaration. The executor checks these to decide FK
 * strategy, transaction behavior, etc. — no universal assumptions.
 */
export interface BackupEngineCapabilities {
  engine: DatabaseEngine;
  /** Whether the engine can disable FK constraint enforcement for the session. */
  canDisableFkChecks: boolean;
  /** SQL to disable FK checks for the session, or null if unsupported. */
  fkDisableSql: string | null;
  /** SQL to re-enable FK checks, or null. */
  fkEnableSql: string | null;
  /** Future: whether DDL can be wrapped in BEGIN/COMMIT. */
  supportsTransactionalDdl: boolean;
  /** Future: whether constraints can be deferred until COMMIT. */
  supportsDeferredConstraints: boolean;
}

/**
 * Declare capabilities for each engine. This is the single source of truth —
 * the executor never branches on engine name directly.
 *
 * IMPORTANT NOTES:
 *
 * PostgreSQL: `SET session_replication_role = replica` disables ALL triggers
 * and rules, not just FK checks. It requires superuser or pg_execute_server_program
 * role. The executor should ATTEMPT it at runtime and gracefully fall back to
 * dependency ordering if the privilege check fails — do not assume it will
 * always succeed.
 *
 * Cloudflare D1: The REST API does not expose session-level FK controls, so
 * `canDisableFkChecks` is false. Whether D1 tables have FK definitions is a
 * separate question answered by the schema metadata — this capability only
 * says we cannot disable enforcement, not that FKs never exist.
 *
 * SQLite: `PRAGMA foreign_keys = OFF` is per-connection. Since `execute_query`
 * opens a new connection per call, the pragma must be re-issued before the
 * data phase and will not persist to the next connection. The executor handles
 * this by executing the pragma in the same batch as the data statements.
 */
export function getEngineCapabilities(engine: DatabaseEngine): BackupEngineCapabilities {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return {
        engine,
        canDisableFkChecks: true,
        fkDisableSql: 'SET FOREIGN_KEY_CHECKS = 0;',
        fkEnableSql: 'SET FOREIGN_KEY_CHECKS = 1;',
        supportsTransactionalDdl: false,
        supportsDeferredConstraints: false,
      };
    case 'postgres':
    case 'cockroachdb':
    case 'yugabytedb':
      return {
        engine,
        canDisableFkChecks: true, // attempted at runtime; may fail on insufficient privileges
        // NOTE: session_replication_role = 'replica' disables ALL triggers and
        // rules, not just FK checks. It requires superuser privileges. The
        // executor must attempt this at runtime and gracefully fall back to
        // dependency ordering if it fails.
        fkDisableSql: "SET session_replication_role = 'replica';",
        fkEnableSql: "SET session_replication_role = 'origin';",
        supportsTransactionalDdl: true,
        supportsDeferredConstraints: true,
      };
    case 'sqlite':
      return {
        engine,
        canDisableFkChecks: true, // per-connection — executor must re-issue each time
        fkDisableSql: 'PRAGMA foreign_keys = OFF;',
        fkEnableSql: 'PRAGMA foreign_keys = ON;',
        supportsTransactionalDdl: true,
        supportsDeferredConstraints: false,
      };
    case 'duckdb':
      return {
        engine,
        // DuckDB enforces foreign keys and exposes no per-session switch to
        // disable them (unlike MySQL's FOREIGN_KEY_CHECKS or Postgres'
        // session_replication_role). Backup relies on dependency ordering
        // (parents inserted before children) to satisfy FK constraints.
        // Identifier quoting uses double-quotes (same as postgres), handled in
        // quoteIdent via the non-mysql default arm.
        canDisableFkChecks: false,
        fkDisableSql: null,
        fkEnableSql: null,
        supportsTransactionalDdl: true,
        supportsDeferredConstraints: false,
      };
    case 'cloudflare-d1':
      return {
        engine,
        // D1's REST API does not expose session-level FK controls.
        // This does NOT mean D1 tables never have FK definitions — it means we
        // cannot disable enforcement at the API level. Dependency ordering is
        // the primary strategy.
        canDisableFkChecks: false,
        fkDisableSql: null,
        fkEnableSql: null,
        supportsTransactionalDdl: false,
        supportsDeferredConstraints: false,
      };
    default:
      return {
        engine,
        canDisableFkChecks: false,
        fkDisableSql: null,
        fkEnableSql: null,
        supportsTransactionalDdl: false,
        supportsDeferredConstraints: false,
      };
  }
}

/** Execution phases, in the order they run. */
export type BackupPhase = 'schema' | 'data' | 'secondary' | 'finalize';

/**
 * A single unit of work in the execution plan. Each item is independently
 * trackable, retryable, and checkpointable (future). The `id` field is designed
 * for future checkpoint persistence; `dependsOn` for future parallel execution;
 * `rowCount` for future streaming/chunking.
 */
export interface BackupPlanItem {
  id: string;
  table: string;
  phase: BackupPhase;
  sql: string;
  rowCount?: number;
  dependsOn?: string[];
}

/** Selection state for a table (structure / data checkboxes). */
export interface TableSelection {
  structure: boolean;
  data: boolean;
}

/** The full execution plan. Serializable for future checkpoint persistence. */
export interface BackupExecutionPlan {
  engine: DatabaseEngine;
  capabilities: BackupEngineCapabilities;
  sourceSchema: string;
  targetSchema?: string;
  /** Ordered items — schema phase first, then data, then secondary, then finalize. */
  items: BackupPlanItem[];
  totalTables: number;
  totalStatements: number;
  /** Whether dependency analysis detected a cycle (FK-disable is critical). */
  hasCycle: boolean;
  /** Table names in dependency order (parents first). */
  tableOrder: string[];
}

/** Progress event emitted by the executor. */
export interface PlanProgress {
  phase: BackupPhase;
  currentItemIndex: number;
  totalItems: number;
  currentTable: string | null;
  rowsProcessed: number;
}

/**
 * Build the execution plan from schema metadata. Pure, testable — no side
 * effects, no IPC calls. The plan is then executed by the caller.
 *
 * The plan is organized into phases:
 *   1. Schema: CREATE TABLE for all tables, ordered by dependency (parents first)
 *   2. Data: INSERT statements, ordered by dependency
 *   3. Secondary: reserved for future indexes/constraints/triggers (currently empty)
 *   4. Finalize: FK re-enable (emitted as a plan item so the executor knows
 *      to run it; also included in file output scripts)
 */
export function buildBackupPlan(params: {
  engine: DatabaseEngine;
  tables: SchemaTableNode[];
  selections: Map<string, TableSelection>;
  schema: string;
  writeMode: 'insert' | 'truncate' | 'drop';
  /** When set, table names in generated SQL are qualified with this schema.
   *  When null, no schema prefix is added (for live-DB destinations where the
   *  connection config already targets the right database).
   *  When undefined (omitted), falls back to the source schema. */
  targetSchema?: string | null;
}): BackupExecutionPlan {
  const { engine, tables, selections, schema, writeMode, targetSchema } = params;
  const capabilities = getEngineCapabilities(engine);

  // Sort tables by FK dependency (parents first). Falls back to original order
  // if no FKs detected. hasCycle tells us if FK-disable is critical.
  const { ordered: tableOrder, hasCycle } = sortTablesByDependency(tables);

  // Map ordered names back to SchemaTableNode objects
  const tableMap = new Map(tables.map((t) => [t.name, t]));
  const orderedTables = tableOrder.map((name) => tableMap.get(name)!).filter(Boolean);

  // null = no prefix (live-DB dest), undefined = use source schema (file output),
  // string = use that schema. Convert null → undefined for downstream functions
  // that accept string | undefined.
  const rawSchema = targetSchema === undefined ? schema : targetSchema;
  const applySchema = rawSchema ?? undefined;
  const items: BackupPlanItem[] = [];

  // ── Phase 1: Schema (base structure) ──────────────────────────────────
  // For writeMode 'drop', emit DROP statements first (in reverse dependency
  // order — children dropped before parents to avoid FK violations on engines
  // that enforce them during DDL).
  if (writeMode === 'drop') {
    const dropOrder = [...orderedTables].reverse();
    for (const table of dropOrder) {
      const sel = selections.get(table.name);
      if (!sel || !sel.structure) continue;
      const targetRef = qualifiedTable(engine, table.name, applySchema);
      // MySQL-family and DuckDB drop with plain IF EXISTS (no CASCADE). Other
      // engines (postgres, sqlite, cloudflare-d1) wrap with CASCADE so a stray
      // dependent view/constraint doesn't block the drop.
      const dropSql =
        isMysqlFamily(engine) || isDuckdbFamily(engine)
          ? `DROP TABLE IF EXISTS ${targetRef};`
          : `DROP TABLE IF EXISTS ${targetRef} CASCADE;`;
      items.push({
        id: `drop_${table.name}`,
        table: table.name,
        phase: 'schema',
        sql: dropSql,
      });
    }
  }

  // CREATE TABLE statements in dependency order (parents first)
  for (const table of orderedTables) {
    const sel = selections.get(table.name);
    if (!sel || !sel.structure) continue;
    items.push({
      id: `create_${table.name}`,
      table: table.name,
      phase: 'schema',
      sql: generateCreateTableSql(engine, table, applySchema),
    });
  }

  // For writeMode 'truncate', emit TRUNCATE before data (in reverse order)
  if (writeMode === 'truncate') {
    const truncOrder = [...orderedTables].reverse();
    for (const table of truncOrder) {
      const sel = selections.get(table.name);
      if (!sel || !sel.data) continue;
      const targetRef = qualifiedTable(engine, table.name, applySchema);
      items.push({
        id: `truncate_${table.name}`,
        table: table.name,
        phase: 'schema',
        sql: `TRUNCATE TABLE ${targetRef};`,
      });
    }
  }

  // ── Phase 2: Data (INSERTs) ───────────────────────────────────────────
  // Data items are filled with placeholders — the actual row data must be
  // read at execution time (not at plan-build time) because reading all data
  // upfront would load everything into memory. The executor reads per-table.
  // We emit a "data_read" marker item per table so the executor knows to
  // read from source and then apply INSERTs.
  for (const table of orderedTables) {
    const sel = selections.get(table.name);
    if (!sel || !sel.data) continue;
    items.push({
      id: `data_${table.name}`,
      table: table.name,
      phase: 'data',
      // Placeholder SQL — the executor replaces this with real INSERTs after
      // reading the source data. This keeps the plan serializable without
      // embedding all row data upfront.
      sql: '',
      rowCount: typeof table.row_count === 'number' ? table.row_count : undefined,
    });
  }

  // ── Phase 3: Secondary objects ────────────────────────────────────────
  // Reserved for future: indexes, constraints, triggers, views.
  // Currently no generators produce these — the phase exists so adding them
  // later is additive (insert items here), not structural.

  // ── Phase 4: Finalize (FK re-enable) ──────────────────────────────────
  if (capabilities.canDisableFkChecks && capabilities.fkEnableSql) {
    items.push({
      id: 'finalize_fk_enable',
      table: '',
      phase: 'finalize',
      sql: capabilities.fkEnableSql,
    });
  }

  return {
    engine,
    capabilities,
    sourceSchema: schema,
    targetSchema: applySchema,
    items,
    totalTables: orderedTables.filter((t) => {
      const sel = selections.get(t.name);
      return sel && (sel.structure || sel.data);
    }).length,
    totalStatements: items.length,
    hasCycle,
    tableOrder,
  };
}

/**
 * Generate the INSERT statements for a data-phase plan item, using columns
 * and rows read from the source at execution time. Returns an array of SQL
 * statements to execute against the destination.
 */
export function generateDataStatements(
  engine: DatabaseEngine,
  tableName: string,
  targetSchema: string | undefined,
  columns: QueryColumn[],
  rows: unknown[][]
): string[] {
  return generateInsertStatements(engine, tableName, targetSchema, columns, rows);
}
