import React, { useState } from 'react';
import { RefreshCw, Copy, XCircle, Loader2, Check } from 'lucide-react';
import { ActivitySnapshot, ActivityRow } from '../../core/domain/health';
import { UnsupportedState, LoadingState } from './primitives';
import { safeInvoke } from '../../core/tauri/ipc';
import { useConnectionStore } from '../../store/useConnectionStore';
import { cn } from '../../core/utils/cn';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';

/** Active-query monitor (spec §15). Cancel/terminate are gated by a
 *  confirmation popover; the actions are delegated to the existing
 *  `execute_query` path via engine-specific termination SQL. */
export const ActivityMonitor: React.FC<{
  activity: ActivitySnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}> = ({ activity, loading, onRefresh }) => {
  const [confirming, setConfirming] = useState<ActivityRow | null>(null);
  const [copiedPid, setCopiedPid] = useState<string | null>(null);

  if (loading && !activity) return <LoadingState message="Loading activity…" />;

  if (!activity || !activity.supported) {
    return <UnsupportedState title="Monitoring unavailable" message="This database engine does not expose active-query activity. SQLite and Cloudflare D1 do not provide a processlist." />;
  }

  const rows = activity.rows ?? [];

  if (rows.length === 0) {
    return (
      <div className="py-6 text-center">
        <Check className="w-8 h-8 text-emerald-400/60 mx-auto mb-2" />
        <div className="text-xs font-semibold text-slate-300">No active sessions</div>
        <div className="text-[11px] text-slate-500 mt-0.5">There are no other running queries on this database.</div>
      </div>
    );
  }

  const copyQuery = (row: ActivityRow) => {
    if (row.query) {
      navigator.clipboard?.writeText(row.query);
      setCopiedPid(row.pid);
      setTimeout(() => setCopiedPid(null), 1500);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-slate-500 border-b border-[#1e293b]">
            <th className="text-left px-2 py-1.5 font-semibold">PID</th>
            <th className="text-left px-2 py-1.5 font-semibold">Duration</th>
            <th className="text-left px-2 py-1.5 font-semibold">State</th>
            <th className="text-left px-2 py-1.5 font-semibold">Query</th>
            <th className="text-right px-2 py-1.5 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.pid} className="border-b border-[#1e293b]/40 hover:bg-[#0d1117]">
              <td className="px-2 py-1.5 text-slate-300 font-mono">{r.pid}</td>
              <td className={cn('px-2 py-1.5 font-mono', (r.durationSeconds ?? 0) > 300 ? 'text-rose-400' : (r.durationSeconds ?? 0) > 60 ? 'text-amber-400' : 'text-slate-300')}>
                {r.durationLabel}
              </td>
              <td className="px-2 py-1.5">
                <span className={cn('text-[10px] font-semibold uppercase', r.state === 'active' ? 'text-emerald-400' : r.state === 'idle' ? 'text-slate-500' : 'text-amber-400')}>
                  {r.state}
                </span>
              </td>
              <td className="px-2 py-1.5 text-slate-400 font-mono truncate max-w-[320px]" title={r.query ?? ''}>
                {r.query ?? '—'}
              </td>
              <td className="px-2 py-1.5">
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => copyQuery(r)}
                    title="Copy query"
                    className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-[#141e33]"
                  >
                    {copiedPid === r.pid ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => setConfirming(r)}
                    title="Cancel query"
                    className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10"
                  >
                    <XCircle className="w-3 h-3" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {confirming && (
        <ConfirmCancel
          row={confirming}
          onClose={() => setConfirming(null)}
          onDone={() => {
            setConfirming(null);
            onRefresh();
          }}
        />
      )}
    </div>
  );
};

/** Inline confirmation for cancelling a query. The actual cancellation runs the
 *  engine-appropriate termination statement through `execute_query`. */
const ConfirmCancel: React.FC<{ row: ActivityRow; onClose: () => void; onDone: () => void }> = ({ row, onClose, onDone }) => {
  const { connections, activeConnectionId } = useConnectionStore();
  const conn = connections.find((c) => c.id === activeConnectionId);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!conn) return;
    setRunning(true);
    setError(null);
    try {
      // Engine-specific termination. Postgres: pg_cancel_backend; MySQL: KILL
      // QUERY; SQL Server: KILL <session_id> (T-SQL has no "cancel just this
      // query" — KILL ends the whole session).
      const engine = conn.engine;
      let sql = '';
      if (engine === 'postgres') sql = `SELECT pg_cancel_backend(${row.pid});`;
      else if (engine === 'mysql') sql = `KILL QUERY ${row.pid};`;
      else if (engine === 'mssql') sql = `KILL ${row.pid};`;
      else throw new Error(`Cancellation not supported for engine: ${engine}`);
      await safeInvoke('execute_query', {
        request: { config: conn, sql },
        queryId: `cancel_${row.pid}_${Date.now()}`,
      });
      onDone();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md bg-[#0a0f18] border border-rose-500/30 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 text-rose-300 font-semibold text-xs mb-2">
          <XCircle className="w-4 h-4" />
          Cancel query?
        </div>
        <p className="text-[11px] text-slate-400 mb-3">
          This will attempt to cancel backend <span className="font-mono text-slate-300">{row.pid}</span> running for {row.durationLabel}. This is a potentially disruptive action.
        </p>
        <code className="block text-[10px] text-slate-500 font-mono bg-[#06090e] border border-[#1e293b] rounded p-2 mb-3 truncate">
          {row.query}
        </code>
        {error && (
          <div className="mb-2">
            <CopyableErrorBanner message={error} tone="rose" compact parseAsDbError />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200">
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold disabled:opacity-50"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Confirm Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
