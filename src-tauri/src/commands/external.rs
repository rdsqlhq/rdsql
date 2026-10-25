//! Opening links in the system browser.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Opens an http(s) or mailto link in the default browser or mail app. A
/// plain `<a target="_blank">` does nothing inside the app window, so every
/// external link in the UI goes through here (see `OutboundLink.tsx`).
#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    if !is_external_url(&url) {
        return Err(format!("Not a web or mail link: {url}"));
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("Could not open the link: {e}"))
}

/// Only web and mail links: this must never become a way to launch local
/// files or other URL schemes.
fn is_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
}

#[cfg(test)]
mod tests {
    use super::is_external_url;

    #[test]
    fn only_web_and_mail_links() {
        assert!(is_external_url("https://github.com/sponsors/rdsqlhq"));
        assert!(is_external_url("http://localhost:3000"));
        assert!(is_external_url("mailto:hi@example.com"));
        assert!(!is_external_url("file:///etc/passwd"));
        assert!(!is_external_url("/Applications/Calculator.app"));
        assert!(!is_external_url("javascript:alert(1)"));
    }
}
