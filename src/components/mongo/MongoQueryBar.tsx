import React, { useState } from 'react';
import { Play, ChevronDown, ChevronRight } from 'lucide-react';

interface Props {
  filter: string;
  onFilterChange: (value: string) => void;
  project: string;
  onProjectChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
  limit: string;
  onLimitChange: (value: string) => void;
  onRun: () => void;
  running?: boolean;
  error?: string | null;
}

const fieldClass =
  'w-full bg-[#0f172a] border border-[#1e293b] focus:border-emerald-500 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:outline-none';
const labelClass = 'block text-[9.5px] uppercase tracking-wider text-slate-500 mb-0.5';

/** The MongoDB-native analogue of a SQL `WHERE`/`SELECT`/`ORDER BY`/`LIMIT`
 *  bar: Filter is always visible (the common case); Project/Sort/Limit live
 *  behind an "Advanced" toggle so the common single-filter query stays a
 *  one-line affair, matching how most Mongo GUIs default to filter-only. */
export const MongoQueryBar: React.FC<Props> = ({
  filter,
  onFilterChange,
  project,
  onProjectChange,
  sort,
  onSortChange,
  limit,
  onLimitChange,
  onRun,
  running = false,
  error,
}) => {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="border-b border-[#1e293b] bg-[#06090e]">
      <div className="p-2 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <label className={labelClass}>Filter</label>
          <input
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onRun()}
            placeholder='{ "qty": { "$gt": 10 } }'
            className={fieldClass}
          />
        </div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="mt-4 flex items-center gap-0.5 px-1.5 py-1 rounded text-[10px] text-slate-400 hover:text-slate-200 transition-colors shrink-0"
          title="Project / Sort / Limit"
        >
          {advancedOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Advanced
        </button>
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="mt-4 flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white transition-colors shrink-0"
        >
          <Play className="w-3 h-3" />
          Run
        </button>
      </div>

      {advancedOpen && (
        <div className="px-2 pb-2 grid grid-cols-3 gap-2">
          <div>
            <label className={labelClass}>Project</label>
            <input
              value={project}
              onChange={(e) => onProjectChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onRun()}
              placeholder='{ "name": 1, "qty": 1 }'
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass}>Sort</label>
            <input
              value={sort}
              onChange={(e) => onSortChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onRun()}
              placeholder='{ "createdAt": -1 }'
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass}>Limit</label>
            <input
              value={limit}
              onChange={(e) => onLimitChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onRun()}
              placeholder="50"
              inputMode="numeric"
              className={fieldClass}
            />
          </div>
        </div>
      )}

      {error && <div className="px-2 pb-2 text-[10px] text-red-400">{error}</div>}
    </div>
  );
};
