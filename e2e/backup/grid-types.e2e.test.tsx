// The data grid's view of Postgres types the driver only sends in binary
// (interval, inet, cidr, macaddr, bit, varbit, timetz, money, and arrays of
// them). Each value must read the way Postgres displays it, never NULL.
import { afterAll, expect, test } from 'vitest';
import { stopBridge } from './bridge';
import { conn, query, servers } from './helpers';

afterAll(() => stopBridge());

test('binary-only Postgres types read as Postgres displays them, on every row', async () => {
  const source = conn(servers.pgSrc);
  const cols = ['dur', 'ip', 'net', 'mac', 'bits', 'vbits', 't_tz'];
  // format('%s', x) is Postgres' display form (inet_out etc.); x::text can
  // differ (inet::text always adds the /32 mask).
  const select = cols.map((c) => `"${c}", format('%s', "${c}") AS "${c}_text"`).join(', ');
  const res = await query(source, `SELECT ${select}, money_val::numeric::text AS money_text, money_val, ARRAY[ip, ip] AS ips, format('%s', ARRAY[ip, ip]) AS ips_text FROM "TypeZoo" ORDER BY id`);
  expect(res.rows.length).toBe(10000);
  const at = (name: string) => res.columns.findIndex((c) => c.name === name);
  let checked = 0;
  for (const row of res.rows) {
    for (const c of cols) {
      expect(row[at(c)], c).toBe(row[at(`${c}_text`)]);
      checked++;
    }
    // money: the amount without the locale's currency symbol.
    expect(Number(row[at('money_val')])).toBe(Number(row[at('money_text')]));
    expect(`{${(row[at('ips')] as unknown as string[]).join(',')}}`).toBe(row[at('ips_text')]);
  }
  expect(checked).toBe(70000);
}, 120_000);
