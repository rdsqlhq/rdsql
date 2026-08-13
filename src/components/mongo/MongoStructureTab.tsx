import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { BSON_KIND_COLOR, type BsonKind } from '../../core/mongo/bson';
import type { DatabaseConnection } from '../../core/domain/types';
import type { MongoSchemaInference } from '../../core/mongo/types';

interface Props {
  connection: DatabaseConnection;
  database: string;
  collectionName: string;
}

const barColor: Partial<Record<BsonKind, string>> = {
  string: 'bg-emerald-500',
  number: 'bg-cyan-500',
  int: 'bg-cyan-500',
  long: 'bg-cyan-500',
  double: 'bg-cyan-500',
  decimal128: 'bg-cyan-500',
  boolean: 'bg-orange-500',
  objectId: 'bg-amber-500',
  date: 'bg-purple-500',
  array: 'bg-blue-500',
  object: 'bg-blue-500',
  null: 'bg-slate-600',
  binary: 'bg-pink-500',
};

/** Schema inference: MongoDB collections have no fixed schema, so instead of
 *  a real column list (impossible) this samples documents and reports, per
 *  field, which BSON types actually occur and how often — a "detected shape"
 *  rather than an enforced one. */
export const MongoStructureTab: React.FC<Props> = ({ connection, database, collectionName }) => {
  const [sampleSize, setSampleSize] = useState(100);
  const [inference, setInference] = useState<MongoSchemaInference | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await safeInvoke<MongoSchemaInference>('mongo_infer_schema', {
        config: connection,
        database,
        collectionName,
        sampleSize,
      });
      setInference(result);
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

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-slate-500">
          {inference ? `Fields detected from ${inference.sampled.toLocaleString()} sampled document${inference.sampled === 1 ? '' : 's'}` : 'Sampling…'}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={1000}
            value={sampleSize}
            onChange={(e) => setSampleSize(Number(e.target.value))}
            className="w-16 bg-[#0f172a] border border-[#1e293b] rounded px-1.5 py-1 text-[11px] font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
            title="Sample size"
          />
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-300 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Resample
          </button>
        </div>
      </div>

      {error && <CopyableErrorBanner message={error} parseAsDbError />}

      {inference && inference.fields.length === 0 && !loading && (
        <div className="text-center text-[11px] text-slate-500 py-8">No documents to sample.</div>
      )}

      <div className="space-y-3">
        {inference?.fields.map((field) => (
          <div key={field.name} className="border border-[#1e293b] rounded-lg p-2.5 bg-[#0a0f18]/60">
            <div className="text-[12px] font-mono font-semibold text-slate-200 mb-1.5">{field.name}</div>
            <div className="space-y-1">
              {field.types.map((t) => (
                <div key={t.bsonType} className="flex items-center gap-2">
                  <span className={`text-[10px] font-mono w-20 shrink-0 ${BSON_KIND_COLOR[t.bsonType as BsonKind] ?? 'text-slate-400'}`}>
                    {t.bsonType}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-[#141e33] overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barColor[t.bsonType as BsonKind] ?? 'bg-slate-500'}`}
                      style={{ width: `${Math.max(t.percentage, 2)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 w-10 text-right shrink-0">
                    {t.percentage.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
