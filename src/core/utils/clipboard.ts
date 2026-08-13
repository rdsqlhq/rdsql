/**
 * Copy text to the clipboard, resolving the host clipboard API regardless of
 * whether we're running inside Tauri or a plain browser preview.
 *
 * Always resolves (never rejects): clipboard access can be blocked by the page
 * permissions/focus state, and callers generally prefer a silent no-op over a
 * thrown exception that crashes the UI.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Preferred: async clipboard API (available in Tauri's webview + browsers).
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy strategies
    }
  }

  // 2. Legacy fallback: a hidden textarea + execCommand('copy'). Works in older
  //    webviews / when the Permissions API denies navigator.clipboard.
  if (typeof document !== 'undefined') {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  return false;
}
