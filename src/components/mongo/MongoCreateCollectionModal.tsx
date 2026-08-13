import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import type { DatabaseConnection } from '../../core/domain/types';

interface Props {
  connection: DatabaseConnection;
  database: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}

/** Explicit collection creation — not required by MongoDB (writing to a
 *  collection that doesn't exist creates it implicitly), but useful for
 *  starting an empty collection before inserting anything, matching what
 *  every SQL engine's "New Table" already offers in this app. */
export const MongoCreateCollectionModal: React.FC<Props> = ({ connection, database, onClose, onCreated }) => {
  useEscapeToClose(onClose);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      await safeInvoke('mongo_create_collection', { config: connection, database, collectionName: trimmed });
      onCreated(trimmed);
      onClose();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <Plus className="w-4 h-4 text-emerald-400" />
            New Collection
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-[11px] text-slate-500 font-semibold mb-1">Collection name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder="widgets"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full bg-[#06090e] border border-[#1e293b] rounded-lg text-sm text-slate-200 px-3 py-2 font-mono focus:outline-none focus:border-emerald-500/50"
            />
          </div>
          {error && <CopyableErrorBanner message={error} parseAsDbError compact />}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#1e293b]">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!name.trim() || creating}
            className="px-4 py-1.5 rounded-lg text-white text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
};
