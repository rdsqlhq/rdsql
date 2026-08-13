import React, { useState } from 'react';
import { X, Check, AlertTriangle, Copy, Trash2, Pencil, Plus } from 'lucide-react';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';

export type ChangeKind = 'insert' | 'update' | 'delete';

export interface PendingChange {
  kind: ChangeKind;
  /** The fully-formed SQL statement that will be executed if this change is applied. */
  sql: string;
  /** Short human label, e.g. "users · row 3" — shown next to the kind badge. */
  label?: string;
}

interface ApplyChangesModalProps {
  /** The staged changes, already converted to SQL by the caller. */
  changes: PendingChange[];
  /** Error from a previous apply attempt (shown so the user can fix and retry). */
  error?: string | null;
  /** True while the caller is executing the statements. */
  applying?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const KIND_META: Record<ChangeKind, { label: string; color: string; Icon: React.FC<{ className?: string }> }> = {
  insert: { label: 'INSERT', color: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', Icon: Plus },
  update: { label: 'UPDATE', color: 'text-amber-300 bg-amber-500/10 border-amber-500/30', Icon: Pencil },
  delete: { label: 'DELETE', color: 'text-red-300 bg-red-500/10 border-red-500/30', Icon: Trash2 },
};

/**
 * Confirmation dialog shown before writing pending grid edits to the database.
 * Lists every generated statement (color-coded by kind) with copy support and
 * an apply error area, so the user reviews exactly what's about to run before
 * committing. Styled to match CellEditorModal.
 */
export const ApplyChangesModal: React.FC<ApplyChangesModalProps> = ({
  changes,
  error,
  applying,
  onConfirm,
  onCancel,
}) => {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleCopy = (sql: string, idx: number) => {
    navigator.clipboard.writeText(sql);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const counts = changes.reduce(
    (acc, c) => {
      acc[c.kind] += 1;
      return acc;
    },
    { insert: 0, update: 0, delete: 0 } as Record<ChangeKind, number>
  );

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-[#1e293b] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span className="font-bold text-sm text-slate-100">Apply changes to database</span>
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#141e33]">
              {changes.length} statement{changes.length === 1 ? '' : 's'}
            </span>
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary badges */}
        <div className="px-4 py-2 border-b border-[#1e293b] flex items-center gap-2 text-[10.5px] shrink-0">
          {counts.insert > 0 && (
            <span className="px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 font-mono">
              {counts.insert} insert{counts.insert === 1 ? '' : 's'}
            </span>
          )}
          {counts.update > 0 && (
            <span className="px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 font-mono">
              {counts.update} update{counts.update === 1 ? '' : 's'}
            </span>
          )}
          {counts.delete > 0 && (
            <span className="px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-300 font-mono">
              {counts.delete} delete{counts.delete === 1 ? '' : 's'}
            </span>
          )}
          <span className="ml-auto text-slate-600">Review before applying</span>
        </div>

        {/* Statement list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {changes.map((c, idx) => {
            const meta = KIND_META[c.kind];
            const Icon = meta.Icon;
            return (
              <div key={idx} className="rounded-lg border border-[#1e293b] bg-[#0f172a]/60 overflow-hidden">
                <div className="flex items-center gap-2 px-2.5 py-1 border-b border-[#1e293b]/60">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border flex items-center gap-1 ${meta.color}`}>
                    <Icon className="w-2.5 h-2.5" />
                    {meta.label}
                  </span>
                  {c.label && <span className="text-[10px] text-slate-500 font-mono truncate">{c.label}</span>}
                  <button
                    onClick={() => handleCopy(c.sql, idx)}
                    className="ml-auto p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"
                    title="Copy SQL"
                  >
                    {copiedIdx === idx ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
                <pre className="px-2.5 py-1.5 text-[10.5px] text-slate-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
                  {c.sql}
                </pre>
              </div>
            );
          })}
        </div>

        {/* Error area */}
        {error && (
          <div className="mx-4 mb-3 shrink-0">
            <CopyableErrorBanner message={error} tone="red" compact parseAsDbError />
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-[#1e293b] flex items-center justify-between shrink-0 bg-[#06090e]">
          <span className="text-[10px] text-slate-600">
            Changes execute one statement at a time; the run stops on the first error.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              disabled={applying}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-400 transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={applying}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center gap-1.5 transition-colors"
            >
              {applying ? (
                <>
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Applying…
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Apply {changes.length} change{changes.length === 1 ? '' : 's'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
