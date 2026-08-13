import React, { useEffect, useMemo, useState } from 'react';
import {
  Table as TableIcon,
  RefreshCw,
  Save,
  Undo2,
  X,
  AlertTriangle,
  Pencil,
  Lock,
  ArrowUp,
  ArrowDown,
  Filter,
  Columns3,
} from 'lucide-react';
import { useTabStore } from '../../store/useTabStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { safeInvoke } from '../../core/tauri/ipc';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import {
  QueryResultData,
  QueryResultSet,
} from '../../core/domain/types';
import { isJsonType, cellToEditableString, getEditorKind } from '../table/TypedCellInput';
import { CellEditorModal } from '../table/CellEditorModal';
import { DataGrid } from '../table/DataGrid';
import { RelationTarget, buildTableRelationInfo } from '../table/relationHelpers';
import { compareCells, applyFilters, cellToText, measureTextWidth, type FilterCondition } from '../table/cellUtils';
import { FilterDrawer, type FilterColumn } from '../table/FilterDrawer';
import { useColumnResize } from '../table/useColumnResize';
import { quoteIdent, qualifiedTable, resolveTargetDatabase } from '../../core/sql/ident';
import { ApplyChangesModal, PendingChange } from './ApplyChangesModal';

type CellValue = string | number | boolean | null;
type RowData = CellValue[];

function sqlLiteral(value: CellValue | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

interface NewRow {
  tempId: string;
  values: Record<string, string | null>;
}

interface ResultGridProps {
  tabId: string;
  resultSet: QueryResultSet;
}

/**
 * Renders one QueryResultSet in the bottom panel. Read-only by default; becomes
 * an editable grid when the producing statement resolved to a single table
 * (resultSet.editableTable). Editing follows the same staged-changes model as
 * TableDataView: edits accumulate as amber-highlighted pending changes until the
 * user opens ApplyChangesModal to review and confirm, at which point the
 * statements run one-by-one and the result set is refreshed.
 */
export const ResultGrid: React.FC<ResultGridProps> = ({ tabId, resultSet }) => {
  const { tabs, runSingleStatement } = useTabStore();
  const { connections, activeConnectionId, activeDatabaseByConn, schemaTreeByConn } = useConnectionStore();

  const tab = tabs.find((t) => t.id === tabId);
  const activeConn = connections.find(
    (c) => c.id === (tab?.connectionId ?? activeConnectionId)
  );
  const activeDb =
    tab?.schemaName ||
    (activeConn && activeDatabaseByConn[activeConn.id]) ||
    activeConn?.database;
  const queryConfig = activeConn
    ? (() => {
        const targetDb = resolveTargetDatabase(activeConn.engine, activeConn.database, activeDb);
        return targetDb && targetDb !== activeConn.database
          ? { ...activeConn, database: targetDb }
          : activeConn;
      })()
    : activeConn;

  const engine = activeConn?.engine ?? 'postgres';
  const editableTable = resultSet.editableTable;
  // The grid is only editable when the user explicitly enters edit mode (via
  // the Edit button in the toolbar). Until then an editable-qualified result
  // renders through the virtualized read-only path — no per-cell handlers, no
  // FK/PK discovery, no pending-state machinery — so 1000-row results stay
  // smooth. Toggling edit mode mounts the full interactive grid.
  const [isEditMode, setIsEditMode] = useState(false);
  const isEditable = !!editableTable && !!activeConn && isEditMode;

  const result = resultSet.result;

  // ---- PK / required-column discovery (editable grids only) ---------------
  const [pkColumns, setPkColumns] = useState<string[]>([]);
  const [fkMap, setFkMap] = useState<Map<string, RelationTarget>>(new Map());
  const [requiredColumns, setRequiredColumns] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!activeConn || !editableTable || !isEditMode) {
      setPkColumns([]);
      setFkMap(new Map());
      setRequiredColumns(new Set());
      return;
    }
    // Read from the shared per-connection schema cache — no extra
    // fetch_schema_tree round-trip (the Explorer already populated it).
    const tree = schemaTreeByConn[activeConn.id] || [];
    for (const group of tree) {
      if (editableTable.schema && group.name !== editableTable.schema) continue;
      const match = group.children.find((t) => t.name === editableTable.name);
      if (match) {
        const { pkColumns, fkMap, requiredColumns } = buildTableRelationInfo(
          match,
          group.children,
          editableTable.schema || activeDb,
        );
        setPkColumns(pkColumns);
        setFkMap(fkMap);
        setRequiredColumns(requiredColumns);
        return;
      }
    }
    setPkColumns([]);
    setFkMap(new Map());
    setRequiredColumns(new Set());
  }, [activeConn?.id, editableTable, schemaTreeByConn, isEditMode]);

  // ---- Editing state ------------------------------------------------------
  // (Inline cell editing is handled by the DataGrid component; this parent
  //  only tracks pending edits/deletes and the full-screen modal editor.)
  const [gridSort, setGridSort] = useState<{ colIdx: number; dir: 'asc' | 'desc' } | null>(null);
  const [gridFilters, setGridFilters] = useState<FilterCondition[]>([]);
  const [gridFilterOpen, setGridFilterOpen] = useState(false);
  const [modalEditCell, setModalEditCell] = useState<{ row: RowData; col: string; dataType?: string } | null>(null);
  const [pendingUpdates, setPendingUpdates] = useState<Map<RowData, Record<string, string | null>>>(new Map());
  const [pendingDeletes, setPendingDeletes] = useState<Set<RowData>>(new Set());
  const [newRows, setNewRows] = useState<NewRow[]>([]);

  // Reset staged changes whenever the result set's rows change (re-run/refresh).
  // Key off the result object identity too, not just `resultSet.id`: re-running
  // the same statement produces the SAME id (`rs_<tabId>_0`) but a fresh result
  // object from the backend, so without `result` in the deps, stale pending
  // state from a prior run would persist and falsely show the pending-changes
  // badge. `result` is undefined for non-SELECT sets, so the id still acts as a
  // fallback discriminator in that case.
  useEffect(() => {
    setPendingUpdates(new Map());
    setPendingDeletes(new Set());
    setNewRows([]);
    setApplyError(null);
    // Exit edit mode on re-run so the grid returns to the fast read-only path
    // until the user opts back into editing.
    setIsEditMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultSet.id, resultSet.result]);

  const [showApplyModal, setShowApplyModal] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Reset staged changes when the statement text changes.
  useEffect(() => {
    setPendingUpdates(new Map());
    setPendingDeletes(new Set());
    setNewRows([]);
    setApplyError(null);
    setShowApplyModal(false);
    setIsEditMode(false);
  }, [resultSet.statement]);

  if (!result) {
    // No rows / status message (e.g. an INSERT/UPDATE that returned no set).
    return (
      <div className="p-3 text-xs text-slate-400 font-mono">
        {resultSet.error ? (
          <div className="font-sans">
            <CopyableErrorBanner message={resultSet.error} tone="red" compact parseAsDbError />
          </div>
        ) : (
          <>
            {resultSet.statement}
            <span className="block mt-1 text-slate-600">No result set returned.</span>
          </>
        )}
      </div>
    );
  }

  if (result.columns.length === 0) {
    return (
      <div className="p-3 text-xs text-slate-400 font-mono">
        {result.status_message || `OK — ${result.affected_rows} row(s) affected`}{' '}
        <span className="text-slate-600">({result.execution_time_ms}ms)</span>
      </div>
    );
  }

  // ---- Read-only path -----------------------------------------------------
  // When the query is editable-qualified (SELECT * FROM <table>) but the user
  // hasn't entered edit mode, still render via the fast read-only grid — but
  // pass an Edit button so they can opt into editing. This keeps heavy
  // per-cell handlers, FK lookups, and PK discovery off until requested.
  if (!isEditable || !editableTable || !activeConn) {
    const canEdit = !!editableTable && !!activeConn;
    return (
      <ReadOnlyGrid
        result={result}
        statement={resultSet.statement}
        editableTableName={canEdit ? editableTable!.name : undefined}
        onEnterEdit={canEdit ? () => setIsEditMode(true) : undefined}
        storageKey={canEdit ? `${activeConn!.id}_${activeDb || 'default'}_${editableTable!.name}` : undefined}
      />
    );
  }

  // ---- Editable path ------------------------------------------------------
  const allRows: RowData[] = result.rows || [];
  const idColumns = pkColumns.length > 0 ? pkColumns : result.columns.map((c) => c.name);
  // (newRows / insert-row feature removed from the SQL result grid — inserts
  // are done via the SQL editor. Only updates + deletes stage pending changes.)
  const pendingCount = pendingUpdates.size + pendingDeletes.size;

  const commitModalEdit = (value: string | null) => {
    if (!modalEditCell) return;
    const { row, col } = modalEditCell;
    setPendingUpdates((prev) => {
      const next = new Map(prev);
      const rowEdits = { ...(next.get(row) || {}) };
      rowEdits[col] = value;
      next.set(row, rowEdits);
      return next;
    });
  };

  const toggleRowDelete = (row: RowData) => {
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
  };

  const handleDiscardChanges = () => {
    setPendingUpdates(new Map());
    setPendingDeletes(new Set());
    setNewRows([]);
    setApplyError(null);
    setShowApplyModal(false);
  };

  /** Exit edit mode: discard any staged changes and return to the fast
   *  read-only render path. Bound to the "Done" toolbar button. */
  const handleExitEditMode = () => {
    handleDiscardChanges();
    setIsEditMode(false);
  };

  // Build the SQL for every staged change, for review in ApplyChangesModal.
  const buildPendingChanges = (): PendingChange[] => {
    const q = (name: string) => quoteIdent(activeConn.engine, name);
    // Use the editableTable's schema if the user qualified the SELECT, else the
    // tab/active schema. Falls back to unqualified when neither is set.
    const schemaName = editableTable.schema ?? tab?.schemaName;
    const tableIdent = qualifiedTable(activeConn.engine, editableTable.name, schemaName);
    const changes: PendingChange[] = [];

    const whereFor = (row: RowData) =>
      idColumns
        .map((colName) => {
          const ci = result.columns.findIndex((c) => c.name === colName);
          const val = ci >= 0 ? row[ci] : null;
          return `${q(colName)} = ${sqlLiteral(val)}`;
        })
        .join(' AND ');

    pendingDeletes.forEach((row) => {
      changes.push({ kind: 'delete', sql: `DELETE FROM ${tableIdent} WHERE ${whereFor(row)};`, label: editableTable.name });
    });

    pendingUpdates.forEach((rowEdits, row) => {
      if (pendingDeletes.has(row)) return;
      const setParts = Object.entries(rowEdits).map(([col, val]) => `${q(col)} = ${sqlLiteral(val)}`);
      if (setParts.length === 0) return;
      changes.push({
        kind: 'update',
        sql: `UPDATE ${tableIdent} SET ${setParts.join(', ')} WHERE ${whereFor(row)};`,
        label: editableTable.name,
      });
    });

    return changes;
  };

  const handleApplyConfirmed = async () => {
    if (!activeConn) return;
    const changes = buildPendingChanges();
    if (changes.length === 0) {
      setShowApplyModal(false);
      return;
    }

    // Required-field validation before anything touches the DB.
    if (requiredColumns.size > 0) {
      const validationErrors: string[] = [];
      pendingUpdates.forEach((rowEdits, row) => {
        if (pendingDeletes.has(row)) return;
        Object.entries(rowEdits).forEach(([col, val]) => {
          if (requiredColumns.has(col) && val === null) {
            validationErrors.push(`"${col}" can't be cleared — it's a required field`);
          }
        });
      });
      if (validationErrors.length > 0) {
        setApplyError(`Cannot apply — ${validationErrors.join('; ')}.`);
        return;
      }
    }

    setApplying(true);
    setApplyError(null);

    let failure: string | null = null;
    for (const [stmtIdx, change] of changes.entries()) {
      try {
        await safeInvoke<{ affected_rows?: number }>('execute_query', {
          request: { config: queryConfig, sql: change.sql },
          queryId: `crud_${editableTable.name}_${stmtIdx}_${Date.now()}`,
          __meta: { source: 'table' },
        });
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        failure = errMsg;
        break;
      }
    }

    if (failure) {
      setApplyError(failure);
      setApplying(false);
      return;
    }

    // Commit succeeded: clear staged state, close modal, and refresh this set.
    setPendingUpdates(new Map());
    setPendingDeletes(new Set());
    setNewRows([]);
    setApplying(false);
    setShowApplyModal(false);
    await runSingleStatement(tabId, resultSet.statement);
  };

  const rowCount = allRows.length;

  return (
    <div className="flex flex-col h-full">
      {/* Pending-change bar */}
      {pendingCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-950/20 border-b border-amber-500/30 text-xs shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-amber-300 font-medium">{pendingCount} pending change{pendingCount === 1 ? '' : 's'}</span>
          {pkColumns.length === 0 && (
            <span className="text-amber-400/80 hidden md:inline">
              · no primary key — updates/deletes match all column values
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={handleDiscardChanges}
              disabled={applying}
              className="px-2 py-0.5 rounded bg-[#141e33] hover:bg-[#1e293b] text-slate-300 text-[11px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-50"
              title="Discard pending changes"
            >
              <Undo2 className="w-3 h-3" />
              Discard
            </button>
            <button
              onClick={() => {
                setApplyError(null);
                setShowApplyModal(true);
              }}
              disabled={applying}
              className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-50 shadow-md shadow-emerald-600/30"
              title="Review and apply changes to the database"
            >
              {applying ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Apply ({pendingCount})
            </button>
          </div>
        </div>
      )}
      {applyError && !showApplyModal && (
        <div className="px-3 py-1.5 bg-red-950/20 border-b border-red-500/30 text-red-300 text-[11px] flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Failed to apply changes: {applyError}
        </div>
      )}

      {/* Toolbar (compact — appears only when editable so read-only sets stay clean) */}
      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-[#1e293b] bg-[#080c14] shrink-0 text-[10.5px]">
        <span className="text-slate-500 font-mono">
          {rowCount.toLocaleString()} row{rowCount === 1 ? '' : 's'} • {result.execution_time_ms}ms
        </span>
        <span className="text-slate-700">·</span>
        <span className="inline-flex items-center gap-1 text-slate-300 font-mono">
          <TableIcon className="w-3 h-3 text-cyan-400" />
          {activeDb ? `${activeDb}.` : ''}
          {editableTable.name}
        </span>
        {pkColumns.length === 0 && (
          <span className="text-amber-500/80 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />no PK
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {/* Advanced filter — sits next to Refresh. */}
          <button
            onClick={() => setGridFilterOpen((v) => !v)}
            className={`relative p-1 rounded transition-colors ${
              gridFilters.some((c) => c.operator === 'is_null' || c.operator === 'is_not_null' || c.value.trim() !== '')
                ? 'text-cyan-300 bg-cyan-500/20'
                : 'hover:bg-[#1e293b] text-slate-400'
            }`}
            title="Advanced filter"
          >
            <Filter className="w-3.5 h-3.5" />
            {(() => {
              const n = gridFilters.filter(
                (c) => c.operator === 'is_null' || c.operator === 'is_not_null' || c.value.trim() !== '',
              ).length;
              return n > 0 ? (
                <span className="absolute -top-1 -right-1 bg-cyan-500 text-[#06090e] px-1 rounded-full text-[8px] leading-tight font-bold min-w-[14px] text-center">
                  {n}
                </span>
              ) : null;
            })()}
          </button>
          {/* Active sort indicator. */}
          {gridSort && (
            <span className="inline-flex items-center gap-0.5 text-cyan-300 font-mono text-[10px]">
              {gridSort.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
              {result.columns[gridSort.colIdx]?.name}
              <button
                onClick={() => setGridSort(null)}
                className="text-slate-500 hover:text-red-400"
                title="Clear sort"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          <button
            onClick={() => runSingleStatement(tabId, resultSet.statement)}
            disabled={applying}
            className="p-1 rounded hover:bg-[#1e293b] text-slate-400 transition-colors disabled:opacity-50"
            title="Re-run this statement"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleExitEditMode}
            disabled={applying}
            className="p-1 rounded hover:bg-[#1e293b] text-slate-400 transition-colors disabled:opacity-50"
            title="Exit edit mode"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Grid — uses the reusable DataGrid (virtualized, edit-on-doubleclick). */}
      <DataGrid
        columns={result.columns.map((c) => ({
          name: c.name,
          data_type: c.data_type,
          is_required: requiredColumns.has(c.name),
        }))}
        rows={allRows}
        editable
        pendingUpdates={pendingUpdates}
        pendingDeletes={pendingDeletes}
        fkMap={fkMap}
        onCellEdit={(row, colName, value) => {
          setPendingUpdates((prev) => {
            const next = new Map(prev);
            const rowEdits = { ...(next.get(row) || {}) };
            rowEdits[colName] = value;
            next.set(row, rowEdits);
            return next;
          });
        }}
        onOpenModalEditor={(row, colName, dataType) => setModalEditCell({ row, col: colName, dataType })}
        onToggleRowDelete={toggleRowDelete}
        sortState={gridSort}
        onSortChange={setGridSort}
        filterConditions={gridFilters}
        onFilterChange={setGridFilters}
        filterOpen={gridFilterOpen}
        onFilterOpenChange={setGridFilterOpen}
        columnStorageKey={`${activeConn.id}_${activeDb || 'default'}_${editableTable.name}`}
      />

      {/* Apply-changes confirm modal */}
      {showApplyModal && (
        <ApplyChangesModal
          changes={buildPendingChanges()}
          error={applyError}
          applying={applying}
          onConfirm={handleApplyConfirmed}
          onCancel={() => setShowApplyModal(false)}
        />
      )}

      {/* Full-screen modal cell editor */}
      {modalEditCell && (
        <CellEditorModal
          columnName={modalEditCell.col}
          dataType={modalEditCell.dataType}
          isJson={isJsonType(modalEditCell.dataType)}
          value={
            (() => {
              const edits = pendingUpdates.get(modalEditCell.row);
              const hasEdit = edits && Object.prototype.hasOwnProperty.call(edits, modalEditCell.col);
              const colIdx = result.columns.findIndex((c) => c.name === modalEditCell.col);
              const raw = hasEdit ? edits![modalEditCell.col] : (colIdx >= 0 ? modalEditCell.row[colIdx] : null);
              return cellToEditableString(raw, isJsonType(modalEditCell.dataType));
            })()
          }
          onClose={() => setModalEditCell(null)}
          onSave={commitModalEdit}
        />
      )}
    </div>
  );
};

/** Plain read-only grid for result sets that aren't editable (joins, aggregates,
 *  anything detectEditableTable couldn't resolve to a single table).
 *
 *  Uses windowed (virtualized) rendering: only the rows inside (or near) the
 *  visible scroll viewport are mounted, plus a top/bottom spacer to preserve
 *  the scrollbar height. This keeps the DOM light even for 100k+ row result
 *  sets — mounting all rows was the main cause of UI lag on heavy SELECTs. */
const ROW_HEIGHT = 26; // px — matches the rendered row (py-1 + text-[11px] line)
// Extra rows rendered above/below the viewport. Generous so fast scrolling
// reveals already-rendered rows instead of the bare spacer area (which paints
// as the dark container background and looks like a blank/black flash).
const OVERSCAN = 24;

const ReadOnlyGrid: React.FC<{
  result: QueryResultData;
  statement: string;
  /** Table name when the result is editable-qualified (SELECT * FROM <table>).
   *  When present together with `onEnterEdit`, an Edit button is shown. */
  editableTableName?: string;
  onEnterEdit?: () => void;
  /** Stable key for persisting column widths + hidden columns. Omit to
   *  disable persistence. */
  storageKey?: string;
}> = ({ result, statement, editableTableName, onEnterEdit, storageKey }) => {
  const allRows = result.rows ?? [];
  const rowCount = allRows.length;
  const isReadOnlySelect = statement.trim().toUpperCase().startsWith('SELECT');
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);

  // ── Sort + filter (view concerns — internal) ──────────────────────────────
  const [sortState, setSortState] = useState<{ colIdx: number; dir: 'asc' | 'desc' } | null>(null);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  // Per-column resize (drag the handle on the right edge of any header).
  // (measureColumn + the hook call are set up below, after `columnIndex` and
  //  `visibleColumns` are defined.)
  // Auto-fit (table-auto) until widths are locked or manually set, then
  // table-fixed so scrolling can't shift column widths.

  // Hide/show columns. Persisted when storageKey is provided.
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    if (!storageKey) return new Set();
    try {
      const raw = localStorage.getItem(`rdsql_col_hidden_${storageKey}`);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  React.useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(`rdsql_col_hidden_${storageKey}`, JSON.stringify([...hiddenCols]));
    } catch { /* ignore */ }
  }, [storageKey, hiddenCols]);
  const visibleColumns = useMemo(() => result.columns.filter((c) => !hiddenCols.has(c.name)), [result.columns, hiddenCols]);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!colMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setColMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colMenuOpen]);

  // thRefs + didLockRef for the auto-fit snapshot (effect is wired after the
  // resize hook is created, below).
  const thRefs = React.useRef<(HTMLTableCellElement | null)[]>([]);
  const didLockRef = React.useRef(false);

  const filterColumns: FilterColumn[] = useMemo(
    () => result.columns.map((c) => ({ name: c.name, kind: getEditorKind(c.data_type), data_type: c.data_type })),
    [result.columns],
  );
  const columnKinds = useMemo(() => {
    const m = new Map<string, ReturnType<typeof getEditorKind>>();
    result.columns.forEach((c) => m.set(c.name, getEditorKind(c.data_type)));
    return m;
  }, [result.columns]);
  const columnIndex = useMemo(() => {
    const m = new Map<string, number>();
    result.columns.forEach((c, i) => m.set(c.name, i));
    return m;
  }, [result.columns]);

  const displayRows = useMemo(() => {
    let out: RowData[] = allRows;
    if (filterConditions.length) {
      out = applyFilters(out, filterConditions, columnKinds, columnIndex);
    }
    if (sortState) {
      const { colIdx, dir } = sortState;
      // colIdx is the visible-column index; map to the raw row index so
      // hidden columns don't shift what we sort by.
      const colName = visibleColumns[colIdx]?.name;
      const rawIdx = colName ? (columnIndex.get(colName) ?? colIdx) : colIdx;
      const sorted = [...out].sort((a, b) => compareCells(a[rawIdx], b[rawIdx]));
      out = dir === 'desc' ? sorted.reverse() : sorted;
    }
    return out;
  }, [allRows, filterConditions, columnKinds, columnIndex, sortState, visibleColumns]);

  // Per-column resize (drag handle) + double-click auto-fit. Measures the
  // natural text width of header + sampled body cells (canvas-based, so it's
  // independent of the column's current width → shrink and grow both work).
  const measureColumn = React.useCallback(
    (name: string): number | null => {
      const rawIdx = columnIndex.get(name);
      if (rawIdx === undefined) return null;
      const col = result.columns.find((c) => c.name === name);
      const headerText = name + (col?.data_type ? ` ${col.data_type}` : '');
      let maxW = measureTextWidth(headerText, 11);
      // Sample up to ~150 rows (every Nth if large) so this stays fast even
      // for 1000-row results. We want the widest *content*, not every row.
      const rows = displayRows;
      const n = rows.length;
      const step = n > 150 ? Math.ceil(n / 150) : 1;
      for (let i = 0; i < n; i += step) {
        maxW = Math.max(maxW, measureTextWidth(cellToText(rows[i][rawIdx]), 11));
      }
      return maxW > 0 ? maxW + 28 : null;
    },
    [columnIndex, result.columns, displayRows],
  );
  const { widths: colWidths, startResize, lockWidths, autoFitColumn, isLocked } =
    useColumnResize(storageKey, measureColumn);
  const hasCustomWidths = colWidths.size > 0;
  const useFixedLayout = hasCustomWidths || isLocked;

  // Snapshot auto-fit widths once after first data render, then freeze layout.
  React.useEffect(() => {
    if (didLockRef.current) return;
    if (!visibleColumns.length || !allRows.length) return;
    const id = requestAnimationFrame(() => {
      const m = new Map<string, number>();
      visibleColumns.forEach((c, i) => {
        const el = thRefs.current[i];
        if (el && el.offsetWidth > 0) m.set(c.name, el.offsetWidth);
      });
      if (m.size) {
        lockWidths(m);
        didLockRef.current = true;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [visibleColumns, allRows.length, lockWidths]);

  const activeFilterCount = filterConditions.filter(
    (c) => c.operator === 'is_null' || c.operator === 'is_not_null' || c.value.trim() !== '',
  ).length;

  const toggleSort = React.useCallback((colIdx: number) => {
    setSortState((prev) => {
      if (!prev || prev.colIdx !== colIdx) return { colIdx, dir: 'asc' };
      if (prev.dir === 'asc') return { colIdx, dir: 'desc' };
      return null;
    });
  }, []);

  // Reset sort/filter/visibility when the result set changes (new query).
  React.useEffect(() => {
    setSortState(null);
    setFilterConditions([]);
    setHiddenCols(new Set());
    didLockRef.current = false;
  }, [result]);

  // Track the scroll container's height and scrollTop so we can compute the
  // visible row window. Throttled via rAF to avoid recomputing on every pixel.
  // Only setScrollTop on scroll — viewportH changes only on resize (handled by
  // the ResizeObserver below). Setting both per frame caused a double
  // re-render + needless re-slice on every animation frame, which made fast
  // scrolling feel janky and show unrendered (blank) spacer areas.
  const rafRef = React.useRef<number | null>(null);
  const onScroll = React.useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);
  React.useEffect(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  // Observe the container so resizing the result panel recomputes the window.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Seed the real height immediately so the first paint renders the correct
    // number of rows (the initial 400px default could under-render on mount).
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute the visible row range (+ overscan), clamped to row count.
  const displayCount = displayRows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(displayCount, start + visibleCount);
  const visibleRows = displayCount > 0 ? displayRows.slice(start, end) : [];
  const spacerTop = start * ROW_HEIGHT;
  const spacerBottom = Math.max(0, (displayCount - end) * ROW_HEIGHT);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[#1e293b] bg-[#080c14] shrink-0 text-[10.5px]">
        <span className="text-slate-600 font-mono">
          {result.execution_time_ms}ms
        </span>
        {isReadOnlySelect && !onEnterEdit && (
          <Lock className="w-3 h-3 text-slate-600" />
        )}
        {editableTableName && (
          <span className="inline-flex items-center gap-1 text-slate-400 font-mono">
            <TableIcon className="w-3 h-3 text-cyan-400" />
            {editableTableName}
          </span>
        )}
        {/* Right-aligned actions: sort indicator + filter + edit. */}
        <div className="ml-auto flex items-center gap-1.5">
          {sortState && (
            <span className="inline-flex items-center gap-0.5 text-cyan-300 font-mono text-[10px]">
              {sortState.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
              {result.columns[sortState.colIdx]?.name}
              <button
                onClick={() => setSortState(null)}
                className="text-slate-500 hover:text-red-400"
                title="Clear sort"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          <button
            onClick={() => setFilterOpen((v) => !v)}
            className={`relative p-1 rounded transition-colors ${
              activeFilterCount > 0
                ? 'text-cyan-300 bg-cyan-500/20'
                : 'hover:bg-[#1e293b] text-slate-400'
            }`}
            title="Advanced filter"
          >
            <Filter className="w-3.5 h-3.5" />
            {activeFilterCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-cyan-500 text-[#06090e] px-1 rounded-full text-[8px] leading-tight font-bold min-w-[14px] text-center">
                {activeFilterCount}
              </span>
            )}
          </button>
          {onEnterEdit && (
            <button
              onClick={onEnterEdit}
              className="p-1 rounded hover:bg-[#1e293b] text-cyan-300 transition-colors"
              title="Edit rows in this table"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <FilterDrawer
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        conditions={filterConditions}
        onChange={setFilterConditions}
        columns={filterColumns}
      />
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto bg-[#06090e]">
        <table className={`w-full text-left border-collapse font-mono text-[11px] ${useFixedLayout ? 'table-fixed' : 'table-auto'}`}>
          <thead className="bg-[#0f172a] border-b border-[#1e293b] sticky top-0 text-slate-400 uppercase text-[10px] tracking-wider z-10">
            <tr>
              <th className="py-1.5 px-2 border-r border-[#1e293b] w-10 text-right text-slate-600">#</th>
              {visibleColumns.map((col, colIdx) => {
                const isSorted = sortState?.colIdx === colIdx;
                const sortDir = isSorted ? sortState!.dir : null;
                const w = colWidths.get(col.name);
                return (
                  <th
                    key={col.name}
                    ref={(el) => { thRefs.current[colIdx] = el; }}
                    onClick={() => toggleSort(colIdx)}
                    style={{ width: w }}
                    className={`relative py-1.5 px-3 border-r border-[#1e293b] ${w ? '' : 'min-w-[120px]'} whitespace-nowrap cursor-pointer select-none hover:bg-[#141e33] transition-colors ${
                      isSorted ? 'text-cyan-300' : ''
                    }`}
                    title={`Sort by ${col.name}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="flex items-center gap-0.5 text-slate-200 normal-case truncate">
                        {col.name}
                        {sortDir === 'asc' && <ArrowUp className="w-3 h-3 text-cyan-400 shrink-0" />}
                        {sortDir === 'desc' && <ArrowDown className="w-3 h-3 text-cyan-400 shrink-0" />}
                      </span>
                      {col.data_type && <span className="text-[9px] text-slate-600 lowercase shrink-0">{col.data_type}</span>}
                    </div>
                    {/* Resize handle — drag to resize, double-click to auto-fit. */}
                    <div
                      onMouseDown={startResize(col.name)}
                      onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(col.name); }}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-0 right-[-2px] h-full w-1.5 cursor-col-resize hover:bg-cyan-500/40 z-20"
                      title="Drag to resize"
                    />
                  </th>
                );
              })}
              {/* Hide/show columns toggle. */}
              <th className="relative py-1.5 px-2 w-8 text-center text-slate-500">
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
                      {result.columns.map((c) => {
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
              </th>
            </tr>
          </thead>
          <tbody>
            {displayCount > 0 && (
              <>
                {spacerTop > 0 && (
                  <tr style={{ height: spacerTop }} className="bg-[#06090e]">
                    <td colSpan={visibleColumns.length + 2} />
                  </tr>
                )}
                {visibleRows.map((row, vi) => {
                  const ri = start + vi;
                  return (
                    <tr key={ri} className="border-b border-[#1e293b]/40 hover:bg-[#0f172a]/60">
                      <td className="py-1 px-2 border-r border-[#1e293b] text-right text-slate-600">{ri + 1}</td>
                      {visibleColumns.map((col, ci) => {
                        const rawIdx = columnIndex.get(col.name) ?? ci;
                        const cell = row[rawIdx];
                        const isNull = cell === null || cell === undefined;
                        return (
                          <td
                            key={ci}
                            className={`py-1 px-3 border-r border-[#1e293b] overflow-hidden ${
                              isNull ? 'text-slate-600 italic' : 'text-slate-300'
                            }`}
                          >
                            <span className="block truncate">
                              {isNull ? 'NULL' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {spacerBottom > 0 && (
                  <tr style={{ height: spacerBottom }} className="bg-[#06090e]">
                    <td colSpan={visibleColumns.length + 2} />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
