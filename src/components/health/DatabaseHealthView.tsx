import React, { useEffect, useMemo, useRef } from 'react';
import { Activity, Stethoscope, Wrench, LineChart, Database as DatabaseIcon } from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useHealthStore } from '../../store/useHealthStore';
import { useHealthHistoryStore } from '../../store/useHealthHistoryStore';
import { useToastStore } from '../../store/useToastStore';
import { EngineIcon } from '../common/EngineIcon';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { hasHealthCapability, HealthCapability } from '../../core/domain/healthCapabilities';
import { cn } from '../../core/utils/cn';
import { deriveHealthState, HealthState, HEALTH_STATE_STYLES } from './healthState';
import { OverviewPanel } from './OverviewPanel';
import { DiagnosePanel } from './DiagnosePanel';
import { RepairCenter } from './RepairCenter';
import { MonitoringPanel } from './MonitoringPanel';
import { RepairHistory } from './RepairHistory';

type HealthTab = 'overview' | 'diagnose' | 'repair' | 'monitoring';

export const DatabaseHealthView: React.FC = () => {
  const { connections, activeConnectionId, setActiveConnection } = useConnectionStore();
  const {
    overview,
    healthReport,
    diagnostics,
    refreshOverview,
    runDiagnostics,
    clear,
    lastError,
  } = useHealthStore();
  const [tab, setTab] = React.useState<HealthTab>('overview');
  const lastSeverityRef = useRef<HealthState | null>(null);
  const { push } = useToastStore();

  const activeConn = useMemo(
    () => connections.find((c) => c.id === activeConnectionId) ?? null,
    [connections, activeConnectionId]
  );

  // Load overview + statistics when the active connection changes.
  useEffect(() => {
    if (!activeConn) {
      clear();
      return;
    }
    refreshOverview(activeConn);
  }, [activeConn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the newly active connection's engine doesn't support the currently
  // open tab (e.g. switching from Postgres, on "Repair", to Redis, which has
  // no maintenance actions), fall back to Overview rather than rendering a
  // tab with no button pointing at it.
  useEffect(() => {
    if (!activeConn) return;
    const tabCapability: Partial<Record<HealthTab, HealthCapability>> = {
      repair: 'maintenance',
      monitoring: 'connections',
    };
    const required = tabCapability[tab];
    if (required && !hasHealthCapability(activeConn.engine, required)) {
      setTab('overview');
    }
  }, [activeConn?.engine]); // eslint-disable-line react-hooks/exhaustive-deps

  // Emit a non-intrusive toast when the overall health state changes.
  useEffect(() => {
    if (!healthReport || !activeConn) return;
    const state = deriveHealthState(healthReport.issueCounts);
    const prev = lastSeverityRef.current;
    if (prev !== null && prev !== state) {
      const severityMap: Record<HealthState, 'success' | 'warning' | 'error' | 'info'> = {
        healthy: 'success',
        notice: 'info',
        warning: 'warning',
        critical: 'error',
      };
      if (state === 'critical' || state === 'warning') {
        push({
          severity: severityMap[state],
          title: state === 'critical' ? 'Critical database issue' : 'Database health changed',
          message:
            state === 'critical'
              ? `${healthReport.issueCounts.critical} critical issue(s) detected on ${activeConn.name}.`
              : `${healthReport.issueCounts.warning} warning(s) on ${activeConn.name}.`,
          actionLabel: 'View',
          onAction: () => setTab('diagnose'),
        });
      } else if (state === 'healthy') {
        push({
          severity: 'success',
          title: 'Database is healthy',
          message: `${activeConn.name} has no detected issues.`,
        });
      }
    }
    lastSeverityRef.current = state;
  }, [healthReport, activeConn]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!activeConn) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#06090e]">
        <div className="text-center max-w-sm">
          <DatabaseIcon className="w-12 h-12 text-slate-700 mx-auto mb-3" />
          <h2 className="text-sm font-semibold text-slate-300">No connection selected</h2>
          <p className="text-xs text-slate-500 mt-1">
            Select a database connection in the Explorer to view its health, diagnostics, and monitoring.
          </p>
        </div>
      </div>
    );
  }

  const healthState = healthReport ? deriveHealthState(healthReport.issueCounts) : 'healthy';
  const hsStyle = HEALTH_STATE_STYLES[healthState];
  const repairableCount = diagnostics.filter((d) => d.canAutoRepair).length;

  // Repair/Monitoring are hidden — not shown as a dead "not available"
  // panel — for engines that don't support maintenance actions or live
  // connection/activity stats yet (see `healthCapabilities.ts`).
  const allTabs: { id: HealthTab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number; capability?: HealthCapability }[] = [
    { id: 'overview', label: 'Overview', icon: Activity },
    { id: 'diagnose', label: 'Diagnose', icon: Stethoscope, badge: healthReport?.issueCounts.critical || undefined },
    { id: 'repair', label: 'Repair', icon: Wrench, badge: repairableCount || undefined, capability: 'maintenance' },
    { id: 'monitoring', label: 'Monitoring', icon: LineChart, capability: 'connections' },
  ];
  const tabs = allTabs.filter((t) => !t.capability || hasHealthCapability(activeConn.engine, t.capability));

  return (
    <div className="flex-1 flex flex-col bg-[#06090e] overflow-hidden">
      {/* Header */}
      <div className="border-b border-[#1e293b] px-5 py-3 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[#141e33] border border-[#1e293b] flex items-center justify-center shrink-0">
            <EngineIcon engine={activeConn.engine} className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-slate-100 truncate">{activeConn.name}</span>
              <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold', hsStyle.text)}>
                <span className={cn('w-1.5 h-1.5 rounded-full', hsStyle.dot)} />
                {hsStyle.label}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {overview?.engine} {overview?.version ? `· ${overview.version}` : ''}
              {overview?.databaseName ? ` · ${overview.databaseName}` : ''}
            </div>
          </div>
        </div>

        {/* Connection selector */}
        <select
          value={activeConnectionId ?? ''}
          onChange={(e) => {
            setActiveConnection(e.target.value);
            setTab('overview');
          }}
          className="bg-[#0f172a] border border-[#1e293b] rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-cyan-500/50 max-w-[200px]"
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 px-4 border-b border-[#1e293b] bg-[#0a0f18] shrink-0">
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors',
                isActive
                  ? 'border-cyan-400 text-cyan-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              {t.badge != null && t.badge > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400 text-[9px] font-bold">
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {lastError && (
          <div className="mx-5 mt-4">
            <CopyableErrorBanner message={lastError} tone="rose" compact parseAsDbError />
          </div>
        )}
        {tab === 'overview' && <OverviewPanel />}
        {tab === 'diagnose' && <DiagnosePanel />}
        {tab === 'repair' && <RepairCenter onJumpToDiagnostics={() => setTab('diagnose')} />}
        {tab === 'monitoring' && <MonitoringPanel />}
        {tab === 'overview' && <RepairHistory connectionId={activeConn.id} />}
      </div>
    </div>
  );
};
