import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LineChart, RefreshCw, HardDrive, Users, Gauge, Activity, Database } from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useHealthStore } from '../../store/useHealthStore';
import { useHealthHistoryStore } from '../../store/useHealthHistoryStore';
import { StatCard, SectionCard, UnsupportedState, LoadingState } from './primitives';
import { MetricChart } from './primitives/MetricChart';
import { formatBytes, formatNumber, formatRatio } from './format';
import { IndexStatisticsTable } from './IndexStatisticsTable';
import { ActivityMonitor } from './ActivityMonitor';
import { cn } from '../../core/utils/cn';

const AUTO_REFRESH_OPTIONS = [
  { label: 'Off', seconds: 0 },
  { label: '5 seconds', seconds: 5 },
  { label: '10 seconds', seconds: 10 },
  { label: '30 seconds', seconds: 30 },
  { label: '1 minute', seconds: 60 },
  { label: '5 minutes', seconds: 300 },
];

export const MonitoringPanel: React.FC = () => {
  const { connections, activeConnectionId } = useConnectionStore();
  const { statistics, loadingStatistics, refreshStatistics, activity, refreshActivity, overview, refreshOverview } = useHealthStore();
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const [refreshSeconds, setRefreshSeconds] = useState(0);
  const recordSnapshot = useHealthHistoryStore((s) => s.recordSnapshot);
  const healthHistory = useHealthHistoryStore();

  const loadAll = useCallback(async () => {
    if (!activeConn) return;
    await Promise.all([
      refreshStatistics(activeConn),
      refreshActivity(activeConn),
      refreshOverview(activeConn),
    ]);
  }, [activeConn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial load.
  useEffect(() => {
    if (activeConn && !statistics) {
      loadAll();
    }
  }, [activeConn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Record a historical snapshot whenever statistics refresh.
  useEffect(() => {
    if (activeConn && statistics) {
      recordSnapshot(activeConn.id, statistics);
    }
  }, [statistics]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh timer (lightweight monitoring only).
  useEffect(() => {
    if (refreshSeconds === 0 || !activeConn) return;
    const id = setInterval(() => {
      refreshStatistics(activeConn);
      refreshActivity(activeConn);
    }, refreshSeconds * 1000);
    return () => clearInterval(id);
  }, [refreshSeconds, activeConn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!activeConn) {
    return <div className="p-5 text-xs text-slate-500">Select a connection to view monitoring.</div>;
  }

  if (loadingStatistics && !statistics) {
    return <LoadingState message="Loading monitoring data…" />;
  }

  const hasMetrics = statistics != null;
  const sizeSeries = activeConn ? healthHistory.get(activeConn.id, 'sizeBytes') : [];
  const connSeries = activeConn ? healthHistory.get(activeConn.id, 'connectionCount') : [];

  return (
    <div className="p-5 space-y-5">
      {/* Header + auto refresh */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <LineChart className="w-4 h-4 text-cyan-400" />
            Database Monitoring
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Live metrics. Heavy diagnostics are not run during auto-refresh.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadAll()}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-[11px] text-slate-300 border border-[#1e293b]"
          >
            <RefreshCw className={cn('w-3 h-3', loadingStatistics && 'animate-spin')} />
            Refresh
          </button>
          <select
            value={refreshSeconds}
            onChange={(e) => setRefreshSeconds(Number(e.target.value))}
            className="bg-[#0f172a] border border-[#1e293b] rounded-lg text-[11px] text-slate-300 px-2 py-1.5 focus:outline-none focus:border-cyan-500/50"
          >
            {AUTO_REFRESH_OPTIONS.map((o) => (
              <option key={o.seconds} value={o.seconds}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Top metric cards */}
      {hasMetrics && statistics && overview && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Database Size" value={formatBytes(statistics.sizeBytes)} icon={Database} accent="emerald" />
          <StatCard
            label="Connections"
            value={statistics.connectionCount != null && statistics.maxConnections != null
              ? `${statistics.connectionCount} / ${statistics.maxConnections}`
              : statistics.connectionCount != null ? formatNumber(statistics.connectionCount) : '—'}
            icon={Users}
            accent="blue"
          />
          <StatCard label="Active Queries" value={statistics.activeQueries != null ? formatNumber(statistics.activeQueries) : '—'} icon={Activity} accent="cyan" />
          <StatCard label="Cache Hit" value={formatRatio(statistics.cacheHitRatio)} icon={Gauge} accent="emerald" />
          <StatCard label="Issues" value={statistics.lockCount != null ? formatNumber(statistics.lockCount) : '—'} hint="locks" icon={HardDrive} accent="amber" />
          <StatCard label="Long Queries" value={statistics.longRunningQueries != null ? formatNumber(statistics.longRunningQueries) : '—'} icon={LineChart} accent="rose" />
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SectionCard title="Database Size" icon={Database}>
          <MetricChart samples={sizeSeries} color="#34d399" formatValue={(v) => formatBytes(v)} />
        </SectionCard>
        <SectionCard title="Connections" icon={Users}>
          {connSeries.length > 0 ? (
            <MetricChart samples={connSeries} color="#38bdf8" formatValue={(v) => formatNumber(v)} />
          ) : (
            <UnsupportedState message="Connection history is not available for this database engine yet. It will populate as monitoring samples are collected." />
          )}
        </SectionCard>
      </div>

      {/* Cache / performance details */}
      {hasMetrics && statistics && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <SectionCard title="Cache" icon={Gauge}>
            <MetricRow label="Hit ratio" value={formatRatio(statistics.cacheHitRatio)} />
            <MetricRow label="Idle connections" value={statistics.idleConnections != null ? formatNumber(statistics.idleConnections) : '—'} />
          </SectionCard>
          <SectionCard title="Performance" icon={LineChart}>
            <MetricRow label="Blocking queries" value={statistics.blockingQueries != null ? formatNumber(statistics.blockingQueries) : '—'} />
            <MetricRow label="Slow queries" value={statistics.slowQueryCount != null ? formatNumber(statistics.slowQueryCount) : '—'} />
          </SectionCard>
          <SectionCard title="Storage" icon={HardDrive}>
            <MetricRow label="Table count" value={formatNumber(statistics.tableCount)} />
            <MetricRow label="Index count" value={formatNumber(statistics.indexCount)} />
            <MetricRow label="Rows" value={statistics.rowCount != null ? formatNumber(statistics.rowCount) : '—'} />
          </SectionCard>
        </div>
      )}

      {/* Index statistics */}
      <SectionCard title="Index Statistics" icon={LineChart}>
        <IndexStatisticsTable />
      </SectionCard>

      {/* Activity monitor */}
      <SectionCard title="Activity" icon={Activity}>
        <ActivityMonitor activity={activity} loading={useHealthStore.getState().loadingActivity} onRefresh={() => activeConn && refreshActivity(activeConn)} />
      </SectionCard>
    </div>
  );
};

const MetricRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-center justify-between py-1.5 border-b border-[#1e293b]/40 last:border-0">
    <span className="text-[11px] text-slate-500">{label}</span>
    <span className="text-xs font-semibold text-slate-200">{value}</span>
  </div>
);
