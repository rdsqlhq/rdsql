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

export const useSyncStore = create<SyncState>((set, get) => ({
  status: 'idle',
  lastSyncedAt: null,
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
      set({
        status: 'synced',
        lastSyncedAt: new Date().toISOString(),
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
