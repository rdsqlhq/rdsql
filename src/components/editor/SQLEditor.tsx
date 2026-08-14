import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNS, languages as MonacoLanguagesNS } from 'monaco-editor';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
  Play,
  Square,
  Database,
  ChevronDown,
  Code2,
  History as HistoryIcon,
  Wand2,
  Server,
  RefreshCw,
  Sparkles,
  Save as SaveIcon,
} from 'lucide-react';
import { useTabStore } from '../../store/useTabStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useQueryLogStore } from '../../store/useQueryStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useToastStore } from '../../store/useToastStore';
import { describeFsError } from '../../core/utils/fsErrors';
import { isAIConfigured } from '../../core/ai/types';
import {
  SQL_KEYWORDS,
  SQL_SNIPPETS,
  buildSchemaSuggestions,
  tablesInScope,
  qualifiedTokenBeforeDot,
} from '../../core/sql/completion';
import { formatSql } from '../../core/sql/format';

interface SQLEditorProps {
  tabId: string;
}

type MonacoNS = typeof import('monaco-editor');

// The SQL completion provider reads live schema data from this shared ref,
// which the active editor keeps updated. Registering the provider once — not
// on every editor mount — prevents the duplicate suggestions that accumulate
// when each tab registers its own.
//
// The ref + disposable live on `globalThis` (not module scope) so they
// SURVIVE Vite HMR module reloads. Without this, every code edit during dev
// created a new module instance with a fresh null disposable, leaving the
// previous provider registered → N stacked providers → N×duplicates.
const G = globalThis as unknown as {
  __rdsqlSchemaRef?: { current: ReturnType<typeof buildSchemaSuggestions> };
  __rdsqlCompletionDisposable?: { dispose: () => void };
};
if (!G.__rdsqlSchemaRef) G.__rdsqlSchemaRef = { current: buildSchemaSuggestions([]) };
const sharedSchemaRef = G.__rdsqlSchemaRef!;

/** Register our SQL completion provider on a Monaco instance exactly once.
 *  Idempotent + safe under React StrictMode / HMR: any previous registration
 *  is disposed before re-registering so there is never more than one active
 *  provider contributing suggestions. */
function ensureCompletionProvider(monaco: MonacoNS) {
  if (G.__rdsqlCompletionDisposable) {
    try {
      G.__rdsqlCompletionDisposable.dispose();
    } catch {
      // Already disposed (e.g. monaco torn down) — ignore.
    }
    G.__rdsqlCompletionDisposable = undefined;
  }

  G.__rdsqlCompletionDisposable = monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const textUntil = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const afterDot = /\.\s*$/.test(textUntil.slice(-2));
      const dotPath = qualifiedTokenBeforeDot(textUntil);
      const scoped = tablesInScope(textUntil);
      const seen = new Set<string>();
      const sugg = sharedSchemaRef.current;

      const push = (item: MonacoLanguagesNS.CompletionItem) => {
        // `label` may be a string or a CompletionItemLabel object; normalise
        // to a string key so duplicates (e.g. a table present in several
        // schemas) collapse to one entry.
        const key = typeof item.label === 'string' ? item.label : item.label.label;
        if (seen.has(key)) return;
        seen.add(key);
        suggestions.push(item);
      };
      const suggestions: MonacoLanguagesNS.CompletionItem[] = [];

      // Context-aware dot completion. The path before the dot is either
      // ["table"] or ["schema", "table"] (or ["db"] for the first segment).
      // We NEVER mix in tables from other schemas here — a dot means the user
      // has already chosen a scope, so we return only what lives under it.
      if (afterDot && dotPath) {
        // Two segments: "schema.table." → columns of THAT table only.
        if (dotPath.length === 2) {
          const key = `${dotPath[0].toLowerCase()}.${dotPath[1].toLowerCase()}`;
          const cols = sugg.columnsByDbTable.get(key) || [];
          for (const col of cols) {
            push({
              label: col,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col,
              detail: `column · ${dotPath[0]}.${dotPath[1]}`,
              range,
            } as MonacoLanguagesNS.CompletionItem);
          }
          return { suggestions };
        }

        // One segment. It could be a database/schema (→ its tables) or a
        // table (→ its columns). Table wins so an unqualified single-segment
        // table still gets columns.
        const tok = dotPath[0].toLowerCase();
        const tokDisplay = dotPath[0];
        // Table? → columns.
        if (sugg.columnsByTable.has(tok)) {
          const cols = sugg.columnsByTable.get(tok) || [];
          for (const col of cols) {
            push({
              label: col,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col,
              detail: `column · ${tokDisplay}`,
              range,
            } as MonacoLanguagesNS.CompletionItem);
          }
          return { suggestions };
        }
        // Database/schema? → its tables.
        if (sugg.tablesByDatabase.has(tok)) {
          const tbls = sugg.tablesByDatabase.get(tok) || [];
          for (const tname of tbls) {
            push({
              label: tname,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: tname,
              detail: `table · ${tokDisplay}`,
              range,
            } as MonacoLanguagesNS.CompletionItem);
          }
          return { suggestions };
        }
        // Unknown token before the dot — return nothing schema-related so we
        // don't pollute the list with tables from other databases. Keywords
        // are still useful (e.g. typing an alias), so keep those.
        for (const kw of SQL_KEYWORDS) {
          push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            detail: 'keyword',
            range,
          } as MonacoLanguagesNS.CompletionItem);
        }
        return { suggestions };
      }

      // No-dot context. Offer columns of tables in the FROM/JOIN clauses,
      // plus keywords, snippets, databases/schemas, and tables. Everything is
      // deduped by label so a table present in multiple schemas appears once.
      if (scoped.length) {
        for (const tname of scoped) {
          const cols = sugg.columnsByTable.get(tname.toLowerCase()) || [];
          for (const col of cols) {
            push({
              label: col,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col,
              detail: `column · ${tname}`,
              range,
            } as MonacoLanguagesNS.CompletionItem);
          }
        }
      }

      for (const kw of SQL_KEYWORDS) {
        push({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw,
          detail: 'keyword',
          range,
        } as MonacoLanguagesNS.CompletionItem);
      }

      for (const snip of SQL_SNIPPETS) {
        push({
          label: snip.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snip.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: snip.detail,
          documentation: snip.insertText,
          range,
        } as MonacoLanguagesNS.CompletionItem);
      }

      for (const db of sugg.databases) {
        push({
          label: db,
          kind: monaco.languages.CompletionItemKind.Module,
          insertText: db,
          detail: 'database/schema',
          range,
        } as MonacoLanguagesNS.CompletionItem);
      }

      for (const t of sugg.tables) {
        push({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: t.name,
          detail: t.schema ? `table · ${t.schema}` : 'table',
          range,
        } as MonacoLanguagesNS.CompletionItem);
      }

      return { suggestions };
    },
  });
}

export const SQLEditor: React.FC<SQLEditorProps> = ({ tabId }) => {
  const { tabs, updateTabSql, executeQuery, stopQuery, setTabConnection, setTabSchema, setTabFilePath } =
    useTabStore();
  const pushToast = useToastStore((s) => s.push);
  const {
    connections,
    activeConnectionId,
    setActiveConnection,
    activeDatabaseByConn,
    setActiveDatabase,
    schemaTreeByConn,
    fetchSchema,
  } = useConnectionStore();
  const { logs } = useQueryLogStore();
  const ai = useSettingsStore((s) => s.ai);
  const aiReady = isAIConfigured(ai);
  const { zoomLevel, setAIPanelOpen, isAIPanelOpen } = useWorkspaceStore();

  const tab = tabs.find((t) => t.id === tabId);
  // Resolve the connection from the tab's own binding so each editor runs
  // against the server it was opened on, regardless of the global selection.
  const activeConn = connections.find(
    (c) => c.id === (tab?.connectionId ?? activeConnectionId)
  );
  const activeDb =
    tab?.schemaName ||
    (activeConn && activeDatabaseByConn[activeConn.id]) ||
    activeConn?.database;

  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoNS | null>(null);
  const [snippetMenuOpen, setSnippetMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [connMenuOpen, setConnMenuOpen] = useState(false);
  const [dbMenuOpen, setDbMenuOpen] = useState(false);

  // Schema for THIS tab's connection comes from the shared per-connection
  // cache in the store (populated by the Explorer, so editor and Explorer
  // always agree). If the cache is empty for this connection we fetch once
  // and write it back so the Explorer picks it up too.
  const connTree = (activeConn && schemaTreeByConn[activeConn.id]) || [];
  const [loadingTree, setLoadingTree] = useState(false);

  const refreshSchema = React.useCallback(
    (connId: string) => {
      setLoadingTree(true);
      fetchSchema(connId).finally(() => setLoadingTree(false));
    },
    [fetchSchema]
  );

  // When the tab's connection changes, use the cached tree if present,
  // otherwise fetch it into the shared cache.
  useEffect(() => {
    if (!activeConn) return;
    if (!schemaTreeByConn[activeConn.id]) {
      refreshSchema(activeConn.id);
    }
  }, [activeConn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the module-level sharedSchemaRef updated with this editor's schema so
  // the single globally-registered completion provider reads live data.
  const schemaSuggestions = useMemo(() => buildSchemaSuggestions(connTree), [connTree]);
  useEffect(() => {
    sharedSchemaRef.current = schemaSuggestions;
  }, [schemaSuggestions]);

  // Sync Monaco's font size with the global zoom level so the editor scales
  // together with the rest of the UI (webview zoom doesn't reach Monaco).
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: Math.round(13 * zoomLevel) });
  }, [zoomLevel]);

  const running = !!tab?.executing;

  // Switching connection from the toolbar rebinds the tab and primes the
  // global active connection (so the Explorer follows along) + its schema.
  const handlePickConnection = (connId: string) => {
    setConnMenuOpen(false);
    if (!connId || connId === activeConn?.id) return;
    setTabConnection(tabId, connId);
    setActiveConnection(connId);
  };

  // Picking a database/schema from the toolbar binds it to the tab. For
  // MySQL/MariaDB this becomes the target database; for Postgres it's the
  // schema used to qualify identifiers (the connection DB stays as configured).
  const handlePickDatabase = (dbName?: string) => {
    setDbMenuOpen(false);
    if (!activeConn) return;
    setTabSchema(tabId, dbName);
    if (dbName) setActiveDatabase(activeConn.id, dbName);
  };

  const runSelectionOrAll = () => {
    if (!tabId || running) return;
    const ed = editorRef.current;
    let override: string | undefined;
    if (ed) {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (sel && model && !sel.isEmpty()) {
        override = model.getValueInRange(sel);
      }
    }
    // Prevent empty queries from executing — check both the override (selected
    // text) and the full editor content.
    const sqlToRun = (override ?? tab?.sql ?? '').trim();
    if (!sqlToRun) return;
    executeQuery(tabId, override);
  };

  const insertAtCursor = (text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelection();
    ed.executeEdits('snippet', [{ range: sel ?? ed.getModel()!.getFullModelRange(), text, forceMoveMarkers: true }]);
    ed.focus();
  };

  // Beautify the selection if there is one, otherwise the whole buffer.
  const formatSelectionOrAll = () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    const sel = ed.getSelection();
    const targetRange = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
    const raw = model.getValueInRange(targetRange);
    const formatted = formatSql(raw);
    ed.pushUndoStop();
    ed.executeEdits('format', [{ range: targetRange, text: formatted, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
  };

  // AI Improve/Fix lives entirely in the assistant panel now (opened via the
  // "Ask AI" toolbar button) — the inline `handleImproveSql` was removed when
  // the toolbar's separate "Improve" button was consolidated into "Ask AI".

  const [saving, setSaving] = useState(false);

  // Prompts the native Save dialog and writes there, then binds the tab to
  // that path (so the next plain Save writes back to it directly) and renames
  // the tab to the file's name. Reads the live buffer via the Monaco model —
  // not the `tab` closure — since `handleSaveAs`/`handleSave` are registered
  // once as editor commands (Ctrl/Cmd+S) and must stay correct for edits made
  // long after that registration ran.
  const saveAs = async (sql: string) => {
    const current = useTabStore.getState().tabs.find((t) => t.id === tabId);
    const defaultName = current?.filePath
      ? current.filePath.split(/[\\/]/).pop()
      : `${(current?.title || 'query').replace(/\.sql$/i, '')}.sql`;
    const path = await save({
      title: 'Save SQL File',
      defaultPath: defaultName,
      filters: [{ name: 'SQL', extensions: ['sql'] }],
    });
    if (!path) return; // user cancelled
    await writeTextFile(path, sql);
    const base = path.split(/[\\/]/).pop() || path;
    setTabFilePath(tabId, path, base.replace(/\.\w+$/, ''));
    pushToast({ severity: 'success', title: 'Saved', message: path });
  };

  /** Smart save: writes straight back to the tab's bound file path, or falls
   *  back to Save As when the tab has never been saved (e.g. a fresh query,
   *  not one opened from disk). */
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const sql = editorRef.current?.getValue() ?? tab?.sql ?? '';
      const current = useTabStore.getState().tabs.find((t) => t.id === tabId);
      if (current?.filePath) {
        await writeTextFile(current.filePath, sql);
        pushToast({ severity: 'success', title: 'Saved', message: current.filePath });
      } else {
        await saveAs(sql);
      }
    } catch (err: any) {
      pushToast({ severity: 'error', title: 'Could not save file', message: describeFsError(err, 'write') });
    } finally {
      setSaving(false);
    }
  };

  /** Always prompts for a new location, even when the tab already has a
   *  bound file path. */
  const handleSaveAs = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const sql = editorRef.current?.getValue() ?? tab?.sql ?? '';
      await saveAs(sql);
    } catch (err: any) {
      pushToast({ severity: 'error', title: 'Could not save file', message: describeFsError(err, 'write') });
    } finally {
      setSaving(false);
    }
  };

  const beforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco as MonacoNS;
    // Minimal extra config: keep the built-in SQL language; we only add a
    // completion provider in onMount so it can read live schema data.
  };

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco as MonacoNS;

    // Ctrl/Cmd+Enter runs the selection (or whole buffer).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runSelectionOrAll);

    // Ctrl/Cmd+S saves — to the tab's bound file if it has one, else prompts
    // Save As. Also overrides the browser/OS "Save Page" shortcut.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void handleSave(); });

    // Right-click "Format SQL" (also Ctrl/Cmd+Shift+F). Formats the selection,
    // or the whole buffer when nothing is selected.
    editor.addAction({
      id: 'format-sql',
      label: 'Format SQL',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
      contextMenuGroupId: 'rdsql',
      contextMenuOrder: 1,
      run: () => formatSelectionOrAll(),
    });

    // Register our SQL completion provider exactly once per Monaco instance.
    // It reads live schema data from the module-level sharedSchemaRef, which
    // this component keeps updated below. Registering once (not per-mount)
    // avoids the duplicate suggestions that stacked up across editor mounts.
    ensureCompletionProvider(monaco as MonacoNS);
  };

  // When the tab id changes (switching tabs), sync the editor value from the
  // store so Monaco shows the right buffer. We deliberately do NOT push every
  // keystroke back through setValue — that would reset undo/redo history.
  const lastSyncedTab = useRef<string | null>(null);
  useEffect(() => {
    if (lastSyncedTab.current === tabId) return;
    lastSyncedTab.current = tabId;
    const ed = editorRef.current;
    if (ed && tab && ed.getValue() !== tab.sql) {
      ed.setValue(tab.sql || '');
    }
  }, [tabId, tab]);

  if (!tab) return null;

  const handleEditorChange = (value?: string) => {
    if (value !== undefined) {
      updateTabSql(tabId, value);
    }
  };

  const recentSuccess = logs.filter((l) => l.status === 'success').slice(-12).reverse();

  return (
    <div className="w-full h-full flex flex-col bg-[#06090e]">
      {/* Toolbar */}
      <div className="h-10 shrink-0 border-b border-[#1e293b] px-3 bg-[#0a0f18] flex items-center justify-between gap-2 shadow-sm shadow-black/20 z-10 relative overflow-x-auto">
        <div className="flex items-center gap-2 flex-nowrap shrink-0">
          <button
            onClick={runSelectionOrAll}
            disabled={running || !(tab?.sql ?? '').trim()}
            title="Run (Ctrl/Cmd+Enter) — runs the selection if any, else the whole buffer"
            className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50 shadow-md shadow-emerald-600/30 whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5 shrink-0 fill-current" />
            Run
          </button>
          <button
            onClick={() => stopQuery(tabId)}
            disabled={!running}
            title="Stop the running query"
            className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 active:bg-red-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-40 shadow-md shadow-red-600/20 disabled:shadow-none whitespace-nowrap shrink-0"
          >
            <Square className="w-3.5 h-3.5 shrink-0 fill-current" />
            Stop
          </button>

          <div className="h-5 w-px bg-[#1e293b] mx-1" />

          {/* Save — writes to the tab's bound file, or prompts Save As for a
              tab that's never been saved to disk. Long-press-free Save As is
              a separate small button so both stay one click away. */}
          <button
            onClick={handleSave}
            disabled={saving}
            title={tab?.filePath ? `Save (Ctrl/Cmd+S) — ${tab.filePath}` : 'Save (Ctrl/Cmd+S) — choose a file'}
            className="px-2 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <SaveIcon className={`w-3.5 h-3.5 shrink-0 ${saving ? 'animate-pulse' : ''}`} />
            Save
          </button>
          <button
            onClick={handleSaveAs}
            disabled={saving}
            title="Save As — always choose a new file"
            className="px-1.5 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-slate-400 hover:text-white text-[10px] font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            As…
          </button>

          <div className="h-5 w-px bg-[#1e293b] mx-1" />

          {/* Format SQL */}
          <button
            onClick={formatSelectionOrAll}
            className="px-2 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            title="Format SQL (Ctrl/Cmd+Shift+F) — selection or whole buffer"
          >
            <Wand2 className="w-3.5 h-3.5 shrink-0" />
            Format
          </button>

          {/* Ask AI — the single AI entry point on the editor. Opens the
              assistant panel so the user can describe what they want in plain
              language (e.g. "create an event that runs when a customer adds a
              product") and have SQL drafted against the live schema, then
              inserted back into this editor. Covers generate + improve + fix
              via the same chat. Hidden when no provider is configured. */}
          {aiReady && (
            <button
              onClick={() => setAIPanelOpen(!isAIPanelOpen)}
              className={`px-2 py-1 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                isAIPanelOpen
                  ? 'bg-violet-600/30 border-violet-500/50 text-violet-100'
                  : 'bg-violet-600/15 hover:bg-violet-600/25 border-violet-500/30 text-violet-300 hover:text-violet-200'
              }`}
              title="Ask AI — open the assistant panel to draft, improve, or fix this SQL in plain language"
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              Ask AI
            </button>
          )}

          {/* Refresh schema (re-fetch the connection's tables/columns so
              autocomplete reflects newly created/dropped objects). */}
          <button
            onClick={() => activeConn && refreshSchema(activeConn.id)}
            disabled={!activeConn || loadingTree}
            className="p-1.5 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-slate-300 hover:text-white text-xs font-semibold flex items-center justify-center transition-colors disabled:opacity-40 disabled:hover:bg-[#141e33] disabled:hover:text-slate-300"
            title="Refresh schema for autocomplete"
          >
            <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${loadingTree ? 'animate-spin text-cyan-400' : ''}`} />
          </button>

          <div className="h-5 w-px bg-[#1e293b] mx-1" />

          {/* Snippets dropdown */}
          <div className="relative">
            <button
              onClick={() => {
                setSnippetMenuOpen((v) => !v);
                setHistoryOpen(false);
              }}
              className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                snippetMenuOpen ? 'bg-[#1e293b] text-white' : 'bg-[#141e33] hover:bg-[#1e293b] text-slate-300 hover:text-white'
              }`}
              title="Insert a SQL snippet"
            >
              <Code2 className="w-3.5 h-3.5 shrink-0" />
              Snippets
              <ChevronDown className={`w-3 h-3 shrink-0 opacity-70 transition-transform duration-150 ${snippetMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {snippetMenuOpen && (
              <div className="absolute z-[70] mt-1 left-0 w-56 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1 text-xs">
                {SQL_SNIPPETS.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => {
                      insertAtCursor(s.insertText);
                      setSnippetMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex flex-col"
                  >
                    <span className="text-slate-200 font-mono">{s.label}</span>
                    <span className="text-[10px] text-slate-500">{s.detail}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* History dropdown */}
          <div className="relative">
            <button
              onClick={() => {
                setHistoryOpen((v) => !v);
                setSnippetMenuOpen(false);
              }}
              className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                historyOpen ? 'bg-[#1e293b] text-white' : 'bg-[#141e33] hover:bg-[#1e293b] text-slate-300 hover:text-white'
              }`}
              title="Recent successful queries"
            >
              <HistoryIcon className="w-3.5 h-3.5 shrink-0" />
              History
              <ChevronDown className={`w-3 h-3 shrink-0 opacity-70 transition-transform duration-150 ${historyOpen ? 'rotate-180' : ''}`} />
            </button>
            {historyOpen && (
              <div className="absolute z-[70] mt-1 left-0 w-[420px] max-h-80 overflow-y-auto bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1 text-xs">
                {recentSuccess.length === 0 ? (
                  <div className="px-3 py-2 text-slate-500 italic">No successful queries yet.</div>
                ) : (
                  recentSuccess.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => {
                        insertAtCursor(l.sql);
                        setHistoryOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex flex-col gap-0.5"
                      title="Insert into editor"
                    >
                      <span className="text-slate-300 font-mono truncate">{l.sql}</span>
                      <span className="text-[10px] text-slate-500">
                        {l.database} · {l.durationMs}ms · {l.rowsAffected} rows · {l.executedAt}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Connection + database pickers */}
        <div className="flex items-center gap-1.5 flex-nowrap shrink-0">
          {/* Connection dropdown */}
          <div className="relative">
            <button
              onClick={() => {
                setConnMenuOpen((v) => !v);
                setDbMenuOpen(false);
                setSnippetMenuOpen(false);
                setHistoryOpen(false);
              }}
              className={`px-2 py-1 rounded-lg text-[11px] font-mono flex items-center gap-1.5 transition-colors max-w-[180px] ${
                connMenuOpen ? 'bg-[#1e293b] text-white ring-1 ring-blue-500/30' : 'bg-[#141e33] hover:bg-[#1e293b] text-slate-300'
              }`}
              title="Select connection"
            >
              <Server className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span className="truncate">{activeConn?.name ?? 'no connection'}</span>
              <ChevronDown className={`w-3 h-3 opacity-70 shrink-0 transition-transform duration-150 ${connMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {connMenuOpen && (
              <>
                {/* z-[60]/z-[70] (not the default Tailwind z-30/z-40 scale) —
                    Monaco's own overlay layers (suggest widget, parameter
                    hints, etc.) reach z-index values in that range and were
                    covering this dropdown; matches the z-[60]+ convention
                    already used for Explorer's context menu / ApplyChangesModal. */}
                <div className="fixed inset-0 z-[60]" onClick={() => setConnMenuOpen(false)} />
                <div className="absolute z-[70] mt-1 right-0 w-64 max-h-80 overflow-y-auto bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1 text-xs">
                  {connections.length === 0 ? (
                    <div className="px-3 py-2 text-slate-500 italic">No connections configured.</div>
                  ) : (
                    connections.map((c) => {
                      const selected = c.id === activeConn?.id;
                      return (
                        <button
                          key={c.id}
                          onClick={() => handlePickConnection(c.id)}
                          className={`w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 ${
                            selected ? 'text-cyan-400' : 'text-slate-200'
                          }`}
                        >
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: c.colorTag || '#64748b' }}
                          />
                          <div className="min-w-0 flex flex-col">
                            <span className="font-mono truncate">{c.name}</span>
                            <span className="text-[10px] text-slate-500 uppercase">
                              {c.engine}
                              {c.database ? ` · ${c.database}` : ''}
                            </span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>

          {/* Database / schema dropdown */}
          <div className="relative">
            <button
              onClick={() => {
                setDbMenuOpen((v) => !v);
                setConnMenuOpen(false);
                setSnippetMenuOpen(false);
                setHistoryOpen(false);
              }}
              disabled={!activeConn}
              className={`px-2 py-1 rounded-lg text-[11px] font-mono flex items-center gap-1.5 transition-colors max-w-[180px] disabled:opacity-40 disabled:cursor-not-allowed ${
                dbMenuOpen ? 'bg-[#1e293b] text-white ring-1 ring-cyan-500/30' : 'bg-[#141e33] hover:bg-[#1e293b] text-slate-300'
              }`}
              title={
                activeConn?.engine === 'postgres'
                  ? 'Select schema'
                  : 'Select database'
              }
            >
              <Database className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className={`truncate ${activeDb ? '' : 'text-slate-500 italic'}`}>
                {activeDb ?? 'no database'}
              </span>
              <ChevronDown className={`w-3 h-3 opacity-70 shrink-0 transition-transform duration-150 ${dbMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {dbMenuOpen && (
              <>
                <div className="fixed inset-0 z-[60]" onClick={() => setDbMenuOpen(false)} />
                <div className="absolute z-[70] mt-1 right-0 w-60 max-h-80 overflow-y-auto bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1 text-xs">
                  {loadingTree ? (
                    <div className="px-3 py-2 text-slate-500 italic">Loading…</div>
                  ) : connTree.length === 0 ? (
                    <div className="px-3 py-2 text-slate-500 italic">No databases found.</div>
                  ) : (
                    <>
                      {/* Default = the connection's configured database / no schema override */}
                      <button
                        onClick={() => handlePickDatabase(undefined)}
                        className={`w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 ${
                          !tab?.schemaName ? 'text-cyan-400' : 'text-slate-300'
                        }`}
                      >
                        <Database className="w-3 h-3 opacity-60 shrink-0" />
                        <span className="font-mono truncate">
                          {activeConn?.database || 'default'}
                        </span>
                        <span className="ml-auto text-[10px] text-slate-500">default</span>
                      </button>
                      {connTree.map((g) => {
                        const selected = tab?.schemaName === g.name;
                        return (
                          <button
                            key={g.name}
                            onClick={() => handlePickDatabase(g.name)}
                            className={`w-full text-left px-3 py-1.5 hover:bg-[#141e33] flex items-center gap-2 ${
                              selected ? 'text-cyan-400' : 'text-slate-200'
                            }`}
                          >
                            <Database className="w-3 h-3 opacity-60 shrink-0" />
                            <span className="font-mono truncate">{g.name}</span>
                            <span className="ml-auto text-[10px] text-slate-500 uppercase">
                              {g.node_type}
                            </span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 relative">
        <Editor
          height="100%"
          defaultLanguage="sql"
          theme="vs-dark"
          value={tab.sql}
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={handleEditorChange}
          options={{
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            padding: { top: 8 },
            suggestOnTriggerCharacters: true,
            quickSuggestions: { other: true, comments: false, strings: true },
            // Turn OFF Monaco's built-in word-based + language suggestions so
            // only OUR completion provider (keywords, snippets, schema) ever
            // surfaces. Without this the built-in SQL keyword provider stacks
            // a second copy of every keyword on top of ours.
            wordBasedSuggestions: 'off',
            suggest: { showWords: false },
          }}
        />
      </div>
    </div>
  );
};
