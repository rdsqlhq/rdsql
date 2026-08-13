import { describe, it, expect } from 'vitest';
import { isDangerous, RepairPlan } from '../../../core/domain/health';
import { formatBytes, formatNumber, formatRatio } from '../format';

describe('isDangerous', () => {
  const base: RepairPlan = {
    diagnosticId: 'd1',
    title: 't',
    sql: [],
    affectedObjects: [],
    riskLevel: 'safe',
    requiresBackup: false,
  };

  it('safe plans are not dangerous', () => {
    expect(isDangerous({ ...base, riskLevel: 'safe' })).toBe(false);
  });

  it('dangerous plans are flagged', () => {
    expect(isDangerous({ ...base, riskLevel: 'dangerous', requiresBackup: true })).toBe(true);
  });

  it('a drop-index plan is dangerous and requires backup', () => {
    const plan: RepairPlan = {
      diagnosticId: 'd1',
      title: 'DROP redundant/unused indexes (destructive)',
      sql: ['DROP INDEX public.idx_orders_created_at;'],
      affectedObjects: ['public.idx_orders_created_at'],
      riskLevel: 'dangerous',
      requiresBackup: true,
    };
    expect(isDangerous(plan)).toBe(true);
    expect(plan.requiresBackup).toBe(true);
  });
});

describe('format helpers', () => {
  it('formatBytes scales units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(5 * 1073741824)).toBe('5 GB');
  });

  it('formatNumber uses compact notation for large numbers', () => {
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(12400000)).toBe('12.4M');
  });

  it('formatRatio renders a percentage', () => {
    expect(formatRatio(0.984)).toBe('98.4%');
    expect(formatRatio(null)).toBe('—');
  });
});
