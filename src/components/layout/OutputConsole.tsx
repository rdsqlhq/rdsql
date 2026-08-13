import React from 'react';
import { Terminal, CheckCircle2, AlertCircle, Copy, Check } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

export const OutputConsole: React.FC = () => {
  const { isOutputConsoleOpen } = useWorkspaceStore();
  const [copied, setCopied] = React.useState(false);

  if (!isOutputConsoleOpen) return null;

  const lines = [
    '[SYSTEM] rdSQL runtime initialized (IPC Tauri v2 ready).',
    '[INFO] Keyring secure store loaded cleanly.',
  ];

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied/unavailable — silently no-op.
    }
  };

  return (
    <div className="h-32 bg-[#06090e] border-t border-[#1e293b] flex flex-col font-mono text-xs">
      <div className="px-3 py-1 bg-[#0a0f18] border-b border-[#1e293b] flex items-center justify-between text-slate-400 text-[11px] select-none">
        <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-slate-300">
          <Terminal className="w-3.5 h-3.5 text-blue-400" />
          Output Console
        </div>
        <button
          onClick={handleCopyAll}
          className="flex items-center gap-1 text-slate-500 hover:text-slate-200 transition-colors"
          title="Copy all output"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      <div className="flex-1 p-3 overflow-y-auto space-y-1 text-slate-300 select-text cursor-text">
        <div className="flex items-center gap-2 text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>{lines[0]}</span>
        </div>
        <div className="text-slate-500">
          {lines[1]}
        </div>
      </div>
    </div>
  );
};
