import React, { useEffect } from 'react';
import { ShieldCheck, CheckCircle2, ZoomIn, Clock, Activity, Wifi } from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useHealthStore } from '../../store/useHealthStore';
import { formatUptime } from '../../core/domain/health';
import { EngineIcon } from '../common/EngineIcon';
import { useAppVersion } from '../../core/hooks/useAppVersion';

/** Extract a short version string from the full version() output.
 *  e.g. "PostgreSQL 16.2 on x86_64..." → "16.2"
 *       "8.0.36-commercial" → "8.0.36"
 *       "10.21.3-MariaDB" → "10.21.3" */
function shortVersion(version?: string): string | null {
  if (!version) return null;
  const m = version.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

export const StatusBar: React.FC = () => {
  const { connections, activeConnectionId } = useConnectionStore();
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const { zoomLevel, resetZoom } = useWorkspaceStore();
  const { overview, refreshOverview, connStatus, pingConnection, resetConnStatus } = useHealthStore();
  const version = useAppVersion();

  // Poll the active connection every 30s: `pingConnection` (test_connection)
  // drives the connected/disconnected status dot for every engine, and
  // `refreshOverview` fetches server time / uptime / latency / version —
  // both work uniformly across every engine now that Health has real
  // Mongo/Redis overview providers (`health::metrics::overview_mongo`/
  // `overview_redis`).
  useEffect(() => {
    if (!activeConn) {
      resetConnStatus();
      return;
    }
    pingConnection(activeConn);
    refreshOverview(activeConn);

    const interval = setInterval(() => {
      pingConnection(activeConn);
      refreshOverview(activeConn);
    }, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId]);

  const statusColor =
    connStatus === 'connected' ? 'bg-emerald-400' :
    connStatus === 'disconnected' ? 'bg-red-400' :
    'bg-slate-500';

  const statusLabel =
    connStatus === 'connected' ? (overview?.connectionStatus || 'Connected') :
    connStatus === 'disconnected' ? 'Disconnected' :
    'Idle';

  const dbVersion = shortVersion(overview?.version);

  return (
    <footer className="h-6 bg-[#06090e] border-t border-[#1e293b] px-3 flex items-center justify-between text-[11px] text-slate-400 select-none">
      {/* Left connection info */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${statusColor} ${connStatus === 'connected' ? 'animate-pulse' : ''}`} />
          <span className="text-slate-200 font-medium">{activeConn?.name || 'No Active Connection'}</span>
        </div>

        {activeConn && (
          <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
            <EngineIcon engine={activeConn.engine} className="w-3 h-3 shrink-0" />
            <span>{activeConn.host || activeConn.filePath}</span>
            {dbVersion && (
              <span className="text-slate-400" title={overview?.version}>v{dbVersion}</span>
            )}
            {overview?.latencyMs != null && (
              <span className="text-slate-500">{overview.latencyMs}ms</span>
            )}
          </div>
        )}
      </div>

      {/* Center — server metrics */}
      <div className="hidden lg:flex items-center gap-4 text-[10px] font-mono text-slate-500">
        {/* Connection status */}
        <div className="flex items-center gap-1" title={`Status: ${statusLabel}`}>
          <Wifi className={`w-3 h-3 ${connStatus === 'connected' ? 'text-emerald-400' : connStatus === 'disconnected' ? 'text-red-400' : 'text-slate-600'}`} />
          <span>{statusLabel}</span>
        </div>

        {/* Server time */}
        {overview?.serverTime && (
          <div className="flex items-center gap-1" title="Server time">
            <Clock className="w-3 h-3 text-slate-500" />
            <span>{overview.serverTime.replace('T', ' ').slice(0, 19)}</span>
          </div>
        )}

        {/* Uptime */}
        {overview?.uptimeSeconds != null && overview.uptimeSeconds > 0 && (
          <div className="flex items-center gap-1" title="Server uptime">
            <Activity className="w-3 h-3 text-slate-500" />
            <span>up {formatUptime(overview.uptimeSeconds)}</span>
          </div>
        )}
      </div>

      {/* Right system info */}
      <div className="flex items-center gap-4 text-[10px] font-mono text-slate-500">
        <button
          onClick={resetZoom}
          title="Reset Zoom (⌘0)"
          className={`flex items-center gap-1 transition-colors ${zoomLevel !== 1 ? 'text-blue-400 hover:text-blue-300' : 'hover:text-slate-300'}`}
        >
          <ZoomIn className="w-3 h-3" />
          <span>{Math.round(zoomLevel * 100)}%</span>
        </button>

        <div className="hidden sm:flex items-center gap-1">
          <ShieldCheck className="w-3 h-3 text-cyan-400" />
          <span>AES-256</span>
        </div>

        <div className="hidden sm:flex items-center gap-1 text-emerald-400">
          <CheckCircle2 className="w-3 h-3" />
          <span>v{version}</span>
        </div>
      </div>
    </footer>
  );
};
