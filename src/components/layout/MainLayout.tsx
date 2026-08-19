import React, { useState, useEffect } from 'react';
import { PanelBottomOpen, PanelLeftOpen, Table as TableIcon } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { inTauri } from '../../core/tauri/ipc';
import { Header } from './Header';
import { Explorer } from './Explorer';
import { EditorTabs } from './EditorTabs';
import { ResultPanel } from './ResultPanel';
import { GlobalSqlLog } from './GlobalSqlLog';
import { AIAssistantPanel } from './AIAssistantPanel';
import { StatusBar } from './StatusBar';
import { ConnectionModal } from '../connection/ConnectionModal';
import { EncryptedConnectionsModal } from '../connection/EncryptedConnectionsModal';
import { AboutModal } from '../common/AboutModal';
import { UsersPrivilegesModal } from '../users/UsersPrivilegesModal';
import { SQLEditor } from '../editor/SQLEditor';
import { ObjectEditor } from '../editor/ObjectEditor';
import { TableDataView } from '../table/TableDataView';
import { VisualERDCanvas } from '../erd/VisualERDCanvas';
import { MigrationStudio } from '../migration/MigrationStudio';
import { MysqlToPostgresWizard } from '../pgmigrate/MysqlToPostgresWizard';
import { PluginMarketplace } from '../plugins/PluginMarketplace';
import { StorageBrowser } from '../storage/StorageBrowser';
import { RedisBrowser } from '../redis/RedisBrowser';
import { MongoDocumentBrowser } from '../mongo/MongoDocumentBrowser';

import { SettingsModal } from '../settings/SettingsModal';
import { DatabaseHealthView } from '../health/DatabaseHealthView';
import { ToastContainer } from '../common/ToastContainer';

import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useTabStore } from '../../store/useTabStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useToastStore } from '../../store/useToastStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useEdition } from '../../core/config/edition';
import { checkForUpdateAndNotify } from '../../core/updater';
import { pickAndReadSqlFile } from '../../core/sql/loadSqlFile';
import { readTextFile } from '@tauri-apps/plugin-fs';

export const MainLayout: React.FC = () => {
  const {
    activeView,
    sidebarWidth,
    setSidebarWidth,
    bottomPanelHeight,
    setBottomPanelHeight,
    aiPanelWidth,
    setAIPanelWidth,
    isAIPanelOpen,
    toggleAIPanel,
    isSidebarOpen,
    toggleSidebar,
    isOutputConsoleOpen,
    toggleOutputConsole,
    isEncryptedConnectionsModalOpen,
    encryptedConnectionsModalMode,
    singleConnectionExport,
    encryptedConnectionsInitialPath,
    openEncryptedConnectionsModal,
    closeEncryptedConnectionsModal,
    setAboutModalOpen,
    zoomLevel,
    zoomIn,
    zoomOut,
    resetZoom,
    setActiveView,
  } = useWorkspaceStore();

  const { tabs, activeTabId, openSqlTab } = useTabStore();
  const { setConnectionModalOpen } = useConnectionStore();
  const pushToast = useToastStore((s) => s.push);
  // User-level preference: when off, the global log panel is fully hidden
  // (no panel, no collapsed strip). The per-session `isOutputConsoleOpen`
  // toggle below is a finer-grained on/off for the current session only.
  const showGlobalLogs = useSettingsStore((s) => s.showGlobalLogs);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const refreshEntitlement = useAuthStore((s) => s.refreshEntitlement);
  const checkCloudConfigured = useAuthStore((s) => s.checkCloudConfigured);
  const handleAuthCallback = useAuthStore((s) => s.handleAuthCallback);
  const edition = useEdition();

  // Pick up an existing signed-in session (keychain-backed tokens survive app
  // restarts) once on boot. Best-effort — never blocks the app if offline or
  // signed out; see useAuthStore.refreshEntitlement.
  useEffect(() => {
    void checkCloudConfigured();
    void refreshEntitlement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // tauri.conf.json's static title is only the signed-out/offline default
  // (read before any JS runs, so it can't know the real account) — once the
  // live entitlement resolves, correct the native title bar to match.
  useEffect(() => {
    if (!inTauri()) return; // browser preview (make dev-web) — no native window to update
    const title = edition === 'pro' ? 'rdSQL - Professional' : 'rdSQL - Community Edition';
    getCurrentWindow()
      .setTitle(title)
      .catch((err) => {
        // A real failure here (e.g. missing core:window:allow-set-title
        // capability — see capabilities/default.json) previously looked
        // identical to "not running in Tauri" and silently hid the title
        // bar never updating. Surface it instead.
        console.error('Failed to update window title:', err);
      });
  }, [edition]);

  // Browser-based sign-in completion: the website redirects to
  // rdsql://auth/callback after the user authenticates, which lib.rs's
  // deep-link handler turns into this event once tokens are persisted.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<{ status: 'success' | 'error'; message?: string }>('auth-callback', (event) => {
      handleAuthCallback(event.payload.status, event.payload.message);
    })
      .then((unlisten) => {
        unlistenFn = unlisten;
      })
      .catch(() => {
        // Fallback for non-Tauri browser previews
      });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [handleAuthCallback]);

  // Listen for native OS menu bar events (File, Edit, View, Window, Help)
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<string>('menu_action', (event) => {
      switch (event.payload) {
        case 'export_encrypted':
          openEncryptedConnectionsModal('export');
          break;
        case 'import_encrypted':
          openEncryptedConnectionsModal('import');
          break;
        case 'new_connection':
          setConnectionModalOpen(true);
          break;
        case 'open_sql':
          openSqlTab();
          break;
        case 'open_sql_file':
          // Same load-and-create-tab logic as the toolbar button in EditorTabs.tsx.
          void pickAndReadSqlFile()
            .then((file) => {
              if (file) openSqlTab(file.name, file.content, undefined, undefined, file.path);
            })
            .catch((err: any) => {
              pushToast({ severity: 'error', title: 'Could not open SQL file', message: err?.message || String(err) });
            });
          break;
        case 'toggle_explorer':
          toggleSidebar();
          break;
        case 'toggle_ai':
          toggleAIPanel();
          break;
        case 'compare_schemas':
        case 'compare_data':
        case 'sync_schema':
          setActiveView('migration');
          break;
        case 'migrate_to_postgres':
          setActiveView('pgMigrate');
          break;
        case 'check_updates':
          // Explicit user request — always report the outcome, even "up to date".
          void checkForUpdateAndNotify(false);
          break;
        case 'about':
          setAboutModalOpen(true);
          break;
        default:
          break;
      }
    })
      .then((unlisten) => {
        unlistenFn = unlisten;
      })
      .catch(() => {
        // Fallback for non-Tauri browser previews
      });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [openEncryptedConnectionsModal, setConnectionModalOpen, openSqlTab, toggleSidebar, toggleAIPanel, setActiveView, setAboutModalOpen, pushToast]);

  // OS file-open events: fired by the Rust side (RunEvent::Opened) when the user
  // double-clicks a registered file extension (.sql, .rdsql, .rdsqlw, .sqlite,
  // .sqlite3) or uses "Open With". .sql/.rdsqlw → new SQL editor tab with the
  // file contents; .rdsql → open the encrypted-connections import modal
  // (decryption requires a passphrase prompt, so we don't attempt silent
  // auto-import here); .sqlite/.sqlite3 → connect straight to that database
  // file, reusing an existing connection that already points at it.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<string>('open-file', (event) => {
      const path = event.payload;
      const ext = path.toLowerCase().split('.').pop() ?? '';

      if (ext === 'rdsql') {
        // Encrypted connection bundles need a passphrase prompt; route the user
        // to the import modal pre-loaded with the double-clicked file.
        openEncryptedConnectionsModal('import', null, path);
        return;
      }

      if (ext === 'sql' || ext === 'rdsqlw') {
        const fileName = path.split(/[\\/]/).pop() ?? path;
        void readTextFile(path)
          .then((content) => openSqlTab(fileName, content, undefined, undefined, path))
          .catch((err: any) => {
            pushToast({
              severity: 'error',
              title: 'Could not open file',
              message: err?.message || String(err),
            });
          });
        return;
      }

      if (ext === 'sqlite' || ext === 'sqlite3') {
        const { connections, saveConnection, setActiveConnection } = useConnectionStore.getState();
        const existing = connections.find((c) => c.engine === 'sqlite' && c.filePath === path);
        if (existing) {
          setActiveConnection(existing.id);
          return;
        }
        const fileName = path.split(/[\\/]/).pop() ?? path;
        saveConnection({
          id: `conn_${Date.now()}`,
          name: fileName.replace(/\.(sqlite3?|db)$/i, ''),
          engine: 'sqlite',
          filePath: path,
        });
      }
    })
      .then((unlisten) => {
        unlistenFn = unlisten;
      })
      .catch(() => {
        // Non-Tauri preview: nothing to do.
      });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [openEncryptedConnectionsModal, openSqlTab, pushToast]);

  // Check for a new version once on startup. Delayed so it never competes with
  // the initial render, and silent so an up-to-date or offline user sees nothing.
  useEffect(() => {
    const t = setTimeout(() => void checkForUpdateAndNotify(true), 4000);
    return () => clearTimeout(t);
  }, []);

  // Apply global zoom by scaling the root font-size. Tailwind utilities use rem
  // units (1rem = root font-size), so changing it from the default 16px scales
  // every rem-based class (h-12, text-xs, p-4, gap-2, …) proportionally. Viewport
  // units (100vw/100vh used by w-screen/h-screen) are NOT rem-based, so the
  // layout keeps filling the window at every zoom level — no empty space, no
  // cropping. This is true responsive zoom, just like the browser's own zoom.
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * zoomLevel}px`;
    return () => {
      document.documentElement.style.fontSize = '';
    };
  }, [zoomLevel]);

  // Keyboard shortcuts: Cmd/Ctrl + = / + (in), Cmd/Ctrl + - (out), Cmd/Ctrl + 0
  // (reset). preventDefault stops the browser's own page-zoom from firing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        resetZoom();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [zoomIn, zoomOut, resetZoom]);

  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizingBottom, setIsResizingBottom] = useState(false);
  const [isResizingAI, setIsResizingAI] = useState(false);
  const [isResizingResult, setIsResizingResult] = useState(false);
  const [resultPanelHidden, setResultPanelHidden] = useState(false);
  // Anchor (clientY of the result panel's bottom edge) captured at drag start,
  // so the new height = anchor - current cursor y as the user drags up/down.
  const resizeAnchorRef = React.useRef(0);

  // Destructure result panel height from the store (persisted).
  const { resultPanelHeight, setResultPanelHeight } = useWorkspaceStore();

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        setSidebarWidth(e.clientX / zoomLevel);
      } else if (isResizingBottom) {
        setBottomPanelHeight((window.innerHeight - e.clientY - 24) / zoomLevel);
      } else if (isResizingAI) {
        setAIPanelWidth((window.innerWidth - e.clientX) / zoomLevel);
      } else if (isResizingResult) {
        // Result panel sits at the bottom of the central editor column. Its
        // height grows upward as the user drags the handle down → the
        // available height is (column bottom y) - (mouse y).
        setResultPanelHeight((resizeAnchorRef.current - e.clientY) / zoomLevel);
      }
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      setIsResizingBottom(false);
      setIsResizingAI(false);
      setIsResizingResult(false);
    };

    if (isResizingSidebar || isResizingBottom || isResizingAI || isResizingResult) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSidebar, isResizingBottom, isResizingAI, isResizingResult, setSidebarWidth, setBottomPanelHeight, setAIPanelWidth, setResultPanelHeight, zoomLevel]);

  return (
    <div className="w-screen h-screen flex flex-col bg-[#06090e] text-slate-100 overflow-hidden font-sans select-none">
      {/* Top Application Header */}
      <Header />

      {/* Main Workspace Body */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Resizable Database Explorer Sidebar — persists across all views */}
        {isSidebarOpen ? (
          <>
            <div style={{ width: `${sidebarWidth * zoomLevel}px` }} className="h-full shrink-0 relative">
              <Explorer />
            </div>

            {/* Sidebar Resizer Handle */}
            <div
              onMouseDown={() => setIsResizingSidebar(true)}
              className="w-1.5 h-full bg-[#1e293b]/40 hover:bg-cyan-500 cursor-col-resize z-30 transition-colors shrink-0"
              title="Drag to resize sidebar"
            />
          </>
        ) : (
          /* Collapsed re-expand strip */
          <button
            onClick={toggleSidebar}
            className="w-7 h-full flex items-center justify-center bg-[#0a0f18] border-r border-[#1e293b] text-slate-500 hover:text-cyan-400 hover:bg-[#0f172a] transition-colors shrink-0 z-30"
            title="Expand Sidebar"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}

        {/* Dynamic Main Workspace Content */}
        {activeView === 'explorer' ? (
          <div className="flex-1 flex overflow-hidden">
            {/* Central View Area: Table Data Spreadsheet OR SQL Editor + Bottom Query Log Dock */}
            <main className="flex-1 flex flex-col overflow-hidden bg-[#06090e]">
              <EditorTabs />

              {/* Main Content Area */}
              <div className="flex-1 overflow-hidden relative">
                {activeTab?.tabType === 'table_data' ? (
                  <TableDataView tabId={activeTabId} />
                ) : activeTab?.tabType === 'object_editor' ? (
                  <ObjectEditor tabId={activeTabId} />
                ) : activeTab?.tabType === 'erd' ? (
                  <VisualERDCanvas schema={activeTab.erdSchema ?? null} />
                ) : activeTab?.tabType === 'users' ? (
                  <UsersPrivilegesModal embedded connectionId={activeTab.connectionId} />
                ) : activeTab?.tabType === 'storage_browser' ? (
                  <StorageBrowser connectionId={activeTab.connectionId} />
                ) : activeTab?.tabType === 'redis_browser' ? (
                  <RedisBrowser connectionId={activeTab.connectionId} dbIndex={activeTab.redisDbIndex} />
                ) : activeTab?.tabType === 'mongo_documents' ? (
                  <MongoDocumentBrowser
                    connectionId={activeTab.connectionId}
                    database={activeTab.schemaName}
                    collectionName={activeTab.tableName}
                  />
                ) : (
                  <SQLEditor tabId={activeTabId} />
                )}
              </div>

              {/* Result panel for SQL editor tabs — shows the query result grid
                  inline (not in the global log). Has its own hide/show toggle
                  separate from the global SQL log panel. Height is draggable
                  via the handle above (persisted in the workspace store). Only
                  visible when the tab has a result or error and the user hasn't
                  hidden it. */}
              {activeTab?.tabType === 'sql_editor' && !resultPanelHidden && (activeTab.result || activeTab.error || (activeTab.resultSets && activeTab.resultSets.length > 0)) && (
                <>
                  {/* Drag handle — resizes the result panel below. */}
                  <div
                    onMouseDown={(e) => {
                      // Capture the current bottom edge of the result panel as
                      // the resize anchor; height = anchor - cursorY.
                      resizeAnchorRef.current = e.clientY + resultPanelHeight * zoomLevel;
                      setIsResizingResult(true);
                    }}
                    className="h-1.5 w-full bg-[#1e293b]/40 hover:bg-cyan-500 cursor-row-resize z-30 transition-colors shrink-0"
                    title="Drag to resize result panel"
                  />
                  <div
                    style={{ height: `${resultPanelHeight * zoomLevel}px` }}
                    className="min-h-[120px] shrink-0 border-t border-[#1e293b]"
                  >
                    <ResultPanel onHide={() => setResultPanelHidden(true)} />
                  </div>
                </>
              )}
              {/* Re-expand strip for the result panel */}
              {activeTab?.tabType === 'sql_editor' && resultPanelHidden && (activeTab.result || activeTab.error || (activeTab.resultSets && activeTab.resultSets.length > 0)) && (
                <button
                  onClick={() => setResultPanelHidden(false)}
                  className="h-5 shrink-0 w-full flex items-center justify-center gap-1.5 bg-[#080c14] border-t border-[#1e293b] text-[10px] font-medium uppercase tracking-wider text-slate-600 hover:text-emerald-300 hover:bg-[#0f172a] transition-colors"
                  title="Show result panel"
                >
                  <TableIcon className="w-3 h-3" />
                  <span>Show Result</span>
                </button>
              )}
            </main>

            {/* AI Panel Resizer Handle (Visible when toggled on) */}
            {isAIPanelOpen && (
              <div
                onMouseDown={() => setIsResizingAI(true)}
                className="w-1.5 h-full bg-[#1e293b]/40 hover:bg-cyan-500 cursor-col-resize z-30 transition-colors shrink-0"
                title="Drag to resize AI Assistant panel"
              />
            )}

            {/* Resizable AI Assistant Right Drawer (Default hidden) */}
            {isAIPanelOpen && (
              <div style={{ width: `${aiPanelWidth * zoomLevel}px` }} className="h-full shrink-0">
                <AIAssistantPanel />
              </div>
            )}
          </div>
        ) : activeView === 'migration' ? (
          <MigrationStudio />
        ) : activeView === 'pgMigrate' ? (
          <MysqlToPostgresWizard />
        ) : activeView === 'health' ? (
          <DatabaseHealthView />
        ) : activeView === 'plugins' ? (
          <PluginMarketplace />
        ) : null}
      </div>

      {/* Global SQL Log panel — spans the FULL window width below the workspace
          body (sidebar + content + AI panel) so it's visible in every view
          (explorer, migration, backup, health, settings), not just the SQL
          editor. Gated by the `showGlobalLogs` user preference (Settings); the
          per-session `isOutputConsoleOpen` toggle collapses/expands it. */}
      {showGlobalLogs && isOutputConsoleOpen && (
        <>
          <div
            onMouseDown={() => setIsResizingBottom(true)}
            className="h-1.5 w-full bg-[#1e293b]/40 hover:bg-cyan-500 cursor-row-resize z-30 transition-colors shrink-0"
            title="Drag to resize SQL log panel"
          />
          <div style={{ height: `${bottomPanelHeight * zoomLevel}px` }} className="shrink-0">
            <GlobalSqlLog />
          </div>
        </>
      )}
      {showGlobalLogs && !isOutputConsoleOpen && (
        <button
          onClick={toggleOutputConsole}
          className="group h-6 shrink-0 w-full flex items-center justify-center gap-1.5 bg-[#080c14] border-t border-[#1e293b] text-[10px] font-medium uppercase tracking-wider text-slate-600 hover:text-slate-300 hover:bg-[#0f172a] transition-colors"
          title="Show SQL log panel"
        >
          <PanelBottomOpen className="w-3.5 h-3.5" />
          <span>Show Output</span>
        </button>
      )}

      {/* Footer Status Bar */}
      <StatusBar />

      {/* Global Modals */}
      <ConnectionModal />
      <AboutModal />
      <SettingsModal />
      <EncryptedConnectionsModal
        isOpen={isEncryptedConnectionsModalOpen}
        onClose={closeEncryptedConnectionsModal}
        initialMode={encryptedConnectionsModalMode}
        singleConnectionExport={singleConnectionExport}
        initialImportPath={encryptedConnectionsInitialPath}
      />

      {/* Global non-intrusive toast notifications */}
      <ToastContainer />
    </div>
  );
};
