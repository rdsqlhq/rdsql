import React, { useMemo, useState } from 'react';
import { Folder, Eye, ExternalLink, Trash2, HardDrive, FileText, CheckCircle2 } from 'lucide-react';
import { formatBytes } from './format';
import { FileTypeIcon } from './FileTypeIcon';

export interface TreemapItem {
  id: string;
  name: string;
  fullPath: string;
  prefixPath: string; // for folder navigation or file location
  size: number;
  type: 'folder' | 'file';
  fileCount?: number;
  keys: string[];
}

export interface Rect {
  x: number; // percentage 0..100
  y: number; // percentage 0..100
  w: number; // percentage 0..100
  h: number; // percentage 0..100
}

export interface PositionedNode {
  item: TreemapItem;
  rect: Rect;
  colorClass: string;
  badgeClass: string;
}

interface StorageGridMapProps {
  items: TreemapItem[];
  totalBytes: number;
  onGoToLocation: (prefix: string, key?: string) => void;
  onPreviewFile?: (key: string) => void;
  onDeleteItem: (item: TreemapItem) => void;
  deletingKeyOrPath?: string | null;
}

/** Determines tile styling based on type and extension */
function getTileColor(item: TreemapItem): { bg: string; badge: string } {
  if (item.type === 'folder') {
    return {
      bg: 'bg-gradient-to-br from-indigo-950/80 via-slate-900 to-slate-950 border-indigo-500/30 hover:border-indigo-400/60 text-indigo-200',
      badge: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
    };
  }

  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (['zip', 'tar', 'gz', '7z', 'rar', 'bz2'].includes(ext)) {
    return {
      bg: 'bg-gradient-to-br from-amber-950/70 via-slate-900 to-amber-950/40 border-amber-500/30 hover:border-amber-400/60 text-amber-200',
      badge: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    };
  }
  if (['mp4', 'mov', 'mkv', 'avi', 'mp3', 'wav', 'flac'].includes(ext)) {
    return {
      bg: 'bg-gradient-to-br from-purple-950/70 via-slate-900 to-purple-950/40 border-purple-500/30 hover:border-purple-400/60 text-purple-200',
      badge: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    };
  }
  if (['sql', 'db', 'sqlite', 'csv', 'json', 'parquet', 'dump'].includes(ext)) {
    return {
      bg: 'bg-gradient-to-br from-emerald-950/70 via-slate-900 to-emerald-950/40 border-emerald-500/30 hover:border-emerald-400/60 text-emerald-200',
      badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    };
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) {
    return {
      bg: 'bg-gradient-to-br from-sky-950/70 via-slate-900 to-sky-950/40 border-sky-500/30 hover:border-sky-400/60 text-sky-200',
      badge: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
    };
  }

  return {
    bg: 'bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-950 border-slate-700/50 hover:border-slate-500 text-slate-200',
    badge: 'bg-slate-800 text-slate-300 border-slate-700',
  };
}

/** Recursively squarify items inside bounding box (0..100, 0..100) */
function squarify(
  items: TreemapItem[],
  rect: Rect,
  totalSum: number,
): PositionedNode[] {
  if (items.length === 0 || rect.w <= 0 || rect.h <= 0 || totalSum <= 0) {
    return [];
  }

  if (items.length === 1) {
    const style = getTileColor(items[0]);
    return [
      {
        item: items[0],
        rect,
        colorClass: style.bg,
        badgeClass: style.badge,
      },
    ];
  }

  // Split horizontally or vertically based on rect aspect ratio
  let currentSum = 0;
  let splitIndex = 0;
  const halfSum = totalSum / 2;

  for (let i = 0; i < items.length; i++) {
    currentSum += items[i].size;
    splitIndex = i;
    if (currentSum >= halfSum) break;
  }

  // Guarantee at least 1 item in left/top slice
  const leftItems = items.slice(0, Math.max(1, splitIndex + 1));
  const rightItems = items.slice(Math.max(1, splitIndex + 1));

  const leftSum = leftItems.reduce((acc, it) => acc + it.size, 0);
  const rightSum = totalSum - leftSum;

  const leftRatio = leftSum / totalSum;

  let leftRect: Rect;
  let rightRect: Rect;

  if (rect.w >= rect.h) {
    // Split along width (vertical line)
    const leftWidth = rect.w * leftRatio;
    leftRect = { x: rect.x, y: rect.y, w: leftWidth, h: rect.h };
    rightRect = { x: rect.x + leftWidth, y: rect.y, w: rect.w - leftWidth, h: rect.h };
  } else {
    // Split along height (horizontal line)
    const leftHeight = rect.h * leftRatio;
    leftRect = { x: rect.x, y: rect.y, w: rect.w, h: leftHeight };
    rightRect = { x: rect.x, y: rect.y + leftHeight, w: rect.w, h: rect.h - leftHeight };
  }

  return [
    ...squarify(leftItems, leftRect, leftSum),
    ...squarify(rightItems, rightRect, rightSum),
  ];
}

export const StorageGridMap: React.FC<StorageGridMapProps> = ({
  items,
  totalBytes,
  onGoToLocation,
  onPreviewFile,
  onDeleteItem,
  deletingKeyOrPath,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const positionedNodes = useMemo(() => {
    if (!items.length || totalBytes <= 0) return [];
    // Sort descending by size
    const sorted = [...items].sort((a, b) => b.size - a.size);
    // Take top 40 items to keep visual grid clear and readable
    const top = sorted.slice(0, 40);
    const sum = top.reduce((acc, i) => acc + i.size, 0);

    return squarify(top, { x: 0, y: 0, w: 100, h: 100 }, sum);
  }, [items, totalBytes]);

  const selectedNode = useMemo(
    () => positionedNodes.find((n) => n.item.id === selectedId) ?? null,
    [positionedNodes, selectedId],
  );

  if (items.length === 0) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 text-sm">
        <HardDrive className="w-8 h-8 mb-2 text-slate-600 stroke-[1.5]" />
        No objects available for Grid Map display.
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col gap-3">
      {/* Interactive Treemap Box */}
      <div className="relative w-full flex-1 min-h-[380px] bg-[#070b14] border border-[#1e293b] rounded-xl overflow-hidden p-1">
        {positionedNodes.map(({ item, rect, colorClass, badgeClass }) => {
          const isSelected = selectedId === item.id;
          const isDeleting = deletingKeyOrPath === item.fullPath || deletingKeyOrPath === item.id;
          const pctOfTotal = totalBytes > 0 ? ((item.size / totalBytes) * 100).toFixed(1) : '0';

          return (
            <div
              key={item.id}
              onClick={() => setSelectedId(isSelected ? null : item.id)}
              style={{
                left: `${rect.x}%`,
                top: `${rect.y}%`,
                width: `${rect.w}%`,
                height: `${rect.h}%`,
              }}
              className={`absolute p-1.5 transition-all duration-150 group cursor-pointer ${
                isDeleting ? 'opacity-30 pointer-events-none' : ''
              }`}
            >
              <div
                className={`w-full h-full rounded-lg border p-2 flex flex-col justify-between overflow-hidden shadow-sm backdrop-blur-xs transition-all ${colorClass} ${
                  isSelected ? 'ring-2 ring-amber-400 shadow-lg scale-[0.99] z-10' : 'hover:scale-[0.995]'
                }`}
              >
                {/* Header line inside block */}
                <div className="flex items-center justify-between gap-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {item.type === 'folder' ? (
                      <Folder className="w-3.5 h-3.5 shrink-0 text-amber-400 fill-amber-400/20" />
                    ) : (
                      <FileTypeIcon name={item.name} className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="text-xs font-semibold truncate leading-tight tracking-tight">
                      {item.name}
                    </span>
                  </div>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md border shrink-0 font-medium ${badgeClass}`}>
                    {pctOfTotal}%
                  </span>
                </div>

                {/* Body info if block height is large enough */}
                {rect.h > 15 && rect.w > 12 && (
                  <div className="mt-auto pt-1 flex flex-col gap-0.5 min-w-0">
                    <span className="text-[11px] font-mono font-bold tracking-tight">
                      {formatBytes(item.size)}
                    </span>
                    {item.type === 'folder' && item.fileCount !== undefined && (
                      <span className="text-[10px] opacity-75 truncate">
                        {item.fileCount.toLocaleString()} {item.fileCount === 1 ? 'file' : 'files'}
                      </span>
                    )}
                    {rect.h > 25 && rect.w > 18 && (
                      <span className="text-[9.5px] opacity-50 font-mono truncate pt-0.5">
                        {item.fullPath}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Selected Item Action Drawer Bar */}
      {selectedNode ? (
        <div className="shrink-0 bg-[#0c121e] border border-[#1e293b] rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 shadow-md animate-in fade-in slide-in-from-bottom-1 duration-150">
          <div className="flex items-center gap-2.5 min-w-0">
            {selectedNode.item.type === 'folder' ? (
              <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">
                <Folder className="w-4 h-4" />
              </div>
            ) : (
              <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <FileText className="w-4 h-4" />
              </div>
            )}
            <div className="min-w-0 flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-100 truncate">
                  {selectedNode.item.name}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded border border-slate-700">
                  {selectedNode.item.type === 'folder' ? 'Folder' : 'File'}
                </span>
              </div>
              <span className="text-[11px] text-slate-400 font-mono truncate">
                {selectedNode.item.fullPath} · <strong className="text-slate-200">{formatBytes(selectedNode.item.size)}</strong>
                {selectedNode.item.fileCount !== undefined && ` (${selectedNode.item.fileCount} files)`}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Go to location button */}
            <button
              onClick={() =>
                onGoToLocation(
                  selectedNode.item.prefixPath,
                  selectedNode.item.type === 'file' ? selectedNode.item.fullPath : undefined,
                )
              }
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 bg-[#172238] hover:bg-[#20304f] border border-[#2b3c5e] flex items-center gap-1.5 transition-colors"
              title="Open location in Storage Browser"
            >
              <ExternalLink className="w-3.5 h-3.5 text-sky-400" />
              <span>Ke {selectedNode.item.type === 'folder' ? 'Folder' : 'File'}</span>
            </button>

            {/* Preview file button */}
            {selectedNode.item.type === 'file' && onPreviewFile && (
              <button
                onClick={() => onPreviewFile(selectedNode.item.fullPath)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 bg-[#172238] hover:bg-[#20304f] border border-[#2b3c5e] flex items-center gap-1.5 transition-colors"
                title="Preview object content"
              >
                <Eye className="w-3.5 h-3.5 text-blue-400" />
                <span>Preview</span>
              </button>
            )}

            {/* Delete button */}
            <button
              onClick={() => onDeleteItem(selectedNode.item)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 flex items-center gap-1.5 transition-colors"
              title={selectedNode.item.type === 'folder' ? 'Delete all files in folder' : 'Delete file'}
            >
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
              <span>Delete {selectedNode.item.type === 'folder' ? 'Folder' : 'File'}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="shrink-0 text-[11px] text-slate-500 px-2 py-1 flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-slate-600" />
          Click any box on the Grid Map to select, inspect, open location, or delete.
        </div>
      )}
    </div>
  );
};
