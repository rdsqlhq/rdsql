// Starts the Rust e2e bridge (src-tauri/src/commands/e2e_bridge.rs) and sends
// it the `invoke()` calls the modals make, so they run the real driver code.
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

let child: ChildProcess | null = null;
let ready: Promise<void> | null = null;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let nextId = 1;

/** Every call made, with its error if it failed — tests print these. */
export const calls: { cmd: string; sql?: string; err?: string; result?: unknown }[] = [];

function start(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolveReady, rejectReady) => {
    child = spawn('cargo', ['test', '--lib', 'e2e_bridge', '--', '--ignored', '--nocapture'], {
      cwd: path.resolve(__dirname, '../../src-tauri'),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.on('exit', (code) => {
      rejectReady(new Error(`e2e bridge exited (${code}) before it was ready`));
      // A panic in a command kills the bridge; fail what's waiting rather
      // than leaving the test to time out.
      for (const p of pending.values()) p.reject(`e2e bridge exited (${code}) — see the Rust panic above`);
      pending.clear();
      child = null;
      ready = null;
    });
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      if (!line.startsWith('@@')) return;
      const msg = JSON.parse(line.slice(2));
      if (msg.ready) return resolveReady();
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if ('err' in msg) p.reject(msg.err);
      else p.resolve(msg.ok);
    });
  });
  return ready;
}

export async function bridgeInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  await start();
  const id = nextId++;
  const { __meta: _meta, ...rest } = args;
  const sql = (rest.sql ?? (rest.request as { sql?: string } | undefined)?.sql) as string | undefined;
  const entry: { cmd: string; sql?: string; err?: string; result?: unknown } = { cmd, sql };
  calls.push(entry);
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => {
        if (cmd === 'db_migrate_run' || cmd === 'db_migrate_plan_tables') entry.result = v;
        resolve(v);
      },
      reject: (e) => {
        entry.err = String(e);
        reject(e);
      },
    });
    child!.stdin!.write(JSON.stringify({ id, cmd, args: rest }) + '\n');
  });
}

export function stopBridge(): void {
  child?.stdin?.end();
  child?.kill();
  child = null;
  ready = null;
}
