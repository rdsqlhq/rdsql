import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DatabaseConnection, SchemaGroupNode } from '../core/domain/types';
import { safeInvoke } from '../core/tauri/ipc';
import { useSettingsStore } from './useSettingsStore';

interface ConnectionState {
  connections: DatabaseConnection[];
  activeConnectionId: string | null;
  schemaTree: SchemaGroupNode[];
  /** Per-connection schema tree cache, keyed by connection id. Populated by
   *  the Explorer when it loads a connection's tree and shared with the SQL
   *  editor's autocomplete so both always see the same fresh data. */
  schemaTreeByConn: Record<string, SchemaGroupNode[]>;
  loadingSchema: boolean;
  isConnectionModalOpen: boolean;
  editingConnection: DatabaseConnection | null;
  searchQuery: string;
  /** Per-connection currently selected database/schema. Set when the user
   *  clicks a database node in the explorer; the executor applies it as the
   *  connection's target database so unqualified queries resolve. */
  activeDatabaseByConn: Record<string, string>;
  /** Per-connection pinned database/schema names — pinned groups sort to the
   *  top of that connection's tree. Persisted preference. */
  pinnedSchemasByConn: Record<string, string[]>;
  /** Per-connection server version banner, captured whenever `test_connection`
   *  succeeds (ConnectionModal). Session-only (not persisted — could go stale
   *  across a server upgrade); used to give the AI assistant the exact engine
   *  + version instead of just the family name. */
  serverVersionByConn: Record<string, string>;

  // Actions
  setActiveConnection: (id: string | null) => void;
  setActiveDatabase: (connId: string, database: string) => void;
  setServerVersion: (connId: string, version: string) => void;
  saveConnection: (conn: DatabaseConnection) => void;
  deleteConnection: (id: string) => void;
  toggleFavorite: (id: string) => void;
  /** Pin/unpin a database or schema within a connection (sorts it to the top). */
  togglePinnedSchema: (connId: string, schema: string) => void;
  /** Clear every pin at once: unpin all connections and all pinned
   *  databases/schemas. Used by the Explorer's "Unpin All" menu action. */
  unpinAll: () => void;
  /** Per-connection "show system schemas" override (undefined = inherit global). */
  setConnectionShowSystemSchemas: (connId: string, value: boolean) => void;
  /** Assign (or clear with null) a connection's environment/group tag. */
  setConnectionTag: (connId: string, tagId: string | null) => void;
  /** Alias used by drag-and-drop — moves a connection into a folder (tag). */
  moveConnection: (connId: string, tagId: string | null) => void;
  /** Clear a tag from every connection that references it (used on tag delete). */
  clearTagFromAll: (tagId: string) => void;
  fetchSchema: (connId: string) => Promise<void>;
  /** Cache a connection's schema tree in the shared store. Called by the
   *  Explorer after fetching so the SQL editor (and anything else) reads the
   *  same live data without re-fetching. */
  setSchemaTreeForConn: (connId: string, tree: SchemaGroupNode[]) => void;
  setConnectionModalOpen: (open: boolean) => void;
  openEditConnection: (conn: DatabaseConnection) => void;
  setSearchQuery: (query: string) => void;
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set, get) => ({
      connections: [],
      activeConnectionId: null,
      schemaTree: [],
      schemaTreeByConn: {},
      loadingSchema: false,
      isConnectionModalOpen: false,
      editingConnection: null,
      searchQuery: '',
      activeDatabaseByConn: {},
      pinnedSchemasByConn: {},
      serverVersionByConn: {},

      setActiveConnection: (id) => {
        set({ activeConnectionId: id });
        if (id) {
          // Only fetch if we don't already have this connection's schema
          // cached. Without this guard, every tab switch / connection click
          // fires a fresh `fetch_schema_tree` even when the tree is already in
          // `schemaTreeByConn`, causing cascading duplicate fetches (5+ per
          // table open). The Explorer and SQLEditor both read from the shared
          // cache, so a warm cache is always authoritative.
          const state = get();
          if (!state.schemaTreeByConn[id]) {
            get().fetchSchema(id);
          } else {
            // Keep the active-connection mirror in sync from the cache so
            // legacy consumers reading `schemaTree` see the right tree.
            set({ schemaTree: state.schemaTreeByConn[id] });
          }
        } else {
          set({ schemaTree: [] });
        }
      },

      setActiveDatabase: (connId, database) => {
        set((state) => ({
          activeDatabaseByConn: { ...state.activeDatabaseByConn, [connId]: database },
        }));
      },

      setServerVersion: (connId, version) => {
        set((state) => ({
          serverVersionByConn: { ...state.serverVersionByConn, [connId]: version },
        }));
      },

      saveConnection: (conn) => {
        set((state) => {
          const exists = state.connections.some((c) => c.id === conn.id);
          const updated = exists
            ? state.connections.map((c) => (c.id === conn.id ? conn : c))
            : [conn, ...state.connections];
          return { connections: updated, activeConnectionId: conn.id };
        });
        get().fetchSchema(conn.id);
      },

      deleteConnection: (id) => {
        set((state) => {
          const remaining = state.connections.filter((c) => c.id !== id);
          const newActive = state.activeConnectionId === id ? (remaining[0]?.id || null) : state.activeConnectionId;
          return { connections: remaining, activeConnectionId: newActive };
        });
      },

      toggleFavorite: (id) => {
        set((state) => ({
          connections: state.connections.map((c) =>
            c.id === id ? { ...c, isFavorite: !c.isFavorite } : c
          ),
        }));
      },

      togglePinnedSchema: (connId, schema) => {
        set((state) => {
          const current = state.pinnedSchemasByConn[connId] || [];
          const exists = current.includes(schema);
          const next = exists ? current.filter((s) => s !== schema) : [...current, schema];
          return {
            pinnedSchemasByConn: { ...state.pinnedSchemasByConn, [connId]: next },
          };
        });
      },

      unpinAll: () => {
        set((state) => ({
          connections: state.connections.map((c) => ({ ...c, isFavorite: false })),
          pinnedSchemasByConn: {},
        }));
      },

      setConnectionShowSystemSchemas: (connId, value) => {
        set((state) => ({
          connections: state.connections.map((c) =>
            c.id === connId ? { ...c, showSystemSchemas: value } : c
          ),
        }));
      },

      setConnectionTag: (connId, tagId) => {
        set((state) => ({
          connections: state.connections.map((c) =>
            c.id === connId ? { ...c, tagId: tagId ?? null } : c
          ),
        }));
      },

      moveConnection: (connId, tagId) => {
        get().setConnectionTag(connId, tagId);
      },

      clearTagFromAll: (tagId) => {
        set((state) => ({
          connections: state.connections.map((c) =>
            c.tagId === tagId ? { ...c, tagId: null } : c
          ),
        }));
      },

      fetchSchema: async (connId) => {
        const conn = get().connections.find((c) => c.id === connId);
        if (!conn) return;

        // Redis has no schema/table/column tree — skip the round trip
        // entirely (the Explorer opens a key browser tab for it instead).
        if (conn.engine === 'redis') {
          set((state) => ({
            schemaTree: [],
            schemaTreeByConn: { ...state.schemaTreeByConn, [connId]: [] },
            loadingSchema: false,
          }));
          return;
        }

        set({ loadingSchema: true });
        try {
          // Honor the per-connection "show system schemas" override, falling
          // back to the global default — same precedence the Explorer uses, so
          // a save / connect fetches with the same visibility the tree shows.
          const includeSystemSchemas =
            conn.showSystemSchemas ?? useSettingsStore.getState().showSystemSchemas;
          const tree = await safeInvoke<SchemaGroupNode[]>('fetch_schema_tree', {
            config: { ...conn, includeSystemSchemas },
          });
          // Cache per-connection AND mirror into schemaTree (the active-conn
          // view legacy consumers read). The per-conn cache is shared with the
          // SQL editor's autocomplete.
          set((state) => ({
            schemaTree: tree || [],
            schemaTreeByConn: { ...state.schemaTreeByConn, [connId]: tree || [] },
            loadingSchema: false,
          }));
        } catch (err) {
          console.error('Failed to fetch schema tree:', err);
          set({ schemaTree: [], loadingSchema: false });
        }
      },

      setSchemaTreeForConn: (connId, tree) => {
        set((state) => ({
          schemaTreeByConn: { ...state.schemaTreeByConn, [connId]: tree },
          // Keep the active-connection mirror in sync when this is the active
          // connection so legacy consumers (and the editor before it migrated)
          // still see fresh data.
          schemaTree:
            state.activeConnectionId === connId ? tree : state.schemaTree,
        }));
      },

      setConnectionModalOpen: (open) => set({ isConnectionModalOpen: open, editingConnection: null }),
      openEditConnection: (conn) => set({ editingConnection: conn, isConnectionModalOpen: true }),
      setSearchQuery: (query) => set({ searchQuery: query }),
    }),
    {
      name: 'rdsql_desktop_connections_v2',
      storage: createJSONStorage(() => localStorage),
      // Schema trees are large and fetched live — never persist them.
      partialize: (state) => ({
        connections: state.connections,
        activeConnectionId: state.activeConnectionId,
        activeDatabaseByConn: state.activeDatabaseByConn,
        pinnedSchemasByConn: state.pinnedSchemasByConn,
      }),
    }
  )
);
