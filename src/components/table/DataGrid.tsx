import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
  Undo2,
  Link2,
  Braces,
  Pencil,
  X,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  Columns3,
  Key,
  ListStart,
  Expand,
} from 'lucide-react';
import { QueryColumn, DatabaseConnection } from '../../core/domain/types';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { TypedCellInput, getEditorKind, cellToEditableString, isJsonType } from './TypedCellInput';
import { RelationCellInput } from './RelationCellInput';
import { RelationTarget } from './relationHelpers';
import {
  compareCells,
  applyFilters,
  cellToText,
  measureTextWidth,
  type FilterCondition,
} from './cellUtils';
import { FilterDrawer, type FilterColumn } from './FilterDrawer';
import { RowInspectorPanel } from './RowInspectorPanel';
import { useColumnResize, DEFAULT_COL_WIDTH } from './useColumnResize';

// ─── Public types ───────────────────────────────────────────────────────────

export type CellValue = string | number | boolean | null;
export type RowData = CellValue[];

/** A staged cell edit: { [columnName]: newValue | null }. Keyed by row ref. */
export type RowEdits = Record<string, string | null>;

/** A pending insert row staged in the grid. */
export interface NewGridRow {
  tempId: string;
  values: Record<string, string | null>;
}

export interface DataGridColumn {
  name: string;
  data_type?: string;
  is_primary_key?: boolean;
  /** Show a red "*" marker — column is NOT NULL with no default. */
  is_required?: boolean;
  /** Foreign-key column → renders a link icon in the header. */
  is_foreign_key?: boolean;
  /** Part of a secondary index → renders an index icon in the header. */
  is_indexed?: boolean;
}

export interface DataGridProps {
  columns: DataGridColumn[];
  rows: RowData[];

  // ── Editing ───────────────────────────────────────────────────────────────
  /** When true, double-click enters inline edit mode. */
  editable?: boolean;
  /** Map of row → column edits, controlled by parent. */
  pendingUpdates?: Map<RowData, RowEdits>;
  /** Set of rows marked for deletion, controlled by parent. */
  pendingDeletes?: Set<RowData>;
  /** FK column → target table info, for relation-cell rendering. */
  fkMap?: Map<string, RelationTarget>;
  /** Called when a cell edit is committed (blur / Enter). */
  onCellEdit?: (row: RowData, colName: string, value: string | null) => void;
  /** Called when the user wants to open the full-screen modal editor. */
  onOpenModalEditor?: (row: RowData, colName: string, dataType?: string) => void;
  /** Toggle row delete state. */
  onToggleRowDelete?: (row: RowData) => void;
  /** Connection config for RelationCellInput (FK autocomplete). Omit to disable relation pickers. */
  relationConnection?: DatabaseConnection;
  /** Schema name for FK relation rendering. */
  activeSchema?: string;

  // ── Insert rows ───────────────────────────────────────────────────────────
  /** Pending insert rows (staged, not yet applied to the DB). */
  newRows?: NewGridRow[];
  /** Called when a new-row cell value changes. */
  onNewRowEdit?: (tempId: string, colName: string, value: string | null) => void;
  /** Remove a pending insert row. */
  onNewRowRemove?: (tempId: string) => void;
  /** Open the full-screen modal editor for a new-row cell. */
  onNewRowOpenModal?: (tempId: string, colName: string, dataType?: string) => void;

  // ── Selection ─────────────────────────────────────────────────────────────
  selectedRows?: Set<RowData>;
  onToggleSelectRow?: (row: RowData) => void;
  onToggleSelectAll?: (checked: boolean) => void;

  // ── Context menu ──────────────────────────────────────────────────────────
  onCellContextMenu?: (e: React.MouseEvent, row: RowData, colName: string) => void;

  // ── Row number offset (for server-side pagination). ──────────────────────
  rowNumberOffset?: number;

  // ── Sort + filter (controlled from the parent toolbar). ───────────────────
  /** Active sort, keyed by column NAME (not index — indices shift with hidden
   *  columns, and a name is what a parent needs to build a server-side
   *  `ORDER BY`). `null` = unsorted. Header clicks call `onSortChange`. */
  sortState?: { column: string; dir: 'asc' | 'desc' } | null;
  onSortChange?: (s: { column: string; dir: 'asc' | 'desc' } | null) => void;
  /** Active filter conditions. AND-combined. */
  filterConditions?: FilterCondition[];
  onFilterChange?: (c: FilterCondition[]) => void;
  /** Whether the filter drawer is open (parent owns the toggle button). */
  filterOpen?: boolean;
  onFilterOpenChange?: (open: boolean) => void;
  /** Row shown in the docked row-inspector panel. `null`/`undefined` = closed.
   *  Uncontrolled by default (the "#" gutter's expand icon manages it
   *  internally); pass both props to also open it from elsewhere, e.g. a
   *  "Inspect Row" item in the parent's own row context menu. */
  inspectedRow?: RowData | null;
  onInspectedRowChange?: (row: RowData | null) => void;

  /** Stable key for persisting column widths + hidden columns to localStorage.
   *  Omit to disable persistence (state resets on remount). */
  columnStorageKey?: string;
}

// ─── Layout constants ───────────────────────────────────────────────────────
//
// The grid body is div/flexbox, NOT a <table>. A native <table> re-runs its
// (expensive) layout algorithm whenever rows are added/removed — which
// virtualization does constantly — and that recalculation is what showed up
// as a freeze/stutter on fast scroll in BOTH directions (horizontal scroll
// never touched React state at all, so a table-layout cost was the only thing
// that could explain it happening there too). Div rows are absolutely
// positioned (via `top`, computed from the row index — see ROW_HEIGHT below)
// so adding/removing one never affects any sibling's layout, and plain
// fixed-width flex cells never invoke a table layout pass at all.

const ROW_HEIGHT = 30; // px — matches the old py-1.5 + text-xs line height
const HEADER_HEIGHT = 33; // px — matches the old thead (py-2 + text)
// Generous overscan so fast scrolling reveals already-rendered rows instead
// of bare (unrendered) space before the next frame catches up.
const OVERSCAN = 20;

// Fixed-width gutter columns (px equivalents of the old w-9/w-10/w-8 classes).
const SELECT_COL_W = 36;
const DELETE_COL_W = 40;
const ROWNUM_COL_W = 40;
const COLTOGGLE_COL_W = 32;
const EMPTY_STATE_H = 96;

// ─── Cell content (read mode) ───────────────────────────────────────────────

/** Pure cell display — no handlers, no hover effects. Cheap to render. */
const CellContent: React.FC<{
  value: CellValue;
  editorKind: ReturnType<typeof getEditorKind>;
  relation?: RelationTarget;
  isRequired: boolean;
}> = React.memo(({ value, editorKind, relation, isRequired }) => {
  if (value === null || value === undefined) {
    return <span className={isRequired ? 'text-red-500/80 italic' : 'text-slate-600 italic'}>NULL</span>;
  }
  if (relation) {
    return (
      <>
        <Link2 className="w-3 h-3 text-cyan-500 shrink-0" />
        <span className="truncate text-cyan-300">{String(value)}</span>
      </>
    );
  }
  if (editorKind === 'json') {
    return (
      <>
        <Braces className="w-3 h-3 text-amber-400 shrink-0" />
        <span className="truncate">{String(value)}</span>
      </>
    );
  }
  return <span className="truncate">{String(value)}</span>;
});
CellContent.displayName = 'CellContent';

// ─── DataGrid ───────────────────────────────────────────────────────────────

export const DataGrid: React.FC<DataGridProps> = ({
  columns,
  rows,
  editable = false,
  pendingUpdates,
  pendingDeletes,
  fkMap,
  onCellEdit,
  onOpenModalEditor,
  onToggleRowDelete,
  relationConnection,
  activeSchema,
  newRows,
  onNewRowEdit,
  onNewRowRemove,
  onNewRowOpenModal,
  selectedRows,
  onToggleSelectRow,
  onToggleSelectAll,
  onCellContextMenu,
  rowNumberOffset = 0,
  sortState: controlledSort,
  onSortChange,
  filterConditions: controlledFilters,
  onFilterChange,
  filterOpen: controlledFilterOpen,
  onFilterOpenChange,
  inspectedRow: controlledInspectRow,
  onInspectedRowChange,
  columnStorageKey,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);

  // Inline edit state — local to the grid so parents stay simple.
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; colIdx: number } | null>(null);
  const [draft, setDraftState] = useState('');
  // `draftRef` mirrors `draft` SYNCHRONOUSLY so commitEdit always reads the
  // latest value — even when commit fires in the same tick as the edit (e.g.
  // a date picker that fires onChange then immediately onBlur). The old
  // useEffect-based mirror lagged by a render and lost the just-typed value.
  const draftRef = useRef('');
  const setDraft = useCallback((v: string) => {
    draftRef.current = v;
    setDraftState(v);
  }, []);
  // Track which new row should auto-focus its first cell. Set by the parent
  // via `focusNewRowId` prop when Insert Row is clicked.
  const focusNewRowId = newRows && newRows.length > 0 ? newRows[newRows.length - 1].tempId : null;
  // Which new rows have already received their one-time auto-focus. Without
  // this, the ref callback below (an inline function, so React treats it as
  // "new" every render) re-fires and re-focuses the first column's input on
  // every keystroke in ANY other column — editing "name" would yank focus
  // back to "id" after every character.
  const autoFocusedNewRowIds = useRef<Set<string>>(new Set());

  // Click-outside: when a cell is being edited and the user clicks outside
  // the editing cell (but not on a RelationCellInput dropdown or the Flatpickr
  // calendar popup — both are fixed-position portals to document.body), commit
  // the edit. Without the Flatpickr exclusion, clicking a date in the popup
  // would commit the stale draft before the picker's onChange fired, so the
  // selected date never landed in the cell.
  const editingCellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!editingCell) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Don't commit if clicking inside the editing cell.
      if (editingCellRef.current?.contains(target)) return;
      // Don't commit if clicking inside the relation dropdown portal.
      if ((target as HTMLElement)?.closest('[data-relation-dropdown]')) return;
      // Don't commit if clicking inside the Flatpickr calendar popup
      // (the date/time popover is portaled to document.body).
      if ((target as HTMLElement)?.closest('.flatpickr-calendar')) return;
      commitEdit();
    };
    // Use mousedown with a slight delay so it doesn't fire before the
    // double-click that started the edit.
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [editingCell]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll tracking (rAF-throttled) ───────────────────────────────────────
  // Only setScrollTop on scroll — viewportH changes only on resize (handled
  // by the ResizeObserver below).
  const rafRef = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Seed the real height immediately so the first paint renders the correct
    // number of rows (the initial 400px default could under-render on mount).
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Row inspector (docked right panel) ────────────────────────────────────
  // Controlled-or-internal, same pattern as sort/filter above: the "#"
  // gutter's expand icon manages it internally by default, but a parent can
  // also open it from elsewhere (e.g. its own row context menu) by passing
  // `inspectedRow`/`onInspectedRowChange`. Keyed by row reference (same
  // identity convention as `selectedRows`/`pendingUpdates`), so it's reset
  // below whenever the row set genuinely changes (a stale reference would
  // show stale data).
  const [internalInspectRow, setInternalInspectRow] = useState<RowData | null>(null);
  const inspectRow = controlledInspectRow !== undefined ? controlledInspectRow : internalInspectRow;
  const setInspectRow = onInspectedRowChange ?? setInternalInspectRow;
  const { gridRowInspectorWidth, setGridRowInspectorWidth, zoomLevel } = useWorkspaceStore();
  const gridRowRef = useRef<HTMLDivElement>(null);
  const [isResizingInspector, setIsResizingInspector] = useState(false);
  useEffect(() => {
    if (!isResizingInspector) return;
    const handleMouseMove = (e: MouseEvent) => {
      const rowRight = gridRowRef.current?.getBoundingClientRect().right;
      if (rowRight === undefined) return;
      setGridRowInspectorWidth((rowRight - e.clientX) / zoomLevel);
    };
    const handleMouseUp = () => setIsResizingInspector(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingInspector, setGridRowInspectorWidth, zoomLevel]);

  // ── Sort + Filter (controlled-or-internal) ────────────────────────────────
  // Sorting reorders a shallow copy of `rows`, so row object identity is
  // preserved and pending-edit lookups (keyed by row reference) still work.
  // Filtering reduces the visible set. Both compose: filter → sort → virtualize.
  //
  // The parent toolbar owns the Filter button + drawer toggle. When the parent
  // passes controlled props, we use them; otherwise we fall back to internal
  // state so the grid still works standalone.
  const [internalSort, setInternalSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [internalFilters, setInternalFilters] = useState<FilterCondition[]>([]);
  const [internalFilterOpen, setInternalFilterOpen] = useState(false);

  const sortState = controlledSort !== undefined ? controlledSort : internalSort;
  const filterConditions = controlledFilters !== undefined ? controlledFilters : internalFilters;
  const filterOpen = controlledFilterOpen !== undefined ? controlledFilterOpen : internalFilterOpen;
  const setSortState = onSortChange ?? setInternalSort;
  const setFilterConditions = onFilterChange ?? setInternalFilters;
  const setFilterOpen = onFilterOpenChange ?? setInternalFilterOpen;

  // Column metadata for the filter drawer (name + editor kind + raw type).
  const filterColumns: FilterColumn[] = useMemo(
    () => columns.map((c) => ({ name: c.name, kind: getEditorKind(c.data_type), data_type: c.data_type })),
    [columns],
  );
  const columnKinds = useMemo(() => {
    const m = new Map<string, ReturnType<typeof getEditorKind>>();
    columns.forEach((c) => m.set(c.name, getEditorKind(c.data_type)));
    return m;
  }, [columns]);
  const columnIndex = useMemo(() => {
    const m = new Map<string, number>();
    columns.forEach((c, i) => m.set(c.name, i));
    return m;
  }, [columns]);

  // Hide/show columns. Hidden columns are excluded from the rendered header
  // and body cells. Owned internally; toggled via the toolbar dropdown.
  // Persisted to localStorage when `columnStorageKey` is provided.
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    if (!columnStorageKey) return new Set();
    try {
      const raw = localStorage.getItem(`rdsql_col_hidden_${columnStorageKey}`);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  useEffect(() => {
    if (!columnStorageKey) return;
    try {
      localStorage.setItem(`rdsql_col_hidden_${columnStorageKey}`, JSON.stringify([...hiddenCols]));
    } catch { /* ignore */ }
  }, [columnStorageKey, hiddenCols]);
  const visibleColumns = useMemo(() => columns.filter((c) => !hiddenCols.has(c.name)), [columns, hiddenCols]);

  const displayRows = useMemo(() => {
    let out: RowData[] = rows;
    if (filterConditions.length) {
      out = applyFilters(out, filterConditions, columnKinds, columnIndex);
    }
    if (sortState) {
      const rawIdx = columnIndex.get(sortState.column);
      if (rawIdx !== undefined) {
        const sorted = [...out].sort((a, b) => compareCells(a[rawIdx], b[rawIdx]));
        out = sortState.dir === 'desc' ? sorted.reverse() : sorted;
      }
    }
    return out;
  }, [rows, filterConditions, columnKinds, columnIndex, sortState]);

  const toggleSort = useCallback(
    (column: string) => {
      const next = (() => {
        if (!sortState || sortState.column !== column) return { column, dir: 'asc' as const };
        if (sortState.dir === 'asc') return { column, dir: 'desc' as const };
        return null;
      })();
      setSortState(next);
    },
    [sortState, setSortState],
  );

  // Reset sort/filter when the column set genuinely changes so a stale sort
  // index doesn't point at a column that no longer exists.
  const colsKey = columns.map((c) => c.name).join(',');
  // didLockRef prevents re-measuring column widths after the first snapshot.
  const didLockRef = useRef(false);
  useEffect(() => {
    setSortState(null);
    setFilterConditions([]);
    didLockRef.current = false;
  }, [colsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore hidden-column preferences when the storage key changes (e.g. the
  // user switches to a different table). The hook above restores widths; here
  // we restore hidden columns from the same localStorage namespace.
  useEffect(() => {
    if (!columnStorageKey) { setHiddenCols(new Set()); return; }
    try {
      const raw = localStorage.getItem(`rdsql_col_hidden_${columnStorageKey}`);
      setHiddenCols(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    } catch { setHiddenCols(new Set()); }
  }, [columnStorageKey]);

  // ── Visible row window ────────────────────────────────────────────────────
  const vStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const vCount = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2;
  const vEnd = Math.min(displayRows.length, vStart + vCount);
  const vRows = displayRows.slice(vStart, vEnd);

  const hasSelection = !!selectedRows && !!onToggleSelectRow;
  const hasDelete = !!onToggleRowDelete && editable;

  // Per-column resize (drag the handle on the right edge of any header).
  // `measureColumn` powers double-click-to-autofit: it measures the natural
  // text width of the header + visible body cells (via canvas, independent of
  // the column's current width) so the column can shrink OR grow to fit.
  //
  // Reads `vRows` via a ref instead of closing over it directly. `vRows` is a
  // fresh slice on every vertical-scroll-triggered render, so having it in
  // this useCallback's deps gave `measureColumn` a new identity on every
  // scroll frame — which cascaded into the auto-fit-lock effect below
  // (`measureColumn` is one of its deps) tearing down and re-running every
  // frame too, even though it's a no-op after the first lock. The ref keeps
  // `measureColumn` stable across scroll while still reading fresh rows
  // whenever it's actually called (double-click-to-autofit, or the one-time
  // lock).
  const vRowsRef = useRef(vRows);
  vRowsRef.current = vRows;
  const measureColumn = useCallback(
    (name: string): number | null => {
      const rawIdx = columnIndex.get(name);
      if (rawIdx === undefined) return null;
      const col = columns.find((c) => c.name === name);
      // Header text — include the required "*" marker + type label if present.
      let maxW = 0;
      const headerText = name + (col?.is_required ? ' *' : '') + (col?.data_type ? ` ${col.data_type}` : '');
      maxW = Math.max(maxW, measureTextWidth(headerText, 12));
      // Body cells from the visible window + new rows. Measure display text,
      // not the DOM — this is width-agnostic so shrink/grow both work.
      const samples: unknown[] = [];
      vRowsRef.current.forEach((row) => samples.push(row[rawIdx]));
      (newRows || []).forEach((nr) => samples.push(nr.values[name] ?? null));
      samples.forEach((v) => { maxW = Math.max(maxW, measureTextWidth(cellToText(v), 12)); });
      // px-3 padding both sides (12px each) + a little slack.
      return maxW > 0 ? maxW + 28 : null;
    },
    [columnIndex, columns, newRows],
  );
  const { widths: colWidths, startResize, lockWidths, autoFitColumn } =
    useColumnResize(columnStorageKey, measureColumn);
  // Every column always renders at an explicit pixel width (no table-auto
  // equivalent here) — DEFAULT_COL_WIDTH until the auto-fit-lock effect below
  // snapshots real widths, then whatever's in `colWidths` (auto-fit or a
  // manual drag).
  const colWidth = useCallback((name: string) => colWidths.get(name) ?? DEFAULT_COL_WIDTH, [colWidths]);

  // Hide/show columns dropdown state (the toggle lives in the header).
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setColMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colMenuOpen]);

  useEffect(() => {
    if (didLockRef.current) return;
    if (!visibleColumns.length || !rows.length) return;
    // Snapshot on the next frame so the browser has laid out the visible
    // rows this measurement reads from.
    const id = requestAnimationFrame(() => {
      const m = new Map<string, number>();
      visibleColumns.forEach((c) => {
        const w = measureColumn(c.name);
        if (w && w > 0) m.set(c.name, w);
      });
      if (m.size) {
        lockWidths(m);
        didLockRef.current = true;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [visibleColumns, rows.length, lockWidths, measureColumn]);

  // ── Inline edit helpers ───────────────────────────────────────────────────
  // Track the original (pre-edit) value so commitEdit can skip staging a
  // no-op change — editing "546" back to "546" shouldn't create a pending
  // update that forces an unnecessary Apply Changes round-trip.
  const originalValueRef = useRef<string>('');

  const startEdit = useCallback((rowIdx: number, colIdx: number) => {
    const row = displayRows[rowIdx];
    if (!row) return;
    // colIdx is the visible-column index; map it to the raw row index so we
    // read the right cell (hidden columns are skipped in rendering).
    const col = visibleColumns[colIdx];
    const colName = col?.name;
    const rawColIdx = columnIndex.get(colName ?? '') ?? colIdx;
    const edits = pendingUpdates?.get(row);
    const hasEdit = edits && colName && Object.prototype.hasOwnProperty.call(edits, colName);
    const val = hasEdit ? edits![colName] : row[rawColIdx];
    // Serialize via cellToEditableString so object values (JSON/JSONB columns,
    // which arrive from the backend as parsed JS objects) become pretty JSON
    // instead of "[object Object]". Primitives pass through as plain strings.
    const jsonCol = isJsonType(col?.data_type);
    const draftVal = cellToEditableString(val, jsonCol) ?? '';
    setDraft(draftVal);
    // Track the raw DB value (not the pending-edit value) so that editing a
    // cell back to its original DB value removes the pending edit entirely.
    const rawVal = row[rawColIdx];
    originalValueRef.current = cellToEditableString(rawVal, jsonCol) ?? '';
    setEditingCell({ rowIdx, colIdx });
  }, [displayRows, visibleColumns, columnIndex, pendingUpdates]);

  const commitEdit = useCallback((overrideValue?: string) => {
    if (!editingCell) { setEditingCell(null); return; }
    const { rowIdx, colIdx } = editingCell;
    setEditingCell(null);
    if (!onCellEdit) return;
    const row = displayRows[rowIdx];
    const colName = visibleColumns[colIdx]?.name;
    if (!row || !colName) return;
    const val = overrideValue !== undefined ? overrideValue : draftRef.current;
    // Skip staging if the value didn't actually change from the original DB value.
    if (val === originalValueRef.current) return;
    onCellEdit(row, colName, val === '' ? null : val);
  }, [editingCell, displayRows, visibleColumns, onCellEdit]);

  const discardEdit = useCallback(() => setEditingCell(null), []);

  // Reset edit state when the row/column set genuinely changes (page switch,
  // refresh). Use a composite key derived from row count + first/last row
  // identity rather than the array reference — parent re-renders often create
  // new array references without the data actually changing, which would
  // prematurely kill an in-progress edit (especially RelationCellInput whose
  // async search causes parent re-renders).
  const rowsKey = `${rows.length}::${rows[0]?.[0]}::${rows[rows.length - 1]?.[0] ?? ''}`;
  useEffect(() => { setEditingCell(null); }, [rowsKey, colsKey]);
  // The inspected row is held by reference — a genuinely new row set means
  // that reference is stale, so close the panel rather than show old data.
  useEffect(() => { setInspectRow(null); }, [rowsKey, colsKey]);

  // Position of the inspected row within the current (filtered+sorted) set —
  // used for its "#N" header. If the row fell out of view (filtered away)
  // this comes back -1 and the panel simply doesn't render.
  const inspectIdx = inspectRow ? displayRows.indexOf(inspectRow) : -1;

  // ── Grid geometry (div/flex body — see the Layout constants comment) ─────
  const totalWidth =
    (hasSelection ? SELECT_COL_W : 0) +
    (hasDelete ? DELETE_COL_W : 0) +
    ROWNUM_COL_W +
    visibleColumns.reduce((sum, c) => sum + colWidth(c.name), 0) +
    COLTOGGLE_COL_W;
  const showEmpty = rows.length === 0 && (!newRows || newRows.length === 0);
  const bodyRowCount = displayRows.length + (newRows?.length ?? 0);
  const totalHeight = HEADER_HEIGHT + bodyRowCount * ROW_HEIGHT + (showEmpty ? EMPTY_STATE_H : 0);

  return (
    <>
      <FilterDrawer
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        conditions={filterConditions}
        onChange={setFilterConditions}
        columns={filterColumns}
      />
      <div className="flex-1 flex flex-row min-h-0" ref={gridRowRef}>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-w-0 overflow-auto bg-[#06090e]">
        <div
          className="relative text-left text-xs font-mono text-slate-200"
          style={{ width: totalWidth, minWidth: '100%', height: totalHeight }}
        >
          {/* ── Header (sticky within the scroll container) ──────────────── */}
          <div
            className="sticky top-0 z-10 flex bg-[#0f172a] border-b border-[#1e293b] text-slate-400 uppercase text-[10px] tracking-wider"
            style={{ height: HEADER_HEIGHT, width: totalWidth }}
          >
            {hasSelection && (
              <div
                className="flex items-center justify-center shrink-0 border-r border-[#1e293b]"
                style={{ width: SELECT_COL_W }}
              >
                <input
                  type="checkbox"
                  checked={!!selectedRows && selectedRows.size > 0 && selectedRows.size === displayRows.length}
                  onChange={(e) => onToggleSelectAll?.(e.target.checked)}
                  className="rounded border-[#1e293b] text-blue-600 focus:ring-0 cursor-pointer"
                />
              </div>
            )}
            {hasDelete && (
              <div
                className="flex items-center justify-center shrink-0 border-r border-[#1e293b] text-slate-500"
                style={{ width: DELETE_COL_W }}
              >
                🗑
              </div>
            )}
            <div
              className="flex items-center justify-center shrink-0 border-r border-[#1e293b] text-slate-500"
              style={{ width: ROWNUM_COL_W }}
            >
              #
            </div>
            {visibleColumns.map((col) => {
              const isSorted = sortState?.column === col.name;
              const sortDir = isSorted ? sortState!.dir : null;
              const w = colWidth(col.name);
              return (
                <div
                  key={col.name}
                  onClick={() => toggleSort(col.name)}
                  style={{ width: w }}
                  className={`relative flex items-center px-3 shrink-0 border-r border-[#1e293b] cursor-pointer select-none hover:bg-[#141e33] ${
                    isSorted ? 'text-cyan-300' : ''
                  }`}
                  title={`Sort by ${col.name}`}
                >
                  <div className="flex items-center justify-between gap-1 w-full min-w-0">
                    <span className="flex items-center gap-0.5 truncate">
                      {/* Key / FK / index badges — compact, only the relevant ones. */}
                      {(col.is_primary_key || col.is_foreign_key || col.is_indexed) && (
                        <span className="flex items-center gap-0.5 mr-0.5 shrink-0">
                          {col.is_primary_key && (
                            <span title="Primary key"><Key className="w-3 h-3 text-amber-400" /></span>
                          )}
                          {col.is_foreign_key && (
                            <span title="Foreign key"><Link2 className="w-3 h-3 text-cyan-400" /></span>
                          )}
                          {col.is_indexed && !col.is_primary_key && (
                            <span title="Indexed"><ListStart className="w-3 h-3 text-purple-400" /></span>
                          )}
                        </span>
                      )}
                      {col.name}
                      {col.is_required && (
                        <span className="text-red-500 ml-0.5" title="Required — NOT NULL with no default">*</span>
                      )}
                      {sortDir === 'asc' && <ArrowUp className="w-3 h-3 text-cyan-400 shrink-0" />}
                      {sortDir === 'desc' && <ArrowDown className="w-3 h-3 text-cyan-400 shrink-0" />}
                      {!sortDir && (
                        <ChevronsUpDown className="w-3 h-3 text-slate-700 opacity-0 group-hover/th:opacity-100 shrink-0" />
                      )}
                    </span>
                    {col.data_type && <span className="text-[9px] text-slate-600 lowercase shrink-0">{col.data_type}</span>}
                  </div>
                  {/* Resize handle — drag to resize, double-click to auto-fit
                      the column to its content width. */}
                  <div
                    onMouseDown={startResize(col.name)}
                    onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(col.name); }}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-0 right-[-2px] h-full w-1.5 cursor-col-resize hover:bg-cyan-500/40 z-20"
                    title="Drag to resize · Double-click to auto-fit"
                  />
                </div>
              );
            })}
            {/* Hide/show columns toggle. */}
            <div
              className="relative flex items-center justify-center shrink-0 text-center text-slate-500"
              style={{ width: COLTOGGLE_COL_W }}
            >
              <div ref={colMenuRef} className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setColMenuOpen((v) => !v); }}
                  className={`p-0.5 rounded hover:bg-[#1e293b] transition-colors ${hiddenCols.size > 0 ? 'text-cyan-400' : 'text-slate-500'}`}
                  title="Hide/show columns"
                >
                  <Columns3 className="w-3.5 h-3.5" />
                </button>
                {colMenuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-full mt-1 z-50 bg-[#0a0f18] border border-[#1e293b] rounded-lg shadow-2xl py-1 min-w-[180px] max-h-72 overflow-y-auto text-left normal-case"
                  >
                    <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-slate-500">Columns</div>
                    {columns.map((c) => {
                      const checked = !hiddenCols.has(c.name);
                      return (
                        <label key={c.name} className="flex items-center gap-2 px-2.5 py-1 hover:bg-[#141e33] cursor-pointer text-[11px] text-slate-200 font-normal">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setHiddenCols((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.name)) next.delete(c.name);
                                else next.add(c.name);
                                return next;
                              });
                            }}
                            className="rounded border-[#1e293b] text-blue-600 focus:ring-0"
                          />
                          <span className="truncate">{c.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Virtualized rows (absolutely positioned — see the Layout
              constants comment for why) ──────────────────────────────────── */}
          {vRows.map((row, vi) => {
            const rowIdx = vStart + vi;
            const absoluteIdx = rowNumberOffset + rowIdx + 1;
            const isSelected = selectedRows?.has(row) ?? false;
            const isDeleted = pendingDeletes?.has(row) ?? false;
            const rowEdits = pendingUpdates?.get(row);
            return (
              <div
                // Keyed by slot position (vi), not absolute row index — an
                // index-based key changes identity for almost every row on
                // every scroll tick, forcing React to unmount+remount nearly
                // every row instead of recycling the same DOM nodes.
                key={vi}
                style={{ position: 'absolute', top: HEADER_HEIGHT + rowIdx * ROW_HEIGHT, left: 0, width: totalWidth, height: ROW_HEIGHT }}
                // No `transition-colors`: as rows scroll past a stationary
                // cursor, each one fires a hover-in/hover-out, and an
                // interpolated transition on that is continuous repaint work
                // fighting the scroll compositor. An instant hover has none.
                className={`flex border-b border-[#1e293b]/50 ${
                  isDeleted
                    ? 'bg-red-950/20 text-red-400/70 line-through'
                    : isSelected
                    ? 'bg-blue-600/20 font-semibold'
                    : rowEdits
                    ? 'bg-amber-500/5'
                    : 'hover:bg-[#141e33]'
                }`}
              >
                {hasSelection && (
                  <div
                    className="flex items-center justify-center shrink-0 border-r border-[#1e293b]/50"
                    style={{ width: SELECT_COL_W }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelectRow?.(row)}
                      className="rounded border-[#1e293b] text-blue-600 focus:ring-0 cursor-pointer"
                    />
                  </div>
                )}
                {hasDelete && (
                  <div
                    className="flex items-center justify-center shrink-0 border-r border-[#1e293b]/50"
                    style={{ width: DELETE_COL_W }}
                  >
                    <button
                      onClick={() => onToggleRowDelete?.(row)}
                      className={`p-0.5 rounded hover:bg-[#1e293b] transition-colors ${
                        isDeleted ? 'text-red-400' : 'text-slate-600 hover:text-red-400'
                      }`}
                      title={isDeleted ? 'Undo delete' : 'Mark row for deletion'}
                    >
                      {isDeleted ? <Undo2 className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                    </button>
                  </div>
                )}
                <div
                  onClick={() => setInspectRow(row)}
                  className="group/rownum flex items-center justify-center shrink-0 border-r border-[#1e293b] text-slate-500 select-none text-[11px] cursor-pointer"
                  style={{ width: ROWNUM_COL_W }}
                  title="Inspect row"
                >
                  <span className="group-hover/rownum:hidden">{absoluteIdx}</span>
                  <Expand className="w-3 h-3 mx-auto hidden group-hover/rownum:block text-cyan-400" />
                </div>
                {visibleColumns.map((col, colIdx) => {
                  const rawColIdx = columnIndex.get(col.name) ?? colIdx;
                  const cell = row[rawColIdx];
                  const colName = col.name;
                  const isEditing = editingCell?.rowIdx === rowIdx && editingCell?.colIdx === colIdx;
                  const hasPendingEdit = rowEdits && colName && Object.prototype.hasOwnProperty.call(rowEdits, colName);
                  const displayValue = hasPendingEdit ? rowEdits![colName] : cell;
                  const editorKind = getEditorKind(col?.data_type);
                  const relation = fkMap?.get(colName);
                  const w = colWidth(colName);

                  return (
                    <div
                      key={colIdx}
                      ref={isEditing ? (el: HTMLDivElement | null) => {
                        editingCellRef.current = el;
                        // Focus the first input/select inside the editing cell,
                        // matching the new-row approach (external focus via ref,
                        // not React autoFocus). This ensures the RelationCellInput
                        // receives focus after layout is ready, so its dropdown
                        // portal can compute correct coordinates.
                        if (el) {
                          const input = el.querySelector('input, select, textarea');
                          if (input) setTimeout(() => (input as HTMLElement).focus(), 0);
                        }
                      } : undefined}
                      onDoubleClick={() => {
                        if (isDeleted || !editable) return;
                        startEdit(rowIdx, colIdx);
                      }}
                      onContextMenu={(e) => onCellContextMenu?.(e, row, colName || '')}
                      style={{ width: w, height: ROW_HEIGHT }}
                      className={`group/cell relative flex items-center px-3 shrink-0 border-r border-[#1e293b]/50 min-w-0 ${
                        isEditing ? 'overflow-visible' : 'overflow-hidden'
                      } ${
                        !isDeleted && editable ? 'cursor-text' : ''
                      } ${hasPendingEdit ? 'bg-amber-500/10' : ''}`}
                    >
                      {isEditing ? (
                        relation && relationConnection ? (
                          <RelationCellInput
                            connection={relationConnection}
                            targetTable={relation.table}
                            targetSchemaName={relation.schemaName}
                            targetPkColumn={relation.pkColumn}
                            targetLabelColumn={relation.labelColumn ?? null}
                            value={draft}
                            onChange={setDraft}
                            // Pass the selected value directly to commit — don't
                            // rely on `draft` state which may not have flushed
                            // when commitEdit runs in the setTimeout.
                            onSelect={(selectedValue) => {
                              commitEdit(selectedValue);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') discardEdit();
                              else if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                            }}
                            className={`w-full h-6 box-border flex items-center bg-[#0f172a] border rounded px-1.5 text-xs text-slate-100 font-mono border-blue-500`}
                          />
                        ) : (
                          <InlineCellEditor
                            kind={editorKind}
                            value={draft}
                            onChange={setDraft}
                            onCommit={commitEdit}
                            onDiscard={discardEdit}
                            autoFocus
                          />
                        )
                      ) : (
                        <>
                          <span className="inline-flex items-center gap-1 truncate min-w-0">
                            <CellContent
                              value={displayValue as CellValue}
                              editorKind={editorKind}
                              relation={relation}
                              isRequired={!!col?.is_required}
                            />
                          </span>
                          {/* Hover pencil — opens the full-screen modal editor
                              for long text / focused editing. Only shown when
                              an onOpenModalEditor handler is provided and the
                              cell isn't deleted. */}
                          {!isDeleted && onOpenModalEditor && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenModalEditor(row, colName || '', col?.data_type);
                              }}
                              // No `transition-opacity` — every cell the
                              // cursor passes over during a scroll would
                              // otherwise animate this, same reasoning as the
                              // row's hover transition above.
                              className="absolute top-1/2 right-0.5 -translate-y-1/2 shrink-0 p-0.5 rounded text-slate-600 hover:text-blue-400 hover:bg-[#1e293b] opacity-0 group-hover/cell:opacity-100 focus:opacity-100"
                              title="Open in editor"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Pending insert rows — always fully mounted (not virtualized)
              since there are typically only 1-3 at a time, placed right after
              the (virtualized) main row set. Each cell is directly editable
              (no double-click needed) and has emerald styling. */}
          {newRows && newRows.length > 0 && newRows.map((nr, nrIdx) => (
            <div
              key={nr.tempId}
              style={{
                position: 'absolute',
                top: HEADER_HEIGHT + (displayRows.length + nrIdx) * ROW_HEIGHT,
                left: 0,
                width: totalWidth,
                height: ROW_HEIGHT,
              }}
              className="flex bg-emerald-600/10 border-b border-emerald-500/20"
            >
              {hasSelection && <div className="shrink-0 border-r border-[#1e293b]/50" style={{ width: SELECT_COL_W }} />}
              <div
                className="flex items-center justify-center shrink-0 border-r border-[#1e293b]/50 text-emerald-400 text-[9.5px] font-bold gap-1"
                style={{ width: ROWNUM_COL_W }}
              >
                {onNewRowRemove && (
                  <button
                    onClick={() => onNewRowRemove(nr.tempId)}
                    className="text-red-400 hover:text-red-300"
                    title="Discard new row"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              {visibleColumns.map((col, colIdx) => {
                const rawVal = nr.values[col.name] ?? null;
                const relation = fkMap?.get(col.name);
                const isEmpty = rawVal === null || rawVal === undefined || rawVal === '';
                const invalid = col.is_required && isEmpty;
                const w = colWidth(col.name);
                return (
                  <div
                    key={col.name}
                    ref={
                      colIdx === 0 && nr.tempId === focusNewRowId
                        ? (el: HTMLDivElement | null) => {
                            if (el && !autoFocusedNewRowIds.current.has(nr.tempId)) {
                              const input = el.querySelector('input, select, textarea');
                              if (input) {
                                autoFocusedNewRowIds.current.add(nr.tempId);
                                setTimeout(() => (input as HTMLElement).focus(), 0);
                              }
                            }
                          }
                        : undefined
                    }
                    className="flex items-center px-1 shrink-0 border-r border-[#1e293b]/50 min-w-0"
                    style={{ width: w, height: ROW_HEIGHT }}
                  >
                    <div className="flex items-center gap-0.5 px-0.5 w-full min-w-0" style={{ height: 24 }}>
                      {relation && relationConnection ? (
                        <RelationCellInput
                          connection={relationConnection}
                          targetTable={relation.table}
                          targetSchemaName={relation.schemaName}
                          targetPkColumn={relation.pkColumn}
                          targetLabelColumn={relation.labelColumn ?? null}
                          value={rawVal ?? ''}
                          onChange={(v) => onNewRowEdit?.(nr.tempId, col.name, v === '' ? null : v)}
                          onBlur={undefined}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape' && onNewRowRemove) onNewRowRemove(nr.tempId);
                          }}
                          className={`flex-1 min-w-0 h-6 box-border flex items-center bg-[#0f172a] border rounded px-1.5 text-xs text-slate-100 font-mono ${
                            invalid ? 'border-red-500/60' : 'border-emerald-500/30'
                          }`}
                        />
                      ) : (
                        <TypedCellInput
                          kind={getEditorKind(col.data_type)}
                          value={rawVal ?? ''}
                          onChange={(v) => onNewRowEdit?.(nr.tempId, col.name, v === '' ? null : v)}
                          placeholder={col.name}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape' && onNewRowRemove) onNewRowRemove(nr.tempId);
                          }}
                          className={`flex-1 min-w-0 h-6 box-border bg-[#0f172a] border rounded px-1.5 text-xs text-slate-100 focus:outline-none font-mono leading-6 overflow-hidden whitespace-nowrap ${
                            invalid ? 'border-red-500/60' : 'border-emerald-500/30'
                          }`}
                        />
                      )}
                      {onNewRowOpenModal && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onNewRowOpenModal(nr.tempId, col.name, col.data_type);
                          }}
                          className="shrink-0 p-0.5 rounded text-slate-500 hover:text-blue-400 hover:bg-[#1e293b] transition-colors"
                          title="Open in full editor"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {showEmpty && (
            <div
              style={{ position: 'absolute', top: HEADER_HEIGHT, left: 0, width: '100%' }}
              className="py-8 text-center text-slate-600 text-xs"
            >
              No rows.
            </div>
          )}
        </div>
      </div>

      {/* Docked row-inspector panel — every column of the selected row in
          label/value form. Opened via the expand icon in the "#" gutter. */}
      {inspectRow && inspectIdx >= 0 && (
        <>
          <div
            onMouseDown={() => setIsResizingInspector(true)}
            className="w-1.5 h-full bg-[#1e293b]/40 hover:bg-cyan-500 cursor-col-resize z-30 transition-colors shrink-0"
            title="Drag to resize row inspector"
          />
          <div style={{ width: `${gridRowInspectorWidth * zoomLevel}px` }} className="h-full shrink-0">
            <RowInspectorPanel
              columns={columns}
              row={inspectRow}
              columnIndex={columnIndex}
              rowEdits={pendingUpdates?.get(inspectRow)}
              rowNumber={rowNumberOffset + inspectIdx + 1}
              onClose={() => setInspectRow(null)}
            />
          </div>
        </>
      )}
      </div>
    </>
  );
};

// ─── Inline cell editor ─────────────────────────────────────────────────────

/**
 * Single-line inline cell editor. Vertically centered within the cell, no
 * scrollbars. ESC discards, Enter/blur commits. The input itself is
 * type-appropriate (number/date/boolean/text) via TypedCellInput, but the
 * wrapper enforces single-line + overflow-hidden so long text can't push the
 * row taller or introduce a scrollbar.
 *
 * There is intentionally NO pencil/confirm button here — the inline editor
 * commits automatically on blur/Enter. The full-screen modal is reached via
 * the read-mode hover pencil on the cell, not from inside the inline editor
 * (a second pencil here was redundant and caused the draft to be committed
 * as "[object Object]" for JSON columns when clicked).
 */
const InlineCellEditor: React.FC<{
  kind: ReturnType<typeof getEditorKind>;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
  autoFocus?: boolean;
}> = ({ kind, value, onChange, onCommit, onDiscard, autoFocus }) => {
  return (
    <div className="flex items-center w-full px-0.5" style={{ height: 24 }}>
      <TypedCellInput
        kind={kind}
        value={value}
        onChange={onChange}
        // Wrapped, not passed directly: `TypedCellInput`'s `onBlur` forwards
        // the native focus event through to whatever handler it's given
        // (despite being typed as `() => void`), so `onBlur={onCommit}`
        // called `commitEdit(focusEvent)` — the event object as
        // `overrideValue` — and committed "[object Object]" as the cell's
        // new value on any blur-triggered commit (Tab, click elsewhere, or
        // React unmounting this input after a click-outside commit already
        // ran). The wrapper discards whatever argument it's called with.
        onBlur={() => onCommit()}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onDiscard(); }
          else if (e.key === 'Enter' && kind !== 'longtext') { e.preventDefault(); onCommit(); }
        }}
        className="flex-1 min-w-0 h-6 box-border bg-[#0f172a] border border-blue-500 rounded px-1.5 text-xs text-slate-100 focus:outline-none font-mono leading-6 overflow-hidden whitespace-nowrap"
      />
    </div>
  );
};
