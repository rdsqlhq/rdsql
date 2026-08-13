import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { S3ConnectionConfig } from '../core/storage/domain/types';

/**
 * Storage connections store.
 *
 * Mirrors `useConnectionStore`: Zustand + persist + createJSONStorage on
 * localStorage, under a versioned `rdsql_*` key, with `partialize` whitelisting
 * exactly what is persisted. The `secretAccessKey` / optional `sessionToken`
 * fields ARE persisted — but as AES-256-GCM ciphertext (see
 * `core/storage/secrets`). `partialize` therefore keeps them in the snapshot
 * (they are already sealed) rather than dropping them.
 *
 * S3 is opt-in: the store ships empty. The app starts normally with no storage
 * connections configured.
 */
interface StorageState {
  connections: S3ConnectionConfig[];
  /** Currently selected connection id for the browser, or null. */
  activeConnectionId: string | null;
  /** Navigation target requested from Analytics (prefix and optional selected file key). */
  navTarget: { connectionId: string; prefix: string; selectedKey?: string } | null;

  // Actions
  setActiveConnection: (id: string | null) => void;
  setNavTarget: (target: { connectionId: string; prefix: string; selectedKey?: string } | null) => void;
  /** Upsert a connection by id. The caller is responsible for sealing the
   *  secret before calling (see `encryptSecret` / `withDecryptedSecret`). The
   *  `UNCHANGED_SECRET` sentinel on edit keeps the existing ciphertext. */
  saveConnection: (conn: S3ConnectionConfig) => void;
  deleteConnection: (id: string) => void;
  getConnection: (id: string) => S3ConnectionConfig | undefined;
  /** Set or clear the tag on a storage connection. Mirrors
   *  `useConnectionStore.setConnectionTag` so storage rows can be grouped into
   *  the same tag folders as DB connections in the Explorer. Pass null to clear. */
  setConnectionTag: (connId: string, tagId: string | null) => void;
  /** Alias of `setConnectionTag` used by the Explorer drag-drop handler. */
  moveConnection: (connId: string, tagId: string | null) => void;
  /** Null-out a tag id on every storage connection referencing it (called when
   *  a tag is deleted, mirroring `clearTagFromAll` on the DB connection store). */
  clearTagFromAll: (tagId: string) => void;
}

export const useStorageStore = create<StorageState>()(
  persist(
    (set, get) => ({
      connections: [],
      activeConnectionId: null,
      navTarget: null,

      setActiveConnection: (id) => set({ activeConnectionId: id }),
      setNavTarget: (target) => set({ navTarget: target }),

      saveConnection: (conn) =>
        set((state) => {
          const idx = state.connections.findIndex((c) => c.id === conn.id);
          if (idx === -1) {
            return { connections: [...state.connections, conn] };
          }
          // Edit: honor the UNCHANGED_SECRET sentinel by copying the existing
          // ciphertext through, so an edit that leaves the masked secret field
          // alone never clobbers the stored secret with the sentinel string.
          const existing = state.connections[idx];
          const merged: S3ConnectionConfig = {
            ...conn,
            secretAccessKey:
              conn.secretAccessKey === '<<unchanged>>'
                ? existing.secretAccessKey
                : conn.secretAccessKey,
            sessionToken:
              conn.sessionToken === '<<unchanged>>'
                ? existing.sessionToken
                : conn.sessionToken,
          };
          const next = [...state.connections];
          next[idx] = merged;
          return { connections: next };
        }),

      deleteConnection: (id) =>
        set((state) => ({
          connections: state.connections.filter((c) => c.id !== id),
          activeConnectionId:
            state.activeConnectionId === id ? null : state.activeConnectionId,
        })),

      getConnection: (id) => get().connections.find((c) => c.id === id),

      setConnectionTag: (connId, tagId) =>
        set((state) => ({
          connections: state.connections.map((c) =>
            c.id === connId ? { ...c, tagId: tagId ?? null } : c,
          ),
        })),

      moveConnection: (connId, tagId) => {
        get().setConnectionTag(connId, tagId);
      },

      clearTagFromAll: (tagId) =>
        set((state) => ({
          connections: state.connections.map((c) =>
            c.tagId === tagId ? { ...c, tagId: null } : c,
          ),
        })),
    }),
    {
      name: 'rdsql_storage_v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        connections: state.connections,
        activeConnectionId: state.activeConnectionId,
      }),
    },
  ),
);
