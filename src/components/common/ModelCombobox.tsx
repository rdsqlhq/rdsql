import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ModelInfo } from '../../core/ai/types';

/**
 * A typeable autocomplete for AI model selection.
 *
 * Combines a free-text input (so the user can always type a custom model id)
 * with a filtered dropdown of fetched models. Keyboard-navigable: ArrowUp /
 * ArrowDown to move, Enter to select, Escape to close. Matches the app's dark
 * theme — unlike native <datalist>, whose popup uses the OS's light styling
 * and doesn't filter as you type.
 *
 * Controlled: the parent owns `value` and receives changes via `onChange`.
 */
export interface ModelComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ModelInfo[];
  placeholder?: string;
  disabled?: boolean;
  /** Input id — needed so a <label htmlFor> can focus it. */
  id?: string;
}

export const ModelCombobox: React.FC<ModelComboboxProps> = ({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  id,
}) => {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter options by the current input text (case-insensitive substring on
  // both id and label). Empty input shows everything.
  const query = value.trim().toLowerCase();
  const filtered = query
    ? options.filter(
        (m) =>
          m.id.toLowerCase().includes(query) ||
          (m.label?.toLowerCase().includes(query) ?? false),
      )
    : options;

  // Keep the highlighted index within bounds when the filter changes.
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered.length, highlight]);

  // Scroll the highlighted option into view while navigating with the keyboard.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (!filtered.length) return;
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      if (!filtered.length) return;
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter' && open && filtered[highlight]) {
      e.preventDefault();
      select(filtered[highlight].id);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer so a click on an option registers before we close.
          setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
        className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-slate-200 p-2 pr-8 font-mono text-xs focus:outline-none focus:border-cyan-500/50 disabled:opacity-50"
      />
      {/* Dropdown affordance — purely visual; clicking focuses the input. */}
      <ChevronDown
        className="w-3.5 h-3.5 text-slate-500 absolute right-2.5 top-3 pointer-events-none"
      />

      {open && filtered.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto bg-[#0a0f18] border border-[#1e293b] rounded-lg shadow-xl py-1 macos-scroll"
        >
          {filtered.map((m, idx) => {
            const isActive = idx === highlight;
            const isSelected = m.id === value;
            return (
              <button
                type="button"
                key={m.id}
                data-idx={idx}
                onMouseDown={(e) => {
                  // Prevent the input's onBlur from firing before the click.
                  e.preventDefault();
                  select(m.id);
                }}
                onMouseEnter={() => setHighlight(idx)}
                className={`w-full text-left px-2.5 py-1.5 flex items-center gap-2 transition-colors ${
                  isActive ? 'bg-cyan-600/20' : 'hover:bg-white/5'
                }`}
              >
                <span className="font-mono text-[11px] text-slate-200 truncate flex-1 min-w-0">
                  {m.id}
                </span>
                {m.label && (
                  <span className="text-[10px] text-slate-500 truncate shrink-0 max-w-[40%]">
                    {m.label}
                  </span>
                )}
                {isSelected && <Check className="w-3 h-3 text-cyan-400 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
