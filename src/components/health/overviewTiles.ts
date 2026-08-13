/**
 * Engine-aware metric tiles for the Health Overview header.
 *
 * The top-of-page stat grid shouldn't show "Tables"/"Indexes" for Redis (no
 * such thing) or hide MongoDB's operation counters — each engine gets the
 * tile set that actually describes it, per the design spec's header mockups.
 * Everything here reads from the *same* `DatabaseOverview` payload
 * (`core/domain/health.ts`); it's the tile selection that's engine-aware, not
 * the wire type.
 */
import type { ComponentType } from 'react';
import { Table as TableIcon, Box, HardDrive, Rows3, Wrench, Clock, Database, Cpu, Zap, Percent, Users } from 'lucide-react';
import type { DatabaseOverview, HealthReport } from '../../core/domain/health';
import { isMongoEngine, isRedisEngine } from '../../core/connection/engines';
import { formatBytes, formatNumber, formatRatio } from './format';

export interface StatTileSpec {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  accent: 'blue' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'slate';
}

function sqlFamilyTiles(overview: DatabaseOverview, healthReport: HealthReport | null): StatTileSpec[] {
  return [
    { label: 'Tables', value: formatNumber(overview.tableCount), icon: TableIcon, accent: 'blue' },
    { label: 'Indexes', value: formatNumber(overview.indexCount), icon: Box, accent: 'cyan' },
    { label: 'Size', value: formatBytes(overview.sizeBytes), icon: HardDrive, accent: 'emerald' },
    { label: 'Rows', value: overview.rowCount != null ? formatNumber(overview.rowCount) : '—', icon: Rows3, accent: 'amber' },
    {
      label: 'Issues',
      value: healthReport ? formatNumber(healthReport.issueCounts.critical + healthReport.issueCounts.warning) : '—',
      icon: Wrench,
      accent: 'rose',
    },
    { label: 'Latency', value: `${overview.latencyMs} ms`, icon: Clock, accent: 'slate' },
  ];
}

function mongoTiles(overview: DatabaseOverview): StatTileSpec[] {
  return [
    { label: 'Databases', value: formatNumber(overview.schemaCount), icon: Database, accent: 'blue' },
    { label: 'Collections', value: formatNumber(overview.tableCount), icon: TableIcon, accent: 'cyan' },
    { label: 'Indexes', value: formatNumber(overview.indexCount), icon: Box, accent: 'slate' },
    { label: 'Storage', value: formatBytes(overview.sizeBytes), icon: HardDrive, accent: 'emerald' },
    { label: 'Memory', value: overview.memoryUsedBytes != null ? formatBytes(overview.memoryUsedBytes) : '—', icon: Cpu, accent: 'amber' },
    { label: 'Ops/sec', value: overview.opsPerSecond != null ? formatNumber(Math.round(overview.opsPerSecond)) : '—', icon: Zap, accent: 'rose' },
  ];
}

function redisTiles(overview: DatabaseOverview): StatTileSpec[] {
  return [
    { label: 'Clients', value: overview.connectionsCurrent != null ? formatNumber(overview.connectionsCurrent) : '—', icon: Users, accent: 'blue' },
    { label: 'Commands/sec', value: overview.opsPerSecond != null ? formatNumber(Math.round(overview.opsPerSecond)) : '—', icon: Zap, accent: 'cyan' },
    { label: 'Memory', value: overview.memoryUsedBytes != null ? formatBytes(overview.memoryUsedBytes) : '—', icon: Cpu, accent: 'amber' },
    { label: 'Hit Rate', value: formatRatio(overview.hitRatio), icon: Percent, accent: 'emerald' },
    { label: 'Keys', value: formatNumber(overview.redisInfo?.keyspace.reduce((sum, db) => sum + db.keys, 0)), icon: Box, accent: 'slate' },
    { label: 'Latency', value: `${overview.latencyMs} ms`, icon: Clock, accent: 'rose' },
  ];
}

export function getOverviewTiles(
  engine: string,
  overview: DatabaseOverview,
  healthReport: HealthReport | null
): StatTileSpec[] {
  if (isMongoEngine(engine)) return mongoTiles(overview);
  if (isRedisEngine(engine)) return redisTiles(overview);
  return sqlFamilyTiles(overview, healthReport);
}
