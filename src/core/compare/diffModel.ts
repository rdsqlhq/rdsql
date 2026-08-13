/**
 * Presentation model for the Schema Compare view.
 *
 * The backend (`compare_schema` / `generate_schema_sync_sql`) returns a flat
 * per-table diff and a flat list of DDL statements. Rendering that raw shape
 * means thousands of undifferentiated rows on a real database, so this module
 * reshapes it — **without recomputing anything** — into:
 *
 *   - one `ObjectChange` per changed table/view, with its column changes nested
 *   - a risk level derived from the operations the sync would actually perform
 *   - filter / search / selection helpers over that object list
 *   - a matching view of the generated sync script (counts, destructive ops,
 *     and the statement subset an apply should receive)
 *
 * Every number here is derived from real diff data. Nothing is estimated and
 * no SQL is generated in the frontend — statement text always comes from the
 * backend script verbatim.
 *
 * Direction is always **source → target**: `added` = present in source and
 * missing from target (it would be created), `removed` = present only in the
 * target (it would be dropped).
 */

import type {
  ColumnDiff,
  DiffObjectType,
  DiffStatus,
  SchemaDiffResult,
  SyncOperation,
  SyncStatement,
  TableDiff,
} from '../domain/types';

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

/**
 * How dangerous a change is for the target database.
 *  - `low`    — additive, nothing existing is touched (CREATE TABLE, add nullable column)
 *  - `medium` — rewrites an existing column (type change, NOT NULL, …); data may not survive
 *  - `high`   — removes something that exists in the target (DROP TABLE/COLUMN, PK change)
 */
export type ChangeRisk = 'low' | 'medium' | 'high';

const RISK_ORDER: Record<ChangeRisk, number> = { low: 0, medium: 1, high: 2 };

/** The higher of two risk levels. */
export function maxRisk(a: ChangeRisk, b: ChangeRisk): ChangeRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export const RISK_LABEL: Record<ChangeRisk, string> = {
  low: 'Safe',
  medium: 'Review',
  high: 'Destructive',
};

// ---------------------------------------------------------------------------
// Object-level model
// ---------------------------------------------------------------------------

/** A change to a single column, already classified. */
export interface ColumnChange {
  name: string;
  /** `unchanged` columns are never included. */
  status: Exclude<DiffStatus, 'unchanged'>;
  risk: ChangeRisk;
  /** True when applying this change removes a column from the target. */
  destructive: boolean;
  /** The column definition as it exists (or will exist) in the source. */
  sourceType?: string;
  sourceNullable?: boolean;
  /** The column definition as it exists in the target today. */
  targetType?: string;
  targetNullable?: boolean;
  isPrimaryKey: boolean;
  /** Backend-supplied description, e.g. "type: int → bigint". */
  detail?: string;
}

/** One changed database object (table or view) with its column changes. */
export interface ObjectChange {
  /** `schema.name`, or just `name` when the engine has no schema qualifier.
   *  Matches `SyncStatement.targetObject`, which is how a selection is mapped
   *  back onto generated statements. */
  key: string;
  schema?: string;
  name: string;
  objectType: DiffObjectType;
  /** `added` = create in target, `removed` = drop from target, `modified` = alter. */
  status: Exclude<DiffStatus, 'unchanged'>;
  risk: ChangeRisk;
  /** True when applying this object's changes drops an object or a column. */
  destructive: boolean;
  /** Number of individual differences rolled up under this object. */
  changeCount: number;
  addedColumns: number;
  removedColumns: number;
  modifiedColumns: number;
  rowCountSource?: number | null;
  rowCountTarget?: number | null;
  columns: ColumnChange[];
}

function objectKey(t: Pick<TableDiff, 'schema' | 'name'>): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/**
 * Classify a single column change.
 *
 * `tableStatus` matters: the columns of an added table are created as part of
 * one CREATE TABLE (nothing in the target is touched), and the columns of a
 * removed table all disappear with it.
 */
export function classifyColumn(col: ColumnDiff, tableStatus: DiffStatus): ChangeRisk {
  if (tableStatus === 'added') return 'low';
  if (tableStatus === 'removed') return 'high';

  switch (col.status) {
    case 'added':
      // A new column on an existing table: NOT NULL without a default fails on
      // a non-empty table, so it needs review.
      return col.sourceIsNullable === false ? 'medium' : 'low';
    case 'removed':
      // Dropping a column destroys its data.
      return 'high';
    case 'modified': {
      // A primary-key change rewrites the table's identity — always high.
      if (
        col.sourceIsPrimaryKey !== undefined &&
        col.targetIsPrimaryKey !== undefined &&
        col.sourceIsPrimaryKey !== col.targetIsPrimaryKey
      ) {
        return 'high';
      }
      // Widening/narrowing a type, or tightening nullability, can reject data.
      const typeChanged =
        (col.sourceDataType ?? '').toLowerCase() !== (col.targetDataType ?? '').toLowerCase();
      const tightened = col.targetIsNullable === true && col.sourceIsNullable === false;
      if (typeChanged || tightened) return 'medium';
      // Only loosening nullability (NOT NULL → NULL) is left.
      return 'low';
    }
    default:
      return 'low';
  }
}

function toColumnChange(col: ColumnDiff, tableStatus: DiffStatus): ColumnChange {
  const status = col.status as Exclude<DiffStatus, 'unchanged'>;
  return {
    name: col.name,
    status,
    risk: classifyColumn(col, tableStatus),
    destructive: tableStatus !== 'added' && status === 'removed',
    sourceType: col.sourceDataType,
    sourceNullable: col.sourceIsNullable,
    targetType: col.targetDataType,
    targetNullable: col.targetIsNullable,
    isPrimaryKey: Boolean(
      col.isPrimaryKey ?? col.sourceIsPrimaryKey ?? col.targetIsPrimaryKey
    ),
    detail: col.changeDescription,
  };
}

/**
 * Roll one `TableDiff` up into an `ObjectChange`. Returns `null` for
 * `unchanged` tables — they carry no changes to show.
 */
export function toObjectChange(t: TableDiff): ObjectChange | null {
  if (t.status === 'unchanged') return null;

  const relevant =
    t.status === 'modified' ? t.columns.filter((c) => c.status !== 'unchanged') : t.columns;
  const columns = relevant.map((c) => toColumnChange(c, t.status));

  let risk: ChangeRisk = t.status === 'removed' ? 'high' : 'low';
  let destructive = t.status === 'removed';
  for (const c of columns) {
    risk = maxRisk(risk, c.risk);
    destructive = destructive || c.destructive;
  }

  return {
    key: objectKey(t),
    schema: t.schema,
    name: t.name,
    objectType: t.objectType ?? 'table',
    status: t.status,
    risk,
    destructive,
    // An added/removed object counts every column it brings or takes with it;
    // a modified one counts only what actually differs. Never zero — the
    // object itself is at least one change.
    changeCount: Math.max(columns.length, 1),
    addedColumns: columns.filter((c) => c.status === 'added').length,
    removedColumns: columns.filter((c) => c.status === 'removed').length,
    modifiedColumns: columns.filter((c) => c.status === 'modified').length,
    rowCountSource: t.rowCountSource,
    rowCountTarget: t.rowCountTarget,
    columns,
  };
}

/** Build the object list, sorted by type then qualified name. */
export function buildObjectChanges(diff: SchemaDiffResult): ObjectChange[] {
  const out: ObjectChange[] = [];
  for (const t of diff.tables) {
    const o = toObjectChange(t);
    if (o) out.push(o);
  }
  out.sort((a, b) => {
    if (a.objectType !== b.objectType) return a.objectType === 'table' ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Side-by-side object rows
// ---------------------------------------------------------------------------

/**
 * One line of the table-to-table list: the same object as seen from each side,
 * with its row counts. Objects that are identical in both databases are
 * included (with `change === null`) so the list is a complete inventory rather
 * than only the differences.
 */
export interface ObjectRow {
  key: string;
  schema?: string;
  name: string;
  objectType: DiffObjectType;
  status: DiffStatus;
  risk: ChangeRisk;
  destructive: boolean;
  /** 0 when the object is identical on both sides. */
  changeCount: number;
  inSource: boolean;
  inTarget: boolean;
  rowCountSource?: number | null;
  rowCountTarget?: number | null;
  /** target − source, or `null` when either count is unknown. */
  rowDelta: number | null;
  /** The expandable detail, or `null` for identical objects. */
  change: ObjectChange | null;
}

function rowDelta(source?: number | null, target?: number | null): number | null {
  if (source == null || target == null) return null;
  return target - source;
}

/** Build the full side-by-side list, sorted by type then qualified name. */
export function buildObjectRows(diff: SchemaDiffResult): ObjectRow[] {
  const rows: ObjectRow[] = diff.tables.map((t) => {
    const change = toObjectChange(t);
    return {
      key: objectKey(t),
      schema: t.schema,
      name: t.name,
      objectType: t.objectType ?? 'table',
      status: t.status,
      risk: change?.risk ?? 'low',
      destructive: change?.destructive ?? false,
      changeCount: change?.changeCount ?? 0,
      // `added` exists only in the source, `removed` only in the target.
      inSource: t.status !== 'removed',
      inTarget: t.status !== 'added',
      rowCountSource: t.rowCountSource,
      rowCountTarget: t.rowCountTarget,
      rowDelta: rowDelta(t.rowCountSource, t.rowCountTarget),
      change,
    };
  });
  rows.sort((a, b) => {
    if (a.objectType !== b.objectType) return a.objectType === 'table' ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  return rows;
}

export interface RowTotals {
  objects: number;
  sourceRows: number;
  targetRows: number;
  /** True when a count was missing on either side — the totals are partial. */
  partial: boolean;
}

/** Sum the row counts of a set of rows, for the list footer. */
export function totalRows(rows: ObjectRow[]): RowTotals {
  let sourceRows = 0;
  let targetRows = 0;
  let partial = false;
  for (const r of rows) {
    if (r.inSource) {
      if (r.rowCountSource == null) partial = true;
      else sourceRows += r.rowCountSource;
    }
    if (r.inTarget) {
      if (r.rowCountTarget == null) partial = true;
      else targetRows += r.rowCountTarget;
    }
  }
  return { objects: rows.length, sourceRows, targetRows, partial };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface ChangeSummary {
  /** Objects with at least one difference. */
  affectedObjects: number;
  created: number;
  modified: number;
  removed: number;
  /** Sum of every individual difference across all objects. */
  totalChanges: number;
  /** Objects whose changes drop an object or a column. */
  destructiveObjects: number;
  risk: Record<ChangeRisk, number>;
}

/** Summarize a set of objects. Pass a filtered/selected subset to summarize it. */
export function summarizeObjects(objects: ObjectChange[]): ChangeSummary {
  const summary: ChangeSummary = {
    affectedObjects: objects.length,
    created: 0,
    modified: 0,
    removed: 0,
    totalChanges: 0,
    destructiveObjects: 0,
    risk: { low: 0, medium: 0, high: 0 },
  };
  for (const o of objects) {
    if (o.status === 'added') summary.created += 1;
    else if (o.status === 'removed') summary.removed += 1;
    else summary.modified += 1;
    summary.totalChanges += o.changeCount;
    if (o.destructive) summary.destructiveObjects += 1;
    summary.risk[o.risk] += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Filtering & search
// ---------------------------------------------------------------------------

export type StatusFilter = 'all' | 'added' | 'modified' | 'removed' | 'unchanged';
export type TypeFilter = 'all' | DiffObjectType;
export type RiskFilter = 'all' | ChangeRisk;

export interface ObjectFilter {
  status: StatusFilter;
  objectType: TypeFilter;
  risk: RiskFilter;
  /** Matched against schema, object name and column names, case-insensitively. */
  query: string;
}

export const EMPTY_FILTER: ObjectFilter = {
  status: 'all',
  objectType: 'all',
  risk: 'all',
  query: '',
};

/** The minimum an entry needs to be filtered — satisfied by both
 *  `ObjectChange` and `ObjectRow`. */
interface Filterable {
  key: string;
  status: DiffStatus;
  objectType: DiffObjectType;
  risk: ChangeRisk;
  columns?: readonly { name: string }[];
}

/** True when the object name, or one of its changed column names, matches. */
export function matchesQuery(o: Filterable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (o.key.toLowerCase().includes(q)) return true;
  return (o.columns ?? []).some((c) => c.name.toLowerCase().includes(q));
}

function matchesFilter(o: Filterable, filter: ObjectFilter): boolean {
  if (filter.status !== 'all' && o.status !== filter.status) return false;
  if (filter.objectType !== 'all' && o.objectType !== filter.objectType) return false;
  if (filter.risk !== 'all' && o.risk !== filter.risk) return false;
  return matchesQuery(o, filter.query);
}

export function filterObjects(objects: ObjectChange[], filter: ObjectFilter): ObjectChange[] {
  return objects.filter((o) => matchesFilter(o, filter));
}

/** Same filter applied to the side-by-side list, including identical objects. */
export function filterRows(rows: ObjectRow[], filter: ObjectFilter): ObjectRow[] {
  return rows.filter((r) =>
    matchesFilter({ ...r, columns: r.change?.columns }, filter)
  );
}

/** Object types actually present in this diff — drives which filters are shown. */
export function presentObjectTypes(objects: { objectType: DiffObjectType }[]): DiffObjectType[] {
  const seen = new Set<DiffObjectType>();
  for (const o of objects) seen.add(o.objectType);
  return (['table', 'view'] as DiffObjectType[]).filter((t) => seen.has(t));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Keys of every object whose changes are non-destructive. */
export function safeObjectKeys(objects: ObjectChange[]): string[] {
  return objects.filter((o) => !o.destructive).map((o) => o.key);
}

export function allObjectKeys(objects: ObjectChange[]): string[] {
  return objects.map((o) => o.key);
}

// ---------------------------------------------------------------------------
// Sync script
// ---------------------------------------------------------------------------

/** The three buckets a generated statement can fall into. */
export type StatementKind = 'create' | 'alter' | 'drop';

export function statementKind(op: SyncOperation): StatementKind {
  switch (op) {
    case 'createtable':
      return 'create';
    case 'droptable':
    case 'dropcolumn':
      return 'drop';
    default:
      // addcolumn / altercolumn / raw all ALTER an existing object.
      return 'alter';
  }
}

/** True when the statement removes an object or a column from the target. */
export function isDestructiveStatement(stmt: SyncStatement): boolean {
  return statementKind(stmt.operation) === 'drop';
}

export function statementRisk(op: SyncOperation): ChangeRisk {
  switch (op) {
    case 'createtable':
      return 'low';
    case 'droptable':
    case 'dropcolumn':
      return 'high';
    case 'altercolumn':
      return 'medium';
    case 'addcolumn':
      return 'low';
    default:
      return 'medium';
  }
}

export interface ScriptSummary {
  total: number;
  create: number;
  alter: number;
  drop: number;
  /** Statements that remove something — always equal to `drop` here, kept
   *  separate because the confirmation copy talks about "destructive". */
  destructive: number;
  /** Distinct objects the script touches. */
  objects: number;
}

export function summarizeStatements(statements: SyncStatement[]): ScriptSummary {
  const summary: ScriptSummary = {
    total: statements.length,
    create: 0,
    alter: 0,
    drop: 0,
    destructive: 0,
    objects: 0,
  };
  const objects = new Set<string>();
  for (const s of statements) {
    objects.add(s.targetObject);
    const kind = statementKind(s.operation);
    summary[kind] += 1;
    if (kind === 'drop') summary.destructive += 1;
  }
  summary.objects = objects.size;
  return summary;
}

export interface StatementFilter {
  /** Only keep statements whose `targetObject` is in this set. `null` = keep all. */
  selectedKeys: ReadonlySet<string> | null;
  /** Drop every DROP TABLE / DROP COLUMN statement. */
  excludeDestructive: boolean;
}

/**
 * Narrow a generated script down to the statements an apply should run.
 *
 * This is the only place selection touches the sync flow: the statements
 * themselves are the backend's verbatim output, we just choose a subset. With
 * `selectedKeys: null` and `excludeDestructive: false` the result is the full
 * script, byte for byte — the original full-sync behaviour.
 */
export function filterStatements(
  statements: SyncStatement[],
  filter: StatementFilter
): SyncStatement[] {
  return statements.filter((s) => {
    if (filter.excludeDestructive && isDestructiveStatement(s)) return false;
    if (filter.selectedKeys && !filter.selectedKeys.has(s.targetObject)) return false;
    return true;
  });
}

/** Group statements by their target object, preserving script order. */
export function groupStatementsByObject(
  statements: SyncStatement[]
): { object: string; statements: SyncStatement[] }[] {
  const groups = new Map<string, SyncStatement[]>();
  for (const s of statements) {
    const existing = groups.get(s.targetObject);
    if (existing) existing.push(s);
    else groups.set(s.targetObject, [s]);
  }
  return [...groups.entries()].map(([object, stmts]) => ({ object, statements: stmts }));
}

/** The full script text, exactly as generated, for copy/export. */
export function scriptText(statements: SyncStatement[]): string {
  return statements.map((s) => s.sql).join('\n\n');
}
