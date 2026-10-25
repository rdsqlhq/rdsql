// The Compare & Sync screen: the setup card before a compare, the result
// after it, and "New compare" back to the setup. Uses the default stack's
// Postgres servers (seeded source vs an empty target database).
import { afterAll, expect, test } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { stopBridge } from './bridge';
import { conn, freshDatabase, servers } from './helpers';

afterAll(() => stopBridge());

const wait = async (el: HTMLElement, fn: () => boolean, what: string, ms = 60_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}: ${el.textContent?.slice(0, 600)}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
  }
};
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

test('setup card → compare → result → new compare', async () => {
  await freshDatabase(conn(servers.pgDst), 'compare_target');
  const source = conn(servers.pgSrc);
  const target = conn(servers.pgDst, 'compare_target');
  const { useConnectionStore } = await import('../../src/store/useConnectionStore');
  useConnectionStore.setState({ connections: [source, target] });
  const { MigrationStudio } = await import('../../src/components/migration/MigrationStudio');

  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(<MigrationStudio />));

  // Before comparing: the setup card, with both sides and no header pickers.
  expect(el.textContent).toContain('Compare two databases');
  expect(el.textContent).toContain('Read only. Never written to.');
  expect(el.textContent).toContain('Applying a sync writes changes here.');
  expect(button(el, 'New compare')).toBeUndefined();

  await wait(el, () => !!button(el, 'Compare') && !button(el, 'Compare')!.disabled, 'the Compare button');
  await act(async () => button(el, 'Compare')!.click());

  // After: the table list, the compact pickers and "New compare".
  await wait(el, () => el.textContent!.includes('customers') && !!button(el, 'New compare'), 'the compare result');
  expect(el.textContent).not.toContain('Compare two databases');

  await act(async () => button(el, 'New compare')!.click());
  expect(el.textContent).toContain('Compare two databases');

  act(() => root.unmount());
}, 300_000);
