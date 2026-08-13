/**
 * Shared cell-value utilities for the data grid: comparison (for sorting) and
 * filtering. Used by both `DataGrid` (editable table-data grid) and
 * `ReadOnlyGrid` (SQL-editor result panel) so sort/filter behave identically.
 */

import type { EditorKind } from './TypedCellInput';

/** A raw cell value as it arrives from the backend (already decoded). */
export type CellValue = string | number | boolean | null;

// ─── Text-width measurement (for column auto-fit) ───────────────────────────

/** Convert a raw cell value to its display string (matches grid rendering). */
export function cellToText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

let _measureCanvas: HTMLCanvasElement | null = null;
/** Measure the rendered width (px) of a text string in the grid's font
 *  (11–12px monospace). Uses an offscreen canvas — no DOM mutation, so it's
 *  safe to call many times during a double-click. */
export function measureTextWidth(text: string, fontSize = 11): number {
  if (typeof document === 'undefined') return text.length * 7;
  if (!_measureCanvas) {
    _measureCanvas = document.createElement('canvas');
  }
  const ctx = _measureCanvas.getContext('2d');
  if (!ctx) return text.length * 7;
  ctx.font = `${fontSize}px 'JetBrains Mono', 'Fira Code', ui-monospace, monospace`;
  return ctx.measureText(text).width;
}


/** A row is an array of cell values, indexed by column position. */
export type RowData = CellValue[];

// ─── Sorting ────────────────────────────────────────────────────────────────

/**
 * Compare two cell values for grid sorting. Ordering rules:
 *
 * - `null` sorts first (asc), last (desc) — i.e. nulls-first on ascending.
 * - Numbers compare numerically.
 * - Booleans: false < true.
 * - Strings compare via `localeCompare` (case-insensitive, natural numbers).
 * - Dates (ISO strings detected heuristically) compare chronologically.
 * - Mixed types fall back to string comparison to stay total/stable.
 *
 * Returns -1 / 0 / 1 (never NaN).
 */
export function compareCells(a: CellValue, b: CellValue): number {
  // Nulls first on ascending sort.
  if (a === null || a === undefined) {
    return b === null || b === undefined ? 0 : -1;
  }
  if (b === null || b === undefined) return 1;

  // Numbers compare numerically.
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // Booleans: false (0) < true (1).
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }

  // String comparison — try date parsing first if both look like ISO dates,
  // otherwise a natural localeCompare.
  const sa = String(a);
  const sb = String(b);
  if (looksLikeDate(sa) && looksLikeDate(sb)) {
    const ta = Date.parse(sa);
    const tb = Date.parse(sb);
    if (!isNaN(ta) && !isNaN(tb)) {
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    }
  }
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

/** Heuristic: does this string look like a date/datetime we should sort
 *  chronologically rather than lexically? Matches ISO-ish timestamps and
 *  YYYY-MM-DD dates. */
function looksLikeDate(s: string): boolean {
  // YYYY-MM-DD at start, optionally followed by 'T' or space and time.
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/.test(s);
}

// ─── Filtering ──────────────────────────────────────────────────────────────

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'starts'
  | 'ends'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_null'
  | 'is_not_null';

/** A single user-authored filter condition. Multiple conditions are AND-combined. */
export interface FilterCondition {
  /** Stable id for React keying + targeted removal. */
  id: string;
  /** Column name the condition applies to. */
  column: string;
  /** Comparison operator. */
  operator: FilterOp;
  /** Typed comparison value (empty string for is_null / is_not_null). */
  value: string;
}

/** Operators valid for a given editor kind. The UI uses this to populate the
 *  operator dropdown so users can't pick a nonsensical operator (e.g. ">"
 *  on a boolean). */
export function operatorsForKind(kind: EditorKind): FilterOp[] {
  switch (kind) {
    case 'number':
    case 'date':
    case 'datetime':
    case 'time':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'];
    case 'boolean':
      return ['eq', 'is_null', 'is_not_null'];
    case 'json':
      // JSON columns: limited to string-contains + null checks. Structured
      // JSON querying belongs in SQL, not a client filter.
      return ['contains', 'is_null', 'is_not_null'];
    case 'longtext':
    case 'text':
    default:
      return ['eq', 'neq', 'contains', 'starts', 'ends', 'is_null', 'is_not_null'];
  }
}

/** Human-readable label for an operator, shown in the dropdown. */
export function operatorLabel(op: FilterOp): string {
  switch (op) {
    case 'eq': return 'equals';
    case 'neq': return 'not equals';
    case 'contains': return 'contains';
    case 'starts': return 'starts with';
    case 'ends': return 'ends with';
    case 'gt': return '>';
    case 'gte': return '≥';
    case 'lt': return '<';
    case 'lte': return '≤';
    case 'is_null': return 'is NULL';
    case 'is_not_null': return 'is not NULL';
  }
}

/** Does a single cell match a single condition? */
function cellMatches(cell: CellValue, op: FilterOp, filterValue: string, kind: EditorKind): boolean {
  switch (op) {
    case 'is_null':
      return cell === null || cell === undefined;
    case 'is_not_null':
      return cell !== null && cell !== undefined;
  }
  // Remaining operators need a non-null cell.
  if (cell === null || cell === undefined) return false;

  // Numeric / date comparisons — parse both sides as numbers/dates.
  if (kind === 'number') {
    const a = typeof cell === 'number' ? cell : Number(cell);
    const b = Number(filterValue);
    if (isNaN(a) || isNaN(b)) return false;
    switch (op) {
      case 'eq': return a === b;
      case 'neq': return a !== b;
      case 'gt': return a > b;
      case 'gte': return a >= b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
    }
    return false;
  }
  if (kind === 'date' || kind === 'datetime' || kind === 'time') {
    const a = Date.parse(String(cell));
    const b = Date.parse(filterValue);
    if (isNaN(a) || isNaN(b)) return false;
    switch (op) {
      case 'eq': return a === b;
      case 'neq': return a !== b;
      case 'gt': return a > b;
      case 'gte': return a >= b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
    }
    return false;
  }
  if (kind === 'boolean') {
    const a = cell === true || cell === 'true' || cell === 1 || cell === '1' || cell === 't';
    const b = filterValue === 'true' || filterValue === '1' || filterValue === 't';
    return op === 'eq' ? a === b : a !== b; // neq handled above for nulls, but kept for safety
  }

  // Text-ish (and json: best-effort string contains).
  const s = typeof cell === 'object' ? safeStringify(cell) : String(cell);
  const needle = filterValue;
  switch (op) {
    case 'eq': return s === needle;
    case 'neq': return s !== needle;
    case 'contains': return s.toLowerCase().includes(needle.toLowerCase());
    case 'starts': return s.toLowerCase().startsWith(needle.toLowerCase());
    case 'ends': return s.toLowerCase().endsWith(needle.toLowerCase());
    // gt/gte/lt/lte on text fall back to lexical comparison.
    case 'gt': return s > needle;
    case 'gte': return s >= needle;
    case 'lt': return s < needle;
    case 'lte': return s <= needle;
  }
  return false;
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/**
 * Apply a list of AND-combined filter conditions to a set of rows.
 *
 * @param rows       Incoming rows (already loaded).
 * @param conditions Filter conditions (empty array = no filtering).
 * @param columnKinds Map of column name → EditorKind, so numeric/date columns
 *                    compare by value rather than lexically. Columns missing
 *                    from the map default to text comparison.
 * @returns A new filtered array (input is not mutated).
 */
export function applyFilters(
  rows: RowData[],
  conditions: FilterCondition[],
  columnKinds: Map<string, EditorKind>,
  columnIndex: Map<string, number>,
): RowData[] {
  if (!conditions.length) return rows;
  // Drop conditions that have no value and aren't unary (is_null/is_not_null).
  const active = conditions.filter(
    (c) =>
      c.operator === 'is_null' ||
      c.operator === 'is_not_null' ||
      c.value.trim() !== '',
  );
  if (!active.length) return rows;
  return rows.filter((row) =>
    active.every((c) => {
      const idx = columnIndex.get(c.column);
      if (idx === undefined) return true; // unknown column — don't filter it out
      const kind = columnKinds.get(c.column) ?? 'text';
      return cellMatches(row[idx], c.operator, c.value, kind);
    }),
  );
}
