//! Local application log.
//!
//! `tauri-plugin-log` (registered in `lib.rs`) writes a rotating
//! `<app-log-dir>/rdsql.log`. GUI builds have no console on Windows or macOS,
//! so plain `eprintln!` output used to be lost entirely. Rust code logs via
//! the `log` macros; the frontend logs uncaught errors through
//! `@tauri-apps/plugin-log` (see src/core/errors/errorLog.ts). Panics aren't
//! captured by the plugin, so `install_panic_hook` routes them in too.
//!
//! Nothing here leaves the machine. Users open the folder or copy a scrubbed
//! tail of the log from Settings → Application Data to attach to a GitHub
//! issue.

use std::sync::OnceLock;
use tauri::Manager;

pub const LOG_FILE_NAME: &str = "rdsql";
/// How much of the log tail `app_log_read` returns.
const LOG_TAIL_BYTES: u64 = 64 * 1024;

/// Strip credential-shaped substrings and the user's home directory from log
/// text before it's copied out — it usually ends up pasted into a public
/// GitHub issue. Same spirit as `commands::s3::scrub`, broader patterns.
pub fn scrub(s: &str) -> String {
    static PATTERNS: OnceLock<Vec<(regex_lite::Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            // user:password@ in connection URLs (postgres://, mysql://, mongodb+srv://, redis://, …).
            (r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@", "$1••••@"),
            // key=value / key: value secrets, incl. JSON-ish "password":"…".
            (
                r#"(?i)("?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)"?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)"#,
                "$1••••",
            ),
            (r"(?i)(bearer\s+)\S+", "$1••••"),
            // AWS access key ids.
            (r"AKIA[0-9A-Z]{12,16}", "AKIA••••"),
            // Long base64/hex runs (tokens, signatures, secret keys).
            (r"[A-Za-z0-9+/_-]{40,}={0,2}", "••••"),
        ]
        .into_iter()
        .map(|(re, rep)| (regex_lite::Regex::new(re).unwrap(), rep))
        .collect()
    });

    let mut out = s.to_string();
    for (re, rep) in patterns {
        out = re.replace_all(&out, *rep).into_owned();
    }
    // Home dir paths carry the OS username.
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(var) {
            if home.len() > 1 {
                out = out.replace(&home, "~");
            }
        }
    }
    out
}

/// Writes panics to the log file. Chains to the previous hook so the default
/// stderr output is kept.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        log::error!("panic at {}: {}\n{}", location, payload, std::backtrace::Backtrace::force_capture());
        previous(info);
    }));
}

#[tauri::command]
pub fn app_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path().app_log_dir().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_log_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// The tail of the current log file, scrubbed, for pasting into a bug report.
#[tauri::command]
pub fn app_log_read(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{}.log", LOG_FILE_NAME));
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL_BYTES))).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    // Drop the (likely partial) first line when we started mid-file.
    let text: &str = if len > LOG_TAIL_BYTES { text.split_once('\n').map_or(&text, |(_, rest)| rest) } else { &text };
    Ok(scrub(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_connection_url_credentials() {
        let s = scrub("failed to connect to postgres://admin:hunter2@db.example.com:5432/app");
        assert!(!s.contains("hunter2"));
        assert!(!s.contains("admin"));
        assert!(s.contains("postgres://••••@db.example.com"));
    }

    #[test]
    fn scrubs_key_value_secrets() {
        let s = scrub(r#"password=hunter2 token: abc123 {"apiKey":"xyz"}"#);
        assert!(!s.contains("hunter2"));
        assert!(!s.contains("abc123"));
        assert!(!s.contains("xyz"));
    }

    #[test]
    fn scrubs_bearer_and_long_tokens() {
        let s = scrub("Authorization header Bearer abk_live_123 and sk_0123456789abcdefghijklmnopqrstuvwxyzABCD");
        assert!(!s.contains("abk_live_123"));
        assert!(!s.contains("0123456789abcdefghij"));
    }

    #[test]
    fn leaves_ordinary_messages_alone() {
        let msg = "TypeError: Cannot read properties of undefined (reading 'map')";
        assert_eq!(scrub(msg), msg);
    }
}
