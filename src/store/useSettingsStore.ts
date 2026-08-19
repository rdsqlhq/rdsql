import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { encryptSecret } from '../core/storage/secrets';
import { EMPTY_AI_CONFIG, type AIConfig, type AIProvider } from '../core/ai/types';

/**
 * Application settings store — persisted, versioned. Backs the Settings view's
 * real (no longer placeholder) inputs.
 *
 * NOTE: `rowLimit` and `execTimeoutSec` are stored here and surfaced in the UI,
 * but the query executor does not yet read them — wiring them into
 * `execute_query` is a follow-up. `s3PreviewMaxBytes` IS consumed today (by the
 * StorageFileViewer, via the StorageBrowser's preview pane).
 *
 * AI config: `ai.apiKey` is stored SEALED (encrypted with the per-device KEK,
 * same pattern as S3 secret keys). It persists safely because the value in
 * localStorage is ciphertext. Plaintext only exists transiently in the AI
 * client during a request.
 */
interface SettingsState {
  /** Max rows returned by a SELECT (UI control; not yet enforced by executor). */
  rowLimit: number;
  /** Query execution timeout in seconds (UI control; not yet enforced). */
  execTimeoutSec: number;
  /** Max bytes fetched for in-app S3 file preview. Larger files refuse preview. */
  s3PreviewMaxBytes: number;

  /** Show system schemas (Postgres: pg_catalog/information_schema; MySQL:
   *  information_schema/mysql/performance_schema/sys) in the Explorer tree.
   *  Off by default — same convention as DBeaver/pgAdmin/TablePlus. Threaded
   *  through as `includeSystemSchemas` on the `fetch_schema_tree` call rather
   *  than stored per-connection, so flipping it applies to every connection
   *  immediately on next tree refresh. */
  showSystemSchemas: boolean;

  /** Show the row-count badge next to each table in the Explorer tree (and
   *  fold into the schema/database header's aggregate tooltip). On by
   *  default — same visibility as before this was made toggleable; turning
   *  it off trims a bit of width/noise from a tree with many tables. */
  showRowCounts: boolean;
  /** Show the size badge next to each table (and the schema/database
   *  header's aggregate size badge) in the Explorer tree. On by default. */
  showTableSizes: boolean;

  /** Show the global SQL log panel at the bottom of the workspace. When off,
   *  the panel never renders (not even the collapsed strip) until re-enabled
   *  from Settings. The per-session collapse toggle in the workspace store is
   *  a separate, finer-grained control. */
  showGlobalLogs: boolean;
  /** Apply SQL syntax color-coding to log entries (keywords, strings, numbers,
   *  comments). Off = plain monochrome text, which is lighter to render. */
  sqlLogColorCoding: boolean;
  /** Show the full query text in each log entry instead of a truncated/clamped
   *  preview. Long entries wrap inside the panel. */
  sqlLogFullText: boolean;

  /** Opt-in, anonymous, aggregate usage analytics (e.g. which DB/S3 engines
   *  people connect to) — currently defaulted ON for testing (see the
   *  website's privacy copy, which still says "off by default" — these are
   *  now out of sync and should be reconciled before a real release).
   *  See src/core/analytics/. Checked
   *  fresh on every `track()` call, so toggling this off takes effect
   *  immediately, not just for future sessions. */
  analyticsEnabled: boolean;

  /** AI Database Assistant configuration. `apiKey` is stored sealed. */
  ai: AIConfig;

  setRowLimit: (n: number) => void;
  setExecTimeoutSec: (n: number) => void;
  setS3PreviewMaxBytes: (n: number) => void;
  setShowSystemSchemas: (v: boolean) => void;
  setShowRowCounts: (v: boolean) => void;
  setShowTableSizes: (v: boolean) => void;
  setShowGlobalLogs: (v: boolean) => void;
  setSqlLogColorCoding: (v: boolean) => void;
  setSqlLogFullText: (v: boolean) => void;
  setAnalyticsEnabled: (v: boolean) => void;
  /** Update part of the AI config. When `apiKey` is supplied it is sealed
   *  (encrypted) before storage; pass `''` to clear. Provider/model/baseUrl
   *  are stored as-is. `enabled` auto-flips to true when a key + model land. */
  setAIConfig: (partial: Partial<Omit<AIConfig, 'apiKey'>> & { apiKey?: string }) => Promise<void>;
}

const FIVE_MB = 5 * 1024 * 1024;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      rowLimit: 1000,
      execTimeoutSec: 30,
      s3PreviewMaxBytes: FIVE_MB,
      showSystemSchemas: false,
      showRowCounts: true,
      showTableSizes: true,
      showGlobalLogs: true,
      sqlLogColorCoding: true,
      sqlLogFullText: true,
      analyticsEnabled: true,
      ai: { ...EMPTY_AI_CONFIG },

      setRowLimit: (n) => set({ rowLimit: clampPositive(n, 1000) }),
      setExecTimeoutSec: (n) => set({ execTimeoutSec: clampPositive(n, 30) }),
      setS3PreviewMaxBytes: (n) => set({ s3PreviewMaxBytes: clampPositive(n, FIVE_MB) }),
      setShowSystemSchemas: (v) => set({ showSystemSchemas: v }),
      setShowRowCounts: (v) => set({ showRowCounts: v }),
      setShowTableSizes: (v) => set({ showTableSizes: v }),
      setShowGlobalLogs: (v) => set({ showGlobalLogs: v }),
      setSqlLogColorCoding: (v) => set({ sqlLogColorCoding: v }),
      setSqlLogFullText: (v) => set({ sqlLogFullText: v }),
      setAnalyticsEnabled: (v) => set({ analyticsEnabled: v }),

      setAIConfig: async (partial) => {
        const current = get().ai;
        // Seal the API key when it's being updated. Empty string clears it.
        let apiKey = current.apiKey;
        if (partial.apiKey !== undefined) {
          apiKey = partial.apiKey ? await encryptSecret(partial.apiKey) : '';
        }
        const next: AIConfig = {
          ...current,
          ...partial,
          apiKey,
          // Drop the plaintext-ish apiKey field we just handled so the spread
          // above doesn't overwrite the sealed value.
        };
        // Auto-enable once a key + model are both present.
        next.enabled = !!(next.apiKey && next.model);
        set({ ai: next });
      },
    }),
    {
      name: 'rdsql_settings_v1',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** Clamp to a positive integer with a fallback. */
function clampPositive(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
