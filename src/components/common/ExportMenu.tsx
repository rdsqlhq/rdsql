import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Copy } from 'lucide-react';
import { EXPORT_FORMATS, type ExportFormat } from '../../core/export/resultExport';

interface ExportMenuProps {
  onExport: (format: ExportFormat) => void;
  /** Adds a "Copy as table" entry (tab-separated, pastes into spreadsheets). */
  onCopy?: () => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}

/** Download button with a format menu. The menu renders in a portal so a
 *  scrolling toolbar (overflow-x: auto) can't clip it. */
export const ExportMenu: React.FC<ExportMenuProps> = ({ onExport, onCopy, disabled, busy, title = 'Export' }) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const toggle = () => {
    if (pos) {
      setPos(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  const pick = (fn: () => void) => {
    setPos(null);
    fn();
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={disabled || busy}
        className="p-1 rounded-lg hover:bg-[#1e293b] disabled:opacity-50 disabled:cursor-not-allowed text-slate-400 transition-colors shrink-0"
        title={busy ? 'Exporting…' : title}
      >
        <Download className={`w-3.5 h-3.5 ${busy ? 'animate-pulse' : ''}`} />
      </button>
      {pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[99998]" onClick={() => setPos(null)} />
            <div
              style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 99999 }}
              className="min-w-[200px] bg-[#0a0f18] border border-[#1e293b] rounded-lg shadow-2xl py-1 text-xs"
            >
              {onCopy && (
                <button
                  onClick={() => pick(onCopy)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-[#141e33]"
                >
                  <Copy className="w-3.5 h-3.5 text-slate-400" />
                  Copy as table
                </button>
              )}
              {EXPORT_FORMATS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => pick(() => onExport(f.id))}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-[#141e33]"
                >
                  <Download className="w-3.5 h-3.5 text-slate-400" />
                  Export {f.label}…
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
};
