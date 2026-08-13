import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { describeFsError } from '../utils/fsErrors';

export interface LoadedSqlFile {
  path: string;
  /** File name without its extension — used as the new tab's title. */
  name: string;
  content: string;
}

/**
 * Above this size, loading the file straight into Monaco as a controlled
 * `value` risks freezing or crashing the editor (no error boundary existed
 * for this before — a crash here used to blank out the ENTIRE app, not just
 * the tab). ~2MB comfortably covers hand-written or generated query files;
 * this app's own multi-thousand-statement backup dumps are exactly the kind
 * of file that exceeds it — those belong in Restore (streams the file and
 * never holds it all in one editor buffer), not the SQL editor.
 */
export const MAX_SQL_EDITOR_FILE_CHARS = 2_000_000;

/**
 * Opens the native file picker filtered to `.sql`/`.txt`, reads the chosen
 * file, and returns its content. Returns `null` when the user cancels the
 * dialog (not an error). Read failures (permissions, missing file, etc.) and
 * oversized files are surfaced as a user-readable message via a thrown Error.
 */
export async function pickAndReadSqlFile(): Promise<LoadedSqlFile | null> {
  const picked = await open({ multiple: false, filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] });
  if (!picked || typeof picked !== 'string') return null;

  let content: string;
  try {
    content = await readTextFile(picked);
  } catch (err) {
    throw new Error(describeFsError(err, 'read'));
  }

  const base = picked.split(/[\\/]/).pop() || picked;
  const name = base.replace(/\.\w+$/, '');

  if (content.length > MAX_SQL_EDITOR_FILE_CHARS) {
    const mb = (content.length / 1_000_000).toFixed(1);
    throw new Error(
      `"${base}" is ${mb}MB — too large for the SQL editor. Use Restore (Backup icon in the Explorer, or the Restore modal) for large .sql dumps instead — it streams statements one at a time rather than loading the whole file into memory.`
    );
  }

  return { path: picked, name, content };
}
