import React, { useMemo, useState } from 'react';
import { Wrench, AlertTriangle, Eye, ShieldAlert, CheckCircle2, Loader2 } from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useHealthStore } from '../../store/useHealthStore';
import { useRepairHistoryStore, buildHistoryEntry } from '../../store/useRepairHistoryStore';
import { useToastStore } from '../../store/useToastStore';
import { DiagnosticResult, RepairPlan, RepairResult, categoryLabel } from '../../core/domain/health';
import { SeverityBadge, EmptyState, LoadingState } from './primitives';
import { RepairPreviewModal } from './RepairPreviewModal';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { parseDbError } from '../../core/sql/dbError';
import { cn } from '../../core/utils/cn';

export const RepairCenter: React.FC<{ onJumpToDiagnostics: () => void }> = ({ onJumpToDiagnostics }) => {
  const { connections, activeConnectionId } = useConnectionStore();
  const { diagnostics, healthReport, loadingDiagnostics, runDiagnostics } = useHealthStore();
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const [preview, setPreview] = useState<{ plan: RepairPlan; diagnostic: DiagnosticResult } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const repairable = useMemo(() => diagnostics.filter((d) => d.canAutoRepair), [diagnostics]);
  const manual = useMemo(() => diagnostics.filter((d) => !d.canAutoRepair), [diagnostics]);

  const handlePreview = async (d: DiagnosticResult) => {
    if (!activeConn || !d.repairAction) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const plan = await useHealthStore.getState().previewRepair(activeConn, {
        diagnosticId: d.id,
        repairAction: d.repairAction,
        affectedObjects: d.affectedObjects,
        details: d.details ?? {},
      });
      setPreview({ plan, diagnostic: d });
    } catch (err: any) {
      setPreviewError(err?.message ?? String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirm = async (plan: RepairPlan): Promise<RepairResult> => {
    if (!activeConn || !preview) {
      throw new Error('No active connection or preview');
    }
    const result = await useHealthStore.getState().executeRepair(activeConn, plan);
    useRepairHistoryStore.getState().addEntry(
      buildHistoryEntry({
        connectionId: activeConn.id,
        connectionName: activeConn.name,
        engine: activeConn.engine,
        operation: plan.title,
        affectedObjects: plan.affectedObjects,
        result,
      })
    );
    if (result.success) {
      useToastStore.getState().push({
        severity: 'success',
        title: 'Repair completed',
        message: plan.title,
      });
    } else {
      useToastStore.getState().push({
        severity: 'error',
        title: 'Repair failed',
        message: result.error ? parseDbError(result.error).message : plan.title,
      });
    }
    setPreview(null);
    // Re-run lightweight diagnostics to reflect the change.
    await runDiagnostics(activeConn, { heavy: false });
    return result;
  };

  if (loadingDiagnostics && diagnostics.length === 0) {
    return <LoadingState message="Loading diagnostics…" />;
  }

  if (!healthReport) {
    return (
      <div className="p-5">
        <EmptyState
          title="No diagnostics yet"
          message="Run diagnostics first to identify repairable issues."
          icon={Wrench}
        >
          <button
            onClick={() => activeConn && runDiagnostics(activeConn, { heavy: true })}
            className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold"
          >
            Run Diagnose
          </button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-emerald-400" />
            Repair Center
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Every repair follows: detect → preview → confirm → execute → verify. Destructive operations require a backup recommendation.
          </p>
        </div>
      </div>

      {previewError && (
        <CopyableErrorBanner message={previewError} tone="rose" parseAsDbError />
      )}

      {/* Repairable issues */}
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 mb-2">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {repairable.length} issue{repairable.length === 1 ? '' : 's'} can be repaired
        </div>
        {repairable.length === 0 ? (
          <div className="text-[11px] text-slate-500 px-1">No automatically repairable issues detected.</div>
        ) : (
          <div className="space-y-2">
            {repairable.map((d) => (
              <RepairableRow key={d.id} d={d} onPreview={() => handlePreview(d)} previewing={previewing} />
            ))}
          </div>
        )}
      </div>

      {/* Manual-review issues */}
      {manual.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 mb-2">
            <AlertTriangle className="w-3.5 h-3.5" />
            {manual.length} issue{manual.length === 1 ? '' : 's'} require manual review
          </div>
          <div className="space-y-2">
            {manual.map((d) => (
              <ManualRow key={d.id} d={d} />
            ))}
          </div>
        </div>
      )}

      {diagnostics.length === 0 && (
        <EmptyState title="Nothing to repair" message="Database is healthy. No issues detected." />
      )}

      {preview && (
        <RepairPreviewModal
          plan={preview.plan}
          diagnostic={preview.diagnostic}
          onConfirm={handleConfirm}
          onClose={() => setPreview(null)}
        />
      )}

      {/* Helpful nudge if no diagnostics run yet */}
      {!loadingDiagnostics && diagnostics.length === 0 && (
        <button
          onClick={onJumpToDiagnostics}
          className="text-[11px] text-cyan-400 hover:text-cyan-300"
        >
          Go to Diagnostics →
        </button>
      )}
    </div>
  );
};

const RepairableRow: React.FC<{ d: DiagnosticResult; onPreview: () => void; previewing: boolean }> = ({ d, onPreview, previewing }) => (
  <div className="rounded-xl border border-emerald-500/20 bg-[#0a0f18] px-4 py-3 flex items-center gap-3">
    <SeverityBadge severity={d.severity} />
    <div className="flex-1 min-w-0">
      <div className="text-xs font-semibold text-slate-200 truncate">{d.title}</div>
      <div className="text-[11px] text-slate-500 truncate">
        {categoryLabel(d.category)} · {d.affectedObjects.slice(0, 2).join(', ')}
      </div>
    </div>
    <button
      onClick={onPreview}
      disabled={previewing}
      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-[11px] font-semibold text-slate-200 border border-[#1e293b] disabled:opacity-50"
    >
      {previewing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
      Preview Fix
    </button>
  </div>
);

const ManualRow: React.FC<{ d: DiagnosticResult }> = ({ d }) => (
  <div className="rounded-xl border border-amber-500/15 bg-[#0a0f18] px-4 py-3 flex items-center gap-3">
    <SeverityBadge severity={d.severity} />
    <div className="flex-1 min-w-0">
      <div className="text-xs font-semibold text-slate-200 truncate">{d.title}</div>
      <div className="text-[11px] text-slate-500 truncate">
        {categoryLabel(d.category)} · {d.affectedObjects.slice(0, 2).join(', ')}
      </div>
    </div>
    <span className="flex items-center gap-1 text-[10px] text-amber-400/70 shrink-0">
      <ShieldAlert className="w-3 h-3" />
      Manual
    </span>
  </div>
);
