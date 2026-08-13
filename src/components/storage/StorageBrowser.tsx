import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Folder,
  Download,
  Upload,
  Trash2,
  RefreshCw,
  Search,
  Loader2,
  Home,
  ArrowUp,
  ArrowUpDown,
  FilePlus2,
  Eye,
  Link2,
  Shield,
  BarChart3,
  LayoutGrid,
  List,
  Filter,
} from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { useStorageStore } from '../../store/useStorageStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

import { useSettingsStore } from '../../store/useSettingsStore';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { normalizePrefix, isWithinPrefix } from '../../core/storage/domain/paths';
import { toStorageError } from '../../core/storage/domain/errors';
import { providerSupportsAcl } from '../../core/storage/domain/acl';
import { getPreset } from '../../core/storage/domain/presets';
import { PRESIGN_DEFAULT_SECS, formatExpiry } from '../../core/storage/domain/presign';
import { getTransferManager } from '../../core/storage/react';
import { copyToClipboard } from '../../core/utils/clipboard';
import { formatBytes, formatDateTime, guessContentType } from './format';
import { StorageFileViewer } from './StorageFileViewer';
import { StorageAclDialog } from './StorageAclDialog';
import { StorageAnalytics } from './StorageAnalytics';
import { StorageObjectDetailPanel } from './StorageObjectDetailPanel';
import { FileTypeIcon } from './FileTypeIcon';
import type {
  ListObjectsResult,
  StorageObject,
  StoragePrefix,
} from '../../core/storage/domain/types';

interface Props {
  /** Override the active connection (used when embedded by backup/restore pickers). */
  connectionId?: string;
  /** Called when a user selects an object (embedded picker mode). */
  onSelectObject?: (obj: StorageObject) => void;
  /** Filter: when set, only show objects whose key ends with one of these suffixes. */
  filterSuffixes?: string[];
  /** Embed mode hides upload/delete actions (read-only picker). */
  embedded?: boolean;
}

type ViewMode = 'list' | 'grid';

export const StorageBrowser: React.FC<Props> = ({
  connectionId,
  onSelectObject,
  filterSuffixes,
  embedded = false,
}) => {
  const storeConnId = useStorageStore((s) => s.activeConnectionId);
  const connections = useStorageStore((s) => s.connections);
  const previewMaxBytes = useSettingsStore((s) => s.s3PreviewMaxBytes);
  const connId = connectionId ?? storeConnId;
  const connection = useMemo(
    () => connections.find((c) => c.id === connId) ?? null,
    [connections, connId],
  );

  const navTarget = useStorageStore((s) => s.navTarget);
  const setNavTarget = useStorageStore((s) => s.setNavTarget);

  const [prefix, setPrefix] = useState<string>(connection?.pathPrefix ?? '');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [hideMeta, setHideMeta] = useState(false);
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    if (navTarget && navTarget.connectionId === connId) {
      setPrefix(navTarget.prefix);
      if (navTarget.selectedKey) {
        setSelectedKey(navTarget.selectedKey);
      }
      setShowAnalytics(false); // navigate back to file browser view
      setNavTarget(null);
    }
  }, [navTarget, connId, setNavTarget]);
  const [result, setResult] = useState<ListObjectsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Multi-select for bulk operations. Lives alongside single-select
  // (`selectedKey` drives the docked detail panel); the checkbox column
  // toggles membership here.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const lastCheckedIdx = useRef<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadTargets, setUploadTargets] = useState<FileList | null>(null);
  /** Toggle analytics panel inline within this tab. */
  const [showAnalytics, setShowAnalytics] = useState(false);

  /** State for the in-app delete confirmation dialog (replaces native confirm()). */
  const [deleteConfirm, setDeleteConfirm] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // Docked object-detail panel — sits beside the table (Explorer-sidebar
  // style), same resize pattern as the ERD tab's table-detail panel.
  const { storageDetailPanelWidth, setStorageDetailPanelWidth, zoomLevel } = useWorkspaceStore();
  const mainRowRef = useRef<HTMLDivElement>(null);
  const [isResizingDetail, setIsResizingDetail] = useState(false);

  useEffect(() => {
    if (!isResizingDetail) return;
    const handleMouseMove = (e: MouseEvent) => {
      const rowRight = mainRowRef.current?.getBoundingClientRect().right;
      if (rowRight === undefined) return;
      setStorageDetailPanelWidth((rowRight - e.clientX) / zoomLevel);
    };
    const handleMouseUp = () => setIsResizingDetail(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingDetail, setStorageDetailPanelWidth, zoomLevel]);

  // The currently-selected object (for the docked detail panel) — derived
  // from the content-pane result + selectedKey. Folder rows (prefixes) don't
  // have a detail panel, only files do.
  const selectedObject = useMemo(
    () => (result?.objects ?? []).find((o) => o.key === selectedKey) ?? null,
    [result, selectedKey],
  );

  // Preview/edit pane state. When `previewKey` is set, the content area shows
  // the StorageFileViewer instead of the object table. The preview is lazy —
  // it only fetches when the user opens it.
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const previewObject = useMemo(
    () => (result?.objects ?? []).find((o) => o.key === previewKey) ?? null,
    [result, previewKey],
  );
  // ACL dialog state.
  const [aclKey, setAclKey] = useState<string | null>(null);
  const aclObject = useMemo(
    () => (result?.objects ?? []).find((o) => o.key === aclKey) ?? null,
    [result, aclKey],
  );

  // Reset the browse prefix when the connection changes.
  useEffect(() => {
    setPrefix(connection?.pathPrefix ?? '');
    setResult(null);
    setError(null);
    setSelectedKey(null);
    setSelectedKeys(new Set());
    lastCheckedIdx.current = null;
    setPreviewKey(null);
  }, [connection?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [truncatedHint, setTruncatedHint] = useState<string | null>(null);

  const list = useCallback(async () => {
    if (!connection) return;
    setLoading(true);
    setError(null);
    setTruncatedHint(null);
    try {
      // Decrypt the secret in memory for this call — S3 ListObjects requires a
      // valid SigV4 signature, so the Rust client needs the plaintext key. The
      // stored connection carries the AES-GCM ciphertext; passing it raw would
      // sign with the ciphertext blob and fail with SignatureDoesNotMatch.
      const decrypted = await withDecryptedSecret(connection);
      const normPrefix = normalizePrefix(prefix);
      const hasSearch = !!search;
      // First page.
      let res = await safeInvoke<ListObjectsResult>('s3_list_objects', {
        config: decrypted,
        prefix: normPrefix,
        opts: { maxKeys: 1000, search: search || undefined },
      });
      // Auto-paginate (lazy load) when NOT searching — the search filter is
      // applied per-page server-side, so paginating a filtered set is
      // ambiguous. For plain folder browsing we exhaust the continuation token
      // so buckets with >1000 objects show everything. Cap at 10 pages (10k
      // objects) to avoid runaway loads on enormous buckets.
      const MAX_PAGES = 10;
      let pages = 1;
      const seenPrefixes = new Set(res.prefixes.map((p) => p.prefix));
      while (!hasSearch && res.isTruncated && res.continuationToken && pages < MAX_PAGES) {
        const next = await safeInvoke<ListObjectsResult>('s3_list_objects', {
          config: decrypted,
          prefix: normPrefix,
          opts: { maxKeys: 1000, continuationToken: res.continuationToken },
        });
        // Accumulate + dedupe (prefixes can repeat across pages in rare cases).
        res = {
          objects: [...res.objects, ...next.objects],
          prefixes: [
            ...res.prefixes,
            ...next.prefixes.filter((p) => !seenPrefixes.has(p.prefix) && seenPrefixes.add(p.prefix)),
          ],
          isTruncated: next.isTruncated,
          continuationToken: next.continuationToken,
        };
        pages++;
      }
      if (res.isTruncated) {
        setTruncatedHint(`Showing first ${(pages * 1000).toLocaleString()} objects — refine your folder or use search for more.`);
      }
      setResult(res);
    } catch (err: unknown) {
      setError(toStorageError(err).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [connection, prefix, search]);

  useEffect(() => {
    if (connection) list();
  }, [connection?.id, prefix, list]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close the context menu on any click elsewhere.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // Esc closes the preview pane (Finder-like: Esc dismisses the open file).
  useEffect(() => {
    if (!previewKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setPreviewKey(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [previewKey]);

  // ── Keyboard shortcuts for folder navigation (Finder-style). ────────────
  //    Cmd+Up / Cmd+Left  → go to parent folder
  //    Cmd+Right          → enter selected folder, or preview selected file
  //    Ignored in embedded/picker mode, while in analytics view, or when a
  //    text input / modal dialog is focused.
  useEffect(() => {
    if (embedded || showAnalytics) return; // not applicable in these modes
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // Don't intercept while typing in inputs, textareas, contenteditable.
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const isEditable = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable;
      if (isEditable) return;
      // Don't intercept while a modal dialog is visible.
      if (deleteConfirm || contextMenu) return;

      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        const root = normalizePrefix(connection?.pathPrefix ?? '');
        const current = normalizePrefix(prefix);
        if (current === root) return; // already at root, nowhere to go
        e.preventDefault();
        // Inline navigateTo to avoid referencing the const before declaration.
        setSelectedKey(null);
        setSelectedKeys(new Set());
        lastCheckedIdx.current = null;
        setPreviewKey(null);
        setPrefix(parentOf(prefix, connection?.pathPrefix ?? ''));
      } else if (e.key === 'ArrowRight') {
        if (!selectedKey) return;
        e.preventDefault();
        // Is it a folder prefix? (matches one of the result's prefix entries)
        const isFolder = result?.prefixes.some((p) => p.prefix === selectedKey);
        if (isFolder) {
          setSelectedKey(null);
          setSelectedKeys(new Set());
          lastCheckedIdx.current = null;
          setPreviewKey(null);
          setPrefix(selectedKey);
        } else {
          // It's a file — open the inline preview viewer
          setPreviewKey(selectedKey);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, showAnalytics, prefix, selectedKey, result, deleteConfirm, contextMenu, connection]);

  if (!connection) {
    return (
      <div className="border border-dashed border-[#1e293b] rounded-xl p-10 text-center text-slate-500 text-sm">
        Select a storage connection to browse.
      </div>
    );
  }

  const breadcrumbs = buildBreadcrumbs(prefix, connection.pathPrefix);
  // Whether we're below the connection's root prefix — drives both the
  // breadcrumb "Up" button and the ".." row/card at the top of the listing.
  const canGoUp = prefix !== (connection.pathPrefix ?? '');

  const navigateTo = (p: string) => {
    setSelectedKey(null);
    setSelectedKeys(new Set());
    lastCheckedIdx.current = null;
    setPreviewKey(null);
    setPresignOk(null);
    setPrefix(p);
  };

  let objects = (result?.objects ?? []).filter((o) => {
    if (filterSuffixes && filterSuffixes.length > 0 && !filterSuffixes.some((s) => o.key.endsWith(s))) return false;
    if (hideMeta && o.isMetadata) return false;
    return true;
  });
  objects = [...objects].sort((a, b) => (sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)));

  const totalSize = objects.reduce((sum, o) => sum + o.size, 0);
  const totalCount = (result?.prefixes.length ?? 0) + objects.length;

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !connection) return;
    const decrypted = await withDecryptedSecret(connection);
    const mgr = getTransferManager();
    // Upload each file to the current prefix. We need a local path for the
    // Rust uploader; in the browser we only have File objects, so this path
    // is only effective in the Tauri runtime (where the dialog plugin gives
    // us real paths). For drag-drop in Tauri we receive paths on the File.
    for (const file of Array.from(files)) {
      // @ts-expect-error - Tauri exposes a `path` property on dropped files.
      const localPath: string | undefined = file.path;
      if (!localPath) continue; // Browser preview: no real path available.
      const key = `${normalizePrefix(prefix)}${file.name}`;
      if (!isWithinPrefix(key, connection.pathPrefix)) {
        setError(`Refused: "${key}" is outside the configured prefix.`);
        continue;
      }
      mgr.start({
        direction: 'upload',
        connectionId: connection.id,
        config: decrypted,
        key,
        localPath,
      });
    }
    setUploadTargets(null);
  };

  const handleDownload = async (obj: StorageObject) => {
    if (!connection) return;
    // Prompt for a save location via the Tauri dialog plugin.
    const { save } = await import('@tauri-apps/plugin-dialog');
    const localPath = await save({ defaultPath: obj.name });
    if (!localPath) return;
    const decrypted = await withDecryptedSecret(connection);
    getTransferManager().start({
      direction: 'download',
      connectionId: connection.id,
      config: decrypted,
      key: obj.key,
      localPath,
    });
  };

  const handleDelete = (obj: StorageObject) => {
    if (!connection) return;
    setDeleteConfirm({
      title: 'Hapus File',
      message: `Hapus "${obj.name}" (${formatBytes(obj.size)})? Tindakan ini tidak dapat dibatalkan.`,
      onConfirm: async () => {
        setDeleteConfirm(null);
        try {
          const decrypted = await withDecryptedSecret(connection);
          await safeInvoke('s3_delete_object', { config: decrypted, key: obj.key });
          if (selectedKey === obj.key) setSelectedKey(null);
          list();
        } catch (err: unknown) {
          setError(toStorageError(err).message);
        }
      },
    });
  };

  const handleCreateFolder = async () => {
    if (!connection) return;
    const name = prompt('New folder name:');
    if (!name) return;
    const newPrefix = `${normalizePrefix(prefix)}${normalizePrefix(name)}`;
    if (!isWithinPrefix(newPrefix, connection.pathPrefix)) {
      setError(`Refused: "${newPrefix}" is outside the configured prefix.`);
      return;
    }
    try {
      const decrypted = await withDecryptedSecret(connection);
      await safeInvoke('s3_create_prefix', { config: decrypted, prefix: newPrefix });
      list();
    } catch (err: unknown) {
      setError(toStorageError(err).message);
    }
  };

  // ── Bulk operations (multi-select). The checkbox column toggles membership
  //    in `selectedKeys`; shift-click range-selects between the last-checked
  //    row and the clicked one. ─────────────────────────────────────────────
  const toggleSelect = (key: string, idx: number, shiftKey: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastCheckedIdx.current !== null) {
        // Range select: toggle every object between the last check and this.
        const from = Math.min(lastCheckedIdx.current, idx);
        const to = Math.max(lastCheckedIdx.current, idx);
        const allChecked = objects.slice(from, to + 1).every((o) => next.has(o.key));
        for (let i = from; i <= to; i++) {
          if (allChecked) next.delete(objects[i].key);
          else next.add(objects[i].key);
        }
      } else {
        if (next.has(key)) next.delete(key);
        else next.add(key);
        lastCheckedIdx.current = idx;
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedKeys((prev) => {
      if (objects.length > 0 && objects.every((o) => prev.has(o.key))) {
        return new Set();
      }
      return new Set(objects.map((o) => o.key));
    });
  };

  const handleBulkDelete = (keys: string[]) => {
    if (!connection || keys.length === 0) return;
    setDeleteConfirm({
      title: `Hapus ${keys.length} File`,
      message: `Hapus ${keys.length} objek yang dipilih? Tindakan ini tidak dapat dibatalkan.`,
      onConfirm: async () => {
        setDeleteConfirm(null);
        try {
          const decrypted = await withDecryptedSecret(connection);
          await safeInvoke('s3_delete_objects', { config: decrypted, keys });
          setSelectedKeys(new Set());
          setSelectedKey(null);
          lastCheckedIdx.current = null;
          list();
        } catch (err: unknown) {
          setError(toStorageError(err).message);
        }
      },
    });
  };

  const handleBulkDownload = async (keys: string[]) => {
    if (!connection || keys.length === 0) return;
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const folder = await openDialog({ directory: true, multiple: false });
    if (!folder || typeof folder !== 'string') return;
    const decrypted = await withDecryptedSecret(connection);
    const mgr = getTransferManager();
    for (const key of keys) {
      const name = key.split('/').pop() || key;
      mgr.start({
        direction: 'download',
        connectionId: connection.id,
        config: decrypted,
        key,
        localPath: `${folder}/${name}`,
      });
    }
  };

  /** Generate a presigned download link (default expiry) and copy it to the
   *  clipboard. Surfaces an error inline via the main error banner. */
  const handleQuickPresign = async (obj: StorageObject, expiresSecs: number) => {
    if (!connection) return;
    setError(null);
    try {
      const decrypted = await withDecryptedSecret(connection);
      const url = await safeInvoke<string>('s3_presign_get', {
        config: decrypted,
        key: obj.key,
        expiresSecs,
      });
      const ok = await copyToClipboard(url);
      setPresignOk(ok ? `Copied link for ${obj.name} (expires in ${formatExpiry(expiresSecs)})` : `Link generated for ${obj.name}`);
    } catch (err: unknown) {
      setError(toStorageError(err).message);
    }
  };
  const [presignOk, setPresignOk] = useState<string | null>(null);

  // Picker mode (embedded + onSelectObject) keeps the legacy single-column
  // layout so the restore/backup picker UX is unchanged — no header, no
  // docked detail panel.
  const isPicker = embedded && !!onSelectObject;
  // The object table gains a leading checkbox column (for bulk select) outside
  // picker mode.
  const gridCols = isPicker ? 'grid-cols-[1fr_140px_100px_160px]' : 'grid-cols-[24px_1fr_140px_100px_160px]';
  const allObjectsSelected = objects.length > 0 && objects.every((o) => selectedKeys.has(o.key));

  // Right-click applies to the whole multi-selection when the clicked row is
  // part of it; otherwise it's a single-object action set.
  const contextKeys = contextMenu && selectedKeys.has(contextMenu.key) && selectedKeys.size > 1
    ? [...selectedKeys]
    : contextMenu
      ? [contextMenu.key]
      : [];
  const contextIsBulk = contextKeys.length > 1;

  const providerLabel = getPreset(connection.preset).label;

  return (
    <div className={isPicker ? 'flex flex-col gap-2 min-h-0' : 'flex flex-col h-full min-h-0'}>
      {/* Bucket header — name, provider badge, and a stat row scoped to what's
          currently listed (this app lists per-folder, not the whole bucket
          eagerly, so "Objects"/"Size" reflect the current folder). */}
      {!isPicker && (
        <div className="px-3 pt-2.5 pb-2 shrink-0 border-b border-[#1e293b]">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold text-slate-100">Bucket: {connection.bucket}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300 font-medium">
              {providerLabel}
            </span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span>Region: {connection.region || '—'}</span>
            <span className="text-slate-700">•</span>
            <span>Objects: {totalCount.toLocaleString('en-US')}</span>
            <span className="text-slate-700">•</span>
            <span>Size: {formatBytes(totalSize)}</span>
          </div>
        </div>
      )}

      {/* Main row: content pane + docked object-detail panel. */}
      <div className={isPicker ? 'flex flex-col gap-2 min-h-0 flex-1' : 'flex-1 flex flex-row min-h-0'} ref={mainRowRef}>
      <div className={isPicker ? 'flex flex-col gap-2 min-h-0 flex-1' : 'flex-1 flex flex-col min-w-0 min-h-0'}>
      {/* Analytics panel fills the content pane when toggled. */}
      {!isPicker && showAnalytics && connection ? (
        <StorageAnalytics connectionId={connection.id} />
      ) : (
      <>
      {/* Preview/edit pane replaces the table when active (Finder-style). */}
      {!isPicker && previewObject && connection ? (
        <StorageFileViewer
          connection={connection}
          object={previewObject}
          maxBytes={previewMaxBytes}
          onClose={() => setPreviewKey(null)}
        />
      ) : (
      <>
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 flex-wrap shrink-0">
        {!embedded && (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white bg-blue-600 hover:bg-blue-500 flex items-center gap-1"
              title="Upload to current folder"
            >
              <Upload className="w-3.5 h-3.5" /> Upload
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleUploadFiles(e.target.files ?? uploadTargets)}
            />
            <button
              onClick={handleCreateFolder}
              className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] flex items-center gap-1"
              title="Create folder (prefix)"
            >
              <FilePlus2 className="w-3.5 h-3.5" /> New Folder
            </button>
          </>
        )}
        <button
          onClick={list}
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] flex items-center gap-1"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        {!embedded && (
          <button
            onClick={() => handleBulkDelete([...selectedKeys])}
            disabled={selectedKeys.size === 0}
            className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-red-300 bg-red-600/10 hover:bg-red-600/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
            title={selectedKeys.size > 0 ? `Delete ${selectedKeys.size} selected` : 'Select objects to delete'}
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        )}
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && list()}
            placeholder="Search objects…"
            className="w-56 h-7 pl-7 pr-2 bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded text-xs text-slate-200 focus:outline-none"
          />
        </div>
        <button
          onClick={() => setHideMeta((v) => !v)}
          className={`p-1.5 rounded-lg transition-colors ${
            hideMeta ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 bg-[#141e33] hover:bg-[#1c2a45]'
          }`}
          title={hideMeta ? 'Showing objects only (rdSQL backup sidecars hidden)' : 'Hide rdSQL backup sidecars (.meta.json)'}
        >
          <Filter className="w-3.5 h-3.5" />
        </button>
        <div className="flex items-center rounded-lg border border-[#1e293b] overflow-hidden shrink-0">
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'}`}
            title="List view"
          >
            <List className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setViewMode('grid')}
            className={`p-1.5 transition-colors border-l border-[#1e293b] ${viewMode === 'grid' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'}`}
            title="Grid view"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* Analytics toggle button — inline in same tab */}
        {!embedded && (
          <button
            onClick={() => setShowAnalytics((v) => !v)}
            className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium flex items-center gap-1 transition-colors ${
              showAnalytics
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] border border-transparent'
            }`}
            title={showAnalytics ? 'Back to file browser' : 'Storage Analytics & Disk Map'}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            {showAnalytics ? 'Browser' : 'Analytics'}
          </button>
        )}
      </div>

      {/* Breadcrumbs */}
      <div className="flex items-center gap-0.5 text-[11px] text-slate-400 flex-wrap px-2">
        <button
          onClick={() => navigateTo(connection.pathPrefix)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[#141e33] hover:text-slate-200"
        >
          <Home className="w-3 h-3" /> {connection.pathPrefix ? 'root' : connection.bucket}
        </button>
        {canGoUp && (
          <button
            onClick={() => navigateTo(parentOf(prefix, connection.pathPrefix))}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[#141e33] hover:text-slate-200"
            title="Up one level"
          >
            <ArrowUp className="w-3 h-3" />
          </button>
        )}
        {breadcrumbs.map((b) => (
          <React.Fragment key={b.prefix}>
            <ChevronRight className="w-3 h-3 text-slate-600" />
            <button
              onClick={() => navigateTo(b.prefix)}
              className={`px-1.5 py-0.5 rounded hover:bg-[#141e33] hover:text-slate-200 ${
                b.prefix === normalizePrefix(prefix) ? 'text-slate-200 font-medium' : ''
              }`}
            >
              {b.name}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="relative px-2">
          <CopyableErrorBanner message={error} tone="red" compact />
          <button
            onClick={() => setError(null)}
            className="absolute top-1 right-3 text-slate-500 hover:text-slate-300 p-1"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {presignOk && !error && (
        <div className="relative shrink-0 px-2">
          <div className="flex items-center gap-2 text-emerald-400 text-[11px] px-2 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded">
            <Link2 className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{presignOk}</span>
            <button onClick={() => setPresignOk(null)} className="text-slate-500 hover:text-slate-300">✕</button>
          </div>
        </div>
      )}

      {/* Truncation hint from lazy-load pagination (shown when a folder has
          more than the 10k-object cap). */}
      {truncatedHint && (
        <div className="shrink-0 text-[10px] text-amber-500/80 px-3 pb-0.5">{truncatedHint}</div>
      )}

      {/* Object list/grid + footer status bar */}
      <div className="mx-2 mb-2 border border-[#1e293b] rounded-xl overflow-hidden flex-1 min-h-0 flex flex-col">
        {viewMode === 'list' ? (
          <div className={`grid ${gridCols} gap-2 px-3 py-1.5 bg-[#0a0f18] border-b border-[#1e293b] text-[10px] font-semibold uppercase tracking-wider text-slate-500`}>
            {!isPicker && (
              <span className="flex items-center">
                <input
                  type="checkbox"
                  checked={allObjectsSelected}
                  onChange={toggleSelectAll}
                  className="accent-blue-500 cursor-pointer"
                  title={allObjectsSelected ? 'Deselect all' : 'Select all on this page'}
                  disabled={objects.length === 0}
                />
              </span>
            )}
            <button
              onClick={() => setSortAsc((v) => !v)}
              className="flex items-center gap-1 text-left hover:text-slate-300"
              title="Sort by name"
            >
              Name <ArrowUpDown className="w-2.5 h-2.5" />
            </button>
            <span>Type</span>
            <span className="text-right">Size</span>
            <span>Last Modified</span>
          </div>
        ) : null}
        <div className="flex-1 overflow-auto">
          {loading && !result ? (
            <div className="flex items-center justify-center gap-2 text-slate-500 text-xs py-10">
              <Loader2 className="w-4 h-4 animate-spin" /> Listing…
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid gap-3 p-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))' }}>
              {canGoUp && (
                <button
                  onClick={() => navigateTo(parentOf(prefix, connection.pathPrefix))}
                  className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl border border-transparent text-center transition-colors hover:bg-[#0f172a] hover:border-[#1e293b]"
                  title="Go up one level"
                >
                  <Folder className="w-8 h-8 text-slate-500 shrink-0" />
                  <span className="text-[11px] text-slate-400 truncate w-full">..</span>
                </button>
              )}
              {(result?.prefixes.length ?? 0) === 0 && objects.length === 0 && (
                <div className="col-span-full text-center text-slate-600 text-xs py-10">This folder is empty.</div>
              )}
              {result?.prefixes.map((p: StoragePrefix, i: number) => (
                <button
                  key={`gprefix-${i}-${p.prefix}`}
                  onDoubleClick={() => navigateTo(p.prefix)}
                  onClick={() => setSelectedKey(p.prefix)}
                  className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl border text-center transition-colors ${
                    selectedKey === p.prefix ? 'bg-blue-500/10 border-blue-500/30' : 'border-transparent hover:bg-[#0f172a] hover:border-[#1e293b]'
                  }`}
                >
                  <Folder className="w-8 h-8 text-amber-400 shrink-0" />
                  <span className="text-[11px] text-slate-300 truncate w-full">{p.name}</span>
                </button>
              ))}
              {objects.map((o, i) => (
                <button
                  key={`gobj-${i}-${o.key}`}
                  onClick={() => { setSelectedKey(o.key); onSelectObject?.(o); }}
                  onDoubleClick={() => { if (!isPicker) setPreviewKey(o.key); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelectedKey(o.key);
                    setContextMenu({ x: e.clientX, y: e.clientY, key: o.key });
                  }}
                  className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl border text-center transition-colors ${
                    selectedKey === o.key ? 'bg-blue-500/10 border-blue-500/30' : 'border-transparent hover:bg-[#0f172a] hover:border-[#1e293b]'
                  }`}
                >
                  <FileTypeIcon name={o.name} contentType={o.contentType} className="w-8 h-8 shrink-0" />
                  <span className="text-[11px] text-slate-300 truncate w-full">{o.name}</span>
                  <span className="text-[9px] text-slate-600">{formatBytes(o.size)}</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              {canGoUp && (
                <button
                  onClick={() => navigateTo(parentOf(prefix, connection.pathPrefix))}
                  className={`w-full grid ${gridCols} gap-2 px-3 py-1.5 text-left text-xs border-b border-[#0f172a] hover:bg-[#0a0f18]`}
                  title="Go up one level"
                >
                  {!isPicker && <span />}
                  <span className="flex items-center gap-2 text-slate-400">
                    <Folder className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span>..</span>
                  </span>
                  <span className="text-slate-600">Folder</span>
                  <span className="text-right text-slate-600">—</span>
                  <span className="text-slate-600">—</span>
                </button>
              )}
              {(result?.prefixes.length ?? 0) === 0 && objects.length === 0 && (
                <div className="text-center text-slate-600 text-xs py-10">This folder is empty.</div>
              )}
              {result?.prefixes.map((p: StoragePrefix, i: number) => (
                <button
                  key={`prefix-${i}-${p.prefix}`}
                  onDoubleClick={() => navigateTo(p.prefix)}
                  onClick={() => setSelectedKey(p.prefix)}
                  className={`w-full grid ${gridCols} gap-2 px-3 py-1.5 text-left text-xs border-b border-[#0f172a] ${
                    selectedKey === p.prefix ? 'bg-blue-500/10' : 'hover:bg-[#0a0f18]'
                  }`}
                >
                  {!isPicker && <span />}
                  <span className="flex items-center gap-2 text-slate-300 truncate">
                    <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </span>
                  <span className="text-slate-600">Folder</span>
                  <span className="text-right text-slate-600">—</span>
                  <span className="text-slate-600">—</span>
                </button>
              ))}
              {objects.map((o, i) => (
                <div
                  key={`obj-${i}-${o.key}`}
                  onClick={() => {
                    setSelectedKey(o.key);
                    onSelectObject?.(o);
                  }}
                  onDoubleClick={() => {
                    // Finder/Explorer behavior: double-click opens the file.
                    // In picker mode, defer to the single-click onSelectObject.
                    if (!isPicker) setPreviewKey(o.key);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelectedKey(o.key);
                    setContextMenu({ x: e.clientX, y: e.clientY, key: o.key });
                  }}
                  className={`grid ${gridCols} gap-2 px-3 py-1.5 text-xs border-b border-[#0f172a] cursor-default ${
                    selectedKey === o.key ? 'bg-blue-500/10' : 'hover:bg-[#0a0f18]'
                  } ${selectedKeys.has(o.key) ? 'bg-blue-500/5' : ''}`}
                >
                  {!isPicker && (
                    <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(o.key)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelect(o.key, i, (window.event as MouseEvent | null)?.shiftKey ?? false)}
                        className="accent-blue-500 cursor-pointer"
                        title="Toggle selection (shift-click for range)"
                      />
                    </span>
                  )}
                  <span className="flex items-center gap-2 text-slate-300 truncate">
                    <FileTypeIcon name={o.name} contentType={o.contentType} className="w-3.5 h-3.5" />
                    <span className="truncate">{o.name}</span>
                    {o.isMetadata && (
                      <span className="text-[9px] text-slate-600 bg-[#1e293b] px-1 rounded">meta</span>
                    )}
                  </span>
                  <span className="text-slate-500 truncate lowercase">{o.contentType || guessContentType(o.name)}</span>
                  <span className="text-right text-slate-400">{formatBytes(o.size)}</span>
                  <span className="text-slate-500">{formatDateTime(o.lastModified)}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Persistent footer status bar. */}
        {!isPicker && (
          <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-t border-[#1e293b] bg-[#0a0f18] text-[11px] text-slate-500">
            <span>
              {totalCount.toLocaleString('en-US')} object{totalCount === 1 ? '' : 's'}
            </span>
            {selectedKeys.size > 0 && (
              <>
                <span className="text-slate-700">•</span>
                <span className="text-blue-300 font-medium">
                  {selectedKeys.size} selected ({formatBytes(objects.filter((o) => selectedKeys.has(o.key)).reduce((s, o) => s + o.size, 0))})
                </span>
                <button
                  onClick={() => { setSelectedKeys(new Set()); lastCheckedIdx.current = null; }}
                  className="text-slate-500 hover:text-slate-300"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        )}
      </div>
      </> // end non-preview fragment
      )}
      </> // end analytics conditional
      )}
      </div>{/* end content pane */}

      {/* Docked object-detail panel. */}
      {!isPicker && selectedObject && connection && (
        <>
          <div
            onMouseDown={() => setIsResizingDetail(true)}
            className="w-1.5 h-full bg-[#1e293b]/40 hover:bg-cyan-500 cursor-col-resize z-30 transition-colors shrink-0"
            title="Drag to resize detail panel"
          />
          <div style={{ width: `${storageDetailPanelWidth * zoomLevel}px` }} className="h-full shrink-0">
            <StorageObjectDetailPanel
              connection={connection}
              object={selectedObject}
              onClose={() => setSelectedKey(null)}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onPreview={(key) => setPreviewKey(key)}
              onOpenAcl={(key) => setAclKey(key)}
            />
          </div>
        </>
      )}
      </div>{/* end main row */}

      {/* ACL / permissions dialog. */}
      {!isPicker && aclObject && connection && (
        <StorageAclDialog
          connection={connection}
          object={aclObject}
          onClose={() => setAclKey(null)}
        />
      )}

      {/* Delete confirmation dialog — replaces native browser confirm(). */}
      {deleteConfirm && (
        <ConfirmDialog
          title={deleteConfirm.title}
          message={deleteConfirm.message}
          confirmLabel="Hapus"
          tone="danger"
          onConfirm={deleteConfirm.onConfirm}
          onClose={() => setDeleteConfirm(null)}
        />
      )}

      {/* Context menu — every per-object action lives here (or in the docked
          detail panel) instead of a row of always-visible icon buttons, so
          the table stays clean like the mockup. Applies to the whole
          selection when the clicked row is part of a multi-select. */}
      {contextMenu && (
        <div
          className="fixed z-[200] bg-[#0a0f18] border border-[#1e293b] rounded-lg shadow-2xl py-1 text-xs min-w-[160px]"
          // Flip the menu above the cursor when there isn't room below (e.g.
          // right-clicking the last row), so it never gets clipped at the
          // viewport bottom. Approximate menu height ≈ 5 items × 28px + chrome.
          style={{
            left: contextMenu.x,
            top: contextMenu.y + 170 > window.innerHeight ? contextMenu.y - 170 : contextMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextIsBulk ? (
            <>
              <div className="px-3 pb-1 pt-0.5 text-[9px] uppercase tracking-wider text-slate-600 font-semibold">
                {contextKeys.length} selected
              </div>
              <ContextItem
                icon={<Download className="w-3.5 h-3.5" />}
                label={`Download ${contextKeys.length}`}
                onClick={() => { void handleBulkDownload(contextKeys); setContextMenu(null); }}
              />
              {!embedded && (
                <ContextItem
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                  label={`Delete ${contextKeys.length}`}
                  danger
                  onClick={() => { handleBulkDelete(contextKeys); setContextMenu(null); }}
                />
              )}
            </>
          ) : (
            <>
              <ContextItem
                icon={<Eye className="w-3.5 h-3.5" />}
                label="Preview / Edit"
                onClick={() => {
                  setPreviewKey(contextMenu.key);
                  setContextMenu(null);
                }}
              />
              <ContextItem
                icon={<Link2 className="w-3.5 h-3.5" />}
                label="Copy Share Link"
                onClick={() => {
                  const o = objects.find((x) => x.key === contextMenu.key);
                  if (o) void handleQuickPresign(o, PRESIGN_DEFAULT_SECS);
                  setContextMenu(null);
                }}
              />
              {connection && providerSupportsAcl(connection.preset) && (
                <ContextItem
                  icon={<Shield className="w-3.5 h-3.5" />}
                  label="Permissions (ACL)"
                  onClick={() => {
                    setAclKey(contextMenu.key);
                    setContextMenu(null);
                  }}
                />
              )}
              <ContextItem
                icon={<Download className="w-3.5 h-3.5" />}
                label="Download"
                onClick={() => {
                  const o = objects.find((x) => x.key === contextMenu.key);
                  if (o) handleDownload(o);
                  setContextMenu(null);
                }}
              />
              {!embedded && (
                <ContextItem
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                  label="Delete"
                  danger
                  onClick={() => {
                    const o = objects.find((x) => x.key === contextMenu.key);
                    if (o) handleDelete(o);
                    setContextMenu(null);
                  }}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const ContextItem: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }> = ({
  icon, label, onClick, danger,
}) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#141e33] ${
      danger ? 'text-red-400' : 'text-slate-300'
    }`}
  >
    {icon}
    {label}
  </button>
);

/** Build breadcrumb segments between the connection's root prefix and `prefix`. */
function buildBreadcrumbs(prefix: string, rootPrefix: string): { name: string; prefix: string }[] {
  const root = normalizePrefix(rootPrefix);
  let rel = normalizePrefix(prefix);
  if (root && rel.startsWith(root)) rel = rel.slice(root.length);
  if (!rel) return [];
  const parts = rel.split('/').filter(Boolean);
  const segs: { name: string; prefix: string }[] = [];
  let acc = root;
  for (let i = 0; i < parts.length; i++) {
    acc += parts[i] + '/';
    segs.push({ name: parts[i], prefix: acc });
  }
  return segs;
}

/** Parent prefix of the current one, clamped at the connection root. */
function parentOf(prefix: string, rootPrefix: string): string {
  const root = normalizePrefix(rootPrefix);
  let rel = normalizePrefix(prefix);
  if (root && rel.startsWith(root)) rel = rel.slice(root.length);
  const parts = rel.split('/').filter(Boolean);
  if (parts.length <= 1) return root;
  parts.pop();
  return root + parts.join('/') + '/';
}
