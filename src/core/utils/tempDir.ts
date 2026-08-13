/** Resolve the OS temp directory. Falls back to a best-effort path when the
 *  Tauri FS plugin isn't available (browser preview). */
export async function tempDir(): Promise<string> {
  // @ts-expect-error - Tauri exposes the home dir on the window in dev.
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    // Use the Tauri home-dir base + a rdsql temp subdir. We avoid pulling the
    // full @tauri-apps/api/path module here to keep the import light; the OS
    // temp env var is sufficient and works cross-platform.
    const envHome = await import('@tauri-apps/api/path').then((m) => m.tempDir()).catch(() => null);
    return envHome ?? '/tmp';
  }
  return '/tmp';
}
