import React, { useMemo } from 'react';
import { Eye } from 'lucide-react';
import { formatBsonValue, bsonKindOf, BSON_KIND_COLOR } from '../../core/mongo/bson';
import type { MongoDocument } from '../../core/mongo/types';

interface Props {
  documents: MongoDocument[];
  selectedIndex?: number | null;
  /** Omit for a read-only table (e.g. aggregation results, which aren't a
   *  single collection's documents and so have no natural edit target). */
  onOpenDocument?: (doc: MongoDocument, index: number) => void;
  /** Read-only "peek" action, distinct from `onOpenDocument` (which opens
   *  the editable slide-over). Rendered as a hover-revealed icon button per
   *  row so inspecting a document doesn't require committing to edit mode. */
  onInspectDocument?: (doc: MongoDocument, index: number) => void;
  /** Checkbox column for multi-select (bulk delete / compare). Omit for
   *  read-only tables (aggregation results) — there's nothing to bulk-act on. */
  selectable?: boolean;
  selectedIndices?: Set<number>;
  onToggleSelect?: (index: number) => void;
  onToggleSelectAll?: () => void;
}

/** Grid/table view of a page of documents — one row per document, one
 *  column per distinct top-level field seen across the page (`_id` pinned
 *  first). Genuinely schemaless collections just get a wide, sparse table;
 *  that's an honest reflection of the data, not a bug. Cell values use the
 *  BSON-aware `formatBsonValue`/`bsonKindOf` so `ObjectId("...")`/`Date(...)`
 *  read as their real type instead of raw Extended JSON. */
export const MongoDocumentTable: React.FC<Props> = ({
  documents,
  selectedIndex,
  onOpenDocument,
  onInspectDocument,
  selectable,
  selectedIndices,
  onToggleSelect,
  onToggleSelectAll,
}) => {
  const columns = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const doc of documents) {
      for (const key of Object.keys(doc)) {
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(key);
        }
      }
    }
    ordered.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
    return ordered;
  }, [documents]);

  if (documents.length === 0) {
    return <div className="p-4 text-center text-[11px] text-slate-500">No documents found.</div>;
  }

  const allSelected = !!selectable && documents.length > 0 && selectedIndices?.size === documents.length;

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-[11px] font-mono border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-[#0a0f18] border-b border-[#1e293b]">
            {selectable && (
              <th className="w-7 px-2 py-1.5 border-r border-[#1e293b]/60">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => onToggleSelectAll?.()}
                  className="rounded border-[#1e293b] text-emerald-600 focus:ring-0 cursor-pointer"
                />
              </th>
            )}
            {onInspectDocument && <th className="w-7 px-1 py-1.5 border-r border-[#1e293b]/60" />}
            {columns.map((col) => (
              <th
                key={col}
                className="text-left px-2.5 py-1.5 font-semibold text-slate-400 whitespace-nowrap border-r border-[#1e293b]/60 last:border-r-0"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {documents.map((doc, i) => {
            const isChecked = !!selectedIndices?.has(i);
            return (
              <tr
                key={i}
                onClick={() => onOpenDocument?.(doc, i)}
                className={`border-b border-[#1e293b]/60 transition-colors group ${onOpenDocument ? 'cursor-pointer' : ''} ${
                  selectedIndex === i || isChecked ? 'bg-emerald-500/10' : onOpenDocument ? 'hover:bg-[#0f172a]' : ''
                }`}
              >
                {selectable && (
                  <td className="px-2 py-1 border-r border-[#1e293b]/30" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => onToggleSelect?.(i)}
                      className="rounded border-[#1e293b] text-emerald-600 focus:ring-0 cursor-pointer"
                    />
                  </td>
                )}
                {onInspectDocument && (
                  <td className="px-1 py-1 border-r border-[#1e293b]/30">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onInspectDocument(doc, i);
                      }}
                      className="p-0.5 rounded text-slate-600 opacity-0 group-hover:opacity-100 hover:text-emerald-400 hover:bg-white/5 transition-all"
                      title="Inspect document (read-only)"
                    >
                      <Eye className="w-3 h-3" />
                    </button>
                  </td>
                )}
                {columns.map((col) => {
                  const has = Object.prototype.hasOwnProperty.call(doc, col);
                  const value = doc[col];
                  return (
                    <td
                      key={col}
                      className={`px-2.5 py-1 whitespace-nowrap max-w-[240px] truncate border-r border-[#1e293b]/30 last:border-r-0 ${
                        has ? BSON_KIND_COLOR[bsonKindOf(value)] : 'text-slate-700'
                      }`}
                      title={has ? formatBsonValue(value) : undefined}
                    >
                      {has ? formatBsonValue(value) : '·'}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
