import React, { useState } from 'react';
import { X, Database, Loader2, CheckCircle2, AlertTriangle, Link2 } from 'lucide-react';
import { DatabaseConnection } from '../../core/domain/types';
import { safeInvoke } from '../../core/tauri/ipc';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { quoteIdent } from '../../core/sql/ident';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';

interface CreateDatabaseModalProps {
  connection: DatabaseConnection;
  onClose: () => void;
  onCreated?: () => void;
  /** Postgres can't browse a different database from the same connection —
   *  offer to open a prefilled "new connection" pointed at the freshly
   *  created database instead. */
  onOpenConnectionFor?: (dbName: string) => void;
}

const MYSQL_CHARSETS = [
  { value: 'utf8mb4', label: 'utf8mb4 — Unicode (recommended)' },
  { value: 'utf8mb3', label: 'utf8mb3 — Unicode (legacy, 3-byte)' },
  { value: 'latin1', label: 'latin1 — Western European' },
  { value: 'ascii', label: 'ascii — US-ASCII' },
  { value: 'utf16', label: 'utf16 — Unicode (UTF-16)' },
  { value: 'utf32', label: 'utf32 — Unicode (UTF-32)' },
  { value: 'cp1251', label: 'cp1251 — Cyrillic' },
  { value: 'greek', label: 'greek — ISO 8859-7' },
  { value: 'hebrew', label: 'hebrew — ISO 8859-8' },
  { value: 'sjis', label: 'sjis — Shift-JIS' },
  { value: 'ujis', label: 'ujis — EUC-JP' },
  { value: 'gbk', label: 'gbk — Simplified Chinese' },
  { value: 'big5', label: 'big5 — Traditional Chinese' },
  { value: 'euckr', label: 'euckr — Korean' },
];

export const CreateDatabaseModal: React.FC<CreateDatabaseModalProps> = ({
  connection,
  onClose,
  onCreated,
  onOpenConnectionFor,
}) => {
  useEscapeToClose(onClose);
  const [name, setName] = useState('');
  const [charset, setCharset] = useState('utf8mb4');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const unsupported = connection.engine === 'sqlite' || connection.engine === 'duckdb';
  const isPostgres = connection.engine === 'postgres';

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a database name.');
      return;
    }
    setRunning(true);
    setError(null);

    let sql = `CREATE DATABASE ${quoteIdent(connection.engine, trimmed)}`;
    if (connection.engine === 'mysql' && charset.trim()) {
      sql += ` CHARACTER SET ${charset.trim()}`;
    }
    sql += ';';

    try {
      await safeInvoke('execute_query', {
        request: { config: connection, sql },
        queryId: `create_db_${Date.now()}`,
        __meta: { source: 'database' },
      });
      setSuccess(true);
      onCreated?.();
    } catch (err: any) {
      const msg = err?.message || String(err);
      setError(msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[420px] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl text-slate-200 font-sans text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 border-b border-[#1e293b] bg-[#06090e] px-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <Database className="w-3.5 h-3.5 text-blue-400" />
            <span>Create Database</span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <div className="text-[11px] text-slate-400">
            On connection <span className="text-slate-200 font-semibold">{connection.name}</span>
          </div>

          {unsupported ? (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{connection.engine === 'sqlite' ? 'SQLite' : 'DuckDB'} connections are single-file databases — there's no server-level "create database" for this engine.</span>
            </div>
          ) : success ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px]">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>Database "{name.trim()}" created.</span>
              </div>
              {isPostgres ? (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[11px]">
                  <Link2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    PostgreSQL can't browse another database from this same connection — add a connection pointed at
                    "{name.trim()}" to explore it.
                  </span>
                </div>
              ) : (
                <div className="text-[11px] text-slate-400">It'll appear in the connection tree.</div>
              )}
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Database Name
                </label>
                <input
                  autoFocus
                  type="text"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="my_new_database"
                  className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono"
                />
              </div>

              {connection.engine === 'mysql' && (
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    Character Set <span className="text-slate-500 font-normal normal-case">(optional)</span>
                  </label>
                  <select
                    value={charset}
                    onChange={(e) => setCharset(e.target.value)}
                    className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="">(use server default)</option>
                    {MYSQL_CHARSETS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {error && (
                <CopyableErrorBanner message={error} tone="red" compact />
              )}
            </>
          )}
        </div>

        <div className="h-12 border-t border-[#1e293b] px-3 flex items-center justify-end gap-2 bg-[#06090e]">
          {success ? (
            <>
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#263447] text-slate-200 text-xs font-semibold transition-colors"
              >
                Close
              </button>
              {isPostgres && onOpenConnectionFor && (
                <button
                  onClick={() => onOpenConnectionFor(name.trim())}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  Add Connection to It
                </button>
              )}
            </>
          ) : unsupported ? (
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#263447] text-slate-200 text-xs font-semibold transition-colors"
            >
              Close
            </button>
          ) : (
            <>
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
                Create
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
