// Runs before every e2e test file: route Tauri APIs to the Rust bridge and
// the local file system, and give jsdom the bits the modals expect.
import { vi } from 'vitest';
import fs from 'node:fs';
import { bridgeInvoke } from './bridge';

/** The file the next native save/open dialog "picks". Set by the helpers. */
export const dialogState: { path: string | null } = { path: null };

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => bridgeInvoke(cmd, args),
}));
// Progress events (the migration wizard) aren't forwarded; nothing to listen to.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: async () => dialogState.path,
  save: async () => dialogState.path,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: async (p: string) => fs.readFileSync(p, 'utf8'),
  writeTextFile: async (p: string, text: string, opts?: { append?: boolean }) =>
    opts?.append ? fs.appendFileSync(p, text) : fs.writeFileSync(p, text),
  remove: async () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// safeInvoke only calls invoke() inside Tauri; otherwise it simulates.
(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
Element.prototype.scrollIntoView = () => {};
// The compare result list measures itself; jsdom has no layout to observe.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
