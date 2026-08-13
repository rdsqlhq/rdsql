/**
 * Classify a filesystem error from the Tauri fs/dialog plugins (or the browser
 * File API) into a short, actionable, human-readable message.
 *
 * We pattern-match on the lowercased error string because Tauri surfaces the
 * underlying OS error text, which is more portable than relying on error codes.
 * The raw detail is still included at the end so the (copyable) banner keeps
 * the full diagnostic for bug reports.
 *
 * @param action whether we were trying to write (export/save) or read (import).
 */
export function describeFsError(err: unknown, action: 'write' | 'read'): string {
  const raw =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message ?? err)
      : String(err);

  const lower = raw.toLowerCase();

  if (action === 'write') {
    if (/(permission|denied|not permitted|readonly|read-only|read only|eacces|ero)/.test(lower)) {
      return `Permission denied — the selected location can't be written to. Choose a folder you have write access to (e.g. your Desktop or Documents).`;
    }
    if (/(no such file|not found|does not exist|enoent)/.test(lower)) {
      return `The selected path no longer exists. Pick a different save location.`;
    }
    if (/(disk|space|full|enospc)/.test(lower)) {
      return `Not enough disk space to write the file.`;
    }
    if (/(cancelled|canceled|abort)/.test(lower)) {
      return `Save cancelled.`;
    }
    return `Couldn't save the file. Detail: ${raw}`;
  }

  // read
  if (/(permission|denied|not permitted|eacces)/.test(lower)) {
    return `Permission denied — this app isn't allowed to read the selected file. Move it somewhere readable (e.g. your Desktop) or grant access.`;
  }
  if (/(no such file|not found|does not exist|enoent)/.test(lower)) {
    return `The selected file could not be found. It may have been moved or deleted.`;
  }
  if (/(is a directory|eisdir)/.test(lower)) {
    return `That path is a folder, not a file. Select a file instead.`;
  }
  if (/(cancelled|canceled|abort)/.test(lower)) {
    return `File selection cancelled.`;
  }
  return `Couldn't read the selected file. Detail: ${raw}`;
}
