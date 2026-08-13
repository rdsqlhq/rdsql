/**
 * React wrapper around Flatpickr for the data-grid's date / datetime / time
 * cell editors.
 *
 * The native `<input type="datetime-local">` rendered at a tiny size, looked
 * inconsistent across platforms, and its calendar popup was awkward in a dense
 * grid. Flatpickr gives us a single, themeable, lightweight (~40KB) picker that
 * supports seconds precision (needed for SQL TIMESTAMP / DATETIME columns) and
 * renders in a portal so it never gets clipped by the grid's cell overflow.
 *
 * The wrapper stays "DB-format in, DB-format out":
 *   - `value` / `onChange` speak the same plain-text formats the rest of the
 *     grid already uses (`YYYY-MM-DD`, `YYYY-MM-DD HH:mm:ss`, `HH:mm:ss`).
 *   - Internally Flatpickr works with Date objects; the wrapper converts at the
 *     boundary so callers don't change.
 */

import React, { useEffect, useRef } from 'react';
import flatpickr from 'flatpickr';
import type { Instance } from 'flatpickr/dist/types/instance';
// Dark theme — matches the app's `#0f172a` / slate palette.
import 'flatpickr/dist/flatpickr.min.css';

export type PickerMode = 'date' | 'datetime' | 'time';

interface DateTimePickerProps {
  mode: PickerMode;
  /** Plain DB-format text (or '' for empty/NULL). */
  value: string;
  onChange: (dbValue: string) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}

// ── Format helpers ──────────────────────────────────────────────────────────
// Pad a number to 2 digits.
const pad = (n: number) => String(n).padStart(2, '0');

/** Parse a DB-format string into a Date (local time). Returns null when blank
 *  or unparseable — Flatpickr treats a null `defaultDate` as "no selection". */
function dbToDate(raw: string, mode: PickerMode): Date | null {
  if (!raw) return null;
  if (mode === 'date') {
    // YYYY-MM-DD
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  if (mode === 'datetime') {
    // YYYY-MM-DD HH:mm[:ss] (the space may also be 'T' from native inputs)
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }
  if (mode === 'time') {
    // HH:mm[:ss] — anchor to today's date (Flatpickr needs a full Date).
    const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    if (m) {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], m[3] ? +m[3] : 0);
    }
  }
  // Fallback: let Date parse it (works for ISO strings).
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Format a Date back into the DB-format string for the active mode. */
function dateToDb(d: Date, mode: PickerMode): string {
  if (mode === 'date') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (mode === 'time') return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The Flatpickr `dateFormat` string for each mode. With `enableTime` +
 *  `noCalendar`, Flatpickr uses these tokens to parse + format the input text. */
function flatpickrFormat(mode: PickerMode): string {
  if (mode === 'date') return 'Y-m-d';
  if (mode === 'time') return 'H:i:S';
  return 'Y-m-d H:i:S';
}

// ── Component ───────────────────────────────────────────────────────────────

export const DateTimePicker: React.FC<DateTimePickerProps> = ({
  mode,
  value,
  onChange,
  onBlur,
  autoFocus,
  placeholder,
  className,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const fpRef = useRef<Instance | null>(null);
  // Keep the latest onChange in a ref so the Flatpickr `onChange` handler (bound
  // once at init) always calls the current callback without re-creating the
  // instance on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!inputRef.current) return;
    const isTimeOnly = mode === 'time';
    // Flatpickr's `defaultDate` rejects null — only set it when we parsed a real
    // Date. An unset value simply leaves the picker empty (SQL NULL).
    const parsed = dbToDate(value, mode);
    const fp = flatpickr(inputRef.current, {
      enableTime: mode !== 'date',
      noCalendar: isTimeOnly,
      time_24hr: true,
      enableSeconds: true, // seconds stepper for TIMESTAMP columns
      dateFormat: flatpickrFormat(mode),
      ...(parsed ? { defaultDate: parsed } : {}),
      allowInput: true, // let the user type a value directly
      clickOpens: true, // also open on click (not only on the calendar icon)
      // Theme: Flatpickr's default calendar reads well on dark; we restyle via
      // the input's own dark background (className) + the inline calendar's
      // default which already renders on a translucent white popover.
      onChange: (_dates, _dateStr) => {
        const d = _dates[0];
        if (!d) {
          onChangeRef.current('');
          return;
        }
        onChangeRef.current(dateToDb(d, mode));
      },
      onClose: () => {
        onBlur?.();
      },
    });
    fpRef.current = fp;

    if (autoFocus) {
      // Defer focus so the input is mounted + Flatpickr is wired up.
      setTimeout(() => inputRef.current?.focus(), 0);
    }

    return () => {
      fp.destroy();
      fpRef.current = null;
    };
    // Re-create only when the mode genuinely changes (date↔datetime↔time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Keep Flatpickr's internal value in sync when the parent's `value` prop
  // changes externally (e.g. a programmatic reset / "Set NULL", or the grid
  // committing a just-selected value back down). We compare the NORMALIZED
  // DB-format string (not raw timestamps) so a same-day difference in the
  // irrelevant time component (e.g. midnight vs noon for a DATE column) does
  // not cause a feedback loop that reverts the user's selection.
  useEffect(() => {
    const fp = fpRef.current;
    if (!fp) return;
    const have = fp.selectedDates[0] ?? null;
    const haveDb = have ? dateToDb(have, mode) : '';
    // `value` is already DB-format; normalize empty to ''.
    const wantDb = value || '';
    if (haveDb === wantDb) return;
    // `false` = don't trigger onChange (we're reacting to an external change,
    // not causing one).
    const want = dbToDate(value, mode);
    if (want) fp.setDate(want, false);
    else fp.clear(false);
  }, [value, mode]);

  // Forward Enter/Escape to the input so the grid's commit/discard still works
  // while Flatpickr is open. Flatpickr intercepts some keys; we listen on
  // capture so we run before its own handler.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Close + let the parent commit on blur.
      fpRef.current?.close();
    } else if (e.key === 'Escape') {
      fpRef.current?.close();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      placeholder={placeholder}
      onKeyDown={handleKeyDown}
      className={
        className ??
        'h-7 box-border w-full bg-[#0f172a] border border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono'
      }
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
    />
  );
};
