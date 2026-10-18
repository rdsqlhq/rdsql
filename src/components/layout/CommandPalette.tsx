import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Terminal, Table as TableIcon, Server, FileCode, CornerDownLeft } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useTabStore } from '../../store/useTabStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useToastStore } from '../../store/useToastStore';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { pickAndReadSqlFile } from '../../core/sql/loadSqlFile';
import { checkForUpdateAndNotify } from '../../core/updater';
import { isMongoEngine, isRedisEngine } from '../../core/connection/engines';
import { CLOSE_ACTIVE_TAB_EVENT } from './EditorTabs';

interface PaletteItem {
  id: string;
  group: 'Commands' | 'Tabs' | 'Connections' | 'Tables' | 'SQL';
  label: string;
  detail?: string;
  shortcut?: string;
  run: () => void;
}

const GROUP_ICON: Record<PaletteItem['group'], React.ComponentType<{ className?: string }>> = {
  Commands: Terminal,
  Tabs: FileCode,
  Connections: Server,
  Tables: TableIcon,
  SQL: FileCode,
};

const SQL_START = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|SHOW|EXPLAIN|DESCRIBE|PRAGMA|CALL|EXEC)\b/i;
const MAX_RESULTS = 60;
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** Subsequence match score: higher is better, -1 means no match. Consecutive
 *  letters and matches at word starts score more. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) return 1000 - direct;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    score += found === prev + 1 ? 5 : 1;
    if (found === 0 || /[\s._-]/.test(t[found - 1])) score += 3;
    prev = found;
    ti = found + 1;
  }
  return score;
}

/** ⌘K / Ctrl+K: run any command, jump to an open tab, open a connection or a
 *  table, or paste SQL to open it in a new editor tab. */
export const CommandPalette: React.FC = () => {
  const open = useWorkspaceStore((s) => s.isCommandPaletteOpen);
  const setOpen = useWorkspaceStore((s) => s.setCommandPaletteOpen);

  // Global shortcut. Capture phase so the SQL editor (Monaco) doesn't swallow
  // it; the ERD canvas keeps Cmd+K for its own table search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k' || e.shiftKey || e.altKey) return;
      const { tabs, activeTabId } = useTabStore.getState();
      const onErd =
        useWorkspaceStore.getState().activeView === 'explorer' &&
        tabs.find((t) => t.id === activeTabId)?.tabType === 'erd';
      if (onErd) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(!useWorkspaceStore.getState().isCommandPaletteOpen);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setOpen]);

  if (!open) return null;
  return createPortal(<PaletteDialog onClose={() => setOpen(false)} />, document.body);
};

const PaletteDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  useEscapeToClose(onClose);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const ws = useWorkspaceStore();
  const { tabs, setActiveTab, openSqlTab, openTableDataTab } = useTabStore();
  const { connections, schemaTreeByConn, setActiveConnection, setConnectionModalOpen } = useConnectionStore();
  const pushToast = useToastStore((s) => s.push);

  const items = useMemo<PaletteItem[]>(() => {
    const toExplorer = () => ws.setActiveView('explorer');
    const commands: PaletteItem[] = [
      { id: 'new-sql', group: 'Commands', label: 'New SQL query', shortcut: `${MOD}T`, run: () => { toExplorer(); openSqlTab(); } },
      {
        id: 'open-file',
        group: 'Commands',
        label: 'Open SQL file…',
        shortcut: `${MOD}O`,
        run: () => {
          void pickAndReadSqlFile()
            .then((file) => {
              if (!file) return;
              toExplorer();
              openSqlTab(file.name, file.content, undefined, undefined, file.path);
            })
            .catch((err: any) => pushToast({ severity: 'error', title: 'Could not open SQL file', message: err?.message || String(err) }));
        },
      },
      { id: 'new-conn', group: 'Commands', label: 'New connection…', shortcut: `${MOD}N`, run: () => setConnectionModalOpen(true) },
      { id: 'close-tab', group: 'Commands', label: 'Close tab', shortcut: `${MOD}W`, run: () => window.dispatchEvent(new Event(CLOSE_ACTIVE_TAB_EVENT)) },
      { id: 'settings', group: 'Commands', label: 'Settings', run: () => ws.setSettingsModalOpen(true) },
      { id: 'ai', group: 'Commands', label: 'Toggle AI assistant', run: () => ws.toggleAIPanel() },
      { id: 'sidebar', group: 'Commands', label: 'Toggle explorer sidebar', run: () => ws.toggleSidebar() },
      { id: 'output', group: 'Commands', label: 'Toggle output panel', run: () => ws.toggleOutputConsole() },
      { id: 'compare', group: 'Commands', label: 'Compare & sync databases', run: () => ws.setActiveView('migration') },
      { id: 'migrate', group: 'Commands', label: 'Migrate database', run: () => ws.setActiveView('pgMigrate') },
      { id: 'health', group: 'Commands', label: 'Database health', run: () => ws.setActiveView('health') },
      { id: 'integrations', group: 'Commands', label: 'Drivers & integrations', run: () => ws.setActiveView('integrations') },
      { id: 'export-enc', group: 'Commands', label: 'Export encrypted connections…', run: () => ws.openEncryptedConnectionsModal('export') },
      { id: 'import-enc', group: 'Commands', label: 'Import encrypted connections…', run: () => ws.openEncryptedConnectionsModal('import') },
      { id: 'updates', group: 'Commands', label: 'Check for updates', run: () => void checkForUpdateAndNotify(false) },
      { id: 'about', group: 'Commands', label: 'About rdSQL', run: () => ws.setAboutModalOpen(true) },
    ];

    const tabItems: PaletteItem[] = tabs.map((t) => ({
      id: `tab-${t.id}`,
      group: 'Tabs',
      label: t.title,
      detail: 'Open tab',
      run: () => { toExplorer(); setActiveTab(t.id); },
    }));

    const connItems: PaletteItem[] = connections
      .filter((c) => !isRedisEngine(c.engine) && !isMongoEngine(c.engine))
      .map((c) => ({
        id: `conn-${c.id}`,
        group: 'Connections',
        label: c.name,
        detail: `New SQL query · ${c.engine}${c.database ? ` · ${c.database}` : ''}`,
        run: () => {
          toExplorer();
          setActiveConnection(c.id);
          openSqlTab(undefined, undefined, c.id);
        },
      }));

    const tableItems: PaletteItem[] = [];
    for (const c of connections) {
      if (isRedisEngine(c.engine) || isMongoEngine(c.engine)) continue;
      for (const group of schemaTreeByConn[c.id] ?? []) {
        for (const t of group.children) {
          if (t.node_type === 'collection') continue;
          tableItems.push({
            id: `table-${c.id}-${group.name}-${t.name}`,
            group: 'Tables',
            label: `${group.name}.${t.name}`,
            detail: `${t.node_type === 'view' ? 'View' : 'Table'} · ${c.name}`,
            run: () => {
              toExplorer();
              setActiveConnection(c.id);
              openTableDataTab(t.name, group.name, c.id);
            },
          });
        }
      }
    }
    return [...commands, ...tabItems, ...connItems, ...tableItems];
  }, [ws, tabs, connections, schemaTreeByConn, openSqlTab, openTableDataTab, setActiveTab, setActiveConnection, setConnectionModalOpen, pushToast]);

  const results = useMemo(() => {
    const q = query.trim();
    const sqlItem: PaletteItem[] = SQL_START.test(q)
      ? [{
          id: 'sql',
          group: 'SQL',
          label: q.length > 80 ? `${q.slice(0, 80)}…` : q,
          detail: 'Open in a new SQL tab',
          run: () => { ws.setActiveView('explorer'); openSqlTab(undefined, q); },
        }]
      : [];
    if (!q) return items.filter((i) => i.group === 'Commands' || i.group === 'Tabs').slice(0, MAX_RESULTS);
    const scored = items
      .map((item) => ({ item, score: fuzzyScore(q, item.label) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((r) => r.item);
    return [...sqlItem, ...scored];
  }, [items, query, ws, openSqlTab]);

  useEffect(() => setHighlight(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(results[highlight]);
    }
  };

  return (
    <div className="fixed inset-0 z-[150] bg-black/50 flex justify-center pt-[12vh]" onClick={onClose}>
      <div
        className="w-[600px] max-w-[calc(100vw-32px)] h-fit max-h-[70vh] flex flex-col bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-[#1e293b]">
          <Search className="w-4 h-4 text-slate-500 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command, table or connection, or paste SQL…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 bg-transparent py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
          />
        </div>
        <div ref={listRef} className="overflow-y-auto py-1">
          {results.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-500">No matches.</div>}
          {results.map((item, i) => {
            const Icon = GROUP_ICON[item.group];
            const active = i === highlight;
            return (
              <button
                key={item.id}
                data-index={i}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => runItem(item)}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs ${active ? 'bg-blue-600/20 text-slate-100' : 'text-slate-300'}`}
              >
                <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span className="truncate font-medium">{item.label}</span>
                {item.detail && <span className="truncate text-slate-500">{item.detail}</span>}
                <span className="ml-auto flex items-center gap-2 shrink-0 text-[10px] text-slate-500">
                  {item.shortcut && <kbd className="px-1.5 py-0.5 rounded bg-[#1e293b] font-mono">{item.shortcut}</kbd>}
                  {active && <CornerDownLeft className="w-3 h-3" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
