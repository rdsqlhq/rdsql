import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Table as TableIcon,
  PanelBottomClose,
  Wand2,
} from 'lucide-react';
import { useTabStore } from '../../store/useTabStore';
import { useAIStore } from '../../store/useAIStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { isAIConfigured } from '../../core/ai/types';
import { parseDbError, errorKindLabel, errorKindColor } from '../../core/sql/dbError';
import { ResultGrid } from '../editor/ResultGrid';

/**
 * Result grid panel for the active SQL editor tab. Shows only the query result
 * (rows grid) or error card — NOT the global SQL log (that's in GlobalSqlLog).
 * Has its own collapse/hide toggle independent of the global log panel.
 */
export const ResultPanel: React.FC<{ onHide?: () => void }> = ({ onHide }) => {
  const { tabs, activeTabId } = useTabStore();
  const [activeResultIdx, setActiveResultIdx] = useState(0);

  const activeTabObj = tabs.find((t) => t.id === activeTabId);
  const resultSets = activeTabObj?.resultSets;
  const result = activeTabObj?.result;
  const resultRowCount = result?.rows?.length ?? 0;
  const hasResultOrError = !!(result || activeTabObj?.error);

  // Reset the active result-set index when the set list changes.
  const resultSetsKey = resultSets?.map((r) => r.id).join('|') ?? '';
  useEffect(() => {
    setActiveResultIdx(0);
  }, [resultSetsKey]);

  if (!hasResultOrError && (!resultSets || resultSets.length === 0)) {
    return null; // Nothing to show — don't render the panel at all.
  }

  return (
    <div className="h-full w-full bg-[#06090e] border-t border-[#1e293b] flex flex-col select-none font-sans overflow-hidden">
      {/* Header — result sub-tabs (for multi-statement) + collapse */}
      <div className="h-8 border-b border-[#1e293b] px-2 bg-[#080c14] flex items-center justify-between shrink-0 text-xs">
        <div className="flex items-center gap-1 h-full">
          {/* Result sub-tabs: one per statement result set */}
          {resultSets && resultSets.length > 1
            ? resultSets.map((rs, idx) => {
                const isActive = idx === activeResultIdx;
                const accent = rs.status === 'error'
                  ? 'red'
                  : rs.editableTable
                  ? 'emerald'
                  : 'slate';
                const borderAccent = accent === 'red'
                  ? 'border-red-500'
                  : accent === 'emerald'
                  ? 'border-emerald-500'
                  : 'border-cyan-500';
                const textAccent = accent === 'red'
                  ? 'text-red-300'
                  : accent === 'emerald'
                  ? 'text-emerald-300'
                  : 'text-cyan-300';
                return (
                  <button
                    key={rs.id}
                    onClick={() => setActiveResultIdx(idx)}
                    className={`h-full px-2.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider border-b-2 transition-colors ${
                      isActive
                        ? `${borderAccent} ${textAccent}`
                        : 'border-transparent text-slate-500 hover:text-slate-300'
                    }`}
                    title={rs.statement}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        accent === 'red'
                          ? 'bg-red-400'
                          : accent === 'emerald'
                          ? 'bg-emerald-400'
                          : 'bg-slate-500'
                      }`}
                    />
                    <span>Result {idx + 1}</span>
                    {rs.result && (
                      <span className="px-1.5 py-0.2 rounded-full bg-[#1e293b] text-slate-400 text-[10px] font-mono font-normal normal-case">
                        {rs.result.rows?.length ?? 0}
                      </span>
                    )}
                    {rs.status === 'error' && <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />}
                  </button>
                );
              })
            : (
              <div className="h-full px-2.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider border-b-2 border-emerald-500 text-emerald-300">
                <TableIcon className="w-3.5 h-3.5" />
                <span>Result</span>
                {result && (
                  <span className="px-1.5 py-0.2 rounded-full bg-[#1e293b] text-slate-400 text-[10px] font-mono font-normal">
                    {resultRowCount}
                  </span>
                )}
              </div>
            )
          }
        </div>

        {/* Collapse button */}
        {onHide && (
          <button
            onClick={onHide}
            className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"
            title="Hide result panel"
          >
            <PanelBottomClose className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Result grid body */}
      <div className="flex-1 min-h-0 flex flex-col bg-[#06090e] select-text overflow-hidden">
        {activeTabObj?.error && (!resultSets || resultSets.every((rs) => rs.status === 'error')) ? (
          <ErrorCard
            message={activeTabObj.error}
            tabId={activeTabId}
            sql={activeTabObj.sql}
          />
        ) : !resultSets || resultSets.length === 0 ? (
          !result ? (
            <div className="text-slate-600 italic p-3 text-xs">
              No result yet. Run a query (Ctrl/Cmd+Enter) to see its output here.
            </div>
          ) : (
            // Legacy single-result path
            <div className="flex-1 min-h-0">
              <ResultGrid
                tabId={activeTabId}
                resultSet={{
                  id: `legacy_${activeTabId}`,
                  statement: '',
                  status: 'success',
                  result,
                }}
              />
            </div>
          )
        ) : resultSets.length === 1 ? (
          <div className="flex-1 min-h-0">
            <ResultGrid tabId={activeTabId} resultSet={resultSets[0]} />
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            {resultSets[activeResultIdx] && (
              <ResultGrid tabId={activeTabId} resultSet={resultSets[activeResultIdx]} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** Parsed error card for a failed statement. Includes an "AI Fix" button that
 *  asks the AI Assistant to diagnose the error and propose a corrected query
 *  (confirmation dialog follows — nothing is auto-applied). */
const ErrorCard: React.FC<{ message: string; tabId: string; sql: string }> = ({
  message,
  tabId,
  sql,
}) => {
  const e = parseDbError(message);
  const requestFix = useAIStore((s) => s.requestFix);
  const isGenerating = useAIStore((s) => s.isGenerating);
  const ai = useSettingsStore((s) => s.ai);
  const aiReady = isAIConfigured(ai);

  const handleFix = () => {
    if (!sql.trim()) return;
    void requestFix(tabId, sql, message);
  };

  return (
    <div className="m-3 rounded-lg bg-red-500/10 border border-red-500/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-red-950/40 border-b border-red-500/20">
        <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
        <span className={`text-[10px] font-bold uppercase tracking-wider ${errorKindColor(e.kind)}`}>
          {errorKindLabel(e.kind)}{e.code ? ` · ${e.code}` : ''}
        </span>
        {aiReady && sql.trim() && (
          <button
            onClick={handleFix}
            disabled={isGenerating}
            className="ml-auto px-2 py-0.5 rounded-md bg-cyan-600/20 hover:bg-cyan-600/40 border border-cyan-500/30 text-cyan-300 text-[10px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Ask the AI Assistant to fix this query"
          >
            <Wand2 className="w-3 h-3" />
            {isGenerating ? 'Fixing…' : 'AI Fix'}
          </button>
        )}
      </div>
      <div className="p-3 space-y-2">
        <pre className="text-red-200 text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed">
          {e.message}
        </pre>
        {e.detail && (
          <pre className="text-slate-300 text-[11px] font-mono whitespace-pre-wrap break-all">
            {e.detail}
          </pre>
        )}
        {e.hint && (
          <pre className="text-cyan-300 text-[11px] font-mono whitespace-pre-wrap break-all">
            {e.hint}
          </pre>
        )}
      </div>
    </div>
  );
};
