import React, { useState } from 'react';
import { X, Copy, Check, KeyRound, Link2 } from 'lucide-react';
import { copyToClipboard } from '../../core/utils/clipboard';
import { getEditorKind, cellToEditableString, isJsonType } from './TypedCellInput';
import type { DataGridColumn, RowData, RowEdits, CellValue } from './DataGrid';

interface Props {
  columns: DataGridColumn[];
  row: RowData;
  /** Row index within the current column set, for value lookup (hidden
   *  columns included — the inspector shows every column, not just visible ones). */
  columnIndex: Map<string, number>;
  /** Pending (unsaved) edits for this row, keyed by column name — overlaid on
   *  top of the raw DB value with an "edited" marker, same as the grid cell. */
  rowEdits?: RowEdits;
  /** 1-based row number for the header (matches the grid's "#" column). */
  rowNumber: number;
  onClose: () => void;
}

/**
 * Docked right-side panel showing every column of a single selected grid row
 * in label/value form — useful for wide tables (horizontal scroll) or long
 * JSON/text cells that get truncated in the grid. Mirrors the ERD/S3 tabs'
 * docked detail panels: fills whatever column the parent gives it, no
 * fixed/overlay positioning.
 */
export const RowInspectorPanel: React.FC<Props> = ({ columns, row, columnIndex, rowEdits, rowNumber, onClose }) => {
  const [copied, setCopied] = useState(false);

  const handleCopyJson = async () => {
    const obj: Record<string, CellValue> = {};
    columns.forEach((c) => {
      const idx = columnIndex.get(c.name);
      const raw = idx !== undefined ? row[idx] : null;
      const edited = rowEdits && Object.prototype.hasOwnProperty.call(rowEdits, c.name);
      obj[c.name] = edited ? (rowEdits![c.name] as CellValue) : raw;
    });
    const ok = await copyToClipboard(JSON.stringify(obj, null, 2));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="h-full w-full bg-[#0a0f18] border-l border-[#1e293b] flex flex-col">
      {/* Header */}
      <div className="px-4 pt-3.5 pb-2.5 shrink-0 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Row</span>
          <div className="text-[15px] font-bold text-slate-100">#{rowNumber}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopyJson}
            className="px-2 py-1 rounded-lg text-[11px] font-medium text-slate-300 bg-[#141e33] hover:bg-[#1c2a45] flex items-center gap-1"
            title="Copy row as JSON"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            Copy JSON
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body — every column, label/value, in table order (hidden columns included). */}
      <div className="flex-1 overflow-y-auto px-4 py-3.5 space-y-3">
        {columns.map((col) => {
          const idx = columnIndex.get(col.name);
          const raw = idx !== undefined ? row[idx] : null;
          const edited = rowEdits && Object.prototype.hasOwnProperty.call(rowEdits, col.name);
          const value = edited ? (rowEdits![col.name] as CellValue) : raw;
          const kind = getEditorKind(col.data_type);
          const json = isJsonType(col.data_type);
          const display = value === null || value === undefined ? null : cellToEditableString(value, json);
          const isMultiline = json || (kind === 'longtext' && (display?.length ?? 0) > 60);

          return (
            <div key={col.name}>
              <div className="flex items-center gap-1.5 mb-0.5">
                {col.is_primary_key && <KeyRound className="w-3 h-3 text-amber-400 shrink-0" />}
                {col.is_foreign_key && <Link2 className="w-3 h-3 text-cyan-400 shrink-0" />}
                <span className="text-[11px] font-mono text-slate-500 truncate">{col.name}</span>
                {col.data_type && <span className="text-[9px] text-slate-600 lowercase shrink-0">{col.data_type}</span>}
                {edited && (
                  <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/15 text-amber-300 font-mono shrink-0">edited</span>
                )}
              </div>
              {display === null ? (
                <div className="text-[12px] text-slate-600 italic">NULL</div>
              ) : isMultiline ? (
                <pre className="text-[11px] font-mono text-slate-200 bg-[#0f172a] border border-[#1e293b] rounded-lg p-2 whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                  {display}
                </pre>
              ) : (
                <div className="text-[12px] font-mono text-slate-200 break-all">{display}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
