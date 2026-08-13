import React, { useState } from 'react';
import { AlertCircle, AlertTriangle, Copy, Check } from 'lucide-react';
import { cn } from '../../core/utils/cn';
import { copyToClipboard } from '../../core/utils/clipboard';
import { parseDbError, formatDbErrorTrace, errorKindLabel, errorKindColor } from '../../core/sql/dbError';

/**
 * The single error banner for the app. Renders the message and — when the text
 * is a structured DB error — the detail/hint/code too. A Copy button always
 * copies a stable multi-line trace to the clipboard so users can paste errors
 * into bug reports or chat.
 *
 * Use this anywhere we previously inlined
 *   `<div className="...rose..."><AlertCircle/><span>{err}</span></div>`
 */
export const CopyableErrorBanner: React.FC<{
  /** Plain message string OR a raw backend error string (JSON or otherwise). */
  message: string | null | undefined;
  /**
   * When true, `message` is treated as a raw backend error string and parsed
   * with parseDbError so we can surface detail/hint/code. When false (default),
   * it is shown verbatim. This lets callers pass a hand-written UI message
   * without it being misinterpreted as a DB error.
   */
  parseAsDbError?: boolean;
  /** lucide icon override; defaults to AlertCircle. */
  Icon?: React.ComponentType<{ className?: string }>;
  /** Visual tone. `rose` is the app default. */
  tone?: 'rose' | 'amber' | 'red';
  className?: string;
  /** Smaller padding/font for inline contexts (e.g. under a form field). */
  compact?: boolean;
}> = ({ message, parseAsDbError = false, Icon, tone = 'rose', className, compact = false }) => {
  const [copied, setCopied] = useState(false);
  if (!message) return null;

  const parsed = parseAsDbError ? parseDbError(message) : null;
  // The text we copy is always the full trace (if structured) or the raw string.
  const copyText = parsed ? formatDbErrorTrace(parsed) : message;

  const handleCopy = async () => {
    const ok = await copyToClipboard(copyText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const palette =
    tone === 'amber'
      ? { box: 'bg-amber-500/10 border-amber-500/20 text-amber-400', DefaultIcon: AlertTriangle }
      : tone === 'red'
      ? { box: 'bg-red-950/30 border-red-500/30 text-red-400', DefaultIcon: AlertTriangle }
      : { box: 'bg-rose-500/10 border-rose-500/20 text-rose-400', DefaultIcon: AlertCircle };
  const FinalIcon = Icon ?? palette.DefaultIcon;

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-xl border',
        palette.box,
        compact ? 'p-2' : 'p-3',
        className
      )}
    >
      <FinalIcon className={cn('shrink-0 mt-0.5', compact ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
      <div className="min-w-0 flex-1">
        {parsed ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className={cn('text-[10px] font-bold uppercase tracking-wider', errorKindColor(parsed.kind))}>
                {errorKindLabel(parsed.kind)}
                {parsed.code ? ` · ${parsed.code}` : ''}
              </span>
            </div>
            <pre
              className={cn('font-mono whitespace-pre-wrap break-all leading-relaxed text-slate-200', compact ? 'text-[11px]' : 'text-xs')}
            >
              {parsed.message}
            </pre>
            {parsed.detail && (
              <pre className="font-mono whitespace-pre-wrap break-all text-slate-400 text-[11px]">
                {parsed.detail}
              </pre>
            )}
            {parsed.hint && (
              <pre className="font-mono whitespace-pre-wrap break-all text-cyan-300 text-[11px]">
                {parsed.hint}
              </pre>
            )}
          </div>
        ) : (
          <span className={cn('block break-words', compact ? 'text-[11px]' : 'text-xs')}>{message}</span>
        )}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy error to clipboard"
        className={cn(
          'shrink-0 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors flex items-center gap-1',
          compact ? 'p-1' : 'p-1.5'
        )}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        {!compact && <span className="text-[10px]">{copied ? 'Copied' : 'Copy'}</span>}
      </button>
    </div>
  );
};
