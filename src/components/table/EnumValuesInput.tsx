import React, { useEffect, useRef, useState } from 'react';
import { parseEnumInner, buildEnumInner } from '../../core/sql/dataTypes';

interface EnumValuesInputProps {
  /** The quoted-list content between an enum type's parens, e.g. "'a','b'"
   *  (NOT the surrounding "enum(...)" — callers slice that off/back on). */
  value: string;
  onChange: (innerQuotedList: string) => void;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Friendly editor for a MySQL/MariaDB enum column's allowed values — type
 * them as a plain comma-separated list ("completed, active, cancelled"), no
 * manual SQL string-literal quoting/escaping needed.
 *
 * Keeps its own local text instead of deriving the displayed value fresh
 * from `value` on every keystroke: `buildEnumInner` drops empty entries (so
 * an in-progress "completed, " isn't sent upward with a dangling empty
 * member), and if the *displayed* text were re-derived from that trimmed
 * result each render, the trailing comma+space the user just typed would
 * vanish immediately — making it impossible to ever type a second value.
 * `value` is only re-read when it changes from an EXTERNAL source (e.g. the
 * parent switches which column/row this input is editing), tracked via
 * `lastEmitted` to tell that apart from this input's own round-trip.
 */
export const EnumValuesInput: React.FC<EnumValuesInputProps> = ({ value, onChange, autoFocus, className }) => {
  const [text, setText] = useState(() => parseEnumInner(value).join(', '));
  const lastEmitted = useRef(value);

  useEffect(() => {
    if (value !== lastEmitted.current) {
      setText(parseEnumInner(value).join(', '));
      lastEmitted.current = value;
    }
  }, [value]);

  return (
    <input
      type="text"
      autoFocus={autoFocus}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const inner = buildEnumInner(e.target.value.split(','));
        lastEmitted.current = inner;
        onChange(inner);
      }}
      placeholder="completed, active, cancelled"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      className={className}
    />
  );
};
