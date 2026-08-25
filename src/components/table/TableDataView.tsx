import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Table as TableIcon,
  Search,
  RefreshCw,
  Download,
  FileCode,
  Trash2,
  ChevronLeft,
  ChevronRight,
  CheckCheck,
  Plus,
  Save,
  Undo2,
  X,
  AlertTriangle,
  Pencil,
  Ban,
  Copy,
  Files,
  Clipboard,
  CopyPlus,
  Filter,
  ArrowUp,
  ArrowDown,
  Expand,
  GitCompare,
} from 'lucide-react';
import { useTabStore } from '../../store/useTabStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { safeInvoke } from '../../core/tauri/ipc';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { isJsonType, cellToEditableString, CELL_INPUT_HEIGHT_CLASS } from './TypedCellInput';
import { CellEditorModal } from './CellEditorModal';
import { DataGrid } from './DataGrid';
import { RowCompareModal } from './RowCompareModal';
import { RelationTarget, buildTableRelationInfo } from './relationHelpers';
import { type FilterCondition } from './cellUtils';
import { quoteIdent, qualifiedTable, selectPreviewSql, paginatedSelectSql, resolveTargetDatabase } from '../../core/sql/ident';
import { fetchTableIndexes, fetchTableForeignKeys } from '../../core/sql/indexIntrospection';
import { parseDbError, errorKindLabel, errorKindColor, formatDbErrorTrace } from '../../core/sql/dbError';
import { QueryResultData } from '../../core/domain/types';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { copyToClipboard } from '../../core/utils/clipboard';
import { useToastStore } from '../../store/useToastStore';

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZE_PRESETS = [25, 50, 100, 250, 500, 1000];
const MAX_PAGE_SIZE = 100_000;

type CellValue = string | number | boolean | null;
type RowData = CellValue[];

function sqlLiteral(value: CellValue | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toCsvField(value: CellValue): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function newRowInputClass(invalid: boolean): string {
  return `${CELL_INPUT_HEIGHT_CLASS} w-full bg-[#0f172a] border ${
    invalid ? 'border-red-500' : 'border-emerald-500/30'
  } rounded px-2 py-0 text-xs text-slate-100 focus:outline-none focus:border-emerald-400 font-mono leading-7`;
}

interface NewRow {
  tempId: string;
  values: Record<string, string | null>;
}

/**
 * Clamp a context menu to the viewport. Same idea as Explorer's
 * `useClampedMenuPosition`: start at the click point, then after layout
 * measure the real rendered size and shift up/left so the menu never overflows
 * the screen (the grid's right-click menu was getting cut off at the bottom
 * and right edges of the window).
 */
function useClampedMenuPos(
  clickX: number,
  clickY: number
): { ref: React.RefObject<HTMLDivElement | null>; style: { top: number; left: number } } {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: clickY, left: clickX });
  useLayoutEffect(() => {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = ref.current?.offsetHeight ?? 0;
    const w = ref.current?.offsetWidth ?? 240;
    const overflowY = clickY + h + margin - vh;
    const top = overflowY > 0 ? Math.max(margin, clickY - overflowY) : clickY;
    const overflowX = clickX + w + margin - vw;
    const left = overflowX > 0 ? Math.max(margin, vw - w - margin) : clickX;
    setPos({ top, left });
  }, [clickX, clickY]);
  return { ref, style: pos };
}

export const TableDataView: React.FC<{ tabId: string }> = ({ tabId }) => {
  const { tabs, executeQuery, openSqlTab, closeTab } = useTabStore();
  const { connections, activeConnectionId, activeDatabaseByConn, schemaTreeByConn } = useConnectionStore();
  const setActiveView = useWorkspaceStore((s) => s.setActiveView);

  const tab = tabs.find((t) => t.id === tabId);
  // Resolve the connection this tab belongs to. Each tab remembers the
  // connection (and schema) it was opened on, so switching the global active
  // connection doesn't hijack the grid. Fall back to the global active
  // connection for older tabs that have no connectionId bound.
  const activeConn = connections.find(
    (c) => c.id === (tab?.connectionId ?? activeConnectionId)
  );
  // `activeDb` is the SCHEMA used to qualify table names in SQL
  // (e.g. "public"."users" for Postgres, `bsc`.`users` for MySQL). Prefer the
  // tab's own schema, then the explorer's per-connection active database, then
  // the connection's configured database.
  //
  // Memoized so the value has a stable identity across re-renders as long as
  // the resolved schema string doesn't change. Without this, the click handler
  // (`setActiveConnection` → `setActiveDatabase` → `openTableDataTab`) causes
  // three separate store updates that each re-derive a *new* `activeDb`
  // reference, which in turn re-fires the data-loading effect 3× even though
  // the resolved schema is identical.
  const activeDb = useMemo(
    () =>
      tab?.schemaName ||
      (activeConn && activeDatabaseByConn[activeConn.id]) ||
      activeConn?.database,
    [tab?.schemaName, activeConn, activeDatabaseByConn]
  );
  // `queryConfig` is the connection config used to actually connect. For MySQL
  // the explorer group IS the database, so we override config.database. For
  // Postgres the group is a schema (e.g. `public`), NOT a database, so we must
  // keep the connection's configured database — overriding it would try
  // `dbname=public` and fail with ERROR 3D000.
  //
  // Memoized so loadCount/loadPage useCallback deps stay stable — without this
  // every render creates a new queryConfig object, re-creating the callbacks
  // and re-triggering dependent effects.
  const queryConfig = useMemo(
    () => {
      if (!activeConn) return activeConn;
      const targetDb = resolveTargetDatabase(activeConn.engine, activeConn.database, activeDb);
      return targetDb && targetDb !== activeConn.database
        ? { ...activeConn, database: targetDb }
        : activeConn;
    },
    [activeConn, activeDb]
  );

  const [searchFilter, setSearchFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedRows, setSelectedRows] = useState<Set<RowData>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);

  // Rows-per-page — user-adjustable (preset dropdown + arbitrary custom
  // number), not just the fixed 100 the backend used to hard-code.
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [customPageSizeOpen, setCustomPageSizeOpen] = useState(false);
  const [pageSizeDraft, setPageSizeDraft] = useState(String(DEFAULT_PAGE_SIZE));

  // Grid sort + filter — controlled by this parent's toolbar so Filter sits
  // next to Refresh in a single row (no separate grid toolbar). Sort is keyed
  // by column NAME (not the grid's internal visible-column index) so it can
  // be turned into a server-side `ORDER BY` — see handleSortChange below.
  const [gridSort, setGridSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [gridFilters, setGridFilters] = useState<FilterCondition[]>([]);
  const [gridFilterOpen, setGridFilterOpen] = useState(false);

  // Grid area viewport height — measured so the skeleton can render exactly
  // as many rows as the screen will hold. Hoisted into the workspace store
  // (persisted) so it survives tab switches and component remounts — without
  // this, switching from a table tab to SQL/ERD and back reset the height to
  // its default, causing a visible flicker and a wrong skeleton row count.
  const gridAreaRef = useRef<HTMLDivElement>(null);
  const gridAreaH = useWorkspaceStore((s) => s.gridAreaHeight);
  const setGridAreaHeight = useWorkspaceStore((s) => s.setGridAreaHeight);
  useEffect(() => {
    const el = gridAreaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setGridAreaHeight(el.clientHeight));
    ro.observe(el);
    setGridAreaHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [setGridAreaHeight]);

  // Server-side pagination state. The tab's own `result` only ever holds the
  // first page (its SQL carries `LIMIT 100`), so we fetch each subsequent
  // page directly here and track a separate total row count for the footer.
  const [pageResult, setPageResult] = useState<QueryResultData | null>(null);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loadingPage, setLoadingPage] = useState(false);
  // Track whether this is the first load (no page data shown yet) so we can
  // display a skeleton instead of the empty-state "No table data loaded".
  const [firstLoad, setFirstLoad] = useState(true);
  // The real backend error from the last page/count fetch (e.g. the actual
  // Postgres/MySQL error text), surfaced so users aren't stuck with "db error".
  const [pageError, setPageError] = useState<string | null>(null);

  // CRUD editing state
  const [pkColumns, setPkColumns] = useState<string[]>([]);
  const [fkMap, setFkMap] = useState<Map<string, RelationTarget>>(new Map());
  const [requiredColumns, setRequiredColumns] = useState<Set<string>>(new Set());
  // Columns covered by a secondary index — drives the index icon in the grid
  // header. PK columns are excluded (they already get the key icon).
  const [indexedColumns, setIndexedColumns] = useState<Set<string>>(new Set());
  // Columns that are real foreign keys (from DB introspection) — drives the
  // FK link icon in the grid header. Augments the `_id`-suffix heuristic in
  // `fkMap` so FKs declared without the naming convention still show the icon.
  const [fkColumns, setFkColumns] = useState<Set<string>>(new Set());
  // All NOT NULL columns (regardless of default). Used to block an explicit
  // UPDATE SET col = NULL — defaults only apply on INSERT, so clearing a NOT
  // NULL column on update always violates the constraint (e.g. `createdAt`).
  const [notNullColumns, setNotNullColumns] = useState<Set<string>>(new Set());
  // Full-screen modal editor for long text / JSON values (opened via the
  // expand button on a cell or the context menu).
  const [modalEditCell, setModalEditCell] = useState<{ row: RowData; col: string; dataType?: string } | null>(null);
  // Docked row-inspector panel — opened via the grid's own "#" gutter icon,
  // or via "Inspect Row" in the cell context menu below.
  const [inspectedRow, setInspectedRow] = useState<RowData | null>(null);
  // Separate modal state for new-row cells — new rows aren't in `rows`, so
  // the existing modal (which reads from result.rows via row ref) can't handle
  // them. This tracks which new row + column the modal was opened for.
  const [newRowModal, setNewRowModal] = useState<{ tempId: string; col: string; dataType?: string } | null>(null);
  const [pendingUpdates, setPendingUpdates] = useState<Map<RowData, Record<string, string | null>>>(new Map());
  const [pendingDeletes, setPendingDeletes] = useState<Set<RowData>>(new Set());
  const pushToast = useToastStore((s) => s.push);
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Right-click cell/row context menu (HeidiSQL-style)
  const [cellContextMenu, setCellContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    row: RowData;
    col: string;
  } | null>(null);
  // Clamp the cell context menu to the viewport (0,0 when closed — the menu
  // isn't rendered then, so the position is irrelevant).
  const clampedMenu = useClampedMenuPos(
    cellContextMenu?.mouseX ?? 0,
    cellContextMenu?.mouseY ?? 0
  );

  useEffect(() => {
    setCurrentPage(0);
    setSelectedRows(new Set());
    setPendingUpdates(new Map());
    setPendingDeletes(new Set());
    setNewRows([]);
    setApplyError(null);
    setCellContextMenu(null);
    // A sort column from the previous table may not exist on this one.
    setGridSort(null);
  }, [tabId, tab?.tableName]);

  // ---- Server-side pagination ------------------------------------------------
  // The tab's own `result` only ever holds the first page (LIMIT 100). To move
  // past page 1 we fetch each page directly with LIMIT/OFFSET and a separate
  // COUNT(*) for an accurate total. `tab.result` is still used for column
  // metadata (CRUD).
  const engine = activeConn?.engine ?? 'postgres';

  const loadCount = React.useCallback(async () => {
    if (!activeConn || !tab?.tableName) return;
    const tbl = qualifiedTable(engine, tab.tableName, activeDb);
    try {
      const res = await safeInvoke<QueryResultData>('execute_query', {
        request: { config: queryConfig, sql: `SELECT COUNT(*) AS cnt FROM ${tbl};` },
        queryId: `count_${tab.tableName}_${Date.now()}`,
      });
      // PostgreSQL/SQLite return COUNT(*) as a string ("1000"); MySQL returns
      // it as a number. Handle both, plus edge cases (null/empty/NaN).
      const first = res.rows?.[0]?.[0];
      let n: number;
      if (typeof first === 'number') {
        n = first;
      } else if (typeof first === 'string') {
        // Strip non-digit chars (e.g. commas in some locales) before parsing.
        n = parseInt(first.replace(/[^\d-]/g, ''), 10);
      } else {
        n = 0;
      }
      setTotalCount(Number.isFinite(n) && n > 0 ? n : 0);
    } catch (err: any) {
      // Count failing is non-fatal (paging still works page-by-page), but keep
      // the message around so it can be surfaced alongside a page error.
      setPageError(err?.message || String(err));
    }
  }, [activeConn, engine, activeDb, tab?.tableName]);

  // `overrides` lets a caller supply a page size / sort that hasn't landed in
  // state yet (e.g. right when the user changes it) — reading only from
  // `pageSize`/`gridSort` state would race the setState call and fetch with
  // the stale value for one round-trip. Every other caller (Prev/Next,
  // refresh, apply-changes) omits it and gets the current state as-is.
  const loadPage = React.useCallback(
    async (
      page: number,
      overrides?: { size?: number; sort?: { column: string; dir: 'asc' | 'desc' } | null }
    ) => {
      if (!activeConn || !tab?.tableName) return;
      setLoadingPage(true);
      setPageError(null);
      const size = overrides?.size ?? pageSize;
      const sort = overrides && 'sort' in overrides ? overrides.sort : gridSort;
      const offset = page * size;
      const sql = paginatedSelectSql(engine, tab.tableName, activeDb, size, offset, sort);
      try {
        const res = await safeInvoke<QueryResultData>('execute_query', {
          request: { config: queryConfig, sql },
          queryId: `page_${tab.tableName}_${page}_${Date.now()}`,
        });
        setPageResult(res);
      } catch (err: any) {
        // Surface the REAL backend error text (Postgres/MySQL code + message),
        // the offending SQL, and a retry control — not a vague "db error".
        setPageResult(null);
        setPageError(err?.message || String(err));
      } finally {
        setLoadingPage(false);
      }
    },
    [activeConn, engine, activeDb, tab?.tableName, pageSize, gridSort]
  );

  // In-flight guards: track the table identity each query was last fired for
  // and the pending promise, so that StrictMode double-mounts and overlapping
  // store updates (click does setActiveConnection → setActiveDatabase →
  // openTableDataTab = 3 renders) coalesce into a single IPC round-trip per
  // query. This is what stops the "3-4× duplicate SELECT/COUNT on table click".
  const lastLoadKey = useRef<string | null>(null);
  const inFlightPage = useRef<Promise<void> | null>(null);
  const inFlightCount = useRef<Promise<void> | null>(null);

  // (Re)load count + first page whenever the table/schema/connection changes.
  // Table data tabs auto-load their rows — viewing the data is the tab's
  // purpose. (The SQL editor stays manual.) `loadKey` is a stable composite so
  // the effect only re-fires when something that actually changes the SQL
  // changes — not on every transient store tick.
  const loadKey = `${activeConn?.id}::${tab?.tableName}::${activeDb}`;
  useEffect(() => {
    if (!activeConn || !tab?.tableName) return;
    // Dedupe across StrictMode double-mount and overlapping renders: if a
    // fetch for this exact table/conn/schema is already in flight (or was the
    // last one we kicked off), skip.
    if (lastLoadKey.current === loadKey) return;
    lastLoadKey.current = loadKey;

    // Reset all pagination state for the new table. totalCount is reset here
    // (not inside the in-flight guarded section) so stale counts from a
    // previous table don't linger while the new COUNT(*) is in flight.
    setPageResult(null);
    setTotalCount(0);
    setPageError(null);
    // NOTE: don't reset totalCount to 0 here — loadCount() sets it when the
    // COUNT(*) resolves. Resetting here then having a race re-fire this effect
    // would briefly (or permanently, if the count promise is skipped by the
    // guard) leave "0 rows total" even though the table has data.
    // Fire both, but guard each against re-entry.
    if (!inFlightCount.current) {
      inFlightCount.current = loadCount().finally(() => {
        inFlightCount.current = null;
      });
    }
    if (!inFlightPage.current) {
      inFlightPage.current = loadPage(0).finally(() => {
        inFlightPage.current = null;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  // Fetch the requested page whenever it changes — but skip page 0 on the
  // initial mount, because the table/schema effect above already loads page 0.
  // This effect is for user-driven pagination (page > 0 or explicit changes).
  const prevPage = useRef(0);
  useEffect(() => {
    // Only fire on a genuine page *change* — not on mount (the loader effect
    // owns page 0) and not when the page was reset to 0 by the loader.
    if (prevPage.current === currentPage) return;
    prevPage.current = currentPage;
    loadPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  // Listen for an external reload signal (e.g. after Truncate / Delete All Rows
  // from the Explorer context menu) so an open data grid refreshes its rows
  // and total count without needing to be manually reopened.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (
        detail &&
        detail.connectionId === activeConn?.id &&
        detail.tableName === tab?.tableName
      ) {
        // Reset to page 0 — after a truncate/delete-all there may be fewer
        // (or zero) pages, so staying on the current page would show stale
        // data or an empty grid on a non-existent page.
        setCurrentPage(0);
        setSelectedRows(new Set());
        setPendingUpdates(new Map());
        setPendingDeletes(new Set());
        setNewRows([]);
        setApplyError(null);
        loadCount();
        loadPage(0);
      }
    };
    window.addEventListener('rdsql:reload-table-data', handler as EventListener);
    return () => window.removeEventListener('rdsql:reload-table-data', handler as EventListener);
  }, [activeConn?.id, tab?.tableName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const closeMenu = () => setCellContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  // Reset firstLoad flag when table changes so the skeleton shows on each new
  // table open; clear it once the first page arrives.
  useEffect(() => {
    setFirstLoad(true);
  }, [loadKey]);
  // Clear firstLoad once we actually receive page data (columns + rows) so the
  // skeleton is replaced by the grid.
  useEffect(() => {
    if (pageResult && (pageResult.rows.length > 0 || pageResult.columns.length > 0)) {
      setFirstLoad(false);
    }
  }, [pageResult]);

  // Best-effort discovery of the primary key column(s) so edits/deletes target the right row.
  // Reads from the shared per-connection schema cache (`schemaTreeByConn`) —
  // no extra `fetch_schema_tree` round-trip, since the Explorer already
  // populated it when the connection was expanded.
  useEffect(() => {
    if (!activeConn || !tab?.tableName) {
      setPkColumns([]);
      setFkMap(new Map());
      setRequiredColumns(new Set());
      setNotNullColumns(new Set());
      return;
    }
    const tree = schemaTreeByConn[activeConn.id] || [];
    for (const group of tree) {
      // A table name can exist in more than one schema — when the tab
      // knows which schema it came from, only match that one.
      if (tab.schemaName && group.name !== tab.schemaName) continue;
      const match = group.children.find((t) => t.name === tab.tableName);
      if (match) {
        const { pkColumns, fkMap, requiredColumns, notNullColumns } = buildTableRelationInfo(
          match,
          group.children,
          tab.schemaName || activeDb,
        );
        setPkColumns(pkColumns);
        setFkMap(fkMap);
        setRequiredColumns(requiredColumns);
        setNotNullColumns(notNullColumns);
        return;
      }
    }
    setPkColumns([]);
    setFkMap(new Map());
    setRequiredColumns(new Set());
    setNotNullColumns(new Set());
  }, [activeConn?.id, tab?.tableName, tab?.schemaName, schemaTreeByConn]);

  // Fetch the table's indexes + foreign keys once per (connection, schema,
  // table) so the grid header can show an index / FK icon on covered columns.
  // Best-effort: any error (unsupported engine, permission denied) is swallowed
  // — the header simply won't show the icon.
  useEffect(() => {
    if (!queryConfig || !tab?.tableName) {
      setIndexedColumns(new Set());
      setFkColumns(new Set());
      return;
    }
    let cancelled = false;
    const schema = tab.schemaName || activeDb;
    Promise.all([
      fetchTableIndexes({ config: queryConfig, engine: queryConfig.engine, schema, table: tab.tableName }),
      fetchTableForeignKeys({ config: queryConfig, engine: queryConfig.engine, schema, table: tab.tableName }),
    ])
      .then(([idxs, fks]) => {
        if (cancelled) return;
        const idxSet = new Set<string>();
        for (const idx of idxs) {
          if (idx.isPrimary) continue; // PK already gets the key icon
          for (const col of idx.columns) idxSet.add(col);
        }
        setIndexedColumns(idxSet);
        const fkSet = new Set<string>();
        for (const fk of fks) fkSet.add(fk.column);
        setFkColumns(fkSet);
      })
      .catch(() => {
        if (!cancelled) {
          setIndexedColumns(new Set());
          setFkColumns(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [queryConfig, tab?.tableName, tab?.schemaName, activeDb]);

  if (!tab) return null;

  const result = pageResult ?? tab.result;
  // Prefer the page-fetch error (the real backend message); fall back to the
  // initial execute error. Either way we show the actual DB error text, not a
  // vague wrapper.
  const error = pageError || tab.error;
  const executing = tab.executing;
  const allRows: RowData[] = result?.rows || [];

  // Column names for the skeleton header — prefer the actual result columns
  // (accurate data types), but fall back to the schema-tree cache when the
  // first page is still loading so the skeleton shows the right column count.
  const skeletonColumns = useMemo(() => {
    if (result?.columns?.length) return result.columns.map((c) => c.name);
    const tree = activeConn ? (schemaTreeByConn[activeConn.id] || []) : [];
    for (const group of tree) {
      if (tab.schemaName && group.name !== tab.schemaName) continue;
      const match = group.children.find((t) => t.name === tab.tableName);
      if (match) return match.children.map((c) => c.name);
    }
    return [];
  }, [result?.columns, activeConn?.id, tab?.tableName, tab?.schemaName, schemaTreeByConn]);

  // Search filters within the current page (server-side paging means we can't
  // filter the whole table client-side; this is a convenience for the visible page).
  const filteredRows = allRows.filter((row) =>
    row.some((cell) => String(cell ?? '').toLowerCase().includes(searchFilter.toLowerCase()))
  );

  const totalRows = totalCount;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const pageRows = filteredRows;

  // Virtualization: compute the visible row window from the scroll position.
  const idColumns = pkColumns.length > 0 ? pkColumns : result?.columns.map((c) => c.name) || [];
  const pendingCount = pendingUpdates.size + pendingDeletes.size + newRows.length;

  // Shared column metadata for both the grid and the row-compare modal — kept
  // as one memo so PK/FK/index icons stay identical between the two instead
  // of two copies of the same derivation drifting apart.
  const gridColumns = useMemo(
    () =>
      (result?.columns || []).map((c) => ({
        name: c.name,
        data_type: c.data_type,
        is_required: requiredColumns.has(c.name),
        is_primary_key: pkColumns.includes(c.name),
        is_foreign_key: fkColumns.has(c.name) || fkMap.has(c.name),
        is_indexed: indexedColumns.has(c.name),
        enum_values: c.enum_values,
      })),
    [result?.columns, requiredColumns, pkColumns, fkColumns, fkMap, indexedColumns]
  );

  const handleToggleSelectAll = () => {
    if (selectedRows.size === pageRows.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(pageRows));
    }
  };

  const handleToggleSelectRow = (row: RowData) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
  };

  const handleInsertRow = () => {
    if (!result) return;
    const values: Record<string, string | null> = {};
    result.columns.forEach((c) => {
      values[c.name] = null;
    });
    setNewRows((prev) => [
      ...prev,
      { tempId: `new_${Date.now()}_${Math.random().toString(36).slice(2)}`, values },
    ]);
  };

  // Stage a value coming back from the full-screen modal editor.
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

  const handleDeleteSelected = () => {
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      selectedRows.forEach((r) => next.add(r));
      return next;
    });
    setSelectedRows(new Set());
  };

  const handleDiscardChanges = () => {
    setPendingUpdates(new Map());
    setPendingDeletes(new Set());
    setNewRows([]);
    setApplyError(null);
  };

  // Sorting is server-side: each page only ever holds `pageSize` rows of the
  // table, so sorting just the loaded page client-side would silently sort
  // the wrong thing (a 100-row slice, not the table). A header click instead
  // resets to page 0 and re-fetches with `ORDER BY <column> <dir>`.
  //
  // Resetting an already-0 `currentPage` to 0 is a no-op state update, so the
  // page-change effect below (keyed on `currentPage`) won't fire — in that
  // case we fetch directly. Otherwise setting the page is enough: the effect
  // picks it up and reads the just-updated sort/size off state itself.
  const handleSortChange = (sort: { column: string; dir: 'asc' | 'desc' } | null) => {
    setGridSort(sort);
    if (currentPage === 0) {
      loadPage(0, { sort });
    } else {
      setCurrentPage(0);
    }
  };

  const handlePageSizeChange = (size: number) => {
    const clamped = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(size) || DEFAULT_PAGE_SIZE));
    setPageSize(clamped);
    setPageSizeDraft(String(clamped));
    if (currentPage === 0) {
      loadPage(0, { size: clamped });
    } else {
      setCurrentPage(0);
    }
  };

  const commitCustomPageSize = () => {
    const n = parseInt(pageSizeDraft, 10);
    if (Number.isFinite(n) && n > 0) {
      handlePageSizeChange(n);
    } else {
      setPageSizeDraft(String(pageSize));
    }
    setCustomPageSizeOpen(false);
  };

  const handleCellContextMenu = (e: React.MouseEvent, row: RowData, col: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCellContextMenu({ mouseX: e.clientX, mouseY: e.clientY, row, col });
  };

  const closeCellMenu = () => setCellContextMenu(null);

  // Effective values for the row under the context menu — current pending
  // edits win over the last-fetched values, so Copy/Duplicate reflect what
  // the user is about to apply, not stale data.
  const rowValuesForMenu = (row: RowData): Record<string, CellValue> => {
    const map: Record<string, CellValue> = {};
    if (!result) return map;
    const edits = pendingUpdates.get(row);
    result.columns.forEach((c, i) => {
      const hasEdit = edits && Object.prototype.hasOwnProperty.call(edits, c.name);
      map[c.name] = hasEdit ? edits![c.name] : row[i];
    });
    return map;
  };

  const handleEditFromMenu = () => {
    if (!cellContextMenu || !result) return;
    const { row, col } = cellContextMenu;
    // Open the full-screen modal editor — the inline cell editor is managed
    // by the DataGrid component itself; from the context menu we jump straight
    // to the modal for long text / JSON values.
    const colIdx = result.columns.findIndex((c) => c.name === col);
    const dataType = colIdx >= 0 ? result.columns[colIdx]?.data_type : undefined;
    setModalEditCell({ row, col, dataType });
    closeCellMenu();
  };

  const handleSetCellNullFromMenu = () => {
    if (!cellContextMenu) return;
    const { row, col } = cellContextMenu;
    setPendingUpdates((prev) => {
      const next = new Map(prev);
      const rowEdits = { ...(next.get(row) || {}) };
      rowEdits[col] = null;
      next.set(row, rowEdits);
      return next;
    });
    closeCellMenu();
  };

  const handleCopyCellValue = () => {
    if (!cellContextMenu) return;
    const values = rowValuesForMenu(cellContextMenu.row);
    const v = values[cellContextMenu.col];
    void copyToClipboard(v === null || v === undefined ? '' : String(v));
    closeCellMenu();
  };

  const handleCopyRowCsv = () => {
    if (!cellContextMenu || !result) return;
    const values = rowValuesForMenu(cellContextMenu.row);
    void copyToClipboard(result.columns.map((c) => toCsvField(values[c.name])).join(','));
    closeCellMenu();
  };

  const handleCopyRowJson = () => {
    if (!cellContextMenu) return;
    void copyToClipboard(JSON.stringify(rowValuesForMenu(cellContextMenu.row), null, 2));
    closeCellMenu();
  };

  const handleCopyRowInsertSql = () => {
    if (!cellContextMenu || !result || !activeConn || !tab.tableName) return;
    const q = (n: string) => quoteIdent(activeConn.engine, n);
    const values = rowValuesForMenu(cellContextMenu.row);
    const cols = result.columns.map((c) => c.name);
    const colNames = cols.map((c) => q(c)).join(', ');
    const colVals = cols.map((c) => sqlLiteral(values[c])).join(', ');
    const target = qualifiedTable(activeConn.engine, tab.tableName, tab.schemaName);
    void copyToClipboard(`INSERT INTO ${target} (${colNames}) VALUES (${colVals});`);
    closeCellMenu();
  };

  const [exporting, setExporting] = useState(false);
  const handleExportCsv = async () => {
    if (!result || exporting) return;
    setExporting(true);
    try {
      // Build CSV from the current page's columns + rows.
      const header = result.columns.map((c) => toCsvField(c.name)).join(',');
      const body = (result.rows || [])
        .map((row) => {
          const values = rowValuesForMenu(row);
          return result.columns.map((c) => toCsvField(values[c.name])).join(',');
        })
        .join('\n');
      const csv = `${header}\n${body}`;

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const defaultName = `${tab.tableName}_${stamp}.csv`;
      const path = await save({
        title: 'Export CSV',
        defaultPath: defaultName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!path) return; // user cancelled
      await writeTextFile(path, csv);
    } catch (err: any) {
      console.error('CSV export failed:', err);
      alert(`Failed to export CSV: ${err?.message || err}`);
    } finally {
      setExporting(false);
    }
  };

  const handleDuplicateRowFromMenu = () => {
    if (!cellContextMenu || !result) return;
    const values = rowValuesForMenu(cellContextMenu.row);
    const asStrings: Record<string, string | null> = {};
    result.columns.forEach((c) => {
      const v = values[c.name];
      asStrings[c.name] = v === null || v === undefined ? null : String(v);
    });
    setNewRows((prev) => [
      ...prev,
      { tempId: `dup_${Date.now()}_${Math.random().toString(36).slice(2)}`, values: asStrings },
    ]);
    closeCellMenu();
  };

  const handleInsertRowFromMenu = () => {
    handleInsertRow();
    closeCellMenu();
  };

  const handleToggleDeleteFromMenu = () => {
    if (cellContextMenu) toggleRowDelete(cellContextMenu.row);
    closeCellMenu();
  };

  const handleRefreshFromMenu = () => {
    executeQuery(tabId);
    loadCount();
    loadPage(currentPage);
    closeCellMenu();
  };

  const handleApply = async () => {
    if (!activeConn || !tab.tableName || !result) return;
    setApplying(true);
    setApplyError(null);

    // Client-side validation, run before anything touches the database.
    // Two checks:
    //  1. New rows must fill every required column (NOT NULL, no default).
    //  2. Updates must not set a NOT NULL column to NULL — defaults only
    //     apply on INSERT, so `UPDATE ... SET col = NULL` on a NOT NULL
    //     column (even one with a default like `createdAt DEFAULT now()`)
    //     always violates the constraint (Postgres error 23502).
    const validationErrors: string[] = [];
    if (requiredColumns.size > 0) {
      newRows.forEach((nr, i) => {
        requiredColumns.forEach((col) => {
          const v = nr.values[col];
          if (v === null || v === undefined || v === '') {
            validationErrors.push(`New row #${i + 1}: "${col}" is required`);
          }
        });
      });
    }
    if (notNullColumns.size > 0) {
      pendingUpdates.forEach((changes, row) => {
        if (pendingDeletes.has(row)) return;
        Object.entries(changes).forEach(([col, val]) => {
          if (val === null && notNullColumns.has(col)) {
            validationErrors.push(`"${col}" can't be set to NULL — column is NOT NULL`);
          }
        });
      });
    }

    if (validationErrors.length > 0) {
      setApplyError(`Cannot apply — ${validationErrors.join('; ')}.`);
      setApplying(false);
      return;
    }

    const q = (name: string) => quoteIdent(activeConn.engine, name);
    const tableIdent = qualifiedTable(activeConn.engine, tab.tableName, tab.schemaName);
    const stmts: string[] = [];

    const whereFor = (row: RowData) =>
      idColumns
        .map((colName) => {
          const ci = result.columns.findIndex((c) => c.name === colName);
          const val = ci >= 0 ? row[ci] : null;
          // `col = NULL` never matches in SQL (three-valued logic) — a row
          // whose identifying column is NULL would silently match zero rows,
          // so the edit looks applied (no error) but reverts on refresh.
          return val === null || val === undefined ? `${q(colName)} IS NULL` : `${q(colName)} = ${sqlLiteral(val)}`;
        })
        .join(' AND ');

    pendingDeletes.forEach((row) => {
      stmts.push(`DELETE FROM ${tableIdent} WHERE ${whereFor(row)};`);
    });

    pendingUpdates.forEach((changes, row) => {
      if (pendingDeletes.has(row)) return;
      const setParts = Object.entries(changes).map(([col, val]) => `${q(col)} = ${sqlLiteral(val)}`);
      if (setParts.length === 0) return;
      stmts.push(`UPDATE ${tableIdent} SET ${setParts.join(', ')} WHERE ${whereFor(row)};`);
    });

    newRows.forEach(({ values }) => {
      const cols = Object.keys(values).filter((c) => values[c] !== null && values[c] !== '');
      if (cols.length === 0) return;
      const colNames = cols.map((c) => q(c)).join(', ');
      const colVals = cols.map((c) => sqlLiteral(values[c])).join(', ');
      stmts.push(`INSERT INTO ${tableIdent} (${colNames}) VALUES (${colVals});`);
    });

    if (stmts.length === 0) {
      setApplying(false);
      return;
    }

    // Every INSERT/UPDATE/DELETE the grid runs gets recorded by the IPC layer
    // via `__meta: { source: 'table' }`, so it shows up in Query Log & History
    // (and, if it fails, in the Errors tab) — not just the refresh SELECT.
    let failure: string | null = null;
    let unmatchedCount = 0;
    for (const [stmtIdx, stmt] of stmts.entries()) {
      try {
        const res = await safeInvoke<{ affected_rows?: number }>('execute_query', {
          request: { config: queryConfig, sql: stmt },
          queryId: `crud_${tab.tableName}_${stmtIdx}_${Date.now()}`,
          __meta: { source: 'table' },
        });
        // A no-op UPDATE/DELETE (WHERE matched nothing) doesn't throw — it
        // looks identical to success unless we check affected_rows. Without
        // this, a stale/mismatched WHERE clause (e.g. an editable result
        // grid whose data shifted, or an identifying column that's NULL)
        // silently discards the edit: no error shown, and the refresh below
        // just re-displays the unchanged row.
        if ((stmt.startsWith('UPDATE ') || stmt.startsWith('DELETE ')) && res.affected_rows === 0) {
          unmatchedCount += 1;
        }
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

    if (unmatchedCount > 0) {
      pushToast({
        severity: 'warning',
        title: `${unmatchedCount} change${unmatchedCount > 1 ? 's' : ''} matched no row`,
        message: 'The row may have changed or been deleted since it was loaded. Nothing was saved for it — refresh and try again.',
      });
    }

    setPendingUpdates(new Map());
    setPendingDeletes(new Set());
    setNewRows([]);
    await executeQuery(tabId);
    // Refresh the visible page + total so the grid reflects the committed changes.
    await loadCount();
    await loadPage(currentPage);
    setApplying(false);
  };

  return (
    <div className="h-full w-full bg-[#06090e] flex flex-col select-none font-sans overflow-hidden">
      {/* Table Data Top Action Toolbar */}
      <div className="h-10 border-b border-[#1e293b] px-3 bg-[#0a0f18] flex items-center justify-between gap-2 shrink-0 overflow-x-auto">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-6 h-6 rounded bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
            <TableIcon className="w-3.5 h-3.5" />
          </div>
          <span className="font-bold text-xs text-slate-100 whitespace-nowrap">{tab.tableName}</span>
          {activeConn && (
            <span className="text-[10px] text-slate-500 font-mono whitespace-nowrap hidden md:inline">
              ({activeConn.engine.toUpperCase()} / {activeConn.database || 'default'})
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Quick Search */}
          <div className="relative flex items-center shrink-0">
            <Search className="w-3 h-3 text-slate-500 absolute left-2" />
            <input
              type="text"
              placeholder={`Search ${tab.tableName}...`}
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="bg-[#0f172a] text-xs text-slate-200 pl-7 pr-2 py-1 rounded-lg border border-[#1e293b] focus:outline-none focus:border-cyan-500 w-28 sm:w-52"
            />
          </div>

          <button
            onClick={handleInsertRow}
            disabled={!result || applying}
            className="px-2 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-emerald-400 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50 shrink-0 whitespace-nowrap"
            title="Insert a new row"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Insert Row</span>
          </button>

          {pendingCount > 0 && (
            <>
              <button
                onClick={handleDiscardChanges}
                disabled={applying}
                className="px-2 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-slate-400 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50 shrink-0 whitespace-nowrap"
                title="Discard pending changes"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span className="hidden lg:inline">Discard</span>
              </button>
              <button
                onClick={handleApply}
                disabled={applying}
                className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50 shadow-md shadow-emerald-600/30 shrink-0 whitespace-nowrap"
                title="Apply pending changes to the database"
              >
                {applying ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span>Apply ({pendingCount})</span>
              </button>
            </>
          )}

          <button
            onClick={() => openSqlTab(`${tab.tableName}.sql`, selectPreviewSql(engine, tab.tableName || ''), tab.connectionId, tab.schemaName)}
            className="p-1 rounded-lg hover:bg-[#1e293b] text-slate-400 transition-colors shrink-0"
            title="Open in SQL Query Editor"
          >
            <FileCode className="w-3.5 h-3.5 text-blue-400" />
          </button>

          <button
            onClick={handleExportCsv}
            disabled={!result || exporting}
            className="p-1 rounded-lg hover:bg-[#1e293b] disabled:opacity-50 disabled:cursor-not-allowed text-slate-400 transition-colors shrink-0"
            title={exporting ? 'Exporting…' : 'Export CSV'}
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Advanced filter (opens drawer) — sits next to Refresh. */}
          <button
            onClick={() => setGridFilterOpen((v) => !v)}
            className={`relative p-1 rounded-lg transition-colors shrink-0 ${
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

          {/* Active sort indicator (clears sort on click). */}
          {gridSort && result && (
            <span className="inline-flex items-center gap-0.5 text-cyan-300 font-mono text-[10px] shrink-0">
              {gridSort.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
              {gridSort.column}
              <button
                onClick={() => handleSortChange(null)}
                className="text-slate-500 hover:text-red-400"
                title="Clear sort"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {/* Refresh — icon-only, label on hover via title. */}
          <button
            onClick={() => {
              executeQuery(tabId);
              loadCount();
              loadPage(currentPage);
            }}
            disabled={executing}
            className="p-1 rounded-lg hover:bg-[#1e293b] text-slate-400 transition-colors disabled:opacity-50 shrink-0"
            title="Refresh table data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${executing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Pending Changes Warning / Error Banner */}
      {pendingCount > 0 && pkColumns.length === 0 && (
        <div className="px-3 py-1.5 bg-amber-950/20 border-b border-amber-500/30 text-amber-300 text-[11px] flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          No primary key detected on this table — updates/deletes will match on all column values, which can be
          unsafe if rows aren't unique.
        </div>
      )}
      {applyError && (
        <div className="px-3 py-1.5 border-b border-red-500/30 shrink-0">
          <CopyableErrorBanner message={`Failed to apply changes: ${applyError}`} tone="red" compact parseAsDbError />
        </div>
      )}

      {/* Batch Selection Banner */}
      {selectedRows.size > 0 && (
        <div className="h-8 bg-blue-600/15 border-b border-blue-500/30 px-3 flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-2 font-medium text-blue-300">
            <CheckCheck className="w-4 h-4 text-blue-400" />
            <span>
              <strong>{selectedRows.size}</strong> row(s) selected
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setCompareOpen(true)}
              disabled={selectedRows.size < 2}
              title={selectedRows.size < 2 ? 'Select at least 2 rows to compare' : 'Compare selected rows side by side'}
              className="px-2.5 py-0.5 rounded bg-[#1e293b] hover:bg-[#334155] text-slate-200 font-semibold text-xs flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <GitCompare className="w-3 h-3" />
              Compare
            </button>
            <button
              onClick={handleDeleteSelected}
              className="px-2.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white font-semibold text-xs flex items-center gap-1 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Mark Selected for Deletion
            </button>
          </div>
        </div>
      )}

      {compareOpen && (() => {
        // Compare in page order (not Set insertion/click order) so the modal
        // reads left-to-right the same way the grid does.
        const compareRows: RowData[] = [];
        const compareRowNumbers: number[] = [];
        pageRows.forEach((row, idx) => {
          if (selectedRows.has(row)) {
            compareRows.push(row);
            compareRowNumbers.push(currentPage * pageSize + idx + 1);
          }
        });
        return (
          <RowCompareModal
            columns={gridColumns}
            rows={compareRows}
            rowNumbers={compareRowNumbers}
            onClose={() => setCompareOpen(false)}
          />
        );
      })()}

      {/* Full Panel Edge-to-Edge Grid (No Card Outer Wrapping) */}
      <div ref={gridAreaRef} className="flex-1 flex flex-col overflow-hidden bg-[#06090e]">
        {!activeConn ? (
          // This tab was opened against a connection that no longer exists in
          // `connections` (deleted, or an older tab with a stale id). Silently
          // no-op'ing loadPage/loadCount would otherwise leave the grid either
          // blank or showing whatever page it last had, with "Click refresh"
          // as the only feedback — refresh would just no-op again. Surface it
          // explicitly instead of guessing.
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center p-6">
            <AlertTriangle className="w-8 h-8 text-amber-400" />
            <div className="text-sm text-slate-300 font-medium">Connection no longer available</div>
            <div className="text-[11px] text-slate-500 max-w-sm leading-relaxed">
              The connection this tab was opened on isn’t in your connection list anymore — it may have
              been deleted. Reconnect from the Explorer, or close this tab.
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => setActiveView('explorer')}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
              >
                Go to Explorer
              </button>
              <button
                onClick={() => closeTab(tabId)}
                className="px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#334155] text-slate-200 text-xs font-semibold transition-colors"
              >
                Close Tab
              </button>
            </div>
          </div>
        ) : error ? (
          (() => {
            const e = parseDbError(error);
            const offendingSql =
              e.sql ||
              paginatedSelectSql(engine, tab.tableName || '', activeDb, pageSize, currentPage * pageSize, gridSort);
            return (
              <div className="m-4 rounded-xl border border-red-500/30 bg-red-950/20 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 bg-red-950/40 border-b border-red-500/30 text-red-200">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider">
                    Failed to load "{tab.tableName}"
                  </span>
                  <span className={`ml-auto text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#0a0f18] ${errorKindColor(e.kind)}`}>
                    {errorKindLabel(e.kind)}
                  </span>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-semibold">
                      Message{e.code ? ` · ${e.code}` : ''}
                    </div>
                    <pre className="text-red-200 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                      {e.message}
                    </pre>
                  </div>
                  {e.detail && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-semibold">
                        Detail
                      </div>
                      <pre className="text-slate-300 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                        {e.detail}
                      </pre>
                    </div>
                  )}
                  {e.hint && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-cyan-500/70 mb-1 font-semibold">
                        Hint
                      </div>
                      <pre className="text-cyan-300 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                        {e.hint}
                      </pre>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-semibold">
                      Offending query
                    </div>
                    <pre className="text-slate-400 text-[11px] font-mono whitespace-pre-wrap break-all">
                      {offendingSql}
                    </pre>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => {
                        setPageError(null);
                        loadCount();
                        loadPage(currentPage);
                      }}
                      className="px-3 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Retry
                    </button>
                    <button
                      onClick={() =>
                        copyToClipboard(
                          formatDbErrorTrace(e) + `\nSQL: ${offendingSql}`
                        )
                      }
                      className="px-3 py-1 rounded-lg bg-[#1e293b] hover:bg-[#334155] text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                    >
                      Copy trace
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        ) : firstLoad && loadingPage ? (
          // Skeleton loading — shown on first open while the initial page +
          // count queries are in flight. Column count matches the actual table
          // (from the schema-tree cache); row count fills the viewport so the
          // skeleton looks like the real grid that's about to appear.
          (() => {
            const ROW_H = 30;
            const HEADER_H = 33; // matches the grid header (py-2 + text)
            const cols = skeletonColumns;
            const rowCount = Math.max(1, Math.ceil((gridAreaH - HEADER_H) / ROW_H));
            return (
              <div className="h-full flex flex-col bg-[#06090e]">
                {/* Grid skeleton — table-fixed so columns share width evenly.
                    The skeleton grid alone communicates loading; no separate
                    spinner bar is needed. */}
                <div className="flex-1 overflow-hidden">
                  <table className="w-full text-left text-xs font-mono border-collapse table-fixed">
                    <thead className="bg-[#0f172a] border-b border-[#1e293b] text-slate-400 uppercase text-[10px] tracking-wider">
                      <tr>
                        <th className="px-3 py-2 border-r border-[#1e293b] w-10 text-center text-slate-600">#</th>
                        {cols.length > 0 ? (
                          cols.map((name) => (
                            <th key={name} className="px-3 py-2 border-r border-[#1e293b] min-w-[140px]">
                              <div className="h-3 w-3/4 bg-[#1e293b] rounded animate-pulse" />
                            </th>
                          ))
                        ) : (
                          // Schema tree not loaded yet either — show a few
                          // placeholder columns so the grid structure is clear.
                          Array.from({ length: 5 }).map((_, j) => (
                            <th key={j} className="px-3 py-2 border-r border-[#1e293b] min-w-[140px]">
                              <div className="h-3 w-3/4 bg-[#1e293b] rounded animate-pulse" />
                            </th>
                          ))
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: rowCount }).map((_, i) => (
                        <tr key={i} className="border-b border-[#1e293b]/50">
                          <td className="px-3 py-1.5 border-r border-[#1e293b]/50">
                            <div className="h-3 w-6 mx-auto bg-[#141e33] rounded animate-pulse" />
                          </td>
                          {(cols.length > 0 ? cols : Array.from({ length: 5 })).map((_, j) => (
                            <td key={j} className="px-3 py-1.5 border-r border-[#1e293b]/50">
                              <div className="h-3 bg-[#141e33] rounded animate-pulse" />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()
        ) : executing ? (
          <div className="h-full flex items-center justify-center gap-2 text-xs text-slate-400 font-mono">
            <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
            Loading {tab.tableName} table rows...
          </div>
        ) : !result ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500 font-mono">
            No table data loaded. Click refresh to query rows.
          </div>
        ) : (
          <DataGrid
            columns={gridColumns}
            rows={pageRows}
            editable
            pendingUpdates={pendingUpdates}
            pendingDeletes={pendingDeletes}
            fkMap={fkMap}
            relationConnection={queryConfig ?? activeConn ?? undefined}
            activeSchema={activeDb}
            newRows={newRows}
            onNewRowEdit={(tempId, colName, value) => {
              setNewRows((prev) =>
                prev.map((r) =>
                  r.tempId === tempId
                    ? { ...r, values: { ...r.values, [colName]: value } }
                    : r
                )
              );
            }}
            onNewRowRemove={(tempId) => setNewRows((prev) => prev.filter((r) => r.tempId !== tempId))}
            onNewRowOpenModal={(tempId, colName, dataType) => setNewRowModal({ tempId, col: colName, dataType })}
            selectedRows={selectedRows}
            onToggleSelectRow={handleToggleSelectRow}
            onToggleSelectAll={(checked) => (checked ? setSelectedRows(new Set(pageRows)) : setSelectedRows(new Set()))}
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
            onCellContextMenu={handleCellContextMenu}
            rowNumberOffset={currentPage * pageSize}
            sortState={gridSort}
            onSortChange={handleSortChange}
            filterConditions={gridFilters}
            onFilterChange={setGridFilters}
            filterOpen={gridFilterOpen}
            onFilterOpenChange={setGridFilterOpen}
            inspectedRow={inspectedRow}
            onInspectedRowChange={setInspectedRow}
            columnStorageKey={`${activeConn?.id || 'x'}_${activeDb || 'default'}_${tab.tableName}`}
          />
        )}
      </div>

      {/* Pagination Footer */}
      {result && (
        <div className="h-9 px-3 border-t border-[#1e293b] bg-[#0a0f18] flex items-center justify-between text-xs select-none shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-slate-400 font-mono text-[11px] truncate">
              {loadingPage
                ? 'Loading page…'
                : `${totalRows.toLocaleString()} row${totalRows === 1 ? '' : 's'} total • Page ${currentPage + 1} of ${totalPages}`}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <select
                value={PAGE_SIZE_PRESETS.includes(pageSize) ? String(pageSize) : 'custom'}
                onChange={(e) => {
                  if (e.target.value === 'custom') {
                    setPageSizeDraft(String(pageSize));
                    setCustomPageSizeOpen(true);
                  } else {
                    setCustomPageSizeOpen(false);
                    handlePageSizeChange(Number(e.target.value));
                  }
                }}
                disabled={executing || loadingPage}
                className="bg-[#0f172a] border border-[#1e293b] rounded px-1 py-0.5 text-[11px] text-slate-300 font-mono focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                title="Rows per page"
              >
                {PAGE_SIZE_PRESETS.map((n) => (
                  <option key={n} value={n}>{n}/page</option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {customPageSizeOpen && (
                <input
                  type="number"
                  min={1}
                  max={MAX_PAGE_SIZE}
                  value={pageSizeDraft}
                  autoFocus
                  onChange={(e) => setPageSizeDraft(e.target.value)}
                  onBlur={commitCustomPageSize}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCustomPageSize();
                    if (e.key === 'Escape') {
                      setPageSizeDraft(String(pageSize));
                      setCustomPageSizeOpen(false);
                    }
                  }}
                  className="w-16 bg-[#0f172a] border border-cyan-500/50 rounded px-1.5 py-0.5 text-[11px] text-slate-200 font-mono focus:outline-none"
                />
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
              disabled={currentPage === 0 || executing || loadingPage}
              className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white disabled:opacity-30 transition-colors flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev</span>
            </button>

            <span className="text-slate-200 font-medium font-mono text-[11px]">
              {currentPage + 1} / {totalPages}
            </span>

            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={currentPage + 1 >= totalPages || executing || loadingPage}
              className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white disabled:opacity-30 transition-colors flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Right-click cell/row context menu, HeidiSQL-style */}
      {cellContextMenu && result && (
        <div
          ref={clampedMenu.ref}
          style={clampedMenu.style}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-60 py-1.5 text-xs text-slate-200 select-none font-sans"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate">
            column: {cellContextMenu.col}
          </div>

          <button
            onClick={() => {
              setInspectedRow(cellContextMenu.row);
              setCellContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <Expand className="w-3.5 h-3.5" />
            <span>Inspect Row</span>
          </button>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={handleEditFromMenu}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>Edit Cell</span>
          </button>
          <button
            onClick={() => {
              if (!cellContextMenu || !result) return;
              const colIdx = result.columns.findIndex((c) => c.name === cellContextMenu.col);
              setModalEditCell({
                row: cellContextMenu.row,
                col: cellContextMenu.col,
                dataType: colIdx >= 0 ? result.columns[colIdx].data_type : undefined,
              });
              setCellContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>Edit in Modal</span>
          </button>
          <button
            onClick={handleSetCellNullFromMenu}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-amber-400"
          >
            <Ban className="w-3.5 h-3.5" />
            <span>Set to NULL</span>
          </button>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={handleCopyCellValue}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>Copy Cell Value</span>
          </button>
          <button
            onClick={handleCopyRowCsv}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <Files className="w-3.5 h-3.5" />
            <span>Copy Row as CSV</span>
          </button>
          <button
            onClick={handleCopyRowInsertSql}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <FileCode className="w-3.5 h-3.5" />
            <span>Copy Row as INSERT</span>
          </button>
          <button
            onClick={handleCopyRowJson}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <Clipboard className="w-3.5 h-3.5" />
            <span>Copy Row as JSON</span>
          </button>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={handleInsertRowFromMenu}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-emerald-400"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Insert Row</span>
          </button>
          <button
            onClick={handleDuplicateRowFromMenu}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-emerald-400"
          >
            <CopyPlus className="w-3.5 h-3.5" />
            <span>Duplicate Row</span>
          </button>
          <button
            onClick={handleToggleDeleteFromMenu}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{pendingDeletes.has(cellContextMenu.row) ? 'Undo Delete' : 'Delete Row'}</span>
          </button>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={handleRefreshFromMenu}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      )}

      {/* Full-screen modal editor for long text / JSON cells */}
      {modalEditCell && result && (
        <CellEditorModal
          columnName={modalEditCell.col}
          dataType={modalEditCell.dataType}
          isJson={isJsonType(modalEditCell.dataType)}
          enumValues={gridColumns.find((c) => c.name === modalEditCell.col)?.enum_values}
          relation={fkMap.get(modalEditCell.col)}
          relationConnection={queryConfig ?? activeConn ?? undefined}
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

      {/* Full-screen modal editor for new-row cells */}
      {newRowModal && (
        <CellEditorModal
          columnName={newRowModal.col}
          dataType={newRowModal.dataType}
          isJson={isJsonType(newRowModal.dataType)}
          enumValues={gridColumns.find((c) => c.name === newRowModal.col)?.enum_values}
          relation={fkMap.get(newRowModal.col)}
          relationConnection={queryConfig ?? activeConn ?? undefined}
          value={
            (() => {
              const nr = newRows.find((r) => r.tempId === newRowModal.tempId);
              const v = nr?.values[newRowModal.col];
              return cellToEditableString(v, isJsonType(newRowModal.dataType));
            })()
          }
          onClose={() => setNewRowModal(null)}
          onSave={(value) => {
            setNewRows((prev) =>
              prev.map((r) =>
                r.tempId === newRowModal.tempId
                  ? { ...r, values: { ...r.values, [newRowModal.col]: value } }
                  : r
              )
            );
          }}
        />
      )}
    </div>
  );
};
