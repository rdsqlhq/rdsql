import { error as logError } from '@tauri-apps/plugin-log';
import { inTauri } from '../tauri/ipc';

/**
 * Writes uncaught frontend errors to the app's local log file via
 * tauri-plugin-log (see src-tauri/src/commands/app_log.rs). Nothing is sent
 * anywhere; users copy the log from Settings → Application Data when filing
 * a bug.
 */

type ErrorKind = 'error' | 'unhandledrejection' | 'render';

/** Browser noise that isn't a bug (Monaco and our resizable panes trip the
 *  ResizeObserver one constantly). */
const IGNORED = [/ResizeObserver loop/i];

export function logUncaughtError(err: unknown, kind: ErrorKind, componentStack?: string): void {
  if (!inTauri()) return;
  const detail =
    err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : typeof err === 'string' ? err : safeStringify(err);
  if (!detail || IGNORED.some((re) => re.test(detail))) return;

  const message = [`[${kind}] ${detail.trim()}`, componentStack?.trim()].filter(Boolean).join('\n');
  // The logger must never throw.
  void logError(message).catch(() => {});
}

/** Installs the window-level handlers. Call once, before the first render. */
export function installErrorLogging(): void {
  if (!inTauri()) return;
  window.addEventListener('error', (e) => logUncaughtError(e.error ?? e.message, 'error'));
  window.addEventListener('unhandledrejection', (e) => logUncaughtError(e.reason, 'unhandledrejection'));
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
