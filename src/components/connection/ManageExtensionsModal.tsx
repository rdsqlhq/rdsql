import React, { useEffect, useState } from 'react';
import { X, Puzzle, Loader2, Download, Trash2, Search } from 'lucide-react';
import { DatabaseConnection } from '../../core/domain/types';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import {
  fetchAvailableExtensions,
  createExtensionSql,
  dropExtensionSql,
  AvailableExtension,
} from '../../core/sql/extensionIntrospection';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';

interface ManageExtensionsModalProps {
  connection: DatabaseConnection;
  onClose: () => void;
  /** Called after a successful install/uninstall so the caller can refresh the
   *  Explorer's Extensions folder. */
  onChanged?: () => void;
}

/** Postgres extension manager — lists every extension available on the server
 *  (`pg_available_extensions`) with one-click Install / Uninstall per row, plus
 *  a search box. Opened from the Extensions folder's context menu and the
 *  connection context menu. */
export const ManageExtensionsModal: React.FC<ManageExtensionsModalProps> = ({ connection, onClose, onChanged }) => {
  useEscapeToClose(onClose);
  const [items, setItems] = useState<AvailableExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchAvailableExtensions(connection, connection.engine)
      .then((rows) => setItems(rows))
      .catch((err: any) => setError(err?.message || String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (name: string, sql: string) => {
    setError(null);
    setPending(name);
    try {
      await safeInvoke('execute_query', {
        request: { config: connection, sql },
        queryId: `ext_manage_${name}_${Date.now()}`,
        __meta: { source: 'ddl' },
      });
      // Flip the row's installed flag locally + notify the caller.
      setItems((prev) => prev.map((e) => (e.name === name ? { ...e, installed: sql.startsWith('CREATE') } : e)));
      onChanged?.();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setPending(null);
    }
  };

  const filtered = items.filter(
    (e) => !query || e.name.toLowerCase().includes(query.toLowerCase()) || e.comment.toLowerCase().includes(query.toLowerCase())
  );
  const installedCount = items.filter((e) => e.installed).length;

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-[640px] max-h-[80vh] flex flex-col bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl text-slate-200 font-sans text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 shrink-0 border-b border-[#1e293b] bg-[#06090e] px-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <Puzzle className="w-3.5 h-3.5 text-fuchsia-400" />
            <span>
              Manage Extensions
              <span className="text-slate-500 font-normal ml-2">{connection.name}</span>
            </span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-3 py-2 border-b border-[#1e293b] flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-600 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search extensions…"
              spellCheck={false}
              className="w-full h-7 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded pl-7 pr-2 text-xs text-slate-100 focus:outline-none"
            />
          </div>
          <span className="text-[10.5px] text-slate-500 shrink-0">
            {installedCount} installed · {items.length} available
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-slate-500 py-10">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-slate-600 italic py-10 text-center">No extensions match.</div>
          ) : (
            filtered.map((ext) => (
              <div
                key={ext.name}
                className="flex items-center gap-2 px-3 py-1.5 border-b border-[#1e293b]/40 hover:bg-[#0f172a] transition-colors"
              >
                <Puzzle className={`w-3.5 h-3.5 shrink-0 ${ext.installed ? 'text-fuchsia-400' : 'text-slate-600'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-200 truncate">{ext.name}</span>
                    <span className="text-[9.5px] text-slate-600 font-mono shrink-0">{ext.defaultVersion}</span>
                    {ext.installed && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300 shrink-0 uppercase">installed</span>
                    )}
                  </div>
                  {ext.comment && (
                    <div className="text-[10.5px] text-slate-500 truncate">{ext.comment}</div>
                  )}
                </div>
                {ext.installed ? (
                  <button
                    onClick={() => run(ext.name, dropExtensionSql(ext.name))}
                    disabled={pending === ext.name || ext.name === 'plpgsql'}
                    className="shrink-0 px-2 py-1 rounded text-[10.5px] font-semibold flex items-center gap-1 bg-red-600/15 hover:bg-red-600/25 border border-red-600/30 text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
                    title={ext.name === 'plpgsql' ? 'plpgsql cannot be removed' : 'Uninstall'}
                  >
                    <Trash2 className="w-3 h-3" />
                    Uninstall
                  </button>
                ) : (
                  <button
                    onClick={() => run(ext.name, createExtensionSql(ext.name))}
                    disabled={pending === ext.name}
                    className="shrink-0 px-2 py-1 rounded text-[10.5px] font-semibold flex items-center gap-1 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-600/30 text-emerald-300 disabled:opacity-40"
                  >
                    {pending === ext.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                    Install
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {error && (
          <div className="px-3 py-2 border-t border-[#1e293b]">
            <CopyableErrorBanner message={error} tone="red" compact />
          </div>
        )}
      </div>
    </div>
  );
};
