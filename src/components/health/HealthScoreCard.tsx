import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useHealthStore } from '../../store/useHealthStore';
import { categoryLabel } from '../../core/domain/health';
import { cn } from '../../core/utils/cn';

/** Transparent health score gauge + breakdown. Clicking a category reveals the
 *  specific deductions that lowered the score (spec §17). */
export const HealthScoreCard: React.FC = () => {
  const { healthReport } = useHealthStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!healthReport) {
    return (
      <div className="text-xs text-slate-500 py-6 text-center">
        Run diagnostics to compute a health score.
      </div>
    );
  }

  const score = healthReport.score;
  const scoreColor =
    score >= 95 ? 'text-emerald-400' : score >= 80 ? 'text-sky-400' : score >= 60 ? 'text-amber-400' : 'text-rose-400';
  const ringColor =
    score >= 95 ? '#34d399' : score >= 80 ? '#38bdf8' : score >= 60 ? '#fbbf24' : '#fb7185';

  const toggle = (cat: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  // SVG gauge: a semicircle arc from 0–100.
  const radius = 52;
  const circumference = Math.PI * radius; // half circle
  const dash = (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      {/* Gauge */}
      <div className="relative">
        <svg width="140" height="80" viewBox="0 0 140 80">
          <path
            d="M 14 70 A 52 52 0 0 1 126 70"
            fill="none"
            stroke="#1e293b"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <path
            d="M 14 70 A 52 52 0 0 1 126 70"
            fill="none"
            stroke={ringColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            style={{ transition: 'stroke-dasharray 0.4s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-end pb-1">
          <span className={cn('text-2xl font-bold', scoreColor)}>{score}</span>
          <span className="text-[9px] text-slate-500 -mt-1">/ 100</span>
        </div>
      </div>

      {/* Breakdown */}
      <div className="w-full mt-3 space-y-1">
        {healthReport.breakdown.length === 0 && (
          <div className="text-[11px] text-emerald-400 text-center py-2">No deductions — perfect score</div>
        )}
        {healthReport.breakdown.map((b) => {
          const catLabel = categoryLabel(b.category);
          const isExpanded = expanded.has(b.category);
          return (
            <div key={b.category} className="rounded-lg border border-[#1e293b] overflow-hidden">
              <button
                onClick={() => toggle(b.category)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#141e33]"
              >
                <span className="flex items-center gap-1.5 text-xs text-slate-300">
                  {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  {catLabel}
                </span>
                <span className={cn('text-xs font-bold', b.score >= 95 ? 'text-emerald-400' : b.score >= 80 ? 'text-amber-400' : 'text-rose-400')}>
                  {b.score}
                </span>
              </button>
              {isExpanded && (
                <div className="px-3 pb-2 space-y-1">
                  {b.deductions.map((d) => (
                    <div key={d.diagnosticId} className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400 truncate mr-2" title={d.reason}>
                        {d.reason}
                      </span>
                      <span className="text-rose-400 font-mono shrink-0">−{d.points}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
