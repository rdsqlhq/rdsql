/**
 * TransferManager — framework-agnostic upload/download coordinator.
 *
 * The heavy lifting (multipart, streaming, retry, cancellation) lives in Rust
 * (`commands::s3`). This module issues transfer commands via an injectable IPC
 * adapter, subscribes to `s3_transfer_progress` events, tracks per-transfer
 * state (bytes, speed, ETA), and exposes `cancel(id)`. Retry/backoff happens
 * inside Rust; the manager only surfaces the resulting `retrying` status.
 *
 * It is deliberately free of React so it can be unit-tested against a mock IPC
 * adapter. `useTransferManager` (in `core/storage/react.ts`) wraps it for the UI.
 *
 * SECURITY: the `config` passed to `upload`/`download` carries the decrypted
 * secret for this transfer only (see `core/storage/secrets`). It is forwarded
 * to Rust per-call and never stored here.
 */
import type {
  TransferTask,
  TransferDirection,
  S3ConnectionConfig,
} from './domain/types';

/** Minimal IPC surface the manager needs. The real adapter forwards to
 *  `safeInvoke` and subscribes to Tauri events; tests pass a mock. */
export interface TransferIpc {
  /** Invoke a Rust command. Returns `unknown` — callers cast at the call site,
   *  since the IPC boundary is inherently untyped. */
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to a Tauri event. Returns an unsubscribe function. */
  on(eventName: string, handler: (payload: unknown) => void): () => void;
}

/** Progress event payload emitted by Rust (`TransferProgress`). */
interface TransferProgressPayload {
  transferId: string;
  direction: string;
  bytesDone: number;
  totalBytes?: number | null;
}

export interface StartTransferArgs {
  direction: TransferDirection;
  connectionId: string;
  config: S3ConnectionConfig;
  key: string;
  localPath: string;
}

/** Smoothed speed sampling window (bytes per second) — we keep the last N
 *  samples and average them so the ETA doesn't jump on every packet. */
const SPEED_SAMPLES = 8;

export class TransferManager {
  private tasks = new Map<string, TransferTask>();
  private listeners = new Set<() => void>();
  private unsubProgress: (() => void) | null = null;
  private speedSamples = new Map<string, { t: number; bytes: number }[]>();
  /** Cached snapshot for `useSyncExternalStore`. Invalidated (set to null) on
   *  every `emit()` and recomputed lazily on the next `snapshot()` call. This
   *  is required because `useSyncExternalStore` calls `getSnapshot` during
   *  render and on every store-poll tick — returning a fresh array each time
   *  (even with identical contents) triggers an infinite re-render loop. */
  private cachedSnapshot: TransferTask[] | null = null;

  constructor(private readonly ipc: TransferIpc) {}

  /** Subscribe to task-list changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Current snapshot of all transfers (newest-first). Referentially stable
   *  across calls until the next `emit()` — see `cachedSnapshot`. */
  snapshot(): TransferTask[] {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
    return this.cachedSnapshot;
  }

  /** Begin an upload or download. Returns the new transfer id. */
  async start(args: StartTransferArgs): Promise<string> {
    const id = makeTransferId();
    const task: TransferTask = {
      id,
      direction: args.direction,
      connectionId: args.connectionId,
      key: args.key,
      localPath: args.localPath,
      status: 'preparing',
      bytesDone: 0,
      totalBytes: null,
      speedBps: 0,
      etaSec: null,
      startedAt: Date.now(),
      attempt: 0,
    };
    this.tasks.set(id, task);
    this.emit();

    // Ensure we are listening for progress events (once).
    this.ensureProgressListener();

    const command = args.direction === 'upload' ? 's3_upload_object' : 's3_download_object';
    try {
      task.status = 'active';
      this.emit();
      await this.ipc.invoke(command, {
        config: args.config,
        key: args.key,
        localPath: args.localPath,
        transferId: id,
      });
      // Final state: completed (unless canceled concurrently).
      const cur = this.tasks.get(id);
      if (cur && cur.status !== 'canceled') {
        cur.status = 'completed';
        cur.finishedAt = Date.now();
        // Snap to total on success so progress reads 100%.
        if (cur.totalBytes != null) cur.bytesDone = cur.totalBytes;
      }
    } catch (err: unknown) {
      const cur = this.tasks.get(id);
      if (cur) {
        const msg = err instanceof Error ? err.message : String(err);
        // Distinguish cancel from real failure by the message shape; the Rust
        // side returns "Upload canceled." / "Download canceled.".
        if (/cancel/i.test(msg)) {
          cur.status = 'canceled';
        } else {
          cur.status = 'failed';
          cur.error = msg;
        }
        cur.finishedAt = Date.now();
      }
    } finally {
      this.speedSamples.delete(id);
      this.emit();
    }
    return id;
  }

  /** Cancel an in-flight transfer. Returns true if a transfer was signaled. */
  async cancel(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
      return false;
    }
    task.status = 'canceled';
    this.emit();
    try {
      const ok = await this.ipc.invoke('s3_cancel_transfer', { transferId: id });
      return Boolean(ok);
    } catch {
      return false;
    }
  }

  /** Remove finished/canceled/failed transfers from the list. */
  clearFinished(): void {
    for (const [id, t] of this.tasks) {
      if (t.status === 'completed' || t.status === 'canceled' || t.status === 'failed') {
        this.tasks.delete(id);
        this.speedSamples.delete(id);
      }
    }
    this.emit();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private ensureProgressListener(): void {
    if (this.unsubProgress) return;
    this.unsubProgress = this.ipc.on('s3_transfer_progress', (payload) => {
      const p = payload as TransferProgressPayload;
      if (!p || typeof p.transferId !== 'string') return;
      const task = this.tasks.get(p.transferId);
      if (!task) return;
      task.bytesDone = p.bytesDone;
      if (typeof p.totalBytes === 'number') task.totalBytes = p.totalBytes;
      this.updateSpeed(task);
      this.emit();
    });
  }

  /** Compute a smoothed bytes/sec and ETA from the rolling sample window. */
  private updateSpeed(task: TransferTask): void {
    const now = Date.now();
    let samples = this.speedSamples.get(task.id);
    if (!samples) {
      samples = [];
      this.speedSamples.set(task.id, samples);
    }
    samples.push({ t: now, bytes: task.bytesDone });
    if (samples.length > SPEED_SAMPLES + 1) samples.shift();

    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0) {
        task.speedBps = Math.max(0, (last.bytes - first.bytes) / dt);
        if (task.totalBytes != null && task.speedBps > 0) {
          const remaining = Math.max(0, task.totalBytes - task.bytesDone);
          task.etaSec = remaining / task.speedBps;
        }
      }
    }
  }

  private emit(): void {
    // Invalidate the cached snapshot so the next `snapshot()` call rebuilds it
    // from the current task map. Listeners (React) then see a new reference.
    this.cachedSnapshot = null;
    for (const l of this.listeners) l();
  }
}

/** Generate a unique transfer id (timestamp + random suffix). */
export function makeTransferId(): string {
  return `xfr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── React adapter (lazy import of react to keep the engine testable) ───────
// NOTE: kept in a separate file `react.ts` to avoid pulling React into the
// unit tests for the engine itself.
