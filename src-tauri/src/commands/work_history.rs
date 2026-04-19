use crate::db;
use crate::AppState;
use std::fs;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn add_work_history(
    state: State<AppState>,
    vessel_name: String,
    vessel_type: Option<String>,
    imo: Option<String>,
    flag: Option<String>,
    company: Option<String>,
    position: String,
    sign_on: Option<String>,
    sign_off: Option<String>,
    notes: Option<String>,
) -> Result<String, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let id = uuid::Uuid::new_v4().to_string();
    db::add_work_entry(conn, &id, &vessel_name, vessel_type.as_deref(), imo.as_deref(), flag.as_deref(), company.as_deref(), &position, sign_on.as_deref(), sign_off.as_deref(), notes.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn get_work_history(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::get_work_history(conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_work_entry(state: State<AppState>, id: String) -> Result<(), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let entry_dir = vault_path.join("_work_history").join(&id);
    if entry_dir.exists() {
        let _ = fs::remove_dir_all(&entry_dir);
    }
    db::delete_work_entry(conn, &id).map_err(|e| e.to_string())
}

/// Attach a supporting document to a work-history entry.
#[tauri::command]
pub fn attach_work_file(
    state: State<AppState>,
    entry_id: String,
    source_path: String,
    kind: Option<String>,
) -> Result<serde_json::Value, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err("Source file does not exist".to_string());
    }
    let file_name = src.file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid source file name")?
        .to_string();
    let safe_name: String = file_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect();

    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    // Verify entry exists
    {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM work_history WHERE id = ?1",
            rusqlite::params![entry_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err("Work history entry not found".to_string());
        }
    }

    let entry_dir = vault_path.join("_work_history").join(&entry_id);
    fs::create_dir_all(&entry_dir).map_err(|e| e.to_string())?;

    let mut final_name = safe_name.clone();
    let mut counter = 1;
    while entry_dir.join(&final_name).exists() {
        let (stem, ext) = match safe_name.rfind('.') {
            Some(i) => (&safe_name[..i], &safe_name[i..]),
            None => (safe_name.as_str(), ""),
        };
        final_name = format!("{}_{}{}", stem, counter, ext);
        counter += 1;
        if counter > 1000 { return Err("Too many files with the same name".to_string()); }
    }
    let dest = entry_dir.join(&final_name);
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;

    let file_id = uuid::Uuid::new_v4().to_string();
    {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        db::add_work_file(conn, &file_id, &entry_id, &final_name, kind.as_deref())
            .map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "id": file_id,
        "file_name": final_name,
        "kind": kind,
    }))
}

#[tauri::command]
pub fn get_work_files(state: State<AppState>, entry_id: String) -> Result<Vec<serde_json::Value>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::get_work_files(conn, &entry_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_work_file(state: State<AppState>, id: String) -> Result<(), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    if let Some((entry_id, file_name)) = db::get_work_file(conn, &id).map_err(|e| e.to_string())? {
        let fp = vault_path.join("_work_history").join(&entry_id).join(&file_name);
        let _ = fs::remove_file(&fp);
    }
    db::delete_work_file(conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_work_file(state: State<AppState>, id: String) -> Result<(), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let (entry_id, file_name) = db::get_work_file(conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or("File not found")?;
    let fp = vault_path.join("_work_history").join(&entry_id).join(&file_name);
    if !fp.exists() {
        return Err("File missing on disk".to_string());
    }
    let fp_str = fp.to_string_lossy().to_string();
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&fp_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&fp_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/C", "start", "", &fp_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
