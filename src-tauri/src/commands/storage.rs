//! OS-native secure credential storage (macOS Keychain / Windows Credential
//! Manager / Linux Secret Service via the `keyring` crate).
//!
//! Used by `commands::backend` for the session refresh token and the local
//! sync-passphrase-derived key material. Not (yet) used for
//! `DatabaseConnection.password` — that migration is separate, larger, and
//! out of scope here (see the auth/sync feature's plan doc).

use keyring::Entry;

const SERVICE: &str = "com.rdsql.desktop";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("keyring error: {}", e))
}

/// Plain (non-command) helpers — used directly by `commands::backend` as well
/// as wrapped below for frontend IPC.
pub fn set_credential(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| format!("keyring error: {}", e))
}

pub fn get_credential(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring error: {}", e)),
    }
}

pub fn delete_credential(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already absent — deletion's goal is satisfied
        Err(e) => Err(format!("keyring error: {}", e)),
    }
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
