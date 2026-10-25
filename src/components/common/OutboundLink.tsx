import React from 'react';
import { inTauri, safeInvoke } from '../../core/tauri/ipc';

/** Opens `url` in the system browser (or mail app for mailto:). Inside the
 *  app window a plain `target="_blank"` link does nothing, so external links
 *  go through the backend's `open_external_url`. */
export async function openExternal(url: string): Promise<void> {
  if (!inTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  await safeInvoke('open_external_url', { url });
}

/** An `<a>` for links that leave the app. Keeps the href (hover shows it,
 *  copy-link works) but opens it with `openExternal`. */
export const OutboundLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }> = ({
  href,
  onClick,
  children,
  ...rest
}) => (
  <a
    {...rest}
    href={href}
    rel="noreferrer"
    onClick={(e) => {
      onClick?.(e);
      if (e.defaultPrevented) return;
      e.preventDefault();
      void openExternal(href).catch((err) => console.warn('[openExternal]', err));
    }}
  >
    {children}
  </a>
);
