const INSTALL_ID_KEY = 'rdsql_install_id_v1';

/** Random, anonymous, per-install identifier — generated once, never linked
 *  to an auth account or email. Exists only so the server can rate-limit
 *  the analytics endpoint against counter-stuffing; it's never persisted
 *  server-side (see functions/api/analytics/event.ts). */
export function getInstallId(): string {
  let id = localStorage.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}
