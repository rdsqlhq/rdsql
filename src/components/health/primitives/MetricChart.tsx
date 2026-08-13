import React, { useMemo } from 'react';
import type { MetricSample } from '../../../core/domain/health';

/** Lightweight inline-SVG line chart. No external chart dependency — keeps the
 *  bundle lean and matches the bespoke component aesthetic of the rest of
 *  RDSQL. Renders gracefully when there are 0, 1, or few samples. */
export const MetricChart: React.FC<{
  samples: MetricSample[];
  height?: number;
  color?: string;
  formatValue?: (v: number) => string;
  /** Optional y-axis max override (e.g. 100 for a percentage). */
  yMax?: number;
}> = ({ samples, height = 120, color = '#22d3ee', formatValue, yMax }) => {
  const width = 600; // viewBox width; scales responsively via CSS
  const padX = 8;
  const padY = 10;

  const { path, area, last, min, max } = useMemo(() => {
    if (samples.length === 0) return { path: '', area: '', last: null, min: 0, max: 0 };
    const values = samples.map((s) => s.value);
    const lo = Math.min(...values);
    const hi = yMax ?? Math.max(...values, 1);
    const range = hi - Math.min(lo, 0) || 1;
    const baseline = Math.min(lo, 0);
    const n = samples.length;
    const xStep = n > 1 ? (width - padX * 2) / (n - 1) : 0;

    const points = samples.map((s, i) => {
      const x = padX + (n > 1 ? i * xStep : (width - padX * 2) / 2);
      const y = padY + (height - padY * 2) * (1 - (s.value - baseline) / range);
      return { x, y };
    });

    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const areaD = `${d} L ${points[points.length - 1].x.toFixed(1)} ${height - padY} L ${points[0].x.toFixed(1)} ${height - padY} Z`;
    return { path: d, area: areaD, last: points[points.length - 1], min: lo, max: hi };
  }, [samples, height, yMax]);

  if (samples.length === 0) {
    return (
      <div className="flex items-center justify-center text-[11px] text-slate-600" style={{ height }}>
        No historical data yet
      </div>
    );
  }

  const lastSample = samples[samples.length - 1];

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="metric-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && <path d={area} fill="url(#metric-fill)" stroke="none" />}
        {path && <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />}
        {last && <circle cx={last.x} cy={last.y} r="2.5" fill={color} />}
      </svg>
      <div className="flex items-center justify-between mt-1 px-1 text-[10px] text-slate-500">
        <span>min: {formatValue ? formatValue(min) : min}</span>
        <span className="font-semibold text-slate-300">
          {formatValue ? formatValue(lastSample.value) : lastSample.value}
        </span>
        <span>max: {formatValue ? formatValue(max) : max}</span>
      </div>
    </div>
  );
};
