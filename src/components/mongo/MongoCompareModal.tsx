import React, { useMemo, useState } from 'react';
import { X, GitCompare, Copy, Check } from 'lucide-react';
import { copyToClipboard } from '../../core/utils/clipboard';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { formatBsonValue, bsonKindOf, BSON_KIND_COLOR } from '../../core/mongo/bson';
import type { MongoDocument } from '../../core/mongo/types';

interface Props {
  /** Selected documents in selection order. */
  documents: MongoDocument[];
  onClose: () => void;
}

function previewId(doc: MongoDocument, i: number): string {
  return doc._id !== undefined ? formatBsonValue(doc._id) : `Document ${i + 1}`;
}

/** True when every value in `vals` is deep-equal (a field missing from a
 *  document is normalized to `undefined` so "absent" reads as its own value
 *  rather than silently matching `null`). */
function allEqual(vals: unknown[]): boolean {
  if (vals.length <= 1) return true;
  const first = JSON.stringify(vals[0]);
  return vals.every((v) => JSON.stringify(v) === first);
}

/**
 * Side-by-side comparison of two or more selected MongoDB documents — one
 * column per document, one row per field (the union of every field seen
 * across the selection, since collections are schemaless), differing fields
 * highlighted. Mirrors `RowCompareModal` (SQL grid) but works directly off
 * BSON documents instead of a fixed column set.
 */
export const MongoCompareModal: React.FC<Props> = ({ documents, onClose }) => {
  useEscapeToClose(onClose);
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [copied, setCopied] = useState(false);

  const fields = useMemo(() => {
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
    return ordered.map((name) => {
      const values = documents.map((doc) => (Object.prototype.hasOwnProperty.call(doc, name) ? doc[name] : undefined));
      return { name, values, differs: !allEqual(values) };
    });
  }, [documents]);

  const diffCount = fields.filter((f) => f.differs).length;
  const visibleFields = onlyDiffs ? fields.filter((f) => f.differs) : fields;

  const handleCopyJson = async () => {
    const ok = await copyToClipboard(JSON.stringify(documents, null, 2));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const formatCell = (value: unknown) => {
    if (value === undefined) return <span className="text-slate-700 italic">missing</span>;
    if (value === null) return <span className="text-slate-600 italic">null</span>;
    const kind = bsonKindOf(value);
    const display = formatBsonValue(value);
    const isMultiline = (kind === 'object' || kind === 'array') && display.length > 60;
    if (isMultiline) {
      return (
        <pre className={`whitespace-pre-wrap break-all max-h-32 overflow-y-auto macos-scroll ${BSON_KIND_COLOR[kind]}`}>{display}</pre>
      );
    }
    return <span className={`break-all ${BSON_KIND_COLOR[kind]}`}>{display}</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-6xl max-h-[85vh] bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e293b] shrink-0">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <GitCompare className="w-4 h-4 text-emerald-400" />
            Compare Documents
            <span className="text-[11px] font-medium text-slate-500">
              {documents.length} documents · {diffCount} field{diffCount === 1 ? '' : 's'} differ
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={onlyDiffs}
                onChange={(e) => setOnlyDiffs(e.target.checked)}
                className="rounded border-[#1e293b] text-emerald-600 focus:ring-0"
              />
              Only show differences
            </label>
            <button
              onClick={handleCopyJson}
              className="px-2 py-1 rounded-lg text-[11px] font-medium text-slate-300 bg-[#141e33] hover:bg-[#1c2a45] flex items-center gap-1"
              title="Copy compared documents as JSON"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              Copy JSON
            </button>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto macos-scroll">
          <table className="border-collapse text-[11.5px] font-mono w-full">
            <thead className="sticky top-0 z-10 bg-[#0a0f18]">
              <tr>
                <th className="sticky left-0 z-20 bg-[#0a0f18] text-left px-3 py-2 border-b border-r border-[#1e293b] text-slate-500 font-semibold text-[10px] uppercase tracking-wide whitespace-nowrap">
                  Field
                </th>
                {documents.map((doc, i) => (
                  <th
                    key={i}
                    className="text-left px-3 py-2 border-b border-[#1e293b] text-slate-300 font-semibold whitespace-nowrap min-w-[180px] truncate max-w-[280px]"
                    title={previewId(doc, i)}
                  >
                    {previewId(doc, i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleFields.map(({ name, values, differs }) => (
                <tr key={name} className={differs ? 'bg-amber-500/5' : undefined}>
                  <td className="sticky left-0 z-10 bg-[#0a0f18] px-3 py-1.5 border-r border-b border-[#1e293b]/70 align-top whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-400">{name}</span>
                      {differs && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Differs across selected documents" />}
                    </div>
                  </td>
                  {values.map((v, i) => (
                    <td
                      key={i}
                      className={`px-3 py-1.5 border-b border-[#1e293b]/70 align-top text-slate-200 ${differs ? 'bg-amber-500/10' : ''}`}
                    >
                      {formatCell(v)}
                    </td>
                  ))}
                </tr>
              ))}
              {visibleFields.length === 0 && (
                <tr>
                  <td colSpan={documents.length + 1} className="px-3 py-8 text-center text-slate-600 text-xs">
                    No differences — every field matches across the selected documents.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
