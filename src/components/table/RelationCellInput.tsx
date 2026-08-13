import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Search, X } from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { DatabaseConnection } from '../../core/domain/types';
import { CELL_INPUT_HEIGHT_CLASS } from './TypedCellInput';

function quoteIdent(engine: string, name: string): string {
  if (engine === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlLiteralText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface RelationOption {
  pk: string;
  label: string;
}

interface RelationCellInputProps {
  connection: DatabaseConnection;
  targetTable: string;
  /** Schema/database the target table lives in, used to qualify the FROM
   *  clause so the relation lookup works on non-default schemas. */
  targetSchemaName?: string;
  targetPkColumn: string;
  /** Column shown alongside the raw id in search results, e.g. "name". Null
   *  when the target table has no obvious label column — the picker still
   *  works, it just lists bare ids. */
  targetLabelColumn: string | null;
  /** Always plain text (the FK column's raw stored value), or '' for NULL. */
  value: string;
  onChange: (rawValue: string) => void;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Called when the user selects an option from the dropdown (or clears).
   *  Passes the selected value so the parent can commit with the correct
   *  value immediately, without waiting for onChange state to flush. */
  onSelect?: (value: string) => void;
  autoFocus?: boolean;
  className?: string;
}

const DEFAULT_CLASS = `${CELL_INPUT_HEIGHT_CLASS} w-full flex items-center gap-1.5 bg-[#0f172a] border border-blue-500 rounded px-2`;

/**
 * A searchable combobox for foreign-key columns: instead of typing a raw id
 * blindly, the user searches the related table by its id or a friendly
 * label column and picks a row. Falls back to accepting manually-typed text
 * as the raw value for anyone who already knows the id they want.
 */
export const RelationCellInput: React.FC<RelationCellInputProps> = ({
  connection,
  targetTable,
  targetSchemaName,
  targetPkColumn,
  targetLabelColumn,
  value,
  onChange,
  onBlur,
  onKeyDown,
  onSelect,
  autoFocus,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<RelationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Dedupe search so StrictMode double-mount doesn't fire duplicate queries.
  const lastSearchKey = useRef<string>('');

  const q = (n: string) => quoteIdent(connection.engine, n);
  const castExpr = (col: string) =>
    connection.engine === 'mysql' ? `CAST(${q(col)} AS CHAR)` : `CAST(${q(col)} AS TEXT)`;
  const targetRef = targetSchemaName ? `${q(targetSchemaName)}.${q(targetTable)}` : q(targetTable);

  // Compute the dropdown position from the input's bounding rect.
  const computeRect = () => {
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect();
      if (r.width > 0) {
        setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 240) });
        return true;
      }
    }
    return false;
  };

  const openDropdown = useCallback(() => {
    const positioned = computeRect();
    if (!positioned) {
      // Input not laid out yet — retry on the next frame.
      requestAnimationFrame(() => {
        computeRect();
        setQuery('');
        setOpen(true);
      });
      return;
    }
    setQuery('');
    setOpen(true);
  }, []);

  // Auto-open on mount. rAF ensures layout is ready.
  useEffect(() => {
    const id = requestAnimationFrame(() => openDropdown());
    return () => cancelAnimationFrame(id);
  }, [openDropdown]);

  // Debounced search — dedupe by composite key so the same search doesn't
  // fire twice (StrictMode, overlapping renders).
  const searchKey = `${open}::${query}::${targetTable}`;
  useEffect(() => {
    if (!open) return;
    if (lastSearchKey.current === searchKey) return;
    lastSearchKey.current = searchKey;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const selectCols = targetLabelColumn ? `${q(targetPkColumn)}, ${q(targetLabelColumn)}` : q(targetPkColumn);
        let sql = `SELECT ${selectCols} FROM ${targetRef}`;
        const needle = query.trim();
        if (needle) {
          const literal = sqlLiteralText(`%${needle}%`);
          const clauses = [`${castExpr(targetPkColumn)} LIKE ${literal}`];
          if (targetLabelColumn) clauses.push(`${castExpr(targetLabelColumn)} LIKE ${literal}`);
          sql += ` WHERE ${clauses.join(' OR ')}`;
        }
        sql += ` ORDER BY ${q(targetPkColumn)} LIMIT 25`;
        const res = await safeInvoke<{ rows: unknown[][] }>('execute_query', {
          request: { config: connection, sql },
          queryId: `fk_search_${targetTable}_${Date.now()}`,
        });
        const rows = res.rows || [];
        if (!cancelled) {
          setOptions(
            rows.map((r) => ({
              pk: r[0] === null || r[0] === undefined ? '' : String(r[0]),
              label: targetLabelColumn && r[1] !== null && r[1] !== undefined ? String(r[1]) : '',
            }))
          );
        }
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    let cancelled = false;
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);

  const selectOption = (opt: RelationOption) => {
    onChange(opt.pk);
    setOpen(false);
    onSelect?.(opt.pk);
    onBlur?.();
  };

  const handleClear = () => {
    onChange('');
    setOpen(false);
    onSelect?.('');
    onBlur?.();
  };

  const handleBlur = () => {
    if (open) {
      // Dropdown is open — delay the blur callback so a dropdown option click
      // can still register (options use onMouseDown preventDefault to stop
      // this blur path entirely).
      setTimeout(() => onBlur?.(), 200);
      return;
    }
    setTimeout(() => onBlur?.(), 150);
  };

  const displayText = value;

  return (
    <div className="relative w-full">
      <div className={className || DEFAULT_CLASS}>
        {/* Hide the relation icon when the dropdown is open so the input
            text/placeholder is fully left-aligned and visually centered —
            the icon takes horizontal space and makes the placeholder look
            off-center when focused. */}
        {!open && <Link2 className="w-3 h-3 text-cyan-400 shrink-0" />}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={open ? query : displayText}
          onFocus={openDropdown}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (open) {
                // Dropdown is open — ESC just closes it, don't propagate.
                setOpen(false);
                e.stopPropagation();
                return;
              }
            }
            onKeyDown?.(e);
          }}
          placeholder={open ? `Search ${targetTable}...` : ''}
          className="flex-1 min-w-0 bg-transparent outline-none text-xs leading-6 text-slate-100 placeholder:text-slate-600 placeholder:italic font-mono"
        />
        {value !== '' && !open && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleClear}
            className="text-slate-500 hover:text-red-400 shrink-0"
            title="Clear (set NULL)"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {open && rect && createPortal(
        <div
          data-relation-dropdown
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width +100, zIndex: 99999 }}
          className="bg-[#0a0f18] border border-[#1e293b] rounded-lg shadow-2xl max-h-60 overflow-y-auto py-1"
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            onClick={handleClear}
            className="w-full text-left px-2.5 py-1.5 text-[11px] text-slate-500 italic hover:bg-[#141e33]"
          >
            NULL
          </button>
          {loading ? (
            <div className="px-2.5 py-2 text-[11px] text-slate-500 flex items-center gap-1.5">
              <Search className="w-3 h-3 animate-pulse" />
              Searching {targetTable}...
            </div>
          ) : options.length === 0 ? (
            <div className="px-2.5 py-2 text-[11px] text-slate-500 italic">No matches</div>
          ) : (
            options.map((opt) => (
              <button
                key={opt.pk}
                onClick={() => selectOption(opt)}
                title={opt.label ? ` ${opt.label}` : undefined}
                className={`w-full text-left px-2.5 py-1.5 text-[11px] font-mono flex items-center gap-2 hover:bg-[#141e33] ${
                  opt.pk === value ? 'bg-blue-600/20 text-blue-400' : 'text-slate-200'
                }`}
              >
                <span className="text-cyan-400 shrink-0">{opt.pk}</span>
                {opt.label && <span className="truncate text-slate-400">{opt.label}</span>}
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  );
};
