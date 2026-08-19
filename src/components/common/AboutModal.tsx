import React, { useEffect, useState } from 'react';
import { X, RefreshCw, Download, CheckCircle2, AlertTriangle, ExternalLink, Database, Bug } from 'lucide-react';
import { EditionBadge } from './EditionBadge';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useAppVersion } from '../../core/hooks/useAppVersion';

/** Discriminated result returned by the Rust `check_for_update` command.
 *  Mirrors `UpdateCheckOutcome` in src-tauri/src/commands/updater.rs. */
type CheckOutcome =
  | { status: 'available'; version: string; notes?: string | null; date?: string | null }
  | { status: 'up-to-date' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export const AboutModal: React.FC = () => {
  const { isAboutModalOpen, setAboutModalOpen } = useWorkspaceStore();
  useEscapeToClose(isAboutModalOpen ? () => setAboutModalOpen(false) : null);

  const version = useAppVersion();
  // Update panel state.
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  // The JS plugin's live Update resource — needed to actually download/install.
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  // Reset transient update-check state each time the modal opens.
  useEffect(() => {
    if (!isAboutModalOpen) return;
    setOutcome(null);
    setUpdate(null);
    setInstalling(false);
    setProgress(null);
    setInstallError(null);
  }, [isAboutModalOpen]);

  if (!isAboutModalOpen) return null;

  const close = () => setAboutModalOpen(false);

  /** Check via the Rust command for the status display, then separately
   *  resolve the JS plugin's `Update` resource (needed for install). The two
   *  are intentionally separate: the Rust command gives robust, mapped errors
   *  for the UI; the JS `Update` is what `downloadAndInstall` requires. */
  const handleCheck = async () => {
    setChecking(true);
    setOutcome(null);
    setUpdate(null);
    setInstallError(null);
    try {
      const res = await safeInvoke<CheckOutcome>('check_for_update');
      setOutcome(res);
      // If available, also grab the JS Update resource for the install button.
      if (res.status === 'available') {
        try {
          const u = await check();
          setUpdate(u);
        } catch {
          // Non-fatal: the user can still retry the check; install just won't
          // be one-click until the resource resolves.
        }
      }
    } catch (err: any) {
      setOutcome({ status: 'error', message: err?.message || String(err) });
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    if (!update) return;
    setInstalling(true);
    setProgress(null);
    setInstallError(null);
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            setProgress(total > 0 ? 0 : null);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (total > 0) setProgress(Math.min(100, Math.round((downloaded / total) * 100)));
            break;
          case 'Finished':
            setProgress(100);
            break;
        }
      });
      await relaunch();
    } catch (err: any) {
      setInstallError(err?.message || String(err));
      setInstalling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-md max-h-[85vh] bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[#1e293b] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-100">
            <Database className="w-4 h-4 text-blue-400" />
            About rdSQL Desktop
          </div>
          <button
            onClick={close}
            className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* App identity */}
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shrink-0 shadow-lg shadow-blue-500/30">
              <Database className="w-6 h-6 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-100">rdSQL Desktop</span>
                <EditionBadge size="md" />
              </div>
              <div className="text-xs text-slate-500 font-mono">Version {version}</div>
            </div>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Modern Database Workspace — a native desktop application for browsing, querying,
            comparing, and syncing databases.
          </p>

          {/* Links */}
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="https://github.com/rdsqlhq/rdsql"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              GitHub
            </a>
            <span className="text-slate-600">·</span>
            <a
              href="https://github.com/rdsqlhq/rdsql/issues/new?template=bug_report.yml"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Bug className="w-3 h-3" />
              Report Bug
            </a>
            <span className="text-slate-600">·</span>
            <span className="text-xs text-slate-500">com.rdsql.desktop</span>
          </div>

          {/* Update panel */}
          <div className="rounded-xl border border-[#1e293b] bg-[#06090e]/50 p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                Updates
              </div>
              <button
                onClick={handleCheck}
                disabled={checking || installing}
                className="px-2.5 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50 shrink-0"
              >
                <RefreshCw className={`w-3 h-3 ${checking ? 'animate-spin' : ''}`} />
                {checking ? 'Checking…' : 'Check for Updates'}
              </button>
            </div>

            {/* Status line */}
            {outcome && (
              <div className="text-xs">
                {outcome.status === 'up-to-date' && (
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    You're up to date — rdSQL is on the latest version.
                  </div>
                )}
                {outcome.status === 'unsupported' && (
                  <div className="flex items-center gap-1.5 text-slate-400">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    Update checks only run in the installed desktop app.
                  </div>
                )}
                {outcome.status === 'error' && (
                  <div className="flex items-start gap-1.5 text-red-400">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span className="break-all">{outcome.message}</span>
                  </div>
                )}
                {outcome.status === 'available' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-cyan-300">
                      <Download className="w-3.5 h-3.5 shrink-0" />
                      Update available — <span className="font-mono font-semibold">v{outcome.version}</span>
                    </div>
                    {outcome.notes && (
                      <pre className="text-[11px] text-slate-400 whitespace-pre-wrap max-h-32 overflow-y-auto bg-[#0a0f18] rounded p-2 border border-[#1e293b]">
                        {outcome.notes}
                      </pre>
                    )}
                    {progress !== null && (
                      <div className="space-y-1">
                        <div className="h-1.5 bg-[#1e293b] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-cyan-500 transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono">{progress}%</div>
                      </div>
                    )}
                    {installError && (
                      <div className="flex items-start gap-1.5 text-red-400">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span className="break-all">{installError}</span>
                      </div>
                    )}
                    {update && !installing && progress === null && (
                      <button
                        onClick={handleInstall}
                        className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-md shadow-cyan-600/30"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download &amp; Install
                      </button>
                    )}
                    {installing && (
                      <div className="text-[11px] text-slate-400 italic">Downloading — rdSQL will restart when done…</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#1e293b] bg-[#06090e] flex justify-end shrink-0">
          <button
            onClick={close}
            className="px-3 py-1.5 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-slate-200 text-xs font-semibold transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
