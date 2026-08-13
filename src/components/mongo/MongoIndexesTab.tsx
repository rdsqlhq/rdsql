import React, { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, KeyRound } from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { ConfirmDialog } from '../common/ConfirmDialog';
import type { DatabaseConnection } from '../../core/domain/types';
import type { MongoIndexInfo } from '../../core/mongo/types';

interface Props {
  connection: DatabaseConnection;
  database: string;
  collectionName: string;
}

const fieldClass =
  'w-full bg-[#0f172a] border border-[#1e293b] focus:border-emerald-500 rounded px-2 py-1.5 text-[11px] font-mono text-slate-100 focus:outline-none';

function keysLabel(keys: Record<string, number>): string {
  return Object.entries(keys)
    .map(([field, dir]) => `${field} ${dir === -1 ? 'DESC' : 'ASC'}`)
    .join(', ');
}

/** Index management: list existing indexes, create a new one (field spec as
 *  JSON, e.g. `{"email": 1}` or a compound `{"createdAt": -1, "status": 1}`),
 *  and drop one (never the mandatory `_id_` index — MongoDB itself refuses
 *  that anyway, but hiding the option avoids a confusing round-trip error). */
export const MongoIndexesTab: React.FC<Props> = ({ connection, database, collectionName }) => {
  const [indexes, setIndexes] = useState<MongoIndexInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [keysInput, setKeysInput] = useState('{ "field": 1 }');
  const [nameInput, setNameInput] = useState('');
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropBusy, setDropBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await safeInvoke<MongoIndexInfo[]>('mongo_list_indexes', {
        config: connection,
        database,
        collectionName,
      });
      setIndexes(result);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, database, collectionName]);

  const createIndex = async () => {
    let keys: unknown;
    try {
      keys = JSON.parse(keysInput);
    } catch (err: any) {
      setCreateError(err?.message || 'Invalid JSON');
      return;
    }
    setCreatingBusy(true);
    setCreateError(null);
    try {
      await safeInvoke('mongo_create_index', {
        config: connection,
        database,
        collectionName,
        keys,
        name: nameInput.trim() || undefined,
        unique: unique || undefined,
        sparse: sparse || undefined,
      });
      setCreating(false);
      setKeysInput('{ "field": 1 }');
      setNameInput('');
      setUnique(false);
      setSparse(false);
      await load();
    } catch (err: any) {
      setCreateError(err?.message || String(err));
    } finally {
      setCreatingBusy(false);
    }
  };

  const dropIndex = async () => {
    if (!dropTarget) return;
    setDropBusy(true);
    try {
      await safeInvoke('mongo_drop_index', { config: connection, database, collectionName, indexName: dropTarget });
      await load();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setDropBusy(false);
      setDropTarget(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-slate-500">
          {indexes.length} index{indexes.length === 1 ? '' : 'es'}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-300 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Create Index
          </button>
        </div>
      </div>

      {error && <CopyableErrorBanner message={error} parseAsDbError />}

      {creating && (
        <div className="mb-4 p-3 border border-[#1e293b] rounded-lg bg-[#0a0f18]/60 space-y-2.5">
          <div>
            <label className="block text-[9.5px] uppercase tracking-wider text-slate-500 mb-0.5">
              Fields (1 = ascending, -1 = descending)
            </label>
            <input
              value={keysInput}
              onChange={(e) => setKeysInput(e.target.value)}
              className={`${fieldClass}`}
              placeholder='{ "email": 1 }'
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[9.5px] uppercase tracking-wider text-slate-500 mb-0.5">
                Name (optional)
              </label>
              <input value={nameInput} onChange={(e) => setNameInput(e.target.value)} className={fieldClass} />
            </div>
            <div className="flex items-end gap-3 pb-1.5">
              <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} className="accent-emerald-500" />
                Unique
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                <input type="checkbox" checked={sparse} onChange={(e) => setSparse(e.target.checked)} className="accent-emerald-500" />
                Sparse
              </label>
            </div>
          </div>
          {createError && <div className="text-[10px] text-red-400">{createError}</div>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="px-2.5 py-1 rounded text-[11px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-400 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={createIndex}
              disabled={creatingBusy}
              className="px-2.5 py-1 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white transition-colors"
            >
              Create
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {indexes.map((idx) => (
          <div
            key={idx.name}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-[#1e293b] bg-[#0a0f18]/40"
          >
            <KeyRound className="w-3.5 h-3.5 text-amber-500/70 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-mono font-semibold text-slate-200 truncate">{idx.name}</div>
              <div className="text-[10px] font-mono text-slate-500 truncate">{keysLabel(idx.keys)}</div>
            </div>
            {idx.unique && <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 font-semibold shrink-0">unique</span>}
            {idx.sparse && <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 font-semibold shrink-0">sparse</span>}
            {idx.name !== '_id_' && (
              <button
                type="button"
                onClick={() => setDropTarget(idx.name)}
                className="p-1 rounded hover:bg-red-500/10 text-slate-500 hover:text-red-400 transition-colors shrink-0"
                title="Drop index"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {dropTarget && (
        <ConfirmDialog
          title="Drop index"
          message={`This drops the index "${dropTarget}". Queries relying on it may slow down. This cannot be undone.`}
          confirmLabel="Drop Index"
          tone="danger"
          loading={dropBusy}
          onConfirm={dropIndex}
          onClose={() => setDropTarget(null)}
        />
      )}
    </div>
  );
};
