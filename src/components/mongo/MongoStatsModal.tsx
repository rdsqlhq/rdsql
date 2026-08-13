import React, { useEffect, useState } from 'react';
import { X, Gauge } from 'lucide-react';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import type { DatabaseConnection } from '../../core/domain/types';
import type { MongoCollectionStats, MongoDatabaseStats } from '../../core/mongo/types';

interface Props {
  connection: DatabaseConnection;
  database: string;
  /** Omit for database-level stats; set for a single collection's stats. */
  collectionName?: string;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between py-1.5 border-b border-[#1e293b]/60 last:border-b-0">
    <span className="text-[11px] text-slate-400">{label}</span>
    <span className="text-[11px] font-mono text-slate-200">{value}</span>
  </div>
);

/** Shows either `mongo_collection_stats` or `mongo_database_stats` — the
 *  MongoDB analogue of a table/database "Properties" panel. */
export const MongoStatsModal: React.FC<Props> = ({ connection, database, collectionName, onClose }) => {
  useEscapeToClose(onClose);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collStats, setCollStats] = useState<MongoCollectionStats | null>(null);
  const [dbStats, setDbStats] = useState<MongoDatabaseStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        if (collectionName) {
          const result = await safeInvoke<MongoCollectionStats>('mongo_collection_stats', {
            config: connection,
            database,
            collectionName,
          });
          if (!cancelled) setCollStats(result);
        } else {
          const result = await safeInvoke<MongoDatabaseStats>('mongo_database_stats', { config: connection, database });
          if (!cancelled) setDbStats(result);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.id, database, collectionName]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <Gauge className="w-4 h-4 text-cyan-400" />
            {collectionName ? `${collectionName} — Stats` : `${database} — Stats`}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">
          {loading && <div className="text-[11px] text-slate-500">Loading…</div>}
          {error && <CopyableErrorBanner message={error} parseAsDbError />}
          {collStats && (
            <div>
              <Row label="Documents" value={collStats.count.toLocaleString()} />
              <Row label="Data size" value={formatBytes(collStats.size)} />
              <Row label="Avg document size" value={formatBytes(collStats.avgObjSize)} />
              <Row label="Storage size" value={formatBytes(collStats.storageSize)} />
              <Row label="Total index size" value={formatBytes(collStats.totalIndexSize)} />
              <Row label="Indexes" value={String(collStats.indexCount)} />
            </div>
          )}
          {dbStats && (
            <div>
              <Row label="Collections" value={String(dbStats.collections)} />
              <Row label="Views" value={String(dbStats.views)} />
              <Row label="Documents" value={dbStats.objects.toLocaleString()} />
              <Row label="Data size" value={formatBytes(dbStats.dataSize)} />
              <Row label="Storage size" value={formatBytes(dbStats.storageSize)} />
              <Row label="Indexes" value={String(dbStats.indexes)} />
              <Row label="Index size" value={formatBytes(dbStats.indexSize)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
