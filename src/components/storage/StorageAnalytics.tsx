import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  RefreshCw,
  Loader2,
  Trash2,
  Eye,
  AlertTriangle,
  LayoutGrid,
  FolderTree,
  FileText,
  ExternalLink,
  Folder,
  HardDrive,
  SlidersHorizontal,
} from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { useStorageStore } from '../../store/useStorageStore';
import { useTabStore } from '../../store/useTabStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { normalizePrefix } from '../../core/storage/domain/paths';
import { toStorageError } from '../../core/storage/domain/errors';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { FileTypeIcon } from './FileTypeIcon';
import { StorageFileViewer } from './StorageFileViewer';
import { StorageGridMap, TreemapItem } from './StorageGridMap';
import { formatBytes, formatDateTime } from './format';
import type { StorageObject, ListObjectsResult } from '../../core/storage/domain/types';

interface Props {
  connectionId?: string;
}

/** Max pages to scan recursively. 50 pages × 1000 = 50k objects cap. */
const MAX_SCAN_PAGES = 50;
/** How many items to render in the graph lists. */
const TOP_N = 50;

type ViewMode = 'all' | 'grid' | 'folders' | 'files';

export interface FolderStat {
  id: string;
  path: string; // e.g. "photos/vacation/"
  name: string; // e.g. "vacation" or "photos"
  prefixPath: string; // parent prefix path to navigate in StorageBrowser
  totalSize: number;
  fileCount: number;
  keys: string[];
}

export const StorageAnalytics: React.FC<Props> = ({ connectionId }) => {
  const storeConnId = useStorageStore((s) => s.activeConnectionId);
  const connections = useStorageStore((s) => s.connections);
  const previewMaxBytes = useSettingsStore((s) => s.s3PreviewMaxBytes);
  const openStorageTab = useTabStore((s) => s.openStorageTab);

  const connId = connectionId ?? storeConnId;
  const connection = useMemo(
    () => connections.find((c) => c.id === connId) ?? null,
    [connections, connId],
  );

  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [scanning, setScanning] = useState(false);
  const [page, setPage] = useState(0);
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [truncatedHint, setTruncatedHint] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const previewObject = useMemo(
    () => objects.find((o) => o.key === previewKey) ?? null,
    [objects, previewKey],
  );

  // Scan recursive objects
  const scan = useCallback(async () => {
    if (!connection) return;
    setScanning(true);
    setError(null);
    setTruncatedHint(null);
    setObjects([]);
    setPage(0);
    try {
      const decrypted = await withDecryptedSecret(connection);
      const prefix = normalizePrefix(connection.pathPrefix);
      let accum: StorageObject[] = [];
      let token: string | undefined = undefined;
      let pages = 0;
      let isTruncated = false;
      do {
        pages++;
        setPage(pages);
        const listResult: ListObjectsResult = await safeInvoke<ListObjectsResult>('s3_list_objects', {
          config: decrypted,
          prefix,
          opts: { maxKeys: 1000, recursive: true, continuationToken: token },
        });
        accum = [...accum, ...listResult.objects];
        isTruncated = listResult.isTruncated;
        token = listResult.continuationToken;
      } while (isTruncated && token && pages < MAX_SCAN_PAGES);

      if (isTruncated) {
        setTruncatedHint(
          `Scanned ${pages * 1000}+ objects (cap reached). Refine connection path prefix to scan a smaller subtree.`,
        );
      }
      accum = accum.filter((o) => o.size > 0).sort((a, b) => b.size - a.size);
      setObjects(accum);
    } catch (err: unknown) {
      setError(toStorageError(err).message);
    } finally {
      setScanning(false);
    }
  }, [connection]);

  useEffect(() => {
    if (connection) void scan();
  }, [connection?.id]);

  useEffect(() => {
    if (!previewKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPreviewKey(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [previewKey]);

  // Aggregate folder statistics
  const folderStats = useMemo<FolderStat[]>(() => {
    if (!connection || objects.length === 0) return [];
    const basePrefix = normalizePrefix(connection.pathPrefix);
    const map = new Map<string, { size: number; count: number; keys: string[] }>();

    for (const obj of objects) {
      let relKey = obj.key;
      if (basePrefix && relKey.startsWith(basePrefix)) {
        relKey = relKey.slice(basePrefix.length);
      }
      const parts = relKey.split('/').filter(Boolean);
      let folderPath = '';
      if (parts.length > 1) {
        folderPath = (basePrefix ? basePrefix : '') + parts[0] + '/';
      } else {
        folderPath = (basePrefix ? basePrefix : '') + '[Root Files]';
      }

      const existing = map.get(folderPath) ?? { size: 0, count: 0, keys: [] };
      existing.size += obj.size;
      existing.count += 1;
      existing.keys.push(obj.key);
      map.set(folderPath, existing);
    }

    const result: FolderStat[] = [];
    for (const [fPath, data] of map.entries()) {
      let name = fPath;
      let prefixPath = fPath;
      if (fPath.endsWith('[Root Files]')) {
        name = '[Files in Root]';
        prefixPath = fPath.replace('[Root Files]', '');
      } else {
        const parts = fPath.split('/').filter(Boolean);
        name = parts[parts.length - 1] || fPath;
      }

      result.push({
        id: fPath,
        path: fPath,
        name,
        prefixPath,
        totalSize: data.size,
        fileCount: data.count,
        keys: data.keys,
      });
    }

    return result.sort((a, b) => b.totalSize - a.totalSize);
  }, [connection, objects]);

  // Items formatted for Grid Map treemap visualizer
  const treemapItems = useMemo<TreemapItem[]>(() => {
    if (!objects.length) return [];
    const items: TreemapItem[] = [];

    // Include top folders
    for (const f of folderStats) {
      if (f.path.endsWith('[Root Files]')) continue;
      items.push({
        id: `folder_${f.path}`,
        name: f.name,
        fullPath: f.path,
        prefixPath: f.path,
        size: f.totalSize,
        type: 'folder',
        fileCount: f.fileCount,
        keys: f.keys,
      });
    }

    // Include top root files
    const rootFiles = objects.filter((o) => {
      const basePrefix = normalizePrefix(connection?.pathPrefix ?? '');
      const relKey = basePrefix && o.key.startsWith(basePrefix) ? o.key.slice(basePrefix.length) : o.key;
      return !relKey.includes('/') || folderStats.length <= 1;
    });

    for (const obj of rootFiles.slice(0, 30)) {
      const parentPrefix = obj.key.substring(0, obj.key.lastIndexOf('/') + 1);
      items.push({
        id: `file_${obj.key}`,
        name: obj.name,
        fullPath: obj.key,
        prefixPath: parentPrefix,
        size: obj.size,
        type: 'file',
        keys: [obj.key],
      });
    }

    return items;
  }, [connection, folderStats, objects]);

  // Actions
  const handleGoToLocation = (prefix: string, key?: string) => {
    if (!connection) return;
    openStorageTab(connection.id, prefix, key);
  };

  const handleDeleteFile = (obj: StorageObject) => {
    if (!connection) return;
    setDeleteConfirm({
      title: 'Hapus File',
      message: `Hapus file "${obj.name}" (${formatBytes(obj.size)})? Tindakan ini tidak dapat dibatalkan.`,
      onConfirm: async () => {
        setDeleteConfirm(null);
        setDeletingPath(obj.key);
        setError(null);
        try {
          const decrypted = await withDecryptedSecret(connection);
          await safeInvoke('s3_delete_object', { config: decrypted, key: obj.key });
          setObjects((prev) => prev.filter((o) => o.key !== obj.key));
        } catch (err: unknown) {
          setError(toStorageError(err).message);
        } finally {
          setDeletingPath(null);
        }
      },
    });
  };

  const handleDeleteFolder = (folder: FolderStat) => {
    if (!connection) return;
    const isRoot = folder.path.endsWith('[Root Files]');
    const label = isRoot ? 'semua file di root' : `folder "${folder.name}"`;
    setDeleteConfirm({
      title: isRoot ? 'Hapus Semua File Root' : `Hapus Folder "${folder.name}"`,
      message: `Hapus ${label} yang berisi ${folder.fileCount.toLocaleString()} objek (${formatBytes(folder.totalSize)})? Tindakan ini tidak dapat dibatalkan.`,
      onConfirm: async () => {
        setDeleteConfirm(null);
        setDeletingPath(folder.path);
        setError(null);
        try {
          const decrypted = await withDecryptedSecret(connection);
          const chunkSize = 1000;
          for (let i = 0; i < folder.keys.length; i += chunkSize) {
            const chunk = folder.keys.slice(i, i + chunkSize);
            await safeInvoke('s3_delete_objects', { config: decrypted, keys: chunk });
          }
          const deleteSet = new Set(folder.keys);
          setObjects((prev) => prev.filter((o) => !deleteSet.has(o.key)));
        } catch (err: unknown) {
          setError(toStorageError(err).message);
        } finally {
          setDeletingPath(null);
        }
      },
    });
  };

  const handleDeleteTreemapItem = (item: TreemapItem) => {
    if (item.type === 'file') {
      const obj = objects.find((o) => o.key === item.fullPath);
      if (obj) handleDeleteFile(obj);
    } else {
      const folder = folderStats.find((f) => f.path === item.fullPath);
      if (folder) handleDeleteFolder(folder);
    }
  };

  if (!connection) {
    return (
      <div className="w-full h-full bg-[#06090e] flex items-center justify-center text-slate-600 text-sm">
        No storage connection selected.
      </div>
    );
  }

  if (previewObject) {
    return (
      <StorageFileViewer
        connection={connection}
        object={previewObject}
        maxBytes={previewMaxBytes}
        onClose={() => setPreviewKey(null)}
      />
    );
  }

  const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
  const maxFileSize = objects[0]?.size ?? 0;
  const topFiles = objects.slice(0, TOP_N);

  return (
    <>
    <div className="w-full h-full bg-[#06090e] flex flex-col overflow-hidden">
      {/* Top Header Bar */}
      <div className="shrink-0 border-b border-[#1e293b] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 bg-[#0a0f18]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">
            <BarChart3 className="w-4 h-4 shrink-0" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-bold text-slate-100 truncate">
              Storage Analytics & Disk Map
            </span>
            <span className="text-[11px] text-slate-400 truncate">
              {connection.name} ({connection.bucket})
            </span>
          </div>
        </div>

        {/* Rescan Button */}
        <button
          onClick={() => void scan()}
          disabled={scanning}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] border border-[#233557] flex items-center gap-1.5 disabled:opacity-50 transition-colors shadow-xs"
          title="Rescan storage prefix"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin text-amber-400' : ''}`} />
          {scanning ? `Scanning (${page})…` : 'Rescan Storage'}
        </button>
      </div>

      {/* Summary Cards */}
      <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 border-b border-[#1e293b] bg-[#070b12]">
        <StatCard label="Objects scanned" value={objects.length.toLocaleString()} />
        <StatCard label="Total storage size" value={formatBytes(totalBytes)} />
        <StatCard label="Total Folders" value={folderStats.length.toString()} />
        <StatCard label="Largest File" value={maxFileSize > 0 ? formatBytes(maxFileSize) : '—'} />
      </div>

      {/* Prominent Tab Navigation Switcher */}
      <div className="shrink-0 border-b border-[#1e293b] px-4 py-2 bg-[#090d16] flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <button
            onClick={() => setViewMode('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
              viewMode === 'all'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Dashboard Lengkap</span>
          </button>
          <button
            onClick={() => setViewMode('grid')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
              viewMode === 'grid'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5 text-sky-400" />
            <span>Grid Map (Treemap)</span>
          </button>
          <button
            onClick={() => setViewMode('folders')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
              viewMode === 'folders'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
            }`}
          >
            <FolderTree className="w-3.5 h-3.5 text-amber-400" />
            <span>Folder Terbesar</span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 bg-slate-800 text-slate-300 rounded border border-slate-700">
              {folderStats.length}
            </span>
          </button>
          <button
            onClick={() => setViewMode('files')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
              viewMode === 'files'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
            }`}
          >
            <FileText className="w-3.5 h-3.5 text-blue-400" />
            <span>Grafik File Terbesar</span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 bg-slate-800 text-slate-300 rounded border border-slate-700">
              {topFiles.length}
            </span>
          </button>
        </div>
      </div>

      {/* Errors / Warnings */}
      {(error || truncatedHint) && (
        <div className="shrink-0 p-3 flex flex-col gap-2">
          {error && <CopyableErrorBanner message={error} tone="red" />}
          {truncatedHint && (
            <div className="flex items-center gap-2 text-[11px] text-amber-500/80 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1">{truncatedHint}</span>
            </div>
          )}
        </div>
      )}

      {/* Main Content Scroll Area */}
      <div className="flex-1 overflow-auto p-4 min-h-0">
        {scanning && objects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500 text-xs">
            <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
            Scanning page {page}… listing objects under {connection.pathPrefix || 'root'}.
          </div>
        ) : objects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 text-sm">
            No storage objects found.
          </div>
        ) : (
          <div className="flex flex-col gap-8 max-w-5xl mx-auto">
            {/* Section 1: Grid Map */}
            {(viewMode === 'all' || viewMode === 'grid') && (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between border-b border-[#1e293b] pb-2">
                  <div className="flex items-center gap-2">
                    <LayoutGrid className="w-4 h-4 text-sky-400" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                      Grid Map (Treemap Visual Disk Map)
                    </h3>
                  </div>
                  <span className="text-[11px] text-slate-500 font-mono">
                    Kotak visual seproporsional dengan byte size
                  </span>
                </div>

                <div className="h-[380px] w-full">
                  <StorageGridMap
                    items={treemapItems}
                    totalBytes={totalBytes}
                    onGoToLocation={handleGoToLocation}
                    onPreviewFile={(key) => setPreviewKey(key)}
                    onDeleteItem={handleDeleteTreemapItem}
                    deletingKeyOrPath={deletingPath}
                  />
                </div>
              </div>
            )}

            {/* Section 2: Grafik & Breakdown Folder Terbesar */}
            {(viewMode === 'all' || viewMode === 'folders') && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-[#1e293b] pb-2">
                  <div className="flex items-center gap-2">
                    <FolderTree className="w-4 h-4 text-amber-400" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                      Grafik & Breakdown Folder Terbesar ({folderStats.length} folders)
                    </h3>
                  </div>
                  <span className="text-[11px] text-slate-400 font-mono">
                    Total Storage: <strong>{formatBytes(totalBytes)}</strong>
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  {folderStats.map((f, idx) => {
                    const pct = totalBytes > 0 ? Math.max(1, Math.round((f.totalSize / totalBytes) * 100)) : 0;
                    const isDeleting = deletingPath === f.path;

                    return (
                      <div
                        key={f.id}
                        className={`group bg-[#0b1019] border border-[#1e293b] hover:border-[#2e3e5c] rounded-xl p-3 flex flex-col gap-2 transition-all ${
                          isDeleting ? 'opacity-40 pointer-events-none' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="text-[10px] font-mono text-slate-500 w-5 text-right shrink-0">
                              #{idx + 1}
                            </span>
                            <div className="p-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 shrink-0">
                              <Folder className="w-4 h-4 fill-amber-400/20" />
                            </div>
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs font-bold text-slate-100 truncate">
                                {f.name}
                              </span>
                              <span className="text-[10.5px] text-slate-500 font-mono truncate">
                                {f.path} · {f.fileCount.toLocaleString()} {f.fileCount === 1 ? 'file' : 'files'}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            <div className="text-right font-mono">
                              <div className="text-xs font-bold text-slate-200">
                                {formatBytes(f.totalSize)}
                              </div>
                              <div className="text-[10px] text-amber-400 font-medium">
                                {pct}% of storage
                              </div>
                            </div>

                            <div className="flex items-center gap-1 opacity-90 group-hover:opacity-100">
                              <button
                                onClick={() => handleGoToLocation(f.prefixPath)}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] border border-[#233557] flex items-center gap-1"
                                title="Go to folder location in Storage Browser"
                              >
                                <ExternalLink className="w-3 h-3 text-sky-400" />
                                <span>Ke Folder</span>
                              </button>
                              <button
                                onClick={() => void handleDeleteFolder(f)}
                                disabled={isDeleting}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-colors disabled:opacity-50"
                                title="Delete folder contents"
                              >
                                {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Size Graph Bar */}
                        <div className="h-2 bg-[#06090e] rounded-full overflow-hidden border border-slate-800/80 p-0.5">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-amber-500 via-orange-500 to-amber-400 transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Section 3: Grafik & Breakdown File Terbesar */}
            {(viewMode === 'all' || viewMode === 'files') && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-[#1e293b] pb-2">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-blue-400" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                      Grafik & Breakdown File Terbesar (Top {topFiles.length} dari {objects.length.toLocaleString()} files)
                    </h3>
                  </div>
                  <span className="text-[11px] text-slate-400 font-mono">
                    Max File Size: <strong>{formatBytes(maxFileSize)}</strong>
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  {topFiles.map((o, idx) => {
                    const pct = maxFileSize > 0 ? Math.max(1, Math.round((o.size / maxFileSize) * 100)) : 0;
                    const parentPrefix = o.key.substring(0, o.key.lastIndexOf('/') + 1);
                    const isDeleting = deletingPath === o.key;

                    return (
                      <div
                        key={o.key}
                        className={`group bg-[#0b1019] border border-[#1e293b] hover:border-[#2e3e5c] rounded-xl p-3 flex flex-col gap-2 transition-all ${
                          isDeleting ? 'opacity-40 pointer-events-none' : ''
                        }`}
                      >
                        <div className="grid grid-cols-[24px_1fr_auto_auto] items-center gap-3">
                          <span className="text-[10px] font-mono text-slate-500 text-right">
                            #{idx + 1}
                          </span>

                          <div className="flex items-center gap-2.5 min-w-0">
                            <FileTypeIcon name={o.name} className="w-4 h-4 shrink-0" />
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs text-slate-100 font-bold truncate">
                                {o.name}
                              </span>
                              <span className="text-[10px] text-slate-500 font-mono truncate">
                                {o.key}
                              </span>
                            </div>
                          </div>

                          <div className="text-right shrink-0 px-2 font-mono">
                            <div className="text-xs font-bold text-slate-200">{formatBytes(o.size)}</div>
                            <div className="text-[9.5px] text-slate-500">{formatDateTime(o.lastModified)}</div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1 opacity-90 group-hover:opacity-100 shrink-0">
                            <button
                              onClick={() => setPreviewKey(o.key)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 border border-transparent hover:border-blue-500/20 transition-colors"
                              title="Preview file content"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleGoToLocation(parentPrefix, o.key)}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] border border-[#233557] flex items-center gap-1"
                              title="Go to file location in Storage Browser"
                            >
                              <ExternalLink className="w-3 h-3 text-sky-400" />
                              <span>Ke File</span>
                            </button>
                            <button
                              onClick={() => void handleDeleteFile(o)}
                              disabled={isDeleting}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-colors disabled:opacity-50"
                              title="Delete file"
                            >
                              {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </div>

                        {/* Relative Bar */}
                        <div className="h-1.5 bg-[#06090e] rounded-full overflow-hidden border border-slate-800/60 p-0.5">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-blue-500 via-sky-400 to-indigo-500 transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    {/* Delete confirmation dialog */}
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
  </>);
};

const StatCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="border border-[#1e293b] rounded-xl p-3 bg-[#0a0f18] flex flex-col justify-between">
    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">{label}</div>
    <div className="text-base sm:text-lg font-bold text-slate-100 mt-1 font-mono tracking-tight truncate">{value}</div>
  </div>
);
