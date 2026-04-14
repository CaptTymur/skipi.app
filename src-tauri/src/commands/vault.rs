use crate::db::{self, VaultInfo};
use crate::{frameworks, identity, AppState};
use std::fs;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn get_last_vault() -> Option<String> {
    crate::load_last_vault()
}

/// Returns the app version baked in at build time from Cargo.toml.
/// Used by the About tab and feedback email so we never drift between UI and binary.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Returns a short identifier for the host OS (mac/windows/linux/other).
/// Used by the feedback template so beta reports always include the platform.
#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

#[tauri::command]
pub fn get_vault_types() -> serde_json::Value {
    serde_json::json!({
        "vessel_types": frameworks::vessel_types(),
        "ranks": frameworks::seafarer_ranks(),
    })
}

#[tauri::command]
pub fn create_vault(
    state: State<AppState>,
    path: String,
    account_type: String,
    name: String,
    rank: Option<String>,
    vessel_type: Option<String>,
) -> Result<VaultInfo, String> {
    let vault_path = PathBuf::from(&path);
    fs::create_dir_all(&vault_path).map_err(|e| e.to_string())?;

    let conn = db::open_db(&vault_path).map_err(|e| e.to_string())?;
    crate::reset_vault_content(&conn);
    identity::ensure_vault_identity(&conn, &vault_path)?;

    db::set_vault_info(&conn, "account_type", &account_type).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "name", &name).map_err(|e| e.to_string())?;
    if let Some(ref r) = rank {
        db::set_vault_info(&conn, "rank", r).map_err(|e| e.to_string())?;
    }
    if let Some(ref v) = vessel_type {
        db::set_vault_info(&conn, "vessel_type", v).map_err(|e| e.to_string())?;
    }

    // Generate framework documents
    let docs = match account_type.as_str() {
        "seafarer" => frameworks::get_seafarer_framework(rank.as_deref()),
        _ => frameworks::get_vessel_framework(vessel_type.as_deref()),
    };

    // Create category folders
    let mut categories_seen = std::collections::HashSet::new();
    for doc in &docs {
        if categories_seen.insert(doc.category.clone()) {
            let cat_dir = vault_path.join(&doc.category);
            fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;
        }
        db::insert_doc(&conn, doc).map_err(|e| e.to_string())?;
        let payload = serde_json::json!({
            "category": doc.category.clone(),
            "kind": "framework",
            "template_id": doc.template_id.clone(),
            "account_type": account_type.clone(),
        })
        .to_string();
        let _ = db::log_event(&conn, "doc_added", "document", Some(&doc.id), Some(&payload));
    }

    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;

    crate::save_last_vault(&path);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);

    Ok(info)
}

#[tauri::command]
pub fn open_vault(state: State<AppState>, path: String) -> Result<VaultInfo, String> {
    let vault_path = PathBuf::from(&path);
    let db_file = vault_path.join("skipi.db");
    if !db_file.exists() {
        return Err("Not a Skipi vault (no skipi.db found)".to_string());
    }

    let conn = db::open_db(&vault_path).map_err(|e| e.to_string())?;
    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;

    crate::save_last_vault(&path);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);

    Ok(info)
}

#[tauri::command]
pub fn close_vault(state: State<AppState>, forget: Option<bool>) -> Result<(), String> {
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if forget.unwrap_or(false) {
        let cfg = crate::config_path();
        let _ = fs::write(cfg, serde_json::json!({}).to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_current_vault_path(state: State<AppState>) -> Option<String> {
    state
        .vault_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_vault_path(state: State<AppState>) -> Result<String, String> {
    let lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    lock.as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or("No vault open".to_string())
}
