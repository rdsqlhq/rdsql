//! MongoDB — document store.
//!
//! Isolated, additive module — no other command or subsystem depends on it,
//! mirroring `commands::redis`. MongoDB reuses the shared
//! `super::connection::ConnectionConfig`: host/port/username/password/
//! database already cover the common case, plus three Mongo-specific fields
//! (`mongo_auth_source`, `mongo_replica_set`, `mongo_connection_string`).
//! Mongo still belongs in the same connection list/modal as the SQL engines
//! and Redis (see `commands::connection::test_connection`/
//! `fetch_schema_tree_impl`, which short-circuit for `engine == "mongodb"`
//! before the SQL family match — the same pattern already used for
//! D1/DuckDB/Redis).
//!
//! Unlike Redis (flat keyspace, no natural tree), Mongo's database →
//! collection structure fits the Explorer's existing schema-tree UX, so
//! `fetch_mongo_schema` populates real `SchemaNode`s (`node_type: "schema"`
//! for a database, `"collection"` for a collection) instead of returning an
//! empty tree. What *is* isolated is document data itself: a collection has
//! no fixed columns, so query results here are plain JSON (`serde_json::Value`),
//! not `QueryResultData`.
//!
//! ## BSON ↔ JSON
//!
//! MongoDB documents are BSON, which has types JSON has no native
//! representation for (`ObjectId`, `DateTime`, `Decimal128`, `Binary`, …).
//! Rather than inventing a bespoke mapping, this module uses the `bson`
//! crate's own [MongoDB Extended JSON v2](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/)
//! (relaxed mode) support — the same convention Compass/`mongoexport` use —
//! so a document round-trips losslessly: `{"$oid": "<hex>"}`,
//! `{"$date": "<millis-since-epoch>"}`, etc. The frontend only ever sees and
//! sends this shape; it never needs its own BSON type mapping.
//!
//! ## Connection string
//!
//! `mongo_connection_string`, when set, is used verbatim instead of composing
//! a URI from the discrete fields — this is the only way to express
//! `mongodb+srv://` (Atlas) connections, which have no fixed port and whose
//! host list is resolved via DNS SRV/TXT records rather than being given
//! directly. An SSH tunnel (`config.ssh`) is therefore only honored on the
//! discrete-fields path: a `+srv` URI resolves its *real* replica-set hosts
//! internally, so tunneling would forward to the wrong place. This mirrors
//! `ssh_tunnel.rs`'s existing TLS-hostname-verification caveat.

use std::collections::HashMap;
use std::time::Duration;

use mongodb::bson::{doc, Bson, Document};
use mongodb::options::ClientOptions;
use mongodb::results::CollectionType;
use mongodb::{Client, Collection, IndexModel};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::Value as JsonValue;

use super::connection::{normalize_host, ConnectionConfig, SchemaNode};

/// Bound how long we'll wait on the initial connection/auth handshake —
/// mirrors `commands::connection::CONNECT_TIMEOUT`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Default/maximum documents returned per `mongo_find_documents` page — a
/// production collection can hold millions of documents, so pagination is
/// mandatory, not optional. Mirrors `commands::redis::MAX_COLLECTION_ITEMS`.
const DEFAULT_PAGE_SIZE: i64 = 50;
const MAX_PAGE_SIZE: i64 = 500;

/// Mongo's own reserved/system databases — filtered out of the schema tree
/// unless `include_system_schemas` is set, the same convention already used
/// for Postgres (`pg_catalog`) and MySQL (`information_schema`).
pub(crate) const SYSTEM_DATABASES: [&str; 3] = ["admin", "local", "config"];

// ─── Error model ────────────────────────────────────────────────────────────

/// Mongo error kind — mirrored on the frontend as `MongoErrorKind`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MongoErrorKind {
    Auth,
    NotFound,
    Network,
    Timeout,
    Config,
    Unknown,
}

/// A normalized Mongo error. Serialized to JSON for the command boundary,
/// mirroring `commands::redis::RedisError` — a structurally different
/// subsystem shouldn't be forced through `commands::error::DbError`.
#[derive(Debug, Clone, Serialize)]
pub struct MongoError {
    pub kind: MongoErrorKind,
    pub message: String,
}

impl MongoError {
    pub fn new(kind: MongoErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|_| "{\"kind\":\"unknown\",\"message\":\"mongodb error\"}".to_string())
    }
}

/// Classify the driver's own error type by message text rather than its
/// `ErrorKind` enum directly — text-based classification (same approach as
/// `commands::redis::RedisError::from`) is far less likely to break across
/// `mongodb` crate version bumps than pattern-matching an enum that isn't
/// ours to keep stable.
impl From<mongodb::error::Error> for MongoError {
    fn from(err: mongodb::error::Error) -> Self {
        let raw = err.to_string();
        let lower = raw.to_lowercase();
        let kind = if lower.contains("timed out") || lower.contains("timeout") {
            MongoErrorKind::Timeout
        } else if lower.contains("authentication failed")
            || lower.contains("auth error")
            || lower.contains("unauthorized")
            || lower.contains("not authorized")
        {
            MongoErrorKind::Auth
        } else if lower.contains("server selection")
            || lower.contains("connection refused")
            || lower.contains("dns")
            || lower.contains("unreachable")
            || lower.contains("no reachable servers")
            || lower.contains("broken pipe")
        {
            MongoErrorKind::Network
        } else {
            MongoErrorKind::Unknown
        };
        MongoError::new(kind, raw)
    }
}

/// Convenience for `.map_err(err_str)` at the `#[tauri::command]` boundary.
fn err_str(e: mongodb::error::Error) -> String {
    MongoError::from(e).to_json_string()
}

// ─── BSON ↔ JSON ────────────────────────────────────────────────────────────

/// Convert a document to the relaxed MongoDB Extended JSON shape the
/// frontend consumes — see the module doc for why this (not a bespoke
/// mapping) is the right tool.
fn document_to_json(doc: Document) -> JsonValue {
    Bson::Document(doc).into_relaxed_extjson()
}

/// Parse a JSON object (as sent back by the frontend — either round-tripped
/// from `document_to_json` or freshly authored by a user) into a `Document`.
/// Accepts both canonical and relaxed extended JSON, per `bson`'s own
/// `TryFrom<serde_json::Value>` support.
fn json_to_document(value: JsonValue) -> Result<Document, MongoError> {
    let bson: Bson = value
        .try_into()
        .map_err(|e| MongoError::new(MongoErrorKind::Config, format!("Invalid document JSON: {e}")))?;
    match bson {
        Bson::Document(d) => Ok(d),
        _ => Err(MongoError::new(MongoErrorKind::Config, "Expected a JSON object for the document.")),
    }
}

// ─── Connection ─────────────────────────────────────────────────────────────

/// Compose a `mongodb://` URI from the shared `ConnectionConfig`'s discrete
/// fields. Never called directly for `mongo_connection_string`-configured
/// connections — see `resolve_uri`. Credentials are percent-encoded so
/// passwords containing `@`, `:`, `/`, etc. don't corrupt the URI, mirroring
/// `commands::redis::build_url`.
fn build_uri(config: &ConnectionConfig) -> Result<String, MongoError> {
    let host = normalize_host(config.host.clone());
    if host.trim().is_empty() {
        return Err(MongoError::new(MongoErrorKind::Config, "Host is required."));
    }
    let port = config.port.unwrap_or(27017);

    let password = config.password.as_deref().unwrap_or("");
    let username = config.username.as_deref().unwrap_or("");
    let userinfo = if username.is_empty() && password.is_empty() {
        String::new()
    } else {
        format!(
            "{}:{}@",
            utf8_percent_encode(username, NON_ALPHANUMERIC),
            utf8_percent_encode(password, NON_ALPHANUMERIC)
        )
    };

    let db = config.database.as_deref().filter(|d| !d.trim().is_empty()).unwrap_or("admin");

    let mut params: Vec<String> = Vec::new();
    if let Some(auth_source) = config.mongo_auth_source.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(format!("authSource={}", utf8_percent_encode(auth_source, NON_ALPHANUMERIC)));
    }
    if let Some(rs) = config.mongo_replica_set.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(format!("replicaSet={}", utf8_percent_encode(rs, NON_ALPHANUMERIC)));
    }
    let use_tls = config
        .ssl_mode
        .as_deref()
        .map(|m| !m.trim().is_empty() && !m.eq_ignore_ascii_case("disable"))
        .unwrap_or(false);
    if use_tls {
        params.push("tls=true".to_string());
    }
    let query = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };

    Ok(format!("mongodb://{userinfo}{host}:{port}/{db}{query}"))
}

/// Resolve the effective connection URI: an explicit `mongo_connection_string`
/// override wins verbatim (the only way to express `mongodb+srv://`), and
/// bypasses the SSH tunnel entirely — see the module doc. Otherwise resolves
/// the tunnel (if any) and composes a URI from the discrete fields.
async fn resolve_uri(config: &ConnectionConfig) -> Result<String, MongoError> {
    if let Some(cs) = config.mongo_connection_string.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(cs.to_string());
    }

    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(27017);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port)
        .await
        .map_err(|message| MongoError::new(MongoErrorKind::Network, message))?;
    let mut effective_config = config.clone();
    effective_config.host = Some(host);
    effective_config.port = Some(port);

    build_uri(&effective_config)
}

/// Build a client for the duration of one command. `mongodb::Client` is
/// itself a thin handle around an internally pooled/monitored topology (no
/// separate pooling layer needed here, unlike MySQL's `pool.rs`), but every
/// other driver in this app also connects fresh per call, so this stays
/// consistent rather than introducing a new lifetime to manage.
pub(crate) async fn open_client(config: &ConnectionConfig) -> Result<Client, MongoError> {
    let uri = resolve_uri(config).await?;
    let mut options = ClientOptions::parse(&uri).await.map_err(MongoError::from)?;
    options.connect_timeout = Some(CONNECT_TIMEOUT);
    options.server_selection_timeout = Some(CONNECT_TIMEOUT);
    Client::with_options(options).map_err(MongoError::from)
}

fn collection(client: &Client, database: &str, collection: &str) -> Collection<Document> {
    client.database(database).collection::<Document>(collection)
}

// ─── Result shapes (serde camelCase for the TS boundary) ──────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoTestResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDatabaseInfo {
    pub name: String,
    pub size_on_disk: u64,
    pub empty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCollectionInfo {
    pub name: String,
    /// An estimate (collection metadata, not a full scan) — same trade-off
    /// as every other engine's row-count display in the Explorer tree.
    pub doc_count: u64,
    /// True for a MongoDB view (a saved aggregation pipeline over another
    /// collection, read-only) — the Explorer groups these separately from
    /// regular collections, same as SQL engines split tables from views.
    pub is_view: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDocumentPage {
    pub documents: Vec<JsonValue>,
    /// True when more documents exist past this page (fetched `limit + 1`
    /// and trimmed) — mirrors `RedisValueDto`'s `truncated` flag.
    pub has_more: bool,
}

// ─── Schema tree (Explorer integration) ────────────────────────────────────

/// Populate the Explorer's schema tree with database → collection/view
/// nodes. Called from `connection::fetch_schema_tree_impl`'s
/// `engine == "mongodb"` short-circuit. Unlike Redis (flat keyspace, empty
/// tree), Mongo's structure fits the tree directly — the Explorer's existing
/// table/view folder-grouping UI splits `node_type: "collection"` from
/// `node_type: "view"` the same way it already splits SQL tables from views.
pub async fn fetch_mongo_schema(config: &ConnectionConfig) -> Result<Vec<SchemaNode>, String> {
    let client = open_client(config).await.map_err(|e| e.to_json_string())?;
    let include_system = config.include_system_schemas.unwrap_or(false);

    let databases = client.list_databases().await.map_err(err_str)?;
    let mut result = Vec::with_capacity(databases.len());

    for db_info in databases {
        if !include_system && SYSTEM_DATABASES.contains(&db_info.name.as_str()) {
            continue;
        }

        let db = client.database(&db_info.name);
        let mut cursor = db.list_collections().await.map_err(err_str)?;
        let mut collection_nodes = Vec::new();
        while cursor.advance().await.map_err(err_str)? {
            let spec = cursor.deserialize_current().map_err(err_str)?;
            if spec.name.starts_with("system.") {
                continue;
            }
            let is_view = spec.collection_type == CollectionType::View;
            // `estimatedDocumentCount` isn't meaningful for a view (it has no
            // storage stats of its own) — skip the round trip entirely
            // rather than surface a confusing 0.
            let doc_count = if is_view {
                None
            } else {
                Some(db.collection::<Document>(&spec.name).estimated_document_count().await.unwrap_or(0))
            };
            collection_nodes.push(SchemaNode {
                name: spec.name,
                node_type: if is_view { "view" } else { "collection" }.to_string(),
                data_type: None,
                row_count: doc_count,
                size_bytes: None,
                is_primary_key: None,
                is_foreign_key: None,
                is_nullable: None,
                has_default: None,
                children: vec![],
            });
        }
        collection_nodes.sort_by(|a, b| a.name.cmp(&b.name));

        result.push(SchemaNode {
            name: db_info.name,
            node_type: "schema".to_string(),
            data_type: None,
            row_count: None,
            size_bytes: Some(db_info.size_on_disk),
            is_primary_key: None,
            is_foreign_key: None,
            is_nullable: None,
            has_default: None,
            children: collection_nodes,
        });
    }

    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Shared by the `#[tauri::command]` wrapper below and
/// `commands::connection::test_connection`'s short-circuit for
/// `engine == "mongodb"`, which needs a plain `MongoError` (with a readable
/// `.message`) rather than the JSON-encoded string the command boundary uses.
pub(crate) async fn test_connection_impl(config: &ConnectionConfig) -> Result<MongoTestResult, MongoError> {
    let started = std::time::Instant::now();
    let client = open_client(config).await?;
    tokio::time::timeout(CONNECT_TIMEOUT, client.database("admin").run_command(doc! { "ping": 1 }))
        .await
        .map_err(|_| MongoError::new(MongoErrorKind::Timeout, "Connection to MongoDB timed out."))?
        .map_err(MongoError::from)?;
    Ok(MongoTestResult {
        success: true,
        message: "Connected to MongoDB.".to_string(),
        latency_ms: Some(started.elapsed().as_millis() as u64),
    })
}

#[tauri::command]
pub async fn mongo_test_connection(config: ConnectionConfig) -> Result<MongoTestResult, String> {
    test_connection_impl(&config).await.map_err(|e| e.to_json_string())
}

#[tauri::command]
pub async fn mongo_list_databases(config: ConnectionConfig) -> Result<Vec<MongoDatabaseInfo>, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let databases = client.list_databases().await.map_err(err_str)?;
    Ok(databases
        .into_iter()
        .map(|d| MongoDatabaseInfo { name: d.name, size_on_disk: d.size_on_disk, empty: d.empty })
        .collect())
}

#[tauri::command]
pub async fn mongo_list_collections(
    config: ConnectionConfig,
    database: String,
) -> Result<Vec<MongoCollectionInfo>, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let db = client.database(&database);
    let mut cursor = db.list_collections().await.map_err(err_str)?;

    let mut collections = Vec::new();
    while cursor.advance().await.map_err(err_str)? {
        let spec = cursor.deserialize_current().map_err(err_str)?;
        if spec.name.starts_with("system.") {
            continue;
        }
        let is_view = spec.collection_type == CollectionType::View;
        let doc_count = if is_view {
            0
        } else {
            db.collection::<Document>(&spec.name).estimated_document_count().await.unwrap_or(0)
        };
        collections.push(MongoCollectionInfo { name: spec.name, doc_count, is_view });
    }
    collections.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(collections)
}

#[tauri::command]
pub async fn mongo_count_documents(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    filter: Option<JsonValue>,
) -> Result<u64, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let filter_doc = match filter {
        Some(v) => json_to_document(v).map_err(|e| e.to_json_string())?,
        None => Document::new(),
    };
    coll.count_documents(filter_doc).await.map_err(err_str)
}

/// Paginated document listing with an optional JSON filter/sort — the
/// document-store analogue of a `SELECT ... LIMIT/OFFSET`. Fetches
/// `limit + 1` documents so `has_more` can be reported without a second
/// round trip (same trick `redis.rs` doesn't need, since Redis paginates via
/// a server-held `SCAN` cursor instead — Mongo's cursor isn't stable across
/// separate command invocations here since each call opens a fresh client).
#[tauri::command]
pub async fn mongo_find_documents(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    filter: Option<JsonValue>,
    project: Option<JsonValue>,
    sort: Option<JsonValue>,
    skip: Option<u64>,
    limit: Option<i64>,
) -> Result<MongoDocumentPage, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);

    let filter_doc = match filter {
        Some(v) => json_to_document(v).map_err(|e| e.to_json_string())?,
        None => Document::new(),
    };
    let page_size = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);

    let mut find = coll.find(filter_doc).skip(skip.unwrap_or(0)).limit(page_size + 1);
    if let Some(sort_value) = sort {
        find = find.sort(json_to_document(sort_value).map_err(|e| e.to_json_string())?);
    }
    if let Some(project_value) = project {
        find = find.projection(json_to_document(project_value).map_err(|e| e.to_json_string())?);
    }
    let mut cursor = find.await.map_err(err_str)?;

    let mut documents = Vec::new();
    while cursor.advance().await.map_err(err_str)? {
        let doc = cursor.deserialize_current().map_err(err_str)?;
        documents.push(doc);
        if documents.len() as i64 > page_size {
            break;
        }
    }
    let has_more = documents.len() as i64 > page_size;
    if has_more {
        documents.truncate(page_size as usize);
    }

    Ok(MongoDocumentPage { documents: documents.into_iter().map(document_to_json).collect(), has_more })
}

#[tauri::command]
pub async fn mongo_get_document(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    filter: JsonValue,
) -> Result<Option<JsonValue>, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let filter_doc = json_to_document(filter).map_err(|e| e.to_json_string())?;
    let found = coll.find_one(filter_doc).await.map_err(err_str)?;
    Ok(found.map(document_to_json))
}

#[tauri::command]
pub async fn mongo_insert_document(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    document: JsonValue,
) -> Result<JsonValue, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let doc = json_to_document(document).map_err(|e| e.to_json_string())?;
    let result = coll.insert_one(doc).await.map_err(err_str)?;
    Ok(result.inserted_id.into_relaxed_extjson())
}

#[tauri::command]
pub async fn mongo_update_document(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    filter: JsonValue,
    document: JsonValue,
) -> Result<(), String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let filter_doc = json_to_document(filter).map_err(|e| e.to_json_string())?;
    let replacement = json_to_document(document).map_err(|e| e.to_json_string())?;
    let result = coll.replace_one(filter_doc, replacement).await.map_err(err_str)?;
    if result.matched_count == 0 {
        return Err(MongoError::new(MongoErrorKind::NotFound, "No document matched the given filter.")
            .to_json_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn mongo_delete_document(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    filter: JsonValue,
) -> Result<(), String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let filter_doc = json_to_document(filter).map_err(|e| e.to_json_string())?;
    let result = coll.delete_one(filter_doc).await.map_err(err_str)?;
    if result.deleted_count == 0 {
        return Err(MongoError::new(MongoErrorKind::NotFound, "No document matched the given filter.")
            .to_json_string());
    }
    Ok(())
}

/// Bulk-delete every document matching `filter` in one round trip (the
/// Explorer's document table uses this for "delete selected", passing
/// `{ _id: { $in: [...] } }` — one `delete_many` instead of N `delete_one`
/// calls). Returns the deleted count so the UI can confirm how many rows
/// actually matched, since a stale selection (deleted by another session
/// between load and click) can legitimately delete fewer than requested.
#[tauri::command]
pub async fn mongo_delete_documents(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    filter: JsonValue,
) -> Result<u64, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let filter_doc = json_to_document(filter).map_err(|e| e.to_json_string())?;
    let result = coll.delete_many(filter_doc).await.map_err(err_str)?;
    Ok(result.deleted_count)
}

// ─── Indexes ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoIndexInfo {
    pub name: String,
    pub keys: JsonValue,
    pub unique: bool,
    pub sparse: bool,
}

#[tauri::command]
pub async fn mongo_list_indexes(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
) -> Result<Vec<MongoIndexInfo>, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let mut cursor = coll.list_indexes().await.map_err(err_str)?;

    let mut indexes = Vec::new();
    while cursor.advance().await.map_err(err_str)? {
        let model = cursor.deserialize_current().map_err(err_str)?;
        let opts = model.options.unwrap_or_default();
        indexes.push(MongoIndexInfo {
            name: opts.name.unwrap_or_default(),
            keys: document_to_json(model.keys),
            unique: opts.unique.unwrap_or(false),
            sparse: opts.sparse.unwrap_or(false),
        });
    }
    Ok(indexes)
}

/// Creates a single-or-compound index. `keys` is the standard Mongo index
/// spec, e.g. `{"email": 1}` or `{"createdAt": -1, "status": 1}`.
#[tauri::command]
pub async fn mongo_create_index(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    keys: JsonValue,
    name: Option<String>,
    unique: Option<bool>,
    sparse: Option<bool>,
) -> Result<String, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let keys_doc = json_to_document(keys).map_err(|e| e.to_json_string())?;
    let options = mongodb::options::IndexOptions::builder().name(name).unique(unique).sparse(sparse).build();
    let model = IndexModel::builder().keys(keys_doc).options(Some(options)).build();
    let result = coll.create_index(model).await.map_err(err_str)?;
    Ok(result.index_name)
}

#[tauri::command]
pub async fn mongo_drop_index(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    index_name: String,
) -> Result<(), String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    coll.drop_index(index_name).await.map_err(err_str)
}

// ─── Schema inference ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoFieldTypeCount {
    pub bson_type: String,
    pub count: u64,
    pub percentage: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoFieldStat {
    pub name: String,
    pub types: Vec<MongoFieldTypeCount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoSchemaInference {
    pub sampled: u64,
    pub fields: Vec<MongoFieldStat>,
}

/// The BSON type name as MongoDB's own `$type`/Compass conventions spell it
/// (not Rust's `Bson` variant names) — e.g. `"objectId"`, not `"ObjectId"`.
fn bson_type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) => "javascript",
        Bson::JavaScriptCodeWithScope(_) => "javascriptWithScope",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// Infers a lightweight "schema" for a schemaless collection by randomly
/// sampling documents (`$sample`, cheap even on huge collections — no full
/// scan) and tallying each top-level field's BSON type across the sample.
/// Percentages are relative to the sample actually fetched, not the whole
/// collection — surfaced as `sampled` so the UI can label it honestly
/// ("Fields detected from N sampled documents", not "N documents").
#[tauri::command]
pub async fn mongo_infer_schema(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    sample_size: Option<u32>,
) -> Result<MongoSchemaInference, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);
    let size = sample_size.unwrap_or(100).clamp(1, 1000) as i64;

    let mut cursor = coll.aggregate(vec![doc! { "$sample": { "size": size } }]).await.map_err(err_str)?;

    let mut counts: HashMap<String, HashMap<&'static str, u64>> = HashMap::new();
    let mut sampled: u64 = 0;
    while cursor.advance().await.map_err(err_str)? {
        let doc = cursor.deserialize_current().map_err(err_str)?;
        sampled += 1;
        for (key, value) in doc.iter() {
            *counts.entry(key.clone()).or_default().entry(bson_type_name(value)).or_insert(0) += 1;
        }
    }

    let mut fields: Vec<MongoFieldStat> = counts
        .into_iter()
        .map(|(name, type_counts)| {
            let mut types: Vec<MongoFieldTypeCount> = type_counts
                .into_iter()
                .map(|(bson_type, count)| MongoFieldTypeCount {
                    bson_type: bson_type.to_string(),
                    count,
                    percentage: if sampled > 0 { (count as f64 / sampled as f64) * 100.0 } else { 0.0 },
                })
                .collect();
            types.sort_by(|a, b| b.count.cmp(&a.count));
            MongoFieldStat { name, types }
        })
        .collect();
    fields.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(MongoSchemaInference { sampled, fields })
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/// Runs a raw aggregation pipeline (array of stage documents, e.g.
/// `[{"$match": {...}}, {"$group": {...}}]`) and returns up to
/// `MAX_PAGE_SIZE` result documents — an aggregation can fan out far beyond
/// the source collection's size, so the same cap/`hasMore` convention as
/// `mongo_find_documents` applies.
#[tauri::command]
pub async fn mongo_run_aggregation(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
    pipeline: Vec<JsonValue>,
) -> Result<MongoDocumentPage, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let coll = collection(&client, &database, &collection_name);

    let stages: Vec<Document> = pipeline
        .into_iter()
        .map(json_to_document)
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_json_string())?;

    let mut cursor = coll.aggregate(stages).await.map_err(err_str)?;
    let mut documents = Vec::new();
    while cursor.advance().await.map_err(err_str)? {
        documents.push(cursor.deserialize_current().map_err(err_str)?);
        if documents.len() as i64 > MAX_PAGE_SIZE {
            break;
        }
    }
    let has_more = documents.len() as i64 > MAX_PAGE_SIZE;
    if has_more {
        documents.truncate(MAX_PAGE_SIZE as usize);
    }

    Ok(MongoDocumentPage { documents: documents.into_iter().map(document_to_json).collect(), has_more })
}

// ─── Stats ──────────────────────────────────────────────────────────────────

/// Pulls a numeric field out of a `runCommand` reply, tolerant of whichever
/// BSON numeric type the server used for it (`collStats`/`dbStats` mix
/// Int32/Int64/Double across fields and server versions) — missing or
/// non-numeric fields default to 0 rather than failing the whole command.
pub(crate) fn bson_num_as_u64(doc: &Document, key: &str) -> u64 {
    match doc.get(key) {
        Some(Bson::Int32(n)) => (*n).max(0) as u64,
        Some(Bson::Int64(n)) => (*n).max(0) as u64,
        Some(Bson::Double(n)) => n.max(0.0) as u64,
        _ => 0,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCollectionStats {
    pub count: u64,
    pub size: u64,
    pub avg_obj_size: u64,
    pub storage_size: u64,
    pub total_index_size: u64,
    pub index_count: u64,
}

#[tauri::command]
pub async fn mongo_collection_stats(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
) -> Result<MongoCollectionStats, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    let db = client.database(&database);
    let result = db.run_command(doc! { "collStats": collection_name }).await.map_err(err_str)?;
    Ok(MongoCollectionStats {
        count: bson_num_as_u64(&result, "count"),
        size: bson_num_as_u64(&result, "size"),
        avg_obj_size: bson_num_as_u64(&result, "avgObjSize"),
        storage_size: bson_num_as_u64(&result, "storageSize"),
        total_index_size: bson_num_as_u64(&result, "totalIndexSize"),
        index_count: bson_num_as_u64(&result, "nindexes"),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDatabaseStats {
    pub collections: u64,
    pub views: u64,
    pub objects: u64,
    pub data_size: u64,
    pub storage_size: u64,
    pub indexes: u64,
    pub index_size: u64,
}

/// Shared by the `#[tauri::command]` wrapper below and the Health overview
/// (`health::metrics::overview_mongo`), which sums this across every
/// non-system database rather than re-issuing `dbStats` inline.
pub(crate) async fn database_stats_for(client: &Client, database: &str) -> Result<MongoDatabaseStats, MongoError> {
    let db = client.database(database);
    let result = db.run_command(doc! { "dbStats": 1 }).await.map_err(MongoError::from)?;
    Ok(MongoDatabaseStats {
        collections: bson_num_as_u64(&result, "collections"),
        views: bson_num_as_u64(&result, "views"),
        objects: bson_num_as_u64(&result, "objects"),
        data_size: bson_num_as_u64(&result, "dataSize"),
        storage_size: bson_num_as_u64(&result, "storageSize"),
        indexes: bson_num_as_u64(&result, "indexes"),
        index_size: bson_num_as_u64(&result, "indexSize"),
    })
}

#[tauri::command]
pub async fn mongo_database_stats(
    config: ConnectionConfig,
    database: String,
) -> Result<MongoDatabaseStats, String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    database_stats_for(&client, &database).await.map_err(|e| e.to_json_string())
}

// ─── Collection / database admin ───────────────────────────────────────────

#[tauri::command]
pub async fn mongo_create_collection(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
) -> Result<(), String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    client.database(&database).create_collection(collection_name).await.map_err(err_str)
}

#[tauri::command]
pub async fn mongo_drop_collection(
    config: ConnectionConfig,
    database: String,
    collection_name: String,
) -> Result<(), String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    collection(&client, &database, &collection_name).drop().await.map_err(err_str)
}

#[tauri::command]
pub async fn mongo_drop_database(config: ConnectionConfig, database: String) -> Result<(), String> {
    let client = open_client(&config).await.map_err(|e| e.to_json_string())?;
    client.database(&database).drop().await.map_err(err_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> ConnectionConfig {
        ConnectionConfig {
            id: None,
            name: "test".into(),
            engine: "mongodb".into(),
            host: Some("localhost".into()),
            port: Some(27017),
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            file_path: None,
            cf_account_id: None,
            cf_api_token: None,
            cf_database_id: None,
            scope_database: None,
            include_system_schemas: None,
            redis_db_index: None,
            ssh: None,
            mongo_auth_source: None,
            mongo_replica_set: None,
            mongo_connection_string: None,
        }
    }

    #[test]
    fn build_uri_plain() {
        let uri = build_uri(&base_config()).unwrap();
        assert_eq!(uri, "mongodb://127.0.0.1:27017/admin");
    }

    #[test]
    fn build_uri_with_credentials_and_database() {
        let mut cfg = base_config();
        cfg.username = Some("app".into());
        cfg.password = Some("p@ss/word".into());
        cfg.database = Some("mydb".into());
        let uri = build_uri(&cfg).unwrap();
        assert!(uri.starts_with("mongodb://app:"));
        assert!(uri.contains("@127.0.0.1:27017/mydb"));
    }

    #[test]
    fn build_uri_with_auth_source_and_replica_set() {
        let mut cfg = base_config();
        cfg.mongo_auth_source = Some("admin".into());
        cfg.mongo_replica_set = Some("rs0".into());
        let uri = build_uri(&cfg).unwrap();
        assert_eq!(uri, "mongodb://127.0.0.1:27017/admin?authSource=admin&replicaSet=rs0");
    }

    #[test]
    fn build_uri_with_tls() {
        let mut cfg = base_config();
        cfg.ssl_mode = Some("require".into());
        let uri = build_uri(&cfg).unwrap();
        assert!(uri.ends_with("?tls=true"));
    }

    #[test]
    fn build_uri_rejects_empty_host() {
        let mut cfg = base_config();
        cfg.host = Some("".into());
        assert!(matches!(build_uri(&cfg), Err(e) if matches!(e.kind, MongoErrorKind::Config)));
    }

    #[tokio::test]
    async fn resolve_uri_uses_connection_string_override_verbatim() {
        let mut cfg = base_config();
        cfg.mongo_connection_string = Some("mongodb+srv://user:pass@cluster0.example.mongodb.net/mydb".into());
        // Host/port are deliberately wrong/unreachable — the override must
        // win without even looking at them or attempting a tunnel.
        cfg.host = Some("unreachable.invalid".into());
        let uri = resolve_uri(&cfg).await.unwrap();
        assert_eq!(uri, "mongodb+srv://user:pass@cluster0.example.mongodb.net/mydb");
    }

    #[test]
    fn document_json_roundtrip_preserves_object_id_and_date() {
        // Canonical extJSON in (`$numberLong`, the wire-precise form) — relaxed
        // extJSON out (an ISO-8601 string), since `document_to_json` always
        // produces the relaxed shape. Both inputs are accepted per `bson`'s
        // `TryFrom<serde_json::Value>` docs (mixing canonical/relaxed is fine),
        // and represent the identical instant — the round-trip just isn't
        // byte-identical for dates, only semantically identical.
        let json = serde_json::json!({
            "_id": { "$oid": "507f1f77bcf86cd799439011" },
            "name": "Ada",
            "createdAt": { "$date": { "$numberLong": "1590972160292" } },
        });
        let doc = json_to_document(json).unwrap();
        let back = document_to_json(doc);
        assert_eq!(back["_id"], serde_json::json!({ "$oid": "507f1f77bcf86cd799439011" }));
        assert_eq!(back["name"], serde_json::json!("Ada"));
        assert_eq!(back["createdAt"], serde_json::json!({ "$date": "2020-06-01T00:42:40.292Z" }));
    }

    // ─── Live integration tests ─────────────────────────────────────────────
    // Require a real MongoDB server from the repo's `docker-compose.yml`
    // (`docker compose up -d mongo`) seeded per `scripts/test-mongo-docker.sh`.
    // Excluded from the default `cargo test` run — no live-server dependency
    // belongs in the normal suite — run via
    // `cargo test -- --ignored --test-threads=1` (the script does this for
    // you), matching the `commands::redis` live-test convention.

    #[tokio::test]
    #[ignore]
    async fn live_connect_list_and_crud() {
        let cfg = base_config(); // localhost:27017, no auth

        let ping = test_connection_impl(&cfg).await.expect("ping should succeed");
        assert!(ping.success);

        let dbs = mongo_list_databases(cfg.clone()).await.unwrap();
        assert!(dbs.iter().any(|d| d.name == "rdsql_test"), "expected seeded db, got {:?}", dbs);

        let cols = mongo_list_collections(cfg.clone(), "rdsql_test".into()).await.unwrap();
        assert!(cols.iter().any(|c| c.name == "widgets"), "expected seeded collection, got {:?}", cols);

        let page = mongo_find_documents(cfg.clone(), "rdsql_test".into(), "widgets".into(), None, None, None, None, None)
            .await
            .unwrap();
        assert!(!page.documents.is_empty());

        let inserted = mongo_insert_document(
            cfg.clone(),
            "rdsql_test".into(),
            "widgets".into(),
            serde_json::json!({ "name": "scratch", "qty": 1 }),
        )
        .await
        .unwrap();

        let filter = serde_json::json!({ "_id": inserted });
        let fetched = mongo_get_document(cfg.clone(), "rdsql_test".into(), "widgets".into(), filter.clone())
            .await
            .unwrap();
        assert!(fetched.is_some());

        mongo_update_document(
            cfg.clone(),
            "rdsql_test".into(),
            "widgets".into(),
            filter.clone(),
            serde_json::json!({ "name": "scratch", "qty": 2 }),
        )
        .await
        .unwrap();

        mongo_delete_document(cfg.clone(), "rdsql_test".into(), "widgets".into(), filter)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn live_indexes_stats_schema_and_aggregation() {
        let cfg = base_config(); // localhost:27017, no auth

        // ── Indexes ──────────────────────────────────────────────────────
        let created_name = mongo_create_index(
            cfg.clone(),
            "rdsql_test".into(),
            "widgets".into(),
            serde_json::json!({ "name": 1 }),
            None,
            Some(false),
            None,
        )
        .await
        .unwrap();
        let indexes = mongo_list_indexes(cfg.clone(), "rdsql_test".into(), "widgets".into()).await.unwrap();
        assert!(indexes.iter().any(|i| i.name == created_name), "expected created index in {:?}", indexes);
        assert!(indexes.iter().any(|i| i.name == "_id_"), "every collection has an _id index");
        mongo_drop_index(cfg.clone(), "rdsql_test".into(), "widgets".into(), created_name).await.unwrap();

        // ── Stats ────────────────────────────────────────────────────────
        let coll_stats = mongo_collection_stats(cfg.clone(), "rdsql_test".into(), "widgets".into()).await.unwrap();
        assert!(coll_stats.count >= 2, "expected the seeded widgets, got {:?}", coll_stats);
        let db_stats = mongo_database_stats(cfg.clone(), "rdsql_test".into()).await.unwrap();
        assert!(db_stats.collections >= 1, "expected at least one collection, got {:?}", db_stats);

        // ── Schema inference ─────────────────────────────────────────────
        let inference =
            mongo_infer_schema(cfg.clone(), "rdsql_test".into(), "widgets".into(), Some(50)).await.unwrap();
        assert!(inference.sampled >= 2);
        let name_field = inference.fields.iter().find(|f| f.name == "name").expect("name field detected");
        assert!(name_field.types.iter().any(|t| t.bson_type == "string"));

        // ── Aggregation ──────────────────────────────────────────────────
        let agg = mongo_run_aggregation(
            cfg.clone(),
            "rdsql_test".into(),
            "widgets".into(),
            vec![
                serde_json::json!({ "$match": { "qty": { "$gte": 0 } } }),
                serde_json::json!({ "$group": { "_id": null, "total": { "$sum": "$qty" } } }),
            ],
        )
        .await
        .unwrap();
        assert_eq!(agg.documents.len(), 1, "single group, got {:?}", agg.documents);

        // ── Collection/database admin (create + drop a throwaway collection) ──
        mongo_create_collection(cfg.clone(), "rdsql_test".into(), "scratch_collection".into()).await.unwrap();
        let cols = mongo_list_collections(cfg.clone(), "rdsql_test".into()).await.unwrap();
        assert!(cols.iter().any(|c| c.name == "scratch_collection"));
        mongo_drop_collection(cfg.clone(), "rdsql_test".into(), "scratch_collection".into()).await.unwrap();
    }
}
