import React, { useMemo, useState } from 'react';
import { Stethoscope, Play, Search, ChevronDown, ChevronRight, Wrench, Loader2 } from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useHealthStore } from '../../store/useHealthStore';
import {
  DiagnosticResult,
  Severity,
  DiagnosticCategory,
  categoryLabel,
  filterDiagnostics,
} from '../../core/domain/health';
import { SeverityBadge, EmptyState, SEVERITY_STYLES } from './primitives';
import { cn } from '../../core/utils/cn';

const ALL_SEVERITIES: Severity[] = ['critical', 'warning', 'info'];

export const DiagnosePanel: React.FC = () => {
  const { connections, activeConnectionId } = useConnectionStore();
  const { diagnostics, healthReport, loadingDiagnostics, runDiagnostics } = useHealthStore();
  const activeConn = connections.find((c) => c.id === activeConnectionId);

  const [search, setSearch] = useState('');
  const [sevFilter, setSevFilter] = useState<Set<Severity>>(new Set());
  const [catFilter, setCatFilter] = useState<Set<DiagnosticCategory>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(
    () => filterDiagnostics(diagnostics, {
      severities: sevFilter.size ? Array.from(sevFilter) : undefined,
      categories: catFilter.size ? Array.from(catFilter) : undefined,
      search,
    }),
    [diagnostics, sevFilter, catFilter, search]
  );

  const categories = useMemo(() => {
    const set = new Set<DiagnosticCategory>();
    diagnostics.forEach((d) => set.add(d.category));
    return Array.from(set);
  }, [diagnostics]);

  const handleRun = async () => {
    if (!activeConn) return;
    await runDiagnostics(activeConn, { heavy: true });
  };

  const toggleSev = (s: Severity) =>
    setSevFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const toggleCat = (c: DiagnosticCategory) =>
    setCatFilter((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="p-5 space-y-4">
      {/* Run + overall health */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Stethoscope className="w-4 h-4 text-cyan-400" />
            Database Diagnostics
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Run engine-aware integrity, index, and maintenance checks. Heavy checks (integrity, bloat) are included.
          </p>
        </div>
        <button
          onClick={handleRun}
          disabled={loadingDiagnostics || !activeConn}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
        >
          {loadingDiagnostics ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {loadingDiagnostics ? 'Running…' : 'Run Diagnose'}
        </button>
      </div>

      {/* Overall health counts */}
      {healthReport && (
        <div className="grid grid-cols-3 gap-3">
          <CountTile label="Healthy" count={0} severity="info" total={diagnostics.length} />
          <CountTile label="Warnings" count={healthReport.issueCounts.warning} severity="warning" total={diagnostics.length} />
          <CountTile label="Critical" count={healthReport.issueCounts.critical} severity="critical" total={diagnostics.length} />
        </div>
      )}

      {loadingDiagnostics && (
        <div className="p-4 rounded-xl border border-[#1e293b] bg-[#0a0f18] space-y-2">
          <RunProgressChecklist />
        </div>
      )}

      {/* Filters */}
      {diagnostics.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex items-center bg-[#0d1117] rounded-lg border border-[#1e293b] focus-within:border-cyan-500/40">
            <Search className="w-3 h-3 text-slate-500 absolute left-2.5" />
            <input
              type="text"
              placeholder="Search issues…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="bg-transparent text-[11px] text-slate-300 pl-7 pr-2 py-1.5 w-48 focus:outline-none placeholder:text-slate-600"
            />
          </div>
          <div className="flex items-center gap-1">
            {ALL_SEVERITIES.map((s) => (
              <FilterChip key={s} active={sevFilter.has(s)} onClick={() => toggleSev(s)} className={SEVERITY_STYLES[s].text}>
                {SEVERITY_STYLES[s].label}
              </FilterChip>
            ))}
          </div>
          {categories.length > 1 && (
            <div className="flex items-center gap-1">
              {categories.map((c) => (
                <FilterChip key={c} active={catFilter.has(c)} onClick={() => toggleCat(c)}>
                  {categoryLabel(c)}
                </FilterChip>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Issues list / empty states */}
      {!loadingDiagnostics && diagnostics.length === 0 && (
        <EmptyState
          title={search || sevFilter.size || catFilter.size ? 'No matching issues' : 'Database is healthy'}
          message={
            search || sevFilter.size || catFilter.size
              ? 'No issues match the current filters.'
              : 'No integrity, schema, index, or maintenance issues were detected. Run diagnostics to verify.'
          }
        />
      )}

      <div className="space-y-2">
        {filtered.map((d) => (
          <IssueRow
            key={d.id}
            diagnostic={d}
            expanded={expanded.has(d.id)}
            onToggle={() => toggleExpand(d.id)}
          />
        ))}
      </div>
    </div>
  );
};

const CountTile: React.FC<{ label: string; count: number; severity: Severity; total: number }> = ({ label, count, severity }) => {
  const s = SEVERITY_STYLES[severity];
  return (
    <div className={cn('p-3 rounded-xl border bg-[#0a0f18]', s.border)}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className={cn('text-xl font-bold', s.text)}>{count}</div>
    </div>
  );
};

const FilterChip: React.FC<{ active: boolean; onClick: () => void; className?: string; children: React.ReactNode }> = ({
  active,
  onClick,
  className,
  children,
}) => (
  <button
    onClick={onClick}
    className={cn(
      'px-2 py-1 rounded-md text-[10px] font-medium border transition-colors',
      active
        ? 'bg-cyan-500/20 border-cyan-500/30 text-cyan-300'
        : 'bg-[#0d1117] border-[#1e293b] text-slate-500 hover:text-slate-300',
      className
    )}
  >
    {children}
  </button>
);

const IssueRow: React.FC<{ diagnostic: DiagnosticResult; expanded: boolean; onToggle: () => void }> = ({
  diagnostic: d,
  expanded,
  onToggle,
}) => {
  const s = SEVERITY_STYLES[d.severity];
  return (
    <div className={cn('rounded-xl border bg-[#0a0f18] overflow-hidden', s.border)}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#0d1117] text-left">
        <SeverityBadge severity={d.severity} />
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-slate-200 truncate">{d.title}</div>
          <div className="text-[11px] text-slate-500 truncate">
            {categoryLabel(d.category)}
            {d.affectedObjects.length > 0 && ` · ${d.affectedObjects.slice(0, 2).join(', ')}${d.affectedObjects.length > 2 ? '…' : ''}`}
          </div>
        </div>
        {d.canAutoRepair && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[9px] font-bold uppercase shrink-0">
            <Wrench className="w-2.5 h-2.5" />
            Fix
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-3">
          <p className="text-[11px] text-slate-400">{d.description}</p>
          {d.details && Object.keys(d.details).length > 0 && (
            <div className="rounded-lg bg-[#06090e] border border-[#1e293b] p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-slate-600 font-semibold mb-1.5">Details</div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                {Object.entries(d.details).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between text-[11px]">
                    <dt className="text-slate-500 font-mono">{k}</dt>
                    <dd className="text-slate-300 font-mono truncate ml-2">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {d.recommendation && (
            <div className="text-[11px] text-slate-400">
              <span className="text-slate-500 font-semibold">Recommended: </span>
              {d.recommendation}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Static progress checklist shown while a diagnostic run is in flight. */
const RunProgressChecklist: React.FC = () => (
  <div className="space-y-1.5 text-[11px] text-slate-400">
    <div className="flex items-center gap-2">
      <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
      Running engine-aware checks…
    </div>
    <ChecklistRow label="Connection" done />
    <ChecklistRow label="Schema" done />
    <ChecklistRow label="Tables" done />
    <ChecklistRow label="Indexes" pending />
    <ChecklistRow label="Integrity checks" pending expensive />
    <ChecklistRow label="Performance" pending />
  </div>
);

const ChecklistRow: React.FC<{ label: string; done?: boolean; pending?: boolean; expensive?: boolean }> = ({ label, done, pending, expensive }) => (
  <div className="flex items-center gap-2 pl-5">
    {done ? (
      <span className="w-3 h-3 text-emerald-400">✓</span>
    ) : pending ? (
      <Loader2 className="w-3 h-3 animate-spin text-slate-500" />
    ) : (
      <span className="w-3 h-3 rounded-full border border-slate-700" />
    )}
    <span className={done ? 'text-slate-300' : 'text-slate-500'}>{label}</span>
    {expensive && <span className="text-[9px] text-amber-500/70 uppercase">expensive</span>}
  </div>
);
