import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Table as TableIcon, X } from 'lucide-react';

interface SearchPaletteProps {
  open: boolean;
  tableNames: string[];
  onSelect: (name: string) => void;
  onClose: () => void;
}

export const SearchPalette: React.FC<SearchPaletteProps> = ({ open, tableNames, onSelect, onClose }) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tableNames.slice(0, 30);
    return tableNames.filter((n) => n.toLowerCase().includes(q)).slice(0, 30);
  }, [query, tableNames]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[activeIndex];
      if (pick) {
        onSelect(pick);
        onClose();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-32 select-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#1e293b]">
          <Search className="w-4 h-4 text-slate-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Jump to a table..."
            className="flex-1 bg-transparent text-sm text-slate-200 focus:outline-none"
          />
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-3 py-4 text-xs text-slate-500 italic text-center">No tables match "{query}"</div>
          ) : (
            results.map((name, i) => (
              <button
                key={name}
                onClick={() => {
                  onSelect(name);
                  onClose();
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 transition-colors ${
                  i === activeIndex ? 'bg-blue-600/20 text-blue-400' : 'text-slate-300 hover:bg-[#141e33]'
                }`}
              >
                <TableIcon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{name}</span>
              </button>
            ))
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-[#1e293b] text-[10px] text-slate-500 flex items-center gap-3">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
};
