import { create } from 'zustand';
import { QueryTab, QueryResultData, QueryResultSet, ErdSchemaContext, ObjectEditorContext } from '../core/domain/types';
import { useConnectionStore } from './useConnectionStore';
import { useWorkspaceStore } from './useWorkspaceStore';
import { useStorageStore } from './useStorageStore';
import { safeInvoke } from '../core/tauri/ipc';
import { selectPreviewSql, resolveTargetDatabase, detectEditableTable } from '../core/sql/ident';
import { splitSqlStatements } from '../core/backup/backupSql';

interface TabState {
  tabs: QueryTab[];
  activeTabId: string;

  // Actions
  openTableDataTab: (tableName: string, schemaName?: string, connectionId?: string) => void;
  openUsersTab: (connectionId?: string) => void;
  openSqlTab: (title?: string, initialSql?: string, connectionId?: string, schemaName?: string, filePath?: string) => string;
  /** Open a structured object-editor tab (HeidiSQL-style: name + fields +
   *  body + Save) for a View/Trigger/Procedure/Event. One editor per object
   *  identity so re-opening "Edit" on the same object focuses its tab. */
  openObjectEditorTab: (
    kind: 'view' | 'trigger' | 'procedure' | 'event',
    mode: 'create' | 'edit',
    connectionId: string,
    schemaName?: string,
    name?: string,
    tableName?: string
  ) => string;
  openErdTab: (schema: ErdSchemaContext) => void;
  /** Open (or focus) an S3 storage browser tab for a storage connection id.
   *  Reuses one tab per storage connection. `connectionId` points at a
   *  `S3ConnectionConfig` in `useStorageStore`, NOT a DB connection. */
  openStorageTab: (connectionId: string, prefix?: string, selectedKey?: string) => void;
  /** Open (or focus) the Redis key browser tab for a connection. Unlike
   *  `openStorageTab`, `connectionId` points at a normal `DatabaseConnection`
   *  in `useConnectionStore` (engine `'redis'`). One tab per connection —
   *  DB switching happens inside that tab, not via a separate tab per DB.
   *  `dbIndex`, when given (e.g. clicking "DB n" in the Explorer's Databases
   *  tree), sets/updates which logical DB the tab is browsing; omitted, a
   *  new tab falls back to the connection's own configured `redisDbIndex`
   *  (or 0), and re-focusing an existing tab leaves its current DB alone. */
  openRedisBrowserTab: (connectionId: string, dbIndex?: number) => void;
  /** Open (or focus) the MongoDB document browser tab for one database +
   *  collection — unlike Redis's single per-connection tab, Mongo has a real
   *  schema tree (see `SchemaGroupNode`/`SchemaTableNode` with
   *  `node_type: 'collection'`), so a tab is scoped the same way
   *  `openTableDataTab` scopes a `table_data` tab (`schemaName`/`tableName`
   *  carry the database/collection names). */
  openMongoDocumentsTab: (database: string, collectionName: string, connectionId?: string) => void;
  addTab: (title?: string, initialSql?: string, autoRun?: boolean) => string;
  closeTab: (id: string) => void;
  closeAllTabs: () => void;
  closeTabsToRight: (id: string) => void;
  /** Closes every tab except `id` (context menu "Close Other Tabs"). */
  closeOtherTabs: (id: string) => void;
  /** Moves the tab `draggedId` to sit just before `targetId` in tab order
   *  (drag-and-drop reposition in the tab bar). No-op if either id is
   *  missing or they're the same tab. */
  reorderTabs: (draggedId: string, targetId: string) => void;
  setActiveTab: (id: string) => void;
  updateTabSql: (id: string, sql: string) => void;
  /** Rebind a tab to a different connection (SQL editor toolbar picker).
   *  Clears any stale results since they belonged to the old connection. */
  setTabConnection: (id: string, connectionId: string) => void;
  /** Records the on-disk path a `sql_editor` tab was saved to (Save/Save As),
   *  and renames the tab to the file's base name so the tab bar reflects it. */
  setTabFilePath: (id: string, filePath: string, title: string) => void;
  /** Set the schema/database a SQL editor tab targets (toolbar picker).
   *  Clears stale results since the prior ones ran against a different db. */
  setTabSchema: (id: string, schemaName?: string) => void;
  /** Runs a tab's SQL (or an explicit override, e.g. the editor selection). */
  executeQuery: (id: string, overrideSql?: string) => Promise<void>;
  /** Asks the backend to cancel the query currently running on this tab. */
  stopQuery: (id: string) => Promise<void>;
  /** Re-runs a single statement (by exact text) within an already-run tab's
   *  `resultSets` and replaces just that result set — used to refresh a result
   *  grid after editing it without re-running the whole batch. */
  runSingleStatement: (id: string, statement: string) => Promise<void>;
}

export const useTabStore = create<TabState>((set, get) => ({
  tabs: [
    {
      id: 'tab_welcome',
      title: 'Query 1.sql',
      sql: '',
      tabType: 'sql_editor',
      isDirty: false,
    },
  ],
  activeTabId: 'tab_welcome',

  openTableDataTab: (tableName: string, schemaName?: string, connectionId?: string) => {
    // Merge tabs per connection + table name: the same table on the same
    // connection reuses one tab even when opened from a different database/
    // schema. If the schema differs, the existing tab is repointed to the new
    // schema and re-run so it shows the newly selected database's data.
    const connId = connectionId ?? useConnectionStore.getState().activeConnectionId ?? undefined;
    const existing = get().tabs.find(
      (t) =>
        t.tabType === 'table_data' &&
        t.tableName === tableName &&
        (t.connectionId ?? undefined) === connId
    );
    if (existing) {
      const schemaChanged = (existing.schemaName ?? undefined) !== (schemaName ?? undefined);
      set({ activeTabId: existing.id });
      if (schemaChanged) {
        const { connections } = useConnectionStore.getState();
        const engine = connections.find((c) => c.id === connId)?.engine ?? 'postgres';
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === existing.id
              ? { ...t, schemaName, sql: selectPreviewSql(engine, tableName, schemaName), result: undefined, resultSets: [], error: undefined }
              : t
          ),
        }));
      }
      // No executeQuery here — TableDataView's mount effect loads the first
      // page + count itself. Calling executeQuery would fire a duplicate
      // `SELECT * FROM ... LIMIT 100` on top of the pagination SELECT.
      return;
    }

    const { connections } = useConnectionStore.getState();
    const engine = connections.find((c) => c.id === connId)?.engine ?? 'postgres';

    const newId = `tab_table_${schemaName ?? ''}_${tableName}_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: tableName,
      sql: selectPreviewSql(engine, tableName, schemaName),
      tabType: 'table_data',
      tableName,
      schemaName,
      connectionId: connId,
      isDirty: false,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newId,
    }));

    // No executeQuery — TableDataView loads the first page + count on mount.
  },

  openUsersTab: (connectionId) => {
    const connId = connectionId ?? useConnectionStore.getState().activeConnectionId ?? undefined;
    // Reuse existing users tab for this connection
    const existing = get().tabs.find(
      (t) => t.tabType === 'users' && (t.connectionId ?? undefined) === connId
    );
    if (existing) {
      set({ activeTabId: existing.id });
      useWorkspaceStore.getState().setActiveView('explorer');
      return;
    }
    const newId = `tab_users_${connId ?? ''}_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: 'Users & Privileges',
      sql: '',
      tabType: 'users',
      connectionId: connId,
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newId,
    }));
    useWorkspaceStore.getState().setActiveView('explorer');
  },

  openSqlTab: (title, initialSql, connectionId, schemaName, filePath) => {
    // Inherit the connection/db context so the editor runs against the right
    // server even after the user switches the global active connection.
    const connId = connectionId ?? useConnectionStore.getState().activeConnectionId ?? undefined;
    const newId = `tab_sql_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: title || `Query ${get().tabs.filter((t) => t.tabType === 'sql_editor').length + 1}.sql`,
      sql: initialSql || '',
      tabType: 'sql_editor',
      connectionId: connId,
      schemaName,
      filePath,
      isDirty: false,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newId,
    }));

    // SQL editor tabs never auto-run on open — the user picks a connection/db
    // from the toolbar dropdowns and presses Run (or Ctrl/Cmd+Enter) when
    // ready. Auto-executing seed SQL surprised users by running against the
    // wrong database before they had a chance to choose one.
    return newId;
  },

  openObjectEditorTab: (kind, mode, connectionId, schemaName, name, tableName) => {
    // Reuse the open tab for the same object identity (kind + name + schema +
    // connection) so clicking "Edit" on an already-open object focuses it
    // instead of stacking duplicates. Create-mode tabs key on kind+schema so
    // each schema gets at most one "New X" tab at a time.
    const existing = get().tabs.find((t) => {
      if (t.tabType !== 'object_editor' || !t.objectEditor) return false;
      const oe = t.objectEditor;
      if (oe.kind !== kind || oe.mode !== mode || t.connectionId !== connectionId) return false;
      if (mode === 'edit') return oe.name === name && oe.schemaName === schemaName;
      return oe.schemaName === schemaName;
    });
    if (existing) {
      set({ activeTabId: existing.id });
      useWorkspaceStore.getState().setActiveView('explorer');
      return existing.id;
    }

    const ctx: ObjectEditorContext = { kind, mode, name, schemaName, tableName };
    const labels = { view: 'View', trigger: 'Trigger', procedure: 'Procedure', event: 'Event' };
    const verb = mode === 'edit' ? name : `New ${labels[kind]}`;
    const newId = `tab_obj_${kind}_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: `${verb} · ${labels[kind]}`,
      sql: '',
      tabType: 'object_editor',
      connectionId,
      schemaName,
      objectEditor: ctx,
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newId,
    }));
    useWorkspaceStore.getState().setActiveView('explorer');
    return newId;
  },

  openErdTab: (schema) => {
    const existing = get().tabs.find(
      (t) => t.tabType === 'erd' && t.erdSchema?.connectionId === schema.connectionId && t.erdSchema?.schemaName === schema.schemaName
    );
    if (existing) {
      set((state) => ({
        activeTabId: existing.id,
        tabs: state.tabs.map((t) => (t.id === existing.id ? { ...t, erdSchema: schema } : t)),
      }));
      return;
    }

    const newId = `tab_erd_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: `ERD: ${schema.schemaName}`,
      sql: '',
      tabType: 'erd',
      isDirty: false,
      erdSchema: schema,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newId,
    }));
  },

  openStorageTab: (connectionId, prefix, selectedKey) => {
    if (prefix !== undefined || selectedKey !== undefined) {
      useStorageStore.getState().setNavTarget({
        connectionId,
        prefix: prefix ?? '',
        selectedKey,
      });
    }
    // One storage browser tab per storage connection (mirrors openUsersTab's
    // reuse-per-connection pattern). The connectionId resolves against
    // useStorageStore, NOT useConnectionStore.
    const existing = get().tabs.find(
      (t) => t.tabType === 'storage_browser' && t.connectionId === connectionId,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      useWorkspaceStore.getState().setActiveView('explorer');
      return;
    }
    const conn = useStorageStore.getState().getConnection(connectionId);
    const newId = `tab_storage_${connectionId}_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: conn ? `Storage: ${conn.name}` : 'Storage',
      sql: '',
      tabType: 'storage_browser',
      connectionId,
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newId,
    }));
    // Surface the storage connection as active so the Explorer highlight and
    // the Storage view both reflect the focused tab.
    useStorageStore.getState().setActiveConnection(connectionId);
    useWorkspaceStore.getState().setActiveView('explorer');
  },

  openRedisBrowserTab: (connectionId, dbIndex) => {
    // One browser tab per Redis connection (mirrors openStorageTab/openUsersTab).
    const existing = get().tabs.find(
      (t) => t.tabType === 'redis_browser' && t.connectionId === connectionId,
    );
    if (existing) {
      set((state) => ({
        activeTabId: existing.id,
        // Only patch redisDbIndex when the caller explicitly asked to switch
        // DB (e.g. clicking "DB n" in the tree) — plain re-focus (no
        // dbIndex passed) leaves whatever DB the tab is already browsing.
        tabs: dbIndex === undefined
          ? state.tabs
          : state.tabs.map((t) => (t.id === existing.id ? { ...t, redisDbIndex: dbIndex } : t)),
      }));
      useConnectionStore.getState().setActiveConnection(connectionId);
      useWorkspaceStore.getState().setActiveView('explorer');
      return;
    }
    const conn = useConnectionStore.getState().connections.find((c) => c.id === connectionId);
    const newId = `tab_redis_${connectionId}_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: conn ? conn.name : 'Redis',
      sql: '',
      tabType: 'redis_browser',
      connectionId,
      redisDbIndex: dbIndex ?? conn?.redisDbIndex ?? 0,
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newId,
    }));
    useConnectionStore.getState().setActiveConnection(connectionId);
    useWorkspaceStore.getState().setActiveView('explorer');
  },

  openMongoDocumentsTab: (database, collectionName, connectionId) => {
    const connId = connectionId ?? useConnectionStore.getState().activeConnectionId ?? undefined;
    const existing = get().tabs.find(
      (t) =>
        t.tabType === 'mongo_documents' &&
        t.tableName === collectionName &&
        t.schemaName === database &&
        (t.connectionId ?? undefined) === connId,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      if (connId) useConnectionStore.getState().setActiveConnection(connId);
      useWorkspaceStore.getState().setActiveView('explorer');
      return;
    }
    const newId = `tab_mongo_${database}_${collectionName}_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: collectionName,
      sql: '',
      tabType: 'mongo_documents',
      tableName: collectionName,
      schemaName: database,
      connectionId: connId,
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newId,
    }));
    if (connId) useConnectionStore.getState().setActiveConnection(connId);
    useWorkspaceStore.getState().setActiveView('explorer');
  },

  addTab: (title, initialSql, autoRun = true) => {
    return get().openSqlTab(title, initialSql);
  },

  closeTab: (id) => {
    const state = get();
    if (state.tabs.length <= 1) return;
    const filtered = state.tabs.filter((t) => t.id !== id);
    const newActiveId = state.activeTabId === id ? filtered[filtered.length - 1].id : state.activeTabId;
    set({ tabs: filtered, activeTabId: newActiveId });
  },

  closeAllTabs: () => {
    const newId = `tab_sql_${Date.now()}`;
    const newTab: QueryTab = {
      id: newId,
      title: 'Query 1.sql',
      sql: '',
      tabType: 'sql_editor',
      isDirty: false,
    };
    set({ tabs: [newTab], activeTabId: newId });
  },

  closeTabsToRight: (id) => {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const kept = state.tabs.slice(0, idx + 1);
    const activeStillExists = kept.some((t) => t.id === state.activeTabId);
    set({ tabs: kept, activeTabId: activeStillExists ? state.activeTabId : id });
  },

  closeOtherTabs: (id) => {
    const state = get();
    if (!state.tabs.some((t) => t.id === id)) return;
    set({ tabs: state.tabs.filter((t) => t.id === id), activeTabId: id });
  },

  reorderTabs: (draggedId, targetId) => {
    if (draggedId === targetId) return;
    set((state) => {
      const fromIdx = state.tabs.findIndex((t) => t.id === draggedId);
      const toIdx = state.tabs.findIndex((t) => t.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return state;
      const next = [...state.tabs];
      const [moved] = next.splice(fromIdx, 1);
      const insertAt = next.findIndex((t) => t.id === targetId);
      next.splice(insertAt, 0, moved);
      return { tabs: next };
    });
  },

  setActiveTab: (id) => {
    set({ activeTabId: id });
    const tab = get().tabs.find((t) => t.id === id);
    // Storage tabs live in their own store — sync that instead of the DB
    // connection store so the Explorer storage highlight follows focus.
    if (tab?.tabType === 'storage_browser' && tab.connectionId) {
      useStorageStore.getState().setActiveConnection(tab.connectionId);
      return;
    }
    // Sync the global active connection to this tab's connection so the Explorer
    // highlight follows tab focus (and legacy code reading the global active
    // connection sees the right one).
    if (tab?.connectionId) {
      const { activeConnectionId, setActiveConnection } = useConnectionStore.getState();
      if (activeConnectionId !== tab.connectionId) {
        setActiveConnection(tab.connectionId);
      }
      // Also mirror the tab's schema into the per-connection active database so
      // the Explorer highlights the matching group node.
      if (tab.schemaName) {
        useConnectionStore.getState().setActiveDatabase(tab.connectionId, tab.schemaName);
      }
    }
    // No tab auto-runs on focus. TableDataView loads its own first page +
    // count when it mounts (so switching to a table_data tab refreshes via
    // that effect), and SQL editor tabs are always manual (Run / Ctrl+Enter).
  },

  updateTabSql: (id, sql) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, sql, isDirty: true } : t)),
    }));
  },

  setTabConnection: (id, connectionId) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              connectionId,
              // A connection switch invalidates any prior result — it ran
              // against a different server. Also drop the schema binding so
              // the editor doesn't keep a database from the old connection.
              schemaName: undefined,
              result: undefined,
              resultSets: [],
              error: undefined,
            }
          : t
      ),
    }));
  },

  setTabFilePath: (id, filePath, title) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, filePath, title } : t)),
    }));
  },

  setTabSchema: (id, schemaName) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              schemaName,
              result: undefined,
              resultSets: [],
              error: undefined,
            }
          : t
      ),
    }));
  },

  executeQuery: async (id, overrideSql) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;

    const { connections, activeConnectionId, activeDatabaseByConn } = useConnectionStore.getState();
    // Each tab remembers the connection it was opened on, so switching the global
    // active connection (e.g. browsing another server) doesn't hijack a tab that
    // belongs to a different database. Fall back to the global active connection
    // for older tabs that have no connectionId bound.
    const connId = tab.connectionId ?? activeConnectionId;
    const activeConn = connections.find((c) => c.id === connId);

    if (!activeConn) {
      // Distinguish "this tab was bound to a connection that's since been
      // deleted" from "nothing was ever selected" — the backend opens a
      // fresh connection per query (no persistent pool), so the only way
      // `activeConn` resolves to nothing is a missing connectionId or a
      // deleted connection, never a dropped/disconnected live session.
      const message = tab.connectionId
        ? 'This tab’s connection no longer exists (it may have been deleted). Rebind the tab to a different connection to run this query.'
        : 'No active connection selected. Please select a database connection first.';
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                executing: false,
                error: message,
              }
            : t
        ),
      }));
      return;
    }

    // Decide what SQL to run: an explicit override (e.g. the editor selection),
    // otherwise the tab's full SQL.
    const sql = (overrideSql ?? tab.sql ?? '').trim();
    if (!sql) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === id ? { ...t, executing: false, error: 'Nothing to execute — the editor is empty.' } : t
        ),
      }));
      return;
    }

    // Resolve the database to connect to. Prefer the tab's own schema (so the
    // query follows the tab, not the global selection), then the explorer's
    // per-connection active database. For MySQL/MariaDB the explorer group is a
    // database, so it overrides the connection's default database. For PostgreSQL
    // the group is a schema (e.g. `public`), NOT a database — overriding
    // config.database with it would make the backend try `dbname=public` and
    // fail — so for Postgres we keep the connection's configured database and let
    // the schema qualify the SQL only.
    const groupOrSchema = tab?.schemaName ?? activeDatabaseByConn[activeConn.id];
    const targetDb = resolveTargetDatabase(activeConn.engine, activeConn.database, groupOrSchema);
    const config =
      targetDb && targetDb !== activeConn.database
        ? { ...activeConn, database: targetDb }
        : activeConn;

    // The backend executes ONE statement per call. Split the buffer on top-level
    // semicolons (respecting quoted strings) and run each in sequence, collecting
    // one QueryResultSet per statement. A single-statement buffer produces a
    // single-element list — identical UX to the old single-shot path.
    const statements = splitSqlStatements(sql);

    // A single backend query id drives the Stop button; we track the currently
    // running one so cancel lands on the right in-flight request.
    const queryId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, executing: true, error: undefined, currentQueryId: queryId, resultSets: [] } : t
      ),
    }));

    const resultSets: QueryResultSet[] = [];
    let firstError: string | undefined;

    for (const stmtRaw of statements) {
      const stmt = stmtRaw.trim();
      if (!stmt) continue;

      const stmtQueryId = `q_${queryId}_${resultSets.length}`;
      // Publish the active query id so Stop targets this statement.
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === id ? { ...t, currentQueryId: stmtQueryId } : t)),
      }));

      try {
        const res = await safeInvoke<QueryResultData>('execute_query', {
          request: { config, sql: stmt },
          queryId: stmtQueryId,
          // The IPC layer logs this once with the correct source — no manual
          // addLog needed here.
          __meta: { source: 'editor' },
        });

        resultSets.push({
          id: `rs_${id}_${resultSets.length}`,
          statement: stmt,
          status: 'success',
          result: res,
          editableTable: detectEditableTable(stmt),
        });
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        // (Logged by the IPC layer with source: 'editor'.)

        if (!firstError) firstError = errMsg;
        resultSets.push({
          id: `rs_${id}_${resultSets.length}`,
          statement: stmt,
          status: 'error',
          error: errMsg,
        });
        // Stop the batch on the first error so the user sees what broke instead
        // of a cascade of follow-on failures.
        break;
      }
    }

    // Keep `result` / `error` in sync with the first set so legacy consumers
    // (e.g. a tab with a single statement, or code reading tab.result directly)
    // keep working unchanged.
    const firstSet = resultSets[0];
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              executing: false,
              isDirty: false,
              currentQueryId: undefined,
              resultSets,
              result: firstSet?.result,
              error: firstError,
            }
          : t
      ),
    }));
  },

  stopQuery: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    const queryId = tab?.currentQueryId;
    if (!queryId) return;
    try {
      await safeInvoke<boolean>('cancel_query', { queryId });
    } catch {
      // Backend may have already removed the token (query finished). Ignore.
    }
  },

  runSingleStatement: async (id, statement) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    const stmt = statement.trim();
    if (!stmt) return;

    const { connections, activeConnectionId, activeDatabaseByConn } = useConnectionStore.getState();
    const connId = tab.connectionId ?? activeConnectionId;
    const activeConn = connections.find((c) => c.id === connId);
    if (!activeConn) return;

    const groupOrSchema = tab?.schemaName ?? activeDatabaseByConn[activeConn.id];
    const targetDb = resolveTargetDatabase(activeConn.engine, activeConn.database, groupOrSchema);
    const config =
      targetDb && targetDb !== activeConn.database
        ? { ...activeConn, database: targetDb }
        : activeConn;

    const queryId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      const res = await safeInvoke<QueryResultData>('execute_query', {
        request: { config, sql: stmt },
        queryId,
        // Logged once by the IPC layer with source: 'editor'.
        __meta: { source: 'editor' },
      });

      const updated: QueryResultSet = {
        id: `rs_${id}_refresh_${Date.now()}`,
        statement: stmt,
        status: 'success',
        result: res,
        editableTable: detectEditableTable(stmt),
      };
      // Replace the matching set by statement text. If none matches (statement
      // was edited inline since the last run), append it.
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id !== id) return t;
          const existing = t.resultSets ?? [];
          const idx = existing.findIndex((rs) => rs.statement.trim() === stmt);
          const nextSets =
            idx >= 0
              ? existing.map((rs) => (rs.statement.trim() === stmt ? { ...updated, id: rs.id } : rs))
              : [...existing, updated];
          return { ...t, resultSets: nextSets, result: nextSets[0]?.result ?? t.result };
        }),
      }));
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      // (Logged by the IPC layer with source: 'editor'.)
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id !== id) return t;
          const existing = t.resultSets ?? [];
          const idx = existing.findIndex((rs) => rs.statement.trim() === stmt);
          const failed: QueryResultSet = {
            id: idx >= 0 ? existing[idx].id : `rs_${id}_err_${Date.now()}`,
            statement: stmt,
            status: 'error',
            error: errMsg,
          };
          const nextSets =
            idx >= 0 ? existing.map((rs) => (rs.statement.trim() === stmt ? failed : rs)) : [...existing, failed];
          return { ...t, resultSets: nextSets, error: errMsg };
        }),
      }));
    }
  },
}));
