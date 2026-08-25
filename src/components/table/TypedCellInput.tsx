import React from 'react';
import { DateTimePicker } from './DateTimePicker';

export type EditorKind = 'date' | 'datetime' | 'time' | 'number' | 'boolean' | 'longtext' | 'json' | 'enum' | 'text';

/** A raw cell value as it arrives from the backend (already decoded). */
export type CellValue = string | number | boolean | null;

/** Detect whether a column's SQL data type holds structured JSON/object data. */
export function isJsonType(dataType?: string): boolean {
  if (!dataType) return false;
  const dt = dataType.toLowerCase();
  return dt.includes('json') || dt.includes('object') || dt.includes('struct') || dt.includes('array') || dt.includes('list');
}

/**
 * Convert a raw cell value into a string suitable for the modal editor.
 *
 * PostgreSQL JSON/JSONB (and other structured) columns arrive from the backend
 * as **parsed JS objects/arrays** — not strings. Calling `String(obj)` on those
 * yields `"[object Object]"`, which then fails `JSON.parse()` inside the modal
 * ("Unexpected identifier 'object'"). This helper serializes objects/arrays
 * via `JSON.stringify` (pretty-printed so Monaco shows readable JSON) and
 * leaves primitives as plain strings.
 *
 * - `null` / `undefined` → `null` (SQL NULL)
 * - object / array → pretty `JSON.stringify`
 * - string → as-is (JSON-as-text columns keep their text; the modal's Format
 *   button will parse + reformat if it's valid JSON)
 * - number / boolean → `String(value)`
 */
export function cellToEditableString(raw: unknown, isJson: boolean): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') {
    // Parsed JSON object/array from the backend — serialize it.
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  // Primitives (string / number / boolean). For JSON columns that arrive as a
  // string, pass the raw string through so the modal can validate/format it.
  if (isJson && typeof raw === 'string') {
    // Best-effort: if the string is valid JSON, pretty-print it for readability.
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      // Not valid JSON — leave as-is so the user sees the raw stored text.
    }
    return raw;
  }
  return String(raw);
}

/**
 * Picks the right HTML input control for a column's SQL data type, so
 * editing/inserting a row can't produce a value the column will reject —
 * a datetime column gets a native datetime picker, a numeric column gets a
 * number spinner (with browser-level validation), a boolean column gets an
 * explicit True/False/NULL choice instead of free text, etc.
 */
export function getEditorKind(dataType?: string): EditorKind {
  if (!dataType) return 'text';
  const dt = dataType.toLowerCase();

  if (dt.includes('bool')) return 'boolean';
  if (dt.includes('timestamp') || dt.includes('datetime')) return 'datetime';
  if (dt === 'date' || (dt.includes('date') && !dt.includes('update'))) return 'date';
  if (dt.includes('time')) return 'time';
  if (
    dt.includes('int') ||
    dt.includes('numeric') ||
    dt.includes('decimal') ||
    dt.includes('float') ||
    dt.includes('double') ||
    dt.includes('real') ||
    dt.includes('serial') ||
    dt.includes('money')
  ) {
    return 'number';
  }
  // JSON / structured types get their own editor (with format + validation).
  if (isJsonType(dataType)) return 'json';
  if (dt.includes('text') || dt.includes('blob') || dt.includes('clob') || dt.includes('xml')) {
    return 'longtext';
  }
  return 'text';
}

function normalizeBooleanDraft(value: string): '' | '1' | '0' {
  if (value === '') return '';
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 't' || v === 'yes') return '1';
  return '0';
}

interface TypedCellInputProps {
  kind: EditorKind;
  /** Always plain DB-format text (or '' for empty/NULL) — never a Date object. */
  value: string;
  onChange: (dbValue: string) => void;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  /** Required when kind === 'enum' — the column's allowed labels. */
  enumValues?: string[] | null;
}

// Fixed height + box-border on every variant so a row's height never jumps
// around depending on which column type happens to be under edit — text,
// number, date/time pickers, and the boolean dropdown all line up exactly.
export const CELL_INPUT_HEIGHT_CLASS = 'h-7 box-border';

const DEFAULT_CLASS = `${CELL_INPUT_HEIGHT_CLASS} w-full bg-[#0f172a] border border-blue-500 rounded px-2 py-0 text-xs text-slate-100 focus:outline-none font-mono leading-7`;

export const TypedCellInput: React.FC<TypedCellInputProps> = ({
  kind,
  value,
  onChange,
  onBlur,
  onKeyDown,
  autoFocus,
  placeholder,
  className,
  enumValues,
}) => {
  const cls = className || DEFAULT_CLASS;

  if (kind === 'boolean') {
    return (
      <select
        autoFocus={autoFocus}
        value={normalizeBooleanDraft(value)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={cls}
      >
        <option value="">NULL</option>
        <option value="1">TRUE</option>
        <option value="0">FALSE</option>
      </select>
    );
  }

  // Enum column — a dropdown of the type's actual allowed labels (Navicat-
  // style), not free text a user could mistype into an invalid value. Falls
  // through to plain text below if the caller didn't supply the list (e.g.
  // MySQL enum columns, whose labels aren't fetched yet).
  if (kind === 'enum' && enumValues && enumValues.length > 0) {
    return (
      <select
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={cls}
      >
        <option value="">NULL</option>
        {enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  }

  if (kind === 'date') {
    return (
      <DateTimePicker
        mode="date"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        autoFocus={autoFocus}
        placeholder="YYYY-MM-DD"
        className="h-7 box-border w-full bg-[#0f172a] border border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono min-w-[150px]"
      />
    );
  }

  if (kind === 'datetime') {
    return (
      <DateTimePicker
        mode="datetime"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        autoFocus={autoFocus}
        placeholder="YYYY-MM-DD HH:mm:ss"
        className="h-7 box-border w-full bg-[#0f172a] border border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono min-w-[220px]"
      />
    );
  }

  if (kind === 'time') {
    return (
      <DateTimePicker
        mode="time"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        autoFocus={autoFocus}
        placeholder="HH:mm:ss"
        className="h-7 box-border w-full bg-[#0f172a] border border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono min-w-[120px]"
      />
    );
  }

  if (kind === 'number') {
    return (
      <input
        type="number"
        step="any"
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={cls}
      />
    );
  }

  if (kind === 'longtext') {
    return (
      <textarea
        autoFocus={autoFocus}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        // Match the single-line input height exactly so the row doesn't jump
        // when a longtext/json column enters edit. Vertical centering via
        // matching height + line-height; overflow hidden keeps it single-line
        // inside the cell (the modal editor is for multi-line).
        className={`${cls} leading-6 py-0 resize-none overflow-hidden whitespace-nowrap`}
      />
    );
  }

  return (
    <input
      type="text"
      autoFocus={autoFocus}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      className={cls}
    />
  );
};
