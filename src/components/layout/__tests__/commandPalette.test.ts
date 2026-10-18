import { describe, it, expect } from 'vitest';
import { fuzzyScore } from '../CommandPalette';

describe('fuzzyScore', () => {
  it('ranks substring matches above scattered ones', () => {
    expect(fuzzyScore('user', 'public.users')).toBeGreaterThan(fuzzyScore('user', 'public.u_s_e_r_x'));
  });

  it('matches letters in order and rejects others', () => {
    expect(fuzzyScore('nsq', 'New SQL query')).toBeGreaterThan(0);
    expect(fuzzyScore('qsn', 'New SQL query')).toBe(-1);
  });

  it('scores an empty query as a match', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});
