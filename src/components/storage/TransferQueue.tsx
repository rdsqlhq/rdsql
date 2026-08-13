import React from 'react';
import { ArrowUp, ArrowDown, X, CheckCircle2, AlertTriangle, Clock, Loader2 } from 'lucide-react';
import { useTransferManager } from '../../core/storage/react';
import { formatBytes, formatSpeed, formatEta, formatPercent } from './format';
import type { TransferTask } from '../../core/storage/domain/types';

const statusColor: Record<string, string> = {
  queued: 'text-slate-400',
  preparing: 'text-blue-400',
  active: 'text-blue-400',
  retrying: 'text-amber-400',
  completed: 'text-emerald-400',
  failed: 'text-red-400',
  canceled: 'text-slate-500',
};

export const TransferQueue: React.FC = () => {
  const mgr = useTransferManager();
  const tasks = mgr.snapshot();
  const active = tasks.filter((t) => ['active', 'preparing', 'retrying', 'queued'].includes(t.status));
  const finished = tasks.filter((t) => !['active', 'preparing', 'retrying', 'queued'].includes(t.status));

  if (tasks.length === 0) {
    return (
      <div className="border border-dashed border-[#1e293b] rounded-xl p-10 text-center text-slate-600 text-sm">
        No transfers yet. Uploads and downloads appear here with live progress.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {active.length > 0 && (
        <div className="flex flex-col gap-2">
          {active.map((t) => (
            <TransferRow key={t.id} task={t} onCancel={(id) => mgr.cancel(id)} />
          ))}
        </div>
      )}
      {finished.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-slate-600">History</span>
            <button
              onClick={() => mgr.clearFinished()}
              className="text-[11px] text-slate-500 hover:text-slate-300"
            >
              Clear finished
            </button>
          </div>
          {finished.slice(0, 20).map((t) => (
            <TransferRow key={t.id} task={t} onCancel={(id) => mgr.cancel(id)} />
          ))}
        </div>
      )}
    </div>
  );
};

const TransferRow: React.FC<{ task: TransferTask; onCancel: (id: string) => void }> = ({ task, onCancel }) => {
  const pct = formatPercent(task.bytesDone, task.totalBytes);
  const isActive = ['active', 'preparing', 'retrying', 'queued'].includes(task.status);
  const Icon = task.direction === 'upload' ? ArrowUp : ArrowDown;
  return (
    <div className="border border-[#1e293b] rounded-xl p-3 bg-[#0a0f18] flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${task.direction === 'upload' ? 'text-blue-400' : 'text-emerald-400'}`} />
        <span className="text-xs text-slate-200 truncate flex-1" title={task.key}>{task.key}</span>
        <StatusBadge status={task.status} />
        {isActive ? (
          <button
            onClick={() => onCancel(task.id)}
            className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-red-400"
            title="Cancel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>

      <div className="h-1.5 bg-[#0f172a] rounded-full overflow-hidden">
        <div
          className={`h-full transition-[width] duration-300 ${
            task.status === 'failed' ? 'bg-red-500' : task.status === 'canceled' ? 'bg-slate-600' : 'bg-blue-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center gap-3 text-[10px] text-slate-500">
        <span>{formatBytes(task.bytesDone)}{task.totalBytes != null ? ` / ${formatBytes(task.totalBytes)}` : ''}</span>
        {isActive && <span>{formatSpeed(task.speedBps)}</span>}
        {isActive && task.etaSec != null && (
          <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{formatEta(task.etaSec)}</span>
        )}
        {!isActive && task.error && (
          <span className="text-red-400 truncate" title={task.error}>{task.error}</span>
        )}
      </div>
    </div>
  );
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const color = statusColor[status] ?? 'text-slate-400';
  if (status === 'active' || status === 'preparing') {
    return (
      <span className={`flex items-center gap-1 text-[10px] ${color}`}>
        <Loader2 className="w-3 h-3 animate-spin" /> {status}
      </span>
    );
  }
  if (status === 'completed') {
    return <CheckCircle2 className={`w-3.5 h-3.5 ${color}`} />;
  }
  if (status === 'failed') {
    return <AlertTriangle className={`w-3.5 h-3.5 ${color}`} />;
  }
  return <span className={`text-[10px] ${color}`}>{status}</span>;
};
