import React, { useMemo, useState } from 'react';
import {
  Terminal,
  Search,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  PanelBottomClose,
} from 'lucide-react';
import { useQueryLogStore, isUserFacingQuery } from '../../store/useQueryStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTabStore } from '../../store/useTabStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { isRedisEngine } from '../../core/connection/engines';
import { SqlHighlight } from '../editor/SqlHighlight';
import { copyToClipboard } from '../../core/utils/clipboard';

type LogTab = 'log' | 'errors';

/**
 * Collapse a (possibly multi-line) SQL string into a compact 1-2 line preview
 * for the log panel. Newlines/tabs are squashed into single spaces, runs of
 * whitespace are collapsed, and the result is clamped to `max` characters on a
 * word boundary so a long statement reads as a single flowing line instead of
 * the raw, indented query text. The full, untouched SQL is still copied when
 * the user clicks the copy button — this is purely for display density.
 */
function compactSql(sql: string, max = 240): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  // Keep the head and tail so a long statement stays identifiable (leading
  // keywords + final clause/limit are the most informative parts).
  const head = oneLine.slice(0, max - 24);
  const tail = oneLine.slice(-20);
  return `${head}… ${tail}`;
}

/**
 * Global SQL log panel — always visible at the bottom of the workspace,
 * independent of which tab or view is active. Shows every executed SQL
 * statement (from the SQL editor, backup, restore, table actions, etc.)
 * with timestamp, status, duration, and copyable error details.
 *
 * Can be collapsed/expanded via the toggle in the header or the header
 * toolbar. Does NOT show query result grids (those stay in the SQL editor's
 * own result view to avoid duplication).
 */
export const GlobalSqlLog: React.FC = () => {
  // Explicit per-field selectors (not a whole-store destructure) — the
  // reliable pattern already used for this same store in SettingsModal.
  // Clearing via a whole-store subscription was observed to leave the list
  // showing stale entries until the panel was collapsed/reopened; the
  // `key` on the scroll container below is the belt-and-suspenders fix that
  // guarantees a fresh render on every clear regardless of cause.
  const allLogs = useQueryLogStore((s) => s.logs);
  const clearLogs = useQueryLogStore((s) => s.clearLogs);
  const { toggleOutputConsole } = useWorkspaceStore();
  // Display preferences (persisted). Full-text renders the whole statement
  // (wrapping); truncated clamps to a compact single line. Color coding toggles
  // syntax highlighting.
  const { sqlLogFullText, sqlLogColorCoding } = useSettingsStore();
  const [tab, setTab] = useState<LogTab>('log');
  const [search, setSearch] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Connection isolation: when the focused tab belongs to a Redis connection,
  // scope the panel to just that connection's own entries (and relabel it) so
  // e.g. a SQL Server connection's errors never bleed into the Redis view.
  // Every other engine keeps today's global, cross-connection log — this is a
  // targeted fix for the one named complaint, not a full per-connection
  // rearchitecture.
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const connections = useConnectionStore((s) => s.connections);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeConn = activeTab?.connectionId ? connections.find((c) => c.id === activeTab.connectionId) : undefined;
  const isRedisScoped = !!activeConn && isRedisEngine(activeConn.engine);
  const logs = useMemo(
    () => (isRedisScoped ? allLogs.filter((l) => l.connectionId === activeConn!.id) : allLogs),
    [allLogs, isRedisScoped, activeConn],
  );

  const errorLogs = useMemo(() => logs.filter((l) => l.status === 'error'), [logs]);
  // Apply the system-query filter: when the checkbox is off, only user-facing
  // queries (SQL editor + table grid) are shown. Errors always include every
  // source so failures from backup/restore/maintenance aren't hidden.
  const sourceFiltered = useMemo(
    () => (showSystem || tab === 'errors' ? logs : logs.filter((l) => isUserFacingQuery(l.source))),
    [logs, showSystem, tab]
  );
  const source = tab === 'errors' ? errorLogs : sourceFiltered;
  const filtered = source.filter(
    (l) =>
      l.sql.toLowerCase().includes(search.toLowerCase()) ||
      (l.database && l.database.toLowerCase().includes(search.toLowerCase()))
  );
  // Newest first — the most recent query should be visible at the top without
  // scrolling, matching how every other log/terminal panel works.
  const displayLogs = [...filtered].reverse();

  const handleCopy = (sql: string, id: string) => {
    copyToClipboard(sql);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCopyAll = () => {
    const text = filtered
      .map((l) => {
        // Match what's shown: full statement (whitespace-collapsed) when the
        // full-text preference is on, otherwise the compact preview.
        const sql = sqlLogFullText ? l.sql.replace(/\s+/g, ' ').trim() : compactSql(l.sql, 600);
        const parts = [l.executedAt, sql];
        if (l.status === 'error' && l.errorMessage) parts.push(`-- ERROR: ${l.errorMessage}`);
        if (l.rowsAffected !== undefined) parts.push(`-- ${l.rowsAffected} rows in ${l.durationMs}ms`);
        return parts.join('  ');
      })
      .join('\n');
    copyToClipboard(text);
    setCopiedId('copy-all');
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="h-full w-full bg-[#06090e] border-t border-[#1e293b] flex flex-col select-none font-sans overflow-hidden">
      {/* Header Bar */}
      <div className="h-8 border-b border-[#1e293b] px-2 bg-[#080c14] flex items-center justify-between shrink-0 text-xs">
        <div className="flex items-center gap-1 h-full">
          <button
            onClick={() => setTab('log')}
            className={`h-full px-2.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider border-b-2 transition-colors ${
              tab === 'log'
                ? 'border-blue-500 text-slate-200'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
            title={isRedisScoped ? `Log of every command run against ${activeConn!.name}` : 'Global log of every executed statement (success + error)'}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>{isRedisScoped ? 'Redis Log' : 'SQL Log'}</span>
            <span className="px-1.5 py-0.2 rounded-full bg-[#1e293b] text-slate-400 text-[10px] font-mono font-normal">
              {logs.length}
            </span>
          </button>

          <button
            onClick={() => setTab('errors')}
            className={`h-full px-2.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider border-b-2 transition-colors ${
              tab === 'errors'
                ? 'border-red-500 text-red-300'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
            title="Failed statements and warnings"
          >
            <AlertTriangle className={`w-3.5 h-3.5 ${errorLogs.length > 0 ? 'text-red-400' : ''}`} />
            <span>Errors</span>
            {errorLogs.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-red-950/60 text-red-300 text-[10px] font-mono font-normal border border-red-900/50">
                {errorLogs.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Filter */}
          <div className="relative flex items-center">
            <Search className="w-3 h-3 text-slate-600 absolute left-2" />
            <input
              type="text"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder={tab === 'errors' ? 'Filter errors...' : 'Filter log...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-[#0f172a] text-xs text-slate-300 pl-7 pr-2 py-0.5 rounded border border-[#1e293b] focus:outline-none focus:border-slate-600 w-44 font-mono text-[11px]"
            />
          </div>

          {/* Show system queries (DDL / backup / restore / maintenance). Off by
              default so the log stays focused on what the user ran in the editor
              or edited in the grid. */}
          <label
            className="flex items-center gap-1.5 text-[10.5px] text-slate-500 hover:text-slate-300 cursor-pointer select-none transition-colors"
            title="Include DDL, backup/restore, and maintenance queries in the log"
          >
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => setShowSystem(e.target.checked)}
              className="rounded border-[#1e293b] bg-[#0f172a] text-blue-600 focus:ring-0 focus:ring-offset-0 w-3 h-3 cursor-pointer"
            />
            System
          </label>

          <button
            onClick={handleCopyAll}
            disabled={filtered.length === 0}
            className="px-2 py-0.5 rounded bg-[#0f172a] hover:bg-[#1e293b] disabled:opacity-40 text-slate-500 hover:text-slate-300 text-[11px] flex items-center gap-1 transition-colors border border-[#1e293b]"
            title="Copy all visible entries"
          >
            {copiedId === 'copy-all' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copiedId === 'copy-all' ? 'Copied' : 'Copy All'}
          </button>

          <button
            onClick={clearLogs}
            className="px-2 py-0.5 rounded bg-[#0f172a] hover:bg-[#1e293b] text-slate-500 hover:text-slate-300 text-[11px] flex items-center gap-1 transition-colors border border-[#1e293b]"
            title="Clear log history"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>

          <button
            onClick={toggleOutputConsole}
            className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"
            title="Collapse panel"
          >
            <PanelBottomClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Log entries. Keyed by the log set's size + newest id so clearing (or
          any other change to the underlying array) forces a fresh DOM
          subtree instead of patching the existing one — this is the same
          effect as collapsing/reopening the panel (which was the previous
          workaround for a stuck/stale list), but automatic. */}
      <div
        key={`${logs.length}-${logs[0]?.id ?? 'empty'}`}
        className="flex-1 overflow-y-auto macos-scroll select-text cursor-text"
      >
        {filtered.length === 0 ? (
          <div className="text-slate-600 italic p-3 text-[11px]">
            {tab === 'errors' ? 'No errors recorded.' : 'No SQL executed yet. Run a query to see it here.'}
          </div>
        ) : (
          displayLogs.map((l) => {
            // Decide what text to render: full statement (wrapped, multi-line)
            // or a compact single-line preview. The copy button always copies
            // the original, untouched SQL.
            const displaySql = sqlLogFullText ? l.sql.replace(/\s+/g, ' ').trim() : compactSql(l.sql);
            const baseColor = l.status === 'error' ? 'text-red-300' : 'text-slate-300';
            return (
            <div
              key={l.id}
              className={`group flex ${sqlLogFullText ? 'items-start' : 'items-center'} gap-2 px-3 py-1 border-b border-[#0d1117] hover:bg-[#0a0f18] transition-colors ${
                l.status === 'error' ? 'bg-red-950/10' : ''
              }`}
            >
              {/* Time */}
              <span className="text-slate-600 font-mono text-[10px] shrink-0 mt-0.5 tabular-nums">
                {l.executedAt}
              </span>

              {/* SQL — color-coded (SQL language) or plain monochrome. Full-text
                  mode wraps; truncated mode clamps to one line. */}
              <div className={`flex-1 min-w-0 ${sqlLogFullText ? '' : 'overflow-hidden'}`}>
                <div
                  className={`font-mono text-[10.5px] leading-relaxed ${sqlLogFullText ? 'whitespace-pre-wrap break-words' : 'truncate'} ${baseColor}`}
                  title={sqlLogFullText ? undefined : compactSql(l.sql, 600)}
                >
                  {sqlLogColorCoding ? (
                    <SqlHighlight sql={displaySql} className={baseColor} />
                  ) : (
                    displaySql
                  )}
                </div>
                {l.status === 'error' && l.errorMessage && (
                  <div
                    className={`font-mono text-[10px] text-red-400/70 ${sqlLogFullText ? 'whitespace-pre-wrap break-words mt-0.5' : 'truncate'}`}
                    title={sqlLogFullText ? undefined : l.errorMessage}
                  >
                    {l.errorMessage}
                  </div>
                )}
              </div>

              {/* Meta */}
              <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                {l.engine && (
                  <span className="text-[8px] uppercase tracking-wider text-slate-600 font-mono">
                    {l.engine}
                  </span>
                )}
                <span className={`text-[9px] font-mono ${l.status === 'error' ? 'text-red-400' : 'text-slate-500'}`}>
                  {l.durationMs}ms
                </span>
                <button
                  onClick={() => handleCopy(l.sql, l.id)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#1e293b] text-slate-600 hover:text-slate-300 transition-all"
                  title="Copy this SQL"
                >
                  {copiedId === l.id ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                </button>
              </div>
            </div>
            );
          })
        )}
      </div>
    </div>
  );
};
