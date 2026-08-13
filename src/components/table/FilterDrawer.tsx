import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Trash2, Filter, Check } from 'lucide-react';
import {
  type FilterCondition,
  type FilterOp,
  operatorsForKind,
  operatorLabel,
} from './cellUtils';
import type { EditorKind } from './TypedCellInput';
import { DateTimePicker } from './DateTimePicker';

export interface FilterColumn {
  name: string;
  kind: EditorKind;
  data_type?: string;
}

interface FilterDrawerProps {
  open: boolean;
  onClose: () => void;
  conditions: FilterCondition[];
  onChange: (conditions: FilterCondition[]) => void;
  columns: FilterColumn[];
}

/** Generate a unique id for a new condition. */
const newId = () => `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Right-side drawer for building advanced multi-condition filters on the data
 * grid. Conditions are AND-combined and applied live (the parent re-filters as
 * conditions change, so there's no explicit Apply button).
 *
 * The drawer is rendered via a fixed overlay and animates in from the right.
 * It never covers the grid's left columns, so the user sees results update in
 * real time while editing conditions.
 */
export const FilterDrawer: React.FC<FilterDrawerProps> = ({
  open,
  onClose,
  conditions,
  onChange,
  columns,
}) => {
  // Local buffer so typing in value fields doesn't re-filter on every keystroke
  // — we debounce the propagation by ~200ms. Column/operator changes propagate
  // immediately (they're discrete selects).
  const [buffer, setBuffer] = useState<FilterCondition[]>(conditions);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync buffer when the drawer opens or external conditions change (e.g.
  // "Clear all" pressed elsewhere).
  useEffect(() => {
    setBuffer(conditions);
  }, [conditions, open]);

  // Debounced propagation of value edits.
  const propagate = React.useCallback(
    (next: FilterCondition[]) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => onChange(next), 200);
    },
    [onChange],
  );
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const update = (id: string, patch: Partial<FilterCondition>) => {
    const next = buffer.map((c) => (c.id === id ? { ...c, ...patch } : c));
    setBuffer(next);
    propagate(next);
  };

  const addCondition = () => {
    const firstCol = columns[0];
    if (!firstCol) return;
    const next = [
      ...buffer,
      {
        id: newId(),
        column: firstCol.name,
        operator: 'contains' as FilterOp,
        value: '',
      },
    ];
    setBuffer(next);
    propagate(next);
  };

  const removeCondition = (id: string) => {
    const next = buffer.filter((c) => c.id !== id);
    setBuffer(next);
    propagate(next);
  };

  const clearAll = () => {
    setBuffer([]);
    onChange([]);
  };

  const activeCount = conditions.filter(
    (c) => c.operator === 'is_null' || c.operator === 'is_not_null' || c.value.trim() !== '',
  ).length;

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-[90]"
          onClick={onClose}
        />
      )}
      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 h-full w-80 sm:w-96 bg-[#0a0f18] border-l border-[#1e293b] shadow-2xl z-[91] flex flex-col transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#1e293b] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-cyan-400" />
            <span className="font-bold text-sm text-slate-100">Filter</span>
            {activeCount > 0 && (
              <span className="text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 px-1.5 py-0.5 rounded">
                {activeCount}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Conditions list */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {buffer.length === 0 && (
            <div className="text-center py-12 text-slate-600 text-xs">
              <Filter className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No filter conditions.
              <br />
              Click "Add condition" to filter rows.
            </div>
          )}
          {buffer.map((c) => {
            const col = columns.find((x) => x.name === c.column);
            const kind = col?.kind ?? 'text';
            const ops = operatorsForKind(kind);
            const isUnary = c.operator === 'is_null' || c.operator === 'is_not_null';
            return (
              <div
                key={c.id}
                className="bg-[#0f172a] border border-[#1e293b] rounded-lg p-2.5 space-y-2"
              >
                <div className="flex items-center gap-1.5">
                  <select
                    value={c.column}
                    onChange={(e) => {
                      // When the column changes, reset to the first valid
                      // operator for that column's kind (the current operator
                      // may not be valid for the new type).
                      const newCol = columns.find((x) => x.name === e.target.value);
                      const newKind = newCol?.kind ?? 'text';
                      const validOps = operatorsForKind(newKind);
                      const op = validOps.includes(c.operator)
                        ? c.operator
                        : validOps[0];
                      update(c.id, { column: e.target.value, operator: op });
                    }}
                    className="flex-1 min-w-0 bg-[#06090e] text-xs text-slate-200 border border-[#1e293b] rounded px-2 py-1 focus:outline-none focus:border-cyan-500"
                  >
                    {columns.map((x) => (
                      <option key={x.name} value={x.name}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeCondition(c.id)}
                    className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-[#1e293b] transition-colors shrink-0"
                    title="Remove condition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={c.operator}
                    onChange={(e) => update(c.id, { operator: e.target.value as FilterOp })}
                    className="w-32 shrink-0 bg-[#06090e] text-xs text-slate-200 border border-[#1e293b] rounded px-2 py-1 focus:outline-none focus:border-cyan-500"
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {operatorLabel(op)}
                      </option>
                    ))}
                  </select>
                  {!isUnary && (
                    <FilterValueInput
                      kind={kind}
                      value={c.value}
                      onChange={(v) => update(c.id, { value: v })}
                    />
                  )}
                </div>
                {col?.data_type && (
                  <div className="text-[9px] font-mono text-slate-600 uppercase tracking-wider">
                    {col.data_type}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-3 py-3 border-t border-[#1e293b] flex items-center justify-between shrink-0 bg-[#06090e]">
          <button
            onClick={clearAll}
            disabled={buffer.length === 0}
            className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Clear all
          </button>
          <div className="flex items-center gap-1.5">
            <button
              onClick={addCondition}
              disabled={columns.length === 0}
              className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-cyan-300 flex items-center gap-1 transition-colors disabled:opacity-40"
            >
              <Plus className="w-3 h-3" />
              Add condition
            </button>
            <button
              onClick={onClose}
              className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1 transition-colors"
            >
              <Check className="w-3 h-3" />
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

/** The value input adapts to the column kind: a native date/time picker for
 *  date columns, a checkbox-style select for booleans, a numeric input for
 *  numbers, and a plain text input otherwise. */
const FilterValueInput: React.FC<{
  kind: EditorKind;
  value: string;
  onChange: (v: string) => void;
}> = ({ kind, value, onChange }) => {
  const base = 'flex-1 min-w-0 bg-[#06090e] text-xs text-slate-200 border border-[#1e293b] rounded px-2 py-1 focus:outline-none focus:border-cyan-500';
  if (kind === 'boolean') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={base}>
        <option value="">select…</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (kind === 'number') {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="value"
        className={base}
      />
    );
  }
  if (kind === 'date') {
    return <DateTimePicker mode="date" value={value} onChange={onChange} className={base} />;
  }
  if (kind === 'datetime') {
    return <DateTimePicker mode="datetime" value={value} onChange={onChange} className={base} />;
  }
  if (kind === 'time') {
    return <DateTimePicker mode="time" value={value} onChange={onChange} className={base} />;
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="value"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      className={base}
    />
  );
};
