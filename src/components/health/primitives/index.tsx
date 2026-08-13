import React from 'react';
import { AlertTriangle, Info, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { Severity, HealthState } from '../../../core/domain/health';
import { cn } from '../../../core/utils/cn';

/** Color/icon mapping for a diagnostic severity. Shared by every health view. */
export const SEVERITY_STYLES: Record<
  Severity,
  { label: string; text: string; bg: string; border: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  critical: {
    label: 'Critical',
    text: 'text-rose-400',
    bg: 'bg-rose-500/15',
    border: 'border-rose-500/30',
    Icon: AlertCircle,
  },
  warning: {
    label: 'Warning',
    text: 'text-amber-400',
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/20',
    Icon: AlertTriangle,
  },
  info: {
    label: 'Info',
    text: 'text-sky-400',
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/20',
    Icon: Info,
  },
};

export const HEALTH_STATE_STYLES: Record<
  HealthState,
  { label: string; dot: string; text: string }
> = {
  healthy: { label: 'Healthy', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  notice: { label: 'Notice', dot: 'bg-sky-400', text: 'text-sky-400' },
  warning: { label: 'Warning', dot: 'bg-amber-400', text: 'text-amber-400' },
  critical: { label: 'Critical', dot: 'bg-rose-400', text: 'text-rose-400' },
};

export const SeverityBadge: React.FC<{ severity: Severity; className?: string }> = ({ severity, className }) => {
  const s = SEVERITY_STYLES[severity];
  const Icon = s.Icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border',
        s.bg,
        s.text,
        s.border,
        className
      )}
    >
      <Icon className="w-3 h-3" />
      {s.label}
    </span>
  );
};

export const StatCard: React.FC<{
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  accent?: 'blue' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'slate';
  children?: React.ReactNode;
}> = ({ label, value, hint, icon: Icon, accent = 'slate', children }) => {
  const accentMap = {
    blue: 'text-blue-400',
    cyan: 'text-cyan-400',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    rose: 'text-rose-400',
    slate: 'text-slate-300',
  };
  return (
    <div className="p-4 bg-[#0a0f18] border border-[#1e293b] rounded-xl flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</span>
        {Icon && <Icon className={cn('w-3.5 h-3.5', accentMap[accent])} />}
      </div>
      <div className={cn('text-lg font-bold', accentMap[accent])}>{value}</div>
      {hint && <div className="text-[10px] text-slate-500">{hint}</div>}
      {children}
    </div>
  );
};

export const SectionCard: React.FC<{
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, icon: Icon, actions, children, className }) => (
  <div className={cn('bg-[#0a0f18] border border-[#1e293b] rounded-xl overflow-hidden', className)}>
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1e293b] bg-[#0d1117]/60">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-400" />}
        {title}
      </div>
      {actions}
    </div>
    <div className="p-4">{children}</div>
  </div>
);

export const EmptyState: React.FC<{
  title: string;
  message: string;
  icon?: React.ComponentType<{ className?: string }>;
  children?: React.ReactNode;
}> = ({ title, message, icon: Icon = CheckCircle2, children }) => (
  <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
    <Icon className="w-10 h-10 text-emerald-400/60 mb-3" />
    <div className="text-sm font-semibold text-slate-200">{title}</div>
    <div className="text-xs text-slate-500 mt-1 max-w-md">{message}</div>
    {children && <div className="mt-4">{children}</div>}
  </div>
);

export const UnsupportedState: React.FC<{
  title?: string;
  message: string;
}> = ({ title = 'Not available', message }) => (
  <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
    <Info className="w-8 h-8 text-slate-600 mb-2" />
    <div className="text-xs font-semibold text-slate-400">{title}</div>
    <div className="text-[11px] text-slate-600 mt-1 max-w-sm">{message}</div>
  </div>
);

export const LoadingState: React.FC<{ message?: string }> = ({ message = 'Loading…' }) => (
  <div className="flex items-center justify-center py-10">
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <div className="w-3.5 h-3.5 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin" />
      {message}
    </div>
  </div>
);

export const ErrorState: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => (
  <div className="flex flex-col items-center justify-center py-8 px-6 text-center">
    <AlertCircle className="w-8 h-8 text-rose-400/70 mb-2" />
    <div className="text-xs font-semibold text-rose-300">Something went wrong</div>
    <div className="text-[11px] text-slate-500 mt-1 max-w-sm break-words">{message}</div>
    {onRetry && (
      <button
        onClick={onRetry}
        className="mt-3 px-3 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-xs text-slate-200 border border-[#1e293b]"
      >
        Retry
      </button>
    )}
  </div>
);
