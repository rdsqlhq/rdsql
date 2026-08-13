//! SSH tunnel / jump-server support, shared by every networked engine
//! (Postgres, MySQL, SQL Server, Redis).
//!
//! `resolve_target()` is the single entry point every driver's connect path
//! calls: it returns the original `(host, port)` unchanged when the
//! connection has no SSH config, or the address of a local TCP forward that
//! proxies to the real target through an authenticated SSH session
//! otherwise. Callers don't need to know or care which case they're in.
//!
//! Tunnels are cached in a process-wide registry keyed by connection id and
//! reused across calls — every engine here connects fresh per command call
//! (no pooling anywhere in this codebase), and redoing an SSH handshake +
//! auth on every query would be a real perf/UX regression. A plain
//! `OnceLock` (rather than Tauri-managed state) is used deliberately:
//! `connection::fetch_schema_tree_impl` is also called directly by
//! `compare.rs`'s schema/data tooling without going through the
//! `#[tauri::command]` wrapper, so threading a `tauri::State` parameter
//! through would cascade into those call sites too.
//!
//! Known v1 limitations (see the project plan for the full rationale):
//! - Host-key verification is accept-any — no known_hosts pinning yet.
//! - Private keys must be unencrypted (no passphrase field in the UI).
//! - A jump host reuses the same key/password as the main SSH hop.
//! - Tunneling a TLS-enabled connection will generally fail certificate
//!   hostname verification (the driver connects to `127.0.0.1`, not the
//!   real hostname the cert was issued for).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelStream;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

const SSH_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// ─── Config ─────────────────────────────────────────────────────────────────

/// Mirrors `SshTunnelConfig` in `src/core/domain/types.ts` field-for-field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelSpec {
    pub ssh_host: String,
    #[serde(default)]
    pub ssh_port: Option<u16>,
    pub ssh_user: String,
    #[serde(default)]
    pub ssh_key_path: Option<String>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub jump_host: Option<String>,
}

// ─── Error model ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SshTunnelErrorKind {
    Auth,
    Network,
    Timeout,
    Config,
    Unknown,
}

/// Mirrors `commands::redis::RedisError` — its own error type for the same
/// reason: a structurally different subsystem, not a SQL driver error.
#[derive(Debug, Clone, Serialize)]
pub struct SshTunnelError {
    pub kind: SshTunnelErrorKind,
    pub message: String,
}

impl SshTunnelError {
    fn new(kind: SshTunnelErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|_| "{\"kind\":\"unknown\",\"message\":\"ssh tunnel error\"}".to_string())
    }
}

impl From<russh::Error> for SshTunnelError {
    fn from(err: russh::Error) -> Self {
        let raw = err.to_string();
        let lower = raw.to_lowercase();
        let kind = if lower.contains("timed out") || lower.contains("timeout") {
            SshTunnelErrorKind::Timeout
        } else if lower.contains("no more authentication methods") || lower.contains("auth")
        {
            SshTunnelErrorKind::Auth
        } else if lower.contains("connection refused")
            || lower.contains("dns")
            || lower.contains("unreachable")
            || lower.contains("broken pipe")
        {
            SshTunnelErrorKind::Network
        } else {
            SshTunnelErrorKind::Unknown
        };
        SshTunnelError::new(kind, raw)
    }
}

impl From<russh::keys::Error> for SshTunnelError {
    fn from(err: russh::keys::Error) -> Self {
        SshTunnelError::new(
            SshTunnelErrorKind::Config,
            format!("Could not load the private key: {err}"),
        )
    }
}

impl From<std::io::Error> for SshTunnelError {
    fn from(err: std::io::Error) -> Self {
        let kind = match err.kind() {
            std::io::ErrorKind::TimedOut => SshTunnelErrorKind::Timeout,
            std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound => {
                SshTunnelErrorKind::Network
            }
            _ => SshTunnelErrorKind::Unknown,
        };
        SshTunnelError::new(kind, err.to_string())
    }
}

// ─── Host-spec parsing (`user@host:port` / `host:port`) ────────────────────

/// Parse the `jumpHost` field's free-form `user@host:port` / `host:port`
/// form. Missing user falls back to `default_user` (the main hop's SSH
/// user — the jump host is assumed to accept the same login unless the
/// field explicitly overrides it). Missing port falls back to 22.
fn parse_host_spec(spec: &str, default_user: &str) -> (String, String, u16) {
    let (user, rest) = match spec.split_once('@') {
        Some((u, r)) => (u.to_string(), r),
        None => (default_user.to_string(), spec),
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().unwrap_or(22)),
        None => (rest.to_string(), 22),
    };
    (user, host, port)
}

// ─── SSH client handler ─────────────────────────────────────────────────────

/// Accept-any host key verification. See the module doc's limitations list —
/// this is a known, deliberate v1 trade-off, not an oversight.
struct TunnelClient;

impl client::Handler for TunnelClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Authenticate as `user` on an already-connected session: try the private
/// key first when `key_path` is set, otherwise fall back to `password`.
async fn authenticate(
    session: &mut Handle<TunnelClient>,
    user: &str,
    key_path: Option<&str>,
    password: Option<&str>,
) -> Result<(), SshTunnelError> {
    if let Some(path) = key_path.filter(|p| !p.trim().is_empty()) {
        let key_pair = load_secret_key(path, None)?;
        let hash_alg = session.best_supported_rsa_hash().await?.flatten();
        let result = session
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg))
            .await?;
        if result.success() {
            return Ok(());
        }
        return Err(SshTunnelError::new(
            SshTunnelErrorKind::Auth,
            "SSH authentication failed (private key rejected).",
        ));
    }

    let password = password.unwrap_or_default();
    let result = session.authenticate_password(user, password).await?;
    if result.success() {
        Ok(())
    } else {
        Err(SshTunnelError::new(
            SshTunnelErrorKind::Auth,
            "SSH authentication failed (check the username/password).",
        ))
    }
}

async fn connect_hop(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    password: Option<&str>,
) -> Result<Handle<TunnelClient>, SshTunnelError> {
    let config = Arc::new(client::Config { nodelay: true, ..Default::default() });
    let mut session = tokio::time::timeout(
        SSH_CONNECT_TIMEOUT,
        client::connect(config, (host, port), TunnelClient),
    )
    .await
    .map_err(|_| {
        SshTunnelError::new(
            SshTunnelErrorKind::Timeout,
            format!("SSH connect to {host}:{port} timed out."),
        )
    })??;
    authenticate(&mut session, user, key_path, password).await?;
    Ok(session)
}

async fn connect_hop_over_stream(
    stream: ChannelStream<client::Msg>,
    user: &str,
    key_path: Option<&str>,
    password: Option<&str>,
) -> Result<Handle<TunnelClient>, SshTunnelError> {
    let config = Arc::new(client::Config { nodelay: true, ..Default::default() });
    let mut session = client::connect_stream(config, stream, TunnelClient).await?;
    authenticate(&mut session, user, key_path, password).await?;
    Ok(session)
}

/// Establish the (possibly two-hop) SSH session described by `spec`. When
/// `jump_host` is set, hops through it first: connect+auth there, open a
/// direct-tcpip channel to `sshHost:sshPort` *from* the jump host, and run a
/// second SSH handshake over that channel to reach the real bastion.
async fn establish(spec: &SshTunnelSpec) -> Result<Handle<TunnelClient>, SshTunnelError> {
    let ssh_port = spec.ssh_port.unwrap_or(22);
    let key_path = spec.ssh_key_path.as_deref();
    let password = spec.ssh_password.as_deref();

    match spec.jump_host.as_deref().filter(|s| !s.trim().is_empty()) {
        None => connect_hop(&spec.ssh_host, ssh_port, &spec.ssh_user, key_path, password).await,
        Some(jump) => {
            let (jump_user, jump_host, jump_port) = parse_host_spec(jump, &spec.ssh_user);
            let first_hop = connect_hop(&jump_host, jump_port, &jump_user, key_path, password).await?;
            let channel = first_hop
                .channel_open_direct_tcpip(spec.ssh_host.clone(), ssh_port as u32, "127.0.0.1", 0)
                .await?;
            connect_hop_over_stream(channel.into_stream(), &spec.ssh_user, key_path, password).await
        }
    }
}

// ─── Standalone SSH test ────────────────────────────────────────────────────

/// Result of testing just the SSH hop (auth only — no local forward, no
/// database driver involved). Mirrors the shape of `ConnectionTestResult` in
/// `connection.rs` so the frontend can render it with the same component.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: u64,
}

/// Connect and authenticate through `spec` (and its jump host, if any) and
/// disconnect immediately — lets the UI's "Test SSH Connection" button
/// validate the tunnel hop on its own, before a database driver is ever
/// involved. Never touches the tunnel registry in `resolve_target`, so it
/// can't collide with (or evict) a cached tunnel already in use.
#[tauri::command]
pub async fn test_ssh_connection(spec: SshTunnelSpec) -> Result<SshTestResult, String> {
    let start = std::time::Instant::now();
    match establish(&spec).await {
        Ok(session) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            let _ = session.disconnect(russh::Disconnect::ByApplication, "", "").await;
            Ok(SshTestResult {
                success: true,
                message: format!("SSH connected as {}@{}", spec.ssh_user, spec.ssh_host),
                latency_ms,
            })
        }
        Err(e) => Ok(SshTestResult {
            success: false,
            message: e.message,
            latency_ms: start.elapsed().as_millis() as u64,
        }),
    }
}

// ─── Local port forward ─────────────────────────────────────────────────────

/// Binds an ephemeral local port and forwards every accepted connection to
/// `target_host:target_port` through `session`, each on its own SSH channel.
/// `channel_open_direct_tcpip` takes `&self` (confirmed by reading russh's
/// source — it only sends on a cloneable `mpsc::Sender` and awaits a fresh
/// per-call reply channel), so concurrent forwarded connections don't need a
/// mutex around the shared session.
async fn spawn_local_forward(
    session: Arc<Handle<TunnelClient>>,
    target_host: String,
    target_port: u16,
) -> Result<SocketAddr, SshTunnelError> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_addr = listener.local_addr()?;

    tokio::spawn(async move {
        loop {
            let (mut local_stream, _peer) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => break, // listener dropped/closed — stop the loop.
            };
            let session = session.clone();
            let target_host = target_host.clone();
            tokio::spawn(async move {
                let channel = match session
                    .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
                    .await
                {
                    Ok(c) => c,
                    Err(_) => {
                        let _ = local_stream.shutdown().await;
                        return;
                    }
                };
                let mut channel_stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut local_stream, &mut channel_stream).await;
            });
        }
    });

    Ok(local_addr)
}

// ─── Registry ───────────────────────────────────────────────────────────────

struct CachedTunnel {
    local_addr: SocketAddr,
    target: (String, u16),
    session: Arc<Handle<TunnelClient>>,
}

fn registry() -> &'static Mutex<HashMap<String, CachedTunnel>> {
    static TUNNELS: OnceLock<Mutex<HashMap<String, CachedTunnel>>> = OnceLock::new();
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The one entry point every driver's connect path calls. Returns
/// `(host, port)` unchanged when `config.ssh` is `None` — zero behavior
/// change for the non-tunneled case. Otherwise reuses a cached tunnel for
/// this connection id (re-establishing if the session died or the target
/// changed), and returns the local forward address to connect to instead.
pub async fn resolve_target(
    config: &super::connection::ConnectionConfig,
    host: String,
    port: u16,
) -> Result<(String, u16), String> {
    let Some(spec) = config.ssh.as_ref() else {
        return Ok((host, port));
    };

    let key = config.id.clone().unwrap_or_else(|| format!("{}:{}", spec.ssh_host, spec.ssh_user));

    // Fast path: a cached, still-open tunnel to the same target.
    {
        let cache = registry().lock().unwrap();
        if let Some(cached) = cache.get(&key) {
            if cached.target == (host.clone(), port) && !cached.session.is_closed() {
                return Ok((cached.local_addr.ip().to_string(), cached.local_addr.port()));
            }
        }
    }

    let session = establish(spec).await.map_err(|e| e.to_json_string())?;
    let session = Arc::new(session);
    let local_addr = spawn_local_forward(session.clone(), host.clone(), port)
        .await
        .map_err(|e| e.to_json_string())?;

    registry().lock().unwrap().insert(
        key,
        CachedTunnel { local_addr, target: (host, port), session },
    );

    Ok((local_addr.ip().to_string(), local_addr.port()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_host_spec_with_user_and_port() {
        assert_eq!(
            parse_host_spec("alice@jump.example.com:2222", "fallback"),
            ("alice".to_string(), "jump.example.com".to_string(), 2222)
        );
    }

    #[test]
    fn parse_host_spec_defaults_user_and_port() {
        assert_eq!(
            parse_host_spec("jump.example.com", "bob"),
            ("bob".to_string(), "jump.example.com".to_string(), 22)
        );
    }

    #[test]
    fn parse_host_spec_host_and_port_no_user() {
        assert_eq!(
            parse_host_spec("jump.example.com:2200", "bob"),
            ("bob".to_string(), "jump.example.com".to_string(), 2200)
        );
    }
}
