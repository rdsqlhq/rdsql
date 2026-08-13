//! Connection pool cache — keeps long-lived database connection pools in Tauri
//! app state so that repeated `execute_query` calls reuse existing connections
//! instead of paying the full TCP handshake + auth cost every time.
//!
//! Currently pools MySQL connections (via `mysql_async::Pool`). SQLite opens
//! are cheap (file handle) and Postgres connections are managed per-call until
//! a pooling crate is added.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use mysql_async::Opts;

/// A fingerprint of the connection parameters, used as the pool cache key.
/// Two connections with the same host/port/user/db share a pool.
fn pool_key(host: &str, port: u16, user: &str, db: &Option<String>) -> String {
    format!("{}|{}|{}|{}", host, port, user, db.as_deref().unwrap_or(""))
}

/// Holds cached MySQL connection pools, keyed by connection fingerprint.
/// Pools are created on first use and kept alive for the app's lifetime.
pub type PoolManager = Arc<Mutex<HashMap<String, mysql_async::Pool>>>;

/// Create a new empty pool manager.
pub fn new_pool_manager() -> PoolManager {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Get or create a MySQL pool for the given connection options. If a pool
/// already exists for this fingerprint, it's reused — no new TCP connections
/// are opened unless the pool needs to grow.
pub async fn get_or_create_pool(
    pools: &PoolManager,
    opts: Opts,
    host: &str,
    port: u16,
    user: &str,
    db: &Option<String>,
) -> mysql_async::Pool {
    let key = pool_key(host, port, user, db);
    let mut map = pools.lock().await;
    if let Some(pool) = map.get(&key) {
        return pool.clone();
    }
    let pool = mysql_async::Pool::new(opts);
    map.insert(key, pool.clone());
    pool
}
