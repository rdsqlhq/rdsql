import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useToastStore } from '../store/useToastStore';
import { safeInvoke } from './tauri/ipc';

/** The updater only exists inside the Tauri shell — in `npm run dev` (browser
 *  preview) the plugin isn't injected and `check()` would throw. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface UpdateCheckResult {
  status: 'available' | 'up-to-date' | 'unsupported' | 'error';
  version?: string;
  notes?: string;
  error?: string;
}

/** Discriminated outcome returned by the Rust `check_for_update` command.
 *  Mirrors `UpdateCheckOutcome` in src-tauri/src/commands/updater.rs. */
type CheckOutcome =
  | { status: 'available'; version: string; notes?: string | null; date?: string | null }
  | { status: 'up-to-date' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

/**
 * Ask the update endpoint whether a newer build exists.
 *
 * The check itself runs through the Rust `check_for_update` command for robust
 * error mapping (it never throws — failures map to `status: 'error'`). When an
 * update exists we ALSO resolve the JS plugin's `Update` resource, since that
 * is what `downloadAndInstall` requires. The two are intentionally separate.
 *
 * Returns rather than throws: a failed check is routine (offline, GitHub down,
 * release still in draft) and must never break app startup.
 */
export async function checkForUpdate(): Promise<{
  result: UpdateCheckResult;
  update: Update | null;
}> {
  if (!inTauri()) {
    return { result: { status: 'unsupported' }, update: null };
  }

  // 1) Backend check — robust, mapped errors.
  let outcome: CheckOutcome;
  try {
    outcome = await safeInvoke<CheckOutcome>('check_for_update');
  } catch (err: any) {
    return {
      result: { status: 'error', error: err?.message || String(err) },
      update: null,
    };
  }

  if (outcome.status === 'available') {
    // 2) Resolve the JS Update resource for the install button.
    try {
      const update = await check();
      return {
        result: { status: 'available', version: outcome.version, notes: outcome.notes ?? undefined },
        update,
      };
    } catch (err: any) {
      console.warn('[updater] JS resource resolve failed', err);
      // Still report availability; the About modal / toast just won't be able
      // to install until a re-check resolves the resource.
      return {
        result: { status: 'available', version: outcome.version, notes: outcome.notes ?? undefined },
        update: null,
      };
    }
  }

  if (outcome.status === 'up-to-date') {
    return { result: { status: 'up-to-date' }, update: null };
  }
  if (outcome.status === 'unsupported') {
    return { result: { status: 'unsupported' }, update: null };
  }
  return {
    result: { status: 'error', error: outcome.message },
    update: null,
  };
}

/**
 * Download + install, then restart into the new version.
 *
 * `onProgress` receives 0–100, or null while the server withholds a
 * Content-Length (the download still works, we just can't show a percentage).
 */
export async function installUpdate(
  update: Update,
  onProgress?: (percent: number | null) => void
): Promise<void> {
  let total = 0;
  let downloaded = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0;
        onProgress?.(total > 0 ? 0 : null);
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        if (total > 0) onProgress?.(Math.min(100, Math.round((downloaded / total) * 100)));
        break;
      case 'Finished':
        onProgress?.(100);
        break;
    }
  });

  await relaunch();
}

/**
 * Check and surface the result as a toast.
 *
 * `silent` is for the automatic startup check — it stays quiet unless there is
 * actually an update, so a user who is up to date or offline sees nothing. The
 * Help ▸ Check for Updates menu passes `silent: false` to always get feedback.
 */
export async function checkForUpdateAndNotify(silent: boolean): Promise<void> {
  const push = useToastStore.getState().push;
  const { result, update } = await checkForUpdate();

  if (result.status === 'available' && update) {
    push({
      severity: 'info',
      title: `Update available — v${result.version}`,
      message: 'Download and restart to install the new version.',
      actionLabel: 'Install now',
      onAction: () => {
        push({
          severity: 'info',
          title: 'Downloading update…',
          message: 'rdSQL will restart automatically when it finishes.',
        });
        installUpdate(update).catch((err) => {
          push({
            severity: 'error',
            title: 'Update failed',
            message: err?.message || String(err),
          });
        });
      },
    });
    return;
  }

  if (silent) return;

  switch (result.status) {
    case 'up-to-date':
      push({ severity: 'success', title: 'You are up to date' });
      break;
    case 'unsupported':
      push({
        severity: 'info',
        title: 'Updates unavailable here',
        message: 'Update checks only run in the desktop app.',
      });
      break;
    case 'error':
      push({
        severity: 'error',
        title: 'Could not check for updates',
        message: result.error,
      });
      break;
  }
}
