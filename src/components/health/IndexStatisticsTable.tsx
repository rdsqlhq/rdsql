import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpDown, AlertTriangle, AlertCircle, Box } from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useHealthStore } from '../../store/useHealthStore';
import { IndexStat } from '../../core/domain/health';
import { LoadingState, UnsupportedState } from './primitives';
import { formatBytes, formatNumber } from './format';
import { cn } from '../../core/utils/cn';

type SortKey = 'name' | 'size' | 'scans' | 'reads' | 'writes' | 'status';

export const IndexStatisticsTable: React.FC = () => {
  const { connections, activeConnectionId } = useConnectionStore();
  const { indexStats, loadIndexStats } = useHealthStore();
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const [sortKey, setSortKey] = useState<SortKey>('size');
  const [sortAsc, setSortAsc] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeConn) return;
    setLoading(true);
    loadIndexStats(activeConn, undefined, undefined).finally(() => setLoading(false));
  }, [activeConn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => {
    const getVal = (s: IndexStat): number | string => {
      switch (sortKey) {
        case 'name': return s.name;
        case 'size': return s.sizeBytes ?? -1;
        case 'scans': return s.scans ?? -1;
        case 'reads': return s.reads ?? -1;
        case 'writes': return s.writes ?? -1;
        case 'status': return s.status;
      }
    };
    const arr = [...indexStats];
    arr.sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortAsc ? cmp : -cmp;
    });
    return arr;
  }, [indexStats, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  if (loading && indexStats.length === 0) return <LoadingState message="Loading index statistics…" />;

  if (!activeConn) return <UnsupportedState message="Select a connection to view index statistics." />;

  if (indexStats.length === 0) {
    return <UnsupportedState title="No index statistics" message="This database engine does not expose detailed index statistics, or the database has no indexes." />;
  }

  // Only show usage columns when the engine provides them.
  const hasUsage = indexStats.some((s) => s.scans != null || s.reads != null || s.writes != null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-slate-500 border-b border-[#1e293b]">
            <Th label="Name" sortKey="name" current={sortKey} asc={sortAsc} onSort={toggleSort} />
            <th className="text-left px-2 py-1.5 font-semibold">Table</th>
            <th className="text-left px-2 py-1.5 font-semibold">Columns</th>
            <th className="text-left px-2 py-1.5 font-semibold">Type</th>
            <Th label="Size" sortKey="size" current={sortKey} asc={sortAsc} onSort={toggleSort} align="right" />
            {hasUsage && (
              <>
                <Th label="Scans" sortKey="scans" current={sortKey} asc={sortAsc} onSort={toggleSort} align="right" />
                <Th label="Reads" sortKey="reads" current={sortKey} asc={sortAsc} onSort={toggleSort} align="right" />
                <Th label="Writes" sortKey="writes" current={sortKey} asc={sortAsc} onSort={toggleSort} align="right" />
              </>
            )}
            <Th label="Status" sortKey="status" current={sortKey} asc={sortAsc} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => {
            const unused = s.scans === 0;
            const invalid = s.status === 'invalid';
            return (
              <tr key={`${s.name}-${i}`} className={cn('border-b border-[#1e293b]/40 hover:bg-[#0d1117]', (unused || invalid) && 'bg-amber-500/5')}>
                <td className="px-2 py-1.5 text-slate-200 font-mono flex items-center gap-1.5">
                  {(unused || invalid) && <AlertTriangle className={cn('w-3 h-3', invalid ? 'text-rose-400' : 'text-amber-400')} />}
                  {s.name}
                </td>
                <td className="px-2 py-1.5 text-slate-400 font-mono truncate max-w-[120px]">{s.table}</td>
                <td className="px-2 py-1.5 text-slate-400 font-mono truncate max-w-[160px]" title={s.columns.join(', ')}>
                  {s.columns.join(', ')}
                </td>
                <td className="px-2 py-1.5 text-slate-500">{s.indexType ?? '—'}</td>
                <td className="px-2 py-1.5 text-right text-slate-300 font-mono">{s.sizeBytes != null ? formatBytes(s.sizeBytes) : '—'}</td>
                {hasUsage && (
                  <>
                    <td className={cn('px-2 py-1.5 text-right font-mono', unused ? 'text-amber-400' : 'text-slate-300')}>{s.scans != null ? formatNumber(s.scans) : '—'}</td>
                    <td className="px-2 py-1.5 text-right text-slate-300 font-mono">{s.reads != null ? formatNumber(s.reads) : '—'}</td>
                    <td className="px-2 py-1.5 text-right text-slate-300 font-mono">{s.writes != null ? formatNumber(s.writes) : '—'}</td>
                  </>
                )}
                <td className="px-2 py-1.5">
                  <span className={cn('text-[10px] font-semibold uppercase', invalid ? 'text-rose-400' : 'text-emerald-400')}>
                    {s.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const Th: React.FC<{
  label: string;
  sortKey: SortKey;
  current: SortKey;
  asc: boolean;
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}> = ({ label, sortKey, current, asc, onSort, align = 'left' }) => (
  <th
    onClick={() => onSort(sortKey)}
    className={cn('px-2 py-1.5 font-semibold cursor-pointer hover:text-slate-300 select-none', align === 'right' ? 'text-right' : 'text-left')}
  >
    <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
      {label}
      <ArrowUpDown className={cn('w-2.5 h-2.5', current === sortKey ? 'text-cyan-400' : 'text-slate-700')} />
      {current === sortKey && <span className="text-cyan-400">{asc ? '▲' : '▼'}</span>}
    </span>
  </th>
);
