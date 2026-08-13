import React, { useEffect, useState } from 'react';
import { X, AlertTriangle, AlertCircle } from 'lucide-react';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { cn } from '../../core/utils/cn';

/**
 * Reusable confirmation dialog — the single confirmation component for the app
 * (spec §7: "Do not introduce a second confirmation system").
 *
 * Supports:
 *  - `tone`: danger (rose) / warning (amber) / default (slate)
 *  - `requireText`: when set, the user must type this exact string (e.g. the
 *    table name) to enable the confirm button. Used for destructive ops.
 *  - `children`: arbitrary detail (SQL preview, affected-objects list, …)
 *  - auto-dismiss on Escape
 */
export const ConfirmDialog: React.FC<{
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning' | 'default';
  /** When set, the user must type this exact text to unlock the confirm button. */
  requireText?: string;
  /** Label shown above the requireText input, e.g. "Type the table name to confirm". */
  requireTextLabel?: string;
  children?: React.ReactNode;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
}> = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  requireText,
  requireTextLabel,
  children,
  onConfirm,
  onClose,
  loading = false,
}) => {
  useEscapeToClose(onClose);
  const [typed, setTyped] = useState('');

  const textMatches = !requireText || typed.trim() === requireText;

  const accent =
    tone === 'danger'
      ? { Icon: AlertCircle, text: 'text-rose-300', btn: 'bg-rose-600 hover:bg-rose-500', ring: 'border-rose-500/30' }
      : tone === 'warning'
      ? { Icon: AlertTriangle, text: 'text-amber-300', btn: 'bg-amber-600 hover:bg-amber-500', ring: 'border-amber-500/30' }
      : { Icon: AlertCircle, text: 'text-slate-300', btn: 'bg-cyan-600 hover:bg-cyan-500', ring: 'border-[#1e293b]' };

  const Icon = accent.Icon;

  // Click on backdrop closes.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className={cn('w-full max-w-lg max-h-[85vh] bg-[#0a0f18] border rounded-2xl shadow-2xl flex flex-col overflow-hidden', accent.ring)}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e293b]">
          <div className={cn('flex items-center gap-2 text-sm font-bold', accent.text)}>
            <Icon className="w-4 h-4" />
            {title}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {message && <div className="text-xs text-slate-400 leading-relaxed">{message}</div>}
          {children}
          {requireText && (
            <div className="space-y-1.5">
              {requireTextLabel && (
                <label className="block text-[11px] text-slate-500 font-semibold">
                  {requireTextLabel}
                </label>
              )}
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                placeholder={requireText}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-[#06090e] border border-[#1e293b] rounded-lg text-sm text-slate-200 px-3 py-2 font-mono focus:outline-none focus:border-cyan-500/50"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#1e293b]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={!textMatches || loading}
            className={cn(
              'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-white text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              accent.btn
            )}
          >
            {loading && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
