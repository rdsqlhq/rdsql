import { describe, it, expect } from 'vitest';
import { tableAliases, statementAround, tablesInScope } from '../completion';

describe('tableAliases', () => {
  it('finds aliases with and without AS, qualified or not', () => {
    const a = tableAliases('SELECT u.id FROM users u JOIN public.orders AS o ON o.user_id = u.id');
    expect(a.get('u')).toEqual({ table: 'users' });
    expect(a.get('o')).toEqual({ schema: 'public', table: 'orders' });
  });

  it('ignores keywords that follow a table name', () => {
    const a = tableAliases('SELECT * FROM users WHERE id = 1');
    expect(a.size).toBe(0);
  });
});

describe('statementAround', () => {
  it('returns only the statement under the cursor', () => {
    const text = 'SELECT 1 FROM a; SELECT x. FROM b; SELECT 3 FROM c';
    const offset = text.indexOf('x.') + 2;
    expect(statementAround(text, offset).trim()).toBe('SELECT x. FROM b');
    expect(tablesInScope(statementAround(text, offset))).toEqual(['b']);
  });
});
