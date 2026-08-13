import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { RepairResult } from '../core/domain/health';

/** One entry in the local repair history. Deliberately contains NO credentials —
 *  only operational metadata about what was repaired. */
export interface RepairHistoryEntry {
  timestampMs: number;
  connectionId: string;
  connectionName: string;
  engine: string;
  operation: string;
  sql: string[];
  affectedObjects: string[];
  durationMs: number;
  result: 'success' | 'error';
  errorMessage?: string;
  verification?: string;
}

interface RepairHistoryState {
  entries: RepairHistoryEntry[];

  /** Append a repair outcome to the history. */
  addEntry: (entry: RepairHistoryEntry) => void;
  /** Entries filtered to a specific connection. */
  forConnection: (connectionId: string) => RepairHistoryEntry[];
  /** Clear all history. */
  clear: () => void;
  /** Cap the log so localStorage never grows unbounded. */
  trim: (max: number) => void;
}

const MAX_ENTRIES = 500;

export const useRepairHistoryStore = create<RepairHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      addEntry: (entry) =>
        set((state) => {
          const next = [entry, ...state.entries];
          // Keep the log bounded.
          return { entries: next.slice(0, MAX_ENTRIES) };
        }),

      forConnection: (connectionId) =>
        get().entries.filter((e) => e.connectionId === connectionId),

      clear: () => set({ entries: [] }),
      trim: (max) =>
        set((state) => ({ entries: state.entries.slice(0, Math.max(0, max)) })),
    }),
    {
      name: 'rdsql_repair_history_v1',
      storage: createJSONStorage(() => localStorage),
    }
  )
);

/** Build a history entry from a repair result + context. Pure helper (unit-tested). */
export function buildHistoryEntry(args: {
  connectionId: string;
  connectionName: string;
  engine: string;
  operation: string;
  affectedObjects: string[];
  result: RepairResult;
}): RepairHistoryEntry {
  return {
    timestampMs: Date.now(),
    connectionId: args.connectionId,
    connectionName: args.connectionName,
    engine: args.engine,
    operation: args.operation,
    sql: args.result.executedSql,
    affectedObjects: args.affectedObjects,
    durationMs: args.result.durationMs,
    result: args.result.success ? 'success' : 'error',
    errorMessage: args.result.error,
    verification: args.result.verification,
  };
}
