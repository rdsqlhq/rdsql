import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  FileText,
  GitCompare,
  KeyRound,
  Loader2,
  Play,
  Search,
  ShieldAlert,
  X,
  Cloud,
} from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, remove } from '@tauri-apps/plugin-fs';
import { cn } from '../../core/utils/cn';
import { copyToClipboard } from '../../core/utils/clipboard';
import { describeFsError } from '../../core/utils/fsErrors';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { useToastStore } from '../../store/useToastStore';
// S3-mediated migration transport (Phase 7) — additive. Only adds an export
// destination; the direct DB-to-DB apply path is untouched.
import { useStorageStore } from '../../store/useStorageStore';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { normalizePrefix } from '../../core/storage/domain/paths';
import { safeInvoke } from '../../core/tauri/ipc';
import { SqlPreview } from './SqlPreview';
import {
  EMPTY_FILTER,
  allObjectKeys,
  buildObjectChanges,
  buildObjectRows,
  filterRows,
  filterStatements,
  safeObjectKeys,
  scriptText,
  statementKind,
  summarizeObjects,
  summarizeStatements,
  totalRows,
} from '../../core/compare/diffModel';
import type {
  ColumnChange,
  ObjectChange,
  ObjectFilter,
  ObjectRow,
  StatementKind,
  StatusFilter,
} from '../../core/compare/diffModel';
import type {
  ApplyResult,
  DiffStatus,
  SchemaDiffResult,
  SyncScript,
  SyncStatement,
} from '../../core/domain/types';

/**
 * Schema Compare — one screen.
 *
 * The whole comparison reads top to bottom: what differs (summary chips), the
 * table-by-table list (source on the left, target on the right, click a row to
 * open its field differences), and one action bar at the bottom that walks the
 * user through Generate → Review → Apply. The generated SQL opens in a drawer
 * so reviewing it never means losing your place in the list.
 *
 * Selection is presentation-only: it narrows which of the backend's generated
 * statements get handed to `apply_schema_sync`. No SQL is written here.
 */

// ---------------------------------------------------------------------------
// Vocabulary — plain words, and a sign so colour is never the only signal
// ---------------------------------------------------------------------------

const STATUS_META: Record<DiffStatus, { sign: string; label: string; cls: string }> = {
  added: { sign: '+', label: 'New', cls: 'text-emerald-400' },
  modified: { sign: '~', label: 'Changed', cls: 'text-amber-400' },
  removed: { sign: '−', label: 'Only in target', cls: 'text-rose-400' },
  unchanged: { sign: '=', label: 'Same', cls: 'text-slate-600' },
};

const KIND_META: Record<StatementKind, { label: string; cls: string }> = {
  create: { label: 'CREATE', cls: 'text-emerald-400' },
  alter: { label: 'ALTER', cls: 'text-amber-400' },
  drop: { label: 'DROP', cls: 'text-rose-400' },
};

/** Row counts come from engine statistics, not a COUNT(*) per table. */
const ROW_COUNT_NOTE =
  'Row counts come from engine statistics: exact on SQLite, estimated on MySQL and PostgreSQL.';

/** Marks a change that deletes data in the target. */
const DropBadge: React.FC = () => (
  <span
    title="Applying this deletes data in the target"
    className="inline-flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-1 py-px text-[9px] font-bold uppercase tracking-wider text-rose-400"
  >
    <ShieldAlert className="w-2.5 h-2.5" />
    Deletes data
  </span>
);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SchemaCompareViewProps {
  canCompare: boolean;
  /** Why comparing is blocked, when it is. */
  blockedReason?: string;
  comparing: boolean;
  error: string | null;
  diff: SchemaDiffResult | null;
  sourceLabel: string;
  targetLabel: string;
  targetIsProd: boolean;
  onCompare: () => void;
  syncScript: SyncScript | null;
  generatingSync: boolean;
  syncError: string | null;
  applyResult: ApplyResult | null;
  onGenerateSync: () => void;
  /** Receives exactly the statements the user chose to apply. */
  onApply: (statements: SyncStatement[]) => void;
  applying: boolean;
  /** Incremented by the parent to open the SQL drawer ("Review SQL first"). */
  focusSqlSignal?: number;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const SchemaCompareView: React.FC<SchemaCompareViewProps> = ({
  canCompare,
  blockedReason,
  comparing,
  error,
  diff,
  sourceLabel,
  targetLabel,
  targetIsProd,
  onCompare,
  syncScript,
  generatingSync,
  syncError,
  applyResult,
  onGenerateSync,
  onApply,
  applying,
  focusSqlSignal = 0,
}) => {
  const pushToast = useToastStore((s) => s.push);

  /** Every table/view in either database. */
  const rows = useMemo(() => (diff ? buildObjectRows(diff) : []), [diff]);
  /** Only the ones that differ — these drive selection and the sync script. */
  const objects = useMemo(() => (diff ? buildObjectChanges(diff) : []), [diff]);
  const summary = useMemo(() => summarizeObjects(objects), [objects]);

  const [filter, setFilter] = useState<ObjectFilter>(EMPTY_FILTER);
  /** Objects whose changes will be included in the applied script. */
  const [included, setIncluded] = useState<ReadonlySet<string>>(new Set());
  const [excludeDrops, setExcludeDrops] = useState(false);
  const [sqlOpen, setSqlOpen] = useState(false);
  /** When set, the drawer shows only this object's statements. */
  const [sqlObject, setSqlObject] = useState<string | null>(null);

  // A fresh comparison resets the review state. Everything selected by default,
  // which reproduces the original full-sync behaviour exactly.
  useEffect(() => {
    setIncluded(new Set(allObjectKeys(objects)));
    setExcludeDrops(false);
    setFilter(EMPTY_FILTER);
    setSqlObject(null);
    setSqlOpen(false);
  }, [objects]);

  // "Review SQL first" in the apply confirmation routes back here.
  useEffect(() => {
    if (focusSqlSignal > 0) {
      setSqlObject(null);
      setSqlOpen(true);
    }
  }, [focusSqlSignal]);

  const visibleRows = useMemo(() => filterRows(rows, filter), [rows, filter]);

  const statusCounts = useMemo(() => {
    const c = { all: rows.length, added: 0, modified: 0, removed: 0, unchanged: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const includedObjects = useMemo(
    () => objects.filter((o) => included.has(o.key)),
    [objects, included]
  );
  const includedSummary = useMemo(() => summarizeObjects(includedObjects), [includedObjects]);
  const allIncluded = included.size === objects.length;

  /** The exact statement list an apply would run. */
  const statements = useMemo(() => {
    if (!syncScript) return [];
    return filterStatements(syncScript.statements, {
      // `null` keeps the script byte-identical when nothing was deselected.
      selectedKeys: allIncluded ? null : included,
      excludeDestructive: excludeDrops,
    });
  }, [syncScript, included, allIncluded, excludeDrops]);

  const scriptSummary = useMemo(() => summarizeStatements(statements), [statements]);

  const toggleObject = useCallback((key: string) => {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(scriptText(statements));
    pushToast(
      ok
        ? { severity: 'info', title: 'Copied', message: `${statements.length} statement(s) copied.` }
        : { severity: 'error', title: 'Copy failed', message: 'The clipboard is not available.' }
    );
  };

  const handleExport = async () => {
    try {
      const path = await save({
        defaultPath: `schema-sync-${new Date().toISOString().slice(0, 10)}.sql`,
        filters: [{ name: 'SQL', extensions: ['sql'] }],
      });
      if (!path) return;
      await writeTextFile(path, scriptText(statements));
      pushToast({ severity: 'success', title: 'Exported', message: `Saved to ${path}` });
    } catch (err) {
      pushToast({ severity: 'error', title: 'Export failed', message: describeFsError(err, 'write') });
    }
  };

  /** Export the generated sync script to S3-compatible storage — the
   *  S3-mediated migration transport. The script is written to a temp file and
   *  streamed up via the same upload primitive backups use; the direct
   *  DB-to-DB apply path (`onApply`) stays completely untouched. */
  const [storageBusy, setStorageBusy] = useState(false);
  const handleExportToStorage = async () => {
    const store = useStorageStore.getState();
    if (store.connections.length === 0) {
      pushToast({ severity: 'error', title: 'No storage', message: 'Add a storage connection first.' });
      return;
    }
    // Pick a connection if none active.
    const connId = store.activeConnectionId ?? store.connections[0].id;
    const conn = store.connections.find((c) => c.id === connId);
    if (!conn) return;
    setStorageBusy(true);
    try {
      const decrypted = await withDecryptedSecret(conn);
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
      const key = `${normalizePrefix(conn.pathPrefix)}migrations/${ts}-schema-sync.sql`;
      const tmpPath = `/tmp/rdsql_migration_${ts}.sql`;
      await writeTextFile(tmpPath, scriptText(statements));
      await safeInvoke('s3_upload_object', {
        config: decrypted,
        key,
        localPath: tmpPath,
        transferId: `migration_${Date.now()}`,
      });
      await remove(tmpPath).catch(() => {});
      pushToast({
        severity: 'success',
        title: 'Uploaded',
        message: `Sync script uploaded to ${conn.bucket}/${key}. On the target, use "Import from Storage".`,
      });
    } catch (err: any) {
      pushToast({ severity: 'error', title: 'Storage export failed', message: err?.message || String(err) });
    } finally {
      setStorageBusy(false);
    }
  };

  // --- gates ---------------------------------------------------------------

  if (!canCompare) {
    return (
      <EmptyState
        icon={<GitCompare className="w-7 h-7" />}
        title="Ready to compare"
        body={blockedReason ?? 'Pick a source and a different target database above.'}
      />
    );
  }

  if (comparing) return <ComparingState source={sourceLabel} target={targetLabel} />;

  if (error) {
    return (
      <EmptyState
        icon={<AlertTriangle className="w-7 h-7 text-rose-400" />}
        title="Comparison failed"
        body={error}
        mono
        action={
          <button onClick={onCompare} className={PRIMARY_BTN}>
            <GitCompare className="w-4 h-4" />
            Try again
          </button>
        }
      />
    );
  }

  if (!diff) {
    return (
      <EmptyState
        icon={<GitCompare className="w-7 h-7" />}
        title="Ready to compare"
        body={`Read the schema of ${sourceLabel} and ${targetLabel} and list every table side by side. Nothing is written.`}
        action={
          <button onClick={onCompare} className={PRIMARY_BTN}>
            <GitCompare className="w-4 h-4" />
            Compare
          </button>
        }
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="w-7 h-7 text-emerald-400" />}
        title="No tables found"
        body={`Neither ${sourceLabel} nor ${targetLabel} reported any tables or views.`}
        action={
          <button onClick={onCompare} className={SECONDARY_BTN}>
            <GitCompare className="w-3.5 h-3.5" />
            Re-compare
          </button>
        }
      />
    );
  }

  // --- main ----------------------------------------------------------------

  const setStatus = (status: StatusFilter) =>
    setFilter((f) => ({ ...f, status: f.status === status ? 'all' : status }));

  return (
    <div className="h-full flex flex-col min-h-0 relative">
      {/* 1 — What differs. Each chip is also a filter. */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#1e293b] shrink-0 flex-wrap">
        <Chip
          label="New"
          sign="+"
          count={statusCounts.added}
          cls="text-emerald-400"
          active={filter.status === 'added'}
          onClick={() => setStatus('added')}
          hint="In the source but missing from the target — a sync creates them"
        />
        <Chip
          label="Changed"
          sign="~"
          count={statusCounts.modified}
          cls="text-amber-400"
          active={filter.status === 'modified'}
          onClick={() => setStatus('modified')}
          hint="In both, but their columns differ"
        />
        <Chip
          label="Only in target"
          sign="−"
          count={statusCounts.removed}
          cls="text-rose-400"
          active={filter.status === 'removed'}
          onClick={() => setStatus('removed')}
          hint="Not in the source — a sync drops them from the target"
        />
        <Chip
          label="Same"
          sign="="
          count={statusCounts.unchanged}
          cls="text-slate-500"
          active={filter.status === 'unchanged'}
          onClick={() => setStatus('unchanged')}
          hint="Identical schema on both sides"
        />

        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            placeholder="Search tables…"
            aria-label="Search tables"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-52 bg-[#0f172a] border border-[#1e293b] rounded-lg text-[11px] text-slate-200 pl-7 pr-6 py-1.5 font-mono focus:outline-none focus:border-cyan-500/50"
          />
          {filter.query && (
            <button
              onClick={() => setFilter((f) => ({ ...f, query: '' }))}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <button onClick={onCompare} className={SECONDARY_BTN} title="Read both schemas again">
          <GitCompare className="w-3.5 h-3.5" />
          Re-compare
        </button>
      </div>

      {/* 2 — The two databases, table by table. */}
      <TableList
        rows={visibleRows}
        totalCount={rows.length}
        sourceLabel={sourceLabel}
        targetLabel={targetLabel}
        included={included}
        onToggle={toggleObject}
        onViewSql={(key) => {
          setSqlObject(key);
          setSqlOpen(true);
        }}
        hasScript={!!syncScript}
      />

      {/* 3 — What happens next. */}
      <ActionBar
        summary={summary}
        includedSummary={includedSummary}
        onSelectAll={() => setIncluded(new Set(allObjectKeys(objects)))}
        onSelectSafe={() => setIncluded(new Set(safeObjectKeys(objects)))}
        onSelectNone={() => setIncluded(new Set())}
        syncScript={syncScript}
        generatingSync={generatingSync}
        onGenerateSync={onGenerateSync}
        statementCount={statements.length}
        dropCount={scriptSummary.drop}
        onReviewSql={() => {
          setSqlObject(null);
          setSqlOpen(true);
        }}
        onApply={() => onApply(statements)}
        applying={applying}
        applyResult={applyResult}
        syncError={syncError}
        targetIsProd={targetIsProd}
      />

      {sqlOpen && syncScript && (
        <SqlDrawer
          script={syncScript}
          statements={statements}
          sqlObject={sqlObject}
          onClearObject={() => setSqlObject(null)}
          excludeDrops={excludeDrops}
          onToggleDrops={setExcludeDrops}
          onClose={() => setSqlOpen(false)}
          onCopy={handleCopy}
          onExport={handleExport}
          onExportToStorage={handleExportToStorage}
          storageBusy={storageBusy}
          onApply={() => onApply(statements)}
          applying={applying}
          targetLabel={targetLabel}
          targetIsProd={targetIsProd}
        />
      )}
    </div>
  );
};

const PRIMARY_BTN =
  'flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold shadow-lg shadow-blue-600/30 transition-all';
const SECONDARY_BTN =
  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#0f172a] border border-[#1e293b] hover:border-cyan-500/50 disabled:opacity-40 text-slate-300 text-[11px] font-medium transition-colors';

const Chip: React.FC<{
  label: string;
  sign: string;
  count: number;
  cls: string;
  active: boolean;
  onClick: () => void;
  hint: string;
}> = ({ label, sign, count, cls, active, onClick, hint }) => (
  <button
    onClick={onClick}
    title={hint}
    aria-pressed={active}
    className={cn(
      'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/60',
      active
        ? 'bg-cyan-500/10 border-cyan-500/40'
        : 'bg-[#0a0f18] border-[#1e293b] hover:border-slate-600',
      count === 0 && !active && 'opacity-50'
    )}
  >
    <span className={cn('font-bold', cls)}>{sign}</span>
    <span className="font-mono font-semibold text-slate-200 tabular-nums">
      {count.toLocaleString()}
    </span>
    <span className="text-slate-400">{label}</span>
  </button>
);

// ---------------------------------------------------------------------------
// The table-to-table list
// ---------------------------------------------------------------------------

/** Collapsed row height. Expanded rows are measured after they render. */
const ROW_H = 30;
/** Height assumed for a freshly expanded row until it has been measured. */
const ESTIMATED_DETAIL_H = 180;

const TableList: React.FC<{
  rows: ObjectRow[];
  totalCount: number;
  sourceLabel: string;
  targetLabel: string;
  included: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onViewSql: (key: string) => void;
  hasScript: boolean;
}> = ({ rows, totalCount, sourceLabel, targetLabel, included, onToggle, onViewSql, hasScript }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [detailHeights, setDetailHeights] = useState<Record<string, number>>({});
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const totals = useMemo(() => totalRows(rows), [rows]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewport(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Collapsed rows are exactly ROW_H tall, so only the handful of open rows
  // ever needs measuring — the estimate is corrected before paint.
  const heights = useMemo(
    () =>
      rows.map((r) =>
        expanded.has(r.key) ? ROW_H + (detailHeights[r.key] ?? ESTIMATED_DETAIL_H) : ROW_H
      ),
    [rows, expanded, detailHeights]
  );

  const offsets = useMemo(() => {
    const out = new Array<number>(heights.length + 1);
    out[0] = 0;
    for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
    return out;
  }, [heights]);

  const totalHeight = offsets[offsets.length - 1] ?? 0;

  // Binary search for the first row intersecting the viewport.
  const firstVisible = useMemo(() => {
    let lo = 0;
    let hi = Math.max(0, rows.length - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= scrollTop) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }, [offsets, scrollTop, rows.length]);

  const OVERSCAN = 6;
  const start = Math.max(0, firstVisible - OVERSCAN);
  let end = firstVisible;
  while (end < rows.length && offsets[end] < scrollTop + viewport) end += 1;
  end = Math.min(rows.length, end + OVERSCAN);

  const setDetailHeight = useCallback((key: string, h: number) => {
    setDetailHeights((prev) => (prev[key] === h ? prev : { ...prev, [key]: h }));
  }, []);

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Move focus by `delta` rows and scroll it into view. */
  const move = (delta: number) => {
    if (rows.length === 0) return;
    const pos = rows.findIndex((r) => r.key === focusedKey);
    const next = pos < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, pos + delta));
    setFocusedKey(rows[next].key);
    const el = scrollRef.current;
    if (el) {
      if (offsets[next] < el.scrollTop) el.scrollTop = offsets[next];
      else if (offsets[next + 1] > el.scrollTop + el.clientHeight)
        el.scrollTop = offsets[next + 1] - el.clientHeight;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(12); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(-12); }
    else if (e.key === 'Home') { e.preventDefault(); move(-rows.length); }
    else if (e.key === 'End') { e.preventDefault(); move(rows.length); }
    else if (e.key === ' ' && focusedKey) { e.preventDefault(); onToggle(focusedKey); }
    else if ((e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') && focusedKey) {
      e.preventDefault();
      toggleExpand(focusedKey);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Which database is on which side */}
      <div className="grid grid-cols-[26px_18px_16px_1fr_26px_1fr_130px] items-center gap-1 px-3 py-1.5 border-b border-[#1e293b] bg-[#06090e] shrink-0 text-[10px]">
        <span />
        <span />
        <span />
        <span className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-cyan-400 font-bold uppercase tracking-wider">Source</span>
          <span className="text-slate-500 font-mono truncate">{sourceLabel}</span>
        </span>
        <span />
        <span className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-amber-400 font-bold uppercase tracking-wider">Target</span>
          <span className="text-slate-500 font-mono truncate">{targetLabel}</span>
        </span>
        <span className="text-right text-slate-600 uppercase tracking-wider" title={ROW_COUNT_NOTE}>
          rows ≈
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-4 text-center text-[11px] text-slate-600">
          No tables match the current filter.
        </div>
      ) : (
        <div
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className="flex-1 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan-500/60"
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            {rows.slice(start, end).map((row, i) => {
              const index = start + i;
              return (
                <TableRow
                  key={row.key}
                  style={{ position: 'absolute', top: offsets[index], left: 0, right: 0 }}
                  row={row}
                  expanded={expanded.has(row.key)}
                  focused={focusedKey === row.key}
                  included={included.has(row.key)}
                  onToggleExpand={() => {
                    setFocusedKey(row.key);
                    toggleExpand(row.key);
                  }}
                  onToggleInclude={() => onToggle(row.key)}
                  onViewSql={() => onViewSql(row.key)}
                  hasScript={hasScript}
                  onDetailHeight={(h) => setDetailHeight(row.key, h)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Totals */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-[#1e293b] text-[10px] text-slate-500 shrink-0 flex-wrap">
        <span>
          {rows.length.toLocaleString()}
          {rows.length !== totalCount && ` of ${totalCount.toLocaleString()}`} table
          {rows.length === 1 ? '' : 's'}
        </span>
        <span className="text-slate-700">·</span>
        <span title={ROW_COUNT_NOTE}>
          <span className="text-cyan-400">source</span>{' '}
          <span className="text-slate-300 font-mono tabular-nums">
            {totals.sourceRows.toLocaleString()}
          </span>{' '}
          rows vs <span className="text-amber-400">target</span>{' '}
          <span className="text-slate-300 font-mono tabular-nums">
            {totals.targetRows.toLocaleString()}
          </span>{' '}
          rows
        </span>
        <span className="ml-auto">click a table to see what changed</span>
      </div>
    </div>
  );
};

/** One line: the same table as seen from each database. */
const TableRow: React.FC<{
  style: React.CSSProperties;
  row: ObjectRow;
  expanded: boolean;
  focused: boolean;
  included: boolean;
  onToggleExpand: () => void;
  onToggleInclude: () => void;
  onViewSql: () => void;
  hasScript: boolean;
  onDetailHeight: (h: number) => void;
}> = ({
  style,
  row,
  expanded,
  focused,
  included,
  onToggleExpand,
  onToggleInclude,
  onViewSql,
  hasScript,
  onDetailHeight,
}) => {
  const meta = STATUS_META[row.status];
  const changed = row.change !== null;
  const dimmed = changed && !included;

  return (
    <div style={style}>
      <div
        role="button"
        tabIndex={-1}
        aria-expanded={changed ? expanded : undefined}
        onClick={changed ? onToggleExpand : undefined}
        // The border sits inside the fixed height, so the row is exactly ROW_H
        // tall and the virtual offsets stay exact.
        style={{ height: ROW_H }}
        className={cn(
          'group grid grid-cols-[26px_18px_16px_1fr_26px_1fr_130px] items-center gap-1 px-3 border-l-2 border-b border-b-[#1e293b]/40 transition-colors',
          changed ? 'cursor-pointer' : 'cursor-default',
          focused ? 'bg-cyan-500/10 border-l-cyan-500' : 'border-l-transparent hover:bg-[#0f172a]/60'
        )}
      >
        {changed ? (
          <input
            type="checkbox"
            checked={included}
            onChange={onToggleInclude}
            onClick={(e) => e.stopPropagation()}
            title={included ? 'Included in the sync' : 'Excluded from the sync'}
            aria-label={`Include ${row.key} in the sync`}
            className="w-3 h-3 accent-cyan-500 cursor-pointer"
          />
        ) : (
          <span />
        )}

        {changed ? (
          <ChevronRight
            className={cn('w-3.5 h-3.5 text-slate-500 transition-transform', expanded && 'rotate-90')}
          />
        ) : (
          <span />
        )}

        <span className={cn('text-center font-bold', meta.cls)} title={meta.label}>
          {meta.sign}
        </span>

        <SideCell present={row.inSource} name={row.name} rowCount={row.rowCountSource} dimmed={dimmed} />

        <ArrowRight
          className={cn('w-3.5 h-3.5 mx-auto', changed ? 'text-cyan-600' : 'text-slate-800')}
        />

        <SideCell
          present={row.inTarget}
          name={row.name}
          rowCount={row.rowCountTarget}
          dimmed={dimmed}
          delta={row.inSource && row.inTarget ? row.rowDelta : null}
        />

        <span className="flex items-center justify-end gap-1.5">
          {row.destructive ? (
            <DropBadge />
          ) : changed ? (
            <span className="text-[10px] text-slate-500">
              {row.changeCount} {row.status === 'modified' ? 'field' : 'column'}
              {row.changeCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </span>
      </div>

      {expanded && row.change && (
        <ExpandedDetail
          obj={row.change}
          onViewSql={onViewSql}
          hasScript={hasScript}
          onHeight={onDetailHeight}
        />
      )}
    </div>
  );
};

/** One database's view of the table: its name and row count, or a dash when it
 *  only exists on the other side. */
const SideCell: React.FC<{
  present: boolean;
  name: string;
  rowCount?: number | null;
  dimmed: boolean;
  delta?: number | null;
}> = ({ present, name, rowCount, dimmed, delta }) => {
  if (!present) {
    return <span className="text-[11px] text-slate-700 italic">not here</span>;
  }
  return (
    <span className={cn('flex items-baseline gap-2 min-w-0', dimmed && 'opacity-40')}>
      <span className="font-mono text-[11px] text-slate-200 truncate" title={name}>
        {name}
      </span>
      <span
        className="ml-auto shrink-0 text-[10px] text-slate-500 font-mono tabular-nums"
        title={ROW_COUNT_NOTE}
      >
        {rowCount == null ? '—' : rowCount.toLocaleString()}
        {delta != null && delta !== 0 && (
          <span className={cn('ml-1', delta > 0 ? 'text-emerald-500' : 'text-rose-500')}>
            {delta > 0 ? '+' : ''}
            {delta.toLocaleString()}
          </span>
        )}
      </span>
    </span>
  );
};

// ---------------------------------------------------------------------------
// Expanded row — the field differences
// ---------------------------------------------------------------------------

/** Columns render lazily — a wide table can carry hundreds. */
const COLUMN_PAGE = 100;

const ExpandedDetail: React.FC<{
  obj: ObjectChange;
  onViewSql: () => void;
  hasScript: boolean;
  onHeight: (h: number) => void;
}> = ({ obj, onViewSql, hasScript, onHeight }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(COLUMN_PAGE);

  // Report the rendered height so the rows below land in the right place.
  // Runs after every render because "show more" changes it.
  useLayoutEffect(() => {
    if (ref.current) onHeight(ref.current.offsetHeight);
  });

  const groups = useMemo(
    () => ({
      added: obj.columns.filter((c) => c.status === 'added'),
      modified: obj.columns.filter((c) => c.status === 'modified'),
      removed: obj.columns.filter((c) => c.status === 'removed'),
    }),
    [obj]
  );

  let budget = shown;
  const take = (list: ColumnChange[]) => {
    const slice = list.slice(0, Math.max(0, budget));
    budget -= slice.length;
    return slice;
  };
  const visibleAdded = take(groups.added);
  const visibleModified = take(groups.modified);
  const visibleRemoved = take(groups.removed);
  const hidden =
    obj.columns.length - (visibleAdded.length + visibleModified.length + visibleRemoved.length);

  return (
    <div ref={ref} className="bg-[#080d15] border-b border-[#1e293b] px-10 py-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="text-slate-400">
          {obj.status === 'added'
            ? `Will be created in the target with ${obj.columns.length} column${obj.columns.length === 1 ? '' : 's'}.`
            : obj.status === 'removed'
            ? `Exists only in the target. A sync drops it and its data.`
            : [
                groups.added.length && `${groups.added.length} field(s) added`,
                groups.modified.length && `${groups.modified.length} field(s) changed`,
                groups.removed.length && `${groups.removed.length} field(s) dropped`,
              ]
                .filter(Boolean)
                .join(', ')}
        </span>
        <button
          onClick={onViewSql}
          disabled={!hasScript}
          title={hasScript ? 'Show the SQL for this table' : 'Generate the sync script first'}
          className={cn(SECONDARY_BTN, 'ml-auto text-[10px] py-1')}
        >
          <FileText className="w-3 h-3" />
          View SQL
        </button>
      </div>

      {obj.destructive && (
        <div className="flex items-start gap-2 text-[11px] text-rose-300 bg-rose-500/5 border border-rose-500/20 rounded-lg px-3 py-2">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
          {obj.status === 'removed' ? (
            <span>
              Applying this runs <span className="font-mono">DROP TABLE {obj.key}</span> — the table
              and everything in it is gone for good.
            </span>
          ) : (
            <span>
              Applying this drops {groups.removed.map((c) => c.name).join(', ')} from{' '}
              <span className="font-mono">{obj.key}</span>. That data is gone for good.
            </span>
          )}
        </div>
      )}

      {obj.columns.length === 0 ? (
        <div className="text-[11px] text-slate-500">No field details reported for this object.</div>
      ) : (
        <div className="space-y-2">
          {visibleAdded.length > 0 && (
            <ColumnGroup title="Added" sign="+" cls="text-emerald-400" columns={visibleAdded} side="source" />
          )}
          {visibleModified.length > 0 && (
            <ColumnGroup title="Changed" sign="~" cls="text-amber-400" columns={visibleModified} side="both" />
          )}
          {visibleRemoved.length > 0 && (
            <ColumnGroup title="Dropped" sign="−" cls="text-rose-400" columns={visibleRemoved} side="target" />
          )}
          {hidden > 0 && (
            <button
              onClick={() => setShown((s) => s + COLUMN_PAGE)}
              className="w-full py-1.5 text-[11px] text-slate-400 hover:text-cyan-300 border border-[#1e293b] rounded-lg transition-colors"
            >
              Show {Math.min(hidden, COLUMN_PAGE)} more of {hidden.toLocaleString()} fields
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const ColumnGroup: React.FC<{
  title: string;
  sign: string;
  cls: string;
  columns: ColumnChange[];
  /** Which side's definition is meaningful. */
  side: 'source' | 'target' | 'both';
}> = ({ title, sign, cls, columns, side }) => (
  <div>
    <div className={cn('text-[10px] font-bold uppercase tracking-wider mb-1', cls)}>
      {sign} {title} ({columns.length})
    </div>
    <div className="border border-[#1e293b] rounded-lg overflow-hidden">
      {side === 'both' && (
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 px-2 py-1 bg-[#06090e] border-b border-[#1e293b] text-[9px] uppercase tracking-wider text-slate-600">
          <span>Field</span>
          <span>Source</span>
          <span>Target</span>
        </div>
      )}
      {columns.map((c) => (
        <div
          key={c.name}
          className="grid grid-cols-[1fr_1fr_1fr] gap-2 px-2 py-1 border-b border-[#1e293b]/40 last:border-b-0 text-[11px] items-baseline"
        >
          <span className="font-mono text-slate-200 truncate flex items-center gap-1" title={c.name}>
            {c.isPrimaryKey && (
              <KeyRound className="w-2.5 h-2.5 text-amber-400 shrink-0" aria-label="Primary key">
                <title>Primary key</title>
              </KeyRound>
            )}
            {c.name}
          </span>
          {side === 'source' && (
            <span className="col-span-2 font-mono text-slate-400 truncate">
              {c.sourceType ?? '—'}
              <span className="text-slate-600"> {c.sourceNullable === false ? 'NOT NULL' : 'NULL'}</span>
            </span>
          )}
          {side === 'target' && (
            <span className="col-span-2 font-mono text-slate-400 truncate">
              {c.targetType ?? '—'}
              <span className="text-slate-600"> {c.targetNullable === false ? 'NOT NULL' : 'NULL'}</span>
            </span>
          )}
          {side === 'both' && (
            <>
              <span className="font-mono text-amber-200 truncate" title={c.detail}>
                {c.sourceType ?? '—'}
                <span className="text-slate-600"> {c.sourceNullable === false ? 'NOT NULL' : 'NULL'}</span>
              </span>
              <span className="font-mono text-slate-500 truncate line-through" title={c.detail}>
                {c.targetType ?? '—'}
                <span className="text-slate-700"> {c.targetNullable === false ? 'NOT NULL' : 'NULL'}</span>
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Action bar — Generate → Review → Apply, always visible
// ---------------------------------------------------------------------------

const ActionBar: React.FC<{
  summary: ReturnType<typeof summarizeObjects>;
  includedSummary: ReturnType<typeof summarizeObjects>;
  onSelectAll: () => void;
  onSelectSafe: () => void;
  onSelectNone: () => void;
  syncScript: SyncScript | null;
  generatingSync: boolean;
  onGenerateSync: () => void;
  statementCount: number;
  dropCount: number;
  onReviewSql: () => void;
  onApply: () => void;
  applying: boolean;
  applyResult: ApplyResult | null;
  syncError: string | null;
  targetIsProd: boolean;
}> = ({
  summary,
  includedSummary,
  onSelectAll,
  onSelectSafe,
  onSelectNone,
  syncScript,
  generatingSync,
  onGenerateSync,
  statementCount,
  dropCount,
  onReviewSql,
  onApply,
  applying,
  applyResult,
  syncError,
  targetIsProd,
}) => {
  const nothingToSync = summary.affectedObjects === 0;

  return (
    <div className="shrink-0 border-t border-[#1e293b] bg-[#0a0f18]">
      {syncError && (
        <div className="flex items-start gap-2 px-4 py-2 text-[11px] text-rose-300 border-b border-rose-500/20 bg-rose-500/5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="font-mono break-all">{syncError}</span>
        </div>
      )}
      {applyResult && (
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[11px] border-b',
            applyResult.failed === 0
              ? 'text-emerald-300 border-emerald-500/20 bg-emerald-500/5'
              : 'text-amber-300 border-amber-500/20 bg-amber-500/5'
          )}
        >
          {applyResult.failed === 0 ? (
            <CheckCircle2 className="w-3.5 h-3.5" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5" />
          )}
          <span>
            {applyResult.applied.toLocaleString()} statement(s) applied
            {applyResult.failed > 0 && `, ${applyResult.failed.toLocaleString()} failed`} in{' '}
            {applyResult.durationMs}ms.
          </span>
          {applyResult.errors.length > 0 && (
            <span className="font-mono text-rose-300 truncate" title={applyResult.errors.join('\n')}>
              {applyResult.errors[0]}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-2.5 flex-wrap">
        {nothingToSync ? (
          <div className="flex items-center gap-2 text-[11px] text-emerald-300">
            <CheckCircle2 className="w-4 h-4" />
            Both schemas match — there is nothing to sync.
          </div>
        ) : (
          <>
            <div className="text-[11px] text-slate-400">
              <span className="text-slate-100 font-semibold">
                {includedSummary.affectedObjects.toLocaleString()}
              </span>
              <span className="text-slate-500">
                {' '}
                of {summary.affectedObjects.toLocaleString()} changed tables selected
              </span>
              {includedSummary.destructiveObjects > 0 && (
                <span className="text-rose-400">
                  {' '}
                  · {includedSummary.destructiveObjects.toLocaleString()} delete data
                </span>
              )}
            </div>

            <div className="flex items-center gap-1">
              <button onClick={onSelectAll} className={LINK_BTN}>
                All
              </button>
              <span className="text-slate-700">·</span>
              <button
                onClick={onSelectSafe}
                title="Select every change that doesn't delete a table or a column"
                className={cn(LINK_BTN, 'text-emerald-400 hover:text-emerald-300')}
              >
                Safe only
              </button>
              <span className="text-slate-700">·</span>
              <button onClick={onSelectNone} className={LINK_BTN}>
                None
              </button>
            </div>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!syncScript ? (
            <>
              <span className="text-[11px] text-slate-500 hidden lg:inline">
                Step 2 — build the SQL, review it, then apply.
              </span>
              <button
                onClick={onGenerateSync}
                disabled={generatingSync || nothingToSync}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors"
              >
                {generatingSync ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FileText className="w-3.5 h-3.5" />
                )}
                Generate SQL
              </button>
            </>
          ) : (
            <>
              <button onClick={onGenerateSync} disabled={generatingSync} className={SECONDARY_BTN}>
                {generatingSync ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FileText className="w-3.5 h-3.5" />
                )}
                Rebuild
              </button>
              <button
                onClick={onReviewSql}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#141e33] border border-cyan-500/30 hover:border-cyan-500/60 text-cyan-300 text-xs font-semibold transition-colors"
              >
                Review SQL
                <span className="font-mono text-[10px] opacity-80">
                  {statementCount.toLocaleString()}
                </span>
              </button>
              <button
                onClick={onApply}
                disabled={!syncScript.canApply || applying || statementCount === 0}
                title={
                  !syncScript.canApply
                    ? "Some changes can't be applied automatically on this engine — see the notes in Review SQL."
                    : statementCount === 0
                    ? 'Nothing selected.'
                    : undefined
                }
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  targetIsProd || dropCount > 0
                    ? 'bg-rose-600 hover:bg-rose-500'
                    : 'bg-emerald-600 hover:bg-emerald-500'
                )}
              >
                {applying ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Apply
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const LINK_BTN =
  'px-1.5 py-0.5 rounded text-[11px] font-medium text-slate-400 hover:text-slate-100 transition-colors';

// ---------------------------------------------------------------------------
// SQL drawer
// ---------------------------------------------------------------------------

const SqlDrawer: React.FC<{
  script: SyncScript;
  statements: SyncStatement[];
  sqlObject: string | null;
  onClearObject: () => void;
  excludeDrops: boolean;
  onToggleDrops: (v: boolean) => void;
  onClose: () => void;
  onCopy: () => void;
  onExport: () => void;
  onExportToStorage: () => void;
  storageBusy: boolean;
  onApply: () => void;
  applying: boolean;
  targetLabel: string;
  targetIsProd: boolean;
}> = ({
  script,
  statements,
  sqlObject,
  onClearObject,
  excludeDrops,
  onToggleDrops,
  onClose,
  onCopy,
  onExport,
  onExportToStorage,
  storageBusy,
  onApply,
  applying,
  targetLabel,
  targetIsProd,
}) => {
  useEscapeToClose(onClose);
  const summary = useMemo(() => summarizeStatements(statements), [statements]);
  const shown = sqlObject ? statements.filter((s) => s.targetObject === sqlObject) : statements;
  const sections = (['create', 'alter', 'drop'] as StatementKind[])
    .map((kind) => ({ kind, statements: shown.filter((s) => statementKind(s.operation) === kind) }))
    .filter((s) => s.statements.length > 0);

  return (
    <div className="absolute inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-3xl h-full bg-[#06090e] border-l border-[#1e293b] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#1e293b] shrink-0">
          <FileText className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-bold text-slate-100">Review SQL</span>
          <span className="text-[11px] text-slate-500">
            runs against <span className="font-mono text-amber-300">{targetLabel}</span>
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto text-slate-500 hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Counts */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1e293b] shrink-0 flex-wrap">
          <Count label="CREATE" value={summary.create} cls="text-emerald-400" />
          <Count label="ALTER" value={summary.alter} cls="text-amber-400" />
          <Count label="DROP" value={summary.drop} cls="text-rose-400" />
          <span className="text-[11px] text-slate-500">
            {summary.total.toLocaleString()} statement{summary.total === 1 ? '' : 's'}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={onCopy} className={SECONDARY_BTN}>
              <Copy className="w-3 h-3" /> Copy
            </button>
            <button onClick={onExport} className={SECONDARY_BTN}>
              <Download className="w-3 h-3" /> Export
            </button>
            <button
              onClick={onExportToStorage}
              disabled={storageBusy}
              title="Upload the sync script to S3 storage (for S3-mediated migration)"
              className={SECONDARY_BTN}
            >
              {storageBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Cloud className="w-3 h-3" />}
              To Storage
            </button>
          </div>
        </div>

        {summary.drop > 0 && (
          <label className="flex items-center gap-2 px-4 py-2 border-b border-rose-500/20 bg-rose-500/5 text-[11px] text-rose-300 cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={excludeDrops}
              onChange={(e) => onToggleDrops(e.target.checked)}
              className="w-3 h-3 accent-rose-500 cursor-pointer"
            />
            <ShieldAlert className="w-3.5 h-3.5" />
            {summary.drop.toLocaleString()} statement{summary.drop === 1 ? '' : 's'} delete data —
            tick to leave them out
          </label>
        )}

        {script.warnings.length > 0 && (
          <details className="border-b border-amber-500/20 bg-amber-500/5 shrink-0">
            <summary className="px-4 py-2 text-[11px] text-amber-300 cursor-pointer">
              {script.warnings.length} warning{script.warnings.length === 1 ? '' : 's'} — click to read
            </summary>
            <div className="max-h-40 overflow-y-auto px-4 pb-2 space-y-1">
              {script.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {sqlObject && (
          <div className="flex items-center gap-2 px-4 py-1.5 border-b border-cyan-500/20 bg-cyan-500/5 text-[11px] text-cyan-300 shrink-0">
            Showing <span className="font-mono font-semibold">{sqlObject}</span> only
            <button onClick={onClearObject} className="ml-auto text-slate-400 hover:text-slate-200">
              show all
            </button>
          </div>
        )}

        {/* Statements */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {shown.length === 0 ? (
            <div className="p-6 text-center text-[11px] text-slate-500 border border-[#1e293b] rounded-xl">
              {statements.length === 0
                ? 'Nothing selected — tick at least one table to build a script.'
                : 'No statements were generated for this table.'}
            </div>
          ) : (
            sections.map((s) => (
              <SqlSection key={s.kind} kind={s.kind} statements={s.statements} />
            ))
          )}
        </div>

        {/* Apply */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-t border-[#1e293b] shrink-0">
          <span className="text-[11px] text-slate-500">
            Applying writes to <span className="text-amber-300 font-mono">{targetLabel}</span>. The
            source is never touched.
          </span>
          <button
            onClick={onApply}
            disabled={!script.canApply || applying || statements.length === 0}
            title={
              !script.canApply
                ? "Some changes can't be applied automatically on this engine."
                : undefined
            }
            className={cn(
              'ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-white text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              targetIsProd || summary.drop > 0
                ? 'bg-rose-600 hover:bg-rose-500'
                : 'bg-emerald-600 hover:bg-emerald-500'
            )}
          >
            {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Apply {statements.length.toLocaleString()} statement
            {statements.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
};

const Count: React.FC<{ label: string; value: number; cls: string }> = ({ label, value, cls }) => (
  <span className="flex items-baseline gap-1">
    <span className={cn('text-sm font-bold font-mono tabular-nums', cls)}>{value.toLocaleString()}</span>
    <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
  </span>
);

const SqlSection: React.FC<{ kind: StatementKind; statements: SyncStatement[] }> = ({
  kind,
  statements,
}) => {
  const [open, setOpen] = useState(kind !== 'drop' || statements.length <= 50);
  const meta = KIND_META[kind];
  const sql = useMemo(() => scriptText(statements), [statements]);

  return (
    <div className="bg-[#0a0f18] border border-[#1e293b] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#0f172a] transition-colors"
      >
        <ChevronRight
          className={cn('w-3.5 h-3.5 text-slate-500 transition-transform', open && 'rotate-90')}
        />
        <span className={cn('text-[11px] font-bold tracking-wider', meta.cls)}>{meta.label}</span>
        <span className="text-[10px] text-slate-500 font-mono">
          {statements.length.toLocaleString()}
        </span>
        {kind === 'drop' && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-rose-400 font-semibold">
            <ShieldAlert className="w-3 h-3" /> deletes data
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-[#1e293b] bg-[#06090e]">
          <SqlPreview sql={sql} maxHeightClass="max-h-[40vh]" />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
  mono?: boolean;
}> = ({ icon, title, body, action, mono }) => (
  <div className="h-full flex flex-col items-center justify-center text-center px-6 py-12">
    <div className="text-slate-700 mb-3">{icon}</div>
    <h3 className="text-sm font-bold text-slate-300">{title}</h3>
    <p
      className={cn(
        'text-[11px] text-slate-500 max-w-md mt-1.5 leading-relaxed',
        mono && 'font-mono break-all text-rose-300/90'
      )}
    >
      {body}
    </p>
    {action && <div className="mt-4">{action}</div>}
  </div>
);

/** Indeterminate — the backend reports no progress, so no fake percentage. */
const ComparingState: React.FC<{ source: string; target: string }> = ({ source, target }) => (
  <div className="h-full flex flex-col px-4 py-4 gap-3">
    <div className="flex items-center gap-2 text-xs text-slate-300">
      <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
      Reading both schemas…
      <span className="text-slate-500 font-mono">
        {source} → {target}
      </span>
    </div>
    <div className="text-[11px] text-slate-600">Nothing is written to either database.</div>
    <div className="flex-1 space-y-1.5 min-h-0">
      {Array.from({ length: 14 }).map((_, i) => (
        <div
          key={i}
          className="h-7 rounded bg-[#0a0f18] border border-[#1e293b] animate-pulse"
          style={{ opacity: 1 - i * 0.06 }}
        />
      ))}
    </div>
  </div>
);
