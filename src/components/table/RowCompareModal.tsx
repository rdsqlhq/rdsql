import React, { useMemo, useState } from 'react';
import { X, KeyRound, Link2, GitCompare, Copy, Check } from 'lucide-react';
import { copyToClipboard } from '../../core/utils/clipboard';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { getEditorKind, cellToEditableString, isJsonType } from './TypedCellInput';
import type { DataGridColumn, RowData, CellValue } from './DataGrid';

interface Props {
  columns: DataGridColumn[];
  /** Selected rows in selection order — same row objects the grid holds. */
  rows: RowData[];
  /** 1-based row numbers (matching the grid's "#" gutter), parallel to `rows`. */
  rowNumbers: number[];
  onClose: () => void;
}

/** True when every value in `vals` is deep-equal (NULL/undefined normalized
 *  to the same bucket so "missing" doesn't read as a difference from itself). */
function allEqual(vals: CellValue[]): boolean {
  if (vals.length <= 1) return true;
  const first = JSON.stringify(vals[0] ?? null);
  return vals.every((v) => JSON.stringify(v ?? null) === first);
}

/**
 * Modal for side-by-side comparison of two or more selected grid rows — one
 * column per row, one row per field, with differing fields highlighted.
 * Complements `RowInspectorPanel` (single-row detail) for the "which of
 * these rows actually differ" question multi-select naturally raises.
 */
export const RowCompareModal: React.FC<Props> = ({ columns, rows, rowNumbers, onClose }) => {
  useEscapeToClose(onClose);
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [copied, setCopied] = useState(false);

  const fields = useMemo(() => {
    return columns.map((col, colIdx) => {
      const values = rows.map((row) => row[colIdx] ?? null);
      return { col, colIdx, values, differs: !allEqual(values) };
    });
  }, [columns, rows]);

  const diffCount = fields.filter((f) => f.differs).length;
  const visibleFields = onlyDiffs ? fields.filter((f) => f.differs) : fields;

  const handleCopyJson = async () => {
    const out = rows.map((row, i) => {
      const obj: Record<string, CellValue> = {};
      columns.forEach((c, colIdx) => (obj[c.name] = row[colIdx] ?? null));
      return { row: rowNumbers[i], ...obj };
    });
    const ok = await copyToClipboard(JSON.stringify(out, null, 2));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const formatCell = (col: DataGridColumn, value: CellValue) => {
    const json = isJsonType(col.data_type);
    const kind = getEditorKind(col.data_type);
    const display = value === null || value === undefined ? null : cellToEditableString(value, json);
    const isMultiline = json || (kind === 'longtext' && (display?.length ?? 0) > 60);
    if (display === null) return <span className="text-slate-600 italic">NULL</span>;
    if (isMultiline) {
      return (
        <pre className="whitespace-pre-wrap break-all max-h-32 overflow-y-auto macos-scroll">{display}</pre>
      );
    }
    return <span className="break-all">{display}</span>;
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
            <GitCompare className="w-4 h-4 text-cyan-400" />
            Compare Rows
            <span className="text-[11px] font-medium text-slate-500">
              {rows.length} rows · {diffCount} field{diffCount === 1 ? '' : 's'} differ
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={onlyDiffs}
                onChange={(e) => setOnlyDiffs(e.target.checked)}
                className="rounded border-[#1e293b] text-cyan-600 focus:ring-0"
              />
              Only show differences
            </label>
            <button
              onClick={handleCopyJson}
              className="px-2 py-1 rounded-lg text-[11px] font-medium text-slate-300 bg-[#141e33] hover:bg-[#1c2a45] flex items-center gap-1"
              title="Copy compared rows as JSON"
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
                {rowNumbers.map((n) => (
                  <th
                    key={n}
                    className="text-left px-3 py-2 border-b border-[#1e293b] text-slate-300 font-semibold whitespace-nowrap min-w-[180px]"
                  >
                    Row #{n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleFields.map(({ col, values, differs }) => (
                <tr key={col.name} className={differs ? 'bg-amber-500/5' : undefined}>
                  <td className="sticky left-0 z-10 bg-[#0a0f18] px-3 py-1.5 border-r border-b border-[#1e293b]/70 align-top whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {col.is_primary_key && <KeyRound className="w-3 h-3 text-amber-400 shrink-0" />}
                      {col.is_foreign_key && <Link2 className="w-3 h-3 text-cyan-400 shrink-0" />}
                      <span className="text-slate-400">{col.name}</span>
                      {differs && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Differs across selected rows" />}
                    </div>
                  </td>
                  {values.map((v, i) => (
                    <td
                      key={i}
                      className={`px-3 py-1.5 border-b border-[#1e293b]/70 align-top text-slate-200 ${differs ? 'bg-amber-500/10' : ''}`}
                    >
                      {formatCell(col, v)}
                    </td>
                  ))}
                </tr>
              ))}
              {visibleFields.length === 0 && (
                <tr>
                  <td colSpan={rows.length + 1} className="px-3 py-8 text-center text-slate-600 text-xs">
                    No differences — every field matches across the selected rows.
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
