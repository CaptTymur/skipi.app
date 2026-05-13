mod api;
mod commands;
mod cv;
mod db;
mod demo;
mod feedback;
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
    // Preserve existing recent_vaults list and prepend (most-recent-first).
    // Capped at 10 entries; duplicates removed.
    let mut recent: Vec<String> = load_recent_vaults();
    recent.retain(|p| p != path);
    recent.insert(0, path.to_string());
    recent.truncate(10);
    let data = serde_json::json!({ "last_vault": path, "recent_vaults": recent });
    let _ = fs::write(cfg, data.to_string());
}

pub(crate) fn load_last_vault() -> Option<String> {
    let cfg = config_path();
    let text = fs::read_to_string(cfg).ok()?;
    let val: serde_json::Value = serde_json::from_str(&text).ok()?;
    val["last_vault"].as_str().map(|s| s.to_string())
}

pub(crate) fn load_recent_vaults() -> Vec<String> {
    let cfg = config_path();
    let Ok(text) = fs::read_to_string(cfg) else {
        return vec![];
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    val["recent_vaults"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
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
    use commands::{
        ai, cv_commands, documents, email, jobs, mail_intent, messaging, packages, profile, review,
        vault, work_history,
    };

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
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
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
            vault::get_default_vault_parent,
            vault::get_linux_install_type,
            vault::open_external_url,
            vault::install_deb_update,
            vault::set_window_title,
            vault::create_vault,
            vault::open_vault,
            vault::close_vault,
            vault::get_current_vault_path,
            vault::get_vault_path,
            vault::get_vault_identity_key,
            vault::export_vault_backup,
            vault::import_vault_backup,
            // Documents
            documents::get_documents,
            documents::update_expiry,
            documents::update_doc_field,
            documents::attach_file,
            documents::read_file_base64,
            documents::get_document_file_path,
            documents::export_documents_bundle,
            documents::add_custom_doc,
            documents::add_catalog_doc,
            documents::delete_doc,
            // AI recognition
            ai::ai_recognize,
            ai::save_api_key,
            ai::get_api_key,
            ai::save_ai_correction,
            ai::save_ocr_label,
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
            packages::list_mail_clients,
            packages::prepare_dispatch_attachments,
            packages::record_dispatch_history,
            packages::get_dispatch_dir,
            // Profile
            profile::get_profile_taxonomy,
            profile::get_optional_categories,
            profile::get_active_template_ids,
            profile::get_conditional_template_ids,
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
            vault::get_recent_vaults,
            vault::forget_recent_vault,
            profile::get_matchable_profile,
            profile::get_jobs_readiness_status,
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
            // Public jobs board
            jobs::fetch_jobs,
            jobs::fetch_mailing_requests,
            jobs::job_apply_click,
            jobs::job_hide,
            jobs::mailing_request_send_click,
            jobs::open_mail_with_attachment,
            jobs::get_downloads_dir,
            mail_intent::create_email_file,
            feedback::init_app_diagnostics,
            feedback::app_heartbeat,
            feedback::mark_app_shutdown,
            feedback::record_app_diagnostic,
            feedback::get_feedback_prompt_state,
            feedback::postpone_app_feedback,
            feedback::submit_app_feedback,
            feedback::list_app_feedback,
            // E2E messaging
            messaging::get_api_base_override,
            messaging::get_my_identity,
            messaging::register_my_pubkey,
            messaging::send_encrypted_message,
            messaging::fetch_messages,
            messaging::apply_via_e2e,
            messaging::upload_encrypted_attachment,
            messaging::download_encrypted_attachment,
            messaging::open_path_with_default,
            // Vessel review identity (separate from crewing-facing identity)
            review::get_or_create_review_pubkey,
            review::compute_local_experience_hash,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
