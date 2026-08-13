import React, { useEffect, useMemo } from 'react';
import { Database, Clock, Wrench, Server } from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useHealthStore } from '../../store/useHealthStore';
import { deriveHealthState } from './healthState';
import { HEALTH_STATE_STYLES } from './primitives';
import { StatCard, SectionCard, LoadingState } from './primitives';
import { HealthScoreCard } from './HealthScoreCard';
import { getOverviewTiles } from './overviewTiles';
import { RedisOverviewSections } from './RedisOverviewSections';
import { formatNumber, formatRelativeTime } from './format';
import { formatUptime } from '../../core/domain/health';
import { cn } from '../../core/utils/cn';
import { isMongoEngine, isRedisEngine } from '../../core/connection/engines';

export const OverviewPanel: React.FC = () => {
  const { connections, activeConnectionId } = useConnectionStore();
  const { overview, healthReport, loadingOverview, refreshOverview, runDiagnostics, lastDiagnosticTime, lastMaintenanceTime } = useHealthStore();
  const activeConn = connections.find((c) => c.id === activeConnectionId);

  // The parent already triggers refreshOverview on connection change; this
  // guard re-fetches if the overview is missing (e.g. returning to the tab).
  useEffect(() => {
    if (activeConn && !overview && !loadingOverview) {
      refreshOverview(activeConn);
    }
  }, [activeConn?.id, overview]); // eslint-disable-line react-hooks/exhaustive-deps

  const healthState = healthReport ? deriveHealthState(healthReport.issueCounts) : 'healthy';
  const hs = HEALTH_STATE_STYLES[healthState];

  if (loadingOverview && !overview) {
    return <LoadingState message="Loading database overview…" />;
  }

  if (!overview) {
    return (
      <div className="p-5 text-xs text-slate-500">
        No overview available. Select a connection to load its database overview.
      </div>
    );
  }

  return (
    <div className="p-5 space-y-5">
      {/* Health summary banner */}
      <div className={cn('p-4 rounded-xl border flex items-center justify-between', hs.text, 'border-current/20 bg-[#0a0f18]')}>
        <div className="flex items-center gap-3">
          <span className={cn('w-2.5 h-2.5 rounded-full', hs.dot)} />
          <div>
            <div className="text-sm font-bold text-slate-100">Database Health · {hs.label}</div>
            <div className="text-[11px] text-slate-500">
              {healthReport
                ? `${formatNumber(healthReport.issueCounts.critical)} critical · ${formatNumber(healthReport.issueCounts.warning)} warnings · ${formatNumber(healthReport.issueCounts.info)} info`
                : 'Run diagnostics to see issues'}
            </div>
          </div>
        </div>
        <button
          onClick={() => activeConn && runDiagnostics(activeConn, { heavy: true })}
          className="px-3 py-1.5 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-xs font-semibold text-slate-200 border border-[#1e293b]"
        >
          Run Diagnose
        </button>
      </div>

      {/* Top metric cards — tile set depends on the connection's engine */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {getOverviewTiles(activeConn?.engine ?? overview.engine, overview, healthReport).map((tile) => (
          <StatCard key={tile.label} label={tile.label} value={tile.value} icon={tile.icon} accent={tile.accent} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Connection details */}
        <SectionCard title="Connection" icon={Server}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <Detail label="Engine" value={overview.engine} />
            <Detail label="Version" value={overview.version ?? '—'} />
            <Detail label="Database" value={overview.databaseName ?? '—'} />
            <Detail label="Host" value={overview.host ?? '—'} />
            <Detail label="Port" value={overview.port != null ? String(overview.port) : '—'} />
            <Detail label="Status" value={overview.connectionStatus} />
            <Detail label="Server time" value={overview.serverTime ?? '—'} />
            <Detail label="Uptime" value={formatUptime(overview.uptimeSeconds)} />
            {!isRedisEngine(overview.engine) && (
              <Detail label={isMongoEngine(overview.engine) ? 'Databases' : 'Schemas'} value={formatNumber(overview.schemaCount)} />
            )}
            {!isMongoEngine(overview.engine) && !isRedisEngine(overview.engine) && (
              <>
                <Detail label="Views" value={formatNumber(overview.viewCount)} />
                <Detail label="Sequences" value={formatNumber(overview.sequenceCount)} />
                <Detail label="Constraints" value={formatNumber(overview.constraintCount)} />
              </>
            )}
            {overview.journalMode && <Detail label="Journal mode" value={overview.journalMode} />}
            {overview.autoVacuum && <Detail label="Auto vacuum" value={overview.autoVacuum} />}
            <Detail label="Last diagnostic" value={formatRelativeTime(lastDiagnosticTime)} icon={Clock} />
            <Detail label="Last maintenance" value={formatRelativeTime(lastMaintenanceTime)} icon={Wrench} />
          </dl>
        </SectionCard>

        {/* Health score */}
        <SectionCard title="Health Score" icon={Database}>
          <HealthScoreCard />
        </SectionCard>

        {isRedisEngine(overview.engine) && <RedisOverviewSections overview={overview} />}
      </div>
    </div>
  );
};

const Detail: React.FC<{ label: string; value: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }> = ({ label, value, icon: Icon }) => (
  <div className="flex items-center justify-between border-b border-[#1e293b]/40 pb-1.5">
    <dt className="text-slate-500 flex items-center gap-1.5">
      {Icon && <Icon className="w-3 h-3" />}
      {label}
    </dt>
    <dd className="text-slate-300 font-medium truncate ml-2 max-w-[60%] text-right" title={typeof value === 'string' ? value : undefined}>
      {value}
    </dd>
  </div>
);
