/**
 * Database Health, Diagnostics, Repair & Monitoring — domain types.
 *
 * These mirror the Rust wire types in `src-tauri/src/commands/health/mod.rs`
 * (both sides use `#[serde(rename_all = "camelCase")]` / camelCase TS).
 * Never put credentials in any of these structures.
 */

export type Severity = 'info' | 'warning' | 'critical';

export type DiagnosticCategory =
  | 'connection'
  | 'schema'
  | 'tables'
  | 'indexes'
  | 'constraints'
  | 'foreignKeys'
  | 'performance'
  | 'storage'
  | 'maintenance'
  | 'replication';

export type RiskLevel = 'safe' | 'dangerous';

export interface DiagnosticResult {
  id: string;
  category: DiagnosticCategory;
  severity: Severity;
  title: string;
  description: string;
  affectedObjects: string[];
  recommendation?: string;
  canAutoRepair: boolean;
  repairAction?: string;
  details?: Record<string, string>;
}

export interface DiagnosticOptions {
  heavy: boolean;
}

export interface RepairPlan {
  diagnosticId: string;
  title: string;
  sql: string[];
  affectedObjects: string[];
  riskLevel: RiskLevel;
  estimatedAffectedRows?: number;
  requiresBackup: boolean;
  verificationSql?: string;
}

export interface RepairRequest {
  diagnosticId: string;
  repairAction: string;
  affectedObjects: string[];
  details: Record<string, string>;
}

export interface RepairResult {
  diagnosticId: string;
  success: boolean;
  executedSql: string[];
  affectedRows: number;
  durationMs: number;
  error?: string;
  verification?: string;
}

export interface DatabaseOverview {
  engine: string;
  version?: string;
  databaseName?: string;
  host?: string;
  port?: number;
  connectionStatus: string;
  latencyMs: number;
  sizeBytes: number;
  schemaCount: number;
  tableCount: number;
  viewCount: number;
  indexCount: number;
  sequenceCount: number;
  constraintCount: number;
  rowCount?: number;
  lastDiagnosticTime?: number;
  lastMaintenanceTime?: number;
  /** Server uptime in seconds (MySQL/Postgres only). */
  uptimeSeconds?: number;
  /** Server-side current timestamp (ISO string, when available). */
  serverTime?: string;
  /** Resident memory in use (Mongo `serverStatus.mem.resident`, Redis `used_memory`). */
  memoryUsedBytes?: number;
  /** Configured memory cap, when the engine enforces one (Redis `maxmemory`). */
  memoryLimitBytes?: number;
  /** Live client/connection count (Mongo `connections.current`, Redis `connected_clients`). */
  connectionsCurrent?: number;
  /** Remaining connection headroom (Mongo `connections.available`). */
  connectionsAvailable?: number;
  /** Operations/commands per second, sampled as a delta between polls. */
  opsPerSecond?: number;
  /** 0.0–1.0 cache/keyspace hit ratio (Redis `keyspace_hits`/`(hits+misses)`). */
  hitRatio?: number;
  /** Redis-only: keyspace, replication, and persistence snapshot. `undefined` for every
   *  other engine — see `RedisInfo`. */
  redisInfo?: RedisInfo;
  /** SQLite-only: `PRAGMA journal_mode` (`delete`, `wal`, `memory`, …). */
  journalMode?: string;
  /** SQLite-only: `PRAGMA auto_vacuum`, mapped to its label. */
  autoVacuum?: string;
}

/** Per-logical-database key counts, parsed from Redis `INFO keyspace`. */
export interface RedisKeyspaceDb {
  dbIndex: number;
  keys: number;
  expires: number;
}

export interface RedisReplicationInfo {
  role: string;
  connectedSlaves: number;
  masterReplOffset?: number;
}

export interface RedisPersistenceInfo {
  aofEnabled: boolean;
  rdbLastSaveTime?: number;
  rdbChangesSinceLastSave?: number;
  rdbLastBgsaveStatus?: string;
  /** Only populated when `aofEnabled` is true. */
  aofCurrentSizeBytes?: number;
  aofRewriteInProgress?: boolean;
}

/** Redis `INFO memory`/`stats`/`clients` fields that don't already have a
 *  home on `DatabaseOverview` (`memoryUsedBytes`/`memoryLimitBytes`/`hitRatio`
 *  cover the shared overview tiles) — back the Memory/Performance/Clients
 *  detail sections. */
export interface RedisDetail {
  memoryRssBytes: number;
  memoryPeakBytes: number;
  memoryFragmentationRatio: number;
  blockedClients: number;
  maxClients: number;
  expiredKeys: number;
  evictedKeys: number;
  rejectedConnections: number;
}

export interface RedisInfo {
  keyspace: RedisKeyspaceDb[];
  replication: RedisReplicationInfo;
  persistence: RedisPersistenceInfo;
  detail: RedisDetail;
}

/** Format uptime seconds into a human-readable string like "3d 4h 12m". */
export function formatUptime(seconds?: number): string {
  if (!seconds || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export interface IssueCounts {
  info: number;
  warning: number;
  critical: number;
}

export interface Deduction {
  points: number;
  reason: string;
  diagnosticId: string;
}

export interface ScoreBreakdown {
  category: DiagnosticCategory;
  score: number;
  deductions: Deduction[];
}

export interface HealthReport {
  score: number;
  severity: Severity;
  breakdown: ScoreBreakdown[];
  issueCounts: IssueCounts;
  results: DiagnosticResult[];
}

export interface DatabaseStatistics {
  sizeBytes: number;
  tableCount: number;
  indexCount: number;
  rowCount?: number;
  schemaCount: number;
  connectionCount?: number;
  maxConnections?: number;
  activeQueries?: number;
  idleConnections?: number;
  transactionCount?: number;
  cacheHitRatio?: number;
  avgQueryLatencyMs?: number;
  lockCount?: number;
  blockingQueries?: number;
  longRunningQueries?: number;
  slowQueryCount?: number;
}

export interface TableStat {
  schema?: string;
  name: string;
  rowCount?: number;
  dataSizeBytes?: number;
  indexSizeBytes?: number;
  totalSizeBytes?: number;
  indexCount?: number;
  foreignKeyCount?: number;
  lastAnalyzedMs?: number;
}

export interface IndexStat {
  schema?: string;
  table: string;
  name: string;
  indexType?: string;
  columns: string[];
  sizeBytes?: number;
  scans?: number;
  reads?: number;
  writes?: number;
  status: string;
}

export interface ActivityRow {
  pid: string;
  durationLabel: string;
  durationSeconds?: number;
  state: string;
  query?: string;
}

export interface ActivitySnapshot {
  rows?: ActivityRow[];
  supported: boolean;
}

/** A single timestamped metric sample for the monitoring charts. */
export interface MetricSample {
  timestampMs: number;
  value: number;
}

// ───────────────────── Severity helpers (pure, unit-tested) ─────────────────────

/** Penalty per severity — must stay in sync with the Rust `score.rs`. */
export const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 5,
  warning: 3,
  info: 1,
};

/** Roll-up health state shown in the overview header. */
export type HealthState = 'healthy' | 'notice' | 'warning' | 'critical';

/** Map an issue-count rollup to the four-state health label. */
export function deriveHealthState(counts: IssueCounts): HealthState {
  if (counts.critical > 0) return 'critical';
  if (counts.warning > 0) return 'warning';
  if (counts.info > 0) return 'notice';
  return 'healthy';
}

/** Compute an overall health score (0–100) from a flat list of diagnostics.
 *  Pure mirror of the Rust `build_health_report` so the UI can show a quick
 *  score without an extra round-trip when it already has the diagnostics. */
export function computeHealthScore(results: DiagnosticResult[]): {
  score: number;
  breakdown: ScoreBreakdown[];
} {
  const byCategory = new Map<DiagnosticCategory, DiagnosticResult[]>();
  for (const r of results) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }
  const breakdown: ScoreBreakdown[] = [];
  let sum = 0;
  for (const [category, items] of byCategory) {
    const totalPenalty = items.reduce((acc, r) => acc + SEVERITY_PENALTY[r.severity], 0);
    const score = Math.max(0, 100 - totalPenalty);
    sum += score;
    breakdown.push({
      category,
      score,
      deductions: items.map((r) => ({
        points: SEVERITY_PENALTY[r.severity],
        reason: r.title,
        diagnosticId: r.id,
      })),
    });
  }
  const overall = breakdown.length === 0 ? 100 : Math.round(sum / breakdown.length);
  return { score: Math.min(100, overall), breakdown };
}

/** Category label for display. */
export function categoryLabel(category: DiagnosticCategory): string {
  const labels: Record<DiagnosticCategory, string> = {
    connection: 'Connection',
    schema: 'Schema',
    tables: 'Tables',
    indexes: 'Indexes',
    constraints: 'Constraints',
    foreignKeys: 'Foreign Keys',
    performance: 'Performance',
    storage: 'Storage',
    maintenance: 'Maintenance',
    replication: 'Replication',
  };
  return labels[category] ?? category;
}

/** Filter diagnostics by severity / category / free-text. Pure, unit-tested. */
export interface IssueFilter {
  severities?: Severity[];
  categories?: DiagnosticCategory[];
  search?: string;
}

export function filterDiagnostics(
  results: DiagnosticResult[],
  filter: IssueFilter
): DiagnosticResult[] {
  const search = filter.search?.trim().toLowerCase();
  return results.filter((r) => {
    if (filter.severities && filter.severities.length > 0 && !filter.severities.includes(r.severity)) {
      return false;
    }
    if (filter.categories && filter.categories.length > 0 && !filter.categories.includes(r.category)) {
      return false;
    }
    if (search) {
      const hay = [
        r.title,
        r.description,
        r.recommendation ?? '',
        r.affectedObjects.join(' '),
        categoryLabel(r.category),
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/** Classify a repair plan's risk on the client side for display badges. */
export function isDangerous(plan: RepairPlan): boolean {
  return plan.riskLevel === 'dangerous';
}
