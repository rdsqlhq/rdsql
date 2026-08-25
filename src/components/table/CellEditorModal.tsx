import React, { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { X, Check, AlignLeft, Braces, Eraser, ListChecks, Link2 } from 'lucide-react';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { RelationCellInput } from './RelationCellInput';
import type { RelationTarget } from './relationHelpers';
import type { DatabaseConnection } from '../../core/domain/types';

interface CellEditorModalProps {
  columnName: string;
  dataType?: string;
  /** True when the column is a JSON/object/array type — enables JSON tools. */
  isJson: boolean;
  /** Postgres enum column's allowed labels — renders a dropdown of real
   *  values (Navicat-style) instead of a free-text/Monaco box. */
  enumValues?: string[] | null;
  /** Foreign-key column → renders the same searchable autocomplete the
   *  inline editor uses, instead of a free-text/Monaco box. Both this and
   *  `relationConnection` must be present for the picker to render. */
  relation?: RelationTarget;
  relationConnection?: DatabaseConnection;
  /** Current cell value as a string (or null for SQL NULL). */
  value: string | null;
  onClose: () => void;
  /** Called with the new value. Empty string becomes NULL on commit. */
  onSave: (value: string | null) => void;
}

/**
 * Full-screen modal editor for a single cell, used when a value is too long
 * to edit comfortably inline or when the column holds JSON that benefits from
 * formatting + validation. Uses Monaco editor for syntax highlighting,
 * minimap, and code editing features. For JSON columns it offers one-click
 * "Format" / "Minify" and live validation.
 */
export const CellEditorModal: React.FC<CellEditorModalProps> = ({
  columnName,
  dataType,
  isJson,
  enumValues,
  relation,
  relationConnection,
  value,
  onClose,
  onSave,
}) => {
  const isEnum = !!enumValues && enumValues.length > 0;
  const isRelation = !isEnum && !!relation && !!relationConnection;
  const [draft, setDraft] = useState(value ?? '');
  const [error, setError] = useState<string | null>(null);
  // Always open in editable mode. Even when the cell is currently NULL we show
  // an empty editor so the user can start typing immediately — the NULL toggle
  // button is still available for explicitly setting NULL. (Previously a NULL
  // cell opened with the editor hidden behind a non-editable message, forcing
  // the user to toggle NULL off before they could type anything.)
  const [isNull, setIsNull] = useState(false);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  // Keep latest values in refs so Monaco command callbacks (registered once on
  // mount) always read the current state instead of a stale closure.
  const draftRef = useRef(draft);
  const isNullRef = useRef(isNull);
  const onSaveRef = useRef(onSave);
  const onCloseRef = useRef(onClose);
  draftRef.current = draft;
  isNullRef.current = isNull;
  onSaveRef.current = onSave;
  onCloseRef.current = onClose;

  // Validate JSON live as the user types (only for JSON columns).
  useEffect(() => {
    if (!isJson || isNull) {
      setError(null);
      return;
    }
    const trimmed = draft.trim();
    if (trimmed === '') {
      setError(null);
      return;
    }
    try {
      JSON.parse(trimmed);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Invalid JSON');
    }
  }, [draft, isJson, isNull]);

  const handleFormat = () => {
    if (!isJson) return;
    try {
      const parsed = JSON.parse(draft.trim() || '{}');
      const formatted = JSON.stringify(parsed, null, 2);
      setDraft(formatted);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Cannot format — invalid JSON');
    }
  };

  const handleMinify = () => {
    if (!isJson) return;
    try {
      const parsed = JSON.parse(draft.trim() || '{}');
      const minified = JSON.stringify(parsed);
      setDraft(minified);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Cannot minify — invalid JSON');
    }
  };

  const handleSave = () => {
    if (isNullRef.current) {
      onSaveRef.current(null);
    } else {
      const currentVal = editorRef.current?.getValue() ?? draftRef.current;
      onSaveRef.current(currentVal);
    }
    onCloseRef.current();
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    // Explicitly push the initial value into the editor on mount — Monaco's
    // controlled `value` prop can miss the first paint. Always push, even when
    // empty, so the editor reliably initializes as editable.
    editor.setValue(draftRef.current);
    // Move cursor to end so typing appends rather than overwrites.
    const model = editor.getModel();
    if (model) {
      const lastLine = model.getLineCount();
      editor.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) });
    }
    // Ctrl/Cmd+Enter saves, Escape closes — wired through Monaco so it
    // captures keystrokes before the editor's own handlers. Callbacks read
    // from refs so they always see the latest state.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handleSave());
    editor.addCommand(monaco.KeyCode.Escape, () => onCloseRef.current());
    editor.focus();
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-[#1e293b] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            {isJson ? (
              <Braces className="w-4 h-4 text-amber-400" />
            ) : isEnum ? (
              <ListChecks className="w-4 h-4 text-purple-400" />
            ) : isRelation ? (
              <Link2 className="w-4 h-4 text-cyan-500" />
            ) : (
              <AlignLeft className="w-4 h-4 text-cyan-400" />
            )}
            <span className="font-bold text-sm text-slate-100">{columnName}</span>
            {dataType && (
              <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#141e33]">
                {dataType}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="px-4 py-2 border-b border-[#1e293b] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1.5">
            {isJson && !isNull && (
              <>
                <button
                  onClick={handleFormat}
                  className="px-2 py-1 rounded text-[11px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-amber-400 flex items-center gap-1 transition-colors"
                  title="Pretty-print JSON"
                >
                  <Braces className="w-3 h-3" />
                  Format
                </button>
                <button
                  onClick={handleMinify}
                  className="px-2 py-1 rounded text-[11px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-400 flex items-center gap-1 transition-colors"
                  title="Minify JSON"
                >
                  Minify
                </button>
              </>
            )}
            <button
              onClick={() => {
                setDraft('');
                setIsNull(true);
                setError(null);
              }}
              className={`px-2 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-colors ${
                isNull
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                  : 'bg-[#141e33] hover:bg-[#1e293b] text-slate-400'
              }`}
              title="Set value to NULL"
            >
              <Eraser className="w-3 h-3" />
              NULL
            </button>
          </div>

          {error && (
            <div className="max-w-[340px]">
              <CopyableErrorBanner message={error} tone="red" compact />
            </div>
          )}
          {!error && isJson && !isNull && draft.trim() && (
            <span className="text-[10px] text-emerald-400 font-mono">✓ Valid JSON</span>
          )}
        </div>

        {/* Editor — a native dropdown for enum/relation columns (Navicat-
            style: pick from the actual allowed/related values instead of
            typing free text a user could get wrong), Monaco for everything
            else. Enter/Ctrl+Enter save and Escape cancels either way, to
            match Monaco's own keybindings registered in handleMount. */}
        <div className="overflow-hidden relative h-[55vh] shrink-0">
          {isNull ? (
            <div className="flex items-center justify-center h-full text-slate-600 italic text-xs">
              Value is NULL — toggle NULL off to edit
            </div>
          ) : isEnum ? (
            <div className="p-4">
              <select
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onClose();
                  else if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
                }}
                className="w-full h-9 box-border bg-[#0f172a] border border-blue-500 rounded px-2.5 text-sm text-slate-100 focus:outline-none font-mono"
              >
                <option value="">NULL</option>
                {enumValues!.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          ) : isRelation ? (
            <div className="p-4">
              <RelationCellInput
                connection={relationConnection!}
                targetTable={relation!.table}
                targetSchemaName={relation!.schemaName}
                targetPkColumn={relation!.pkColumn}
                targetLabelColumn={relation!.labelColumn ?? null}
                value={draft}
                onChange={setDraft}
                onSelect={setDraft}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onClose();
                  else if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
                }}
                className="w-full h-9 box-border flex items-center bg-[#0f172a] border border-blue-500 rounded px-2.5 text-sm text-slate-100 font-mono"
              />
            </div>
          ) : (
            <Editor
              height="100%"
              defaultLanguage={isJson ? 'json' : 'plaintext'}
              theme="vs-dark"
              value={draft}
              onMount={handleMount}
              onChange={(val) => setDraft(val ?? '')}
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
                wrappingIndent: 'indent',
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-[#1e293b] flex items-center justify-between shrink-0 bg-[#06090e]">
          <span className="text-[10px] text-slate-600">
            {isNull ? 'NULL value' : `${draft.length.toLocaleString()} characters`}
            <span className="ml-2 text-slate-700">⌘/Ctrl+Enter to save · Esc to cancel</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-400 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!!error}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center gap-1.5 transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
