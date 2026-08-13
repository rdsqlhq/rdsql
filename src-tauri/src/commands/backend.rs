//! rdSQL Cloudflare backend client — accounts, OAuth device-linking, pairing,
//! entitlement, and encrypted connection sync.
//!
//! Login itself is a browser flow, not a native form: `backend_open_login`
//! opens the system browser to the website's `/account?desktop=1&state=...`
//! page; the website completes email/password or Google/GitHub auth and
//! redirects to `rdsql://auth/callback?access=...&refresh=...&state=...`,
//! which `tauri-plugin-deep-link` delivers to the handler registered in
//! `lib.rs`'s `setup()`. That handler (not a `#[tauri::command]`) validates
//! `state`, persists tokens via `commands::storage`'s keyring helpers, and
//! emits an `auth-callback` event the frontend listens for.
//!
//! Every other command here follows the reqwest + bearer-auth pattern from
//! `commands::d1`, with one addition: `authed_request` transparently retries
//! once via `/auth/refresh` on a 401, since access tokens are short-lived.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::storage;

// The backend URL isn't sensitive — it's visible in any network trace or
// `strings` on the binary regardless of how it gets in — so it's just
// hardcoded rather than injected. What still varies per build is
// RDSQL_CLIENT_KEY: a plain `cargo build`/`make build` from the public
// source leaves it unset, which disables cloud features (sign-in, sync,
// entitlement) entirely — see `backend_is_cloud_configured` below. Only the
// maintainer's official release build sets it, from a local,
// gitignored-by-location env file outside the repo
// (`~/.tauri/rdsql-desktop.official.env`, loaded by the Makefile's
// `OFFICIAL_ENV`/`API_ENV`, same pattern as the updater signing key; see
// `make backend-secrets` for CI).
//
// IMPORTANT: RDSQL_CLIENT_KEY is not a secret in any cryptographic sense.
// Once compiled into a public, downloadable binary it's just as extractable
// as the URL above — build-time injection only stops it from sitting in the
// committed source, it does nothing to hide it from someone examining the
// resulting binary. Its only purpose is to stop a *casual* self-built copy
// from silently talking to production as if it were official; it is not,
// and cannot be, a real access-control boundary. The actual security
// boundary is server-side: authenticate the signed-in *user*
// (`backend_open_login` below, tokens in the OS keyring), not the binary
// calling in. Treat a leaked/rotated key as a minor hygiene issue, not an
// incident.
const API_BASE: &str = "https://rdsql.com/api";
const WEB_BASE: &str = "https://rdsql.com";
const CLIENT_KEY: &str = match option_env!("RDSQL_CLIENT_KEY") {
    Some(v) => v,
    None => "",
};
pub const ACCESS_TOKEN_KEY: &str = "rdsql_session_access_token";
pub const REFRESH_TOKEN_KEY: &str = "rdsql_session_refresh_token";

#[tauri::command]
pub fn backend_is_cloud_configured() -> bool {
    !CLIENT_KEY.is_empty()
}

fn require_cloud_configured() -> Result<(), String> {
    if CLIENT_KEY.is_empty() {
        return Err("Cloud features (sign-in, sync, entitlement) aren't available in this build.".to_string());
    }
    Ok(())
}

/// Holds the `state` nonce between `backend_open_login` and the deep-link
/// callback — a single desktop app only ever has one login attempt in
/// flight at a time.
pub struct PendingLogin(pub Arc<Mutex<Option<String>>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceDescriptor {
    #[serde(rename = "deviceName")]
    pub device_name: String,
    pub platform: Option<String>,
    pub architecture: Option<String>,
    #[serde(rename = "appVersion")]
    pub app_version: Option<String>,
}

fn current_device_descriptor() -> DeviceDescriptor {
    let os_label = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    DeviceDescriptor {
        device_name: format!("rdSQL Desktop ({})", os_label),
        platform: Some(std::env::consts::OS.to_string()),
        architecture: Some(std::env::consts::ARCH.to_string()),
        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
    }
}

/// Every request built from this client carries `x-rdsql-client-key` when
/// RDSQL_CLIENT_KEY is set, so this is the one place that needs to know
/// about it — every call site below (`send`, `refresh_access_token`,
/// `backend_redeem_pairing_code`, `backend_analytics_event`) gets it for
/// free. See the module-level comment on RDSQL_CLIENT_KEY: this header is a
/// soft anti-abuse signal, not an access-control mechanism.
fn client() -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    if !CLIENT_KEY.is_empty() {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(CLIENT_KEY) {
            headers.insert("x-rdsql-client-key", v);
        }
    }
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .default_headers(headers)
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

/// Sends an authenticated request, retrying once via `/auth/refresh` on a
/// 401. Returns the deserialized JSON body. Errors propagate as `String`
/// (matching the rest of the app's Tauri command error convention).
async fn authed_request(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    require_cloud_configured()?;
    let access = storage::get_credential(ACCESS_TOKEN_KEY)?
        .ok_or_else(|| "not signed in".to_string())?;

    let resp = send(&method, path, &access, body.clone()).await?;
    if resp.status() != reqwest::StatusCode::UNAUTHORIZED {
        return parse_response(resp).await;
    }

    // Access token expired — refresh once, then retry the original call.
    let new_access = refresh_access_token().await?;
    let retry = send(&method, path, &new_access, body).await?;
    parse_response(retry).await
}

async fn send(
    method: &reqwest::Method,
    path: &str,
    access_token: &str,
    body: Option<Value>,
) -> Result<reqwest::Response, String> {
    let url = format!("{}{}", API_BASE, path);
    let mut req = client()?.request(method.clone(), &url).bearer_auth(access_token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    req.send().await.map_err(|e| format!("request failed: {}", e))
}

async fn parse_response(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        let msg = body.get("error").and_then(|e| e.as_str()).unwrap_or("request failed");
        Err(msg.to_string())
    }
}

async fn refresh_access_token() -> Result<String, String> {
    let refresh = storage::get_credential(REFRESH_TOKEN_KEY)?
        .ok_or_else(|| "session expired — please sign in again".to_string())?;

    let url = format!("{}/auth/refresh", API_BASE);
    let resp = client()?
        .post(&url)
        .json(&serde_json::json!({ "refreshToken": refresh }))
        .send()
        .await
        .map_err(|e| format!("refresh failed: {}", e))?;

    if !resp.status().is_success() {
        // Refresh token itself is invalid/revoked — clear local state so the
        // UI falls back to signed-out instead of retrying forever.
        let _ = storage::delete_credential(ACCESS_TOKEN_KEY);
        let _ = storage::delete_credential(REFRESH_TOKEN_KEY);
        return Err("session expired — please sign in again".to_string());
    }

    let body: Value = resp.json().await.map_err(|e| format!("refresh parse failed: {}", e))?;
    let access = body.get("accessToken").and_then(|v| v.as_str()).ok_or("refresh response missing accessToken")?;
    let new_refresh = body.get("refreshToken").and_then(|v| v.as_str());

    storage::set_credential(ACCESS_TOKEN_KEY, access)?;
    if let Some(r) = new_refresh {
        storage::set_credential(REFRESH_TOKEN_KEY, r)?;
    }
    Ok(access.to_string())
}

// --- Login (browser flow) ---------------------------------------------------

#[tauri::command]
pub async fn backend_open_login(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingLogin>,
) -> Result<(), String> {
    require_cloud_configured()?;
    use tauri_plugin_opener::OpenerExt;

    let state = uuid::Uuid::new_v4().to_string();
    *pending.0.lock().await = Some(state.clone());

    let device = current_device_descriptor();
    let q = |v: &str| percent_encoding::utf8_percent_encode(v, percent_encoding::NON_ALPHANUMERIC).to_string();
    let url = format!(
        "{}/account?desktop=1&state={}&deviceName={}&platform={}&arch={}&appVersion={}",
        WEB_BASE,
        q(&state),
        q(&device.device_name),
        q(device.platform.as_deref().unwrap_or("")),
        q(device.architecture.as_deref().unwrap_or("")),
        q(device.app_version.as_deref().unwrap_or("")),
    );

    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("failed to open browser: {}", e))
}

#[tauri::command]
pub async fn backend_is_signed_in() -> Result<bool, String> {
    Ok(storage::get_credential(ACCESS_TOKEN_KEY)?.is_some())
}

#[tauri::command]
pub async fn backend_logout() -> Result<(), String> {
    if let Ok(Some(refresh)) = storage::get_credential(REFRESH_TOKEN_KEY) {
        let _ = authed_request(reqwest::Method::POST, "/auth/logout", Some(serde_json::json!({ "refreshToken": refresh }))).await;
    }
    let _ = storage::delete_credential(ACCESS_TOKEN_KEY);
    let _ = storage::delete_credential(REFRESH_TOKEN_KEY);
    Ok(())
}

// --- Entitlement / devices ---------------------------------------------------

#[tauri::command]
pub async fn backend_get_me() -> Result<Value, String> {
    authed_request(reqwest::Method::GET, "/me", None).await
}

#[tauri::command]
pub async fn backend_rename_device(device_id: String, device_name: String) -> Result<Value, String> {
    authed_request(
        reqwest::Method::POST,
        &format!("/devices/{}/rename", device_id),
        Some(serde_json::json!({ "deviceName": device_name })),
    )
    .await
}

#[tauri::command]
pub async fn backend_revoke_device(device_id: String) -> Result<Value, String> {
    authed_request(reqwest::Method::POST, &format!("/devices/{}/revoke", device_id), None).await
}

// --- Pairing ------------------------------------------------------------

#[tauri::command]
pub async fn backend_create_pairing_code(code: String, sync_key: Option<Value>) -> Result<Value, String> {
    let body = serde_json::json!({ "code": code, "syncKey": sync_key });
    authed_request(reqwest::Method::POST, "/pairing/create", Some(body)).await
}

/// Returns the redeem response body (`{accessToken, refreshToken, account,
/// syncKey}`) so the frontend can unwrap `syncKey` with the same pairing
/// code and adopt it as this device's local sync key.
#[tauri::command]
pub async fn backend_redeem_pairing_code(code: String) -> Result<Value, String> {
    require_cloud_configured()?;
    let device = current_device_descriptor();
    let url = format!("{}/pairing/redeem", API_BASE);
    let resp = client()?
        .post(&url)
        .json(&serde_json::json!({ "code": code, "device": device }))
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    let body = parse_response(resp).await?;
    let access = body.get("accessToken").and_then(|v| v.as_str()).ok_or("redeem response missing accessToken")?;
    let refresh = body.get("refreshToken").and_then(|v| v.as_str()).ok_or("redeem response missing refreshToken")?;
    storage::set_credential(ACCESS_TOKEN_KEY, access)?;
    storage::set_credential(REFRESH_TOKEN_KEY, refresh)?;
    Ok(body)
}

// --- Sync -----------------------------------------------------------------

#[tauri::command]
pub async fn backend_sync_manifest(cursor: i64) -> Result<Value, String> {
    authed_request(reqwest::Method::GET, &format!("/sync/manifest?cursor={}", cursor), None).await
}

#[tauri::command]
pub async fn backend_sync_pull_resource(resource_type: String, resource_id: String) -> Result<Value, String> {
    authed_request(reqwest::Method::GET, &format!("/sync/resource/{}/{}", resource_type, resource_id), None).await
}

#[tauri::command]
pub async fn backend_sync_push_resource(
    resource_type: String,
    resource_id: String,
    payload: String,
    expected_version: i64,
) -> Result<Value, String> {
    authed_request(
        reqwest::Method::PUT,
        &format!("/sync/resource/{}/{}", resource_type, resource_id),
        Some(serde_json::json!({ "payload": payload, "expectedVersion": expected_version })),
    )
    .await
}

#[tauri::command]
pub async fn backend_sync_delete_resource(resource_type: String, resource_id: String) -> Result<Value, String> {
    authed_request(reqwest::Method::DELETE, &format!("/sync/resource/{}/{}", resource_type, resource_id), None).await
}

#[tauri::command]
pub async fn backend_sync_pull_credentials(resource_id: String) -> Result<Value, String> {
    authed_request(reqwest::Method::GET, &format!("/sync/credentials/{}", resource_id), None).await
}

#[tauri::command]
pub async fn backend_sync_push_credentials(
    resource_id: String,
    ciphertext: String,
    iv: String,
    tag: String,
) -> Result<Value, String> {
    authed_request(
        reqwest::Method::PUT,
        &format!("/sync/credentials/{}", resource_id),
        Some(serde_json::json!({ "ciphertext": ciphertext, "iv": iv, "tag": tag })),
    )
    .await
}

// --- Analytics (opt-in, anonymous — no auth) ---------------------------------

#[tauri::command]
pub async fn backend_analytics_event(install_id: String, event_name: String, dimension: String) -> Result<(), String> {
    if CLIENT_KEY.is_empty() {
        return Ok(());
    }
    let url = format!("{}/analytics/event", API_BASE);
    // Fire-and-forget: analytics must never surface an error to the user or
    // affect app behavior.
    let _ = client()?
        .post(&url)
        .json(&serde_json::json!({ "installId": install_id, "eventName": event_name, "dimension": dimension }))
        .send()
        .await;
    Ok(())
}
