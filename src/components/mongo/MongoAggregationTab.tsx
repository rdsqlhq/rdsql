import React, { useState } from 'react';
import Editor from '@monaco-editor/react';
import { Play, Loader2 } from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { MongoDocumentTable } from './MongoDocumentTable';
import type { DatabaseConnection } from '../../core/domain/types';
import type { MongoDocumentPage } from '../../core/mongo/types';

interface Props {
  connection: DatabaseConnection;
  database: string;
  collectionName: string;
}

const DEFAULT_PIPELINE = `[
  { "$match": {} },
  { "$limit": 20 }
]`;

/** Raw aggregation pipeline runner — a JSON array of stage documents, same
 *  shape `db.collection.aggregate([...])` takes in the Mongo shell. A staged
 *  "Add Stage" builder UI (mockups often show one) is real, separate work;
 *  this raw editor covers the same ground for anyone comfortable with
 *  pipeline syntax, which is the common case for this feature's audience. */
export const MongoAggregationTab: React.FC<Props> = ({ connection, database, collectionName }) => {
  const [pipelineText, setPipelineText] = useState(DEFAULT_PIPELINE);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MongoDocumentPage | null>(null);

  const run = async () => {
    let pipeline: unknown;
    try {
      pipeline = JSON.parse(pipelineText);
    } catch (err: any) {
      setError(err?.message || 'Invalid JSON');
      return;
    }
    if (!Array.isArray(pipeline)) {
      setError('Pipeline must be a JSON array of stage documents.');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const page = await safeInvoke<MongoDocumentPage>('mongo_run_aggregation', {
        config: connection,
        database,
        collectionName,
        pipeline,
      });
      setResult(page);
    } catch (err: any) {
      setError(err?.message || String(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-[#1e293b] flex items-center justify-between shrink-0">
        <span className="text-[11px] font-semibold text-slate-300">Pipeline</span>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white transition-colors"
        >
          {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          Run Pipeline
        </button>
      </div>

      <div className="h-[35%] min-h-[140px] border-b border-[#1e293b] shrink-0">
        <Editor
          height="100%"
          defaultLanguage="json"
          theme="vs-dark"
          value={pipelineText}
          onChange={(v) => setPipelineText(v ?? '')}
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
          }}
        />
      </div>

      {error && (
        <div className="p-2 shrink-0">
          <CopyableErrorBanner message={error} parseAsDbError compact />
        </div>
      )}

      <div className="flex-1 min-h-0">
        {result ? (
          <>
            <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-[#1e293b]/60">
              {result.documents.length} result{result.documents.length === 1 ? '' : 's'}
              {result.hasMore ? ' (truncated — refine the pipeline to narrow further)' : ''}
            </div>
            <div className="h-[calc(100%-28px)]">
              <MongoDocumentTable documents={result.documents} />
            </div>
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            Run the pipeline to see results.
          </div>
        )}
      </div>
    </div>
  );
};
