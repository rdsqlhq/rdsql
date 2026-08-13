import React, { useEffect } from 'react';
import { RefreshCw, Loader2, AlertCircle, CheckCircle2, GitMerge } from 'lucide-react';
import { useSyncStore } from '../../store/useSyncStore';

/**
 * Sync section of the Account tab — manual "Sync now" and conflict
 * resolution. There's no passphrase step: the encryption key is generated
 * automatically on the first device and handed to additional devices
 * through the existing pairing-code flow (see credentialCrypto.ts). Auto-sync
 * is deliberately out of scope for v1 (manual-only, per the sync feature's
 * plan doc) to keep this pass bounded.
 */
export const SyncSection: React.FC = () => {
  const { status, lastSyncedAt, error, conflicts, checkKeySetup, syncNow, keepLocal, keepRemote } = useSyncStore();

  useEffect(() => {
    void checkKeySetup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'checking-key') {
    return (
      <div className="flex items-center gap-2 text-slate-500">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Setting up sync…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => void syncNow()}
          disabled={status === 'syncing'}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#263449] disabled:opacity-50 text-slate-200 font-semibold transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${status === 'syncing' ? 'animate-spin' : ''}`} />
          {status === 'syncing' ? 'Syncing…' : 'Sync now'}
        </button>
        {status === 'synced' && conflicts.length === 0 && (
          <span className="flex items-center gap-1 text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" /> Synced
          </span>
        )}
        {status === 'error' && (
          <span className="flex items-center gap-1 text-red-400">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </span>
        )}
      </div>
      {lastSyncedAt && <p className="text-[10px] text-slate-600">Last synced {new Date(lastSyncedAt).toLocaleString()}</p>}
      <p className="text-[10px] text-slate-600">
        Connection credentials are end-to-end encrypted. New devices get the encryption key automatically when you pair them below.
      </p>

      {conflicts.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-amber-300">
            <GitMerge className="w-3.5 h-3.5" />
            {conflicts.length} connection{conflicts.length > 1 ? 's' : ''} changed on another device
          </div>
          {conflicts.map((c) => (
            <div key={c.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[#0f172a] border border-amber-500/20">
              <span className="text-slate-300 truncate">{c.name}</span>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => void keepLocal(c.id)} className="text-blue-400 hover:text-blue-300">
                  Keep mine
                </button>
                <button onClick={() => void keepRemote(c.id)} className="text-slate-400 hover:text-slate-200">
                  Keep theirs
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
