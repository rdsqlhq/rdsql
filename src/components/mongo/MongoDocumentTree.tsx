import React, { useState } from 'react';
import { ChevronRight, ChevronDown, FileJson } from 'lucide-react';
import { describeBson, formatBsonValue, bsonKindOf, BSON_KIND_COLOR } from '../../core/mongo/bson';
import type { MongoDocument } from '../../core/mongo/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a value that should expand into its own sub-tree (a plain object
 *  or array that ISN'T a BSON Extended JSON envelope — those are leaves,
 *  rendered via `formatBsonValue` instead of recursing into their `$oid`/
 *  `$date`/etc. internals). */
function isExpandable(value: unknown): boolean {
  if (describeBson(value)) return false;
  return isPlainObject(value) || Array.isArray(value);
}

const FieldNode: React.FC<{ name: string; value: unknown; depth: number }> = ({ name, value, depth }) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const expandable = isExpandable(value);
  const kind = bsonKindOf(value);

  const entries: [string, unknown][] = expandable
    ? Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(value as Record<string, unknown>)
    : [];

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <div
        className={`flex items-center gap-1.5 py-0.5 ${expandable ? 'cursor-pointer hover:bg-white/5 rounded' : ''}`}
        onClick={() => expandable && setExpanded((e) => !e)}
      >
        {expandable ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="text-[11px] font-mono text-slate-300">{name}</span>
        {expandable ? (
          <span className="text-[10px] text-slate-600 font-mono">
            {Array.isArray(value) ? `Array(${value.length})` : `Object(${Object.keys(value as object).length})`}
          </span>
        ) : (
          <span className={`text-[11px] font-mono truncate ${BSON_KIND_COLOR[kind]}`}>{formatBsonValue(value)}</span>
        )}
      </div>
      {expandable && expanded && (
        <div className="border-l border-white/5 ml-1.5">
          {entries.map(([k, v]) => (
            <FieldNode key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

interface Props {
  documents: MongoDocument[];
  onOpenDocument: (doc: MongoDocument, index: number) => void;
}

/** Expandable tree view of a page of documents — each document is its own
 *  root node, labeled by `_id` (falls back to its index). Most useful for
 *  documents with deep nesting, where the table view's flat columns don't
 *  read well. */
export const MongoDocumentTree: React.FC<Props> = ({ documents, onOpenDocument }) => {
  if (documents.length === 0) {
    return <div className="p-4 text-center text-[11px] text-slate-500">No documents found.</div>;
  }

  return (
    <div className="overflow-auto h-full p-2 space-y-1">
      {documents.map((doc, i) => {
        const idLabel = doc._id !== undefined ? formatBsonValue(doc._id) : `Document ${i + 1}`;
        return (
          <div key={i} className="rounded border border-[#1e293b]/60 bg-[#0a0f18]/40 p-1.5">
            <div
              className="flex items-center gap-1.5 px-1 py-0.5 cursor-pointer hover:text-emerald-300 text-slate-300"
              onClick={() => onOpenDocument(doc, i)}
              title="Open full document"
            >
              <FileJson className="w-3 h-3 text-slate-600 shrink-0" />
              <span className="text-[11px] font-mono truncate">{idLabel}</span>
            </div>
            <div className="mt-0.5">
              {Object.entries(doc).map(([k, v]) => (
                <FieldNode key={k} name={k} value={v} depth={1} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
