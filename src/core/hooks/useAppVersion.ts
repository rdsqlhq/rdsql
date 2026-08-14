import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { inTauri } from '../tauri/ipc';

/**
 * The real running app version, read once from Tauri at runtime — never a
 * hardcoded JS constant, so there's nothing here that can drift from what's
 * actually installed. Sourced from Cargo.toml: tauri.conf.json intentionally
 * omits `version` so Cargo.toml is the single place a release version is
 * declared (`make bump V=x.y.z` / `make version`).
 *
 * Returns '' outside Tauri (e.g. `npm run dev` in a plain browser).
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (!inTauri()) return;
    getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);

  return version;
}
