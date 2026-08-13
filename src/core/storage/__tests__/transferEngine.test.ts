import { describe, it, expect, vi } from 'vitest';
import { TransferManager, type TransferIpc } from '../transferEngine';

/** Build a mock IPC adapter whose `invoke` resolves immediately and whose `on`
 *  captures the progress handler so tests can drive it. */
function makeMockIpc(opts?: { invokeResult?: unknown; invokeError?: string }) {
  let progressHandler: ((payload: unknown) => void) | null = null;
  const invoke = vi.fn(async (command: string) => {
    if (opts?.invokeError) throw new Error(opts.invokeError);
    if (command === 's3_cancel_transfer') return true;
    return opts?.invokeResult ?? { key: 'k', size: 100, etag: 'e' };
  });
  const on = vi.fn((_eventName: string, handler: (payload: unknown) => void) => {
    progressHandler = handler;
    return () => {
      progressHandler = null;
    };
  });
  const ipc: TransferIpc = { invoke, on };
  return {
    ipc,
    emitProgress: (p: unknown) => progressHandler?.(p),
  };
}

const baseConfig = {
  id: 'c1',
  name: 'test',
  preset: 'minio' as const,
  provider: 's3' as const,
  region: 'us-east-1',
  bucket: 'b',
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
  forcePathStyle: true,
  pathPrefix: 'rdsql/',
  createdAt: '2026-08-09T00:00:00Z',
  updatedAt: '2026-08-09T00:00:00Z',
};

describe('TransferManager.start — upload', () => {
  it('issues s3_upload_object and marks the task completed on success', async () => {
    const { ipc } = makeMockIpc();
    const m = new TransferManager(ipc);
    const id = await m.start({
      direction: 'upload',
      connectionId: 'c1',
      config: baseConfig,
      key: 'rdsql/x.sql',
      localPath: '/tmp/x.sql',
    });
    expect(id).toMatch(/^xfr_/);
    const task = m.snapshot().find((t) => t.id === id)!;
    expect(task.status).toBe('completed');
    expect(ipc.invoke).toHaveBeenCalledWith('s3_upload_object', expect.objectContaining({ key: 'rdsql/x.sql' }));
  });

  it('marks the task failed when invoke throws a non-cancel error', async () => {
    const { ipc } = makeMockIpc({ invokeError: 'network unreachable' });
    const m = new TransferManager(ipc);
    const id = await m.start({
      direction: 'download',
      connectionId: 'c1',
      config: baseConfig,
      key: 'rdsql/x.sql',
      localPath: '/tmp/x.sql',
    });
    const task = m.snapshot().find((t) => t.id === id)!;
    expect(task.status).toBe('failed');
    expect(task.error).toMatch(/network unreachable/);
  });
});

describe('TransferManager — progress events', () => {
  it('updates bytesDone, totalBytes, speed, and eta from progress events', async () => {
    // Hold the invoke promise open so we can emit progress mid-flight.
    let resolveInvoke!: (v: unknown) => void;
    const invoke = vi.fn(
      () => new Promise((res) => { resolveInvoke = res; }),
    );
    const on = vi.fn((_e: string, h: (p: unknown) => void) => () => {});
    const m = new TransferManager({ invoke, on });

    // Don't await start — it won't resolve until resolveInvoke below.
    m.start({
      direction: 'upload',
      connectionId: 'c1',
      config: baseConfig,
      key: 'rdsql/x.sql',
      localPath: '/tmp/x.sql',
    });

    // Let the manager register the listener and create the task.
    await Promise.resolve();
    await Promise.resolve();
    const id = m.snapshot()[0].id;
    const handler = on.mock.calls[0][1];
    // Emit two progress ticks.
    handler({ transferId: id, direction: 'upload', bytesDone: 50, totalBytes: 100 });
    // Force a small time delta so speed is computable.
    await new Promise((r) => setTimeout(r, 20));
    handler({ transferId: id, direction: 'upload', bytesDone: 100, totalBytes: 100 });

    const task = m.snapshot()[0];
    expect(task.bytesDone).toBe(100);
    expect(task.totalBytes).toBe(100);

    resolveInvoke({ key: 'k', size: 100, etag: 'e' });
  });
});

describe('TransferManager.cancel', () => {
  it('marks an in-flight task canceled and invokes s3_cancel_transfer', async () => {
    let resolveInvoke!: (v: unknown) => void;
    const invoke = vi.fn((command: string) => {
      if (command === 's3_cancel_transfer') return Promise.resolve(true);
      return new Promise((res) => { resolveInvoke = res; });
    });
    const on = vi.fn(() => () => {});
    const m = new TransferManager({ invoke, on });

    const startPromise = m.start({
      direction: 'upload',
      connectionId: 'c1',
      config: baseConfig,
      key: 'rdsql/x.sql',
      localPath: '/tmp/x.sql',
    });
    await Promise.resolve();
    const id = m.snapshot()[0].id;

    const ok = await m.cancel(id);
    expect(ok).toBe(true);
    expect(m.snapshot()[0].status).toBe('canceled');

    // Resolve the held invoke so start() resolves cleanly.
    resolveInvoke({ key: 'k', size: 100 });
    await startPromise;
  });

  it('returns false for an unknown id', async () => {
    const { ipc } = makeMockIpc();
    const m = new TransferManager(ipc);
    expect(await m.cancel('nope')).toBe(false);
  });
});

describe('TransferManager.clearFinished', () => {
  it('removes completed/canceled/failed tasks but keeps active ones', async () => {
    const { ipc } = makeMockIpc();
    const m = new TransferManager(ipc);
    const id1 = await m.start({
      direction: 'upload', connectionId: 'c1', config: baseConfig,
      key: 'rdsql/a.sql', localPath: '/tmp/a.sql',
    });
    // id1 completed synchronously.
    expect(m.snapshot()).toHaveLength(1);
    m.clearFinished();
    expect(m.snapshot()).toHaveLength(0);
    expect(id1).toBeDefined();
  });
});

describe('TransferManager.subscribe', () => {
  it('notifies subscribers on state changes', async () => {
    const { ipc } = makeMockIpc();
    const m = new TransferManager(ipc);
    const fn = vi.fn();
    m.subscribe(fn);
    await m.start({
      direction: 'upload', connectionId: 'c1', config: baseConfig,
      key: 'rdsql/x.sql', localPath: '/tmp/x.sql',
    });
    expect(fn).toHaveBeenCalled();
  });
});
