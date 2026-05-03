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
        is_national: false,
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

/// Slice F2-lite — add a template-backed (catalog) document row to the vault.
/// Unlike `add_custom_doc`, this writes a `template_id` so the row contributes
/// to compliance assessment server-side. Caller passes catalog metadata
/// resolved from `serverCatalog.certs`.
#[tauri::command]
pub fn add_catalog_doc(
    state: State<AppState>,
    template_id: String,
    title: String,
    category: Option<String>,
    has_expiry: Option<bool>,
    regulatory_basis: Option<String>,
) -> Result<DocRecord, String> {
    let template_id = template_id.trim().to_string();
    if template_id.is_empty() {
        return Err("template_id is required".to_string());
    }
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Title is required".to_string());
    }
    let category = category
        .and_then(|c| {
            let t = c.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        })
        .unwrap_or_else(|| "Catalog".to_string());
    let has_expiry = has_expiry.unwrap_or(false);

    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let cat_dir = vault_path.join(&category);
    fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let id = format!("cat_{}", uuid::Uuid::new_v4().simple());
    let regulatory = regulatory_basis
        .and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        })
        .unwrap_or_else(|| "Catalog".to_string());
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
        notes: None,
        field_statuses: None,
        regulatory_basis: Some(regulatory),
        template_id: Some(template_id.clone()),
        sha256: None,
        file_size: None,
        content_type: None,
        visibility: "private".to_string(),
        is_national: false,
    };
    db::insert_doc(conn, &rec).map_err(|e| e.to_string())?;
    let payload = serde_json::json!({
        "category": category,
        "kind": "catalog",
        "template_id": template_id,
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

/// Resolve a vault document to its absolute path on disk so the chat
/// attachment uploader can read+encrypt it. Returns Err if the doc has
/// no file attached or no vault is open.
#[tauri::command]
pub fn get_document_file_path(state: State<AppState>, doc_id: String) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let doc = docs.iter().find(|d| d.id == doc_id).ok_or("Document not found")?;
    let file_name = doc.file_name.as_ref().ok_or("No file attached")?;
    let p = vault_path.join(&doc.category).join(file_name);
    Ok(p.to_string_lossy().to_string())
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

/// Bundle every vault document with an attached file into a single ZIP +
/// `manifest.json` describing the doc tree. Used by the chat "send all
/// documents" path so the crewing receives one structured container they
/// can open in the same hierarchical viewer the seafarer uses.
///
/// ZIP layout:
///   manifest.json
///   <category>/<filename>          one entry per doc with a file
#[tauri::command]
pub fn export_documents_bundle(
    state: State<AppState>,
    output_path: String,
) -> Result<String, String> {
    use std::io::Write;
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;

    let out = std::path::PathBuf::from(&output_path);
    if let Some(parent) = out.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let file = fs::File::create(&out).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut manifest_docs: Vec<serde_json::Value> = Vec::new();
    for doc in &docs {
        let fname = match &doc.file_name {
            Some(f) => f.clone(),
            None => {
                // Still record the doc so the crewing sees the empty slot —
                // useful for "missing documents" awareness.
                manifest_docs.push(serde_json::json!({
                    "id": doc.id,
                    "title": doc.title,
                    "category": doc.category,
                    "template_id": doc.template_id,
                    "is_template": doc.template_id.is_some(),
                    "doc_number": doc.doc_number,
                    "issued_by": doc.issued_by,
                    "valid_from": doc.valid_from,
                    "valid_to": doc.valid_to,
                    "file_path": serde_json::Value::Null,
                    "file_name": serde_json::Value::Null,
                }));
                continue;
            }
        };
        let src = vault_path.join(&doc.category).join(&fname);
        if !src.exists() { continue; }
        let data = fs::read(&src).map_err(|e| format!("read {}: {}", src.display(), e))?;
        let in_zip = format!("{}/{}", doc.category, fname);
        zip.start_file(&in_zip, options).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
        manifest_docs.push(serde_json::json!({
            "id": doc.id,
            "title": doc.title,
            "category": doc.category,
            "template_id": doc.template_id,
            "is_template": doc.template_id.is_some(),
            "doc_number": doc.doc_number,
            "issued_by": doc.issued_by,
            "valid_from": doc.valid_from,
            "valid_to": doc.valid_to,
            "file_name": fname,
            "file_path": in_zip,
        }));
    }

    // Optional seafarer metadata so the crewing card has labels.
    let info = db::get_vault_info(conn).map_err(|e| e.to_string())?;
    let manifest = serde_json::json!({
        "schema_version": 1,
        "exported_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "exported_by": {
            "name": info.name,
            "rank": info.rank,
            "vessel_type": info.vessel_type,
            "position": info.position,
            "vessel_category": info.vessel_category,
        },
        "documents": manifest_docs,
    });
    let manifest_str = serde_json::to_string_pretty(&manifest)
        .map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
    zip.write_all(manifest_str.as_bytes()).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}
