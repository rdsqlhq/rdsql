import React from 'react';
import { AlertTriangle, X, Database, Play } from 'lucide-react';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import type { PendingRun } from '../../store/useAIStore';

/**
 * Confirmation dialog shown before the AI Assistant executes destructive SQL
 * (DROP / DELETE / UPDATE / INSERT / ALTER / TRUNCATE / etc.). Displays the
 * exact SQL, the target connection + database, and the risky verbs detected —
 * the user must explicitly click "Run Anyway" to proceed.
 */
export const ConfirmRunDialog: React.FC<{
  pending: PendingRun;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ pending, onConfirm, onCancel }) => {
  useEscapeToClose(onCancel);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fadeIn"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-[#0a0f18] border border-red-500/30 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="h-12 px-4 border-b border-red-500/20 bg-red-950/30 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-red-500/15 border border-red-500/30 flex items-center justify-center text-red-400">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-red-200 text-xs">Run Destructive SQL?</h3>
              <span className="text-[10px] text-red-400/70">
                The AI wants to modify data or schema
              </span>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto macos-scroll">
          {/* Target */}
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Database className="w-3.5 h-3.5 text-blue-400" />
            <span>
              Target: <span className="text-slate-200 font-semibold">{pending.connectionName}</span>
              {pending.databaseName && (
                <span className="text-slate-400"> → {pending.databaseName}</span>
              )}
            </span>
          </div>

          {/* Risky verbs */}
          {pending.destructiveVerbs.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pending.destructiveVerbs.map((v) => (
                <span
                  key={v}
                  className="px-2 py-0.5 rounded-md bg-red-500/15 border border-red-500/30 text-red-300 text-[10px] font-mono font-bold uppercase"
                >
                  {v}
                </span>
              ))}
            </div>
          )}

          {/* SQL preview */}
          <div>
            <div className="text-[10px] text-slate-500 mb-1 font-semibold uppercase tracking-wide">
              SQL to execute
            </div>
            <pre className="bg-[#06090e] border border-[#1e293b] rounded-lg p-3 text-[11px] font-mono text-cyan-300 whitespace-pre-wrap break-all max-h-48 overflow-y-auto macos-scroll leading-relaxed">
              {pending.sql}
            </pre>
          </div>

          <p className="text-[10px] text-slate-500 leading-relaxed">
            This action runs against a live database and cannot be undone. Verify the SQL is correct
            and targets the right connection before proceeding.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#1e293b] bg-[#06090e]">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-300 bg-[#1e293b] hover:bg-[#334155] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-500 flex items-center gap-1.5 transition-colors shadow-lg shadow-red-600/20"
          >
            <Play className="w-3.5 h-3.5" />
            Run Anyway
          </button>
        </div>
      </div>
    </div>
  );
};
