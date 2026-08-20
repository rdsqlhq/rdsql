import React, { useState } from 'react';
import { X, Table as TableIcon, Loader2, Plus, Trash2, Sparkles } from 'lucide-react';
import { DatabaseConnection } from '../../core/domain/types';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import { quoteIdent, qualifiedTable, resolveTargetDatabase } from '../../core/sql/ident';
import { getGroupedTypeOptions, getTypeOptions, isEnumType } from '../../core/sql/dataTypes';
import { EnumValuesInput } from './EnumValuesInput';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { useSettingsStore } from '../../store/useSettingsStore';
import { generateSQL } from '../../core/ai/client';
import { AIError, isAIConfigured } from '../../core/ai/types';

interface CreateTableModalProps {
  connection: DatabaseConnection;
  schemaName?: string;
  onClose: () => void;
  onCreated: (tableName: string) => void;
}

interface ColDef {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}

/** Strip surrounding `"..."` / `` `...` `` / `[...]` quoting from a single identifier. */
function unquoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === '`' && last === '`') || (first === '[' && last === ']')) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Best-effort parse of a `CREATE TABLE name (...);` statement's column list
 * into `ColDef`s, for the AI-suggested-columns feature. Not a real SQL
 * parser — handles the common shapes models actually produce (column lines,
 * a trailing table-level `PRIMARY KEY (...)`) and returns `null` if it can't
 * make sense of the body, so the caller can fall back to an error message
 * rather than silently populating garbage.
 */
export function parseColumnsFromCreateTable(sql: string): ColDef[] | null {
  const openIdx = sql.indexOf('(');
  const closeIdx = sql.lastIndexOf(')');
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) return null;
  const body = sql.slice(openIdx + 1, closeIdx);

  // Split on top-level commas only — types like DECIMAL(10,2) have commas
  // that must NOT split the column definition in two.
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  const pkNames = new Set<string>();
  const parsed: { name: string; type: string; nullable: boolean }[] = [];

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const upper = part.toUpperCase();

    // Table-level constraint lines — not a column. Pull PK column names out
    // of PRIMARY KEY (...), skip everything else (FK/UNIQUE/CHECK/INDEX).
    if (/^(PRIMARY\s+KEY|CONSTRAINT|FOREIGN\s+KEY|UNIQUE|INDEX|KEY\s)/i.test(part)) {
      const pkMatch = part.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (pkMatch) {
        pkMatch[1].split(',').forEach((c) => pkNames.add(unquoteIdent(c)));
      }
      continue;
    }

    const identMatch = part.match(/^("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_]\w*)\s+([\s\S]+)$/);
    if (!identMatch) continue;
    const name = unquoteIdent(identMatch[1]);
    const rest = identMatch[2].trim();
    const restUpper = rest.toUpperCase();
    if (restUpper.includes('PRIMARY KEY')) pkNames.add(name);
    const typeMatch = rest.match(/^([A-Za-z_]\w*(?:\([^)]*\))?(?:\s+PRECISION|\s+VARYING)?)/i);
    const type = (typeMatch ? typeMatch[1] : rest.split(/\s+/)[0]).trim();
    parsed.push({ name, type, nullable: !restUpper.includes('NOT NULL') });
  }

  if (parsed.length === 0) return null;
  return parsed.map((c, i) => ({
    id: `ai_${Date.now()}_${i}`,
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    pk: pkNames.has(c.name),
  }));
}

export const CreateTableModal: React.FC<CreateTableModalProps> = ({
  connection,
  schemaName,
  onClose,
  onCreated,
}) => {
  useEscapeToClose(onClose);
  const [name, setName] = useState('');
  const [cols, setCols] = useState<ColDef[]>([
    { id: 'c1', name: 'id', type: 'bigint', nullable: false, pk: true },
  ]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const ai = useSettingsStore((s) => s.ai);

  const engine = connection.engine;

  const handleAiSuggest = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (!isAIConfigured(ai)) {
      setAiError('Set up the AI Assistant (provider + API key) in Settings first.');
      return;
    }
    setAiError(null);
    setAiSuggesting(true);
    try {
      const result = await generateSQL(ai, {
        prompt:
          `Suggest a complete, sensible CREATE TABLE statement for a table named "${trimmedName}". ` +
          'Infer likely columns from the table name (e.g. a "users" table gets name/email, an "orders" table gets a customer reference and amount). ' +
          'Include an appropriate primary key column and NOT NULL where it makes sense. Keep it to commonly-useful columns — do not over-engineer.',
        schemaContext: '',
        engine,
      });
      const parsed = parseColumnsFromCreateTable(result.sql);
      if (!parsed || parsed.length === 0) {
        setAiError("Couldn't parse a column list from the AI's response — try again or add columns manually.");
        return;
      }
      setCols(parsed);
    } catch (err: any) {
      setAiError(err instanceof AIError ? err.message : err?.message || String(err));
    } finally {
      setAiSuggesting(false);
    }
  };

  const updateCol = (id: string, patch: Partial<ColDef>) => {
    setCols((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };
  const addCol = () => {
    setCols((prev) => [
      ...prev,
      { id: `c_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: '', type: 'varchar(255)', nullable: true, pk: false },
    ]);
  };
  const removeCol = (id: string) => {
    setCols((prev) => prev.filter((c) => c.id !== id));
  };

  const buildSql = (): string | null => {
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    const valid = cols.filter((c) => c.name.trim());
    if (valid.length === 0) return null;

    const colLines = valid.map((c) => {
      const ident = quoteIdent(engine, c.name.trim());
      let line = `  ${ident} ${c.type}`;
      if (!c.nullable) line += ' NOT NULL';
      return line;
    });

    const pks = valid.filter((c) => c.pk).map((c) => quoteIdent(engine, c.name.trim()));
    if (pks.length > 0) colLines.push(`  PRIMARY KEY (${pks.join(', ')})`);

    const tbl = qualifiedTable(engine, trimmedName, schemaName);
    return `CREATE TABLE ${tbl} (\n${colLines.join(',\n')}\n);`;
  };

  const handleCreate = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Enter a table name.');
      return;
    }
    if (cols.filter((c) => c.name.trim()).length === 0) {
      setError('Add at least one column.');
      return;
    }
    const dupNames = cols
      .map((c) => c.name.trim().toLowerCase())
      .filter((n, i, arr) => n && arr.indexOf(n) !== i);
    if (dupNames.length > 0) {
      setError(`Duplicate column name: ${dupNames[0]}`);
      return;
    }

    const sql = buildSql();
    if (!sql) {
      setError('Could not build the CREATE TABLE statement.');
      return;
    }

    setRunning(true);
    try {
      // For MySQL/SQL Server the group is a whole database, not part of the
      // SQL text (see qualifiedTable) — point the connection at it instead.
      const execConnection: DatabaseConnection = {
        ...connection,
        database: resolveTargetDatabase(engine, connection.database, schemaName) ?? connection.database,
      };
      await safeInvoke('execute_query', {
        request: { config: execConnection, sql },
        queryId: `create_table_${Date.now()}`,
        __meta: { source: 'ddl' },
      });
      onCreated(trimmedName);
    } catch (err: any) {
      const msg = err?.message || String(err);
      setError(msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-[560px] max-h-[90vh] flex flex-col bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl text-slate-200 font-sans text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 shrink-0 border-b border-[#1e293b] bg-[#06090e] px-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <TableIcon className="w-3.5 h-3.5 text-cyan-400" />
            <span>
              Create Table
              <span className="text-slate-500 font-normal ml-2">
                in {schemaName ? `${schemaName}` : connection.database || connection.name}
              </span>
            </span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3 overflow-y-auto">
          <div>
            <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
              Table Name
            </label>
            <div className="flex gap-1.5">
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addCol()}
                placeholder="e.g. customers, order_items"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="flex-1 min-w-0 h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono"
              />
              <button
                type="button"
                onClick={handleAiSuggest}
                disabled={!name.trim() || aiSuggesting}
                title="Ask AI to suggest columns for this table name"
                className="shrink-0 px-2.5 h-8 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 disabled:opacity-40 disabled:cursor-not-allowed text-violet-300 flex items-center gap-1.5 text-[11px] font-semibold transition-colors"
              >
                {aiSuggesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                AI Suggest
              </button>
            </div>
            {aiError && (
              <p className="text-[10px] text-amber-400 mt-1">{aiError}</p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Columns
              </label>
              <button
                onClick={addCol}
                className="px-2 py-0.5 rounded bg-blue-600/20 text-blue-300 hover:bg-blue-600/30 flex items-center gap-1 text-[10.5px] font-semibold transition-colors"
              >
                <Plus className="w-3 h-3" /> Add Column
              </button>
            </div>

            <div className="border border-[#1e293b] rounded-lg overflow-hidden">
              <div className="grid grid-cols-[1fr_1.1fr_auto_auto_auto] gap-2 px-2 py-1.5 bg-[#0f172a] text-[9.5px] uppercase tracking-wider text-slate-500 font-semibold">
                <span>Name</span>
                <span>Type</span>
                <span className="text-center w-9">Null</span>
                <span className="text-center w-9">PK</span>
                <span className="w-7" />
              </div>
              <div className="max-h-56 overflow-y-auto">
                {cols.map((c) => (
                  <React.Fragment key={c.id}>
                  <div
                    className="grid grid-cols-[1fr_1.1fr_auto_auto_auto] gap-2 px-2 py-1.5 items-center border-t border-[#1e293b]/50"
                  >
                    <input
                      type="text"
                      value={c.name}
                      onChange={(e) => updateCol(c.id, { name: e.target.value })}
                      placeholder="column_name"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-7 box-border bg-[#06090e] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-[11px] text-slate-100 focus:outline-none font-mono"
                    />
                    <select
                      value={c.type}
                      onChange={(e) => updateCol(c.id, { type: e.target.value })}
                      className="h-7 box-border bg-[#06090e] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-[11px] text-slate-100 focus:outline-none"
                    >
                      {getGroupedTypeOptions(engine).map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.types.map((t) => (
                            <option key={t.label} value={t.label}>
                              {t.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      {/* Include the current value if it's not in the standard list */}
                      {!getTypeOptions(engine).includes(c.type) && (
                        <option value={c.type}>{c.type}</option>
                      )}
                    </select>
                    <label className="w-9 flex justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={c.nullable}
                        onChange={(e) => updateCol(c.id, { nullable: e.target.checked })}
                      />
                    </label>
                    <label className="w-9 flex justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={c.pk}
                        onChange={(e) => updateCol(c.id, { pk: e.target.checked })}
                      />
                    </label>
                    <button
                      onClick={() => removeCol(c.id)}
                      disabled={cols.length === 1}
                      className="w-7 h-7 flex items-center justify-center rounded hover:bg-[#1e293b] text-slate-500 hover:text-red-400 disabled:opacity-30 transition-colors"
                      title="Remove column"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  {isEnumType(c.type) && (
                    <div className="px-2 pb-1.5 -mt-1 border-t-0">
                      <EnumValuesInput
                        value={/^enum\s*\((.*)\)\s*$/i.exec(c.type)?.[1] ?? ''}
                        onChange={(inner) => updateCol(c.id, { type: `enum(${inner})` })}
                        className="w-full h-7 box-border bg-[#06090e] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-[11px] text-slate-100 focus:outline-none font-mono"
                      />
                    </div>
                  )}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>

          {error && (
            <CopyableErrorBanner message={error} tone="red" compact parseAsDbError />
          )}
        </div>

        <div className="h-12 shrink-0 border-t border-[#1e293b] px-3 flex items-center justify-end gap-2 bg-[#06090e]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#263447] text-slate-200 text-xs font-semibold transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={running || !name.trim()}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            {running && <Loader2 className="w-3 h-3 animate-spin" />}
            Create Table
          </button>
        </div>
      </div>
    </div>
  );
};
