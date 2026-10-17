//! OS-native secure credential storage (macOS Keychain / Windows Credential
//! Manager / Linux Secret Service via the `keyring` crate).
//!
//! Used by `commands::backend` for the session access/refresh tokens and by
//! the frontend for the sync key material. Not (yet) used for
//! `DatabaseConnection.password` — that migration is separate, larger, and
//! out of scope here (see the auth/sync feature's plan doc).
//!
//! Every read is cached in memory for the life of the process, so each
//! secret touches the OS store at most once per launch.
//!
//! On macOS all secrets also live in ONE Keychain item (a JSON map) instead
//! of one item per key. Keychain access-control lists are per item and are
//! bound to the app's code signature; release builds are only ad-hoc signed
//! (no Developer ID yet), so every update looks like a new app and macOS
//! re-prompts for each item it touches. One item = one prompt per update
//! instead of three. Existing per-key items are moved into it on first
//! access. Other platforms keep per-key items: Windows Credential Manager
//! caps a secret at 2560 bytes, which two JWTs could exceed, and neither it
//! nor Secret Service prompts per item anyway.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use keyring::Entry;

const SERVICE: &str = "com.rdsql.desktop";
/// Account name of the combined item (macOS).
const VAULT_ITEM: &str = "rdsql_secrets";
/// Set in the combined item once legacy per-key items have been folded in,
/// so later launches don't query them again.
const MIGRATED_MARKER: &str = "__migrated_v1";
/// Every key ever stored as its own item before the combined item existed.
const LEGACY_KEYS: &[&str] = &[
    super::backend::ACCESS_TOKEN_KEY,
    super::backend::REFRESH_TOKEN_KEY,
    "rdsql_sync_key_material",
];

/// The raw OS store, one item per account name. A trait so the caching and
/// migration logic can be tested without a real keychain.
trait Backend {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct OsKeyring;

impl OsKeyring {
    fn entry(account: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, account).map_err(|e| format!("keyring error: {}", e))
    }
}

impl Backend for OsKeyring {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring error: {}", e)),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        Self::entry(account)?.set_password(value).map_err(|e| format!("keyring error: {}", e))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // already absent — deletion's goal is satisfied
            Err(e) => Err(format!("keyring error: {}", e)),
        }
    }
}

struct Vault<B: Backend> {
    backend: B,
    /// macOS: everything in `VAULT_ITEM`. Otherwise one item per key.
    combined: bool,
    /// Combined mode: the whole map, `None` until first loaded.
    entries: Option<HashMap<String, String>>,
    /// Per-key mode: what each key resolved to (`None` = known absent).
    per_key: HashMap<String, Option<String>>,
}

impl<B: Backend> Vault<B> {
    fn new(backend: B, combined: bool) -> Self {
        Self { backend, combined, entries: None, per_key: HashMap::new() }
    }

    fn write_combined(&self, map: &HashMap<String, String>) -> Result<(), String> {
        let json = serde_json::to_string(map).map_err(|e| format!("keyring error: {}", e))?;
        self.backend.set(VAULT_ITEM, &json)
    }

    /// Loads the combined item (one Keychain read), folding in any legacy
    /// per-key items the first time. Not cached on error, so a denied prompt
    /// is retried on the next access rather than reading as "signed out".
    fn loaded(&mut self) -> Result<&mut HashMap<String, String>, String> {
        if self.entries.is_none() {
            let mut map: HashMap<String, String> = match self.backend.get(VAULT_ITEM)? {
                // Refuse to overwrite an unreadable item rather than silently
                // dropping the user's session.
                Some(json) => serde_json::from_str(&json).map_err(|e| format!("keyring error: unreadable secrets item: {}", e))?,
                None => HashMap::new(),
            };
            if !map.contains_key(MIGRATED_MARKER) {
                let mut moved = Vec::new();
                for key in LEGACY_KEYS {
                    if map.contains_key(*key) {
                        continue;
                    }
                    if let Some(value) = self.backend.get(key)? {
                        map.insert(key.to_string(), value);
                        moved.push(*key);
                    }
                }
                map.insert(MIGRATED_MARKER.to_string(), "1".to_string());
                // Write before deleting, so a failed write never loses a secret.
                self.write_combined(&map)?;
                for key in moved {
                    let _ = self.backend.delete(key);
                }
            }
            self.entries = Some(map);
        }
        Ok(self.entries.as_mut().expect("loaded above"))
    }

    fn get(&mut self, key: &str) -> Result<Option<String>, String> {
        if self.combined {
            return Ok(self.loaded()?.get(key).cloned());
        }
        if let Some(cached) = self.per_key.get(key) {
            return Ok(cached.clone());
        }
        let value = self.backend.get(key)?;
        self.per_key.insert(key.to_string(), value.clone());
        Ok(value)
    }

    fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        if self.combined {
            let mut next = self.loaded()?.clone();
            next.insert(key.to_string(), value.to_string());
            self.write_combined(&next)?;
            self.entries = Some(next);
            return Ok(());
        }
        self.backend.set(key, value)?;
        self.per_key.insert(key.to_string(), Some(value.to_string()));
        Ok(())
    }

    fn delete(&mut self, key: &str) -> Result<(), String> {
        if self.combined {
            if !self.loaded()?.contains_key(key) {
                return Ok(());
            }
            let mut next = self.loaded()?.clone();
            next.remove(key);
            self.write_combined(&next)?;
            self.entries = Some(next);
            return Ok(());
        }
        self.backend.delete(key)?;
        self.per_key.insert(key.to_string(), None);
        Ok(())
    }
}

fn with_vault<T>(f: impl FnOnce(&mut Vault<OsKeyring>) -> Result<T, String>) -> Result<T, String> {
    static VAULT: OnceLock<Mutex<Vault<OsKeyring>>> = OnceLock::new();
    let vault = VAULT.get_or_init(|| Mutex::new(Vault::new(OsKeyring, cfg!(target_os = "macos"))));
    let mut guard = vault.lock().map_err(|_| "keyring error: lock poisoned".to_string())?;
    f(&mut guard)
}

/// Plain (non-command) helpers — used directly by `commands::backend` as well
/// as wrapped below for frontend IPC.
pub fn set_credential(key: &str, value: &str) -> Result<(), String> {
    with_vault(|v| v.set(key, value))
}

pub fn get_credential(key: &str) -> Result<Option<String>, String> {
    with_vault(|v| v.get(key))
}

pub fn delete_credential(key: &str) -> Result<(), String> {
    with_vault(|v| v.delete(key))
}

#[tauri::command]
pub async fn save_secure_credential(key: String, value: String) -> Result<bool, String> {
    set_credential(&key, &value)?;
    Ok(true)
}

#[tauri::command]
pub async fn get_secure_credential(key: String) -> Result<Option<String>, String> {
    get_credential(&key)
}

#[tauri::command]
pub async fn delete_secure_credential(key: String) -> Result<bool, String> {
    delete_credential(&key)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct MemBackend {
        items: RefCell<HashMap<String, String>>,
        reads: Cell<usize>,
        writes: Cell<usize>,
    }

    impl Backend for MemBackend {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.reads.set(self.reads.get() + 1);
            Ok(self.items.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            self.writes.set(self.writes.get() + 1);
            self.items.borrow_mut().insert(account.to_string(), value.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.items.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn combined() -> Vault<MemBackend> {
        Vault::new(MemBackend::default(), true)
    }

    #[test]
    fn combined_reads_the_os_store_once() {
        let mut v = combined();
        v.set("a", "1").unwrap();
        let reads = v.backend.reads.get();
        assert_eq!(v.get("a").unwrap().as_deref(), Some("1"));
        assert_eq!(v.get("b").unwrap(), None);
        assert_eq!(v.backend.reads.get(), reads, "cached reads must not hit the store");
    }

    #[test]
    fn combined_migrates_legacy_items_then_deletes_them() {
        let mut v = combined();
        v.backend.items.borrow_mut().insert(LEGACY_KEYS[0].to_string(), "access".to_string());
        v.backend.items.borrow_mut().insert(LEGACY_KEYS[1].to_string(), "refresh".to_string());

        assert_eq!(v.get(LEGACY_KEYS[0]).unwrap().as_deref(), Some("access"));
        assert_eq!(v.get(LEGACY_KEYS[1]).unwrap().as_deref(), Some("refresh"));
        let items = v.backend.items.borrow();
        assert!(!items.contains_key(LEGACY_KEYS[0]));
        assert!(!items.contains_key(LEGACY_KEYS[1]));
        let stored: HashMap<String, String> = serde_json::from_str(&items[VAULT_ITEM]).unwrap();
        assert_eq!(stored[LEGACY_KEYS[0]], "access");
        assert!(stored.contains_key(MIGRATED_MARKER));
    }

    #[test]
    fn combined_skips_migration_once_marked() {
        let mut v = combined();
        let map = HashMap::from([(MIGRATED_MARKER.to_string(), "1".to_string())]);
        v.backend.items.borrow_mut().insert(VAULT_ITEM.to_string(), serde_json::to_string(&map).unwrap());

        assert_eq!(v.get("anything").unwrap(), None);
        assert_eq!(v.backend.reads.get(), 1, "only the combined item is read");
        assert_eq!(v.backend.writes.get(), 0);
    }

    #[test]
    fn combined_delete_of_missing_key_does_not_write() {
        let mut v = combined();
        v.get("x").unwrap();
        let writes = v.backend.writes.get();
        v.delete("x").unwrap();
        assert_eq!(v.backend.writes.get(), writes);
    }

    #[test]
    fn combined_refuses_to_overwrite_unreadable_item() {
        let mut v = combined();
        v.backend.items.borrow_mut().insert(VAULT_ITEM.to_string(), "not json".to_string());
        assert!(v.set("a", "1").is_err());
        assert_eq!(v.backend.items.borrow()[VAULT_ITEM], "not json");
    }

    #[test]
    fn per_key_caches_hits_and_misses() {
        let mut v = Vault::new(MemBackend::default(), false);
        v.backend.items.borrow_mut().insert("a".to_string(), "1".to_string());
        assert_eq!(v.get("a").unwrap().as_deref(), Some("1"));
        assert_eq!(v.get("a").unwrap().as_deref(), Some("1"));
        assert_eq!(v.get("b").unwrap(), None);
        assert_eq!(v.get("b").unwrap(), None);
        assert_eq!(v.backend.reads.get(), 2);

        v.delete("a").unwrap();
        assert_eq!(v.get("a").unwrap(), None);
        assert!(!v.backend.items.borrow().contains_key("a"));
    }
}
