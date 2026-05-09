use crate::db;
use crate::AppState;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

const SEA_SERVICE_DOCS_DIR: &str = "Sea Service";
const LEGACY_WORK_HISTORY_DIR: &str = "_work_history";

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
    dwt: Option<String>,
    teu: Option<String>,
    notes: Option<String>,
) -> Result<String, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let id = uuid::Uuid::new_v4().to_string();
    db::add_work_entry(
        conn,
        &id,
        &vessel_name,
        vessel_type.as_deref(),
        imo.as_deref(),
        flag.as_deref(),
        company.as_deref(),
        &position,
        sign_on.as_deref(),
        sign_off.as_deref(),
        dwt.as_deref(),
        teu.as_deref(),
        notes.as_deref(),
    )
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

    if let Ok(entry_dir) = work_entry_storage_dir(vault_path, conn, &id) {
        if entry_dir.exists() {
            let _ = fs::remove_dir_all(&entry_dir);
        }
    }
    let entry_dir = vault_path.join(LEGACY_WORK_HISTORY_DIR).join(&id);
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
    let file_name = src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid source file name")?
        .to_string();
    let safe_name: String = file_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();

    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let entry_dir = {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM work_history WHERE id = ?1",
                rusqlite::params![entry_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err("Work history entry not found".to_string());
        }
        work_entry_storage_dir(vault_path, conn, &entry_id)?
    };
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
        if counter > 1000 {
            return Err("Too many files with the same name".to_string());
        }
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
pub fn get_work_files(
    state: State<AppState>,
    entry_id: String,
) -> Result<Vec<serde_json::Value>, String> {
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
        for fp in work_file_candidates(vault_path, conn, &entry_id, &file_name) {
            let _ = fs::remove_file(&fp);
        }
    }
    db::delete_work_file(conn, &id).map_err(|e| e.to_string())
}

/// Link a folder on the user's device as the evidence location for a
/// work-history entry. Pass `None` (or an empty string) to unlink. Skipi
/// only stores the path — files inside the folder live outside the vault
/// and are never copied in.
#[tauri::command]
pub fn set_work_evidence_folder(
    state: State<AppState>,
    entry_id: String,
    folder_path: Option<String>,
) -> Result<(), String> {
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    let trimmed = folder_path
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    if let Some(p) = trimmed {
        let path = PathBuf::from(p);
        if !path.exists() {
            return Err(format!("Folder does not exist: {}", p));
        }
        if !path.is_dir() {
            return Err(format!("Not a folder: {}", p));
        }
    }
    db::set_work_evidence_folder(conn, &entry_id, trimmed).map_err(|e| e.to_string())
}

/// Sanitise a string for use as a folder name: collapse anything outside the
/// alnum/dash/underscore set into `_`, strip leading/trailing dots, and cap
/// length at 60 chars so the final path stays comfortably short on Windows.
fn sanitise_folder_segment(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Collapse runs of underscores so `M/V Spring Breeze` does not become
    // `M_V_Spring_Breeze_` with ugly doubles from the leading slash/space.
    while out.contains("__") {
        out = out.replace("__", "_");
    }
    let trimmed = out.trim_matches(|c| c == '_' || c == '.').to_string();
    let final_len = trimmed.chars().count().min(60);
    trimmed.chars().take(final_len).collect()
}

fn work_entry_folder_name(conn: &rusqlite::Connection, entry_id: &str) -> Result<String, String> {
    let (vessel_name, imo, sign_on, created_at) = conn
        .query_row(
            "SELECT vessel_name, imo, sign_on, created_at FROM work_history WHERE id = ?1",
            rusqlite::params![entry_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|_| "Work history entry not found".to_string())?;

    let ident = match imo.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(i) => format!("IMO{}", sanitise_folder_segment(i)),
        None => sanitise_folder_segment(&vessel_name),
    };
    if ident.is_empty() {
        return Err("Cannot build folder name — vessel is missing both IMO and name".to_string());
    }

    let date_src = sign_on
        .as_deref()
        .filter(|s| s.len() >= 7)
        .unwrap_or(&created_at);
    let yyyymm: String = date_src.chars().take(7).filter(|c| *c != '-').collect();
    let short_id: String = entry_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    Ok(format!(
        "{}_{}_{}",
        ident,
        if yyyymm.is_empty() { "unknown" } else { &yyyymm },
        if short_id.is_empty() { "entry" } else { &short_id }
    ))
}

pub(crate) fn work_entry_storage_dir(
    vault_path: &Path,
    conn: &rusqlite::Connection,
    entry_id: &str,
) -> Result<PathBuf, String> {
    Ok(vault_path
        .join(SEA_SERVICE_DOCS_DIR)
        .join(work_entry_folder_name(conn, entry_id)?))
}

pub(crate) fn work_file_candidates(
    vault_path: &Path,
    conn: &rusqlite::Connection,
    entry_id: &str,
    file_name: &str,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = work_entry_storage_dir(vault_path, conn, entry_id) {
        out.push(dir.join(file_name));
    }
    out.push(
        vault_path
            .join(LEGACY_WORK_HISTORY_DIR)
            .join(entry_id)
            .join(file_name),
    );
    out
}

pub(crate) fn resolve_work_file_path(
    vault_path: &Path,
    conn: &rusqlite::Connection,
    entry_id: &str,
    file_name: &str,
) -> PathBuf {
    let candidates = work_file_candidates(vault_path, conn, entry_id, file_name);
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

/// Create the default evidence folder for a work-history entry under
/// `~/Skipi/Contracts/<vessel_or_imo>_<YYYYMM>/` and link it to the entry.
/// Idempotent: if the folder already exists it is reused. Returns the
/// absolute path that was linked so the UI can show it.
#[tauri::command]
pub fn auto_create_work_evidence_folder(
    state: State<AppState>,
    entry_id: String,
) -> Result<String, String> {
    // Pull the fields we need to build the path in one DB scope, then drop
    // the lock before touching the filesystem.
    let (vessel_name, imo, sign_on, created_at) = {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        conn.query_row(
            "SELECT vessel_name, imo, sign_on, created_at FROM work_history WHERE id = ?1",
            rusqlite::params![entry_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|_| "Work history entry not found".to_string())?
    };

    // Prefer IMO as the stable identifier (vessel names legitimately change
    // on the same hull). Fall back to a sanitised vessel name.
    let ident = match imo.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(i) => format!("IMO{}", sanitise_folder_segment(i)),
        None => sanitise_folder_segment(&vessel_name),
    };
    if ident.is_empty() {
        return Err("Cannot build folder name — vessel is missing both IMO and name".to_string());
    }

    // Date bucket: sign_on when present, otherwise the entry's created_at.
    // Both are stored as `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM:SS` — we just want
    // the first 7 chars and to strip the dash for a compact `YYYYMM`.
    let date_src = sign_on
        .as_deref()
        .filter(|s| s.len() >= 7)
        .unwrap_or(&created_at);
    let yyyymm: String = date_src.chars().take(7).filter(|c| *c != '-').collect();

    let folder_name = format!("{}_{}", ident, yyyymm);
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let path = home.join("Skipi").join("Contracts").join(&folder_name);

    fs::create_dir_all(&path).map_err(|e| format!("Failed to create folder: {}", e))?;

    let path_str = path.to_string_lossy().to_string();
    {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        db::set_work_evidence_folder(conn, &entry_id, Some(&path_str))
            .map_err(|e| e.to_string())?;
    }

    Ok(path_str)
}

/// Open the linked evidence folder in the OS file manager. Errors out with
/// a clear message if nothing is linked or the folder has been moved/deleted
/// so the UI can offer a graceful re-link.
#[tauri::command]
pub fn open_work_evidence_folder(state: State<AppState>, entry_id: String) -> Result<(), String> {
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    let folder = db::get_work_evidence_folder(conn, &entry_id)
        .map_err(|e| e.to_string())?
        .ok_or("No evidence folder linked for this entry")?;
    let path = PathBuf::from(&folder);
    if !path.exists() {
        return Err(format!("Folder no longer exists: {}", folder));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a folder: {}", folder));
    }
    let folder_str = folder.as_str();
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(folder_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(folder_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // `explorer <folder>` is the native way to open a folder; no console
        // appears (explorer is GUI), so no CREATE_NO_WINDOW needed here.
        std::process::Command::new("explorer")
            .arg(folder_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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
    let fp = resolve_work_file_path(vault_path, conn, &entry_id, &file_name);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::fs;

    #[test]
    fn work_entry_storage_uses_sea_service_vault_folder() {
        let vault_path = std::env::temp_dir().join(format!(
            "skipi-sea-service-folder-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();
        db::add_work_entry(
            &conn,
            "entry-abcdef12-3456",
            "MV Folder Test",
            Some("Bulk Carrier"),
            Some("9855551"),
            Some("Portugal"),
            Some("Test Manager"),
            "Master",
            Some("2025-06-09"),
            Some("2025-12-23"),
            Some("80000"),
            None,
            None,
        )
        .unwrap();

        let dir = work_entry_storage_dir(&vault_path, &conn, "entry-abcdef12-3456").unwrap();
        assert!(dir.starts_with(vault_path.join("Sea Service")));
        let name = dir.file_name().unwrap().to_string_lossy();
        assert!(name.contains("IMO9855551"));
        assert!(name.contains("202506"));
        assert!(name.ends_with("entryabc"));

        drop(conn);
        let _ = fs::remove_dir_all(&vault_path);
    }
}
