import { describe, it, expect } from 'vitest';
import {
  computeHealthScore,
  filterDiagnostics,
  deriveHealthState,
  categoryLabel,
  DiagnosticResult,
  Severity,
} from '../../../core/domain/health';

function diag(id: string, category: DiagnosticResult['category'], severity: Severity, title = id): DiagnosticResult {
  return {
    id,
    category,
    severity,
    title,
    description: '',
    affectedObjects: [],
    canAutoRepair: false,
    details: {},
  };
}

describe('computeHealthScore', () => {
  it('returns 100 for no diagnostics', () => {
    const { score, breakdown } = computeHealthScore([]);
    expect(score).toBe(100);
    expect(breakdown).toHaveLength(0);
  });

  it('deducts 5 for critical, 3 for warning, 1 for info', () => {
    const { score, breakdown } = computeHealthScore([
      diag('a', 'tables', 'warning'),
      diag('b', 'indexes', 'critical'),
      diag('c', 'indexes', 'info'),
    ]);
    // Tables: 97, Indexes: 94 → avg = 95.5 → round 96
    expect(score).toBe(96);
    expect(breakdown).toHaveLength(2);
  });

  it('clamps category scores at 0', () => {
    const many: DiagnosticResult[] = Array.from({ length: 25 }, (_, i) =>
      diag(`c${i}`, 'indexes', 'critical')
    );
    const { breakdown } = computeHealthScore(many);
    const idx = breakdown.find((b) => b.category === 'indexes')!;
    expect(idx.score).toBe(0);
  });

  it('keeps the score at most 100', () => {
    const { score } = computeHealthScore([diag('a', 'maintenance', 'info')]);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBe(99);
  });
});

describe('deriveHealthState', () => {
  it('critical dominates', () => {
    expect(deriveHealthState({ info: 5, warning: 3, critical: 1 })).toBe('critical');
  });
  it('warning next', () => {
    expect(deriveHealthState({ info: 5, warning: 2, critical: 0 })).toBe('warning');
  });
  it('notice for info-only', () => {
    expect(deriveHealthState({ info: 1, warning: 0, critical: 0 })).toBe('notice');
  });
  it('healthy when empty', () => {
    expect(deriveHealthState({ info: 0, warning: 0, critical: 0 })).toBe('healthy');
  });
});

describe('filterDiagnostics', () => {
  const sample: DiagnosticResult[] = [
    diag('1', 'indexes', 'critical', 'Unused index idx_a on orders'),
    diag('2', 'tables', 'warning', 'Table bloat on users'),
    diag('3', 'maintenance', 'info', 'Outdated statistics on products'),
  ];

  it('filters by severity', () => {
    expect(filterDiagnostics(sample, { severities: ['critical'] })).toHaveLength(1);
    expect(filterDiagnostics(sample, { severities: ['warning', 'critical'] })).toHaveLength(2);
  });

  it('filters by category', () => {
    expect(filterDiagnostics(sample, { categories: ['indexes'] })).toHaveLength(1);
  });

  it('searches title, description, affected objects, category label', () => {
    expect(filterDiagnostics(sample, { search: 'bloat' })).toHaveLength(1);
    expect(filterDiagnostics(sample, { search: 'indexes' })).toHaveLength(1); // category label
    expect(filterDiagnostics(sample, { search: 'orders' })).toHaveLength(1); // affected object
  });

  it('returns everything when no filter', () => {
    expect(filterDiagnostics(sample, {})).toHaveLength(3);
  });
});

describe('categoryLabel', () => {
  it('renders human labels', () => {
    expect(categoryLabel('foreignKeys')).toBe('Foreign Keys');
    expect(categoryLabel('tables')).toBe('Tables');
  });
});
