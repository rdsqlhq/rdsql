import React, { useEffect } from 'react';
import { X, CheckCircle2, Info, AlertTriangle, AlertCircle } from 'lucide-react';
import { useToastStore, ToastSeverity } from '../../store/useToastStore';
import { cn } from '../../core/utils/cn';

const SEVERITY_STYLE: Record<
  ToastSeverity,
  { Icon: React.ComponentType<{ className?: string }>; accent: string; ring: string }
> = {
  info: { Icon: Info, accent: 'text-sky-400', ring: 'border-sky-500/30' },
  success: { Icon: CheckCircle2, accent: 'text-emerald-400', ring: 'border-emerald-500/30' },
  warning: { Icon: AlertTriangle, accent: 'text-amber-400', ring: 'border-amber-500/30' },
  error: { Icon: AlertCircle, accent: 'text-rose-400', ring: 'border-rose-500/30' },
};

const ToastItem: React.FC<{
  id: string;
  severity: ToastSeverity;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}> = ({ id, severity, title, message, actionLabel, onAction }) => {
  const dismiss = useToastStore((s) => s.dismiss);
  const style = SEVERITY_STYLE[severity];
  const Icon = style.Icon;

  // Auto-dismiss after 6s.
  useEffect(() => {
    const t = setTimeout(() => dismiss(id), 6000);
    return () => clearTimeout(t);
  }, [id, dismiss]);

  return (
    <div
      className={cn(
        'pointer-events-auto w-80 bg-[#0a0f18] border rounded-xl shadow-2xl shadow-black/40 p-3 flex items-start gap-2.5',
        style.ring
      )}
    >
      <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', style.accent)} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-slate-100">{title}</div>
        {message && <div className="text-[11px] text-slate-400 mt-0.5 break-words">{message}</div>}
        {actionLabel && (
          <button
            onClick={() => {
              onAction?.();
              dismiss(id);
            }}
            className="mt-1.5 text-[11px] font-semibold text-cyan-400 hover:text-cyan-300"
          >
            {actionLabel}
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(id)}
        className="text-slate-500 hover:text-slate-300 shrink-0"
        title="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export const ToastContainer: React.FC = () => {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastItem
          key={t.id}
          id={t.id}
          severity={t.severity}
          title={t.title}
          message={t.message}
          actionLabel={t.actionLabel}
          onAction={t.onAction}
        />
      ))}
    </div>
  );
};
