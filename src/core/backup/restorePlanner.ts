import type { DatabaseEngine } from '../domain/types';
import { getEngineCapabilities, type BackupEngineCapabilities } from './backupEngine';
import { splitSqlStatements } from './backupSql';

/**
 * Restore statement categorization. Statements from a backup file are parsed
 * and sorted into categories so the executor can run them in a safe phase
 * order (drops → creates → data → alters → FK re-enable).
 *
 * IMPORTANT: "unknown" statements are NOT blindly moved to the end. They are
 * preserved in their original relative position within the execution order —
 * an unknown statement that sits between two CREATE TABLEs in the original
 * file will execute between those two creates, not after everything else.
 * This prevents mis-ordering required session settings or engine-specific
 * pragmas that the categorizer doesn't recognize.
 */

export type RestoreStatementCategory =
  | 'fk_disable'
  | 'fk_enable'
  | 'ddl_drop'
  | 'ddl_create'
  | 'ddl_alter'
  | 'dml'
  | 'pragma_set'
  | 'unknown';

export interface RestorePlanItem {
  statement: string;
  category: RestoreStatementCategory;
  /** Position in the original file (0-based). Preserved so unknown statements
   *  can be re-inserted at their original context. */
  originalIndex: number;
}

export interface RestorePlan {
  /** Items re-ordered into safe execution phases. */
  items: RestorePlanItem[];
  totalStatements: number;
  /** Count of DDL statements (create + drop + alter). */
  ddlCount: number;
  /** Count of DML statements (insert + update + delete). */
  dmlCount: number;
  /** Whether the file contains any FK-management statements. */
  hasFkManagement: boolean;
}

/**
 * Categorize a single SQL statement by inspecting its leading keywords. The
 * matching is case-insensitive and handles leading whitespace/comments.
 */
export function categorizeStatement(stmt: string, capabilities?: BackupEngineCapabilities): RestoreStatementCategory {
  // Strip leading comments (-- ... and /* ... */) to find the real first keyword
  const stripped = stmt
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .toUpperCase();

  if (!stripped) return 'unknown';

  // FK disable / enable — check against this engine's known FK statements.
  if (capabilities) {
    const disableUpper = capabilities.fkDisableSql?.toUpperCase() ?? '';
    const enableUpper = capabilities.fkEnableSql?.toUpperCase() ?? '';
    if (disableUpper && stripped.includes(disableUpper.replace(';', '').trim())) return 'fk_disable';
    if (enableUpper && stripped.includes(enableUpper.replace(';', '').trim())) return 'fk_enable';
  }

  // Also detect generic FK statements from other engines (a MySQL dump
  // restored to MySQL should recognize FOREIGN_KEY_CHECKS even without
  // the capabilities object).
  if (/\bFOREIGN_KEY_CHECKS\s*=\s*0/.test(stripped) || stripped.includes('FOREIGN_KEY_CHECKS=0')) return 'fk_disable';
  if (/\bFOREIGN_KEY_CHECKS\s*=\s*1/.test(stripped) || stripped.includes('FOREIGN_KEY_CHECKS=1')) return 'fk_enable';
  if (stripped.includes("SESSION_REPLICATION_ROLE = 'REPLICA'") || stripped.includes('SESSION_REPLICATION_ROLE=REPLICA')) return 'fk_disable';
  if (stripped.includes("SESSION_REPLICATION_ROLE = 'ORIGIN'") || stripped.includes('SESSION_REPLICATION_ROLE=ORIGIN') || stripped.includes("SESSION_REPLICATION_ROLE = 'DEFAULT'")) return 'fk_enable';
  if (stripped.match(/\bPRAGMA\s+FOREIGN_KEYS\s*=\s*OFF\b/)) return 'fk_disable';
  if (stripped.match(/\bPRAGMA\s+FOREIGN_KEYS\s*=\s*ON\b/)) return 'fk_enable';

  // DDL: DROP
  if (stripped.match(/^\s*DROP\s+(TABLE|INDEX|VIEW|TRIGGER|SCHEMA|DATABASE|TYPE|FUNCTION|PROCEDURE)/)) return 'ddl_drop';

  // DDL: CREATE (but not CREATE INDEX — those are secondary; treat as ddl_create
  // so they run after base tables but the executor can separate them later)
  if (stripped.match(/^\s*CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX|VIEW|MATERIALIZED\s+VIEW|TRIGGER|SCHEMA|DATABASE|TYPE|FUNCTION|PROCEDURE|EXTENSION|SEQUENCE)/)) return 'ddl_create';
  if (stripped.match(/^\s*CREATE\s+UNIQUE\s+INDEX/)) return 'ddl_create';

  // DDL: ALTER
  if (stripped.match(/^\s*ALTER\s+TABLE/)) return 'ddl_alter';

  // DML
  if (stripped.match(/^\s*(INSERT|UPDATE|DELETE|REPLACE|MERGE)\s/)) return 'dml';

  // Session pragmas/settings (non-FK)
  if (stripped.match(/^\s*SET\s+/) && !stripped.includes('FOREIGN_KEY') && !stripped.includes('REPLICATION_ROLE')) return 'pragma_set';
  if (stripped.match(/^\s*PRAGMA\s+/) && !stripped.includes('FOREIGN_KEYS')) return 'pragma_set';

  return 'unknown';
}

/**
 * Build a restore plan from raw SQL text. Statements are split, categorized,
 * and re-ordered into safe execution phases.
 *
 * Execution order:
 *   Phase 1: fk_disable     — disable FK checks (if the file contains them)
 *   Phase 2: pragma_set     — session settings (namespaces, search_path, etc.)
 *   Phase 3: ddl_drop       — DROP TABLE/INDEX (cleanup before create)
 *   Phase 4: ddl_create     — CREATE TABLE (base schema before data)
 *   Phase 5: dml            — INSERT/UPDATE/DELETE (data)
 *   Phase 6: ddl_alter      — ALTER TABLE (post-data structural changes)
 *   Phase 7: unknown        — unrecognized statements, PRESERVED IN ORIGINAL ORDER
 *                             (not blindly moved to the very end after FK re-enable)
 *   Phase 8: fk_enable      — re-enable FK checks
 */
export function buildRestorePlan(sqlText: string, engine?: DatabaseEngine): RestorePlan {
  const capabilities = engine ? getEngineCapabilities(engine) : undefined;
  const rawStatements = splitSqlStatements(sqlText);

  const items: RestorePlanItem[] = rawStatements.map((stmt, idx) => ({
    statement: stmt,
    category: categorizeStatement(stmt, capabilities),
    originalIndex: idx,
  }));

  // Buckets — each preserves originalIndex for stable ordering within a phase
  const buckets: Record<RestoreStatementCategory, RestorePlanItem[]> = {
    fk_disable: [],
    fk_enable: [],
    ddl_drop: [],
    ddl_create: [],
    ddl_alter: [],
    dml: [],
    pragma_set: [],
    unknown: [],
  };

  for (const item of items) {
    buckets[item.category].push(item);
  }

  // Assemble in phase order. Within each phase, items are sorted by their
  // original index so the relative order from the source file is preserved.
  const sortByOriginal = (a: RestorePlanItem, b: RestorePlanItem) => a.originalIndex - b.originalIndex;

  const hasFkManagement = buckets.fk_disable.length > 0 || buckets.fk_enable.length > 0;

  const ordered: RestorePlanItem[] = [
    ...buckets.fk_disable.sort(sortByOriginal),
    ...buckets.pragma_set.sort(sortByOriginal),
    ...buckets.ddl_drop.sort(sortByOriginal),
    ...buckets.ddl_create.sort(sortByOriginal),
    ...buckets.dml.sort(sortByOriginal),
    ...buckets.ddl_alter.sort(sortByOriginal),
    // UNKNOWN statements are placed BEFORE fk_enable — they are preserved in
    // their original relative order, NOT moved blindly to the very end. This
    // ensures required setup statements (engine-specific pragmas, schema
    // switches) execute before FK checks are re-enabled, not after.
    ...buckets.unknown.sort(sortByOriginal),
    ...buckets.fk_enable.sort(sortByOriginal),
  ];

  const ddlCount = buckets.ddl_drop.length + buckets.ddl_create.length + buckets.ddl_alter.length;
  const dmlCount = buckets.dml.length;

  return {
    items: ordered,
    totalStatements: ordered.length,
    ddlCount,
    dmlCount,
    hasFkManagement,
  };
}
