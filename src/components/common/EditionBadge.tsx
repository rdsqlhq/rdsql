import React from 'react';
import { cn } from '../../core/utils/cn';
import { useIsPro, useEditionLabel } from '../../core/config/edition';

interface Props {
  className?: string;
  size?: 'sm' | 'md';
}

/** Amber badge for PRO, slate badge for COMMUNITY.
 *  Amber untuk Pro (premium look), slate untuk Community (netral/open-source).
 *  Follows the badge convention used across the app (cf. SeverityBadge).
 *  Reflects the live, signed-in account's entitlement (see useEdition). */
export const EditionBadge: React.FC<Props> = ({ className, size = 'sm' }) => {
  const isPro = useIsPro();
  const label = useEditionLabel();
  const sizing = size === 'md'
    ? 'px-2 py-0.5 text-[10px]'
    : 'px-1.5 py-0.5 text-[9px]';

  return (
    <span
      title={isPro ? 'Professional Edition' : 'Community Edition'}
      className={cn(
        'inline-flex items-center gap-1 font-bold uppercase tracking-wide rounded border whitespace-nowrap',
        sizing,
        isPro
          ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
          : 'bg-slate-500/15 text-slate-300 border-slate-500/30',
        className,
      )}
    >
      {label}
    </span>
  );
};
