use crate::db::{self, DocRecord};
use crate::AppState;
use std::fs;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn get_documents(state: State<AppState>) -> Result<Vec<DocRecord>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::get_all_docs(conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_expiry(state: State<AppState>, id: String, valid_to: String) -> Result<(), String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::update_doc_expiry(conn, &id, &valid_to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_doc_field(state: State<AppState>, id: String, field: String, value: String) -> Result<(), String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::update_doc_field(conn, &id, &field, &value).map_err(|e| e.to_string())
}

/// Add a user-defined (custom) certificate row to the vault.
#[tauri::command]
pub fn add_custom_doc(
    state: State<AppState>,
    title: String,
    category: Option<String>,
    has_expiry: Option<bool>,
) -> Result<DocRecord, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Title is required".to_string());
    }
    let category = category
        .and_then(|c| {
            let t = c.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        })
        .unwrap_or_else(|| "Custom".to_string());
    let has_expiry = has_expiry.unwrap_or(false);

    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let cat_dir = vault_path.join(&category);
    fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let id = format!("custom_{}", uuid::Uuid::new_v4().simple());
    let rec = DocRecord {
        id: id.clone(),
        category: category.clone(),
        title: title.clone(),
        file_name: None,
        has_expiry,
        valid_from: None,
        valid_to: None,
        issued_by: None,
        doc_number: None,
        notes: Some("User-added custom certificate".to_string()),
        field_statuses: None,
        regulatory_basis: Some("Custom".to_string()),
        template_id: None,
        sha256: None,
        file_size: None,
        content_type: None,
        visibility: "private".to_string(),
    };
    db::insert_doc(conn, &rec).map_err(|e| e.to_string())?;
    let payload = serde_json::json!({
        "category": category,
        "kind": "custom",
        "has_expiry": has_expiry,
    })
    .to_string();
    let _ = db::log_event(conn, "doc_added", "document", Some(&id), Some(&payload));
    Ok(rec)
}

/// Delete a document row from the vault. Also removes any attached file on disk.
#[tauri::command]
pub fn delete_doc(state: State<AppState>, id: String) -> Result<(), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let doc = db::get_all_docs(conn).map_err(|e| e.to_string())?
        .into_iter().find(|d| d.id == id);
    if let Some(d) = doc {
        if let Some(fname) = d.file_name {
            let fp = vault_path.join(&d.category).join(&fname);
            let _ = fs::remove_file(&fp);
        }
    }
    conn.execute("DELETE FROM documents WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    let _ = db::log_event(conn, "doc_deleted", "document", Some(&id), None);
    Ok(())
}

#[tauri::command]
pub fn read_file_base64(state: State<AppState>, doc_id: String) -> Result<(String, String), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let doc = docs.iter().find(|d| d.id == doc_id).ok_or("Document not found")?;
    let file_name = doc.file_name.as_ref().ok_or("No file attached")?;

    let file_path = vault_path.join(&doc.category).join(file_name);
    let data = fs::read(&file_path).map_err(|e| format!("Cannot read file: {}", e))?;

    let b64 = crate::base64_encode(&data);

    let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "pdf" => "application/pdf",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };

    Ok((b64, mime.to_string()))
}

#[tauri::command]
pub fn attach_file(state: State<AppState>, doc_id: String, source_path: String) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let doc = docs.iter().find(|d| d.id == doc_id).ok_or("Document not found")?;

    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }
    let ext = src.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let safe_title: String = doc.title.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
    let dest_name = if ext.is_empty() { safe_title.clone() } else { format!("{}.{}", safe_title, ext) };

    let cat_dir = vault_path.join(&doc.category);
    fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;

    let dest = cat_dir.join(&dest_name);
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;

    db::update_doc_file(conn, &doc_id, &dest_name).map_err(|e| e.to_string())?;

    // Phase-2 readiness (I-4): content hash
    if let Ok(bytes) = fs::read(&dest) {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = hex::encode(hasher.finalize());
        let size = bytes.len() as i64;
        let content_type = match ext.to_lowercase().as_str() {
            "pdf" => "application/pdf",
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "doc" => "application/msword",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "txt" => "text/plain",
            _ => "application/octet-stream",
        };
        let _ = db::update_doc_content_hash(conn, &doc_id, &hash, size, content_type);
        let payload = serde_json::json!({
            "sha256": hash,
            "file_size": size,
            "content_type": content_type,
        })
        .to_string();
        let _ = db::log_event(conn, "file_attached", "document", Some(&doc_id), Some(&payload));
    }

    Ok(dest_name)
}
