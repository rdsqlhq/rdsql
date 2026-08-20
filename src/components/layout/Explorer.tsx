import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight,
  ChevronDown,
  Database,
  Table as TableIcon,
  Columns,
  RefreshCw,
  Plus,
  Filter,
  FileCode,
  Trash2,
  Server,
  Check,
  Hash,
  Type,
  Calendar,
  ToggleLeft,
  Info,
  HardDrive,
  HardDriveDownload,
  HardDriveUpload,
  Download,
  Upload,
  DatabaseZap,
  GitFork,
  Pencil,
  Unplug,
  PanelLeftClose,
  PanelLeftOpen,
  CopyPlus,
  Activity,
  RotateCcw,
  Eraser,
  Gauge,
  Loader2,
  Tag as TagIcon,
  Folder as FolderIcon,
  Edit3,
  X as XIcon,
  Settings,
  Users as UsersIcon,
  Cloud,
  Eye,
  Zap,
  Braces,
  Clock,
  Pin,
  PinOff,
  Puzzle,
  Layers,
  Key,
  WifiOff,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { EngineIcon } from '../common/EngineIcon';
import { TableStructureModal } from '../table/TableStructureModal';
import { CreateTableModal } from '../table/CreateTableModal';
import { fetchSchemaTriggers, TriggerListItem } from '../../core/sql/triggerIntrospection';
import { dropTriggerSql, defaultTriggerFunctionName } from '../../core/sql/triggerActions';
import { fetchSchemaProcedures, ProcedureListItem } from '../../core/sql/procedureIntrospection';
import { dropProcedureSql } from '../../core/sql/procedureActions';
import { fetchSchemaEvents, EventListItem, PGCRON_NOT_INSTALLED } from '../../core/sql/eventIntrospection';
import { dropEventSql, pgCronUnscheduleSql } from '../../core/sql/eventActions';
import { fetchExtensions, ExtensionItem } from '../../core/sql/extensionIntrospection';
import { ManageExtensionsModal } from '../connection/ManageExtensionsModal';
import type { ObjectKind } from '../../core/domain/types';
import { isPostgresFamily, isMysqlFamily, isSqliteFamily, isMongoEngine, isRedisEngine } from '../../core/connection/engines';
import { CreateDatabaseModal } from '../backup/CreateDatabaseModal';
import { BackupModal } from '../backup/BackupModal';
import { RestoreModal } from '../backup/RestoreModal';
import { MongoStatsModal } from '../mongo/MongoStatsModal';
import { MongoCreateCollectionModal } from '../mongo/MongoCreateCollectionModal';
import { CreateTagModal } from '../connection/CreateTagModal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useTabStore } from '../../store/useTabStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useToastStore, pushDedupedToast } from '../../store/useToastStore';
import { useHealthStore } from '../../store/useHealthStore';
import { useStorageStore } from '../../store/useStorageStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useSyncStore } from '../../store/useSyncStore';
import { DatabaseConnection, SchemaGroupNode, SchemaTableNode, SchemaColumnNode, ConnectionTag } from '../../core/domain/types';
import type { RedisDbInfo } from '../../core/redis/types';
import type { S3ConnectionConfig } from '../../core/storage/domain/types';
import { StorageConnectionDialog } from '../storage/StorageConnectionDialog';
import { hexToRgba, groupByTag } from '../../core/domain/tags';
import { useTagStore } from '../../store/useTagStore';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import { selectPreviewSql, qualifiedTable, resolveTargetDatabase } from '../../core/sql/ident';
import { parseDbError } from '../../core/sql/dbError';
import {
  detectAutoIncrementColumn,
  getTableCapabilities,
  truncateTableSql,
  dropTableSql,
  resetAutoIncrementSql,
  analyzeTableSql,
  vacuumTableSql,
  optimizeTableSql,
  checkTableSql,
  reindexTableSql,
  maintenanceOpSql,
  maintenanceOpLabel,
  MaintenanceOp,
  AutoIncrementMeta,
} from '../../core/sql/tableActions';
import {
  getDatabaseCapabilities,
  dropDatabaseSql,
  emptyDatabaseSql,
  isProtectedName,
} from '../../core/sql/databaseActions';

/**
 * Module-level drag tracker. Stores the id AND type of the connection being
 * dragged so drop handlers can route to the correct store without relying on
 * React state (which can be stale by the time onDragOver/onDrop fire, because
 * the re-render triggered by setDragConnId in onDragStart may not have
 * committed before the drag enters the drop zone). Both `text/conn-id` and
 * `text/storage-id` dataTransfer keys are still set for robustness, but this
 * object is the source of truth used during the drop.
 */
const dragTracker: { id: string | null; type: 'db' | 'storage' | null } = {
  id: null,
  type: null,
};
/** Epoch-ms of the last dragEnd. Used to suppress the synthetic click that
 *  WebKit/Tauri can fire right after a drag completes. */
let lastDragEndAt = 0;

function formatBytes(bytes?: number | null): string {
  if (!bytes || typeof bytes !== 'number' || bytes <= 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getSizeColorClass(bytes?: number | null): string {
  if (!bytes || typeof bytes !== 'number' || bytes <= 0) return 'bg-[#1e293b] text-slate-400';
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20';
  if (mb < 1024) return 'bg-amber-500/15 text-amber-400 border border-amber-500/20';
  return 'bg-rose-500/20 text-rose-400 border border-rose-500/30 font-bold';
}

/**
 * Position a context menu at the click point, but clamp it so it never
 * overflows the viewport. Measures the *actual* rendered menu height (via a ref)
 * so the clamp is tight — the menu stays right at the cursor unless it would
 * genuinely get cropped, instead of jumping away due to a guessed max height.
 *
 * Returns a ref to attach to the menu div, and the computed {top, left} style.
 */
function useClampedMenuPosition(
  clickX: number,
  clickY: number,
  menuWidth: number
): { ref: React.RefObject<HTMLDivElement | null>; style: { top: number; left: number } } {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: clickY, left: clickX });

  useLayoutEffect(() => {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Measure the real rendered height; fall back to a safe estimate only if
    // the ref isn't ready yet (first paint).
    const measuredH = ref.current?.offsetHeight ?? 0;
    const w = ref.current?.offsetWidth ?? menuWidth;

    // Horizontal: keep at cursor unless it would overflow the right edge.
    const left = clickX + w + margin > vw ? Math.max(margin, vw - w - margin) : clickX;

    // Vertical: keep at cursor unless it would overflow the bottom edge — then
    // shift up by the menu's own height (not a guessed maximum).
    const overflow = clickY + measuredH + margin - vh;
    const top = overflow > 0 ? Math.max(margin, clickY - overflow) : clickY;

    setPos({ top, left });
  }, [clickX, clickY, menuWidth]);

  return { ref, style: pos };
}

/**
 * A thin wrapper component that applies the clamped-position hook. Each context
 * menu uses this so the clamping logic lives in one place and the menu stays
 * anchored to the click point as closely as possible.
 */
const ClampedContextMenu: React.FC<{
  clickX: number;
  clickY: number;
  menuWidth: number;
  className?: string;
  children: React.ReactNode;
}> = ({ clickX, clickY, menuWidth, className, children }) => {
  const { ref, style } = useClampedMenuPosition(clickX, clickY, menuWidth);
  return (
    <div
      ref={ref}
      style={style}
      className={className}
    >
      {children}
    </div>
  );
};

/**
 * A hover-open fly-out submenu anchored to the right edge of its trigger row.
 * The codebase has no nested-menu pattern, so this is self-contained: it
 * measures the trigger's bounding rect on hover and positions a fixed panel to
 * its right (clamped to the viewport), exactly like a native context submenu.
 *
 * The trigger is rendered inline (so it sits in the parent menu's flow), and
 * the panel is portaled to the document body so it can overflow the parent
 * menu's rounded/clipped container.
 */
const ContextSubMenu: React.FC<{
  /** Label + icon for the parent row. */
  label: string;
  icon: React.ReactNode;
  /** Render-prop for the fly-out items. Each item should call its action and
   *  then close the parent menu (the caller owns that state). */
  children: (close: () => void) => React.ReactNode;
  /** Width of the fly-out panel. */
  panelWidth?: number;
  /** Tone color for the trigger row icon/text. */
  tone?: string;
}> = ({ label, icon, children, panelWidth = 200, tone = 'text-blue-400' }) => {
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Recompute panel position whenever it opens — read the trigger rect and
  // clamp the panel to the viewport so it never overflows.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const panelW = panelWidth;
    const margin = 8;
    const vw = window.innerWidth;
    // If there's room to the right, place it there; otherwise flip to the left
    // of the trigger so the panel stays on screen.
    const left = trigger.right + margin + panelW > vw
      ? Math.max(margin, trigger.left - panelW - margin)
      : trigger.right + margin;
    const top = Math.max(margin, trigger.top);
    setPos({ top, left });
  }, [open, panelWidth]);

  // Close on outside click / scroll — mirrors the parent menu's dismiss.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={(e) => {
          // Only close if the cursor truly left both the trigger and the panel.
          const related = e.relatedTarget as Node | null;
          if (panelRef.current && related && panelRef.current.contains(related)) return;
          setOpen(false);
        }}
        className={`w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium cursor-default ${tone} ${open ? 'bg-[#141e33]' : ''}`}
      >
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
      </div>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: panelWidth }}
          className="z-[60] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          {children(() => setOpen(false))}
        </div>,
        document.body
      )}
    </>
  );
};

/**
 * Reusable expandable tree folder — a chevron + icon + label + count header
 * that reveals `children` in a consistently-indented container. Used for every
 * category level (Schemas, Tables, Views, …) so the tree's alignment and
 * ordering come from one place. The expand state is owned by the caller
 * (Explorer's `expandedNodeKeys`) and passed in as `expanded`/`onToggle`, so
 * the component itself is stateless and doesn't remount its subtree.
 */
const TreeFolder: React.FC<{
  expanded: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: React.ReactNode;
  count?: number | null;
  children?: React.ReactNode;
  /** Optional context-menu handler attached to the header row (e.g. the
   *  Extensions folder's right-click → Manage / Refresh). */
  onHeaderContextMenu?: (e: React.MouseEvent) => void;
}> = ({ expanded, onToggle, icon, label, count, children, onHeaderContextMenu }) => (
  <div>
    <button
      onClick={onToggle}
      onContextMenu={onHeaderContextMenu}
      className="w-full flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[12px] text-slate-500 hover:bg-white/5 hover:text-slate-200 transition-all"
    >
      {expanded ? (
        <ChevronDown className="w-3 h-3 text-slate-600 shrink-0" />
      ) : (
        <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />
      )}
      {icon}
      <span className="truncate flex-1 text-left font-medium">{label}</span>
      {count != null && <span className="text-[10px] text-slate-600 font-mono shrink-0">{count}</span>}
    </button>
    {expanded && (
      <div className="ml-2 pl-1.5 border-l border-white/5 flex flex-col gap-0.5 mt-0.5">{children}</div>
    )}
  </div>
);

/** One leaf row inside a lazy folder (trigger / procedure / event / …):
 *  icon + name + optional trailing node. `onOpen` fires on both click and
 *  right-click — both open the row's context menu, matching the prior inline
 *  behavior. */
const ObjectLeafRow: React.FC<{
  icon: React.ReactNode;
  name: string;
  trailing?: React.ReactNode;
  onOpen: (e: React.MouseEvent) => void;
}> = ({ icon, name, trailing, onOpen }) => (
  <button
    onClick={(e) => { e.preventDefault(); onOpen(e); }}
    onContextMenu={(e) => { e.preventDefault(); onOpen(e); }}
    className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-[11px] text-slate-400 hover:bg-white/5 hover:text-slate-100 text-left"
  >
    {icon}
    <span className="truncate">{name}</span>
    {trailing}
  </button>
);

/** A lazily-loaded object folder built on `TreeFolder`: it shows the folder
 *  header (with a count once loaded) and, when expanded, the standard
 *  loading / error / pgcron-missing / empty states plus the caller-supplied
 *  item rows. Collapses ~120 lines of triplicated markup per object type into
 *  one declarative component. */
type LazyStatus = 'loading' | 'loaded' | 'error' | 'pgcron-missing';
const LazyTreeFolder: React.FC<{
  expanded: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: React.ReactNode;
  status: LazyStatus;
  itemCount: number;
  emptyLabel: string;
  error?: string;
  children?: React.ReactNode;
  /** Optional context-menu handler attached to the header row (Create / Refresh). */
  onHeaderContextMenu?: (e: React.MouseEvent) => void;
}> = ({ expanded, onToggle, icon, label, status, itemCount, emptyLabel, error, children, onHeaderContextMenu }) => (
  <TreeFolder
    expanded={expanded}
    onToggle={onToggle}
    icon={icon}
    label={label}
    count={status === 'loaded' ? itemCount : null}
    onHeaderContextMenu={onHeaderContextMenu}
  >
    {status === 'loading' && (
      <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-slate-600">
        <RefreshCw className="w-3 h-3 animate-spin" /> Loading…
      </div>
    )}
    {status === 'error' && (
      <div className="px-1 py-0.5 text-[10.5px] text-red-400 truncate" title={error}>{error}</div>
    )}
    {status === 'pgcron-missing' && (
      <div className="px-1 py-0.5 text-[10.5px] text-slate-500 italic leading-relaxed">
        Requires the <span className="font-mono not-italic">pg_cron</span> extension —
        ask a database admin to run <span className="font-mono not-italic">CREATE EXTENSION pg_cron;</span>
      </div>
    )}
    {status === 'loaded' && itemCount === 0 && (
      <div className="px-1 py-0.5 text-[10.5px] text-slate-600 italic">{emptyLabel}</div>
    )}
    {status === 'loaded' && itemCount > 0 && children}
  </TreeFolder>
);

function getColumnTypeIcon(dataType?: string) {
  if (!dataType) return <Columns className="w-3 h-3 text-slate-500" />;
  const dt = dataType.toLowerCase();
  if (dt.includes('int') || dt.includes('num') || dt.includes('decimal') || dt.includes('double') || dt.includes('float')) {
    return <Hash className="w-3 h-3 text-amber-400" />;
  }
  if (dt.includes('date') || dt.includes('time') || dt.includes('stamp')) {
    return <Calendar className="w-3 h-3 text-cyan-400" />;
  }
  if (dt.includes('bool')) {
    return <ToggleLeft className="w-3 h-3 text-purple-400" />;
  }
  return <Type className="w-3 h-3 text-blue-400" />;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const Explorer: React.FC = () => {
  const {
    connections,
    activeConnectionId,
    setActiveConnection,
    setActiveDatabase,
    activeDatabaseByConn,
    deleteConnection,
    saveConnection,
    setConnectionTag: storeSetConnectionTag,
    moveConnection,
    setConnectionModalOpen,
    openEditConnection,
    toggleFavorite,
    pinnedSchemasByConn,
    togglePinnedSchema,
    unpinAll,
  } = useConnectionStore();

  const {
    tags,
    tagOrder,
    expandedFolders,
    collapsedUntagged,
    toggleFolder,
    setCollapsedUntagged,
    updateTag,
    deleteTag,
  } = useTagStore();

  const { openTableDataTab, openSqlTab, openErdTab, openUsersTab, openStorageTab, openRedisBrowserTab, openMongoDocumentsTab, openObjectEditorTab } = useTabStore();
  const { setActiveView, toggleSidebar, openEncryptedConnectionsModal, setSettingsModalOpen } = useWorkspaceStore();
  // Real reachability of the active connection (polled by StatusBar via
  // `pingConnection`) — 'connected' is the only state that should light the
  // green dot. Being merely *selected* doesn't mean the server actually
  // answered the last health check.
  const connStatus = useHealthStore((s) => s.connStatus);
  const showSystemSchemas = useSettingsStore((s) => s.showSystemSchemas);
  const setShowSystemSchemas = useSettingsStore((s) => s.setShowSystemSchemas);
  const showRowCounts = useSettingsStore((s) => s.showRowCounts);
  const setShowRowCounts = useSettingsStore((s) => s.setShowRowCounts);
  const showTableSizes = useSettingsStore((s) => s.showTableSizes);
  const setShowTableSizes = useSettingsStore((s) => s.setShowTableSizes);
  const cloudConfigured = useAuthStore((s) => s.cloudConfigured);
  const authStatus = useAuthStore((s) => s.status);
  const syncStatus = useSyncStore((s) => s.status);
  const syncError = useSyncStore((s) => s.error);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const syncConflicts = useSyncStore((s) => s.conflicts);
  const syncNow = useSyncStore((s) => s.syncNow);
  const storageConnections = useStorageStore((s) => s.connections);
  const activeStorageConnectionId = useStorageStore((s) => s.activeConnectionId);
  const setActiveStorageConnection = useStorageStore((s) => s.setActiveConnection);
  const deleteStorageConnection = useStorageStore((s) => s.deleteConnection);
  const setStorageConnectionTag = useStorageStore((s) => s.setConnectionTag);
  const moveStorageConnection = useStorageStore((s) => s.moveConnection);
  // Storage edit dialog state (mirrors StorageConnectionsPanel so the Explorer
  // can edit S3 connections without jumping to the Storage view).
  const [editingStorage, setEditingStorage] = useState<S3ConnectionConfig | null>(null);
  const [storageDialogOpen, setStorageDialogOpen] = useState(false);

  const [filterQuery, setFilterQuery] = useState('');

  // Tag UI state
  const [createTagOpen, setCreateTagOpen] = useState(false);
  const [createTagForConn, setCreateTagForConn] = useState<string | null>(null);
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  // Global Explorer context menu — right-click on the empty tree area.
  const [explorerCtxMenu, setExplorerCtxMenu] = useState<{ mouseX: number; mouseY: number } | null>(null);
  // Folder (tag) context menu
  const [folderContextMenu, setFolderContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    tag: ConnectionTag | null; // null = "Other" untagged bucket
  } | null>(null);
  // Inline tag-edit modal state (rename/recolor)
  const [editingTag, setEditingTag] = useState<ConnectionTag | null>(null);
  // Drag state for connection→folder assignment
  const [dragConnId, setDragConnId] = useState<string | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  
  // Redis has no SQL schema tree — seeding it as "expanded" would render the
  // generic "No schemas or tables found" block against an always-empty
  // connTrees entry (Redis populates its own `redisKeyspace` state instead;
  // see the dedicated Databases-tree render branch below).
  const [expandedConnIds, setExpandedConnIds] = useState<Set<string>>(() => {
    const seed = activeConnectionId ? [activeConnectionId] : connections.slice(0, 1).map((c) => c.id);
    const first = connections.find((c) => seed.includes(c.id));
    return new Set(first && isRedisEngine(first.engine) ? [] : seed);
  });

  const [expandedNodeKeys, setExpandedNodeKeys] = useState<Set<string>>(new Set());

  const [connTrees, setConnTrees] = useState<Record<string, SchemaGroupNode[]>>({});
  const [loadingConnIds, setLoadingConnIds] = useState<Set<string>>(new Set());
  // Tracks which connections' last `fetch_schema_tree` call failed, so the
  // empty-tree render branch can tell "genuinely no schemas" apart from
  // "couldn't reach the database" instead of showing the same misleading
  // "No schemas or tables found" text for both.
  const [connTreeErrors, setConnTreeErrors] = useState<Record<string, string>>({});

  // Redis's "Databases" tree branch — kept separate from `connTrees` (which
  // is typed for the SQL SchemaGroupNode/SchemaTableNode shape) since Redis
  // has no schema/table model at all, just logical DB indexes + key counts.
  const [redisKeyspace, setRedisKeyspace] = useState<Record<string, RedisDbInfo[]>>({});
  const [redisKeyspaceLoading, setRedisKeyspaceLoading] = useState<Set<string>>(new Set());
  // The "Databases" header nested under a Redis connection is its own
  // collapsible node (16 DB rows is a lot to always show) — collapsed by
  // default, independent of whether the connection row itself is expanded.
  const [redisDbBranchExpanded, setRedisDbBranchExpanded] = useState<Set<string>>(new Set());

  // Right-Click Context Menu State
  const [tableContextMenu, setTableContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    table: SchemaTableNode;
    conn: DatabaseConnection;
    group: SchemaGroupNode;
  } | null>(null);

  // Right-Click Context Menu State for Database/Schema Group Nodes
  const [groupContextMenu, setGroupContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    group: SchemaGroupNode;
    conn: DatabaseConnection;
  } | null>(null);

  // Right-Click Context Menu State for Connection Nodes
  const [connContextMenu, setConnContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    conn: DatabaseConnection;
  } | null>(null);

  // Right-Click Context Menu State for Storage Connection Nodes
  const [storageContextMenu, setStorageContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    conn: S3ConnectionConfig;
  } | null>(null);

  // Header "+" add-dropdown open state
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // Field Info & Structure Modal State
  const [structureCtx, setStructureCtx] = useState<{
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    table: SchemaTableNode;
  } | null>(null);

  // Create Database / Backup / Restore Modal State
  const [createDbConn, setCreateDbConn] = useState<DatabaseConnection | null>(null);
  const [createTableCtx, setCreateTableCtx] = useState<{ conn: DatabaseConnection; schemaName?: string } | null>(null);

  // MongoDB-specific modal state: stats (collection or database), new
  // collection, drop collection, drop database. Kept separate from the SQL
  // ctx state above rather than overloading it, since Mongo's admin surface
  // (no DDL, run_command-based stats) doesn't fit the same shapes.
  const [mongoStatsCtx, setMongoStatsCtx] = useState<{ conn: DatabaseConnection; database: string; collectionName?: string } | null>(null);
  const [mongoCreateCollectionCtx, setMongoCreateCollectionCtx] = useState<{ conn: DatabaseConnection; database: string } | null>(null);
  const [mongoDropCollectionCtx, setMongoDropCollectionCtx] = useState<{ conn: DatabaseConnection; database: string; collectionName: string } | null>(null);
  const [mongoDropDatabaseCtx, setMongoDropDatabaseCtx] = useState<{ conn: DatabaseConnection; database: string } | null>(null);
  const [mongoActionBusy, setMongoActionBusy] = useState(false);
  const [mongoActionError, setMongoActionError] = useState<string | null>(null);

  // Triggers folder — lazily loaded per schema/database group (keyed by the
  // same `groupKey` used for tree expand state) so connections that never
  // touch this folder never pay the extra round trip.
  const [triggerFolders, setTriggerFolders] = useState<Record<string, {
    status: 'loading' | 'loaded' | 'error';
    items: TriggerListItem[];
    error?: string;
  }>>({});
  const [triggerItemMenu, setTriggerItemMenu] = useState<{
    mouseX: number;
    mouseY: number;
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    trigger: TriggerListItem;
    groupKey: string;
  } | null>(null);
  const [dropTriggerCtx, setDropTriggerCtx] = useState<{
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    trigger: TriggerListItem;
    groupKey: string;
  } | null>(null);
  const [dropTriggerAlsoFunction, setDropTriggerAlsoFunction] = useState(true);
  const [dropTriggerRunning, setDropTriggerRunning] = useState(false);

  // Procedures folder — same lazy-load-per-group shape as Triggers above.
  const [procedureFolders, setProcedureFolders] = useState<Record<string, {
    status: 'loading' | 'loaded' | 'error';
    items: ProcedureListItem[];
    error?: string;
  }>>({});
  const [procedureItemMenu, setProcedureItemMenu] = useState<{
    mouseX: number;
    mouseY: number;
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    procedure: ProcedureListItem;
    groupKey: string;
  } | null>(null);
  const [dropProcedureCtx, setDropProcedureCtx] = useState<{
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    procedure: ProcedureListItem;
    groupKey: string;
  } | null>(null);
  const [dropProcedureRunning, setDropProcedureRunning] = useState(false);

  // Events folder — same lazy-load-per-group shape as Triggers/Procedures.
  // Postgres uses `PGCRON_NOT_INSTALLED` as a distinct folder status so the UI
  // can explain *why* it's empty instead of showing a scary error banner.
  const [eventFolders, setEventFolders] = useState<Record<string, {
    status: 'loading' | 'loaded' | 'error' | 'pgcron-missing';
    items: EventListItem[];
    error?: string;
  }>>({});
  const [eventItemMenu, setEventItemMenu] = useState<{
    mouseX: number;
    mouseY: number;
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    event: EventListItem;
    groupKey: string;
  } | null>(null);
  const [dropEventCtx, setDropEventCtx] = useState<{
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    event: EventListItem;
    groupKey: string;
  } | null>(null);
  const [dropEventRunning, setDropEventRunning] = useState(false);
  // Postgres-only: installed-extensions directory (top-level under a connection).
  const [extensionFolders, setExtensionFolders] = useState<Record<string, {
    status: 'loading' | 'loaded' | 'error';
    items: ExtensionItem[];
    error?: string;
  }>>({});
  // Extensions-folder context menu + manage-extensions modal.
  const [extFolderMenu, setExtFolderMenu] = useState<{ mouseX: number; mouseY: number; conn: DatabaseConnection; key: string } | null>(null);
  // Category-folder context menu (Tables / Views / Triggers / Functions·Procedures / Events
  // headers) — Create <type>… + Refresh, mirroring the Extensions folder menu above.
  const [categoryFolderMenu, setCategoryFolderMenu] = useState<{
    mouseX: number;
    mouseY: number;
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    groupKey: string;
    kind: 'table' | 'view' | 'trigger' | 'procedure' | 'event';
  } | null>(null);
  const [manageExtConn, setManageExtConn] = useState<DatabaseConnection | null>(null);
  const [backupConn, setBackupConn] = useState<DatabaseConnection | null>(null);
  const [backupGroupName, setBackupGroupName] = useState<string | undefined>(undefined);
  const [restoreConn, setRestoreConn] = useState<DatabaseConnection | null>(null);

  // Table actions (run directly from the context menu).
  // `tableActionCtx` holds the table the confirmation/maintenance dialog is for.
  const [tableActionCtx, setTableActionCtx] = useState<{
    conn: DatabaseConnection;
    group: SchemaGroupNode;
    table: SchemaTableNode;
  } | null>(null);
  // Which destructive/maintenance action is pending confirmation.
  const [pendingAction, setPendingAction] = useState<'drop' | 'truncate' | 'deleteAll' | 'reset' | MaintenanceOp | null>(null);
  const [actionRunning, setActionRunning] = useState(false);
  // Auto-increment metadata for the reset dialog.
  const [autoIncMeta, setAutoIncMeta] = useState<AutoIncrementMeta | null | undefined>(undefined);
  const [autoIncError, setAutoIncError] = useState<string | null>(null);
  const [resetNextValue, setResetNextValue] = useState('1');

  // Database / schema group actions (drop database/schema, empty database).
  const [dbActionCtx, setDbActionCtx] = useState<{
    conn: DatabaseConnection;
    group: SchemaGroupNode;
  } | null>(null);
  const [pendingDbAction, setPendingDbAction] = useState<'dropDb' | 'emptyDb' | null>(null);
  const [dbActionRunning, setDbActionRunning] = useState(false);

  useEffect(() => {
    const handleCloseMenu = () => {
      setTableContextMenu(null);
      setGroupContextMenu(null);
      setConnContextMenu(null);
      setStorageContextMenu(null);
      setFolderContextMenu(null);
      setExplorerCtxMenu(null);
      setTriggerItemMenu(null);
      setProcedureItemMenu(null);
      setEventItemMenu(null);
      setExtFolderMenu(null);
      setCategoryFolderMenu(null);
      setAddMenuOpen(false);
    };
    window.addEventListener('click', handleCloseMenu);
    return () => window.removeEventListener('click', handleCloseMenu);
  }, []);

  useEffect(() => {
    if (!activeConnectionId || expandedConnIds.has(activeConnectionId)) return;
    // Collapsed-by-default only applies to the initial mount seed above —
    // once the user actually selects a connection (Redis included), expand
    // it the same way every other engine does so its tree/Databases branch
    // is visible without a second click.
    setExpandedConnIds((prev) => new Set(prev).add(activeConnectionId));
  }, [activeConnectionId, connections]);

  useEffect(() => {
    expandedConnIds.forEach((connId) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn || isRedisEngine(conn.engine)) return; // handled by the redisKeyspace effect below
      if (!connTrees[connId] && !loadingConnIds.has(connId)) {
        loadSchemaForConnection(conn);
      }
    });
  }, [expandedConnIds, connections]);

  useEffect(() => {
    expandedConnIds.forEach((connId) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn || !isRedisEngine(conn.engine)) return;
      if (!redisKeyspace[connId] && !redisKeyspaceLoading.has(connId)) {
        loadRedisKeyspace(conn);
      }
    });
  }, [expandedConnIds, connections]);

  const loadRedisKeyspace = async (conn: DatabaseConnection) => {
    setRedisKeyspaceLoading((prev) => new Set(prev).add(conn.id));
    try {
      const dbs = await safeInvoke<RedisDbInfo[]>('redis_keyspace_info', { config: conn });
      setRedisKeyspace((prev) => ({ ...prev, [conn.id]: dbs || [] }));
    } catch {
      // Leave it unset — the render branch below shows "0 keys" for every DB
      // slot in that case rather than a scary error state for what's usually
      // a transient/permission hiccup on a purely informational call.
    } finally {
      setRedisKeyspaceLoading((prev) => {
        const next = new Set(prev);
        next.delete(conn.id);
        return next;
      });
    }
  };

  const loadSchemaForConnection = async (conn: DatabaseConnection) => {
    setLoadingConnIds((prev) => new Set(prev).add(conn.id));
    try {
      const tree = await safeInvoke<SchemaGroupNode[]>('fetch_schema_tree', {
        config: { ...conn, includeSystemSchemas: conn.showSystemSchemas ?? showSystemSchemas },
      });
      setConnTrees((prev) => ({ ...prev, [conn.id]: tree || [] }));
      setConnTreeErrors((prev) => {
        if (!(conn.id in prev)) return prev;
        const next = { ...prev };
        delete next[conn.id];
        return next;
      });
      // Mirror into the shared per-connection store cache so the SQL editor's
      // autocomplete (and anything else) sees the same fresh data the Explorer
      // just loaded — no separate fetch needed.
      useConnectionStore.getState().setSchemaTreeForConn(conn.id, tree || []);
      // Auto-expand the first schema/database group so tables are visible immediately.
      if (tree && tree.length > 0) {
        setExpandedNodeKeys((prev) =>
          new Set(prev).add(`${conn.id}-${tree[0].name}`)
        );
        // Postgres nests schemas under a "Schemas" directory — expand that too,
        // otherwise the auto-expanded first schema stays hidden inside it.
        if (isPostgresFamily(conn.engine)) {
          setExpandedNodeKeys((prev) => new Set(prev).add(`${conn.id}-__schemas`));
        }
      }
      // If the structure modal is open for this connection, re-derive the
      // table node from the fresh tree so added/modified columns appear live.
      if (tree && structureCtx && structureCtx.conn.id === conn.id) {
        const freshGroup = tree.find((g) => g.name === structureCtx.group.name);
        const freshTable = freshGroup?.children.find((t) => t.name === structureCtx.table.name);
        if (freshTable) {
          setStructureCtx({
            conn: structureCtx.conn,
            group: freshGroup || structureCtx.group,
            table: freshTable,
          });
        }
      }
    } catch (err: any) {
      console.error(`Failed to fetch schema for ${conn.name}:`, err);
      const message = err?.message || String(err);
      setConnTrees((prev) => ({ ...prev, [conn.id]: [] }));
      setConnTreeErrors((prev) => ({ ...prev, [conn.id]: message }));
      pushDedupedToast(`schema-fetch-failed-${conn.id}`, {
        severity: 'error',
        title: `Couldn't load schema for ${conn.name}`,
        message,
      });
    } finally {
      setLoadingConnIds((prev) => {
        const next = new Set(prev);
        next.delete(conn.id);
        return next;
      });
    }
  };

  const toggleExpandConn = (connId: string) => {
    setExpandedConnIds((prev) => {
      const next = new Set(prev);
      if (next.has(connId)) {
        next.delete(connId);
      } else {
        next.add(connId);
      }
      return next;
    });
  };

  const toggleExpandNode = (key: string) => {
    setExpandedNodeKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleSelectConnection = (conn: DatabaseConnection) => {
    setActiveConnection(conn.id);
    if (!expandedConnIds.has(conn.id)) {
      toggleExpandConn(conn.id);
    }
  };

  // Disconnect is a client-side concept (the backend opens a fresh connection
  // per query, so there is no pool to close). It clears the active connection,
  // drops the cached schema tree, forgets the selected database, and collapses
  // the row — returning the explorer to a "not connected" state for this entry.
  const handleDisconnect = (conn: DatabaseConnection) => {
    if (activeConnectionId === conn.id) {
      setActiveConnection(null);
    }
    setActiveDatabase(conn.id, '');
    setConnTrees((prev) => {
      if (!prev[conn.id]) return prev;
      const next = { ...prev };
      delete next[conn.id];
      return next;
    });
    setExpandedConnIds((prev) => {
      const next = new Set(prev);
      next.delete(conn.id);
      return next;
    });
  };

  const handleDuplicateConnection = (conn: DatabaseConnection) => {
    const copy: DatabaseConnection = {
      ...conn,
      id: `conn_${Date.now()}`,
      name: `${conn.name} (Copy)`,
      isFavorite: false,
    };
    saveConnection(copy);
  };

  const dropMongoCollection = async () => {
    if (!mongoDropCollectionCtx) return;
    setMongoActionBusy(true);
    setMongoActionError(null);
    try {
      await safeInvoke('mongo_drop_collection', {
        config: mongoDropCollectionCtx.conn,
        database: mongoDropCollectionCtx.database,
        collectionName: mongoDropCollectionCtx.collectionName,
      });
      await loadSchemaForConnection(mongoDropCollectionCtx.conn);
      setMongoDropCollectionCtx(null);
    } catch (err: any) {
      setMongoActionError(err?.message || String(err));
    } finally {
      setMongoActionBusy(false);
    }
  };

  const dropMongoDatabase = async () => {
    if (!mongoDropDatabaseCtx) return;
    setMongoActionBusy(true);
    setMongoActionError(null);
    try {
      await safeInvoke('mongo_drop_database', { config: mongoDropDatabaseCtx.conn, database: mongoDropDatabaseCtx.database });
      await loadSchemaForConnection(mongoDropDatabaseCtx.conn);
      setMongoDropDatabaseCtx(null);
    } catch (err: any) {
      setMongoActionError(err?.message || String(err));
    } finally {
      setMongoActionBusy(false);
    }
  };

  const handleTableClick = (conn: DatabaseConnection, tableName: string, schemaName: string) => {
    setActiveConnection(conn.id);
    // The table lives in `schemaName` (the database it was expanded under), so pin
    // it as the active database before opening the tab — otherwise executeQuery
    // falls back to the connection's default database and queries the wrong DB.
    if (schemaName) {
      setActiveDatabase(conn.id, schemaName);
    }
    // MongoDB's tree has the same database → collection shape as a SQL
    // engine's database → table shape, but a "table" node here is really a
    // collection — open the document browser instead of the SQL table grid.
    if (isMongoEngine(conn.engine)) {
      openMongoDocumentsTab(schemaName, tableName, conn.id);
    } else {
      openTableDataTab(tableName, schemaName, conn.id);
    }
    // Switch to the tab view so the newly opened/activated tab is visible,
    // even when the user was in another workspace (migration, health, etc.).
    setActiveView('explorer');
  };

  const handleTableContextMenu = (
    e: React.MouseEvent,
    conn: DatabaseConnection,
    table: SchemaTableNode,
    group: SchemaGroupNode
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveConnection(conn.id);
    setTableContextMenu({
      mouseX: e.clientX,
      mouseY: e.clientY,
      conn,
      table,
      group,
    });
  };

  const handleConnContextMenu = (e: React.MouseEvent, conn: DatabaseConnection) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveConnection(conn.id);
    setConnContextMenu({
      mouseX: e.clientX,
      mouseY: e.clientY,
      conn,
    });
  };

  const handleGroupContextMenu = (
    e: React.MouseEvent,
    conn: DatabaseConnection,
    group: SchemaGroupNode
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveConnection(conn.id);
    setGroupContextMenu({
      mouseX: e.clientX,
      mouseY: e.clientY,
      conn,
      group,
    });
  };

  const handleShowRelationshipDiagram = (conn: DatabaseConnection, group: SchemaGroupNode) => {
    openErdTab({
      connectionId: conn.id,
      connectionName: conn.name,
      schemaName: group.name,
      tables: group.children,
    });
    setActiveView('explorer');
    setGroupContextMenu(null);
  };

  const handleFocusInErd = (conn: DatabaseConnection, group: SchemaGroupNode, table: SchemaTableNode) => {
    openErdTab({
      connectionId: conn.id,
      connectionName: conn.name,
      schemaName: group.name,
      tables: group.children,
      focusTableName: table.name,
    });
    setActiveView('explorer');
    setTableContextMenu(null);
  };

  // ── Table actions (run directly from the context menu) ──────────────
  const pushToast = useToastStore.getState().push;

  // Build a connection config with the correct target database resolved for the
  // group/schema the table lives in. MySQL group nodes ARE databases — without
  // this override the backend connects to the connection's default (or no)
  // database and MySQL replies "No database selected". Postgres group nodes are
  // schemas, so `resolveTargetDatabase` correctly keeps the connection's DB.
  const resolveConnConfig = (
    conn: DatabaseConnection,
    groupOrSchema?: string
  ): DatabaseConnection => {
    const targetDb = resolveTargetDatabase(conn.engine, conn.database, groupOrSchema);
    return targetDb && targetDb !== conn.database ? { ...conn, database: targetDb } : conn;
  };

  // `isSqliteFamily` falls back to true for ANY engine `engineFamily()` doesn't
  // recognize (see its doc comment) — MongoDB hits that default, so it must be
  // excluded explicitly here or the Explorer tree offers a "Triggers" folder
  // for Mongo databases that then fails against `fetchSchemaTriggersSqlite`
  // (which needs `filePath`, always empty for Mongo).
  const supportsTriggers = (engine: string) =>
    !isMongoEngine(engine) && (isPostgresFamily(engine) || isMysqlFamily(engine) || isSqliteFamily(engine));

  const loadTriggersForGroup = (conn: DatabaseConnection, group: SchemaGroupNode, groupKey: string, force = false) => {
    if (!force && triggerFolders[groupKey]?.status === 'loaded') return;
    setTriggerFolders((prev) => ({ ...prev, [groupKey]: { status: 'loading', items: prev[groupKey]?.items || [] } }));
    fetchSchemaTriggers({ config: resolveConnConfig(conn, group.name), engine: conn.engine, schema: group.name })
      .then((items) => {
        setTriggerFolders((prev) => ({ ...prev, [groupKey]: { status: 'loaded', items } }));
      })
      .catch((err: any) => {
        setTriggerFolders((prev) => ({
          ...prev,
          [groupKey]: { status: 'error', items: [], error: err?.message || String(err) },
        }));
      });
  };

  // Stored procedures aren't a SQLite/D1 concept at all — Postgres + MySQL only.
  const supportsProcedures = (engine: string) => isPostgresFamily(engine) || isMysqlFamily(engine);

  const loadProceduresForGroup = (conn: DatabaseConnection, group: SchemaGroupNode, groupKey: string, force = false) => {
    if (!force && procedureFolders[groupKey]?.status === 'loaded') return;
    setProcedureFolders((prev) => ({ ...prev, [groupKey]: { status: 'loading', items: prev[groupKey]?.items || [] } }));
    fetchSchemaProcedures({ config: resolveConnConfig(conn, group.name), engine: conn.engine, schema: group.name })
      .then((items) => {
        setProcedureFolders((prev) => ({ ...prev, [groupKey]: { status: 'loaded', items } }));
      })
      .catch((err: any) => {
        setProcedureFolders((prev) => ({
          ...prev,
          [groupKey]: { status: 'error', items: [], error: err?.message || String(err) },
        }));
      });
  };

  // Postgres-only: installed extensions directory at the connection level.
  const loadExtensionsForConn = (conn: DatabaseConnection, key: string, force = false) => {
    if (!force && extensionFolders[key]?.status === 'loaded') return;
    setExtensionFolders((prev) => ({ ...prev, [key]: { status: 'loading', items: prev[key]?.items || [] } }));
    fetchExtensions(resolveConnConfig(conn, undefined), conn.engine)
      .then((items) => setExtensionFolders((prev) => ({ ...prev, [key]: { status: 'loaded', items } })))
      .catch((err: any) => setExtensionFolders((prev) => ({ ...prev, [key]: { status: 'error', items: [], error: err?.message || String(err) } })));
  };

  // Events: MySQL native scheduler + Postgres via pg_cron — never SQLite/D1.
  const supportsEvents = (engine: string) => isPostgresFamily(engine) || isMysqlFamily(engine);

  const loadEventsForGroup = (conn: DatabaseConnection, group: SchemaGroupNode, groupKey: string, force = false) => {
    if (!force && eventFolders[groupKey]?.status === 'loaded') return;
    setEventFolders((prev) => ({ ...prev, [groupKey]: { status: 'loading', items: prev[groupKey]?.items || [] } }));
    fetchSchemaEvents({ config: resolveConnConfig(conn, group.name), engine: conn.engine, schema: group.name })
      .then((items) => {
        setEventFolders((prev) => ({ ...prev, [groupKey]: { status: 'loaded', items } }));
      })
      .catch((err: any) => {
        const msg = err?.message || String(err);
        setEventFolders((prev) => ({
          ...prev,
          [groupKey]: msg === PGCRON_NOT_INSTALLED
            ? { status: 'pgcron-missing', items: [] }
            : { status: 'error', items: [], error: msg },
        }));
      });
  };

  // ── Create / Edit objects in a structured object-editor tab (HeidiSQL-style:
  //    name field + metadata + body + Save button, rendered in the workspace,
  //    not a modal and not the generic SQL editor). CREATE seeds engine-correct
  //    defaults; EDIT loads the live definition into the form. The tab is bound
  //    to the connection + schema so Save runs the DDL against the right DB.
  const openCreateObjectTab = (conn: DatabaseConnection, schemaName: string | undefined, kind: ObjectKind, table?: string) => {
    openObjectEditorTab(kind, 'create', conn.id, schemaName, undefined, table);
  };

  const openEditObjectTab = (conn: DatabaseConnection, schemaName: string | undefined, kind: ObjectKind, name: string, table?: string) => {
    openObjectEditorTab(kind, 'edit', conn.id, schemaName, name, table);
  };

  // Signal any open data-grid tab for a table to reload its rows + count after
  // a destructive operation (truncate / delete-all). TableDataView listens for
  // this event and re-queries.
  const reloadOpenTableTab = (connectionId: string, tableName: string) => {
    window.dispatchEvent(
      new CustomEvent('rdsql:reload-table-data', { detail: { connectionId, tableName } })
    );
  };

  // Refresh the relevant Explorer folder after an object is saved from the
  // structured object-editor tab (which can't call load*ForGroup directly —
  // it lives outside the Explorer). Views live in the schema tree itself, so
  // those trigger a full tree reload; triggers/procedures/events reload just
  // their folder. Best-effort: ignores events for connections/groups that
  // aren't currently expanded.
  useEffect(() => {
    const handler = (e: Event) => {
      const { kind, connectionId, schemaName } = (e as CustomEvent).detail || {};
      if (!connectionId || !schemaName) return;
      const conn = connections.find((c) => c.id === connectionId);
      if (!conn) return;
      const group: SchemaGroupNode = { name: schemaName, node_type: 'schema', children: [] };
      if (kind === 'view') {
        loadSchemaForConnection(conn);
        return;
      }
      if (kind === 'trigger') loadTriggersForGroup(conn, group, `${connectionId}-${schemaName}-__triggers`, true);
      else if (kind === 'procedure') loadProceduresForGroup(conn, group, `${connectionId}-${schemaName}-__procedures`, true);
      else if (kind === 'event') loadEventsForGroup(conn, group, `${connectionId}-${schemaName}-__events`, true);
    };
    window.addEventListener('rdsql:refresh-object-folder', handler);
    return () => window.removeEventListener('rdsql:refresh-object-folder', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

  const runTableSql = async (
    conn: DatabaseConnection,
    schema: string,
    sql: string,
    label: string
  ): Promise<boolean> => {
    setActionRunning(true);
    const config = resolveConnConfig(conn, schema);
    try {
      await safeInvoke('execute_query', {
        request: { config, sql },
        queryId: `${label.replace(/\s+/g, '_')}_${Date.now()}`,
        __meta: { source: 'explorer' },
      });
      return true;
    } catch (err: any) {
      const parsed = parseDbError(err?.message ?? String(err));
      const msg = parsed.detail ? `${parsed.message} — ${parsed.detail}` : parsed.message;
      pushToast({ severity: 'error', title: `${label} failed`, message: msg });
      return false;
    } finally {
      setActionRunning(false);
    }
  };

  // Open a destructive/maintenance action confirmation.
  const openTableAction = (
    action: 'drop' | 'truncate' | 'deleteAll' | 'reset' | MaintenanceOp,
    conn: DatabaseConnection,
    group: SchemaGroupNode,
    table: SchemaTableNode
  ) => {
    setTableActionCtx({ conn, group, table });
    setPendingAction(action);
    setActionRunning(false);
    // For reset, pre-load auto-increment metadata.
    if (action === 'reset') {
      setAutoIncMeta(undefined);
      setAutoIncError(null);
      const aiCol = detectAutoIncrementColumn(conn.engine, table.children);
      if (aiCol && getTableCapabilities(conn.engine).supportsResetAutoIncrement) {
        safeInvoke<AutoIncrementMeta | null>('get_table_auto_increment', {
          config: resolveConnConfig(conn, group.name),
          schema: group.name,
          table: table.name,
        })
          .then((meta) => {
            setAutoIncMeta(meta);
            const base = meta?.currentMax != null ? meta.currentMax + 1 : 1;
            setResetNextValue(String(base));
          })
          .catch((err: any) => setAutoIncError(err?.message ?? String(err)));
      } else {
        setAutoIncMeta(null);
      }
    }
    setTableContextMenu(null);
  };

  const closeTableAction = () => {
    setTableActionCtx(null);
    setPendingAction(null);
    setAutoIncMeta(undefined);
    setAutoIncError(null);
  };

  const confirmTableAction = async () => {
    if (!tableActionCtx || !pendingAction) return;
    const { conn, group, table } = tableActionCtx;
    const engine = conn.engine;
    const schema = group.name;

    if (pendingAction === 'drop') {
      const sql = dropTableSql(engine, table.name, schema);
      const ok = await runTableSql(conn, schema, sql, 'Drop Table');
      if (ok) {
        // Close any open tab for this table, then refresh the tree.
        useTabStore.getState().tabs
          .filter((t) => t.tableName === table.name && t.connectionId === conn.id)
          .forEach((t) => useTabStore.getState().closeTab(t.id));
        loadSchemaForConnection(conn);
        pushToast({ severity: 'success', title: 'Table dropped', message: `${table.name} was permanently deleted.` });
        closeTableAction();
      }
      return;
    }

    if (pendingAction === 'truncate') {
      const sql = truncateTableSql(engine, table.name, schema);
      if (!sql) return;
      const ok = await runTableSql(conn, schema, sql, 'Truncate Table');
      if (ok) {
        // Force stats refresh so the tree badge shows 0 rows immediately.
        if (String(engine) === 'mysql' || String(engine) === 'mariadb') {
          await runTableSql(conn, schema, `ANALYZE TABLE ${qualifiedTable(engine, table.name, schema)};`, 'Analyze Table');
        }
        // Refresh the Explorer tree so row-count/size badges update.
        loadSchemaForConnection(conn);
        reloadOpenTableTab(conn.id, table.name);
        pushToast({ severity: 'success', title: 'Table truncated', message: `All rows removed from ${table.name}.` });
        closeTableAction();
      }
      return;
    }

    if (pendingAction === 'deleteAll') {
      // DELETE FROM works on every engine — always available.
      const sql = `DELETE FROM ${qualifiedTable(engine, table.name, schema)};`;
      const ok = await runTableSql(conn, schema, sql, 'Delete All Rows');
      if (ok) {
        // MySQL `information_schema.TABLES.TABLE_ROWS` is a cached estimate —
        // ANALYZE TABLE forces the stats (and the tree badge) to reflect 0 rows.
        if (String(engine) === 'mysql' || String(engine) === 'mariadb') {
          await runTableSql(conn, schema, `ANALYZE TABLE ${qualifiedTable(engine, table.name, schema)};`, 'Analyze Table');
        }
        loadSchemaForConnection(conn);
        reloadOpenTableTab(conn.id, table.name);
        pushToast({ severity: 'success', title: 'Rows deleted', message: `All rows removed from ${table.name}.` });
        closeTableAction();
      }
      return;
    }

    if (pendingAction === 'reset') {
      const val = parseInt(resetNextValue, 10);
      if (Number.isNaN(val) || val < 1) {
        pushToast({ severity: 'error', title: 'Invalid value', message: 'Next ID must be a positive integer.' });
        return;
      }
      const sql = resetAutoIncrementSql(engine, table.name, val, autoIncMeta ?? undefined);
      if (!sql) {
        pushToast({ severity: 'error', title: 'Not supported', message: 'Resetting the auto-increment is not supported for this table.' });
        return;
      }
      const ok = await runTableSql(conn, schema, sql, 'Reset Auto Increment');
      if (ok) {
        pushToast({ severity: 'success', title: 'Auto-increment reset', message: `Next value for ${table.name} set to ${val}.` });
        closeTableAction();
      }
      return;
    }

    // Maintenance op.
    const op = pendingAction as MaintenanceOp;
    let sql: string | null = null;
    switch (op) {
      case 'analyze': sql = analyzeTableSql(engine, table.name, schema); break;
      case 'vacuum': sql = vacuumTableSql(engine, table.name, schema); break;
      case 'optimize': sql = optimizeTableSql(engine, table.name, schema); break;
      case 'check': sql = checkTableSql(engine, table.name, schema); break;
      case 'reindex': sql = reindexTableSql(engine, table.name, schema); break;
      case 'checkpoint': sql = maintenanceOpSql('checkpoint', engine, table.name, schema); break;
    }
    if (!sql) return;
    const ok = await runTableSql(conn, schema, sql, maintenanceOpLabel(op));
    if (ok) {
      pushToast({ severity: 'success', title: `${maintenanceOpLabel(op)} completed`, message: `${maintenanceOpLabel(op)} finished on ${table.name}.` });
      closeTableAction();
    }
  };

  // ── Database / schema group actions ─────────────────────────
  const openDbAction = (
    action: 'dropDb' | 'emptyDb',
    conn: DatabaseConnection,
    group: SchemaGroupNode
  ) => {
    setDbActionCtx({ conn, group });
    setPendingDbAction(action);
    setDbActionRunning(false);
    setGroupContextMenu(null);
  };

  const closeDbAction = () => {
    setDbActionCtx(null);
    setPendingDbAction(null);
  };

  const confirmDbAction = async () => {
    if (!dbActionCtx || !pendingDbAction) return;
    const { conn, group } = dbActionCtx;
    const engine = conn.engine;
    setDbActionRunning(true);
    try {
      if (pendingDbAction === 'dropDb') {
        const sql = dropDatabaseSql(engine, group.name);
        if (!sql) {
          pushToast({ severity: 'error', title: 'Not supported', message: 'Dropping is not supported for this engine/group.' });
          return;
        }
        // MySQL can't drop the database it's currently connected to — connect to
        // a different DB (or no DB) when the target IS the current database.
        let config = resolveConnConfig(conn, group.name);
        if ((String(engine) === 'mysql' || String(engine) === 'mariadb') && config.database === group.name) {
          config = { ...config, database: undefined };
        }
        await safeInvoke('execute_query', {
          request: { config, sql },
          queryId: `drop_db_${group.name}_${Date.now()}`,
          __meta: { source: 'explorer' },
        });
        // After dropping a database/schema, the active database may now be gone.
        if (activeDatabaseByConn[conn.id] === group.name) {
          setActiveDatabase(conn.id, '');
        }
        loadSchemaForConnection(conn);
        pushToast({ severity: 'success', title: 'Dropped', message: `${group.name} was permanently deleted.` });
        closeDbAction();
      } else if (pendingDbAction === 'emptyDb') {
        const childNames = group.children.map((t) => t.name);
        const stmts = emptyDatabaseSql(engine, group.name, childNames);
        if (stmts.length === 0) {
          pushToast({ severity: 'error', title: 'Not supported', message: 'Emptying is not supported for this engine/group.' });
          return;
        }
        for (const sql of stmts) {
          await safeInvoke('execute_query', {
            request: { config: resolveConnConfig(conn, group.name), sql },
            queryId: `empty_db_${group.name}_${Date.now()}`,
            __meta: { source: 'explorer' },
          });
        }
        // Reload any open data-grid tabs for tables in this group so they
        // reflect the emptied state.
        for (const t of group.children) {
          reloadOpenTableTab(conn.id, t.name);
        }
        loadSchemaForConnection(conn);
        pushToast({ severity: 'success', title: 'Emptied', message: `${group.name} was reset to an empty state.` });
        closeDbAction();
      }
    } catch (err: any) {
      const parsed = parseDbError(err?.message ?? String(err));
      const msg = parsed.detail ? `${parsed.message} — ${parsed.detail}` : parsed.message;
      pushToast({ severity: 'error', title: 'Operation failed', message: msg });
    } finally {
      setDbActionRunning(false);
    }
  };

  // Force the database to recompute table statistics (sizes, row counts) so the
  // Explorer badges reflect reality instead of cached estimates. Runs the
  // engine-appropriate stats-refresh SQL, then re-fetches the schema tree.
  // Full refresh: clear all cached schema state, force the database to
  // recompute statistics (so size & row counts are accurate, not stale
  // estimates), then re-fetch the tree into both the Explorer and the
  // connection-store caches. One action that does everything.
  const refreshConnection = async (
    conn: DatabaseConnection,
    group?: SchemaGroupNode
  ) => {
    const engine = conn.engine;
    const config = group ? resolveConnConfig(conn, group.name) : conn;
    setActionRunning(true);
    try {
      // 1. Clear the local Explorer tree cache + the connection-store cache
      //    (the latter feeds SQL autocomplete) so nothing stale survives.
      setConnTrees((prev) => {
        if (!prev[conn.id]) return prev;
        const next = { ...prev };
        delete next[conn.id];
        return next;
      });

      // 2. Force the database to recompute table statistics so the size/row
      //    badges reflect reality instead of cached estimates.
      let analyzeStmts: string[] = [];
      if (String(engine) === 'mysql' || String(engine) === 'mariadb') {
        const tables = group ? group.children : [];
        if (tables.length > 0) {
          analyzeStmts.push(
            `ANALYZE TABLE ${tables.map((t) => qualifiedTable(engine, t.name, group?.name)).join(', ')};`
          );
        }
      } else if (
        String(engine) === 'postgres' ||
        String(engine) === 'postgresql' ||
        String(engine) === 'sqlite' ||
        String(engine) === 'cloudflare-d1' ||
        String(engine) === 'd1'
      ) {
        analyzeStmts.push('ANALYZE;');
      }
      for (const sql of analyzeStmts) {
        await safeInvoke('execute_query', {
          request: { config, sql },
          queryId: `refresh_${Date.now()}`,
        });
      }

      // 3. Re-fetch the schema tree. `loadSchemaForConnection` updates BOTH the
      //    Explorer's local cache AND the shared connection-store cache (which
      //    feeds SQL autocomplete) via `setSchemaTreeForConn`, so a separate
      //    `fetchSchema` call here would only duplicate the round-trip.
      await loadSchemaForConnection(conn);
      pushToast({ severity: 'success', title: 'Refreshed', message: `Schema, cache, and statistics refreshed for ${conn.name}.` });
    } catch (err: any) {
      const parsed = parseDbError(err?.message ?? String(err));
      pushToast({ severity: 'error', title: 'Refresh failed', message: parsed.detail ? `${parsed.message} — ${parsed.detail}` : parsed.message });
    } finally {
      setActionRunning(false);
    }
  };

  return (
    <div className="w-full h-full bg-[#0d1117] border-r border-black/20 flex flex-col select-none font-sans text-xs">
      {/* macOS-style translucent header
          `relative z-20` promotes this header to its own explicit stacking
          layer: backdrop-blur-xl already creates a stacking context, but
          without an explicit z-index that context ties with the search bar
          below (also z-index:auto) and — being the later DOM sibling — the
          search bar would paint on top, burying the "+ Add" dropdown menu
          that lives inside the header. */}
      <div className="relative z-20 h-10 bg-[#161b22]/80 backdrop-blur-xl border-b border-white/5 px-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 font-semibold text-[12px] text-slate-200">
          <Database className="w-3.5 h-3.5 text-blue-400" />
          <span>Explorer</span>
        </div>

        <div className="flex items-center gap-0.5">
          {/* Unified "+ Add" dropdown — replaces the row of individual buttons.
              A click on the button body toggles the menu; the menu items cover
              every creation + portability action in one place. */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setAddMenuOpen((v) => !v);
              }}
              className="flex items-center gap-0.5 pl-1.5 pr-1 py-1 rounded-md text-blue-400 hover:text-white hover:bg-white/10 transition-all font-semibold text-[11px]"
              title="Add / Import / Export"
            >
              <Plus className="w-3.5 h-3.5" />
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>
            {addMenuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-full mt-1 z-50 w-52 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1.5 text-xs text-slate-200 select-none font-sans"
              >
                <button
                  onClick={() => {
                    setConnectionModalOpen(true);
                    setAddMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>New Database Connection</span>
                </button>
                <button
                  onClick={() => {
                    setEditingStorage(null);
                    setStorageDialogOpen(true);
                    setAddMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-amber-400"
                >
                  <Cloud className="w-3.5 h-3.5" />
                  <span>New Storage Connection</span>
                </button>
                <div className="h-px bg-[#1e293b] my-1" />
                <button
                  onClick={() => {
                    openEncryptedConnectionsModal('export');
                    setAddMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export Connections…</span>
                </button>
                <button
                  onClick={() => {
                    openEncryptedConnectionsModal('import');
                    setAddMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Import Connections…</span>
                </button>
              </div>
            )}
          </div>
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-all"
            title="Collapse Sidebar"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filter Bar — macOS-style rounded search */}
      {connections.length > 0 && (
        <div className="px-2.5 py-2 border-b border-white/5">
          <div className="relative flex items-center bg-[#0d1117] rounded-lg border border-white/[0.03] focus-within:border-blue-500/40 focus-within:bg-[#161b22] transition-all">
            <Filter className="w-3 h-3 text-slate-500 absolute left-2.5" />
            <input
              type="text"
              placeholder="Search"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full bg-transparent text-[11px] text-slate-300 pl-7 pr-2 py-1.5 focus:outline-none placeholder:text-slate-600"
            />
          </div>
        </div>
      )}

      {/* Explorer Tree
          The container is also a drop zone: dropping a connection on the empty
          area (not on a folder) clears its tag — this is how you "drag out" of
          a tag folder to untag. We check e.target === e.currentTarget so the
          untag only fires when the drop lands on the container itself, not on
          a child folder (which has its own onDrop). */}
      <div
        className={`flex-1 overflow-y-auto px-1.5 py-1.5 macos-scroll transition-colors ${
          dragConnId && dragOverFolder === '__root__' ? 'bg-blue-500/5 ring-1 ring-inset ring-blue-500/20' : ''
        }`}
        onContextMenu={(e) => {
          // Global Explorer menu — only when the right-click lands on the empty
          // tree area itself (not on a connection/group/table row, which have
          // their own context menus and stop propagation).
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setExplorerCtxMenu({ mouseX: e.clientX, mouseY: e.clientY });
          }
        }}
        onDragOver={(e) => {
          if (dragTracker.id && e.target === e.currentTarget) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragOverFolder !== '__root__') setDragOverFolder('__root__');
          }
        }}
        onDragLeave={(e) => {
          if (dragOverFolder === '__root__' && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOverFolder(null);
          }
        }}
        onDrop={(e) => {
          if (e.target === e.currentTarget && dragTracker.id) {
            e.preventDefault();
            // Dropping on the empty root area = clear the tag (untag).
            if (dragTracker.type === 'storage') {
              moveStorageConnection(dragTracker.id, null);
            } else {
              moveConnection(dragTracker.id, null);
            }
            setDragConnId(null);
            dragTracker.id = null;
            dragTracker.type = null;
            setDragOverFolder(null);
          }
        }}
      >
        {connections.length === 0 && storageConnections.length === 0 ? (
          <div className="text-center py-12 px-4 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-[#161b22] border border-white/5 flex items-center justify-center text-blue-400 shadow-lg shadow-black/30">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs font-semibold text-slate-300 mb-1">No Connections</h4>
              <p className="text-[11px] text-slate-500 leading-relaxed mb-4 max-w-[200px]">
                Connect to PostgreSQL, MySQL, SQLite, Cloudflare D1, or S3-compatible storage to get started.
              </p>
              <div className="flex flex-col gap-2 items-center">
                <button
                  onClick={() => setConnectionModalOpen(true)}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium shadow-lg shadow-blue-600/20 transition-all flex items-center gap-1.5"
                >
                  <Database className="w-3.5 h-3.5" />
                  + Database Connection
                </button>
                <button
                  onClick={() => { setEditingStorage(null); setStorageDialogOpen(true); }}
                  className="px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 text-xs font-medium border border-amber-600/30 transition-all flex items-center gap-1.5"
                >
                  <Cloud className="w-3.5 h-3.5" />
                  + Storage Connection
                </button>
              </div>
            </div>
          </div>
        ) : (
          (() => {
            const filtered = connections.filter((c) => {
              if (!filterQuery) return true;
              const q = filterQuery.toLowerCase();
              const tree = connTrees[c.id] || [];
              return (
                c.name.toLowerCase().includes(q) ||
                c.engine.toLowerCase().includes(q) ||
                tree.some(
                  (g) =>
                    g.name.toLowerCase().includes(q) ||
                    g.children.some((t) => t.name.toLowerCase().includes(q))
                )
              );
            });
            // If nothing is tagged, render flat (no folders at all) — the
            // "Other" bucket only makes sense once at least one connection is
            // grouped under a real tag. Storage connections participate in the
            // same check so a tag applied to an S3 connection still creates a
            // folder.
            const hasAnyTagged =
              filtered.some((c) => c.tagId) ||
              storageConnections.some((c) => c.tagId);

            const renderConnectionRow = (conn: DatabaseConnection) => {
              const isConnActive = conn.id === activeConnectionId;
              const schemaTree = connTrees[conn.id] || [];
              const q = filterQuery.toLowerCase();
              const treeMatches =
                !!filterQuery &&
                schemaTree.some(
                  (g) =>
                    g.name.toLowerCase().includes(q) ||
                    g.children.some((t) => t.name.toLowerCase().includes(q))
                );
              const isConnExpanded = treeMatches || expandedConnIds.has(conn.id);
              const isLoading = loadingConnIds.has(conn.id);
              // Only the actively-polled connection has a live reachability
              // verdict (see StatusBar's `pingConnection`) — a confirmed
              // 'disconnected' active connection has nothing to expand into,
              // so the chevron and schema tree shouldn't pretend otherwise.
              const isConnOffline = isConnActive && connStatus === 'disconnected';
              const treeError = connTreeErrors[conn.id];
              // Redis has its own Databases tree branch (below) instead of
              // the generic SchemaGroupNode one — clicking the row still
              // jumps straight to the key browser, but the chevron now also
              // independently expands/collapses that branch like every
              // other engine.
              const isRedisConn = isRedisEngine(conn.engine);

              return (
                <div
                  key={conn.id}
                  className="mb-0.5"
                  draggable
                  onDragStart={(e) => {
                    setDragConnId(conn.id);
                    dragTracker.id = conn.id;
                    dragTracker.type = 'db';
                    e.dataTransfer.setData('text/conn-id', conn.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDragConnId(null);
                    dragTracker.id = null;
                    dragTracker.type = null;
                    lastDragEndAt = Date.now();
                    setDragOverFolder(null);
                  }}
                >
                  {/* Connection Header — active = prominent accent bar + glow */}
                  <div
                    onClick={() => {
                      if (Date.now() - lastDragEndAt < 300) return;
                      if (isRedisConn) {
                        openRedisBrowserTab(conn.id);
                      } else {
                        handleSelectConnection(conn);
                      }
                    }}
                    onContextMenu={(e) => handleConnContextMenu(e, conn)}
                    title={
                      conn.engine === 'cloudflare-d1'
                        ? `${conn.name} — D1 · ${conn.cfDatabaseId || conn.database || '—'}`
                        : conn.filePath
                        ? `${conn.name} — ${conn.engine.toUpperCase()} · ${conn.filePath}`
                        : `${conn.name} — ${conn.engine.toUpperCase()} · ${conn.host || '—'}:${conn.port || '—'}`
                    }
                    className={`group relative w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                      isConnActive
                        ? 'bg-blue-500/15 text-blue-100 font-semibold ring-1 ring-blue-500/30 shadow-sm shadow-blue-500/10'
                        : 'text-slate-300 hover:bg-white/5'
                    } ${dragConnId === conn.id ? 'opacity-50' : ''}`}
                  >
                    {/* Active accent bar */}
                    {isConnActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-blue-400" />
                    )}
                    {isConnOffline ? (
                      <span className="p-0.5 flex items-center justify-center text-slate-700" title="Offline — can't browse schema">
                        <WifiOff className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpandConn(conn.id);
                        }}
                        className="p-0.5 text-slate-500 hover:text-slate-200"
                      >
                        {isConnExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}

                    <EngineIcon engine={conn.engine} isConnected={isConnActive && connStatus === 'connected'} />

                    <div className="truncate flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className={`truncate text-[13px] ${isConnActive ? 'text-blue-50' : ''}`}>{conn.name}</span>
                        {conn.isFavorite && (
                          <Pin className="w-3 h-3 text-cyan-400 fill-cyan-400/40 shrink-0" />
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {isRedisConn ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openRedisBrowserTab(conn.id);
                          }}
                          className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-red-400 transition-colors"
                          title="Browse Keys"
                        >
                          <Key className="w-3 h-3" />
                        </button>
                      ) : (
                        <>
                          {(isConnExpanded || connTrees[conn.id]) &&
                            !(isConnActive && connStatus === 'disconnected') && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDisconnect(conn);
                              }}
                              className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-amber-400 transition-colors"
                              title="Disconnect"
                            >
                              <Unplug className="w-3 h-3" />
                            </button>
                          )}

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              loadSchemaForConnection(conn);
                            }}
                            className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-slate-200 transition-colors"
                            title="Refresh Schema"
                          >
                            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin text-blue-400' : ''}`} />
                          </button>
                        </>
                      )}

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditConnection(conn);
                        }}
                        className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-slate-200 transition-colors"
                        title="Edit Connection"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteConnection(conn.id);
                        }}
                        className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-red-400 transition-colors"
                        title="Delete Connection"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Databases branch (Redis) — no SQL schema/table model, so
                      this is a dedicated, static tree instead of falling
                      into the SchemaGroupNode-shaped block below. */}
                  {isConnExpanded && isRedisConn && (
                    <div className="ml-2 pl-1.5 border-l border-white/5 flex flex-col gap-0.5 mt-0.5">
                      {redisKeyspaceLoading.has(conn.id) && !redisKeyspace[conn.id] ? (
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 py-1 font-mono">
                          <RefreshCw className="w-3 h-3 animate-spin text-blue-400" />
                          Loading databases...
                        </div>
                      ) : (
                        <div>
                          <button
                            type="button"
                            onClick={() =>
                              setRedisDbBranchExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(conn.id)) next.delete(conn.id);
                                else next.add(conn.id);
                                return next;
                              })
                            }
                            className="w-full flex items-center gap-1 pl-0.5 pr-5 py-0.5 text-[11px] font-semibold text-slate-500 hover:text-slate-300"
                          >
                            {redisDbBranchExpanded.has(conn.id) ? (
                              <ChevronDown className="w-3 h-3 shrink-0" />
                            ) : (
                              <ChevronRight className="w-3 h-3 shrink-0" />
                            )}
                            <Database className="w-3.5 h-3.5 text-red-400/70 shrink-0" />
                            <span>Databases</span>
                          </button>
                          {redisDbBranchExpanded.has(conn.id) && (
                          <div className="ml-2 pl-1.5 border-l border-white/5 flex flex-col gap-0.5 mt-0.5">
                            {Array.from({ length: 16 }, (_, i) => i).map((dbIndex) => {
                              const info = (redisKeyspace[conn.id] || []).find((d) => d.dbIndex === dbIndex);
                              const keyCount = info?.keys ?? 0;
                              return (
                                <button
                                  key={dbIndex}
                                  type="button"
                                  onClick={() => openRedisBrowserTab(conn.id, dbIndex)}
                                  className="w-full flex items-center gap-1.5 pl-2 pr-5 py-0.5 rounded-md text-[12px] text-slate-400 hover:bg-white/5 hover:text-slate-100 transition-all"
                                  title={`DB ${dbIndex} — ${keyCount.toLocaleString()} key${keyCount === 1 ? '' : 's'}`}
                                >
                                  <span className="w-3.5 h-3.5 shrink-0 rounded-sm bg-red-500/10 text-red-400 text-[9px] font-mono font-bold flex items-center justify-center">
                                    {dbIndex}
                                  </span>
                                  <span className="truncate flex-1 text-left font-medium">DB {dbIndex}</span>
                                  {keyCount > 0 && (
                                    <span className="text-[9.5px] font-mono px-1 py-0.5 rounded bg-slate-800/80 text-slate-500 shrink-0 mr-1.5">
                                      {keyCount.toLocaleString()}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Schema Tree (every other engine) */}
                  {isConnExpanded && !isRedisConn && (
                    <>
                    <div className="ml-2 pl-1.5 border-l border-white/5 flex flex-col gap-0.5 mt-0.5">
                      {isConnOffline ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-red-400/80 py-1 pl-1">
                          <WifiOff className="w-3 h-3 shrink-0" />
                          Connection offline
                        </div>
                      ) : isLoading ? (
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 py-1 font-mono">
                          <RefreshCw className="w-3 h-3 animate-spin text-blue-400" />
                          Fetching live schema...
                        </div>
                      ) : schemaTree.length === 0 ? (
                        treeError ? (
                          <div className="flex items-center gap-1.5 text-[11px] text-red-400/80 py-1 pl-1" title={treeError}>
                            <WifiOff className="w-3 h-3 shrink-0" />
                            Couldn't load schema
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-600 italic py-1 pl-1">
                            No schemas or tables found
                          </div>
                        )
                      ) : (
                        (() => {
                          const pinned = pinnedSchemasByConn[conn.id] || [];
                          const pinnedSet = new Set(pinned);
                          const groups = schemaTree
                          .filter((group: SchemaGroupNode) => {
                            if (!filterQuery) return true;
                            const q = filterQuery.toLowerCase();
                            return (
                              group.name.toLowerCase().includes(q) ||
                              group.children.some((t) => t.name.toLowerCase().includes(q))
                            );
                          })
                          .slice()
                          .sort((a, b) => {
                            const pa = pinnedSet.has(a.name) ? 0 : 1;
                            const pb = pinnedSet.has(b.name) ? 0 : 1;
                            return pa - pb;
                          })
                          .map((group: SchemaGroupNode) => {
                          const groupKey = `${conn.id}-${group.name}`;
                          // When a filter is active, force-expand groups so the
                          // matching tables (and matching groups themselves) are
                          // immediately visible instead of hidden in collapsed nodes.
                          const matchesFilter =
                            !!filterQuery &&
                            group.children.some((t) => t.name.toLowerCase().includes(filterQuery.toLowerCase()));
                          const isGroupExpanded = matchesFilter || expandedNodeKeys.has(groupKey);

                          const isActiveDb = activeDatabaseByConn[conn.id] === group.name;
                          // Aggregate per-table size/row data into a database
                          // total so the group header can show how big the DB is.
                          // Each SchemaTableNode already carries size_bytes and
                          // row_count from fetch_schema_tree, so this is a pure
                          // client-side sum — no extra backend round-trip.
                          const dbSizeBytes = group.children.reduce(
                            (sum, t) => sum + (typeof t.size_bytes === 'number' ? t.size_bytes : 0),
                            0
                          );
                          const dbRowCount = group.children.reduce(
                            (sum, t) => sum + (typeof t.row_count === 'number' ? t.row_count : 0),
                            0
                          );
                          const dbSizeLabel = formatBytes(dbSizeBytes);
                          return (
                            <div key={group.name} className="mb-0.5">
                              <button
                                onClick={() => {
                                  setActiveDatabase(conn.id, group.name);
                                  toggleExpandNode(groupKey);
                                  // Bring the tab workspace forward so the user
                                  // lands on the data view when navigating the
                                  // tree from another workspace.
                                  setActiveView('explorer');
                                }}
                                onContextMenu={(e) => handleGroupContextMenu(e, conn, group)}
                                className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium transition-all ${
                                  isActiveDb
                                    ? 'bg-cyan-500/15 text-cyan-200'
                                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                                }`}
                              >
                                {isGroupExpanded ? (
                                  <ChevronDown className={`w-3.5 h-3.5 ${isActiveDb ? 'text-cyan-400' : 'text-slate-600'}`} />
                                ) : (
                                  <ChevronRight className={`w-3.5 h-3.5 ${isActiveDb ? 'text-cyan-400' : 'text-slate-600'}`} />
                                )}
                                <Database className={`w-3.5 h-3.5 ${isActiveDb ? 'text-cyan-400' : 'text-slate-500'}`} />
                                <span className="truncate">{group.name}</span>
                                {isActiveDb && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" />
                                )}
                                {pinnedSet.has(group.name) && (
                                  <Pin className="w-3 h-3 text-cyan-400 fill-cyan-400/40 shrink-0" />
                                )}
                                {/* Database total size + table count, pushed right. */}
                                <div className="ml-auto flex items-center gap-1 shrink-0">
                                  {showTableSizes && dbSizeLabel && (
                                    <span
                                      className={`text-[9.5px] font-mono px-1 py-0.5 rounded ${getSizeColorClass(dbSizeBytes)}`}
                                      title={`${dbSizeLabel} across ${group.children.length} table${group.children.length === 1 ? '' : 's'}${showRowCounts && dbRowCount > 0 ? ` · ${dbRowCount.toLocaleString()} rows` : ''}`}
                                    >
                                      {dbSizeLabel}
                                    </span>
                                  )}
                                  <span className="text-[10px] text-slate-600 font-mono">
                                    {group.children.length}
                                  </span>
                                </div>
                              </button>

                              {isGroupExpanded && (
                                <div className="ml-2 pl-1.5 border-l border-white/5 flex flex-col gap-0 mt-0.5">
                                  {(() => {
                                    // Categorize the group's tables/views into their own
                                    // expandable folders (DataGrip/DBeaver style), instead
                                    // of a flat mixed list. Triggers/Functions/Events stay
                                    // in their own lazy folders below.
                                    const q = filterQuery.toLowerCase();
                                    const all = group.children.filter((t) => t.name.toLowerCase().includes(q));
                                    const tables = all.filter((t) => t.node_type !== 'view');
                                    const views = all.filter((t) => t.node_type === 'view');

                                    const renderRow = (table: SchemaTableNode, isView: boolean) => {
                                      const tableKey = `${groupKey}-${table.name}`;
                                      const isTableExpanded = expandedNodeKeys.has(tableKey);
                                      return (
                                        <div key={table.name}>
                                          <button
                                            onClick={() => handleTableClick(conn, table.name, group.name)}
                                            onDoubleClick={() => toggleExpandNode(tableKey)}
                                            onContextMenu={(e) => handleTableContextMenu(e, conn, table, group)}
                                            className="w-full flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[12px] text-slate-400 hover:bg-white/5 hover:text-slate-100 transition-all group"
                                          >
                                            {isView ? (
                                              <Eye className="w-3.5 h-3.5 text-cyan-500/70 group-hover:text-cyan-400 shrink-0" />
                                            ) : (
                                              <TableIcon className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-300 shrink-0" />
                                            )}
                                            <span className="truncate flex-1 text-left font-medium">{table.name}</span>

                                            {/* Size & Row Badges — each independently toggleable via
                                                Explorer's Show ▸ submenu (Row Counts / Table Sizes). */}
                                            <div className="flex items-center gap-1 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                              {showRowCounts && typeof table.row_count === 'number' && (
                                                <span className="text-[9.5px] font-mono px-1 py-0.5 rounded bg-slate-800/80 text-slate-500 flex items-center gap-0.5" title={`${table.row_count.toLocaleString()} rows`}>
                                                  <Hash className="w-2.5 h-2.5" />
                                                  {table.row_count.toLocaleString()}
                                                </span>
                                              )}

                                              {showTableSizes && typeof table.size_bytes === 'number' && table.size_bytes > 0 && (
                                                <span className={`text-[9.5px] font-mono px-1 py-0.5 rounded ${getSizeColorClass(table.size_bytes)}`} title={formatBytes(table.size_bytes)}>
                                                  {formatBytes(table.size_bytes)}
                                                </span>
                                              )}
                                            </div>
                                          </button>

                                          {/* Columns List */}
                                          {isTableExpanded && table.children && (
                                            <div className="ml-2 pl-1.5 border-l border-white/5 flex flex-col gap-0.5 mt-0.5">
                                              {table.children.map((col: SchemaColumnNode) => (
                                                <div
                                                  key={col.name}
                                                  className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-slate-400 font-mono"
                                                >
                                                  {col.is_primary_key ? (
                                                    <span className="text-[9.5px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">
                                                      PK
                                                    </span>
                                                  ) : (
                                                    getColumnTypeIcon(col.data_type)
                                                  )}
                                                  <span>{col.name}</span>
                                                  {col.data_type && (
                                                    <span className="text-[10px] text-slate-500 ml-auto truncate max-w-[90px] font-normal lowercase">
                                                      {col.data_type}
                                                    </span>
                                                  )}
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    };

                                    return (
                                      <>
                                        {/* Always render the Tables folder, even at zero — a
                                            genuinely empty database (e.g. a freshly-created or
                                            empty-file SQLite database) should say so explicitly
                                            instead of the group just expanding into nothing. */}
                                        <TreeFolder
                                          expanded={!!filterQuery || expandedNodeKeys.has(`${groupKey}-__tables`)}
                                          onToggle={() => toggleExpandNode(`${groupKey}-__tables`)}
                                          onHeaderContextMenu={(e) => {
                                            e.preventDefault();
                                            setCategoryFolderMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, group, groupKey: `${groupKey}-__tables`, kind: 'table' });
                                          }}
                                          icon={<TableIcon className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                                          label={isMongoEngine(conn.engine) ? 'Collections' : 'Tables'}
                                          count={tables.length}
                                        >
                                          {tables.length > 0 ? (
                                            tables.map((t) => renderRow(t, false))
                                          ) : (
                                            <div className="px-1 py-0.5 text-[10.5px] text-slate-600 italic">
                                              {isMongoEngine(conn.engine) ? 'No collections' : 'No tables — this database is empty'}
                                            </div>
                                          )}
                                        </TreeFolder>
                                        {(views.length > 0 || !!filterQuery) && (
                                          <TreeFolder
                                            expanded={!!filterQuery || expandedNodeKeys.has(`${groupKey}-__views`)}
                                            onToggle={() => toggleExpandNode(`${groupKey}-__views`)}
                                            onHeaderContextMenu={(e) => {
                                              e.preventDefault();
                                              setCategoryFolderMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, group, groupKey: `${groupKey}-__views`, kind: 'view' });
                                            }}
                                            icon={<Eye className="w-3.5 h-3.5 text-cyan-500/70 shrink-0" />}
                                            label="Views"
                                            count={views.length}
                                          >
                                            {views.map((t) => renderRow(t, true))}
                                          </TreeFolder>
                                        )}
                                      </>
                                    );
                                  })()}

                                  {/* Triggers folder (lazy). */}
                                  {supportsTriggers(conn.engine) && (() => {
                                    const triggersKey = `${groupKey}-__triggers`;
                                    const isExpanded = expandedNodeKeys.has(triggersKey);
                                    const folder = triggerFolders[triggersKey];
                                    return (
                                      <LazyTreeFolder
                                        expanded={isExpanded}
                                        onToggle={() => {
                                          toggleExpandNode(triggersKey);
                                          if (!isExpanded) loadTriggersForGroup(conn, group, triggersKey);
                                        }}
                                        onHeaderContextMenu={(e) => {
                                          e.preventDefault();
                                          setCategoryFolderMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, group, groupKey: triggersKey, kind: 'trigger' });
                                        }}
                                        icon={<Zap className="w-3.5 h-3.5 text-amber-500/70 shrink-0" />}
                                        label="Triggers"
                                        status={folder?.status ?? 'loading'}
                                        itemCount={folder?.items.length ?? 0}
                                        emptyLabel="No triggers"
                                        error={folder?.error}
                                      >
                                        {folder?.items.map((trg) => (
                                          <ObjectLeafRow
                                            key={`${trg.table}.${trg.name}`}
                                            icon={<Zap className="w-3 h-3 text-amber-500/60 shrink-0" />}
                                            name={trg.name}
                                            trailing={
                                              <span className="text-[10px] text-slate-600 font-mono ml-auto truncate max-w-[110px]">
                                                on {trg.table}
                                              </span>
                                            }
                                            onOpen={(e) =>
                                              setTriggerItemMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, group, trigger: trg, groupKey: triggersKey })
                                            }
                                          />
                                        ))}
                                      </LazyTreeFolder>
                                    );
                                  })()}

                                  {/* Functions / Procedures folder (lazy). */}
                                  {supportsProcedures(conn.engine) && (() => {
                                    const proceduresKey = `${groupKey}-__procedures`;
                                    const isExpanded = expandedNodeKeys.has(proceduresKey);
                                    const folder = procedureFolders[proceduresKey];
                                    return (
                                      <LazyTreeFolder
                                        expanded={isExpanded}
                                        onToggle={() => {
                                          toggleExpandNode(proceduresKey);
                                          if (!isExpanded) loadProceduresForGroup(conn, group, proceduresKey);
                                        }}
                                        onHeaderContextMenu={(e) => {
                                          e.preventDefault();
                                          setCategoryFolderMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, group, groupKey: proceduresKey, kind: 'procedure' });
                                        }}
                                        icon={<Braces className="w-3.5 h-3.5 text-violet-500/70 shrink-0" />}
                                        label={isPostgresFamily(conn.engine) ? 'Functions' : 'Procedures'}
                                        status={folder?.status ?? 'loading'}
                                        itemCount={folder?.items.length ?? 0}
                                        emptyLabel="No routines"
                                        error={folder?.error}
                                      >
                                        {folder?.items.map((proc) => (
                                          <ObjectLeafRow
                                            key={proc.name}
                                            icon={<Braces className="w-3 h-3 text-violet-500/60 shrink-0" />}
                                            name={proc.name}
                                            trailing={
                                              proc.type ? (
                                                <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-slate-800/80 text-slate-500 ml-auto shrink-0 uppercase">
                                                  {proc.type === 'FUNCTION' ? 'fn' : 'proc'}
                                                </span>
                                              ) : undefined
                                            }
                                            onOpen={(e) =>
                                              setProcedureItemMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, group, procedure: proc, groupKey: proceduresKey })
                                            }
                                          />
                                        ))}
                                      </LazyTreeFolder>
                                    );
                                  })()}

                                  {/* Events folder (lazy) — MySQL native scheduler / Postgres pg_cron. */}
                                  {supportsEvents(conn.engine) && (() => {
                                    const eventsKey = `${groupKey}-__events`;
                                    const isExpanded = expandedNodeKeys.has(eventsKey);
                                    const folder = eventFolders[eventsKey];
                                    return (
                                      <LazyTreeFolder
                                        expanded={isExpanded}
                                        onToggle={() => {
                                          toggleExpandNode(eventsKey);
                                          if (!isExpanded) loadEventsForGroup(conn, group, eventsKey);
                                        }}
                                        onHeaderContextMenu={(e) => {
                                          e.preventDefault();
                                          setCategoryFolderMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, group, groupKey: eventsKey, kind: 'event' });
                                        }}
                                        icon={<Clock className="w-3.5 h-3.5 text-emerald-500/70 shrink-0" />}
                                        label="Events"
                                        status={folder?.status ?? 'loading'}
                                        itemCount={folder?.items.length ?? 0}
                                        emptyLabel="No events"
                                        error={folder?.error}
                                      >
                                        {folder?.items.map((evt) => (
                                          <ObjectLeafRow
                                            key={evt.name}
                                            icon={<Clock className="w-3 h-3 text-emerald-500/60 shrink-0" />}
                                            name={evt.name}
                                            onOpen={(e) =>
                                              setEventItemMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, group, event: evt, groupKey: eventsKey })
                                            }
                                          />
                                        ))}
                                      </LazyTreeFolder>
                                    );
                                  })()}
                                </div>
                              )}
                            </div>
                          );
                        });

                          // Postgres: nest the schemas under a "Schemas" directory so
                          // the tree reads Database → Schemas → [public, …] → Tables/
                          // Views/… — one DB can hold many schemas. MySQL (databases)
                          // and SQLite (main) render flat, as before.
                          if (isPostgresFamily(conn.engine)) {
                            return (
                              <TreeFolder
                                expanded={!!filterQuery || expandedNodeKeys.has(`${conn.id}-__schemas`)}
                                onToggle={() => toggleExpandNode(`${conn.id}-__schemas`)}
                                icon={<Layers className="w-3.5 h-3.5 text-blue-400/70 shrink-0" />}
                                label="Schemas"
                                count={groups.length}
                              >
                                {groups}
                              </TreeFolder>
                            );
                          }
                          return <>{groups}</>;
                        })()
                      )}

                      {/* Postgres only: installed extensions — a folder INSIDE the
                          same tree container (sibling of Schemas), lazily loaded. */}
                      {isPostgresFamily(conn.engine) && (() => {
                        const extKey = `${conn.id}-__extensions`;
                        const folder = extensionFolders[extKey];
                        const extExpanded = expandedNodeKeys.has(extKey);
                        return (
                          <TreeFolder
                            expanded={extExpanded}
                            onToggle={() => {
                              toggleExpandNode(extKey);
                              if (!extExpanded) loadExtensionsForConn(conn, extKey);
                            }}
                            onHeaderContextMenu={(e) => {
                              e.preventDefault();
                              setExtFolderMenu({ mouseX: e.clientX, mouseY: e.clientY, conn, key: extKey });
                            }}
                            icon={<Puzzle className="w-3.5 h-3.5 text-fuchsia-500/70 shrink-0" />}
                            label="Extensions"
                            count={folder?.status === 'loaded' ? folder.items.length : null}
                          >
                            {folder?.status === 'loading' && (
                              <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-slate-600">
                                <RefreshCw className="w-3 h-3 animate-spin" /> Loading…
                              </div>
                            )}
                            {folder?.status === 'error' && (
                              <div className="px-1 py-0.5 text-[10.5px] text-red-400 truncate" title={folder.error}>
                                {folder.error}
                              </div>
                            )}
                            {folder?.status === 'loaded' && folder.items.length === 0 && (
                              <div className="px-1 py-0.5 text-[10.5px] text-slate-600 italic">No extensions</div>
                            )}
                            {folder?.status === 'loaded' &&
                              folder.items.map((ext) => (
                                <div
                                  key={ext.name}
                                  className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-slate-400 font-mono"
                                  title={`${ext.name} ${ext.version}`}
                                >
                                  <Puzzle className="w-3 h-3 text-fuchsia-500/50 shrink-0" />
                                  <span className="truncate">{ext.name}</span>
                                  <span className="text-[10px] text-slate-600 ml-auto shrink-0">{ext.version}</span>
                                </div>
                              ))}
                          </TreeFolder>
                        );
                      })()}
                    </div>
                  </>
                  )}
                </div>
              );
            };

            // Storage connection row renderer — mirrors the DB row layout
            // (alignment, accent bar, group-hover actions) so it feels native
            // inside the unified tree. Only the icon + amber accent differ.
            const renderStorageRow = (sConn: S3ConnectionConfig) => {
              const isActive = activeStorageConnectionId === sConn.id;
              return (
                <div
                  key={sConn.id}
                  className="mb-0.5"
                  draggable
                  onDragStart={(e) => {
                    setDragConnId(sConn.id);
                    dragTracker.id = sConn.id;
                    dragTracker.type = 'storage';
                    e.dataTransfer.setData('text/storage-id', sConn.id);
                    // Also set text/plain as a fallback — some WebKit/Tauri
                    // versions only honor standard MIME types in getData().
                    e.dataTransfer.setData('text/plain', sConn.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDragConnId(null);
                    dragTracker.id = null;
                    dragTracker.type = null;
                    lastDragEndAt = Date.now();
                    setDragOverFolder(null);
                  }}
                >
                  <div
                    onClick={() => {
                      // Suppress the synthetic click WebKit fires right after
                      // a drag — if a drag is active or just ended, don't open
                      // a storage tab (which would re-render and cancel the drop).
                      if (dragTracker.id) return;
                      if (Date.now() - lastDragEndAt < 300) return;
                      setActiveStorageConnection(sConn.id);
                      openStorageTab(sConn.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setStorageContextMenu({ mouseX: e.clientX, mouseY: e.clientY, conn: sConn });
                    }}
                    title={`${sConn.name} — S3 · ${sConn.bucket}${sConn.endpoint ? ` · ${sConn.endpoint}` : ''}`}
                    className={`group relative w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                      isActive
                        ? 'bg-amber-500/15 text-amber-50 font-semibold ring-1 ring-amber-500/30 shadow-sm shadow-amber-500/10'
                        : 'text-slate-300 hover:bg-white/5'
                    } ${dragConnId === sConn.id ? 'opacity-50' : ''}`}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-amber-400" />
                    )}
                    {/* S3 rows have no expand chevron (no schema tree to open),
                        but DB rows do — this spacer is exactly the width of
                        the DB row's chevron button (14px icon + 2px padding
                        each side = 18px) so the connection name always starts
                        at the same x whether the row has a chevron or not. */}
                    <span className="w-[18px] shrink-0" />
                    <Cloud className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-amber-400' : 'text-slate-500 group-hover:text-amber-400'}`} />
                    <div className="truncate flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className={`truncate text-[13px] ${isActive ? 'text-amber-50' : ''}`}>{sConn.name}</span>
                      </div>
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveStorageConnection(sConn.id);
                          openStorageTab(sConn.id);
                        }}
                        className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-amber-400 transition-colors"
                        title="Browse Objects"
                      >
                        <Cloud className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingStorage(sConn);
                          setStorageDialogOpen(true);
                        }}
                        className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-slate-200 transition-colors"
                        title="Edit Connection"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete storage connection "${sConn.name}"? This does not delete any stored objects.`)) {
                            deleteStorageConnection(sConn.id);
                          }
                        }}
                        className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-red-400 transition-colors"
                        title="Delete Connection"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            };

            // Filtered storage connections (by name or bucket) so the active
            // search query narrows both DB and S3 rows uniformly.
            const filteredStorage = storageConnections.filter((c) =>
              filterQuery
                ? c.name.toLowerCase().includes(filterQuery.toLowerCase()) ||
                  c.bucket.toLowerCase().includes(filterQuery.toLowerCase())
                : true,
            );

            // Render: flat when nothing is tagged, otherwise grouped into folders.
            // S3 connections participate in the same tag-folder system as DB
            // connections — a folder can hold a mix of both.
            if (!hasAnyTagged) {
              return (
                <>
                  {[...filtered]
                    .sort((a, b) => Number(!!b.isFavorite) - Number(!!a.isFavorite))
                    .map((conn) => renderConnectionRow(conn))}
                  {filteredStorage.map((sConn) => renderStorageRow(sConn))}
                </>
              );
            }

            // Build a combined folder structure over DB + S3 connections so
            // a single tag folder can contain both. `groupByTag` is generic
            // over `{ tagId }`, so we project both lists to a minimal shape
            // and then resolve full objects by id at render time.
            const combinedFolders = groupByTag(
              [
                ...filtered.map((c) => ({ id: c.id, name: c.name, tagId: c.tagId })),
                ...filteredStorage.map((c) => ({ id: c.id, name: c.name, tagId: c.tagId })),
              ],
              tags,
              tagOrder,
            );

            return (
              <>
                {combinedFolders.map((folder) => {
                  // The untagged bucket gets no folder wrapper — it renders
                  // flat, right after the tag folders (handled below), so
                  // there's no "Other" folder cluttering the tree by default.
                  if (!folder.tag) return null;
                  const tag = folder.tag;

                  const folderDbConns = folder.connections
                    .map((fc) => filtered.find((c) => c.id === fc.id))
                    .filter((c): c is DatabaseConnection => !!c)
                    .sort((a, b) => Number(!!b.isFavorite) - Number(!!a.isFavorite));
                  const folderStorageConns = folder.connections
                    .map((fc) => filteredStorage.find((c) => c.id === fc.id))
                    .filter((c): c is S3ConnectionConfig => !!c);
                  const folderTotal = folderDbConns.length + folderStorageConns.length;
                  if (folderTotal === 0) return null;
                  const folderKey = tag.id;
                  const isFolderExpanded = !!filterQuery || expandedFolders.has(tag.id);
                  const isDragOver = dragOverFolder === folderKey;
                  return (
                    <div
                      key={folderKey}
                      className={`mb-1 rounded-lg transition-colors ${
                        isDragOver ? 'bg-blue-500/10 ring-1 ring-blue-500/40' : ''
                      }`}
                      // The ENTIRE folder (header + children) is one drop zone.
                      // Putting the handlers on the outer wrapper — instead of only
                      // the header — fixes two issues:
                      //   1. Dropping onto a child row while the folder is open now
                      //      assigns the tag instead of being swallowed by the row.
                      //   2. onDragLeave no longer fires when the cursor crosses
                      //      from the header into a child, which previously reset
                      //      the highlight and made the folder feel "not working".
                      onDragOver={(e) => {
                        // Use the module-level dragTracker as the source of truth —
                        // dragConnId React state can be stale at this point because
                        // the re-render from setDragConnId in onDragStart may not
                        // have committed before the cursor enters the folder.
                        if (dragTracker.id) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (dragOverFolder !== folderKey) setDragOverFolder(folderKey);
                        }
                      }}
                      onDragLeave={(e) => {
                        // Only clear when the cursor truly leaves the folder — i.e.
                        // the relatedTarget is outside this element. Without this
                        // check, moving between child rows would flicker the state.
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          if (dragOverFolder === folderKey) setDragOverFolder(null);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        // Use the module-level dragTracker (set synchronously in
                        // onDragStart) as the primary source — dataTransfer.getData()
                        // can return empty strings in WebKit/Tauri for custom MIME
                        // types, and dragConnId state can be stale.
                        const draggedId = dragTracker.id;
                        const draggedType = dragTracker.type;
                        if (draggedId && draggedType === 'storage') {
                          moveStorageConnection(draggedId, tag.id);
                        } else if (draggedId && draggedType === 'db') {
                          moveConnection(draggedId, tag.id);
                        } else {
                          // Fallback: try dataTransfer MIME keys (including the
                          // text/plain fallback that WebKit honors), then state.
                          const storageId = e.dataTransfer.getData('text/storage-id');
                          const dbId = e.dataTransfer.getData('text/conn-id');
                          const plainId = e.dataTransfer.getData('text/plain');
                          const fallbackId = storageId || dbId || plainId || dragConnId;
                          if (fallbackId) {
                            if (fallbackId.startsWith('stor_')) {
                              moveStorageConnection(fallbackId, tag.id);
                            } else {
                              moveConnection(fallbackId, tag.id);
                            }
                          }
                        }
                        setDragConnId(null);
                        setDragOverFolder(null);
                      }}
                    >
                      {/* Folder Header — click/context-menu only; DnD is on the wrapper. */}
                      <div
                        onClick={() => toggleFolder(tag.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setFolderContextMenu({ mouseX: e.clientX, mouseY: e.clientY, tag });
                        }}
                        className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                          isDragOver ? '' : 'hover:bg-white/5'
                        }`}
                      >
                        {isFolderExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        )}
                        <span
                          className="w-3 h-3 rounded-sm shrink-0"
                          style={{ backgroundColor: tag.color }}
                        />
                        <span className="text-[9.5px] font-bold uppercase tracking-wider text-slate-500 truncate flex-1">
                          {tag.label}
                        </span>
                        <span className="text-[9px] text-slate-600 font-mono">{folderTotal}</span>
                      </div>

                      {/* Folder Contents — an inset box-shadow (not a real
                          border) draws the accent line without taking up
                          layout width, so these rows start at the exact same
                          x as the flat untagged rows below (no margin/padding
                          offset needed to "make room" for the border). */}
                      {isFolderExpanded && (
                        <div
                          className="mt-0.5 mb-0.5"
                          style={{ boxShadow: `inset 2px 0 0 0 ${hexToRgba(tag.color, 0.4)}` }}
                        >
                          {folderDbConns.map((conn) => renderConnectionRow(conn))}
                          {folderStorageConns.map((sConn) => renderStorageRow(sConn))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Untagged connections render flat, with no "Other" folder
                    wrapper — there's no such tag by default. They still
                    fully participate in drag-to-tag (dragging one onto a
                    folder above sets its tag) and the untag drop zones. */}
                {(() => {
                  const untaggedFolder = combinedFolders.find((f) => !f.tag);
                  if (!untaggedFolder) return null;
                  const untaggedDbConns = untaggedFolder.connections
                    .map((fc) => filtered.find((c) => c.id === fc.id))
                    .filter((c): c is DatabaseConnection => !!c)
                    .sort((a, b) => Number(!!b.isFavorite) - Number(!!a.isFavorite));
                  const untaggedStorageConns = untaggedFolder.connections
                    .map((fc) => filteredStorage.find((c) => c.id === fc.id))
                    .filter((c): c is S3ConnectionConfig => !!c);
                  return (
                    <>
                      {untaggedDbConns.map((conn) => renderConnectionRow(conn))}
                      {untaggedStorageConns.map((sConn) => renderStorageRow(sConn))}
                    </>
                  );
                })()}
              </>
            );
          })()
        )}

        {/* Drop-to-untag zone — appears only during a drag. Dropping a
            connection here clears its tag, removing it from any folder. This
            is the "drag out of tag" affordance: the user drags a row out of
            its folder and drops it on this area at the bottom of the tree. */}
        {dragConnId && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dragOverFolder !== '__untag__') setDragOverFolder('__untag__');
            }}
            onDragLeave={() => {
              if (dragOverFolder === '__untag__') setDragOverFolder(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const draggedId = dragTracker.id;
              if (draggedId) {
                if (dragTracker.type === 'storage') {
                  moveStorageConnection(draggedId, null);
                } else {
                  moveConnection(draggedId, null);
                }
              }
              setDragConnId(null);
              dragTracker.id = null;
              dragTracker.type = null;
              setDragOverFolder(null);
            }}
            className={`mt-2 mx-1 py-2 rounded-lg border-2 border-dashed flex items-center justify-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider transition-all ${
              dragOverFolder === '__untag__'
                ? 'border-blue-500/60 bg-blue-500/15 text-blue-300'
                : 'border-[#1e293b] text-slate-600'
            }`}
          >
            <XIcon className="w-3 h-3" />
            <span>Drop to remove tag</span>
          </div>
        )}
      </div>

      {/* Sync Footer — "New SQL Editor"/"Browse Redis Keys" used to live
          here; removed as redundant (also reachable from Header, the tab
          bar's own "+", and File-menu equivalents in MainLayout.tsx). Only
          rendered when cloud sync is actually usable (build has it
          configured and the user is signed in) — otherwise there's nothing
          useful for this footer to show, so it just doesn't render. */}
      {cloudConfigured && authStatus === 'signed-in' && (
        <div className="p-2 border-t border-[#1e293b] flex items-center gap-1.5 bg-[#06090e]">
          <button
            onClick={() => void syncNow()}
            disabled={syncStatus === 'syncing'}
            className="flex-1 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            title="Sync connections and settings now"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
            Sync
          </button>
          <button
            onClick={() => setSettingsModalOpen(true, 'account')}
            className="p-1.5 rounded-lg hover:bg-[#1e293b] transition-colors shrink-0"
            title={
              syncStatus === 'error'
                ? syncError || 'Sync error — click for details'
                : syncConflicts.length > 0
                  ? `${syncConflicts.length} sync conflict${syncConflicts.length > 1 ? 's' : ''} — click to resolve`
                  : lastSyncedAt
                    ? `Last synced ${timeAgo(lastSyncedAt)} — click for sync settings`
                    : 'Not synced yet — click for sync settings'
            }
          >
            {syncStatus === 'syncing' ? (
              <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />
            ) : syncStatus === 'error' ? (
              <AlertCircle className="w-3.5 h-3.5 text-red-400" />
            ) : syncConflicts.length > 0 ? (
              <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
            ) : lastSyncedAt ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
            )}
          </button>
        </div>
      )}

      {/* Storage connection edit dialog (opened from an S3 row's Edit action). */}
      {storageDialogOpen && (
        <StorageConnectionDialog
          editing={editingStorage}
          onClose={() => {
            setStorageDialogOpen(false);
            setEditingStorage(null);
          }}
        />
      )}

      {/* Custom Right-Click Context Menu */}
      {tableContextMenu && (
        <ClampedContextMenu
          clickX={tableContextMenu.mouseX}
          clickY={tableContextMenu.mouseY}
          menuWidth={224}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-56 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate">
            table: {tableContextMenu.table.name}
          </div>

          <button
            onClick={() => {
              handleTableClick(tableContextMenu.conn, tableContextMenu.table.name, tableContextMenu.group?.name || '');
              setTableContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-emerald-400"
          >
            <TableIcon className="w-3.5 h-3.5" />
            <span>{isMongoEngine(tableContextMenu.conn.engine) ? 'Open Documents' : 'Open Data Grid'}</span>
          </button>

          {isMongoEngine(tableContextMenu.conn.engine) && tableContextMenu.group && (
            <>
              <button
                onClick={() => {
                  handleTableClick(tableContextMenu.conn, tableContextMenu.table.name, tableContextMenu.group?.name || '');
                  setTableContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Document…</span>
              </button>
              <button
                onClick={() => {
                  setMongoStatsCtx({
                    conn: tableContextMenu.conn,
                    database: tableContextMenu.group!.name,
                    collectionName: tableContextMenu.table.name,
                  });
                  setTableContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
              >
                <Gauge className="w-3.5 h-3.5" />
                <span>Collection Stats</span>
              </button>
              <div className="h-px bg-[#1e293b] my-1" />
              <button
                onClick={() => {
                  setMongoDropCollectionCtx({
                    conn: tableContextMenu.conn,
                    database: tableContextMenu.group!.name,
                    collectionName: tableContextMenu.table.name,
                  });
                  setTableContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Drop {tableContextMenu.table.node_type === 'view' ? 'View' : 'Collection'}</span>
              </button>
            </>
          )}

          {/* Everything below assumes a SQL table (structure editing, DDL
              generation, ERD, maintenance ops, drop/truncate) — none of it
              has a MongoDB equivalent, so it's hidden entirely for Mongo
              rather than exposing actions that would generate broken SQL
              against a collection. Mongo gets its own actions above instead. */}
          {!isMongoEngine(tableContextMenu.conn.engine) && (
            <>
          {/* "Edit" opens the table-structure modal, which builds ALTER TABLE
              statements — invalid SQL against a view (needs ALTER VIEW /
              CREATE OR REPLACE VIEW instead). Views get "Edit View
              Definition..." below (opens the SQL code editor) as their only
              edit action, so this is table-only. */}
          {tableContextMenu.table.node_type !== 'view' && (
            <button
              onClick={() => {
                setStructureCtx({
                  conn: tableContextMenu.conn,
                  group: tableContextMenu.group,
                  table: tableContextMenu.table,
                });
                setTableContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
            >
              <Info className="w-3.5 h-3.5" />
              <span>Edit</span>
            </button>
          )}

          {tableContextMenu.table.node_type === 'view' && (
            <button
              onClick={() => {
                void openEditObjectTab(
                  tableContextMenu.conn,
                  tableContextMenu.group?.name,
                  'view',
                  tableContextMenu.table.name
                );
                setTableContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Edit</span>
            </button>
          )}

          {/* Create New ▸ — fly-out submenu with the "new" actions. */}
          <ContextSubMenu
            label="Create New"
            icon={<Plus className="w-3.5 h-3.5" />}
            tone="text-blue-400"
          >
            {(close) => (
              <>
                <button
                  onClick={() => {
                    const ctx = tableContextMenu;
                    openSqlTab(
                      `${ctx.table.name}.sql`,
                      selectPreviewSql(
                        ctx.conn.engine,
                        ctx.table.name,
                        ctx.group.name
                      ),
                      ctx.conn.id,
                      ctx.group?.name
                    );
                    close();
                    setTableContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
                >
                  <FileCode className="w-3.5 h-3.5" />
                  <span>Select Query</span>
                </button>
                <button
                  onClick={() => {
                    const ctx = tableContextMenu;
                    setCreateTableCtx({ conn: ctx.conn, schemaName: ctx.group.name });
                    close();
                    setTableContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                >
                  <TableIcon className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Table…</span>
                </button>
                <button
                  onClick={() => {
                    const ctx = tableContextMenu;
                    openCreateObjectTab(ctx.conn, ctx.group.name, 'view');
                    close();
                    setTableContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                >
                  <Eye className="w-3.5 h-3.5 text-cyan-400" />
                  <span>View…</span>
                </button>
                {supportsTriggers(tableContextMenu.conn.engine) && (
                  <button
                    onClick={() => {
                      const ctx = tableContextMenu;
                      // Pre-fill the trigger's table with the right-clicked table.
                      openCreateObjectTab(ctx.conn, ctx.group.name, 'trigger', ctx.table.name);
                      close();
                      setTableContextMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    <span>Trigger…</span>
                  </button>
                )}
                {supportsProcedures(tableContextMenu.conn.engine) && (
                  <button
                    onClick={() => {
                      const ctx = tableContextMenu;
                      openCreateObjectTab(ctx.conn, ctx.group.name, 'procedure');
                      close();
                      setTableContextMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                  >
                    <Braces className="w-3.5 h-3.5 text-violet-400" />
                    <span>Stored Procedure…</span>
                  </button>
                )}
                {supportsEvents(tableContextMenu.conn.engine) && (
                  <button
                    onClick={() => {
                      const ctx = tableContextMenu;
                      openCreateObjectTab(ctx.conn, ctx.group.name, 'event');
                      close();
                      setTableContextMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                  >
                    <Clock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Event…</span>
                  </button>
                )}
              </>
            )}
          </ContextSubMenu>

          <button
            onClick={() => handleFocusInErd(tableContextMenu.conn, tableContextMenu.group, tableContextMenu.table)}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-purple-400"
          >
            <GitFork className="w-3.5 h-3.5" />
            <span>ERD Studio</span>
          </button>


          {(() => {
            const ctx = tableContextMenu;
            const caps = getTableCapabilities(ctx.conn.engine);
            const hasAutoInc =
              !!detectAutoIncrementColumn(ctx.conn.engine, ctx.table.children) &&
              caps.supportsResetAutoIncrement;
            return (
              <button
                onClick={() => hasAutoInc && openTableAction('reset', ctx.conn, ctx.group, ctx.table)}
                disabled={!hasAutoInc}
                title={hasAutoInc ? 'Reset the table auto-increment / sequence value' : 'This table has no auto-increment / identity / sequence column'}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium ${
                  hasAutoInc ? 'text-blue-400' : 'text-slate-600 cursor-not-allowed'
                }`}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Auto Increment</span>
              </button>
            );
          })()}

          {/* Maintenance submenu items — only the ops this engine supports */}
          {(() => {
            const ctx = tableContextMenu;
            const ops = getTableCapabilities(ctx.conn.engine).maintenanceOps;
            if (ops.length === 0) return null;
            return (
              <>
                <div className="h-px bg-[#1e293b] my-1" />
                <div className="px-3 py-0.5 text-[9px] uppercase tracking-wider text-slate-600 font-semibold">Maintenance</div>
                {ops.map((op) => (
                  <button
                    key={op}
                    onClick={() => openTableAction(op, ctx.conn, ctx.group, ctx.table)}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                  >
                    <Gauge className="w-3.5 h-3.5 text-cyan-400" />
                    <span>{maintenanceOpLabel(op)}</span>
                  </button>
                ))}
              </>
            );
          })()}

          <div className="h-px bg-[#1e293b] my-1" />

          {/* Delete All Rows (DELETE FROM — works on every engine) */}
          <button
            onClick={() => openTableAction('deleteAll', tableContextMenu.conn, tableContextMenu.group, tableContextMenu.table)}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-orange-400"
          >
            <Eraser className="w-3.5 h-3.5" />
            <span>Delete All Rows</span>
          </button>

          {/* Truncate Table (engine-native — disabled when unsupported) */}
          {(() => {
            const ctx = tableContextMenu;
            const sql = truncateTableSql(ctx.conn.engine, ctx.table.name, ctx.group.name);
            const supported = !!sql && getTableCapabilities(ctx.conn.engine).supportsTruncate;
            return (
              <button
                onClick={() => supported && openTableAction('truncate', ctx.conn, ctx.group, ctx.table)}
                disabled={!supported}
                title={supported ? 'TRUNCATE TABLE — fast, resets identity' : 'Not supported by this engine (use Delete All Rows)'}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium ${
                  supported ? 'text-amber-400' : 'text-slate-600 cursor-not-allowed'
                }`}
              >
                <Eraser className="w-3.5 h-3.5" />
                <span>Truncate Table</span>
              </button>
            );
          })()}

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => openTableAction('drop', tableContextMenu.conn, tableContextMenu.group, tableContextMenu.table)}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Drop Table</span>
          </button>
            </>
          )}
        </ClampedContextMenu>
      )}

      {/* Custom Right-Click Context Menu for Database/Schema Nodes */}
      {groupContextMenu && (
        <ClampedContextMenu
          clickX={groupContextMenu.mouseX}
          clickY={groupContextMenu.mouseY}
          menuWidth={240}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-60 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate">
            schema: {groupContextMenu.group.name}
          </div>

          {(() => {
            const isPinned = (pinnedSchemasByConn[groupContextMenu.conn.id] || []).includes(groupContextMenu.group.name);
            return (
              <button
                onClick={() => {
                  togglePinnedSchema(groupContextMenu.conn.id, groupContextMenu.group.name);
                  setGroupContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
              >
                <Pin className="w-3.5 h-3.5" />
                <span>{isPinned ? 'Unpin' : 'Pin to Top'}</span>
              </button>
            );
          })()}

          {/* Create New / ERD / Backup / Restore all assume a SQL engine —
              none have a MongoDB equivalent yet, so they're hidden entirely
              rather than exposing actions that would silently do the wrong
              thing (or nothing) against a Mongo database. "Empty"/"Drop
              Database" below are already hidden automatically —
              `getDatabaseCapabilities` has no 'mongodb' case, so both
              capabilities default to false. */}
          {!isMongoEngine(groupContextMenu.conn.engine) && (
            <>
          {/* Create New ▸ — fly-out submenu listing every object type the
              engine supports (table always; view/trigger/procedure/event
              gated by engine capabilities). Opens the structured object
              editor tab (or the table designer for tables). */}
          <ContextSubMenu
            label="Create New"
            icon={<Plus className="w-3.5 h-3.5" />}
            tone="text-emerald-400"
            panelWidth={210}
          >
            {(close) => (
              <>
                <button
                  onClick={() => {
                    setCreateTableCtx({ conn: groupContextMenu.conn, schemaName: groupContextMenu.group.name });
                    close();
                    setGroupContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                >
                  <TableIcon className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Table…</span>
                </button>
                <button
                  onClick={() => {
                    openCreateObjectTab(groupContextMenu.conn, groupContextMenu.group.name, 'view');
                    close();
                    setGroupContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                >
                  <Eye className="w-3.5 h-3.5 text-cyan-400" />
                  <span>View…</span>
                </button>
                {supportsTriggers(groupContextMenu.conn.engine) && (
                  <button
                    onClick={() => {
                      openCreateObjectTab(groupContextMenu.conn, groupContextMenu.group.name, 'trigger');
                      close();
                      setGroupContextMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    <span>Trigger…</span>
                  </button>
                )}
                {supportsProcedures(groupContextMenu.conn.engine) && (
                  <button
                    onClick={() => {
                      openCreateObjectTab(groupContextMenu.conn, groupContextMenu.group.name, 'procedure');
                      close();
                      setGroupContextMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                  >
                    <Braces className="w-3.5 h-3.5 text-violet-400" />
                    <span>Stored Procedure…</span>
                  </button>
                )}
                {supportsEvents(groupContextMenu.conn.engine) && (
                  <button
                    onClick={() => {
                      openCreateObjectTab(groupContextMenu.conn, groupContextMenu.group.name, 'event');
                      close();
                      setGroupContextMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                  >
                    <Clock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Event…</span>
                  </button>
                )}
              </>
            )}
          </ContextSubMenu>

          <button
            onClick={() => handleShowRelationshipDiagram(groupContextMenu.conn, groupContextMenu.group)}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
          >
            <GitFork className="w-3.5 h-3.5" />
            <span>Open ERD Studio</span>
          </button>
            </>
          )}

          <button
            onClick={() => {
              refreshConnection(groupContextMenu.conn, groupContextMenu.group);
              setGroupContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>

          {isMongoEngine(groupContextMenu.conn.engine) && (
            <>
              <button
                onClick={() => {
                  setMongoCreateCollectionCtx({ conn: groupContextMenu.conn, database: groupContextMenu.group.name });
                  setGroupContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-emerald-400"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Collection…</span>
              </button>
              <button
                onClick={() => {
                  setMongoStatsCtx({ conn: groupContextMenu.conn, database: groupContextMenu.group.name });
                  setGroupContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
              >
                <Gauge className="w-3.5 h-3.5" />
                <span>Database Stats</span>
              </button>
              <div className="h-px bg-[#1e293b] my-1" />
              <button
                onClick={() => {
                  setMongoDropDatabaseCtx({ conn: groupContextMenu.conn, database: groupContextMenu.group.name });
                  setGroupContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Drop Database</span>
              </button>
            </>
          )}

          {!isMongoEngine(groupContextMenu.conn.engine) && (
            <>
          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => {
              setBackupGroupName(groupContextMenu.group.name);
              setBackupConn(groupContextMenu.conn);
              setGroupContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-amber-400"
          >
            <HardDriveDownload className="w-3.5 h-3.5" />
            <span>Backup...</span>
          </button>

          <button
            onClick={() => {
              setRestoreConn(groupContextMenu.conn);
              setGroupContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-purple-400"
          >
            <HardDriveUpload className="w-3.5 h-3.5" />
            <span>Restore...</span>
          </button>
            </>
          )}

          {(() => {
            const ctx = groupContextMenu;
            const caps = getDatabaseCapabilities(ctx.conn.engine);
            const canManage = caps.supportsEmpty || caps.supportsDrop;
            if (!canManage) return null;
            const isProtected = isProtectedName(ctx.conn.engine, ctx.group.name);
            return (
              <>
                <div className="h-px bg-[#1e293b] my-1" />

                {caps.supportsEmpty && !isProtected && (
                  <button
                    onClick={() => openDbAction('emptyDb', ctx.conn, ctx.group)}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-amber-400"
                  >
                    <Eraser className="w-3.5 h-3.5" />
                    <span>Empty {caps.entityLabel}</span>
                  </button>
                )}

                {caps.supportsDrop && !isProtected && (
                  <button
                    onClick={() => openDbAction('dropDb', ctx.conn, ctx.group)}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Drop {caps.entityLabel}</span>
                  </button>
                )}

                {isProtected && (
                  <div className="px-3 py-1.5 text-[10px] text-slate-600 italic">
                    System {caps.entityLabel.toLowerCase()} — cannot be dropped
                  </div>
                )}
              </>
            );
          })()}
        </ClampedContextMenu>
      )}

      {/* Global Explorer context menu (right-click on empty tree area). */}
      {explorerCtxMenu && (
        <ClampedContextMenu
          clickX={explorerCtxMenu.mouseX}
          clickY={explorerCtxMenu.mouseY}
          menuWidth={224}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-56 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase">
            Explorer
          </div>

          <button
            onClick={() => {
              setConnectionModalOpen(true);
              setExplorerCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-emerald-400"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Connection…</span>
          </button>

          <button
            onClick={() => {
              setCreateTagForConn(null);
              setCreateTagOpen(true);
              setExplorerCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
          >
            <TagIcon className="w-3.5 h-3.5" />
            <span>New Tag…</span>
          </button>

          <button
            onClick={() => {
              setManageTagsOpen(true);
              setExplorerCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Manage Tags…</span>
          </button>

          {/* Show ▸ — tree display toggles, grouped into one submenu so this
              doesn't grow into a wall of checkboxes at the top level as more
              get added. */}
          <ContextSubMenu label="Show" icon={<Eye className="w-3.5 h-3.5" />} tone="text-slate-300" panelWidth={200}>
            {(close) => (
              <>
                {/* System schemas (pg_catalog / information_schema / mysql / sys …).
                    Mirrors the Settings → Query Execution toggle, surfaced here so
                    it's a couple clicks away. Refreshes every expanded connection
                    on toggle. */}
                <button
                  onClick={() => {
                    setShowSystemSchemas(!showSystemSchemas);
                    // Re-fetch expanded trees so the change is visible immediately.
                    setTimeout(() => {
                      expandedConnIds.forEach((id) => {
                        const c = connections.find((cc) => cc.id === id);
                        if (c) loadSchemaForConnection(c);
                      });
                    }, 0);
                    close();
                    setExplorerCtxMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  {showSystemSchemas ? (
                    <Check className="w-3.5 h-3.5 text-cyan-400" />
                  ) : (
                    <Database className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span>System Schemas</span>
                </button>

                {/* Per-table row-count badge (and the schema/database header's
                    aggregate row count, folded into its size-badge tooltip). */}
                <button
                  onClick={() => {
                    setShowRowCounts(!showRowCounts);
                    close();
                    setExplorerCtxMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  {showRowCounts ? (
                    <Check className="w-3.5 h-3.5 text-cyan-400" />
                  ) : (
                    <Hash className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span>Row Counts</span>
                </button>

                {/* Per-table size badge (and the schema/database header's
                    aggregate size badge). */}
                <button
                  onClick={() => {
                    setShowTableSizes(!showTableSizes);
                    close();
                    setExplorerCtxMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  {showTableSizes ? (
                    <Check className="w-3.5 h-3.5 text-cyan-400" />
                  ) : (
                    <HardDrive className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span>Table Sizes</span>
                </button>
              </>
            )}
          </ContextSubMenu>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => {
              // Expand every connection row (groups load lazily as each opens).
              setExpandedConnIds(new Set(connections.map((c) => c.id)));
              setExplorerCtxMenu(null);
            }}
            disabled={connections.length === 0}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            <span>Expand All</span>
          </button>

          <button
            onClick={() => {
              setExpandedConnIds(new Set());
              setExpandedNodeKeys(new Set());
              setExplorerCtxMenu(null);
            }}
            disabled={expandedConnIds.size === 0 && expandedNodeKeys.size === 0}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronRight className="w-3.5 h-3.5" />
            <span>Collapse All</span>
          </button>

          <button
            onClick={() => {
              unpinAll();
              setExplorerCtxMenu(null);
            }}
            disabled={
              !connections.some((c) => c.isFavorite) &&
              !Object.values(pinnedSchemasByConn).some((arr) => arr && arr.length > 0)
            }
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Unpin every connection and database/schema"
          >
            <PinOff className="w-3.5 h-3.5" />
            <span>Unpin All</span>
          </button>

          <button
            onClick={() => {
              // Re-fetch the schema tree for every expanded connection.
              expandedConnIds.forEach((id) => {
                const c = connections.find((cc) => cc.id === id);
                if (c) loadSchemaForConnection(c);
              });
              setExplorerCtxMenu(null);
            }}
            disabled={expandedConnIds.size === 0}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh All</span>
          </button>
        </ClampedContextMenu>
      )}

      {/* Custom Right-Click Context Menu for Connection Nodes */}
      {connContextMenu && (
        <ClampedContextMenu
          clickX={connContextMenu.mouseX}
          clickY={connContextMenu.mouseY}
          menuWidth={240}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-60 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate">
            connection: {connContextMenu.conn.name}
          </div>

          <button
            onClick={() => {
              toggleFavorite(connContextMenu.conn.id);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
          >
            <Pin className="w-3.5 h-3.5" />
            <span>{connContextMenu.conn.isFavorite ? 'Unpin Connection' : 'Pin Connection to Top'}</span>
          </button>

          {/* Per-connection "show system schemas" override (Postgres/MySQL only).
              Undefined on the connection = inherit the global default; once
              toggled here it becomes an explicit per-connection preference. */}
          {/* Postgres only: manage installed extensions (install/uninstall). */}
          {isPostgresFamily(connContextMenu.conn.engine) && (
            <button
              onClick={() => {
                setManageExtConn(connContextMenu.conn);
                setConnContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-fuchsia-400"
            >
              <Puzzle className="w-3.5 h-3.5" />
              <span>Manage Extensions…</span>
            </button>
          )}

          {connContextMenu.conn.engine !== 'sqlite' && connContextMenu.conn.engine !== 'duckdb' && connContextMenu.conn.engine !== 'cloudflare-d1' && connContextMenu.conn.engine !== 'redis' && (
            <button
              onClick={() => {
                setCreateDbConn(connContextMenu.conn);
                setConnContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
            >
              <DatabaseZap className="w-3.5 h-3.5" />
              <span>Create Database...</span>
            </button>
          )}

          {/* Create New ▸ — objects created against a best-effort default
              schema for this connection (Postgres → `public`, MySQL → the
              connection's database, SQLite → the file). For MySQL with no
              database picked, the items disable until a target is chosen —
              use the group (database) menu in that case. Redis has no DDL
              concept at all, so the whole submenu is skipped for it. */}
          {connContextMenu.conn.engine !== 'redis' && (() => {
            const c = connContextMenu.conn;
            const targetSchema = isPostgresFamily(c.engine)
              ? 'public'
              : isMysqlFamily(c.engine)
              ? c.database || undefined
              : undefined; // sqlite/d1 — no schema qualifier needed
            const mysqlNeedsDb = isMysqlFamily(c.engine) && !targetSchema;
            return (
              <ContextSubMenu
                label="Create New"
                icon={<Plus className="w-3.5 h-3.5" />}
                tone="text-emerald-400"
                panelWidth={210}
              >
                {(close) => (
                  <>
                    <button
                      onClick={() => {
                        setCreateTableCtx({ conn: c, schemaName: targetSchema });
                        close();
                        setConnContextMenu(null);
                      }}
                      disabled={mysqlNeedsDb}
                      className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <TableIcon className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Table…</span>
                    </button>
                    <button
                      onClick={() => {
                        openCreateObjectTab(c, targetSchema, 'view');
                        close();
                        setConnContextMenu(null);
                      }}
                      disabled={mysqlNeedsDb}
                      className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Eye className="w-3.5 h-3.5 text-cyan-400" />
                      <span>View…</span>
                    </button>
                    {supportsTriggers(c.engine) && (
                      <button
                        onClick={() => {
                          openCreateObjectTab(c, targetSchema, 'trigger');
                          close();
                          setConnContextMenu(null);
                        }}
                        disabled={mysqlNeedsDb}
                        className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Zap className="w-3.5 h-3.5 text-amber-400" />
                        <span>Trigger…</span>
                      </button>
                    )}
                    {supportsProcedures(c.engine) && (
                      <button
                        onClick={() => {
                          openCreateObjectTab(c, targetSchema, 'procedure');
                          close();
                          setConnContextMenu(null);
                        }}
                        disabled={mysqlNeedsDb}
                        className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Braces className="w-3.5 h-3.5 text-violet-400" />
                        <span>Stored Procedure…</span>
                      </button>
                    )}
                    {supportsEvents(c.engine) && (
                      <button
                        onClick={() => {
                          openCreateObjectTab(c, targetSchema, 'event');
                          close();
                          setConnContextMenu(null);
                        }}
                        disabled={mysqlNeedsDb}
                        className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Clock className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Event…</span>
                      </button>
                    )}
                  </>
                )}
              </ContextSubMenu>
            );
          })()}

          <button
            onClick={() => {
              loadSchemaForConnection(connContextMenu.conn);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>

          <button
            onClick={() => {
              openEditConnection(connContextMenu.conn);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>Edit Connection</span>
          </button>

          {/* Tags — collapsed into one fly-out row instead of one row per tag,
              so a large tag list doesn't blow up the menu's height. */}
          <div className="h-px bg-[#1e293b] my-1" />
          <ContextSubMenu
            label="Tags"
            icon={<TagIcon className="w-3.5 h-3.5" />}
            tone="text-slate-300"
            panelWidth={200}
          >
            {(close) => (
              <>
                {tags.length === 0 && (
                  <div className="px-3 py-1.5 text-[10.5px] text-slate-600 italic">No tags yet</div>
                )}
                {tags.map((tag) => {
                  const active = connContextMenu.conn.tagId === tag.id;
                  return (
                    <button
                      key={tag.id}
                      onClick={() => {
                        storeSetConnectionTag(connContextMenu.conn.id, active ? null : tag.id);
                        close();
                        setConnContextMenu(null);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                    >
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: tag.color }} />
                      <span className="flex-1 truncate">{tag.label}</span>
                      {active && <Check className="w-3 h-3 text-emerald-400 shrink-0" />}
                    </button>
                  );
                })}
                {connContextMenu.conn.tagId && (
                  <button
                    onClick={() => {
                      storeSetConnectionTag(connContextMenu.conn.id, null);
                      close();
                      setConnContextMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-500"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                    <span>Clear tag</span>
                  </button>
                )}
                <div className="h-px bg-[#1e293b] my-1" />
                <button
                  onClick={() => {
                    setCreateTagForConn(connContextMenu.conn.id);
                    setCreateTagOpen(true);
                    close();
                    setConnContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Tag…</span>
                </button>
                <button
                  onClick={() => {
                    setManageTagsOpen(true);
                    close();
                    setConnContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span>Manage Tags…</span>
                </button>
              </>
            )}
          </ContextSubMenu>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => {
              setActiveConnection(connContextMenu.conn.id);
              setActiveView('health');
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-emerald-400"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Database Health</span>
          </button>

          {(connContextMenu.conn.engine === 'mysql' || connContextMenu.conn.engine === 'postgres' || connContextMenu.conn.engine === 'mssql') && (
            <button
              onClick={() => {
                setActiveConnection(connContextMenu.conn.id);
                openUsersTab(connContextMenu.conn.id);
                setConnContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
            >
              <UsersIcon className="w-3.5 h-3.5" />
              <span>Users & Privileges</span>
            </button>
          )}

          <button
            onClick={() => {
              handleDuplicateConnection(connContextMenu.conn);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <CopyPlus className="w-3.5 h-3.5" />
            <span>Duplicate Connection</span>
          </button>

          <button
            onClick={() => {
              openEncryptedConnectionsModal('export', connContextMenu.conn);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Connections</span>
          </button>

          <button
            onClick={() => {
              handleDisconnect(connContextMenu.conn);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-amber-400"
          >
            <Unplug className="w-3.5 h-3.5" />
            <span>Disconnect</span>
          </button>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => {
              setBackupGroupName(undefined);
              setBackupConn(connContextMenu.conn);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-amber-400"
          >
            <HardDriveDownload className="w-3.5 h-3.5" />
            <span>Backup...</span>
          </button>

          <button
            onClick={() => {
              setRestoreConn(connContextMenu.conn);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-purple-400"
          >
            <HardDriveUpload className="w-3.5 h-3.5" />
            <span>Restore...</span>
          </button>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => {
              deleteConnection(connContextMenu.conn.id);
              setConnContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete Connection</span>
          </button>
        </ClampedContextMenu>
      )}

      {/* Custom Right-Click Context Menu for Storage Connection Nodes */}
      {storageContextMenu && (
        <ClampedContextMenu
          clickX={storageContextMenu.mouseX}
          clickY={storageContextMenu.mouseY}
          menuWidth={240}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-60 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate">
            storage: {storageContextMenu.conn.name}
          </div>

          <button
            onClick={() => {
              setActiveStorageConnection(storageContextMenu.conn.id);
              openStorageTab(storageContextMenu.conn.id);
              setStorageContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-amber-400"
          >
            <Cloud className="w-3.5 h-3.5" />
            <span>Browse Objects</span>
          </button>

          <button
            onClick={() => {
              setEditingStorage(storageContextMenu.conn);
              setStorageDialogOpen(true);
              setStorageContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>Edit Connection</span>
          </button>

          {/* Tags — same collapsed fly-out pattern as DB connections. */}
          <div className="h-px bg-[#1e293b] my-1" />
          <ContextSubMenu
            label="Tags"
            icon={<TagIcon className="w-3.5 h-3.5" />}
            tone="text-slate-300"
            panelWidth={200}
          >
            {(close) => (
              <>
                {tags.length === 0 && (
                  <div className="px-3 py-1.5 text-[10.5px] text-slate-600 italic">No tags yet</div>
                )}
                {tags.map((tag) => {
                  const active = storageContextMenu.conn.tagId === tag.id;
                  return (
                    <button
                      key={tag.id}
                      onClick={() => {
                        setStorageConnectionTag(storageContextMenu.conn.id, active ? null : tag.id);
                        close();
                        setStorageContextMenu(null);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-200"
                    >
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: tag.color }} />
                      <span className="flex-1 truncate">{tag.label}</span>
                      {active && <Check className="w-3 h-3 text-emerald-400 shrink-0" />}
                    </button>
                  );
                })}
                {storageContextMenu.conn.tagId && (
                  <button
                    onClick={() => {
                      setStorageConnectionTag(storageContextMenu.conn.id, null);
                      close();
                      setStorageContextMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-500"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                    <span>Clear tag</span>
                  </button>
                )}
                <div className="h-px bg-[#1e293b] my-1" />
                <button
                  onClick={() => {
                    setCreateTagForConn(storageContextMenu.conn.id);
                    setCreateTagOpen(true);
                    close();
                    setStorageContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Tag…</span>
                </button>
                <button
                  onClick={() => {
                    setManageTagsOpen(true);
                    close();
                    setStorageContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span>Manage Tags…</span>
                </button>
              </>
            )}
          </ContextSubMenu>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => {
              openEncryptedConnectionsModal('export');
              setStorageContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Connections</span>
          </button>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => {
              if (confirm(`Delete storage connection "${storageContextMenu.conn.name}"? This does not delete any stored objects.`)) {
                deleteStorageConnection(storageContextMenu.conn.id);
              }
              setStorageContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete Connection</span>
          </button>
        </ClampedContextMenu>
      )}

      {/* Table Field Info & Structure Modal */}
      {structureCtx && (
        <TableStructureModal
          isOpen={!!structureCtx}
          tableName={structureCtx.table.name}
          columns={structureCtx.table.children}
          conn={structureCtx.conn}
          schemaName={structureCtx.group.name}
          onSchemaChanged={() => loadSchemaForConnection(structureCtx.conn)}
          onClose={() => setStructureCtx(null)}
        />
      )}

      {/* Table action confirmation dialogs (triggered directly from the context menu) */}
      {tableActionCtx && pendingAction === 'drop' && (
        <ConfirmDialog
          title="Drop Table"
          tone="danger"
          confirmLabel="Drop Table"
          requireText={tableActionCtx.table.name}
          requireTextLabel="Type the table name to confirm:"
          loading={actionRunning}
          message={
            <div className="space-y-2">
              <p>
                Permanently delete <span className="font-mono text-rose-300">{tableActionCtx.table.name}</span>, including:
              </p>
              <ul className="list-disc list-inside text-slate-500 space-y-0.5 ml-2 text-[11px]">
                <li>all rows</li>
                <li>columns, data types, indexes, constraints</li>
                <li>the table definition itself</li>
              </ul>
              <p className="text-rose-300 font-semibold text-[11px]">This cannot be undone.</p>
              <pre className="bg-[#06090e] border border-[#1e293b] rounded-lg p-2 text-[10px] font-mono text-slate-500 overflow-x-auto whitespace-pre-wrap break-all">
                {dropTableSql(tableActionCtx.conn.engine, tableActionCtx.table.name, tableActionCtx.group.name)}
              </pre>
            </div>
          }
          onConfirm={confirmTableAction}
          onClose={closeTableAction}
        />
      )}

      {tableActionCtx && pendingAction === 'truncate' && (
        <ConfirmDialog
          title="Truncate Table"
          tone="warning"
          confirmLabel="Truncate Table"
          requireText={tableActionCtx.table.name}
          requireTextLabel="Type the table name to confirm:"
          loading={actionRunning}
          message={
            <div className="space-y-2">
              <p>
                Remove <span className="font-semibold text-amber-300">all rows</span> from{' '}
                <span className="font-mono text-amber-300">{tableActionCtx.table.name}</span> using the database's native TRUNCATE.
              </p>
              <p className="text-slate-500 text-[11px]">Structure, columns, and indexes are preserved. The identity/sequence is reset. This cannot be undone.</p>
              <pre className="bg-[#06090e] border border-[#1e293b] rounded-lg p-2 text-[10px] font-mono text-slate-500 overflow-x-auto whitespace-pre-wrap break-all">
                {truncateTableSql(tableActionCtx.conn.engine, tableActionCtx.table.name, tableActionCtx.group.name)}
              </pre>
            </div>
          }
          onConfirm={confirmTableAction}
          onClose={closeTableAction}
        />
      )}

      {tableActionCtx && pendingAction === 'deleteAll' && (
        <ConfirmDialog
          title="Delete All Rows"
          tone="warning"
          confirmLabel="Delete All Rows"
          requireText={tableActionCtx.table.name}
          requireTextLabel="Type the table name to confirm:"
          loading={actionRunning}
          message={
            <div className="space-y-2">
              <p>
                Remove <span className="font-semibold text-orange-300">all rows</span> from{' '}
                <span className="font-mono text-orange-300">{tableActionCtx.table.name}</span> via <code className="text-slate-400">DELETE FROM</code>.
              </p>
              <p className="text-slate-500 text-[11px]">
                Works on every engine. Structure is preserved. The auto-increment/sequence value is <span className="font-semibold">not</span> reset (use Reset Auto Increment for that). This cannot be undone.
              </p>
              <pre className="bg-[#06090e] border border-[#1e293b] rounded-lg p-2 text-[10px] font-mono text-slate-500 overflow-x-auto whitespace-pre-wrap break-all">
                {`DELETE FROM ${qualifiedTable(tableActionCtx.conn.engine, tableActionCtx.table.name, tableActionCtx.group.name)};`}
              </pre>
            </div>
          }
          onConfirm={confirmTableAction}
          onClose={closeTableAction}
        />
      )}

      {tableActionCtx && pendingAction === 'reset' && (
        <ConfirmDialog
          title="Reset Auto Increment / Sequence"
          tone="default"
          confirmLabel="Reset"
          loading={actionRunning}
          message={
            <div className="space-y-3">
              {autoIncError ? (
                <CopyableErrorBanner message={autoIncError} tone="rose" compact parseAsDbError />
              ) : autoIncMeta === undefined ? (
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading auto-increment metadata…
                </div>
              ) : autoIncMeta === null ? (
                <p className="text-[11px] text-slate-500">No auto-increment / identity / sequence column detected on this table.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 text-[11px]">
                    <div>
                      <div className="text-slate-600 uppercase text-[9px] font-semibold">Column</div>
                      <div className="text-slate-300 font-mono">{autoIncMeta.columnName}</div>
                    </div>
                    <div>
                      <div className="text-slate-600 uppercase text-[9px] font-semibold">Current max ID</div>
                      <div className="text-slate-300 font-mono">{autoIncMeta.currentMax != null ? autoIncMeta.currentMax : '— (empty)'}</div>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] text-slate-500 font-semibold">Next ID</label>
                    <input
                      type="number"
                      min={1}
                      value={resetNextValue}
                      onChange={(e) => setResetNextValue(e.target.value)}
                      autoFocus
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-32 bg-[#06090e] border border-[#1e293b] rounded-lg text-sm text-slate-200 px-3 py-1.5 font-mono focus:outline-none focus:border-cyan-500/50"
                    />
                    <p className="text-[10px] text-slate-600">The next INSERT will receive this value. Existing rows are not modified.</p>
                  </div>
                </>
              )}
            </div>
          }
          onConfirm={confirmTableAction}
          onClose={closeTableAction}
        />
      )}

      {tableActionCtx && pendingAction && !['drop', 'truncate', 'deleteAll', 'reset'].includes(pendingAction) && (
        <ConfirmDialog
          title={maintenanceOpLabel(pendingAction as MaintenanceOp)}
          tone="default"
          confirmLabel={maintenanceOpLabel(pendingAction as MaintenanceOp)}
          loading={actionRunning}
          message={
            <div className="space-y-2">
              <p className="text-[11px] text-slate-400">
                Run <span className="font-semibold text-slate-300">{maintenanceOpLabel(pendingAction as MaintenanceOp)}</span> on{' '}
                <span className="font-mono text-slate-300">{tableActionCtx.table.name}</span>?
              </p>
              <p className="text-[10px] text-slate-600">This is a safe, non-destructive maintenance operation.</p>
            </div>
          }
          onConfirm={confirmTableAction}
          onClose={closeTableAction}
        />
      )}

      {/* Database / schema group action confirmation dialogs */}
      {dbActionCtx && pendingDbAction === 'dropDb' && (() => {
        const caps = getDatabaseCapabilities(dbActionCtx.conn.engine);
        const sql = dropDatabaseSql(dbActionCtx.conn.engine, dbActionCtx.group.name);
        return (
          <ConfirmDialog
            title={`Drop ${caps.entityLabel}`}
            tone="danger"
            confirmLabel={`Drop ${caps.entityLabel}`}
            requireText={dbActionCtx.group.name}
            requireTextLabel={`Type the ${caps.entityLabel.toLowerCase()} name to confirm:`}
            loading={dbActionRunning}
            message={
              <div className="space-y-2">
                <p>
                  Permanently delete the {caps.entityLabel.toLowerCase()}{' '}
                  <span className="font-mono text-rose-300">{dbActionCtx.group.name}</span>
                  {caps.entityLabel === 'Database'
                    ? ', including every table, view, index, and all data it contains.'
                    : ', including every table, view, index, and all data it contains.'}
                </p>
                <p className="text-rose-300 font-semibold text-[11px]">This cannot be undone.</p>
                {sql && (
                  <pre className="bg-[#06090e] border border-[#1e293b] rounded-lg p-2 text-[10px] font-mono text-slate-500 overflow-x-auto whitespace-pre-wrap break-all">
                    {sql}
                  </pre>
                )}
              </div>
            }
            onConfirm={confirmDbAction}
            onClose={closeDbAction}
          />
        );
      })()}

      {dbActionCtx && pendingDbAction === 'emptyDb' && (() => {
        const caps = getDatabaseCapabilities(dbActionCtx.conn.engine);
        const childNames = dbActionCtx.group.children.map((t) => t.name);
        const stmts = emptyDatabaseSql(dbActionCtx.conn.engine, dbActionCtx.group.name, childNames);
        return (
          <ConfirmDialog
            title={`Empty ${caps.entityLabel}`}
            tone="warning"
            confirmLabel={`Empty ${caps.entityLabel}`}
            requireText={dbActionCtx.group.name}
            requireTextLabel={`Type the ${caps.entityLabel.toLowerCase()} name to confirm:`}
            loading={dbActionRunning}
            message={
              <div className="space-y-2">
                <p>
                  Remove <span className="font-semibold text-amber-300">all tables and data</span> from{' '}
                  <span className="font-mono text-amber-300">{dbActionCtx.group.name}</span>.
                </p>
                <p className="text-slate-500 text-[11px]">
                  The {caps.entityLabel.toLowerCase()} itself is kept (recreated empty), but every table, row, index, and constraint inside it is permanently destroyed.
                </p>
                <p className="text-amber-300 font-semibold text-[11px]">This cannot be undone.</p>
                {stmts.length > 0 && (
                  <pre className="bg-[#06090e] border border-[#1e293b] rounded-lg p-2 text-[10px] font-mono text-slate-500 overflow-x-auto whitespace-pre-wrap break-all max-h-32">
                    {stmts.join('\n')}
                  </pre>
                )}
              </div>
            }
            onConfirm={confirmDbAction}
            onClose={closeDbAction}
          />
        );
      })()}

      {/* Create Database Modal */}
      {createDbConn && (
        <CreateDatabaseModal
          connection={createDbConn}
          onClose={() => setCreateDbConn(null)}
          onCreated={() => loadSchemaForConnection(createDbConn)}
          onOpenConnectionFor={(dbName) => {
            const draft: DatabaseConnection = {
              id: `conn_${Date.now()}`,
              name: `${createDbConn.name} — ${dbName}`,
              engine: createDbConn.engine,
              host: createDbConn.host,
              port: createDbConn.port,
              database: dbName,
              username: createDbConn.username,
              password: createDbConn.password,
              sslMode: createDbConn.sslMode,
              colorTag: createDbConn.colorTag,
              isFavorite: true,
            };
            setCreateDbConn(null);
            openEditConnection(draft);
          }}
        />
      )}

      {/* Create Table Modal */}
      {createTableCtx && (
        <CreateTableModal
          connection={createTableCtx.conn}
          schemaName={createTableCtx.schemaName}
          onClose={() => setCreateTableCtx(null)}
          onCreated={(tableName) => {
            const ctx = createTableCtx;
            setCreateTableCtx(null);
            loadSchemaForConnection(ctx.conn);
            if (ctx.schemaName) {
              setActiveDatabase(ctx.conn.id, ctx.schemaName);
            }
            openTableDataTab(tableName, ctx.schemaName, ctx.conn.id);
          }}
        />
      )}

      {/* Trigger row context menu (Edit / Drop) */}
      {triggerItemMenu && (
        <ClampedContextMenu
          clickX={triggerItemMenu.mouseX}
          clickY={triggerItemMenu.mouseY}
          menuWidth={224}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-56 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate">
            trigger: {triggerItemMenu.trigger.name}
          </div>
          <button
            onClick={() => {
              void openEditObjectTab(
                triggerItemMenu.conn,
                triggerItemMenu.group.name,
                'trigger',
                triggerItemMenu.trigger.name,
                triggerItemMenu.trigger.table
              );
              setTriggerItemMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>Edit Definition...</span>
          </button>
          <button
            onClick={() => {
              setDropTriggerCtx({
                conn: triggerItemMenu.conn,
                group: triggerItemMenu.group,
                trigger: triggerItemMenu.trigger,
                groupKey: triggerItemMenu.groupKey,
              });
              setDropTriggerAlsoFunction(true);
              setTriggerItemMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Drop Trigger</span>
          </button>
        </ClampedContextMenu>
      )}

      {/* Drop Trigger confirmation */}
      {dropTriggerCtx && (
        <ConfirmDialog
          title="Drop Trigger"
          tone="danger"
          confirmLabel="Drop Trigger"
          loading={dropTriggerRunning}
          onClose={() => setDropTriggerCtx(null)}
          onConfirm={async () => {
            const { conn, group, trigger, groupKey } = dropTriggerCtx;
            setDropTriggerRunning(true);
            const statements = dropTriggerSql(
              conn.engine,
              trigger.name,
              trigger.table,
              group.name,
              isPostgresFamily(conn.engine) && dropTriggerAlsoFunction
                ? { functionName: defaultTriggerFunctionName({ table: trigger.table, name: trigger.name }) }
                : undefined
            );
            const config = resolveConnConfig(conn, group.name);
            try {
              for (const sql of statements) {
                await safeInvoke('execute_query', {
                  request: { config, sql },
                  queryId: `drop_trigger_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                  __meta: { source: 'ddl' },
                });
              }
              loadTriggersForGroup(conn, group, groupKey, true);
              setDropTriggerCtx(null);
            } catch (err: any) {
              const parsed = parseDbError(err?.message ?? String(err));
              pushToast({ severity: 'error', title: 'Drop Trigger failed', message: parsed.detail ? `${parsed.message} — ${parsed.detail}` : parsed.message });
            } finally {
              setDropTriggerRunning(false);
            }
          }}
        >
          <p className="text-slate-400 text-[11px]">
            Drop trigger <span className="font-mono text-slate-200">{dropTriggerCtx.trigger.name}</span> on{' '}
            <span className="font-mono text-slate-200">{dropTriggerCtx.trigger.table}</span>? This cannot be undone.
          </p>
          {isPostgresFamily(dropTriggerCtx.conn.engine) && (
            <label className="flex items-center gap-1.5 mt-2 text-[11px] text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={dropTriggerAlsoFunction}
                onChange={(e) => setDropTriggerAlsoFunction(e.target.checked)}
              />
              Also drop function{' '}
              <span className="font-mono text-slate-400">
                {defaultTriggerFunctionName({ table: dropTriggerCtx.trigger.table, name: dropTriggerCtx.trigger.name })}
              </span>
            </label>
          )}
        </ConfirmDialog>
      )}

      {/* Procedure row context menu (Edit / Drop) */}
      {procedureItemMenu && (
        <ClampedContextMenu
          clickX={procedureItemMenu.mouseX}
          clickY={procedureItemMenu.mouseY}
          menuWidth={224}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-56 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate">
            procedure: {procedureItemMenu.procedure.name}
          </div>
          <button
            onClick={() => {
              void openEditObjectTab(
                procedureItemMenu.conn,
                procedureItemMenu.group.name,
                'procedure',
                procedureItemMenu.procedure.name
              );
              setProcedureItemMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>Edit Definition...</span>
          </button>
          <button
            onClick={() => {
              setDropProcedureCtx({
                conn: procedureItemMenu.conn,
                group: procedureItemMenu.group,
                procedure: procedureItemMenu.procedure,
                groupKey: procedureItemMenu.groupKey,
              });
              setProcedureItemMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Drop Procedure</span>
          </button>
        </ClampedContextMenu>
      )}

      {/* Drop Procedure confirmation */}
      {dropProcedureCtx && (() => {
        const routineLabel = dropProcedureCtx.procedure.type === 'FUNCTION' ? 'Function' : 'Procedure';
        return (
          <ConfirmDialog
            title={`Drop ${routineLabel}`}
            tone="danger"
            confirmLabel={`Drop ${routineLabel}`}
            loading={dropProcedureRunning}
            onClose={() => setDropProcedureCtx(null)}
            onConfirm={async () => {
              const { conn, group, procedure, groupKey } = dropProcedureCtx;
              setDropProcedureRunning(true);
              const sql = dropProcedureSql(conn.engine, procedure.name, group.name, undefined, procedure.type);
              const config = resolveConnConfig(conn, group.name);
              try {
                await safeInvoke('execute_query', {
                  request: { config, sql },
                  queryId: `drop_procedure_${Date.now()}`,
                  __meta: { source: 'ddl' },
                });
                loadProceduresForGroup(conn, group, groupKey, true);
                setDropProcedureCtx(null);
              } catch (err: any) {
                const parsed = parseDbError(err?.message ?? String(err));
                pushToast({ severity: 'error', title: `Drop ${routineLabel} failed`, message: parsed.detail ? `${parsed.message} — ${parsed.detail}` : parsed.message });
              } finally {
                setDropProcedureRunning(false);
              }
            }}
          >
            <p className="text-slate-400 text-[11px]">
              Drop {routineLabel.toLowerCase()} <span className="font-mono text-slate-200">{dropProcedureCtx.procedure.name}</span>? This
              cannot be undone.
            </p>
          </ConfirmDialog>
        );
      })()}

      {/* Event row context menu (Edit / Drop) */}
      {eventItemMenu && (
        <ClampedContextMenu
          clickX={eventItemMenu.mouseX}
          clickY={eventItemMenu.mouseY}
          menuWidth={224}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-56 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate">
            event: {eventItemMenu.event.name}
          </div>
          <button
            onClick={() => {
              void openEditObjectTab(
                eventItemMenu.conn,
                eventItemMenu.group.name,
                'event',
                eventItemMenu.event.name
              );
              setEventItemMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-cyan-400"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>Edit Definition...</span>
          </button>
          <button
            onClick={() => {
              setDropEventCtx({
                conn: eventItemMenu.conn,
                group: eventItemMenu.group,
                event: eventItemMenu.event,
                groupKey: eventItemMenu.groupKey,
              });
              setEventItemMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Drop Event</span>
          </button>
        </ClampedContextMenu>
      )}

      {/* Drop Event confirmation */}
      {dropEventCtx && (
        <ConfirmDialog
          title="Drop Event"
          tone="danger"
          confirmLabel="Drop Event"
          loading={dropEventRunning}
          onClose={() => setDropEventCtx(null)}
          onConfirm={async () => {
            const { conn, group, event, groupKey } = dropEventCtx;
            setDropEventRunning(true);
            const sql = isPostgresFamily(conn.engine) ? pgCronUnscheduleSql(event.name) : dropEventSql(conn.engine, event.name, group.name);
            const config = resolveConnConfig(conn, group.name);
            try {
              await safeInvoke('execute_query', {
                request: { config, sql },
                queryId: `drop_event_${Date.now()}`,
                __meta: { source: 'ddl' },
              });
              loadEventsForGroup(conn, group, groupKey, true);
              setDropEventCtx(null);
            } catch (err: any) {
              const parsed = parseDbError(err?.message ?? String(err));
              pushToast({ severity: 'error', title: 'Drop Event failed', message: parsed.detail ? `${parsed.message} — ${parsed.detail}` : parsed.message });
            } finally {
              setDropEventRunning(false);
            }
          }}
        >
          <p className="text-slate-400 text-[11px]">
            Drop event <span className="font-mono text-slate-200">{dropEventCtx.event.name}</span>? This cannot be
            undone.
          </p>
        </ConfirmDialog>
      )}

      {/* Category folder context menu (Tables / Views / Triggers / Functions·
          Procedures / Events headers) — Create <type>… + Refresh. Mirrors the
          Extensions folder menu below but is generic across the five kinds. */}
      {categoryFolderMenu && (() => {
        const { conn, group, groupKey, kind } = categoryFolderMenu;
        const isPg = isPostgresFamily(conn.engine);
        const isMongo = isMongoEngine(conn.engine);
        const config: Record<typeof kind, { label: string; icon: React.ReactNode; onCreate: (() => void) | null; onRefresh: () => void }> = {
          table: {
            label: isMongo ? 'Collection' : 'Table',
            icon: <TableIcon className="w-3.5 h-3.5" />,
            onCreate: isMongo
              ? () => setMongoCreateCollectionCtx({ conn, database: group.name })
              : () => setCreateTableCtx({ conn, schemaName: group.name }),
            onRefresh: () => loadSchemaForConnection(conn),
          },
          view: {
            label: 'View',
            icon: <Eye className="w-3.5 h-3.5" />,
            // Mongo views (a saved aggregation pipeline over another
            // collection) aren't creatable here yet — no backend command for
            // it — so only "Refresh" is offered for this folder on Mongo.
            onCreate: isMongo ? null : () => openCreateObjectTab(conn, group.name, 'view'),
            onRefresh: () => loadSchemaForConnection(conn),
          },
          trigger: {
            label: 'Trigger',
            icon: <Zap className="w-3.5 h-3.5" />,
            onCreate: () => openCreateObjectTab(conn, group.name, 'trigger'),
            onRefresh: () => loadTriggersForGroup(conn, group, groupKey, true),
          },
          procedure: {
            label: isPg ? 'Function' : 'Stored Procedure',
            icon: <Braces className="w-3.5 h-3.5" />,
            onCreate: () => openCreateObjectTab(conn, group.name, 'procedure'),
            onRefresh: () => loadProceduresForGroup(conn, group, groupKey, true),
          },
          event: {
            label: 'Event',
            icon: <Clock className="w-3.5 h-3.5" />,
            onCreate: () => openCreateObjectTab(conn, group.name, 'event'),
            onRefresh: () => loadEventsForGroup(conn, group, groupKey, true),
          },
        };
        const { label, icon, onCreate, onRefresh } = config[kind];
        return (
          <ClampedContextMenu
            clickX={categoryFolderMenu.mouseX}
            clickY={categoryFolderMenu.mouseY}
            menuWidth={224}
            className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-56 py-1.5 text-xs text-slate-200 select-none font-sans"
          >
            {onCreate && (
              <button
                onClick={() => {
                  onCreate();
                  setCategoryFolderMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-emerald-400"
              >
                {icon}
                <span>Create {label}…</span>
              </button>
            )}
            <button
              onClick={() => {
                onRefresh();
                setCategoryFolderMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </ClampedContextMenu>
        );
      })()}

      {/* Extensions folder context menu (Manage / Refresh). */}
      {extFolderMenu && (
        <ClampedContextMenu
          clickX={extFolderMenu.mouseX}
          clickY={extFolderMenu.mouseY}
          menuWidth={224}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-56 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <button
            onClick={() => {
              setManageExtConn(extFolderMenu.conn);
              setExtFolderMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-fuchsia-400"
          >
            <Puzzle className="w-3.5 h-3.5" />
            <span>Manage Extensions…</span>
          </button>
          <button
            onClick={() => {
              loadExtensionsForConn(extFolderMenu.conn, extFolderMenu.key, true);
              setExtFolderMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </ClampedContextMenu>
      )}

      {/* Manage Extensions modal (install/uninstall pg extensions). */}
      {manageExtConn && (
        <ManageExtensionsModal
          connection={manageExtConn}
          onClose={() => setManageExtConn(null)}
          onChanged={() => loadExtensionsForConn(manageExtConn, `${manageExtConn.id}-__extensions`, true)}
        />
      )}

      {/* Backup Modal */}
      {backupConn && (
        <BackupModal
          connection={backupConn}
          initialGroupName={backupGroupName}
          onClose={() => {
            setBackupConn(null);
            setBackupGroupName(undefined);
          }}
        />
      )}

      {/* Restore Modal */}
      {restoreConn && <RestoreModal connection={restoreConn} onClose={() => setRestoreConn(null)} />}

      {/* MongoDB: Collection/Database Stats Modal */}
      {mongoStatsCtx && (
        <MongoStatsModal
          connection={mongoStatsCtx.conn}
          database={mongoStatsCtx.database}
          collectionName={mongoStatsCtx.collectionName}
          onClose={() => setMongoStatsCtx(null)}
        />
      )}

      {/* MongoDB: New Collection Modal */}
      {mongoCreateCollectionCtx && (
        <MongoCreateCollectionModal
          connection={mongoCreateCollectionCtx.conn}
          database={mongoCreateCollectionCtx.database}
          onClose={() => setMongoCreateCollectionCtx(null)}
          onCreated={() => loadSchemaForConnection(mongoCreateCollectionCtx.conn)}
        />
      )}

      {/* MongoDB: Drop Collection confirmation */}
      {mongoDropCollectionCtx && (
        <ConfirmDialog
          title={`Drop ${mongoDropCollectionCtx.collectionName}`}
          message="This permanently deletes the collection and all its documents and indexes. This cannot be undone."
          confirmLabel="Drop Collection"
          tone="danger"
          requireText={mongoDropCollectionCtx.collectionName}
          requireTextLabel="Type the collection name to confirm:"
          loading={mongoActionBusy}
          onConfirm={dropMongoCollection}
          onClose={() => {
            setMongoDropCollectionCtx(null);
            setMongoActionError(null);
          }}
        >
          {mongoActionError && <CopyableErrorBanner message={mongoActionError} parseAsDbError compact />}
        </ConfirmDialog>
      )}

      {/* MongoDB: Drop Database confirmation */}
      {mongoDropDatabaseCtx && (
        <ConfirmDialog
          title={`Drop ${mongoDropDatabaseCtx.database}`}
          message="This permanently deletes the database and every collection, view, and index in it. This cannot be undone."
          confirmLabel="Drop Database"
          tone="danger"
          requireText={mongoDropDatabaseCtx.database}
          requireTextLabel="Type the database name to confirm:"
          loading={mongoActionBusy}
          onConfirm={dropMongoDatabase}
          onClose={() => {
            setMongoDropDatabaseCtx(null);
            setMongoActionError(null);
          }}
        >
          {mongoActionError && <CopyableErrorBanner message={mongoActionError} parseAsDbError compact />}
        </ConfirmDialog>
      )}

      {/* Folder (tag) Context Menu */}
      {folderContextMenu && (
        <ClampedContextMenu
          clickX={folderContextMenu.mouseX}
          clickY={folderContextMenu.mouseY}
          menuWidth={200}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-52 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <div className="px-3 py-1 font-mono text-[10px] text-slate-400 border-b border-[#1e293b] uppercase truncate flex items-center gap-1.5">
            <TagIcon className="w-2.5 h-2.5" />
            {folderContextMenu.tag ? folderContextMenu.tag.label : 'Other'}
          </div>

          <button
            onClick={() => {
              useConnectionStore.getState().openNewConnectionForTag(folderContextMenu.tag?.id ?? null);
              setFolderContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <Database className="w-3.5 h-3.5" />
            <span>New Connection…</span>
          </button>

          {/* Show ▸ — same tree display toggles as the global Explorer
              context menu, surfaced here too so they're reachable without
              right-clicking empty tree space. */}
          <ContextSubMenu label="Show" icon={<Eye className="w-3.5 h-3.5" />} tone="text-slate-300" panelWidth={200}>
            {(close) => (
              <>
                <button
                  onClick={() => {
                    setShowSystemSchemas(!showSystemSchemas);
                    setTimeout(() => {
                      expandedConnIds.forEach((id) => {
                        const c = connections.find((cc) => cc.id === id);
                        if (c) loadSchemaForConnection(c);
                      });
                    }, 0);
                    close();
                    setFolderContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  {showSystemSchemas ? (
                    <Check className="w-3.5 h-3.5 text-cyan-400" />
                  ) : (
                    <Database className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span>System Schemas</span>
                </button>

                <button
                  onClick={() => {
                    setShowRowCounts(!showRowCounts);
                    close();
                    setFolderContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  {showRowCounts ? (
                    <Check className="w-3.5 h-3.5 text-cyan-400" />
                  ) : (
                    <Hash className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span>Row Counts</span>
                </button>

                <button
                  onClick={() => {
                    setShowTableSizes(!showTableSizes);
                    close();
                    setFolderContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
                >
                  {showTableSizes ? (
                    <Check className="w-3.5 h-3.5 text-cyan-400" />
                  ) : (
                    <HardDrive className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span>Table Sizes</span>
                </button>
              </>
            )}
          </ContextSubMenu>

          <div className="h-px bg-[#1e293b] my-1" />

          {folderContextMenu.tag && (
            <>
              <button
                onClick={() => {
                  setEditingTag(folderContextMenu.tag);
                  setFolderContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>{folderContextMenu.tag.builtin ? 'Recolor Tag…' : 'Edit Tag…'}</span>
              </button>
              {!folderContextMenu.tag.builtin && (
                <button
                  onClick={() => {
                    if (folderContextMenu.tag) {
                      useConnectionStore.getState().clearTagFromAll(folderContextMenu.tag.id);
                      useStorageStore.getState().clearTagFromAll(folderContextMenu.tag.id);
                      deleteTag(folderContextMenu.tag.id);
                    }
                    setFolderContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Tag</span>
                </button>
              )}
              <div className="h-px bg-[#1e293b] my-1" />
            </>
          )}
          <button
            onClick={() => {
              if (folderContextMenu.tag) toggleFolder(folderContextMenu.tag.id);
              else setCollapsedUntagged(!collapsedUntagged);
              setFolderContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            {folderContextMenu.tag && expandedFolders.has(folderContextMenu.tag.id) ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            <span>{folderContextMenu.tag && expandedFolders.has(folderContextMenu.tag.id) ? 'Collapse' : 'Expand'}</span>
          </button>
          <button
            onClick={() => {
              setCreateTagForConn(null);
              setCreateTagOpen(true);
              setFolderContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-blue-400"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Tag…</span>
          </button>
        </ClampedContextMenu>
      )}

      {/* Inline Edit-Tag modal (rename/recolor) */}
      {editingTag && (
        <EditTagInlineModal
          tag={editingTag}
          onClose={() => setEditingTag(null)}
          onSave={(label, color) => {
            updateTag(editingTag.id, { label, color });
            setEditingTag(null);
          }}
        />
      )}

      {/* Create Tag Modal */}
      <CreateTagModal
        isOpen={createTagOpen}
        onClose={() => {
          setCreateTagOpen(false);
          setCreateTagForConn(null);
        }}
        assignToConnectionId={createTagForConn}
      />

      {/* Manage Tags Modal — rename / recolor / delete all tags in one place */}
      <ManageTagsModal isOpen={manageTagsOpen} onClose={() => setManageTagsOpen(false)} />
    </div>
  );
};

/**
 * Compact inline modal to rename + recolor an existing tag. Builtins keep their
 * label locked (only the color changes).
 */
const EditTagInlineModal: React.FC<{
  tag: ConnectionTag;
  onClose: () => void;
  onSave: (label: string, color: string) => void;
}> = ({ tag, onClose, onSave }) => {
  const [label, setLabel] = useState(tag.label);
  const [color, setColor] = useState(tag.color);
  useEscapeToClose(onClose);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <TagIcon className="w-4 h-4 text-blue-400" />
            {tag.builtin ? 'Recolor Tag' : 'Edit Tag'}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <label className="block text-[11px] text-slate-500 font-semibold">Name</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={tag.builtin}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-[#06090e] border border-[#1e293b] rounded-lg text-sm text-slate-200 px-3 py-2 focus:outline-none focus:border-blue-500/50 disabled:opacity-60"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11px] text-slate-500 font-semibold">Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer bg-transparent border border-[#1e293b]"
              />
              <span className="text-[11px] text-slate-500 font-mono">{color}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] text-slate-600">Preview:</span>
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{ backgroundColor: hexToRgba(color, 0.15), color }}
            >
              {(label.trim() || tag.label).toUpperCase()}
            </span>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200">
              Cancel
            </button>
            <button
              onClick={() => onSave(label.trim() || tag.label, color)}
              className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Full tag manager — lists every tag (builtins + custom), shows how many
 * connections use each, and lets the user rename / recolor / delete (custom
 * only) or create new tags. Opened from the connection context menu
 * ("Manage Tags…").
 */
const ManageTagsModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { tags, addTag, updateTag, deleteTag } = useTagStore();
  const { connections, clearTagFromAll } = useConnectionStore();
  const storageConnections = useStorageStore((s) => s.connections);
  const clearStorageTagFromAll = useStorageStore((s) => s.clearTagFromAll);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editColor, setEditColor] = useState('#3b82f6');
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('#8b5cf6');
  useEscapeToClose(isOpen ? onClose : null);
  if (!isOpen) return null;

  const countFor = (tagId: string) =>
    connections.filter((c) => c.tagId === tagId).length +
    storageConnections.filter((c) => c.tagId === tagId).length;

  const startEdit = (tag: ConnectionTag) => {
    setEditingId(tag.id);
    setEditLabel(tag.label);
    setEditColor(tag.color);
  };

  const saveEdit = (tag: ConnectionTag) => {
    updateTag(tag.id, { label: editLabel.trim() || tag.label, color: editColor });
    setEditingId(null);
  };

  const handleDelete = (tag: ConnectionTag) => {
    clearTagFromAll(tag.id);
    clearStorageTagFromAll(tag.id);
    deleteTag(tag.id);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e293b] shrink-0">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <TagIcon className="w-4 h-4 text-blue-400" />
            Manage Tags
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2 macos-scroll">
          {tags.length === 0 && (
            <div className="text-center text-[11px] text-slate-500 py-8">No tags yet. Create one below.</div>
          )}
          {tags.map((tag) => {
            const count = countFor(tag.id);
            const isEditing = editingId === tag.id;
            return (
              <div key={tag.id} className="rounded-xl border border-[#1e293b] bg-[#06090e] p-2.5">
                {isEditing ? (
                  /* Inline edit row */
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={editColor}
                        onChange={(e) => setEditColor(e.target.value)}
                        disabled={tag.builtin && false}
                        className="w-7 h-7 rounded cursor-pointer bg-transparent border border-[#1e293b] shrink-0"
                      />
                      <input
                        type="text"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        disabled={tag.builtin}
                        autoFocus
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="off"
                        spellCheck={false}
                        className="flex-1 bg-[#0a0f18] border border-[#1e293b] rounded-lg text-xs text-slate-200 px-2 py-1.5 focus:outline-none focus:border-blue-500/50 disabled:opacity-60"
                      />
                    </div>
                    <div className="flex justify-end gap-1.5">
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-slate-400 hover:text-slate-200"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => saveEdit(tag)}
                        className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Display row */
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: tag.color }} />
                    <span className="text-xs font-semibold text-slate-200 flex-1 truncate">{tag.label}</span>
                    {tag.builtin && (
                      <span className="text-[8px] uppercase tracking-wider text-slate-600 font-bold">built-in</span>
                    )}
                    <span className="text-[10px] text-slate-500 font-mono">{count} {count === 1 ? 'conn' : 'conns'}</span>
                    <button
                      onClick={() => startEdit(tag)}
                      title={tag.builtin ? 'Recolor' : 'Edit'}
                      className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-slate-200"
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                    {!tag.builtin && (
                      <button
                        onClick={() => handleDelete(tag)}
                        title="Delete tag"
                        className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Create new tag */}
        <div className="border-t border-[#1e293b] p-3 space-y-2 shrink-0">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              className="w-7 h-7 rounded cursor-pointer bg-transparent border border-[#1e293b] shrink-0"
            />
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newLabel.trim()) {
                  addTag(newLabel, newColor);
                  setNewLabel('');
                }
              }}
              placeholder="New tag name…"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 bg-[#06090e] border border-[#1e293b] rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-blue-500/50"
            />
            <button
              onClick={() => {
                if (newLabel.trim()) {
                  addTag(newLabel, newColor);
                  setNewLabel('');
                }
              }}
              disabled={!newLabel.trim()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-3 h-3" />
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
