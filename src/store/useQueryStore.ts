import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** Where a logged query originated. Drives the "Show system queries" filter in
 *  the SQL log panel: editor/table entries are always shown; the rest (DDL,
 *  backup/restore, maintenance) are "system" and hidden unless the user opts in. */
export type QuerySource =
  | 'editor' // SQL editor Run / single-statement refresh
  | 'table' // editable grid INSERT/UPDATE/DELETE
  | 'ddl' // structure editor, create-table, maintenance ops
  | 'explorer' // Explorer context-menu table/db actions
  | 'backup'
  | 'restore'
  | 'database' // CREATE DATABASE
  | 'system'; // pagination COUNT/SELECT, ANALYZE, GRANT, etc. (captured at IPC layer)

/** Entries whose source is considered "user-facing data" — always shown in the
 *  log regardless of the system-queries toggle. Everything else is hidden by
 *  default to keep the log focused on what the user typed/routed. */
const USER_FACING_SOURCES: ReadonlySet<QuerySource> = new Set(['editor', 'table']);

export function isUserFacingQuery(source?: QuerySource): boolean {
  return !!source && USER_FACING_SOURCES.has(source);
}

export interface QueryLogEntry {
  id: string;
  sql: string;
  database?: string;
  engine?: string;
  /** The connection this entry ran against, when known — lets a connection-
   *  scoped view (e.g. the Redis key browser's log panel) filter to just its
   *  own activity instead of the global cross-connection stream. Older
   *  entries and non-tagged sources leave this `undefined`. */
  connectionId?: string;
  executedAt: string;
  durationMs: number;
  rowsAffected: number;
  status: 'success' | 'error';
  errorMessage?: string;
  /** Origin of the query. Older persisted entries may omit this; treat a
   *  missing value as a user-facing query so the log isn't empty on upgrade. */
  source?: QuerySource;
}

/** Maximum number of log entries kept. Without this cap, a large backup/restore
 *  (hundreds of INSERT statements) fills localStorage past its ~5MB quota,
 *  causing a QuotaExceededError that blocks the UI thread. */
const MAX_LOGS = 200;

interface QueryLogState {
  logs: QueryLogEntry[];
  addLog: (entry: Omit<QueryLogEntry, 'id' | 'executedAt'>) => void;
  clearLogs: () => void;
}

/** A storage wrapper that silently swallows QuotaExceededError so a full
 *  localStorage doesn't crash the app or block the event loop during backup. */
const safeStorage = {
  getItem: (name: string) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // QuotaExceededError — localStorage is full. The in-memory state is still
      // correct; only persistence is skipped. This is non-fatal.
    }
  },
  removeItem: (name: string) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
};

export const useQueryLogStore = create<QueryLogState>()(
  persist(
    (set) => ({
      logs: [],
      addLog: (entry) =>
        set((state) => ({
          logs: [
            {
              ...entry,
              id: `log_${Date.now()}`,
              executedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            },
            ...state.logs,
          ].slice(0, MAX_LOGS),
        })),
      clearLogs: () => set({ logs: [] }),
    }),
    {
      name: 'rdsql_query_logs_v1',
      storage: createJSONStorage(() => safeStorage),
    }
  )
);
