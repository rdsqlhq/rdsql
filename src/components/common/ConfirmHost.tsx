import React from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from './ConfirmDialog';
import { useConfirmStore } from '../../store/useConfirmStore';

/** Renders the dialog for `confirmAsync`. Mounted once in MainLayout. */
export const ConfirmHost: React.FC = () => {
  const pending = useConfirmStore((s) => s.pending);
  const settle = useConfirmStore((s) => s.settle);
  if (!pending) return null;
  // Portalled above every modal: it is often opened from inside one.
  return createPortal(
    <div className="relative z-[200]">
      <ConfirmDialog
        title={pending.title}
        message={pending.message}
        confirmLabel={pending.confirmLabel}
        tone={pending.tone ?? 'danger'}
        onConfirm={() => settle(true)}
        onClose={() => settle(false)}
      />
    </div>,
    document.body,
  );
};
