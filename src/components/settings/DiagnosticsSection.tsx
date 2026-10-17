import React, { useEffect, useState } from 'react';
import { FolderOpen, Copy, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppVersion } from '../../core/hooks/useAppVersion';
import { inTauri } from '../../core/tauri/ipc';
import { copyToClipboard } from '../../core/utils/clipboard';

/**
 * Local log file access for bug reports. See src-tauri/src/commands/app_log.rs.
 */
export const DiagnosticsSection: React.FC<{ flash: (msg: string) => void }> = ({ flash }) => {
  const version = useAppVersion();
  const [logDir, setLogDir] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    invoke<string>('app_log_dir')
      .then(setLogDir)
      .catch(() => undefined);
  }, []);

  if (!inTauri()) return null;

  const openLogs = () => {
    invoke('app_log_open_dir').catch((e) => flash(`Couldn't open logs folder: ${e}`));
  };

  const copyDiagnostics = async () => {
    const log = await invoke<string>('app_log_read').catch(() => '');
    const text = [
      `rdSQL Desktop ${version || 'unknown'}`,
      `Platform: ${navigator.userAgent}`,
      '',
      '--- recent log (credentials scrubbed) ---',
      log.trim() || '(empty)',
    ].join('\n');
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex flex-col gap-2 pt-3 border-t border-[#1e293b]">
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Diagnostics</div>
      <p className="text-[10px] text-slate-600 leading-relaxed">
        Errors are written to a local log file and never sent anywhere. When reporting a bug, copy the diagnostics and paste them into
        the GitHub issue — check them first, they may include table or host names.
      </p>
      {logDir && <div className="font-mono text-[10px] text-slate-500 break-all">{logDir}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={openLogs}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] w-fit"
        >
          <FolderOpen className="w-3.5 h-3.5" /> Open Logs Folder
        </button>
        <button
          onClick={copyDiagnostics}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] w-fit"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy Diagnostics'}
        </button>
      </div>
    </div>
  );
};
