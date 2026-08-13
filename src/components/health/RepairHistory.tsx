import React, { useMemo } from 'react';
import { History, CheckCircle2, AlertCircle, Wrench } from 'lucide-react';
import { useRepairHistoryStore } from '../../store/useRepairHistoryStore';
import { SectionCard, EmptyState } from './primitives';
import { cn } from '../../core/utils/cn';

/** Local repair history (spec §10). Reads from the persisted store — never
 *  contains credentials. */
export const RepairHistory: React.FC<{ connectionId?: string }> = ({ connectionId }) => {
  const entries = useRepairHistoryStore((s) => s.entries);
  const filtered = useMemo(
    () => (connectionId ? entries.filter((e) => e.connectionId === connectionId) : entries).slice(0, 50),
    [entries, connectionId]
  );

  return (
    <div className="p-5">
      <SectionCard title="Repair History" icon={History}>
        {filtered.length === 0 ? (
          <EmptyState title="No repairs yet" message="Completed repairs will be listed here with timestamp, operation, and result." icon={Wrench} />
        ) : (
          <div className="divide-y divide-[#1e293b]/40">
            {filtered.map((e, i) => (
              <div key={i} className="flex items-start gap-3 py-2.5">
                <div className={cn('mt-0.5', e.result === 'success' ? 'text-emerald-400' : 'text-rose-400')}>
                  {e.result === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-slate-200 truncate">{e.operation}</div>
                  <div className="text-[10px] text-slate-500">
                    {e.connectionName} · {e.engine} · {new Date(e.timestampMs).toLocaleString()}
                  </div>
                  {e.sql.length > 0 && (
                    <code className="block mt-1 text-[10px] text-slate-500 font-mono bg-[#06090e] border border-[#1e293b] rounded p-1.5 truncate">
                      {e.sql.join('; ')}
                    </code>
                  )}
                  {e.errorMessage && <div className="text-[10px] text-rose-400 mt-1">{e.errorMessage}</div>}
                </div>
                <span className="text-[10px] text-slate-600 shrink-0">{e.durationMs} ms</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};
