import React, { useEffect, useMemo, useState } from 'react';
import { FileJson, Layers, KeyRound, Workflow } from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { MongoDocumentsPanel } from './MongoDocumentsPanel';
import { MongoStructureTab } from './MongoStructureTab';
import { MongoIndexesTab } from './MongoIndexesTab';
import { MongoAggregationTab } from './MongoAggregationTab';

interface Props {
  connectionId?: string;
  /** Mongo database name (carried as `schemaName` on the `mongo_documents` tab). */
  database?: string;
  /** Collection name (carried as `tableName` on the `mongo_documents` tab). */
  collectionName?: string;
}

type CollectionTab = 'documents' | 'structure' | 'indexes' | 'aggregation';

const TABS: { id: CollectionTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'documents', label: 'Documents', icon: FileJson },
  { id: 'structure', label: 'Structure', icon: Layers },
  { id: 'indexes', label: 'Indexes', icon: KeyRound },
  { id: 'aggregation', label: 'Aggregation', icon: Workflow },
];

/**
 * MongoDB collection browser: a tabbed client (Documents / Structure /
 * Indexes / Aggregation) given a connection + database + collection —
 * mirrors how a SQL engine's table view splits Data/Structure, adapted for a
 * document store: "Structure" is inferred (sampled), not enforced, and
 * "Aggregation" has no SQL equivalent at all.
 */
export const MongoDocumentBrowser: React.FC<Props> = ({ connectionId, database, collectionName }) => {
  const connections = useConnectionStore((s) => s.connections);
  const connection = useMemo(
    () => connections.find((c) => c.id === connectionId) ?? null,
    [connections, connectionId],
  );

  const [tab, setTab] = useState<CollectionTab>('documents');

  useEffect(() => {
    setTab('documents');
  }, [connectionId, database, collectionName]);

  if (!connection || !database || !collectionName) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        No MongoDB collection selected.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-2 border-b border-[#1e293b] bg-[#0a0f18] flex items-center gap-1 shrink-0">
        <span className="text-[11px] font-semibold text-slate-400 px-1 truncate max-w-[220px]" title={`${database}.${collectionName}`}>
          {database}.{collectionName}
        </span>
        <div className="w-px h-4 bg-[#1e293b] mx-1" />
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-medium border-b-2 transition-colors ${
              tab === id ? 'border-emerald-400 text-emerald-300' : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'documents' && (
          <MongoDocumentsPanel connection={connection} database={database} collectionName={collectionName} />
        )}
        {tab === 'structure' && (
          <MongoStructureTab connection={connection} database={database} collectionName={collectionName} />
        )}
        {tab === 'indexes' && (
          <MongoIndexesTab connection={connection} database={database} collectionName={collectionName} />
        )}
        {tab === 'aggregation' && (
          <MongoAggregationTab connection={connection} database={database} collectionName={collectionName} />
        )}
      </div>
    </div>
  );
};
