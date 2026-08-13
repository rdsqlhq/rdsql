import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ActiveView, DatabaseConnection } from '../core/domain/types';

/** Zoom clamps: 0.5 (50%) to 2.0 (200%), stepped in 0.05 increments. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;
const clampZoom = (v: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(v / ZOOM_STEP) * ZOOM_STEP));

interface WorkspaceState {
  activeView: ActiveView;
  isSidebarOpen: boolean;
  isAIPanelOpen: boolean;
  isOutputConsoleOpen: boolean;
  sidebarWidth: number;
  bottomPanelHeight: number;
  aiPanelWidth: number;
  /** ERD tab's docked table-detail side panel width in px. Transient — not
   *  persisted, same as sidebarWidth/aiPanelWidth. */
  erdDetailPanelWidth: number;
  /** S3 Storage tab's docked object-detail side panel width in px. Same
   *  transient, not-persisted convention. */
  storageDetailPanelWidth: number;
  /** DataGrid's docked row-inspector side panel width in px. Same transient,
   *  not-persisted convention. */
  gridRowInspectorWidth: number;
  /** MongoDB Documents tab's slide-over document-detail panel width in px.
   *  Same transient, not-persisted convention. */
  mongoDetailPanelWidth: number;
  activeBottomTab: 'result' | 'messages' | 'explain' | 'history';
  isUsersModalOpen: boolean;
  isEncryptedConnectionsModalOpen: boolean;
  isAboutModalOpen: boolean;
  isSettingsModalOpen: boolean;
  /** Optional initial tab to focus when the Settings modal opens. Set this
   *  together with `setSettingsModalOpen(true)` (e.g. from the AI panel's
   *  "Configure AI" button) so the user lands on the right section. Transient
   *  — consumed once on open, not persisted. */
  settingsModalInitialTab?: string;
  encryptedConnectionsModalMode: 'export' | 'import';
  singleConnectionExport: DatabaseConnection | null;
  /** Pre-selected file path to import when the modal opens in import mode.
   *  Transient — set when the OS launches us via a double-clicked .rdsql file
   *  and consumed once on mount, not persisted. */
  encryptedConnectionsInitialPath?: string;
  /** Global UI zoom factor (1 = 100%). Persisted across restarts. */
  zoomLevel: number;
  /** SQL editor result panel height in px. Drag the handle between the editor
   *  and the result panel to adjust. Persisted across restarts. */
  resultPanelHeight: number;
  /** Data-grid viewport height in px. Measured from the grid area element so
   *  the virtualized table renders the right number of rows. Hoisted into the
   *  store (persisted) so it survives tab switches + remounts — without this,
   *  switching from a table tab to SQL/ERD and back reset the height to a
   *  default, causing a visible flicker and a wrong row count. */
  gridAreaHeight: number;

  setActiveView: (view: ActiveView) => void;
  toggleSidebar: () => void;
  toggleAIPanel: () => void;
  /** Force the AI panel open (no-op if already open) — unlike `toggleAIPanel`,
   *  safe to call from a flow that just needs the panel visible without
   *  risking closing it if the user already had it open. */
  setAIPanelOpen: (open: boolean) => void;
  toggleOutputConsole: () => void;
  setSidebarWidth: (width: number) => void;
  setBottomPanelHeight: (height: number) => void;
  setAIPanelWidth: (width: number) => void;
  setErdDetailPanelWidth: (width: number) => void;
  setStorageDetailPanelWidth: (width: number) => void;
  setGridRowInspectorWidth: (width: number) => void;
  setMongoDetailPanelWidth: (width: number) => void;
  setActiveBottomTab: (tab: 'result' | 'messages' | 'explain' | 'history') => void;
  setUsersModalOpen: (open: boolean) => void;
  setAboutModalOpen: (open: boolean) => void;
  setSettingsModalOpen: (open: boolean, initialTab?: string) => void;
  openEncryptedConnectionsModal: (
    mode?: 'export' | 'import',
    singleConn?: DatabaseConnection | null,
    initialPath?: string,
  ) => void;
  closeEncryptedConnectionsModal: () => void;
  setZoomLevel: (v: number) => void;
  setResultPanelHeight: (h: number) => void;
  setGridAreaHeight: (h: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      activeView: 'explorer',
      isSidebarOpen: true,
      isAIPanelOpen: false, // Default hidden as requested
      isOutputConsoleOpen: true,
      sidebarWidth: 285,
      bottomPanelHeight: 220,
      aiPanelWidth: 320,
      erdDetailPanelWidth: 320,
      storageDetailPanelWidth: 320,
      gridRowInspectorWidth: 320,
      mongoDetailPanelWidth: 440,
      activeBottomTab: 'result',
      isUsersModalOpen: false,
      isEncryptedConnectionsModalOpen: false,
      isAboutModalOpen: false,
      isSettingsModalOpen: false,
      encryptedConnectionsModalMode: 'export',
      singleConnectionExport: null,
      zoomLevel: 1,
      resultPanelHeight: 280,
      gridAreaHeight: 480,

      setActiveView: (view) => set({ activeView: view }),
      toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
      toggleAIPanel: () => set((state) => ({ isAIPanelOpen: !state.isAIPanelOpen })),
      setAIPanelOpen: (open) => set({ isAIPanelOpen: open }),
      toggleOutputConsole: () => set((state) => ({ isOutputConsoleOpen: !state.isOutputConsoleOpen })),
      setSidebarWidth: (width) => set({ sidebarWidth: Math.max(180, Math.min(550, width)) }),
      setBottomPanelHeight: (height) => set({ bottomPanelHeight: Math.max(120, Math.min(650, height)) }),
      setAIPanelWidth: (width) => set({ aiPanelWidth: Math.max(220, Math.min(600, width)) }),
      setErdDetailPanelWidth: (width) => set({ erdDetailPanelWidth: Math.max(260, Math.min(520, width)) }),
      setStorageDetailPanelWidth: (width) => set({ storageDetailPanelWidth: Math.max(260, Math.min(520, width)) }),
      setGridRowInspectorWidth: (width) => set({ gridRowInspectorWidth: Math.max(260, Math.min(520, width)) }),
      setMongoDetailPanelWidth: (width) => set({ mongoDetailPanelWidth: Math.max(320, Math.min(900, width)) }),
      setActiveBottomTab: (tab) => set({ activeBottomTab: tab }),
      setUsersModalOpen: (open) => set({ isUsersModalOpen: open }),
      setAboutModalOpen: (open) => set({ isAboutModalOpen: open }),
      setSettingsModalOpen: (open, initialTab) =>
        set({ isSettingsModalOpen: open, settingsModalInitialTab: initialTab }),
      openEncryptedConnectionsModal: (mode = 'export', singleConn = null, initialPath) =>
        set({
          isEncryptedConnectionsModalOpen: true,
          encryptedConnectionsModalMode: mode,
          singleConnectionExport: singleConn,
          encryptedConnectionsInitialPath: initialPath,
        }),
      closeEncryptedConnectionsModal: () =>
        set({
          isEncryptedConnectionsModalOpen: false,
          singleConnectionExport: null,
          encryptedConnectionsInitialPath: undefined,
        }),
      setZoomLevel: (v) => set({ zoomLevel: clampZoom(v) }),
      setResultPanelHeight: (h) => set({ resultPanelHeight: Math.max(120, Math.min(800, h)) }),
      setGridAreaHeight: (h) => set({ gridAreaHeight: Math.max(160, Math.min(4000, h)) }),
      zoomIn: () => set((state) => ({ zoomLevel: clampZoom(state.zoomLevel + ZOOM_STEP * 2) })),
      zoomOut: () => set((state) => ({ zoomLevel: clampZoom(state.zoomLevel - ZOOM_STEP * 2) })),
      resetZoom: () => set({ zoomLevel: 1 }),
    }),
    {
      name: 'rdsql_workspace_v1',
      storage: createJSONStorage(() => localStorage),
      // Persist the zoom level, the editor result-panel height, and the
      // data-grid viewport height — all durable user preferences. Transient UI
      // state (panels open, widths, active view) should start fresh each session.
      partialize: (state) => ({
        zoomLevel: state.zoomLevel,
        resultPanelHeight: state.resultPanelHeight,
        gridAreaHeight: state.gridAreaHeight,
      }),
    }
  )
);
