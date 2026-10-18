import { useEffect, useRef } from 'react';

/** Open overlays, innermost last. Escape only closes the innermost one, so a
 *  confirmation shown over a modal doesn't close both. */
const stack: symbol[] = [];

/**
 * Calls `onClose` when the Escape key is pressed anywhere in the document.
 * Use in any modal/overlay component for consistent dismiss-on-Escape behavior.
 *
 * @example
 * useEscapeToClose(onClose);
 */
export function useEscapeToClose(onClose: (() => void) | null): void {
  // Read through a ref so a new callback identity on re-render doesn't
  // re-register the overlay and move it to the top of the stack.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const active = !!onClose;
  useEffect(() => {
    if (!active) return;
    const id = Symbol('overlay');
    stack.push(id);
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== id) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current?.();
    };
    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      const i = stack.lastIndexOf(id);
      if (i !== -1) stack.splice(i, 1);
    };
  }, [active]);
}
