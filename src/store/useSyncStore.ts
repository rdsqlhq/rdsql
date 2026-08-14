import { create } from 'zustand';
import { ensureSyncKey } from '../core/sync/credentialCrypto';
import { pushAllConnections, pullAllChanges, resolveConflictKeepLocal, resolveConflictKeepRemote } from '../core/sync/connectionSync';

interface SyncConflict {
  id: string;
  name: string;
}

interface SyncState {
  status: 'idle' | 'checking-key' | 'syncing' | 'synced' | 'error';
  lastSyncedAt: string | null;
  error: string | null;
  conflicts: SyncConflict[];

  checkKeySetup: () => Promise<void>;
  syncNow: () => Promise<void>;
  dismissConflicts: () => void;
  keepLocal: (connectionId: string) => Promise<void>;
  keepRemote: (connectionId: string) => Promise<void>;
}

// Persisted (not just in-memory) so "Last synced …" survives an app
// restart instead of going blank every launch even though sync genuinely
// ran moments before quitting. Same account-scoping caveat as
// connectionSync.ts's version/cursor keys — see resetLocalSyncDisplayState
// below, called from useAuthStore.signOut().
const LAST_SYNCED_KEY = 'rdsql_sync_last_synced_at_v1';

export function resetLocalSyncDisplayState(): void {
  localStorage.removeItem(LAST_SYNCED_KEY);
  useSyncStore.setState({ lastSyncedAt: null, status: 'idle', error: null, conflicts: [] });
}

export const useSyncStore = create<SyncState>((set, get) => ({
  status: 'idle',
  lastSyncedAt: localStorage.getItem(LAST_SYNCED_KEY),
  error: null,
  conflicts: [],

  // No user-facing passphrase step: the first device to reach here generates
  // its own key silently; additional devices receive it via pairing instead
  // (see useAuthStore.redeemPairingCode / createPairingCode).
  checkKeySetup: async () => {
    set({ status: 'checking-key' });
    await ensureSyncKey().catch(() => undefined);
    set({ status: 'idle' });
  },

  syncNow: async () => {
    set({ status: 'syncing', error: null, conflicts: [] });
    try {
      const { conflicts } = await pushAllConnections();
      await pullAllChanges();
      const now = new Date().toISOString();
      localStorage.setItem(LAST_SYNCED_KEY, now);
      set({
        status: 'synced',
        lastSyncedAt: now,
        conflicts,
      });
      if (conflicts.length === 0) {
        // Settle back to idle shortly after showing "synced" — matches the
        // Toggle/save-flash pattern used elsewhere in Settings.
        setTimeout(() => {
          if (get().status === 'synced') set({ status: 'idle' });
        }, 3000);
      }
    } catch (err: any) {
      set({ status: 'error', error: err?.message || String(err) });
    }
  },

  dismissConflicts: () => set({ conflicts: [] }),

  keepLocal: async (connectionId) => {
    try {
      await resolveConflictKeepLocal(connectionId);
      set((s) => ({ conflicts: s.conflicts.filter((c) => c.id !== connectionId), status: 'idle', error: null }));
    } catch (err: any) {
      set({ status: 'error', error: err?.message || String(err) });
    }
  },

  keepRemote: async (connectionId) => {
    try {
      await resolveConflictKeepRemote(connectionId);
      set((s) => ({ conflicts: s.conflicts.filter((c) => c.id !== connectionId), status: 'idle', error: null }));
    } catch (err: any) {
      set({ status: 'error', error: err?.message || String(err) });
    }
  },
}));
