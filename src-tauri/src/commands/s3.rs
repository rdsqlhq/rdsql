//! S3-compatible object storage provider.
//!
//! Isolated, additive module — no other command or subsystem depends on it.
//! Every command receives the full `S3Config` (including the plaintext secret,
//! supplied per-call from the frontend where secrets live encrypted at rest)
//! plus the operation args, builds a transient client, performs the operation,
//! and drops the client. Secrets are never persisted or logged on the Rust
//! side; error messages are scrubbed of credential fragments before they
//! cross the command boundary.
//!
//! Supports any S3-compatible service (AWS S3, Cloudflare R2, MinIO,
//! DigitalOcean Spaces, Backblaze B2, Wasabi, …) — there is exactly one
//! provider implementation; `endpoint` + `forcePathStyle` adapt it to each.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aws_credential_types::Credentials;
use aws_sdk_s3::config::{Builder as S3ConfigBuilder, Region};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client as S3Client;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

// ─── Error model ───────────────────────────────────────────────────────────

/// Storage error kind — mirrored on the frontend as `StorageErrorKind`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageErrorKind {
    Auth,
    Authorization,
    NotFound,
    Network,
    Timeout,
    Config,
    Upload,
    Download,
    Multipart,
    Unknown,
}

/// A normalized storage error. Serialized to JSON for the command boundary,
/// mirroring `commands::error::DbError`. `message`/`hint` are scrubbed of
/// credentials before serialization.
#[derive(Debug, Clone, Serialize)]
pub struct StorageError {
    pub kind: StorageErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl StorageError {
    pub fn new(kind: StorageErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: scrub(message.into()),
            hint: None,
        }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(scrub(hint.into()));
        self
    }
    /// Serialize to a JSON string for the Tauri command boundary.
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            // Last-resort fallback so we never lose the error entirely.
            format!("{{\"kind\":\"unknown\",\"message\":\"storage error\"}}")
        })
    }
}

/// Scrub credential-shaped substrings from a message before it is returned to
/// the frontend. Defense-in-depth — we never construct messages from secrets,
/// but S3/SDK error text occasionally echoes request context.
fn scrub(mut s: String) -> String {
    // AWS access key ids (AKIA…, 20 chars).
    let re = regex_lite::Regex::new(r"AKIA[0-9A-Z]{12,16}").unwrap();
    s = re.replace_all(&s, "AKIA••••").to_string();
    // Long base64/hex runs (signature / secret key fragments).
    let re = regex_lite::Regex::new(r"[A-Za-z0-9+/]{40,}={0,2}").unwrap();
    s = re.replace_all(&s, "••••").to_string();
    // Authorization header values.
    let re = regex_lite::Regex::new(r"(?i)(authorization:\s*).+").unwrap();
    s = re.replace_all(&s, "$1••••").to_string();
    s.trim().to_string()
}

/// Map any error into a normalized `StorageError`. The `context` string is
/// used to classify ambiguous SDK errors (e.g. "upload" → Upload vs Network).
fn map_error(err: impl std::fmt::Display, context: &str) -> StorageError {
    let raw = err.to_string();
    // The AWS SDK's generic errors (Unhandled / ServiceError) often render as
    // an empty or useless string. Surface *something* actionable so the user
    // isn't staring at a blank message.
    let raw = if raw.trim().is_empty() {
        format!("Storage request failed ({context}). The provider returned an unrecognized response.")
    } else {
        raw
    };
    let storage = classify_message(&raw, context);
    StorageError::new(storage, raw)
}

/// Pull a meaningful, *informative* error string out of an S3 `SdkError`.
///
/// The AWS SDK's `Display` for `Unhandled`/`ServiceError` collapses to an
/// empty or near-empty string (the user just sees "service error"), which is
/// useless for diagnosing R2/MinIO/B2 failures. This walks the `SdkError`
/// variants directly to recover the HTTP status code and the inner error
/// message, and formats a single actionable sentence.
fn describe_sdk_error<E>(err: &aws_smithy_runtime_api::client::result::SdkError<E, aws_smithy_runtime_api::http::Response>) -> String
where
    E: std::fmt::Debug,
{
    use aws_smithy_runtime_api::client::result::SdkError;
    match err {
        SdkError::ServiceError(se) => {
            let status = se.raw().status();
            let inner = format!("{:?}", se.err());
            format!("HTTP {}: {}", status.as_u16(), shorten(&inner))
        }
        SdkError::ResponseError(re) => {
            let status = re.raw().status();
            format!("HTTP {} (response error, no parsed body).", status.as_u16())
        }
        SdkError::DispatchFailure(df) => {
            // Connector / network layer — DNS, TLS, connection refused, etc.
            let msg = format!("{:?}", df);
            format!("Network/transport error: {}", shorten(&msg))
        }
        SdkError::TimeoutError(_) => "Request timed out.".to_string(),
        SdkError::ConstructionFailure(_) => {
            "Could not construct the request (check endpoint/region config).".to_string()
        }
        _ => "Unrecognized storage error.".to_string(),
    }
}

/// Trim a verbose Debug string to a readable length and drop the noisy
/// `Some(...)`, `SdkError { ... }` wrappers.
fn shorten(s: &str) -> String {
    let mut s = s.trim().to_string();
    // Collapse the common `Some("x")` → `x`.
    if s.starts_with("Some(") && s.ends_with(')') {
        s = s[5..s.len() - 1].trim().to_string();
    }
    // Strip surrounding quotes.
    if s.len() > 2 && s.starts_with('"') && s.ends_with('"') {
        s = s[1..s.len() - 1].to_string();
    }
    if s.len() > 400 {
        format!("{}…", &s[..400])
    } else {
        s
    }
}

/// Classify an already-extracted message string into an error kind. Factored
/// out of `map_error` so the classification is reusable for both the generic
/// `Display`-based path and the rich `SdkError` path.
fn classify_message(raw: &str, context: &str) -> StorageErrorKind {
    let lower = raw.to_lowercase();
    // Order matters: more-specific kinds first.
    if lower.contains("timeout") || lower.contains("timed out") {
        StorageErrorKind::Timeout
    } else if lower.contains("nosuchbucket") || lower.contains("bucket does not exist") {
        StorageErrorKind::NotFound
    } else if lower.contains("nosuchkey") || lower.contains("404") || lower.contains("not found") {
        if context == "download" {
            StorageErrorKind::Download
        } else {
            StorageErrorKind::NotFound
        }
    } else if lower.contains("accessdenied") || lower.contains("403") || lower.contains("forbidden") {
        StorageErrorKind::Authorization
    } else if lower.contains("invalidaccesskey")
        || lower.contains("signaturedoesnotmatch")
        || lower.contains("invalidtoken")
        || lower.contains("unauthorized")
        || lower.contains("no valid credentials")
    {
        StorageErrorKind::Auth
    } else if lower.contains("dns")
        || lower.contains("connection refused")
        || lower.contains("unreachable")
        || lower.contains("network")
        || lower.contains("econn")
        || lower.contains("broken pipe")
        || lower.contains("transport error")
    {
        StorageErrorKind::Network
    } else if context == "upload" {
        StorageErrorKind::Upload
    } else if context == "download" {
        StorageErrorKind::Download
    } else if context == "multipart" {
        StorageErrorKind::Multipart
    } else {
        StorageErrorKind::Unknown
    }
}

// ─── Config ────────────────────────────────────────────────────────────────

/// S3 connection config as received from the frontend. Mirrors
/// `S3ConnectionConfig` in `src/core/storage/domain/types.ts`. The secret
/// access key and optional session token arrive already decrypted (in-memory
/// only for the duration of the call); they are never logged or persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    pub id: String,
    pub name: String,
    pub region: String,
    pub bucket: String,
    #[serde(default)]
    pub endpoint: Option<String>,
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default)]
    pub force_path_style: bool,
    /// Root prefix RDSQL owns. Automated write/delete ops are scoped under it.
    #[serde(default)]
    pub path_prefix: String,
}

impl S3Config {
    /// Build a transient S3 client from this config. The client lives only for
    /// the duration of the command call.
    fn build_client(&self) -> Result<S3Client, StorageError> {
        if self.bucket.trim().is_empty() {
            return Err(StorageError::new(
                StorageErrorKind::Config,
                "Bucket name is required.",
            ));
        }
        if self.access_key_id.trim().is_empty() || self.secret_access_key.trim().is_empty() {
            return Err(StorageError::new(
                StorageErrorKind::Config,
                "Access key id and secret access key are required.",
            ));
        }
        if self.region.trim().is_empty() {
            return Err(StorageError::new(
                StorageErrorKind::Config,
                "Region is required (use 'auto' for R2).",
            ));
        }

        let creds = Credentials::new(
            self.access_key_id.clone(),
            self.secret_access_key.clone(),
            self.session_token.clone(),
            None,
            "rdsql-storage",
        );

        let mut builder = S3ConfigBuilder::new()
            .region(Region::new(self.region.clone()))
            .credentials_provider(creds)
            .force_path_style(self.force_path_style);

        if let Some(ep) = self.endpoint.as_ref() {
            let ep = ep.trim();
            if !ep.is_empty() {
                builder = builder.endpoint_url(ep);
            }
        }

        Ok(S3Client::from_conf(builder.build()))
    }

    /// True when `key` falls under this connection's `path_prefix`. Automated
    /// write/delete commands refuse keys outside it. An empty prefix means the
    /// user opted into full-bucket scope.
    fn is_within_prefix(&self, key: &str) -> bool {
        let p = normalize_prefix(&self.path_prefix);
        if p.is_empty() {
            return true;
        }
        key == p.trim_end_matches('/') || key.starts_with(&p)
    }

    /// Reject a key that escapes the configured prefix.
    fn assert_within_prefix(&self, key: &str) -> Result<(), StorageError> {
        if !self.is_within_prefix(key) {
            return Err(StorageError::new(
                StorageErrorKind::Authorization,
                format!("Refused to operate on a key outside the configured prefix: {}", key),
            )
            .with_hint("Adjust the connection's path prefix or browse within it."));
        }
        Ok(())
    }
}

/// Normalize a prefix: ensure exactly one trailing slash, no leading slash.
fn normalize_prefix(input: &str) -> String {
    let mut s = input.trim().to_string();
    if s.is_empty() {
        return String::new();
    }
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if s.starts_with('/') {
        s.remove(0);
    }
    // After stripping the leading slash, the string may now be empty (the
    // input was just "/"), which means bucket root.
    if s.is_empty() {
        return String::new();
    }
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}

// ─── Result shapes (serde camelCase for the TS boundary) ───────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageObjectDto {
    pub key: String,
    pub name: String,
    pub size: i64,
    pub last_modified: String,
    pub etag: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoragePrefixDto {
    pub prefix: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub objects: Vec<StorageObjectDto>,
    pub prefixes: Vec<StoragePrefixDto>,
    pub is_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOptions {
    /// Fetch at most this many keys (S3 caps at 1000).
    #[serde(default = "default_page_size")]
    pub max_keys: i32,
    /// Continuation token from a previous truncated response.
    #[serde(default)]
    pub continuation_token: Option<String>,
    /// Optional substring filter applied server-side via prefix narrowing.
    #[serde(default)]
    pub search: Option<String>,
    /// When true, list ALL keys under `prefix` flatly (no `/` delimiter), so
    /// objects in subfolders appear in `contents` instead of being folded into
    /// `common_prefixes`. Used by the analytics scan. Default false (folder view).
    #[serde(default)]
    pub recursive: bool,
}
fn default_page_size() -> i32 {
    1000
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectHead {
    pub key: String,
    pub size: i64,
    pub last_modified: String,
    pub etag: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub key: String,
    pub size: u64,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOptions {
    /// Multipart part size in bytes (default 8 MiB). Must be >= 5 MiB.
    #[serde(default = "default_part_size")]
    pub part_size: u64,
    /// Concurrent part uploads (default 4).
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    /// Max retry attempts per part (default 3).
    #[serde(default = "default_retries")]
    pub retries: u32,
}
fn default_part_size() -> u64 {
    8 * 1024 * 1024
}
fn default_concurrency() -> usize {
    4
}
fn default_retries() -> u32 {
    3
}
impl TransferOptions {
    fn merged(opts: Option<TransferOptions>) -> TransferOptions {
        opts.unwrap_or_default()
    }
}
impl Default for TransferOptions {
    fn default() -> Self {
        Self {
            part_size: default_part_size(),
            concurrency: default_concurrency(),
            retries: default_retries(),
        }
    }
}

// ─── Transfer registry (cancellation, mirrors QueryRegistry) ───────────────

/// Tracks in-flight transfers by id so `s3_cancel_transfer` can signal them.
///
/// This is a newtype (not a type alias) on purpose: `QueryRegistry` is the
/// exact same inner type, and Tauri keys managed state by concrete type. A
/// plain `type` alias would collide with `QueryRegistry` in the state
/// container. The distinct struct keeps the two registries independent.
#[derive(Clone)]
pub struct TransferRegistry(pub Arc<Mutex<HashMap<String, CancellationToken>>>);

impl std::ops::Deref for TransferRegistry {
    type Target = Arc<Mutex<HashMap<String, CancellationToken>>>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// Progress event payload emitted during upload/download.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    transfer_id: String,
    direction: String,
    bytes_done: u64,
    total_bytes: Option<u64>,
}

/// Emit a progress event. Failures are silently ignored — progress is
/// best-effort and must never break a transfer.
fn emit_progress(app: &AppHandle, evt: TransferProgress) {
    let _ = app.emit("s3_transfer_progress", &evt);
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// Validate credentials, endpoint, and bucket accessibility.
///
/// Strategy: try `HeadBucket` first (cheap). Many S3-compatible providers
/// (notably Cloudflare R2, MinIO, B2) respond to `HeadBucket` with an empty
/// or non-standard body that the AWS SDK fails to parse, surfacing as a
/// generic "Unhandled"/"Service error" even though the bucket is reachable.
/// So on any error that isn't a clear auth/404 signal, we fall back to a
/// zero-key `ListObjectsV2` — which is universally supported and also proves
/// the `s3:ListBucket` permission we need to browse.
#[tauri::command]
pub async fn s3_test_connection(config: S3Config) -> Result<TestResult, String> {
    let started = std::time::Instant::now();
    let client = match config.build_client() {
        Ok(c) => c,
        Err(e) => return Err(e.to_json_string()),
    };

    // Attempt 1: HeadBucket.
    let head = client.head_bucket().bucket(&config.bucket).send().await;
    if let Ok(_) = head {
        return Ok(TestResult {
            success: true,
            message: format!(
                "Connected to bucket '{}' on {}.",
                config.bucket,
                config.endpoint.as_deref().unwrap_or("AWS S3")
            ),
            latency_ms: Some(started.elapsed().as_millis() as u64),
        });
    }

    // Classify the HeadBucket failure. For definitive auth/not-found errors we
    // surface immediately; for anything ambiguous (the common R2/MinIO case)
    // we retry with ListObjectsV2 before declaring failure.
    if let Err(err) = &head {
        let meta = err.meta();
        let code = meta.code().unwrap_or("");
        let is_definitive_failure = matches!(
            code,
            "NoSuchBucket" | "AccessDenied" | "Forbidden"
                | "InvalidAccessKeyId" | "SignatureDoesNotMatch"
        );
        if is_definitive_failure {
            let storage_err = match code {
                "NoSuchBucket" => StorageError::new(
                    StorageErrorKind::NotFound,
                    format!("Bucket '{}' does not exist.", config.bucket),
                ),
                "AccessDenied" | "Forbidden" => map_error(err, "test")
                    .with_hint("The credentials lack permission for this bucket."),
                "InvalidAccessKeyId" | "SignatureDoesNotMatch" => map_error(err, "test")
                    .with_hint("Check the access key id and secret access key."),
                _ => map_error(err, "test"),
            };
            return Err(storage_err.to_json_string());
        }
        // Ambiguous — fall through to the ListObjectsV2 probe.
    }

    // If HeadBucket produced an unrecognized error, capture it now so we can
    // include both attempts' details in the final failure message.
    let head_detail = match &head {
        Err(e) => {
            eprintln!("[s3_test_connection] head_bucket failed — {:?}", e);
            describe_sdk_error(e)
        }
        _ => String::new(),
    };

    // Attempt 2: zero-key ListObjectsV2 (broad compatibility).
    let list = client
        .list_objects_v2()
        .bucket(&config.bucket)
        .max_keys(1)
        .send()
        .await;

    match list {
        Ok(_) => Ok(TestResult {
            success: true,
            message: format!(
                "Connected to bucket '{}' on {}.",
                config.bucket,
                config.endpoint.as_deref().unwrap_or("AWS S3")
            ),
            latency_ms: Some(started.elapsed().as_millis() as u64),
        }),
        Err(err) => {
            // Log the FULL raw error to the dev console so we can diagnose
            // provider quirks (R2/MinIO/B2) that the SDK collapses in Display.
            eprintln!("[s3_test_connection] list failed — {:?}", err);
            let meta = err.meta();
            let code = meta.code().unwrap_or("");
            let list_detail = describe_sdk_error(&err);
            let storage_err = match code {
                "NoSuchBucket" => StorageError::new(
                    StorageErrorKind::NotFound,
                    format!("Bucket '{}' does not exist.", config.bucket),
                ),
                "AccessDenied" | "Forbidden" => StorageError::new(
                    StorageErrorKind::Authorization,
                    "Access denied. The credentials lack ListBucket permission on this bucket.",
                ),
                "InvalidAccessKeyId" | "SignatureDoesNotMatch" => StorageError::new(
                    StorageErrorKind::Auth,
                    "Authentication failed. Check the access key id and secret access key.",
                ),
                _ => {
                    // Build a maximally informative message: both attempts'
                    // HTTP status + raw detail so the user (and we) can see
                    // exactly what the provider rejected.
                    let combined = if head_detail.is_empty() {
                        format!("Connection failed. List attempt: {}", list_detail)
                    } else {
                        format!(
                            "Connection failed. HeadBucket attempt: {} | List attempt: {}",
                            head_detail, list_detail
                        )
                    };
                    StorageError::new(StorageErrorKind::Unknown, combined).with_hint(
                        "If this is R2/MinIO/B2: verify the endpoint URL, region (often 'auto'), bucket name, and that 'Force path-style' matches the provider.",
                    )
                }
            };
            Err(storage_err.to_json_string())
        }
    }
}

/// List objects and common prefixes under `prefix`. One page per call;
/// pagination via `continuationToken`.
#[tauri::command]
pub async fn s3_list_objects(
    config: S3Config,
    prefix: String,
    opts: Option<ListOptions>,
) -> Result<ListResult, String> {
    let client = match config.build_client() {
        Ok(c) => c,
        Err(e) => return Err(e.to_json_string()),
    };
    let opts = opts.unwrap_or_else(|| ListOptions {
        max_keys: default_page_size(),
        continuation_token: None,
        search: None,
        recursive: false,
    });

    // Always include a trailing slash on the prefix for folder-style listing,
    // so listing "rdsql/" returns its direct children rather than every key
    // starting with "rdsql" anywhere.
    let normalized_prefix = normalize_prefix(&prefix);

    // The delimiter makes S3 fold subfolders into CommonPrefixes (folder view).
    // Recursive mode omits it so every key under the prefix is returned flatly
    // in `contents` — used by the analytics scan to find the largest files
    // across the whole subtree.
    let mut req = client
        .list_objects_v2()
        .bucket(&config.bucket)
        .prefix(&normalized_prefix)
        .max_keys(opts.max_keys);
    if !opts.recursive {
        req = req.delimiter("/");
    }
    if let Some(tok) = &opts.continuation_token {
        if !tok.is_empty() {
            req = req.continuation_token(tok);
        }
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[s3_list_objects] failed — {:?}", e);
            let detail = describe_sdk_error(&e);
            let kind = classify_message(&detail, "list");
            let storage_err = StorageError::new(kind, format!("Failed to list objects: {}", detail))
                .with_hint("Verify the bucket exists and the credentials have ListBucket permission.");
            return Err(storage_err.to_json_string());
        }
    };

    let browse_prefix = normalized_prefix.as_str();
    let prefixes: Vec<StoragePrefixDto> = resp
        .common_prefixes()
        .iter()
        .filter_map(|cp| cp.prefix().map(|p| p.to_string()))
        // Some providers (R2/MinIO) return a degenerate empty CommonPrefix equal
        // to the browse prefix itself, which renders as a nameless folder. Drop
        // any prefix that is empty or identical to the listed folder.
        .filter(|p| !p.is_empty() && p != &normalized_prefix)
        .map(|p| StoragePrefixDto {
            name: display_name(&p, browse_prefix).trim_end_matches('/').to_string(),
            prefix: p,
        })
        .collect();

    let mut objects: Vec<StorageObjectDto> = resp
        .contents()
        .iter()
        .filter_map(|o| {
            let key = o.key()?.to_string();
            // Skip the prefix placeholder object itself (a zero-byte object
            // equal to the listed folder).
            if key == normalized_prefix {
                return None;
            }
            let size = o.size().unwrap_or(0);
            let last_modified = o
                .last_modified()
                .map(|t| datetime_to_rfc3339(t))
                .unwrap_or_default();
            Some(StorageObjectDto {
                name: display_name(&key, browse_prefix).to_string(),
                key,
                size,
                last_modified,
                etag: o.e_tag().map(|s| s.trim_matches('"').to_string()),
                content_type: None,
            })
        })
        .collect();

    // Optional client-side search filter (the S3 API has no substring filter).
    if let Some(q) = opts.search.as_ref() {
        if !q.is_empty() {
            let ql = q.to_lowercase();
            objects.retain(|o| o.name.to_lowercase().contains(&ql));
        }
    }

    Ok(ListResult {
        objects,
        prefixes,
        is_truncated: resp.is_truncated().unwrap_or(false),
        continuation_token: resp.next_continuation_token().map(|s| s.to_string()),
    })
}

/// Fetch metadata for a single object (null when it does not exist).
#[tauri::command]
pub async fn s3_head_object(config: S3Config, key: String) -> Result<Option<ObjectHead>, String> {
    let client = match config.build_client() {
        Ok(c) => c,
        Err(e) => return Err(e.to_json_string()),
    };
    let resp = client
        .head_object()
        .bucket(&config.bucket)
        .key(&key)
        .send()
        .await;

    match resp {
        Ok(o) => {
            let last_modified = o
                .last_modified
                .as_ref()
                .map(|t| datetime_to_rfc3339(t))
                .unwrap_or_default();
            Ok(Some(ObjectHead {
                key,
                size: o.content_length.unwrap_or(0) as i64,
                last_modified,
                etag: o.e_tag.map(|s| s.trim_matches('"').to_string()),
                content_type: o.content_type,
            }))
        }
        Err(err) => {
            let storage_err = map_error(err, "head");
            // NoSuchKey → return None rather than an error (it is a valid
            // answer to "does this object exist?").
            if matches!(storage_err.kind, StorageErrorKind::NotFound) {
                return Ok(None);
            }
            Err(storage_err.to_json_string())
        }
    }
}

/// Generate a presigned GET URL for an object, allowing anyone with the link to
/// download it without credentials. The URL embeds a time-limited signature.
/// `expires_secs` is clamped to S3's 7-day maximum. The key must be within the
/// connection's configured `path_prefix`.
#[tauri::command]
pub async fn s3_presign_get(
    config: S3Config,
    key: String,
    expires_secs: u64,
) -> Result<String, String> {
    config.assert_within_prefix(&key).map_err(|e| e.to_json_string())?;
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    // S3 caps presigned URL lifetimes at 7 days (604800s). Clamp the requested
    // expiry so callers can't accidentally exceed it and get an SDK error.
    let secs = expires_secs.clamp(1, 604_800);
    let presigning = PresigningConfig::expires_in(Duration::from_secs(secs))
        .map_err(|e| {
            StorageError::new(StorageErrorKind::Config, format!("Invalid expiry: {}", e))
                .to_json_string()
        })?;
    let presigned = client
        .get_object()
        .bucket(&config.bucket)
        .key(&key)
        .presigned(presigning)
        .await
        .map_err(|e| {
            let detail = describe_sdk_error(&e);
            let kind = classify_message(&detail, "download");
            StorageError::new(kind, format!("Failed to presign URL: {}", detail)).to_json_string()
        })?;
    Ok(presigned.uri().to_string())
}

/// Fetch a (bounded) object's bytes for in-app preview/edit of text, JSON,
/// images, and PDFs. Returns base64 (Tauri IPC is JSON). `max_bytes` caps the
/// read so we never pull a multi-GB object into RAM; callers that exceed the
/// cap get `truncated: true` and a hint to download instead. The full object
/// size is returned so the UI can refuse to edit truncated content.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectBytes {
    pub content_base64: String,
    pub content_type: Option<String>,
    pub size: u64,
    pub truncated: bool,
}

#[tauri::command]
pub async fn s3_get_object_bytes(
    config: S3Config,
    key: String,
    max_bytes: Option<u64>,
) -> Result<ObjectBytes, String> {
    use base64::Engine;
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    let cap = max_bytes.unwrap_or(5 * 1024 * 1024); // 5 MiB default preview cap
    let resp = client
        .get_object()
        .bucket(&config.bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| {
            let detail = describe_sdk_error(&e);
            let kind = classify_message(&detail, "download");
            StorageError::new(kind, format!("Failed to fetch object: {}", detail)).to_json_string()
        })?;

    let total = resp.content_length.unwrap_or(0) as u64;
    let content_type = resp.content_type.clone();
    let truncated = total > cap;
    // Read up to `cap` bytes into memory. For text previews this is plenty;
    // for large binaries the UI refuses and suggests downloading.
    let mut body = resp.body;
    let mut buf = Vec::with_capacity((cap.min(total + 1024)) as usize);
    let mut read = 0u64;
    while read < cap {
        match body.next().await {
            Some(Ok(bytes)) => {
                let remaining = cap - read;
                if (bytes.len() as u64) > remaining {
                    buf.extend_from_slice(&bytes[..remaining as usize]);
                    break;
                }
                buf.extend_from_slice(&bytes);
                read += bytes.len() as u64;
            }
            Some(Err(e)) => {
                return Err(StorageError::new(
                    StorageErrorKind::Download,
                    format!("Failed to read object body: {}", e),
                )
                .to_json_string());
            }
            None => break,
        }
    }

    Ok(ObjectBytes {
        content_base64: base64::engine::general_purpose::STANDARD.encode(&buf),
        content_type,
        size: total,
        truncated,
    })
}

// ─── Object ACL (permissions) ──────────────────────────────────────────────
// ACL support varies by provider: AWS S3 supports full ACLs; Cloudflare R2
// rejects them (AccessControlNotSupported); MinIO support depends on config.
// Errors are surfaced via the normal StorageError path.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AclGranteeDto {
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AclGrantDto {
    pub grantee: AclGranteeDto,
    pub permission: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AclOwnerDto {
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AclDto {
    pub owner: AclOwnerDto,
    pub grants: Vec<AclGrantDto>,
}

/// Map an ACL-operation SDK error to a clean, user-facing message. The common
/// failure mode for S3-compatible providers is "ACLs not supported" — R2
/// returns `NotImplemented` (501), MinIO may return `AccessControlNotSupported`.
/// We surface those as a single clear sentence instead of the raw SDK dump.
fn acl_error<E>(
    err: aws_smithy_runtime_api::client::result::SdkError<E, aws_smithy_runtime_api::http::Response>,
    verb: &str,
) -> String
where
    E: std::fmt::Debug + aws_smithy_types::error::metadata::ProvideErrorMetadata,
{
    let meta = err.meta();
    let code = meta.code().unwrap_or("");
    let detail = describe_sdk_error(&err);
    let not_supported = matches!(
        code,
        "NotImplemented" | "AccessControlNotSupported" | "NotSupported"
    ) || detail.contains("not implemented")
        || detail.contains("not supported");
    if not_supported {
        return StorageError::new(
            StorageErrorKind::Config,
            "ACLs are not supported by this storage provider. Cloudflare R2 and some MinIO configurations do not implement S3 ACLs — access is controlled via bucket policies or token scopes instead.",
        )
        .to_json_string();
    }
    let kind = classify_message(&detail, "authorization");
    StorageError::new(kind, format!("Failed to {} ACL: {}", verb, detail))
        .to_json_string()
}

/// Read an object's ACL (owner + grant list).
#[tauri::command]
pub async fn s3_get_object_acl(config: S3Config, key: String) -> Result<AclDto, String> {
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    let resp = client
        .get_object_acl()
        .bucket(&config.bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| acl_error(e, "read"))?;

    let owner = AclOwnerDto {
        id: resp.owner().and_then(|o| o.id().map(|s| s.to_string())),
        display_name: resp.owner().and_then(|o| o.display_name().map(|s| s.to_string())),
    };
    let grants = resp
        .grants()
        .iter()
        .map(|g| {
            let grantee = g.grantee().map(|gr| AclGranteeDto {
                type_: gr.r#type().as_str().to_string(),
                id: gr.id().map(|s| s.to_string()),
                display_name: gr.display_name().map(|s| s.to_string()),
                uri: gr.uri().map(|s| s.to_string()),
            }).unwrap_or(AclGranteeDto { type_: "Group".to_string(), id: None, display_name: None, uri: None });
            AclGrantDto {
                grantee,
                permission: g.permission().map(|p| p.as_str().to_string()).unwrap_or_else(|| "?".to_string()),
            }
        })
        .collect();

    Ok(AclDto { owner, grants })
}

/// Apply a canned ACL to an object. Canned ACLs cover the common cases
/// (private, public-read, public-read-write, ...). `canned` must be one of the
/// S3 canned-ACL string values; the frontend ships the valid set.
#[tauri::command]
pub async fn s3_put_object_acl(
    config: S3Config,
    key: String,
    canned: String,
) -> Result<bool, String> {
    config.assert_within_prefix(&key).map_err(|e| e.to_json_string())?;
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    let acl = aws_sdk_s3::types::ObjectCannedAcl::from(canned.as_str());
    client
        .put_object_acl()
        .bucket(&config.bucket)
        .key(&key)
        .acl(acl)
        .send()
        .await
        .map_err(|e| acl_error(e, "update"))?;
    Ok(true)
}

/// Upload a local file as `key`. Streams the file in parts; never loads the
/// whole file into memory. Emits `s3_transfer_progress` events keyed by
/// `transferId`. Cancellable via `s3_cancel_transfer`.
#[tauri::command]
pub async fn s3_upload_object(
    app: AppHandle,
    registry: tauri::State<'_, TransferRegistry>,
    config: S3Config,
    key: String,
    local_path: String,
    transfer_id: String,
    opts: Option<TransferOptions>,
) -> Result<UploadResult, String> {
    config.assert_within_prefix(&key).map_err(|e| e.to_json_string())?;

    let client = config.build_client().map_err(|e| e.to_json_string())?;
    let opts = TransferOptions::merged(opts);

    let path = PathBuf::from(&local_path);
    let file_size = match tokio::fs::metadata(&path).await {
        Ok(m) => m.len(),
        Err(e) => {
            return Err(StorageError::new(
                StorageErrorKind::Config,
                format!("Could not read local file '{}': {}", local_path, e),
            )
            .to_json_string())
        }
    };

    let token = CancellationToken::new();
    registry
        .lock()
        .await
        .insert(transfer_id.clone(), token.clone());

    let result = upload_with_progress(
        &client,
        &app,
        &config.bucket,
        &key,
        &path,
        file_size,
        &transfer_id,
        &opts,
        token,
    )
    .await;

    registry.lock().await.remove(&transfer_id);
    result.map_err(|e| e.to_json_string())
}

/// Download an object to a local file. Streams to disk; never loads the whole
/// object into memory. Emits `s3_transfer_progress`. Cancellable.
#[tauri::command]
pub async fn s3_download_object(
    app: AppHandle,
    registry: tauri::State<'_, TransferRegistry>,
    config: S3Config,
    key: String,
    local_path: String,
    transfer_id: String,
    opts: Option<TransferOptions>,
) -> Result<DownloadResult, String> {
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    let _opts = TransferOptions::merged(opts);

    let token = CancellationToken::new();
    registry
        .lock()
        .await
        .insert(transfer_id.clone(), token.clone());

    let result = download_with_progress(
        &client, &app, &config.bucket, &key, &local_path, &transfer_id, token,
    )
    .await;

    registry.lock().await.remove(&transfer_id);
    result.map_err(|e| e.to_json_string())
}

/// Delete a single object. Scoped to the configured prefix.
#[tauri::command]
pub async fn s3_delete_object(config: S3Config, key: String) -> Result<u32, String> {
    config.assert_within_prefix(&key).map_err(|e| e.to_json_string())?;
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    client
        .delete_object()
        .bucket(&config.bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| map_error(e, "delete").to_json_string())?;
    Ok(1)
}

/// Delete up to 1000 objects in one request. Every key must be within the
/// configured prefix or the whole call is refused (fail-closed).
#[tauri::command]
pub async fn s3_delete_objects(config: S3Config, keys: Vec<String>) -> Result<u32, String> {
    for k in &keys {
        config.assert_within_prefix(k).map_err(|e| e.to_json_string())?;
    }
    if keys.is_empty() {
        return Ok(0);
    }
    let client = config.build_client().map_err(|e| e.to_json_string())?;

    let mut builder = client.delete_objects().bucket(&config.bucket);
    let identifiers: Vec<aws_sdk_s3::types::ObjectIdentifier> = keys
        .iter()
        .map(|k| aws_sdk_s3::types::ObjectIdentifier::builder().key(k).build())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| StorageError::new(StorageErrorKind::Config, e.to_string()).to_json_string())?;
    let delete = aws_sdk_s3::types::Delete::builder()
        .set_objects(Some(identifiers))
        .build()
        .map_err(|e| StorageError::new(StorageErrorKind::Config, e.to_string()).to_json_string())?;
    builder = builder.set_delete(Some(delete));

    let resp = builder
        .send()
        .await
        .map_err(|e| map_error(e, "delete").to_json_string())?;
    let deleted = resp.deleted().len() as u32;
    Ok(deleted)
}

/// Server-side copy (CopyObject). Used by rename/move (copy then delete).
/// Both source and destination must be within the configured prefix.
#[tauri::command]
pub async fn s3_copy_object(
    config: S3Config,
    src_key: String,
    dst_key: String,
) -> Result<String, String> {
    config
        .assert_within_prefix(&src_key)
        .map_err(|e| e.to_json_string())?;
    config
        .assert_within_prefix(&dst_key)
        .map_err(|e| e.to_json_string())?;
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    let source = format!("{}/{}", config.bucket, src_key);
    client
        .copy_object()
        .bucket(&config.bucket)
        .key(&dst_key)
        .copy_source(&source)
        .send()
        .await
        .map_err(|e| map_error(e, "copy").to_json_string())?;
    Ok(dst_key)
}

/// Create a "folder" by placing a zero-byte object with a trailing slash.
#[tauri::command]
pub async fn s3_create_prefix(config: S3Config, prefix: String) -> Result<String, String> {
    let normalized = normalize_prefix(&prefix);
    config
        .assert_within_prefix(&normalized)
        .map_err(|e| e.to_json_string())?;
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    client
        .put_object()
        .bucket(&config.bucket)
        .key(&normalized)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(b""))
        .send()
        .await
        .map_err(|e| map_error(e, "upload").to_json_string())?;
    Ok(normalized)
}

/// Abort an incomplete multipart upload (cleanup after a failed/canceled upload).
#[tauri::command]
pub async fn s3_abort_multipart(
    config: S3Config,
    key: String,
    upload_id: String,
) -> Result<bool, String> {
    config.assert_within_prefix(&key).map_err(|e| e.to_json_string())?;
    let client = config.build_client().map_err(|e| e.to_json_string())?;
    client
        .abort_multipart_upload()
        .bucket(&config.bucket)
        .key(&key)
        .upload_id(&upload_id)
        .send()
        .await
        .map_err(|e| map_error(e, "multipart").to_json_string())?;
    Ok(true)
}

/// Cancel an in-flight transfer by id. Returns true if a transfer was found
/// and signaled, false if it had already finished.
#[tauri::command]
pub async fn s3_cancel_transfer(
    transfer_id: String,
    registry: tauri::State<'_, TransferRegistry>,
) -> Result<bool, String> {
    let token = { registry.lock().await.remove(&transfer_id) };
    if let Some(t) = token {
        t.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Gzip-compress a local file in a streaming fashion (for optional S3 backup
/// compression). Returns the compressed size. Never loads the whole file.
#[tauri::command]
pub async fn s3_gzip_compress(local_in: String, local_out: String) -> Result<u64, String> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    let input = std::fs::File::open(&local_in).map_err(|e| {
        StorageError::new(StorageErrorKind::Config, format!("open input failed: {}", e))
            .to_json_string()
    })?;
    let output = std::fs::File::create(&local_out).map_err(|e| {
        StorageError::new(StorageErrorKind::Config, format!("open output failed: {}", e))
            .to_json_string()
    })?;
    let mut encoder = GzEncoder::new(output, Compression::default());
    let mut reader = std::io::BufReader::new(input);
    std::io::copy(&mut reader, &mut encoder).map_err(|e| {
        StorageError::new(StorageErrorKind::Upload, format!("gzip failed: {}", e)).to_json_string()
    })?;
    let mut written = encoder.finish().map_err(|e| {
        StorageError::new(StorageErrorKind::Upload, format!("gzip finish failed: {}", e))
            .to_json_string()
    })?;
    use std::io::Seek;
    let size = written.stream_position().ok().unwrap_or(0);
    Ok(size)
}

/// Gzip-decompress a local file in a streaming fashion (for restoring a `.gz`
/// backup downloaded from S3). Returns the decompressed size. Never loads the
/// whole file into memory.
#[tauri::command]
pub async fn s3_gzip_decompress(local_in: String, local_out: String) -> Result<u64, String> {
    use flate2::read::GzDecoder;
    use std::io::Write;
    let input = std::fs::File::open(&local_in).map_err(|e| {
        StorageError::new(StorageErrorKind::Config, format!("open input failed: {}", e))
            .to_json_string()
    })?;
    let output = std::fs::File::create(&local_out).map_err(|e| {
        StorageError::new(StorageErrorKind::Config, format!("open output failed: {}", e))
            .to_json_string()
    })?;
    let mut decoder = GzDecoder::new(std::io::BufReader::new(input));
    let mut writer = std::io::BufWriter::new(output);
    let size = std::io::copy(&mut decoder, &mut writer).map_err(|e| {
        StorageError::new(StorageErrorKind::Download, format!("gunzip failed: {}", e))
            .to_json_string()
    })?;
    writer.flush().map_err(|e| {
        StorageError::new(StorageErrorKind::Download, format!("gunzip flush failed: {}", e))
            .to_json_string()
    })?;
    Ok(size)
}

// ─── Upload/download internals (streaming + multipart) ─────────────────────

/// Multipart-upload a file with progress events and cancellation. For files
/// smaller than one part we use a single PutObject; otherwise we stream parts
/// concurrently.
#[allow(clippy::too_many_arguments)]
async fn upload_with_progress(
    client: &S3Client,
    app: &AppHandle,
    bucket: &str,
    key: &str,
    path: &PathBuf,
    file_size: u64,
    transfer_id: &str,
    opts: &TransferOptions,
    cancel: CancellationToken,
) -> Result<UploadResult, StorageError> {
    // Small file: single PUT.
    let part_size = opts.part_size.max(5 * 1024 * 1024); // S3 minimum 5 MiB.
    if file_size < part_size || file_size == 0 {
        return upload_single(client, app, bucket, key, path, file_size, transfer_id, cancel).await;
    }

    // Large file: multipart.
    upload_multipart(client, app, bucket, key, path, file_size, transfer_id, opts, cancel).await
}

/// Single-shot PutObject for small files. Still streams from disk.
async fn upload_single(
    client: &S3Client,
    app: &AppHandle,
    bucket: &str,
    key: &str,
    path: &PathBuf,
    file_size: u64,
    transfer_id: &str,
    cancel: CancellationToken,
) -> Result<UploadResult, StorageError> {
    let body = aws_sdk_s3::primitives::ByteStream::read_from()
        .path(path)
        .buffer_size(8 * 1024 * 1024)
        .build()
        .await
        .map_err(|e| map_error(e, "upload"))?;
    let resp = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            // Best-effort cleanup is not possible for a single PUT; report canceled.
            return Err(StorageError::new(StorageErrorKind::Upload, "Upload canceled."));
        }
        r = client.put_object().bucket(bucket).key(key).body(body).send() => r,
    }
    .map_err(|e| map_error(e, "upload"))?;
    emit_progress(
        app,
        TransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: "upload".to_string(),
            bytes_done: file_size,
            total_bytes: Some(file_size),
        },
    );
    Ok(UploadResult {
        key: key.to_string(),
        size: file_size,
        etag: resp.e_tag().map(|s| s.trim_matches('"').to_string()),
    })
}

/// Streaming multipart upload with bounded concurrency, per-part retry, and
/// progress events. Reads each part from disk on demand (never the whole file).
#[allow(clippy::too_many_arguments)]
async fn upload_multipart(
    client: &S3Client,
    app: &AppHandle,
    bucket: &str,
    key: &str,
    path: &PathBuf,
    file_size: u64,
    transfer_id: &str,
    opts: &TransferOptions,
    cancel: CancellationToken,
) -> Result<UploadResult, StorageError> {
    // 1. Initiate.
    let upload_id = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(StorageError::new(StorageErrorKind::Upload, "Upload canceled.")),
        r = client.create_multipart_upload().bucket(bucket).key(key).send() => r,
    }
    .map_err(|e| map_error(e, "multipart"))?
    .upload_id
    .ok_or_else(|| StorageError::new(StorageErrorKind::Multipart, "No upload id returned."))?
    .to_string();

    // Guard: abort the multipart upload on any error path so we never leave
    // orphaned parts billed to the user's bucket.
    let bucket_s = bucket.to_string();
    let key_s = key.to_string();
    let client_clone = client.clone();
    let upload_id_clone = upload_id.clone();
    let abort_guard = AbortGuard {
        client: client_clone,
        bucket: bucket_s,
        key: key_s,
        upload_id: upload_id_clone,
        armed: true,
    };

    // 2. Plan parts.
    let part_size = opts.part_size.max(5 * 1024 * 1024);
    let mut parts: Vec<(usize, u64, u64)> = Vec::new(); // (part_number, offset, len)
    let mut offset = 0u64;
    let mut part_no = 1usize;
    while offset < file_size {
        let len = part_size.min(file_size - offset);
        parts.push((part_no, offset, len));
        offset += len;
        part_no += 1;
    }

    // 3. Upload parts concurrently with bounded concurrency + retry.
    let sem = Arc::new(tokio::sync::Semaphore::new(opts.concurrency.max(1)));
    let completed = Arc::new(Mutex::new(Vec::<(usize, aws_sdk_s3::types::CompletedPart)>::new()));
    let bytes_done = Arc::new(std::sync::atomic::AtomicU64::new(0u64));

    let mut handles = Vec::new();
    for (part_no, off, len) in parts {
        let permit = sem.clone().acquire_owned().await.map_err(|_| {
            StorageError::new(StorageErrorKind::Upload, "Concurrency semaphore closed.")
        })?;
        let client = client.clone();
        let bucket = bucket.to_string();
        let key = key.to_string();
        let path = path.clone();
        let transfer_id = transfer_id.to_string();
        let app = app.clone();
        let cancel = cancel.clone();
        let completed = completed.clone();
        let bytes_done = bytes_done.clone();
        let retries = opts.retries;

        handles.push(tokio::spawn(async move {
            let _permit = permit;
            let result = upload_one_part_with_retry(
                &client,
                &bucket,
                &key,
                part_no,
                off,
                len,
                &path,
                &transfer_id,
                &app,
                &cancel,
                retries,
                &bytes_done,
                file_size,
            )
            .await;
            // Push a successful part into the completed set; on error, return
            // an owned StorageError so the caller can fail the whole upload.
            match result {
                Ok(part) => {
                    completed.lock().await.push((part_no, part));
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }));
    }

    // 4. Await all parts; fail on the first error.
    let mut first_err: Option<StorageError> = None;
    for h in handles {
        match h.await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(StorageError::new(
                        StorageErrorKind::Upload,
                        format!("Part upload task panicked: {}", e),
                    ));
                }
            }
        }
        if cancel.is_cancelled() && first_err.is_none() {
            first_err = Some(StorageError::new(StorageErrorKind::Upload, "Upload canceled."));
        }
    }

    if let Some(e) = first_err {
        // AbortGuard drops and aborts the multipart upload.
        return Err(e);
    }

    // 5. Complete the upload.
    let mut completed_parts = completed.lock().await.clone();
    completed_parts.sort_by_key(|(n, _)| *n);
    let completed: Vec<aws_sdk_s3::types::CompletedPart> =
        completed_parts.into_iter().map(|(_, p)| p).collect();

    let completion = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(completed))
        .build();

    let resp = client
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(&upload_id)
        .multipart_upload(completion)
        .send()
        .await
        .map_err(|e| map_error(e, "multipart"))?;

    // Disarm the abort guard — completion succeeded.
    std::mem::forget(abort_guard);

    emit_progress(
        app,
        TransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: "upload".to_string(),
            bytes_done: file_size,
            total_bytes: Some(file_size),
        },
    );
    Ok(UploadResult {
        key: key.to_string(),
        size: file_size,
        etag: resp.e_tag().map(|s| s.trim_matches('"').to_string()),
    })
}

/// Upload one part with bounded retry. Reads the part slice from disk into a
/// fresh buffer (part-sized, never whole-file) for the upload body.
#[allow(clippy::too_many_arguments)]
async fn upload_one_part_with_retry(
    client: &S3Client,
    bucket: &str,
    key: &str,
    part_no: usize,
    offset: u64,
    len: u64,
    path: &PathBuf,
    transfer_id: &str,
    app: &AppHandle,
    cancel: &CancellationToken,
    retries: u32,
    bytes_done: &std::sync::atomic::AtomicU64,
    total: u64,
) -> Result<aws_sdk_s3::types::CompletedPart, StorageError> {
    let mut attempt = 0u32;
    loop {
        if cancel.is_cancelled() {
            return Err(StorageError::new(StorageErrorKind::Upload, "Upload canceled."));
        }
        // Read this part's bytes from disk.
        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|e| map_error(e, "upload"))?;
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| map_error(e, "upload"))?;
        let mut buf = vec![0u8; len as usize];
        file.read_exact(&mut buf)
            .await
            .map_err(|e| map_error(e, "upload"))?;

        let body = aws_sdk_s3::primitives::ByteStream::from(buf);
        let upload_part = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                return Err(StorageError::new(StorageErrorKind::Upload, "Upload canceled."));
            }
            r = client
                .upload_part()
                .bucket(bucket)
                .key(key)
                .part_number(part_no as i32)
                .body(body)
                .send() => r,
        };

        match upload_part {
            Ok(r) => {
                let done = bytes_done.fetch_add(len, std::sync::atomic::Ordering::Relaxed) + len;
                emit_progress(
                    app,
                    TransferProgress {
                        transfer_id: transfer_id.to_string(),
                        direction: "upload".to_string(),
                        bytes_done: done,
                        total_bytes: Some(total),
                    },
                );
                let part = aws_sdk_s3::types::CompletedPart::builder()
                    .part_number(part_no as i32)
                    .set_e_tag(r.e_tag().map(|s| s.to_string()))
                    .build();
                return Ok(part);
            }
            Err(e) => {
                attempt += 1;
                if attempt > retries {
                    return Err(map_error(e, "multipart"));
                }
                // Exponential backoff before retry.
                let backoff = std::time::Duration::from_millis(200 * (1 << attempt.min(5)));
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(StorageError::new(StorageErrorKind::Upload, "Upload canceled.")),
                    _ = tokio::time::sleep(backoff) => {}
                }
            }
        }
    }
}

/// Streaming download with progress and cancellation.
async fn download_with_progress(
    client: &S3Client,
    app: &AppHandle,
    bucket: &str,
    key: &str,
    local_path: &str,
    transfer_id: &str,
    cancel: CancellationToken,
) -> Result<DownloadResult, StorageError> {
    let resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| map_error(e, "download"))?;

    let total = resp.content_length.map(|n| n as u64);
    let mut body = resp.body;
    let mut file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| map_error(e, "download"))?;

    let mut bytes_done: u64 = 0;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // Best-effort: remove the partial file.
                let _ = tokio::fs::remove_file(local_path).await;
                return Err(StorageError::new(StorageErrorKind::Download, "Download canceled."));
            }
            chunk = body.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        file.write_all(&bytes)
                            .await
                            .map_err(|e| map_error(e, "download"))?;
                        bytes_done += bytes.len() as u64;
                        emit_progress(
                            app,
                            TransferProgress {
                                transfer_id: transfer_id.to_string(),
                                direction: "download".to_string(),
                                bytes_done,
                                total_bytes: total,
                            },
                        );
                    }
                    Some(Err(e)) => return Err(map_error(e, "download")),
                    None => break,
                }
            }
        }
    }
    file.flush().await.map_err(|e| map_error(e, "download"))?;
    Ok(DownloadResult { size: bytes_done })
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/// RAII guard that aborts an incomplete multipart upload on drop unless
/// disarmed (via `mem::forget`) after a successful completion.
struct AbortGuard {
    client: S3Client,
    bucket: String,
    key: String,
    upload_id: String,
    armed: bool,
}
impl Drop for AbortGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let client = self.client.clone();
        let bucket = self.bucket.clone();
        let key = self.key.clone();
        let upload_id = self.upload_id.clone();
        tokio::spawn(async move {
            let _ = client
                .abort_multipart_upload()
                .bucket(&bucket)
                .key(&key)
                .upload_id(&upload_id)
                .send()
                .await;
        });
    }
}

/// Strip the browse prefix and trailing slash to produce a display name.
fn display_name(full: &str, browse_prefix: &str) -> String {
    let mut rel = if !browse_prefix.is_empty() && full.starts_with(browse_prefix) {
        &full[browse_prefix.len()..]
    } else {
        full
    };
    if rel.ends_with('/') {
        rel = &rel[..rel.len() - 1];
    }
    match rel.rsplit_once('/') {
        Some((_, last)) => last.to_string(),
        None => rel.to_string(),
    }
}

/// Convert an AWS SDK `DateTime` to an RFC3339 string. The SDK doesn't expose a
/// direct chrono conversion, so we go via epoch seconds.
fn datetime_to_rfc3339(t: &aws_sdk_s3::primitives::DateTime) -> String {
    let secs = t.as_secs_f64();
    let secs_whole = secs.floor() as i64;
    let nanos = ((secs - secs.floor()) * 1_000_000_000.0) as u32;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs_whole, nanos)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_prefix_handles_empty_and_slashes() {
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("/"), "");
        assert_eq!(normalize_prefix("rdsql"), "rdsql/");
        assert_eq!(normalize_prefix("rdsql//backups"), "rdsql/backups/");
        assert_eq!(normalize_prefix("/a/b/"), "a/b/");
    }

    #[test]
    fn display_name_strips_prefix_and_slash() {
        assert_eq!(display_name("rdsql/backups/prod/", "rdsql/backups/"), "prod");
        assert_eq!(display_name("rdsql/backups/prod/x.sql", "rdsql/backups/prod/"), "x.sql");
        assert_eq!(display_name("x.sql", ""), "x.sql");
    }

    #[test]
    fn is_within_prefix_respects_segment_boundary() {
        let cfg = S3Config {
            id: "c".into(),
            name: "n".into(),
            region: "us-east-1".into(),
            bucket: "b".into(),
            endpoint: None,
            access_key_id: "ak".into(),
            secret_access_key: "sk".into(),
            session_token: None,
            force_path_style: false,
            path_prefix: "rdsql/".into(),
        };
        assert!(cfg.is_within_prefix("rdsql/backups/x.sql"));
        assert!(cfg.is_within_prefix("rdsql"));
        assert!(!cfg.is_within_prefix("rdsql-evil/x.sql"));
        assert!(!cfg.is_within_prefix("other/x.sql"));
    }

    #[test]
    fn empty_prefix_means_full_bucket_scope() {
        let cfg = S3Config {
            id: "c".into(),
            name: "n".into(),
            region: "us-east-1".into(),
            bucket: "b".into(),
            endpoint: None,
            access_key_id: "ak".into(),
            secret_access_key: "sk".into(),
            session_token: None,
            force_path_style: false,
            path_prefix: "".into(),
        };
        assert!(cfg.is_within_prefix("anything/x.sql"));
    }

    #[test]
    fn map_error_classifies_common_sdk_messages() {
        // `map_error` accepts any Display; we feed it strings that mimic the
        // SDK's error messages and assert the classification heuristic.
        assert!(matches!(
            map_error(&"request timed out after 30s"[..], "upload").kind,
            StorageErrorKind::Timeout
        ));
        assert!(matches!(
            map_error(&"NoSuchKey: The specified key does not exist."[..], "download").kind,
            StorageErrorKind::Download
        ));
        assert!(matches!(
            map_error(&"AccessDenied (403 Forbidden)"[..], "list").kind,
            StorageErrorKind::Authorization
        ));
        assert!(matches!(
            map_error(&"InvalidAccessKeyId"[..], "test").kind,
            StorageErrorKind::Auth
        ));
        assert!(matches!(
            map_error(&"connection refused"[..], "upload").kind,
            StorageErrorKind::Network
        ));
    }

    #[test]
    fn scrub_redacts_access_key_ids() {
        let m = scrub("bad key AKIAIOSFODNN7EXAMPLE here".to_string());
        assert!(!m.contains("AKIAIOSFODNN7EXAMPLE"));
    }
}
