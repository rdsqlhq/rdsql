import { create } from 'zustand';
import { safeInvoke } from '../core/tauri/ipc';
import {
  ActivitySnapshot,
  DatabaseOverview,
  DatabaseStatistics,
  DiagnosticOptions,
  DiagnosticResult,
  HealthReport,
  IndexStat,
  RepairPlan,
  RepairRequest,
  RepairResult,
  TableStat,
  computeHealthScore,
} from '../core/domain/health';
import type { DatabaseConnection } from '../core/domain/types';
import { resolveTargetDatabase } from '../core/sql/ident';
import { useConnectionStore } from './useConnectionStore';
import { pushDedupedToast } from './useToastStore';

/** MySQL/MariaDB connections can browse many databases from one connection —
 *  the Explorer tracks which one is currently active in `activeDatabaseByConn`,
 *  separate from the connection's own (often empty) `database` field. Every
 *  other consumer (SQL editor, table view, result grid) resolves this before
 *  hitting the backend; the health module must too, or MySQL health checks
 *  silently scope to `DATABASE() IS NULL` and come back empty — showing only
 *  bare connection info with no table/index/stat data. */
function withActiveDatabase(conn: DatabaseConnection): DatabaseConnection {
  const activeDb = useConnectionStore.getState().activeDatabaseByConn[conn.id];
  const target = resolveTargetDatabase(conn.engine, conn.database, activeDb);
  return target && target !== conn.database ? { ...conn, database: target } : conn;
}

/** Per-connection health state. Keyed by connectionId so switching connections
 *  doesn't lose cached results. Volatile (not persisted). */
interface HealthState {
  // The connection the health view is currently scoped to.
  activeConnectionId: string | null;
  setActiveConnection: (id: string | null) => void;

  // Live reachability of the connection StatusBar/Explorer are currently
  // polling. Driven by `test_connection` (not `get_database_overview`) so it
  // works uniformly across every engine — including Mongo/Redis, which have
  // no `engine_family()` arm on the backend and would otherwise be
  // misjudged via the SQL-only overview call. 'idle' = not polling anything
  // yet (no active connection, or first ping still in flight).
  connStatus: 'connected' | 'idle' | 'disconnected';
  pingConnection: (conn: DatabaseConnection) => Promise<void>;
  resetConnStatus: () => void;

  overview: DatabaseOverview | null;
  statistics: DatabaseStatistics | null;
  diagnostics: DiagnosticResult[];
  healthReport: HealthReport | null;
  activity: ActivitySnapshot | null;
  tableStats: Record<string, TableStat>;
  indexStats: IndexStat[];

  loadingOverview: boolean;
  loadingStatistics: boolean;
  loadingDiagnostics: boolean;
  loadingActivity: boolean;
  lastDiagnosticTime: number | null;
  lastMaintenanceTime: number | null;
  lastError: string | null;

  refreshOverview: (conn: DatabaseConnection) => Promise<void>;
  refreshStatistics: (conn: DatabaseConnection) => Promise<void>;
  runDiagnostics: (conn: DatabaseConnection, opts?: DiagnosticOptions) => Promise<DiagnosticResult[]>;
  refreshActivity: (conn: DatabaseConnection) => Promise<void>;
  loadTableStats: (conn: DatabaseConnection, schema: string | undefined, table: string) => Promise<void>;
  loadIndexStats: (conn: DatabaseConnection, schema: string | undefined, table?: string) => Promise<void>;

  previewRepair: (conn: DatabaseConnection, request: RepairRequest) => Promise<RepairPlan>;
  executeRepair: (conn: DatabaseConnection, plan: RepairPlan) => Promise<RepairResult>;

  clear: () => void;
}

export const useHealthStore = create<HealthState>((set, get) => ({
  activeConnectionId: null,
  setActiveConnection: (id) => set({ activeConnectionId: id }),

  connStatus: 'idle',
  resetConnStatus: () => set({ connStatus: 'idle' }),
  pingConnection: async (conn) => {
    let result: { success: boolean; message: string } | null = null;
    try {
      result = await safeInvoke<{ success: boolean; message: string }>('test_connection', { config: conn });
    } catch (err: any) {
      result = { success: false, message: err?.message ?? String(err) };
    }
    const wasDisconnected = get().connStatus === 'disconnected';
    if (result.success) {
      set({ connStatus: 'connected' });
      return;
    }
    set({ connStatus: 'disconnected' });
    // Only toast on the connected/idle → disconnected transition, not on
    // every 30s poll while an outage continues — otherwise a prolonged
    // outage floods the toast stack.
    if (!wasDisconnected) {
      pushDedupedToast(`conn-offline-${conn.id}`, {
        severity: 'error',
        title: `${conn.name} is offline`,
        message: result.message || 'Lost connection to the database.',
      });
    }
  },

  overview: null,
  statistics: null,
  diagnostics: [],
  healthReport: null,
  activity: null,
  tableStats: {},
  indexStats: [],

  loadingOverview: false,
  loadingStatistics: false,
  loadingDiagnostics: false,
  loadingActivity: false,
  lastDiagnosticTime: null,
  lastMaintenanceTime: null,
  lastError: null,

  refreshOverview: async (conn) => {
    set({ loadingOverview: true, lastError: null });
    try {
      const lastDiagnosticTime = get().lastDiagnosticTime ?? undefined;
      const lastMaintenanceTime = get().lastMaintenanceTime ?? undefined;
      const overview = await safeInvoke<DatabaseOverview>('get_database_overview', {
        config: withActiveDatabase(conn),
        lastDiagnosticTime,
        lastMaintenanceTime,
      });
      set({ overview, loadingOverview: false });
    } catch (err: any) {
      set({ loadingOverview: false, lastError: err?.message ?? String(err) });
    }
  },

  refreshStatistics: async (conn) => {
    set({ loadingStatistics: true, lastError: null });
    try {
      const statistics = await safeInvoke<DatabaseStatistics>('get_database_statistics', { config: withActiveDatabase(conn) });
      set({ statistics, loadingStatistics: false });
    } catch (err: any) {
      set({ loadingStatistics: false, lastError: err?.message ?? String(err) });
    }
  },

  runDiagnostics: async (conn, opts) => {
    set({ loadingDiagnostics: true, lastError: null });
    try {
      const options: DiagnosticOptions = opts ?? { heavy: true };
      const results = await safeInvoke<DiagnosticResult[]>('run_diagnostics', { config: withActiveDatabase(conn), options });
      const { score, breakdown } = computeHealthScore(results);
      const issueCounts = { info: 0, warning: 0, critical: 0 };
      for (const r of results) issueCounts[r.severity]++;
      const severity = results.find((r) => r.severity === 'critical')
        ? 'critical'
        : results.find((r) => r.severity === 'warning')
        ? 'warning'
        : 'info';
      const report: HealthReport = { score, severity, breakdown, issueCounts, results };
      const now = Date.now();
      set({
        diagnostics: results,
        healthReport: report,
        loadingDiagnostics: false,
        lastDiagnosticTime: now,
      });
      return results;
    } catch (err: any) {
      set({ loadingDiagnostics: false, lastError: err?.message ?? String(err) });
      return [];
    }
  },

  refreshActivity: async (conn) => {
    set({ loadingActivity: true, lastError: null });
    try {
      const activity = await safeInvoke<ActivitySnapshot>('get_activity', { config: withActiveDatabase(conn) });
      set({ activity, loadingActivity: false });
    } catch (err: any) {
      set({ loadingActivity: false, lastError: err?.message ?? String(err) });
    }
  },

  loadTableStats: async (conn, schema, table) => {
    try {
      const stat = await safeInvoke<TableStat>('get_table_statistics', { config: withActiveDatabase(conn), schema, table });
      set((state) => ({ tableStats: { ...state.tableStats, [table]: stat } }));
    } catch (err: any) {
      set({ lastError: err?.message ?? String(err) });
    }
  },

  loadIndexStats: async (conn, schema, table) => {
    try {
      const stats = await safeInvoke<IndexStat[]>('get_index_statistics', { config: withActiveDatabase(conn), schema, table });
      set({ indexStats: stats ?? [] });
    } catch (err: any) {
      set({ lastError: err?.message ?? String(err) });
    }
  },

  previewRepair: async (conn, request) => {
    return safeInvoke<RepairPlan>('preview_repair', { config: withActiveDatabase(conn), request });
  },

  executeRepair: async (conn, plan) => {
    const result = await safeInvoke<RepairResult>('execute_repair', { config: withActiveDatabase(conn), plan });
    if (result.success) {
      set({ lastMaintenanceTime: Date.now() });
    }
    return result;
  },

  clear: () =>
    set({
      overview: null,
      statistics: null,
      diagnostics: [],
      healthReport: null,
      activity: null,
      tableStats: {},
      indexStats: [],
      lastError: null,
      connStatus: 'idle',
    }),
}));
