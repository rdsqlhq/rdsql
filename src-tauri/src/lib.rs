pub mod commands;

use commands::query::QueryRegistry;
use commands::s3::TransferRegistry;
use commands::backend::PendingLogin;
use commands::migrate::MigrationRegistry;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem};
use tauri::{Emitter, Manager};
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::RunEvent;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(Arc::new(Mutex::new(HashMap::new())) as QueryRegistry)
        // Transfer registry for cancellable S3 uploads/downloads. Same shape as
        // the query registry; lives independently so the two never collide.
        .manage(TransferRegistry(Arc::new(Mutex::new(HashMap::new()))))
        // Cancellable MySQL → PostgreSQL migrations. Same shape as the two
        // registries above; independent so it never collides with them.
        .manage(MigrationRegistry(Arc::new(Mutex::new(HashMap::new()))))
        // Holds the CSRF-style `state` nonce between backend_open_login and the
        // rdsql://auth/callback deep link — see commands::backend's module doc.
        .manage(PendingLogin(Arc::new(Mutex::new(None))))
        .setup(|app| {
            // Browser-based login/pairing callback: the website redirects to
            // rdsql://auth/callback?access=...&refresh=...&state=... after the
            // user signs in. Validate `state` against what backend_open_login
            // stashed, persist tokens via the keyring, then let the frontend
            // know via an event (useAuthStore listens for this).
            {
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let app_handle = app_handle.clone();
                    let urls = event.urls();
                    tauri::async_runtime::spawn(async move {
                        for url in urls {
                            if url.scheme() != "rdsql" || url.host_str() != Some("auth") {
                                continue;
                            }
                            let pairs: std::collections::HashMap<String, String> =
                                url.query_pairs().map(|(k, v)| (k.to_string(), v.to_string())).collect();
                            let (Some(access), Some(refresh)) = (pairs.get("access"), pairs.get("refresh")) else {
                                continue;
                            };

                            let pending = app_handle.state::<PendingLogin>();
                            let expected_state = pending.0.lock().await.take();
                            let state_ok = match (&expected_state, pairs.get("state")) {
                                (Some(expected), Some(got)) => expected == got,
                                // Pairing-code sign-ins don't go through backend_open_login,
                                // so there's no pending state to check for those callers.
                                (None, _) => true,
                                _ => false,
                            };
                            if !state_ok {
                                let _ = app_handle.emit("auth-callback", serde_json::json!({ "status": "error", "message": "state mismatch" }));
                                continue;
                            }

                            if let Err(e) = commands::storage::set_credential(commands::backend::ACCESS_TOKEN_KEY, access) {
                                let _ = app_handle.emit("auth-callback", serde_json::json!({ "status": "error", "message": e }));
                                continue;
                            }
                            if let Err(e) = commands::storage::set_credential(commands::backend::REFRESH_TOKEN_KEY, refresh) {
                                let _ = app_handle.emit("auth-callback", serde_json::json!({ "status": "error", "message": e }));
                                continue;
                            }
                            let _ = app_handle.emit("auth-callback", serde_json::json!({ "status": "success" }));
                        }
                    });
                });
            }

            // Registered here rather than in the builder chain: the updater is
            // desktop-only, and `app.handle()` is what the plugin needs.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Build Export Submenu
            let export_encrypted = MenuItemBuilder::with_id("export_encrypted", "Encrypted Connections (.rdsql)...")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?;

            let export_csv = MenuItemBuilder::with_id("export_csv", "Table Data (CSV)...")
                .build(app)?;

            let export_json = MenuItemBuilder::with_id("export_json", "Table Data (JSON)...")
                .build(app)?;

            let export_sql = MenuItemBuilder::with_id("export_sql", "Table Dump (SQL)...")
                .build(app)?;

            let export_menu = SubmenuBuilder::new(app, "Export")
                .item(&export_encrypted)
                .separator()
                .item(&export_csv)
                .item(&export_json)
                .item(&export_sql)
                .build()?;

            // Build Import Submenu
            let import_encrypted = MenuItemBuilder::with_id("import_encrypted", "Encrypted Connections (.rdsql)...")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(app)?;

            let import_menu = SubmenuBuilder::new(app, "Import")
                .item(&import_encrypted)
                .build()?;

            // Build File Submenu
            let new_conn = MenuItemBuilder::with_id("new_connection", "New Connection...")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;

            let open_sql = MenuItemBuilder::with_id("open_sql", "New SQL Query Tab")
                .accelerator("CmdOrCtrl+T")
                .build(app)?;

            let open_sql_file = MenuItemBuilder::with_id("open_sql_file", "Open SQL File...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_conn)
                .item(&open_sql)
                .item(&open_sql_file)
                .separator()
                .item(&export_menu)
                .item(&import_menu)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;

            // Build Edit Submenu
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            // Build View Submenu
            let toggle_explorer = MenuItemBuilder::with_id("toggle_explorer", "Toggle Explorer Sidebar")
                .accelerator("CmdOrCtrl+B")
                .build(app)?;

            let toggle_ai = MenuItemBuilder::with_id("toggle_ai", "Toggle AI Assistant")
                .accelerator("CmdOrCtrl+L")
                .build(app)?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&toggle_explorer)
                .item(&toggle_ai)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;

            // Build Window Submenu
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .build()?;

            // Build Tools Submenu
            let compare_schemas = MenuItemBuilder::with_id("compare_schemas", "Compare Schemas...")
                .accelerator("CmdOrCtrl+Shift+D")
                .build(app)?;

            let compare_data = MenuItemBuilder::with_id("compare_data", "Compare Data...")
                .build(app)?;

            let sync_schema = MenuItemBuilder::with_id("sync_schema", "Sync Schema...")
                .build(app)?;

            let migrate_to_postgres = MenuItemBuilder::with_id("migrate_to_postgres", "Migrate Database...")
                .build(app)?;

            let tools_menu = SubmenuBuilder::new(app, "Tools")
                .item(&compare_schemas)
                .item(&compare_data)
                .separator()
                .item(&sync_schema)
                .separator()
                .item(&migrate_to_postgres)
                .build()?;

            // Build Help Submenu
            let about_item = MenuItemBuilder::with_id("about", "About rdSQL Desktop")
                .build(app)?;

            let check_updates = MenuItemBuilder::with_id("check_updates", "Check for Updates...")
                .build(app)?;

            let report_bug = MenuItemBuilder::with_id("report_bug", "Report Bug...")
                .build(app)?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&about_item)
                .separator()
                .item(&check_updates)
                .separator()
                .item(&report_bug)
                .build()?;

            // Build App Menu (macOS app menu)
            #[cfg(target_os = "macos")]
            let app_menu = SubmenuBuilder::new(app, "rdSQL Desktop")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let menu_builder = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            let menu = menu_builder
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&tools_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()?;

            #[cfg(not(target_os = "macos"))]
            let menu = menu_builder
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&tools_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "export_encrypted" => {
                    let _ = app.emit("menu_action", "export_encrypted");
                }
                "import_encrypted" => {
                    let _ = app.emit("menu_action", "import_encrypted");
                }
                "new_connection" => {
                    let _ = app.emit("menu_action", "new_connection");
                }
                "open_sql" => {
                    let _ = app.emit("menu_action", "open_sql");
                }
                "open_sql_file" => {
                    let _ = app.emit("menu_action", "open_sql_file");
                }
                "export_csv" => {
                    let _ = app.emit("menu_action", "export_csv");
                }
                "export_json" => {
                    let _ = app.emit("menu_action", "export_json");
                }
                "export_sql" => {
                    let _ = app.emit("menu_action", "export_sql");
                }
                "toggle_explorer" => {
                    let _ = app.emit("menu_action", "toggle_explorer");
                }
                "toggle_ai" => {
                    let _ = app.emit("menu_action", "toggle_ai");
                }
                "compare_schemas" => {
                    let _ = app.emit("menu_action", "compare_schemas");
                }
                "compare_data" => {
                    let _ = app.emit("menu_action", "compare_data");
                }
                "sync_schema" => {
                    let _ = app.emit("menu_action", "sync_schema");
                }
                "migrate_to_postgres" => {
                    let _ = app.emit("menu_action", "migrate_to_postgres");
                }
                "check_updates" => {
                    let _ = app.emit("menu_action", "check_updates");
                }
                "about" => {
                    let _ = app.emit("menu_action", "about");
                }
                "report_bug" => {
                    // Opened directly here (not routed through the frontend via
                    // `menu_action`) — same pattern as `backend_open_login` in
                    // commands/backend.rs — since this is a pure "open this URL"
                    // action with no in-app state to touch.
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app
                        .opener()
                        .open_url("https://github.com/rdsqlhq/rdsql/issues/new?template=bug_report.yml", None::<&str>);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::test_connection,
            commands::connection::fetch_schema_tree,
            commands::ssh_tunnel::test_ssh_connection,
            commands::query::execute_query,
            commands::query::cancel_query,
            commands::transfer::export_table_data,
            commands::storage::save_secure_credential,
            commands::storage::get_secure_credential,
            commands::storage::delete_secure_credential,
            commands::ai::generate_ai_sql,
            commands::health::diagnostics::run_diagnostics,
            commands::health::repair::preview_repair,
            commands::health::repair::execute_repair,
            commands::health::metrics::get_database_overview,
            commands::health::metrics::get_database_statistics,
            commands::health::metrics::get_table_statistics,
            commands::health::metrics::get_index_statistics,
            commands::health::metrics::get_activity,
            commands::health::metrics::get_table_auto_increment,
            commands::compare::compare_schema,
            commands::compare::compare_table_data,
            commands::compare::generate_schema_sync_sql,
            commands::compare::apply_schema_sync,
            commands::updater::check_for_update,
            // Cross-engine database migration wizard (isolated module; all
            // commands are additive).
            commands::migrate::db_migrate_plan_tables,
            commands::migrate::db_migrate_run,
            commands::migrate::db_migrate_cancel,
            // S3-compatible storage (isolated module; all commands are additive).
            commands::s3::s3_test_connection,
            commands::s3::s3_list_objects,
            commands::s3::s3_head_object,
            commands::s3::s3_presign_get,
            commands::s3::s3_get_object_bytes,
            commands::s3::s3_get_object_acl,
            commands::s3::s3_put_object_acl,
            commands::s3::s3_upload_object,
            commands::s3::s3_download_object,
            commands::s3::s3_delete_object,
            commands::s3::s3_delete_objects,
            commands::s3::s3_copy_object,
            commands::s3::s3_create_prefix,
            commands::s3::s3_abort_multipart,
            commands::s3::s3_cancel_transfer,
            commands::s3::s3_gzip_compress,
            commands::s3::s3_gzip_decompress,
            // Redis / Valkey key-value store (isolated module; all commands
            // are additive, and reuse connection::ConnectionConfig).
            commands::redis::redis_test_connection,
            commands::redis::redis_scan_keys,
            commands::redis::redis_keyspace_info,
            commands::redis::redis_get_key_detail,
            commands::redis::redis_set_string_value,
            commands::redis::redis_set_hash_field,
            commands::redis::redis_delete_hash_field,
            commands::redis::redis_delete_key,
            commands::redis::redis_set_ttl,
            commands::redis::redis_list_push,
            commands::redis::redis_set_add,
            commands::redis::redis_zset_add,
            // MongoDB document store (isolated module; all commands are
            // additive, and reuse connection::ConnectionConfig).
            commands::mongo::mongo_test_connection,
            commands::mongo::mongo_list_databases,
            commands::mongo::mongo_list_collections,
            commands::mongo::mongo_count_documents,
            commands::mongo::mongo_find_documents,
            commands::mongo::mongo_get_document,
            commands::mongo::mongo_insert_document,
            commands::mongo::mongo_update_document,
            commands::mongo::mongo_delete_document,
            commands::mongo::mongo_delete_documents,
            commands::mongo::mongo_list_indexes,
            commands::mongo::mongo_create_index,
            commands::mongo::mongo_drop_index,
            commands::mongo::mongo_infer_schema,
            commands::mongo::mongo_run_aggregation,
            commands::mongo::mongo_collection_stats,
            commands::mongo::mongo_database_stats,
            commands::mongo::mongo_create_collection,
            commands::mongo::mongo_drop_collection,
            commands::mongo::mongo_drop_database,
            // rdSQL Cloudflare backend: auth (browser-based), entitlement, devices,
            // pairing, sync, opt-in analytics. See commands::backend's module doc.
            commands::backend::backend_is_cloud_configured,
            commands::backend::backend_open_login,
            commands::backend::backend_is_signed_in,
            commands::backend::backend_logout,
            commands::backend::backend_get_me,
            commands::backend::backend_rename_device,
            commands::backend::backend_revoke_device,
            commands::backend::backend_create_pairing_code,
            commands::backend::backend_redeem_pairing_code,
            commands::backend::backend_sync_manifest,
            commands::backend::backend_sync_pull_resource,
            commands::backend::backend_sync_push_resource,
            commands::backend::backend_sync_delete_resource,
            commands::backend::backend_sync_pull_credentials,
            commands::backend::backend_sync_push_credentials,
            commands::backend::backend_analytics_event,
        ])
        .build(tauri::generate_context!())
        .expect("error while building rdSQL Desktop application")
        .run(|_app, _event| {
            // RunEvent::Opened only exists on macOS/iOS (it's Tauri's wrapper
            // around the OS "openURLs" application-delegate callback) — it
            // doesn't compile on Linux/Windows, where the opened-file path
            // arrives via argv instead. Gate the whole block accordingly.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let RunEvent::Opened { urls } = _event {
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    // Fan out every opened path to the frontend. Listeners decide
                    // what to do per extension (e.g. .rdsql → import, .sql → tab).
                    for path in &paths {
                        let _ = _app.emit("open-file", path);
                    }
                }
            }
        });
}
