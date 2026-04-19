mod commands;
mod cv;
mod db;
mod demo;
mod frameworks;
mod identity;
mod profiles;
mod templates;

use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

pub(crate) struct AppState {
    pub conn: Mutex<Option<Connection>>,
    pub vault_path: Mutex<Option<PathBuf>>,
}

pub(crate) fn config_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("skipi");
    let _ = fs::create_dir_all(&dir);
    dir.join("config.json")
}

pub(crate) fn save_last_vault(path: &str) {
    let cfg = config_path();
    let data = serde_json::json!({ "last_vault": path });
    let _ = fs::write(cfg, data.to_string());
}

pub(crate) fn load_last_vault() -> Option<String> {
    let cfg = config_path();
    let text = fs::read_to_string(cfg).ok()?;
    let val: serde_json::Value = serde_json::from_str(&text).ok()?;
    val["last_vault"].as_str().map(|s| s.to_string())
}

/// Wipe all user-facing content from an opened vault DB, preserving the
/// schema_migrations table.
pub(crate) fn reset_vault_content(conn: &Connection) {
    let tables = [
        "documents",
        "vault_info",
        "packages",
        "package_files",
        "ai_corrections",
        "work_history",
        "work_history_files",
        "dispatches",
    ];
    for t in &tables {
        let _ = conn.execute(&format!("DELETE FROM {}", t), []);
    }
}

pub(crate) fn base64_encode(data: &[u8]) -> String {
    data_encoding::BASE64.encode(data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use commands::{vault, documents, ai, packages, profile, cv_commands, work_history, email};

    tauri::Builder::default()
        .manage(AppState {
            conn: Mutex::new(None),
            vault_path: Mutex::new(None),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Vault lifecycle
            vault::get_vault_types,
            vault::get_last_vault,
            vault::get_app_version,
            vault::get_platform,
            vault::get_linux_install_type,
            vault::open_external_url,
            vault::install_deb_update,
            vault::set_window_title,
            vault::create_vault,
            vault::open_vault,
            vault::close_vault,
            vault::get_current_vault_path,
            vault::get_vault_path,
            // Documents
            documents::get_documents,
            documents::update_expiry,
            documents::update_doc_field,
            documents::attach_file,
            documents::read_file_base64,
            documents::add_custom_doc,
            documents::delete_doc,
            // AI recognition
            ai::ai_recognize,
            ai::save_api_key,
            ai::get_api_key,
            ai::save_ai_correction,
            ai::get_ai_corrections,
            ai::category_has_template,
            ai::update_field_statuses,
            // Packages & dispatch
            packages::create_package,
            packages::get_packages,
            packages::export_package,
            packages::dispatch_package,
            packages::get_dispatches,
            packages::delete_package,
            packages::open_file_in_default,
            packages::open_email_with_attachment,
            packages::prepare_dispatch_attachments,
            packages::record_dispatch_history,
            packages::get_dispatch_dir,
            // Profile
            profile::get_profile_taxonomy,
            profile::get_optional_categories,
            profile::get_required_docs,
            profile::create_profile_vault,
            profile::get_profile_status,
            profile::get_seafarer_frameworks,
            profile::get_vessel_frameworks,
            profile::get_vessel_required_docs,
            profile::get_vessel_taxonomy,
            profile::create_vessel_profile_vault,
            profile::create_demo_vault,
            profile::create_demo_vault_auto,
            profile::get_matchable_profile,
            profile::get_seafarer_personal,
            profile::set_seafarer_personal,
            profile::upload_profile_photo,
            profile::clear_profile_photo,
            profile::get_profile_photo_abs_path,
            profile::get_profile_photo_data_url,
            // CV
            cv_commands::get_cv_data,
            cv_commands::export_cv_docx,
            cv_commands::export_cv_pdf,
            cv_commands::export_redacted_cv_pdf,
            // Work history
            work_history::add_work_history,
            work_history::get_work_history,
            work_history::delete_work_entry,
            work_history::attach_work_file,
            work_history::get_work_files,
            work_history::delete_work_file,
            work_history::open_work_file,
            work_history::set_work_evidence_folder,
            work_history::open_work_evidence_folder,
            work_history::auto_create_work_evidence_folder,
            // SMTP outgoing mail
            email::suggest_smtp_from_email,
            email::get_smtp_config,
            email::save_smtp_config,
            email::clear_smtp_config,
            email::test_smtp_connection,
            email::send_email_smtp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
