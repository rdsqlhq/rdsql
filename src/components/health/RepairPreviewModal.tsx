import React, { useEffect, useState } from 'react';
import { X, Copy, Play, AlertTriangle, ShieldCheck, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { DiagnosticResult, RepairPlan, RepairResult } from '../../core/domain/health';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { isDangerous } from '../../core/domain/health';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { cn } from '../../core/utils/cn';

/** SQL preview + confirm dialog. For dangerous operations it requires an
 *  explicit "Continue" (with a backup recommendation) per spec §8/§9. */
export const RepairPreviewModal: React.FC<{
  plan: RepairPlan;
  diagnostic: DiagnosticResult;
  onConfirm: (plan: RepairPlan) => Promise<RepairResult>;
  onClose: () => void;
}> = ({ plan, diagnostic, onConfirm, onClose }) => {
  useEscapeToClose(onClose);
  const [phase, setPhase] = useState<'preview' | 'confirm-danger' | 'executing' | 'result'>('preview');
  const [result, setResult] = useState<RepairResult | null>(null);
  const [copied, setCopied] = useState(false);
  const dangerous = isDangerous(plan);

  useEffect(() => {
    if (dangerous) setPhase('confirm-danger');
  }, [dangerous]);

  const handleExecute = async () => {
    setPhase('executing');
    try {
      const res = await onConfirm(plan);
      setResult(res);
      setPhase('result');
    } catch (err: any) {
      setResult({
        diagnosticId: plan.diagnosticId,
        success: false,
        executedSql: plan.sql,
        affectedRows: 0,
        durationMs: 0,
        error: err?.message ?? String(err),
      });
      setPhase('result');
    }
  };

  const copySql = () => {
    navigator.clipboard?.writeText(plan.sql.join(';\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2">
            {dangerous ? (
              <AlertTriangle className="w-4 h-4 text-rose-400" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            )}
            <span className="text-sm font-bold text-slate-100">{plan.title}</span>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Affected objects */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">Affected</div>
            <div className="flex flex-wrap gap-1.5">
              {plan.affectedObjects.length === 0 ? (
                <span className="text-[11px] text-slate-600">No specific objects</span>
              ) : (
                plan.affectedObjects.map((o) => (
                  <span key={o} className="px-2 py-0.5 rounded bg-[#141e33] text-[11px] text-slate-300 font-mono">
                    {o}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* SQL preview */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">SQL to execute</div>
              <button
                onClick={copySql}
                className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200"
              >
                <Copy className="w-3 h-3" />
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="bg-[#06090e] border border-[#1e293b] rounded-lg p-3 text-[11px] font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">
              {plan.sql.join(';\n')}
            </pre>
          </div>

          {/* Why it matters */}
          <div className="text-[11px] text-slate-400">
            <span className="text-slate-500 font-semibold">Why: </span>
            {diagnostic.description}
          </div>

          {/* Dangerous confirmation */}
          {phase === 'confirm-danger' && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 space-y-2">
              <div className="flex items-center gap-2 text-rose-300 font-semibold text-xs">
                <AlertTriangle className="w-4 h-4" />
                Dangerous Operation
              </div>
              <p className="text-[11px] text-slate-400">
                This operation will modify database data/schema. A backup is strongly recommended before continuing.
              </p>
            </div>
          )}

          {/* Result */}
          {phase === 'result' && result && (
            <div
              className={cn(
                'rounded-lg border p-3 space-y-2',
                result.success ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-rose-500/30 bg-rose-500/10'
              )}
            >
              <div className={cn('flex items-center gap-2 font-semibold text-xs', result.success ? 'text-emerald-300' : 'text-rose-300')}>
                {result.success ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                {result.success ? 'Repair completed successfully' : 'Repair failed'}
              </div>
              <div className="text-[11px] text-slate-400 space-y-0.5">
                <div>Duration: {result.durationMs} ms</div>
                {result.affectedRows > 0 && <div>Affected rows: {result.affectedRows}</div>}
                {result.verification && <div>Verification: {result.verification}</div>}
              </div>
              {result.error && <CopyableErrorBanner message={result.error} tone="rose" compact parseAsDbError />}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#1e293b]">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200">
            {phase === 'result' ? 'Close' : 'Cancel'}
          </button>
          {phase !== 'result' && (
            <>
              {dangerous && phase === 'confirm-danger' && (
                <button
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold"
                  title="Backups are handled via the Backup Studio"
                >
                  Create Backup
                </button>
              )}
              <button
                onClick={handleExecute}
                disabled={phase === 'executing'}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50',
                  dangerous ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'
                )}
              >
                {phase === 'executing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {phase === 'executing' ? 'Executing…' : dangerous ? 'Continue' : 'Execute'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
