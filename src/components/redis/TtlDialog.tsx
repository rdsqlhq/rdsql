import React, { useState } from 'react';
import { X, Clock } from 'lucide-react';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';

type Unit = 'seconds' | 'minutes' | 'hours';
const UNIT_SECONDS: Record<Unit, number> = { seconds: 1, minutes: 60, hours: 3600 };

/** Preset chips, each expressed as raw seconds for `EXPIRE`. */
const PRESETS: { label: string; seconds: number }[] = [
  { label: '5m', seconds: 5 * 60 },
  { label: '15m', seconds: 15 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '6h', seconds: 6 * 60 * 60 },
  { label: '24h', seconds: 24 * 60 * 60 },
];

interface Props {
  keyName: string;
  /** Current TTL in ms, or `undefined` for "no TTL" — seeds the initial input. */
  currentTtlMs?: number;
  onClose: () => void;
  onApply: (seconds: number) => Promise<void>;
  onRemoveTtl: () => Promise<void>;
  /** "Expire Now" — implemented by the caller as an immediate delete, which
   *  is functionally identical to expiring a key this instant. */
  onExpireNow: () => Promise<void>;
}

export const TtlDialog: React.FC<Props> = ({ keyName, currentTtlMs, onClose, onApply, onRemoveTtl, onExpireNow }) => {
  useEscapeToClose(onClose);
  const [amount, setAmount] = useState(currentTtlMs ? String(Math.max(1, Math.round(currentTtlMs / 1000))) : '3600');
  const [unit, setUnit] = useState<Unit>('seconds');
  const [busy, setBusy] = useState(false);

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const seconds = Math.round(Number(amount || 0) * UNIT_SECONDS[unit]);
  const canApply = seconds > 0 && !Number.isNaN(seconds);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <Clock className="w-4 h-4 text-red-400" />
            Set expiration
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-[11px] text-slate-500 font-mono truncate" title={keyName}>{keyName}</div>

          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="flex-1 bg-[#0f172a] border border-[#1e293b] focus:border-red-500 rounded px-2.5 py-1.5 text-[12px] text-slate-100 focus:outline-none"
            />
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as Unit)}
              className="bg-[#0f172a] border border-[#1e293b] focus:border-red-500 rounded px-2 py-1.5 text-[12px] text-slate-100 focus:outline-none"
            >
              <option value="seconds">seconds</option>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </div>

          <div>
            <div className="text-[10px] text-slate-500 mb-1.5">Presets</div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => withBusy(() => onApply(p.seconds))}
                  disabled={busy}
                  className="px-2.5 py-1 rounded text-[11px] font-medium bg-[#1e293b] text-slate-300 hover:bg-red-500/20 hover:text-red-300 transition-colors disabled:opacity-50"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-[#1e293b]">
            <button
              type="button"
              onClick={() => withBusy(onRemoveTtl)}
              disabled={busy}
              className="flex-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#1e293b] text-slate-300 hover:bg-[#263449] transition-colors disabled:opacity-50"
            >
              Remove TTL
            </button>
            <button
              type="button"
              onClick={() => withBusy(onExpireNow)}
              disabled={busy}
              className="flex-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 transition-colors disabled:opacity-50"
            >
              Expire Now
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#1e293b]">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200">
            Cancel
          </button>
          <button
            onClick={() => withBusy(() => onApply(seconds))}
            disabled={!canApply || busy}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-white text-xs font-semibold bg-red-600 hover:bg-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};
