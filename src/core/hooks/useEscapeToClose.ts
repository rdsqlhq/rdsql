import { useEffect } from 'react';

/**
 * Calls `onClose` when the Escape key is pressed anywhere in the document.
 * Use in any modal/overlay component for consistent dismiss-on-Escape behavior.
 *
 * @example
 * useEscapeToClose(onClose);
 */
export function useEscapeToClose(onClose: (() => void) | null): void {
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);
}
