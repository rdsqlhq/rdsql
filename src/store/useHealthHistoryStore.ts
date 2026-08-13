import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DatabaseStatistics, MetricSample } from '../core/domain/health';

/** Lightweight, append-only time series of monitoring metrics per connection.
 *  Sampled client-side by the auto-refresh timer. Bounded per connection so
 *  localStorage stays small. */
interface HealthHistoryState {
  /** connectionId → metric key → samples (newest last). */
  series: Record<string, Partial<Record<MetricKey, MetricSample[]>>>;

  /** Append a sample (dedupes within the same window to avoid noise). */
  append: (connectionId: string, key: MetricKey, sample: MetricSample) => void;
  /** Record a snapshot of all supported metrics from a statistics fetch. */
  recordSnapshot: (connectionId: string, stats: DatabaseStatistics) => void;
  /** Get the series for a connection+metric. */
  get: (connectionId: string, key: MetricKey) => MetricSample[];
  /** Clear history for a connection (or all). */
  clear: (connectionId?: string) => void;
}

export type MetricKey =
  | 'sizeBytes'
  | 'connectionCount'
  | 'activeQueries'
  | 'lockCount'
  | 'longRunningQueries'
  | 'cacheHitRatio';

const MAX_SAMPLES_PER_SERIES = 288; // ~24h at a 5-min cadence
const SAMPLE_DEDUP_MS = 30_000; // collapse samples within the same 30s window

const METRIC_KEYS: MetricKey[] = [
  'sizeBytes',
  'connectionCount',
  'activeQueries',
  'lockCount',
  'longRunningQueries',
  'cacheHitRatio',
];

export const useHealthHistoryStore = create<HealthHistoryState>()(
  persist(
    (set, get) => ({
      series: {},

      append: (connectionId, key, sample) =>
        set((state) => {
          const connSeries = { ...(state.series[connectionId] ?? {}) };
          const existing = connSeries[key] ?? [];
          // Dedup: skip if the last sample is within SAMPLE_DEDUP_MS.
          if (existing.length > 0) {
            const last = existing[existing.length - 1];
            if (sample.timestampMs - last.timestampMs < SAMPLE_DEDUP_MS) {
              return state;
            }
          }
          const next = [...existing, sample].slice(-MAX_SAMPLES_PER_SERIES);
          return {
            series: { ...state.series, [connectionId]: { ...connSeries, [key]: next } },
          };
        }),

      recordSnapshot: (connectionId, stats) => {
        const now = Date.now();
        const values: Partial<Record<MetricKey, number>> = {
          sizeBytes: stats.sizeBytes,
          connectionCount: stats.connectionCount,
          activeQueries: stats.activeQueries,
          lockCount: stats.lockCount,
          longRunningQueries: stats.longRunningQueries,
          cacheHitRatio:
            stats.cacheHitRatio != null
              ? Math.round(stats.cacheHitRatio * 1000) / 10 // 0–1000 → percent w/ 1 decimal
              : undefined,
        };
        for (const key of METRIC_KEYS) {
          const v = values[key];
          if (v != null && !Number.isNaN(v)) {
            get().append(connectionId, key, { timestampMs: now, value: v });
          }
        }
      },

      get: (connectionId, key) => get().series[connectionId]?.[key] ?? [],

      clear: (connectionId) =>
        set((state) => {
          if (!connectionId) return { series: {} };
          const next = { ...state.series };
          delete next[connectionId];
          return { series: next };
        }),
    }),
    {
      name: 'rdsql_health_history_v1',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
