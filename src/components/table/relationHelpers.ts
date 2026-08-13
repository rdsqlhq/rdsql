/**
 * Shared helpers for foreign-key / relation-cell rendering.
 *
 * Both `TableDataView` (table data tab) and `ResultGrid` (SQL editor result
 * panel) need to answer the same questions about a table:
 *
 *   - Which columns are primary keys?
 *   - Which columns look like foreign keys, and which target table does each
 *     point at? (`RelationTarget`)
 *   - For a relation picker, which column on the target table is the
 *     human-readable "label" to show next to the raw id? (`guessLabelColumn`)
 *   - Which columns are NOT NULL with no default (must be filled in by the
 *     user on insert/update)?
 *
 * These were previously duplicated in both components. Centralising them here
 * keeps the heuristic in one place — change it once and both grids benefit.
 */

import { SchemaTableNode } from '../../core/domain/types';
import { resolveFkTarget } from '../../core/erd/schemaGraph';

/** FK target info used by `RelationCellInput` and `DataGrid` for relation-cell
 *  rendering. */
export interface RelationTarget {
  table: string;
  /** Schema/database the target table lives in, used to qualify the FROM
   *  clause so the relation lookup works on non-default schemas. */
  schemaName?: string;
  pkColumn: string;
  /** Human-readable column on the target table to show next to the raw id in
   *  the relation picker, or `null` when no suitable column was found (the
   *  picker then lists bare ids). */
  labelColumn: string | null;
}

/** Column names we treat as a "label" when guessing a friendly column for the
 *  relation picker. Order = preference. A column qualifies if its lowercased
 *  name equals the preference OR ends with `_<preference>` (e.g. `user_name`,
 *  `post_title`, `category_slug`). */
const LABEL_COLUMN_PREFERENCE = ['name', 'title', 'label', 'username', 'email', 'slug', 'code'];

/** Best-effort guess at a human-readable column to show next to the raw id in
 *  the relation picker. Falls back to the first text-ish column, then to the
 *  first non-PK column, then to `null` (bare ids only). */
export function guessLabelColumn(target: SchemaTableNode): string | null {
  const candidates = target.children.filter((c) => !c.is_primary_key);
  for (const pref of LABEL_COLUMN_PREFERENCE) {
    const found = candidates.find((c) => {
      const n = c.name.toLowerCase();
      return n === pref || n.endsWith(`_${pref}`);
    });
    if (found) return found.name;
  }
  const textCol = candidates.find((c) => {
    const dt = (c.data_type || '').toLowerCase();
    return dt.includes('char') || dt.includes('text');
  });
  if (textCol) return textCol.name;
  return candidates[0]?.name ?? null;
}

/** The set of relation metadata a grid needs for one table: PK columns, the
 *  FK-column → `RelationTarget` map (for relation pickers), the set of
 *  required (NOT NULL, no default) columns, and the set of all NOT NULL
 *  columns (used to block explicit SET NULL on UPDATE — a column like
 *  `createdAt` with `DEFAULT now()` isn't "required" on INSERT because the
 *  default fills it, but an explicit `UPDATE ... SET createdAt = NULL` still
 *  violates the constraint since defaults don't apply on UPDATE). */
export interface TableRelationInfo {
  pkColumns: string[];
  fkMap: Map<string, RelationTarget>;
  requiredColumns: Set<string>;
  notNullColumns: Set<string>;
}

/**
 * Build `TableRelationInfo` for a single table by inspecting its columns and
 * the sibling tables in the same schema group.
 *
 * - `match` — the schema-tree node for the table being displayed.
 * - `siblingTables` — all tables in the same schema/database (used to resolve
 *   FK targets by column-name heuristic).
 * - `schemaName` — the schema/database name used to qualify FK target lookups
 *   so relation pickers work on non-default schemas.
 *
 * Returns an empty result (no PKs, no FKs, no required columns) when `match`
 * is nullish, so callers can write `buildTableRelationInfo(...) ?? EMPTY` and
 * skip null-checks.
 */
export function buildTableRelationInfo(
  match: SchemaTableNode | undefined | null,
  siblingTables: SchemaTableNode[],
  schemaName?: string,
): TableRelationInfo {
  const empty: TableRelationInfo = {
    pkColumns: [],
    fkMap: new Map(),
    requiredColumns: new Set(),
    notNullColumns: new Set(),
  };
  if (!match) return empty;

  const pkColumns = match.children.filter((c) => c.is_primary_key).map((c) => c.name);
  const fkMap = new Map<string, RelationTarget>();
  // NOT NULL columns with no default — the database won't fill these in on
  // its own, so leaving them empty on insert should be blocked client-side
  // rather than bouncing off a constraint violation.
  const requiredColumns = new Set<string>();
  // ALL NOT NULL columns — defaults only apply on INSERT, not on UPDATE, so an
  // explicit `UPDATE ... SET col = NULL` on a NOT NULL column with a default
  // (e.g. `createdAt DEFAULT now()`) still violates the constraint. This set
  // drives the SET NULL guard on updates.
  const notNullColumns = new Set<string>();

  match.children.forEach((col) => {
    if (col.is_nullable === false) {
      notNullColumns.add(col.name);
      if (!col.has_default) {
        requiredColumns.add(col.name);
      }
    }
    if (col.is_primary_key) return;
    const target = resolveFkTarget(col.name, siblingTables, match.name);
    if (!target) return;
    const pkCol =
      target.children.find((c) => c.is_primary_key)?.name || target.children[0]?.name;
    if (!pkCol) return;
    fkMap.set(col.name, {
      table: target.name,
      schemaName,
      pkColumn: pkCol,
      labelColumn: guessLabelColumn(target),
    });
  });

  return { pkColumns, fkMap, requiredColumns, notNullColumns };
}
