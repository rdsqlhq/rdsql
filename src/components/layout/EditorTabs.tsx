import React, { useState, useEffect } from 'react';
import { X, Plus, FileCode, Table as TableIcon, XCircle, ChevronsRight, GitFork, Cloud, FolderOpen, Key, FileJson } from 'lucide-react';
import { useTabStore } from '../../store/useTabStore';
import { useToastStore } from '../../store/useToastStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { isRedisEngine } from '../../core/connection/engines';
import { pickAndReadSqlFile } from '../../core/sql/loadSqlFile';
import { ConfirmDialog } from '../common/ConfirmDialog';
import type { QueryTab } from '../../core/domain/types';

/** A SQL editor tab counts as "has content" when it holds typed SQL — closing
 *  it without asking would silently discard text the user never ran/saved. */
const hasUnclosedSql = (tab: QueryTab) => tab.tabType === 'sql_editor' && tab.sql.trim() !== '';

export const EditorTabs: React.FC = () => {
  const { tabs, activeTabId, setActiveTab, closeTab, openSqlTab, openRedisBrowserTab, closeAllTabs, closeTabsToRight, closeOtherTabs, reorderTabs } = useTabStore();
  const pushToast = useToastStore((s) => s.push);
  const connections = useConnectionStore((s) => s.connections);
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  // Redis has no SQL editor — the "+" button opens the key browser instead
  // when the active connection is Redis (see the button below).
  const activeConnIsRedis = isRedisEngine(connections.find((c) => c.id === activeConnectionId)?.engine || '');

  // Pending close action awaiting confirmation — only set when the action
  // would discard at least one SQL editor tab's typed content.
  const [confirmClose, setConfirmClose] = useState<{ kind: 'single' | 'right' | 'all' | 'other'; tabId?: string; count: number } | null>(null);

  const requestCloseTab = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab && hasUnclosedSql(tab)) {
      setConfirmClose({ kind: 'single', tabId, count: 1 });
    } else {
      closeTab(tabId);
    }
  };

  const requestCloseTabsToRight = (tabId: string) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    const count = idx >= 0 ? tabs.slice(idx + 1).filter(hasUnclosedSql).length : 0;
    if (count > 0) {
      setConfirmClose({ kind: 'right', tabId, count });
    } else {
      closeTabsToRight(tabId);
    }
  };

  const requestCloseOtherTabs = (tabId: string) => {
    const count = tabs.filter((t) => t.id !== tabId && hasUnclosedSql(t)).length;
    if (count > 0) {
      setConfirmClose({ kind: 'other', tabId, count });
    } else {
      closeOtherTabs(tabId);
    }
  };

  const requestCloseAllTabs = () => {
    const count = tabs.filter(hasUnclosedSql).length;
    if (count > 0) {
      setConfirmClose({ kind: 'all', count });
    } else {
      closeAllTabs();
    }
  };

  const handleOpenSqlFile = async () => {
    try {
      const file = await pickAndReadSqlFile();
      if (!file) return; // dialog cancelled
      openSqlTab(file.name, file.content, undefined, undefined, file.path);
    } catch (err: any) {
      pushToast({ severity: 'error', title: 'Could not open SQL file', message: err?.message || String(err) });
    }
  };

  const [tabContextMenu, setTabContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    tabId: string;
  } | null>(null);

  // Drag-and-drop tab reposition state — `draggedId` is the tab being moved,
  // `dragOverId` the tab currently under the pointer (drives the drop-target
  // indicator). Both clear on drop/dragend.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    const handleCloseMenu = () => setTabContextMenu(null);
    window.addEventListener('click', handleCloseMenu);
    return () => window.removeEventListener('click', handleCloseMenu);
  }, []);

  return (
    <div className="h-9 bg-[#06090e] border-b border-[#1e293b] flex items-center justify-between px-2 shrink-0 select-none overflow-x-auto">
      {/* Tabs List */}
      <div className="flex items-center gap-1 flex-1 overflow-x-auto no-scrollbar">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isTableData = tab.tabType === 'table_data';

          return (
            <div
              key={tab.id}
              draggable
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setActiveTab(tab.id);
                setTabContextMenu({ mouseX: e.clientX, mouseY: e.clientY, tabId: tab.id });
              }}
              onDragStart={(e) => {
                setDraggedId(tab.id);
                e.dataTransfer.effectAllowed = 'move';
                // Firefox requires data to be set for the drag to start.
                e.dataTransfer.setData('text/plain', tab.id);
              }}
              onDragOver={(e) => {
                if (!draggedId || draggedId === tab.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOverId !== tab.id) setDragOverId(tab.id);
              }}
              onDragLeave={() => {
                setDragOverId((cur) => (cur === tab.id ? null : cur));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedId && draggedId !== tab.id) reorderTabs(draggedId, tab.id);
                setDraggedId(null);
                setDragOverId(null);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverId(null);
              }}
              className={`group h-7 px-3 rounded-t-lg text-xs font-medium flex items-center gap-2 border-t border-x cursor-grab active:cursor-grabbing transition-all shrink-0 max-w-[200px] ${
                isActive
                  ? 'bg-[#0a0f18] border-[#1e293b] text-slate-100 font-semibold'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#0f172a]/50'
              } ${draggedId === tab.id ? 'opacity-40' : ''} ${
                dragOverId === tab.id && draggedId !== tab.id ? 'border-l-2 border-l-cyan-400' : ''
              }`}
            >
              {isTableData ? (
                <TableIcon className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              ) : tab.tabType === 'erd' ? (
                <GitFork className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              ) : tab.tabType === 'storage_browser' ? (
                <Cloud className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              ) : tab.tabType === 'redis_browser' ? (
                <Key className="w-3.5 h-3.5 text-red-400 shrink-0" />
              ) : tab.tabType === 'mongo_documents' ? (
                <FileJson className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <FileCode className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              )}

              <span className="truncate flex-1">{tab.title}</span>

              {tab.isDirty && (
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
              )}

              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    requestCloseTab(tab.id);
                  }}
                  className="p-0.5 rounded hover:bg-[#1e293b] text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        <button
          onClick={() => (activeConnIsRedis && activeConnectionId ? openRedisBrowserTab(activeConnectionId) : openSqlTab())}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#141e33] transition-colors ml-1"
          title={activeConnIsRedis ? 'Browse Redis Keys' : 'New SQL Editor'}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleOpenSqlFile}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#141e33] transition-colors"
          title="Open SQL File... (Cmd/Ctrl+O)"
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tab Right-Click Context Menu */}
      {tabContextMenu && (
        <div
          style={{ top: tabContextMenu.mouseY, left: tabContextMenu.mouseX }}
          className="fixed z-50 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl w-52 py-1.5 text-xs text-slate-200 select-none font-sans"
        >
          <button
            onClick={() => {
              requestCloseTab(tabContextMenu.tabId);
              setTabContextMenu(null);
            }}
            disabled={tabs.length <= 1}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <X className="w-3.5 h-3.5" />
            <span>Close Tab</span>
          </button>

          <button
            onClick={() => {
              requestCloseTabsToRight(tabContextMenu.tabId);
              setTabContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300"
          >
            <ChevronsRight className="w-3.5 h-3.5" />
            <span>Close Tabs to the Right</span>
          </button>

          <button
            onClick={() => {
              requestCloseOtherTabs(tabContextMenu.tabId);
              setTabContextMenu(null);
            }}
            disabled={tabs.length <= 1}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-slate-300 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <XCircle className="w-3.5 h-3.5" />
            <span>Close Other Tabs</span>
          </button>

          <div className="h-px bg-[#1e293b] my-1" />

          <button
            onClick={() => {
              requestCloseAllTabs();
              setTabContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 font-medium text-red-400"
          >
            <XCircle className="w-3.5 h-3.5" />
            <span>Close All Tabs</span>
          </button>
        </div>
      )}

      {/* Confirm before discarding typed-but-unrun SQL. */}
      {confirmClose && (
        <ConfirmDialog
          title={
            confirmClose.kind === 'all'
              ? 'Close All Tabs?'
              : confirmClose.kind === 'right'
                ? 'Close Tabs to the Right?'
                : confirmClose.kind === 'other'
                  ? 'Close Other Tabs?'
                  : 'Close SQL Editor Tab?'
          }
          message={
            confirmClose.kind === 'single'
              ? 'This tab has SQL typed in it that hasn’t been saved elsewhere. Closing it will discard that text — it cannot be recovered.'
              : `${confirmClose.count} tab${confirmClose.count === 1 ? '' : 's'} about to close ${confirmClose.count === 1 ? 'has' : 'have'} SQL typed in but not saved elsewhere. Closing will discard that text — it cannot be recovered.`
          }
          confirmLabel="Close"
          tone="warning"
          onConfirm={() => {
            if (confirmClose.kind === 'single' && confirmClose.tabId) closeTab(confirmClose.tabId);
            else if (confirmClose.kind === 'right' && confirmClose.tabId) closeTabsToRight(confirmClose.tabId);
            else if (confirmClose.kind === 'other' && confirmClose.tabId) closeOtherTabs(confirmClose.tabId);
            else if (confirmClose.kind === 'all') closeAllTabs();
            setConfirmClose(null);
          }}
          onClose={() => setConfirmClose(null)}
        />
      )}
    </div>
  );
};
