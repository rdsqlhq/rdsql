//! Update-check command.
//!
//! The actual download/install runs through the official `@tauri-apps/plugin-updater`
//! JS plugin (it owns the live `Update` resource and the relaunch flow). This
//! module provides a backend `check_for_update` command so the check itself is
//! robust — proper error mapping, runs on the Tokio runtime, and returns a
//! structured result the About modal can render without depending on the JS
//! plugin's exception behavior.

use serde::Serialize;
use tauri::AppHandle;
use tauri::Runtime;
use tauri_plugin_updater::UpdaterExt;

/// Structured outcome of a single update check. Mirrors the frontend's
/// `UpdateCheckResult` shape so the JS layer can pass it straight through.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum UpdateCheckOutcome {
    /// A newer build is published at the endpoint.
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        notes: Option<String>,
        /// ISO-8601 publish date of the release, if the endpoint provides one.
        date: Option<String>,
    },
    /// Already on the newest published build.
    UpToDate,
    /// Updater isn't configured for this build / platform.
    Unsupported,
    /// The check ran but failed (offline, endpoint down, bad signature, …).
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

/// Check the configured updater endpoint for a newer release.
///
/// Never panics — any failure (network, config missing, plugin not registered)
/// is mapped to `Error { message }` so the UI always gets a renderable result.
#[cfg(desktop)]
pub async fn check_for_update_impl<R: Runtime>(app: AppHandle<R>) -> UpdateCheckOutcome {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return UpdateCheckOutcome::Error {
                message: format!("Updater not configured: {e}"),
            }
        }
    };

    match updater.check().await {
        Ok(Some(update)) => UpdateCheckOutcome::Available {
            version: update.version.clone(),
            notes: update.body.clone(),
            // OffsetDateTime → RFC 3339 via its Display impl (stable, no
            // dependency on the `time` crate's formatting API surface).
            date: update.date.map(|d| {
                let _ = d.unix_timestamp();
                d.to_string()
            }),
        },
        Ok(None) => UpdateCheckOutcome::UpToDate,
        Err(e) => UpdateCheckOutcome::Error {
            message: e.to_string(),
        },
    }
}

/// Non-desktop targets (browser preview during `npm run dev`) report the
/// updater as unsupported — mirroring the JS `inTauri()` guard.
#[cfg(not(desktop))]
pub async fn check_for_update_impl<R: Runtime>(_app: AppHandle<R>) -> UpdateCheckOutcome {
    UpdateCheckOutcome::Unsupported
}

/// `#[tauri::command]` wrapper around [`check_for_update_impl`].
#[cfg_attr(mobile, allow(dead_code))]
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> UpdateCheckOutcome {
    check_for_update_impl(app).await
}
