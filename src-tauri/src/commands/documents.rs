use super::work_history;
use crate::db::{self, DocRecord};
use crate::AppState;
use crate::{frameworks, profiles};
use rusqlite::params;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

const HIDDEN_TEMPLATE_IDS_KEY: &str = "hidden_template_ids";

fn doc_has_user_payload(doc: &DocRecord) -> bool {
    doc.file_name.is_some()
        || doc
            .doc_number
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || doc
            .valid_from
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || doc
            .valid_to
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || doc
            .issued_by
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

fn doc_has_file_or_entered_identity(doc: &DocRecord) -> bool {
    doc.file_name.is_some()
        || doc
            .doc_number
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || doc
            .valid_from
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || doc
            .issued_by
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

fn current_active_required_template_ids(conn: &rusqlite::Connection) -> HashSet<String> {
    let g = |k: &str| db::get_vault_info_value(conn, k);
    if g("account_type").as_deref() != Some("seafarer") {
        return HashSet::new();
    }
    let Some(level_id) = g("stcw_level").filter(|v| !v.is_empty()) else {
        return HashSet::new();
    };
    let Some(level) = profiles::StcwLevel::from_id(&level_id) else {
        return HashSet::new();
    };
    let vessel_category = g("vessel_category").unwrap_or_default();
    let position = g("position").unwrap_or_default();
    profiles::required_docs_for_profile(level, &vessel_category, &position)
        .into_iter()
        .map(|t| t.id.to_string())
        .collect()
}

fn is_optional_category(category: &str) -> bool {
    profiles::optional_categories()
        .into_iter()
        .any(|c| c == category)
}

fn is_hard_required_doc(conn: &rusqlite::Connection, doc: &DocRecord) -> bool {
    let Some(template_id) = doc.template_id.as_deref() else {
        return false;
    };
    current_active_required_template_ids(conn).contains(template_id)
        && !is_optional_category(&doc.category)
}

pub(crate) fn hidden_template_ids(conn: &rusqlite::Connection) -> HashSet<String> {
    db::get_vault_info_value(conn, HIDDEN_TEMPLATE_IDS_KEY)
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect()
}

fn set_hidden_template_ids(
    conn: &rusqlite::Connection,
    ids: &HashSet<String>,
) -> Result<(), String> {
    let ordered: BTreeSet<String> = ids.iter().cloned().collect();
    let raw = serde_json::to_string(&ordered.into_iter().collect::<Vec<_>>())
        .map_err(|e| e.to_string())?;
    db::set_vault_info(conn, HIDDEN_TEMPLATE_IDS_KEY, &raw).map_err(|e| e.to_string())
}

pub(crate) fn mark_template_hidden(
    conn: &rusqlite::Connection,
    template_id: &str,
) -> Result<(), String> {
    if template_id.trim().is_empty() {
        return Ok(());
    }
    let mut ids = hidden_template_ids(conn);
    if ids.insert(template_id.to_string()) {
        set_hidden_template_ids(conn, &ids)?;
    }
    Ok(())
}

pub(crate) fn mark_template_visible(
    conn: &rusqlite::Connection,
    template_id: &str,
) -> Result<(), String> {
    let mut ids = hidden_template_ids(conn);
    if ids.remove(template_id) {
        set_hidden_template_ids(conn, &ids)?;
    }
    Ok(())
}

pub(crate) fn refresh_known_template_metadata(
    conn: &rusqlite::Connection,
) -> Result<usize, String> {
    let templates: HashMap<&'static str, profiles::DocTemplate> =
        profiles::all_seafarer_doc_templates()
            .into_iter()
            .map(|t| (t.id, t))
            .collect();
    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let mut changed = 0usize;

    for doc in docs {
        let Some(template_id) = doc.template_id.as_deref() else {
            continue;
        };
        let Some(tpl) = templates.get(template_id) else {
            continue;
        };
        if doc.title == tpl.title
            && doc.has_expiry == tpl.has_expiry
            && doc.notes.as_deref() == Some(tpl.notes)
            && doc.regulatory_basis.as_deref() == Some(tpl.regulatory_basis)
        {
            continue;
        }
        conn.execute(
            "UPDATE documents
             SET title = ?1,
                 has_expiry = ?2,
                 notes = ?3,
                 regulatory_basis = ?4
             WHERE id = ?5",
            params![
                tpl.title,
                tpl.has_expiry as i32,
                tpl.notes,
                tpl.regulatory_basis,
                doc.id
            ],
        )
        .map_err(|e| e.to_string())?;
        changed += 1;
    }

    Ok(changed)
}

pub(crate) fn prune_empty_catalog_only_docs(conn: &rusqlite::Connection) -> Result<usize, String> {
    let catalog_ids: std::collections::HashSet<&'static str> =
        profiles::catalog_only_seafarer_doc_templates()
            .into_iter()
            .map(|t| t.id)
            .collect();
    if catalog_ids.is_empty() {
        return Ok(0);
    }
    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let mut removed = 0usize;
    for doc in docs {
        let Some(template_id) = doc.template_id.as_deref() else {
            continue;
        };
        if !catalog_ids.contains(template_id) || doc.id.starts_with("custom_") {
            continue;
        }
        if doc_has_file_or_entered_identity(&doc) {
            continue;
        }
        conn.execute("DELETE FROM documents WHERE id = ?1", params![doc.id])
            .map_err(|e| e.to_string())?;
        let payload = serde_json::json!({
            "template_id": template_id,
            "reason": "empty_catalog_only_template",
        })
        .to_string();
        let _ = db::log_event(
            conn,
            "doc_deleted",
            "document",
            Some(&doc.id),
            Some(&payload),
        );
        removed += 1;
    }
    Ok(removed)
}

pub(crate) fn normalize_known_custom_docs(conn: &rusqlite::Connection) -> Result<usize, String> {
    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let existing_template_ids: std::collections::HashSet<String> =
        docs.iter().filter_map(|d| d.template_id.clone()).collect();
    let mut changed = 0usize;

    for doc in docs.iter().filter(|d| d.template_id.is_none()) {
        let Some(tpl) = profiles::doc_template_by_title_or_id(&doc.title) else {
            continue;
        };
        if existing_template_ids.contains(tpl.id) {
            if !doc_has_user_payload(doc) {
                conn.execute("DELETE FROM documents WHERE id = ?1", params![doc.id])
                    .map_err(|e| e.to_string())?;
                let _ = db::log_event(
                    conn,
                    "doc_deleted",
                    "document",
                    Some(&doc.id),
                    Some("{\"reason\":\"duplicate_known_custom\"}"),
                );
                changed += 1;
            }
            continue;
        }

        let rec = frameworks::record_from_profile_template(&tpl);
        conn.execute(
            "UPDATE documents
             SET category = ?1,
                 title = ?2,
                 has_expiry = ?3,
                 valid_to = COALESCE(NULLIF(valid_to, ''), ?4),
                 notes = ?5,
                 regulatory_basis = ?6,
                 template_id = ?7
             WHERE id = ?8",
            params![
                rec.category,
                rec.title,
                rec.has_expiry as i32,
                rec.valid_to,
                rec.notes,
                rec.regulatory_basis,
                rec.template_id,
                doc.id,
            ],
        )
        .map_err(|e| e.to_string())?;
        let payload = serde_json::json!({
            "from": "custom",
            "template_id": tpl.id,
            "regulatory_basis": tpl.regulatory_basis,
        })
        .to_string();
        let _ = db::log_event(
            conn,
            "doc_promoted_to_template",
            "document",
            Some(&doc.id),
            Some(&payload),
        );
        let _ = mark_template_visible(conn, tpl.id);
        changed += 1;
    }

    Ok(changed)
}

#[tauri::command]
pub fn get_documents(state: State<AppState>) -> Result<Vec<DocRecord>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let _ = normalize_known_custom_docs(conn);
    let _ = refresh_known_template_metadata(conn);
    let _ = prune_empty_catalog_only_docs(conn);
    db::get_all_docs(conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_expiry(state: State<AppState>, id: String, valid_to: String) -> Result<(), String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::update_doc_expiry(conn, &id, &valid_to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_doc_field(
    state: State<AppState>,
    id: String,
    field: String,
    value: String,
) -> Result<(), String> {
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
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        })
        .unwrap_or_else(|| "Custom".to_string());
    let has_expiry = has_expiry.unwrap_or(false);

    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let cat_dir = vault_path.join(&category);
    fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let known_template = profiles::doc_template_by_title_or_id(&title);
    if let Some(tpl) = known_template.as_ref() {
        if let Some(existing) = db::get_all_docs(conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|d| d.template_id.as_deref() == Some(tpl.id))
        {
            let _ = mark_template_visible(conn, tpl.id);
            return Ok(existing);
        }
    }

    let id = format!("custom_{}", uuid::Uuid::new_v4().simple());
    let rec = if let Some(tpl) = known_template {
        let mut rec = frameworks::record_from_profile_template(&tpl);
        rec.id = id.clone();
        rec
    } else {
        DocRecord {
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
        }
    };
    if let Some(template_id) = rec.template_id.as_deref() {
        let _ = mark_template_visible(conn, template_id);
    }
    db::insert_doc(conn, &rec).map_err(|e| e.to_string())?;
    let payload = serde_json::json!({
        "category": rec.category.clone(),
        "kind": if rec.template_id.is_some() { "known_template" } else { "custom" },
        "template_id": rec.template_id.clone(),
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
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
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
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
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
    let _ = mark_template_visible(conn, &template_id);
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

    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let doc = docs.iter().find(|d| d.id == id);
    if let Some(d) = doc {
        if is_hard_required_doc(conn, d) {
            return Err(
                "This document is required by the active profile framework and cannot be deleted."
                    .to_string(),
            );
        }
        if let Some(template_id) = d.template_id.as_deref() {
            let _ = mark_template_hidden(conn, template_id);
        }
        if let Some(fname) = d.file_name.as_deref() {
            let still_referenced = docs.iter().any(|other| {
                other.id != d.id
                    && other.category == d.category
                    && other.file_name.as_deref() == Some(fname)
            });
            if !still_referenced {
                let fp = vault_path.join(&d.category).join(fname);
                let _ = fs::remove_file(&fp);
            }
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
    let doc = docs
        .iter()
        .find(|d| d.id == doc_id)
        .ok_or("Document not found")?;
    let file_name = doc.file_name.as_ref().ok_or("No file attached")?;
    let p = vault_path.join(&doc.category).join(file_name);
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_file_base64(
    state: State<AppState>,
    doc_id: String,
) -> Result<(String, String), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let doc = docs
        .iter()
        .find(|d| d.id == doc_id)
        .ok_or("Document not found")?;
    let file_name = doc.file_name.as_ref().ok_or("No file attached")?;

    let file_path = vault_path.join(&doc.category).join(file_name);
    let size = fs::metadata(&file_path)
        .map_err(|e| format!("Cannot read file metadata: {}", e))?
        .len();
    if size > 8 * 1024 * 1024 {
        return Err(format!(
            "Preview skipped for large file ({} MB)",
            (size + 1024 * 1024 - 1) / (1024 * 1024)
        ));
    }
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

fn sanitize_file_component(value: &str, fallback: &str, max_chars: usize) -> String {
    let raw: String = value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c| c == ' ' || c == '.' || c == '-' || c == '_');
    let cleaned = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    cleaned.chars().take(max_chars).collect()
}

fn doc_file_suffix(doc_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(doc_id.as_bytes());
    hex::encode(hasher.finalize())
        .chars()
        .take(10)
        .collect::<String>()
}

fn sanitize_extension(ext: &str) -> String {
    ext.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

fn attachment_file_name(doc: &DocRecord, ext: &str) -> String {
    let title = sanitize_file_component(&doc.title, "Document", 96);
    let suffix = doc_file_suffix(&doc.id);
    let stem = format!("{} - {}", title, suffix);
    let ext = sanitize_extension(ext);
    if ext.is_empty() {
        stem
    } else {
        format!("{}.{}", stem, ext)
    }
}

fn content_type_for_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
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
    }
}

fn remove_unreferenced_old_attachment(
    vault_path: &Path,
    docs: &[DocRecord],
    doc: &DocRecord,
    old_file_name: Option<&str>,
    new_file_name: &str,
) {
    let Some(old_file_name) = old_file_name else {
        return;
    };
    if old_file_name == new_file_name {
        return;
    }
    let still_referenced = docs.iter().any(|other| {
        other.id != doc.id
            && other.category == doc.category
            && other.file_name.as_deref() == Some(old_file_name)
    });
    if !still_referenced {
        let old_path = vault_path.join(&doc.category).join(old_file_name);
        let _ = fs::remove_file(old_path);
    }
}

fn attach_file_to_vault(
    conn: &rusqlite::Connection,
    vault_path: &Path,
    doc_id: &str,
    source_path: &Path,
) -> Result<String, String> {
    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let doc = docs
        .iter()
        .find(|d| d.id == doc_id)
        .ok_or("Document not found")?;

    if !source_path.exists() {
        return Err(format!(
            "Source file not found: {}",
            source_path.to_string_lossy()
        ));
    }
    let ext = source_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let dest_name = attachment_file_name(doc, &ext);

    let cat_dir = vault_path.join(&doc.category);
    fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;

    let dest = cat_dir.join(&dest_name);
    let same_file = match (source_path.canonicalize(), dest.canonicalize()) {
        (Ok(src_abs), Ok(dest_abs)) => src_abs == dest_abs,
        _ => false,
    };
    if !same_file {
        fs::copy(source_path, &dest).map_err(|e| e.to_string())?;
    }

    let old_file_name = doc.file_name.as_deref();
    db::update_doc_file(conn, doc_id, &dest_name).map_err(|e| e.to_string())?;
    remove_unreferenced_old_attachment(vault_path, &docs, doc, old_file_name, &dest_name);

    // Phase-2 readiness (I-4): content hash
    if let Ok(bytes) = fs::read(&dest) {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = hex::encode(hasher.finalize());
        let size = bytes.len() as i64;
        let content_type = content_type_for_ext(&ext);
        let _ = db::update_doc_content_hash(conn, doc_id, &hash, size, content_type);
        let payload = serde_json::json!({
            "sha256": hash,
            "file_size": size,
            "content_type": content_type,
        })
        .to_string();
        let _ = db::log_event(
            conn,
            "file_attached",
            "document",
            Some(doc_id),
            Some(&payload),
        );
    }

    Ok(dest_name)
}

#[tauri::command]
pub fn attach_file(
    state: State<AppState>,
    doc_id: String,
    source_path: String,
) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let src = PathBuf::from(source_path);
    attach_file_to_vault(conn, vault_path, &doc_id, &src)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_doc(id: &str, category: &str, title: &str) -> DocRecord {
        DocRecord {
            id: id.to_string(),
            category: category.to_string(),
            title: title.to_string(),
            file_name: None,
            has_expiry: true,
            valid_from: None,
            valid_to: None,
            issued_by: None,
            doc_number: None,
            notes: None,
            field_statuses: None,
            regulatory_basis: None,
            template_id: Some(id.to_string()),
            sha256: None,
            file_size: None,
            content_type: None,
            visibility: "private".to_string(),
            is_national: false,
        }
    }

    fn create_temp_vault(prefix: &str) -> (PathBuf, rusqlite::Connection) {
        let vault_path = std::env::temp_dir().join(format!("{}-{}", prefix, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();
        (vault_path, conn)
    }

    fn write_synthetic_source(vault_path: &Path, id: &str, ext: &str) -> PathBuf {
        let p = vault_path.join(format!("source-{}.{}", id, ext));
        std::fs::write(
            &p,
            format!(
                "SYNTHETIC_CERTIFICATE\nDOC_ID={}\nUNIQUE_MARKER=marker-for-{}\n",
                id, id
            ),
        )
        .unwrap();
        p
    }

    fn attached_text(vault_path: &Path, doc: &DocRecord) -> String {
        let file_name = doc.file_name.as_ref().unwrap();
        std::fs::read_to_string(vault_path.join(&doc.category).join(file_name)).unwrap()
    }

    #[test]
    fn attach_file_uses_unique_paths_for_duplicate_titles() {
        let (vault_path, conn) = create_temp_vault("skipi-attach-collision");
        let category = "Certificate of Competency";
        let title = "Certificate of Competency - Master";
        let current = test_doc("coc-master-current", category, title);
        let historical = test_doc("coc-master-historical", category, title);
        db::insert_doc(&conn, &current).unwrap();
        db::insert_doc(&conn, &historical).unwrap();

        let current_source = write_synthetic_source(&vault_path, &current.id, "pdf");
        let historical_source = write_synthetic_source(&vault_path, &historical.id, "pdf");
        let current_name =
            attach_file_to_vault(&conn, &vault_path, &current.id, &current_source).unwrap();
        let historical_name =
            attach_file_to_vault(&conn, &vault_path, &historical.id, &historical_source).unwrap();

        assert_ne!(current_name, historical_name);
        let docs = db::get_all_docs(&conn).unwrap();
        let current = docs.iter().find(|d| d.id == "coc-master-current").unwrap();
        let historical = docs
            .iter()
            .find(|d| d.id == "coc-master-historical")
            .unwrap();
        assert_ne!(current.file_name, historical.file_name);
        assert!(attached_text(&vault_path, current).contains("DOC_ID=coc-master-current"));
        assert!(attached_text(&vault_path, historical).contains("DOC_ID=coc-master-historical"));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn attached_copy_survives_deleted_source_file() {
        let (vault_path, conn) = create_temp_vault("skipi-attach-source-deleted");
        let doc = test_doc("passport", "Passport", "Passport (Travel)");
        db::insert_doc(&conn, &doc).unwrap();

        let source = write_synthetic_source(&vault_path, &doc.id, "pdf");
        let dest_name = attach_file_to_vault(&conn, &vault_path, &doc.id, &source).unwrap();
        std::fs::remove_file(&source).unwrap();

        let docs = db::get_all_docs(&conn).unwrap();
        let attached = docs.iter().find(|d| d.id == doc.id).unwrap();
        assert_eq!(attached.file_name.as_deref(), Some(dest_name.as_str()));
        let vault_copy = vault_path.join(&doc.category).join(&dest_name);
        assert!(vault_copy.exists(), "vault copy disappeared after source delete");
        assert!(std::fs::read_to_string(vault_copy)
            .unwrap()
            .contains("DOC_ID=passport"));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn attach_large_and_corrupt_pdf_preserves_independent_metadata() {
        let (vault_path, conn) = create_temp_vault("skipi-attach-large-corrupt");
        let large = test_doc("large_pdf", "Medical", "Large PDF");
        let corrupt = test_doc("corrupt_pdf", "Medical", "Corrupt PDF");
        db::insert_doc(&conn, &large).unwrap();
        db::insert_doc(&conn, &corrupt).unwrap();

        let large_source = vault_path.join("large-source.pdf");
        let mut large_bytes = vec![0_u8; 32 * 1024 * 1024];
        large_bytes[..8].copy_from_slice(b"%PDF-1.7");
        let marker_at = large_bytes.len() - 16;
        large_bytes[marker_at..].copy_from_slice(b"SKIPI-LARGE-SMOK");
        std::fs::write(&large_source, &large_bytes).unwrap();

        let corrupt_source = vault_path.join("corrupt-source.pdf");
        let corrupt_bytes = b"%PDF-corrupt\nnot a real pdf trailer\n";
        std::fs::write(&corrupt_source, corrupt_bytes).unwrap();

        let large_name = attach_file_to_vault(&conn, &vault_path, &large.id, &large_source).unwrap();
        let corrupt_name =
            attach_file_to_vault(&conn, &vault_path, &corrupt.id, &corrupt_source).unwrap();
        assert_ne!(large_name, corrupt_name);

        let docs = db::get_all_docs(&conn).unwrap();
        let large_doc = docs.iter().find(|d| d.id == large.id).unwrap();
        let corrupt_doc = docs.iter().find(|d| d.id == corrupt.id).unwrap();
        assert_eq!(large_doc.file_size, Some(large_bytes.len() as i64));
        assert_eq!(corrupt_doc.file_size, Some(corrupt_bytes.len() as i64));
        assert_ne!(large_doc.sha256, corrupt_doc.sha256);
        assert_eq!(
            std::fs::metadata(vault_path.join(&large.category).join(&large_name))
                .unwrap()
                .len(),
            large_bytes.len() as u64
        );
        assert_eq!(
            std::fs::read(vault_path.join(&corrupt.category).join(&corrupt_name)).unwrap(),
            corrupt_bytes
        );

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn synthetic_profile_upload_smoke_keeps_each_certificate_in_place() {
        let (vault_path, conn) = create_temp_vault("skipi-synthetic-profile-smoke");
        let docs = vec![
            test_doc(
                "coc-master-current",
                "Certificate of Competency",
                "Certificate of Competency - Master",
            ),
            test_doc(
                "coc-master-old",
                "Certificate of Competency",
                "Certificate of Competency - Master",
            ),
            test_doc(
                "gmdss-goc",
                "Certificate of Competency",
                "GMDSS General Operator's Certificate",
            ),
            test_doc("bst", "STCW Mandatory", "Basic Safety Training (BST)"),
            test_doc("sso", "STCW Mandatory", "Ship Security Officer (SSO)"),
            test_doc(
                "ecdis-generic",
                "Deck Training",
                "ECDIS Generic Training",
            ),
            test_doc(
                "ecdis-furuno",
                "ECDIS Type Specific",
                "ECDIS Type-Specific - Furuno",
            ),
            test_doc(
                "ecdis-jrc",
                "ECDIS Type Specific",
                "ECDIS Type-Specific - JRC",
            ),
            test_doc(
                "radar-arpa",
                "Deck Training",
                "Radar Navigation, Radar Plotting and ARPA",
            ),
            test_doc("passport", "Passport", "Passport (Travel)"),
            test_doc(
                "seamans-book",
                "Seaman's Book",
                "Seaman's Book (Discharge Book)",
            ),
            test_doc(
                "flag-coc-endorsement",
                "Flag CoC Endorsement",
                "Flag CoC Endorsement",
            ),
            test_doc(
                "flag-seamans-book",
                "Flag Seaman's Book",
                "Flag Seaman's Book",
            ),
            test_doc(
                "bulk-dangerous-goods",
                "Bulk Carrier Specific",
                "Ships carrying dangerous and hazardous substances in solid form in bulk and in packaged form",
            ),
            test_doc(
                "polar-advanced",
                "STCW Specific",
                "Ice Navigation Advanced Training",
            ),
        ];
        for doc in &docs {
            db::insert_doc(&conn, doc).unwrap();
        }

        for doc in &docs {
            let src = write_synthetic_source(&vault_path, &doc.id, "pdf");
            attach_file_to_vault(&conn, &vault_path, &doc.id, &src).unwrap();
        }

        let attached = db::get_all_docs(&conn).unwrap();
        let mut seen_paths = HashSet::new();
        for expected in &docs {
            let actual = attached.iter().find(|d| d.id == expected.id).unwrap();
            let file_name = actual.file_name.as_ref().unwrap();
            assert!(
                seen_paths.insert((actual.category.clone(), file_name.clone())),
                "duplicate stored path for {}",
                actual.id
            );
            let content = attached_text(&vault_path, actual);
            assert!(
                content.contains(&format!("DOC_ID={}", expected.id)),
                "wrong synthetic marker in {}",
                expected.id
            );
        }

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn normalize_known_custom_sso_promotes_to_template_id() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-doc-normalize-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        let custom = DocRecord {
            id: "custom_sso".to_string(),
            category: "STCW Mandatory".to_string(),
            title: "Ship Security Officer".to_string(),
            file_name: None,
            has_expiry: false,
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
        db::insert_doc(&conn, &custom).unwrap();

        assert_eq!(normalize_known_custom_docs(&conn).unwrap(), 1);
        let docs = db::get_all_docs(&conn).unwrap();
        let sso = docs.iter().find(|d| d.id == "custom_sso").unwrap();
        assert_eq!(sso.template_id.as_deref(), Some("sso"));
        assert_eq!(sso.regulatory_basis.as_deref(), Some("STCW VI/5"));
        assert_eq!(sso.notes.as_deref(), Some("ISPS Code"));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn normalize_known_custom_ice_navigation_promotes_to_stcw_specific() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-doc-normalize-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        let custom = DocRecord {
            id: "custom_ice".to_string(),
            category: "Custom".to_string(),
            title: "Ice Navigation Advanced Training".to_string(),
            file_name: None,
            has_expiry: true,
            valid_from: None,
            valid_to: None,
            issued_by: None,
            doc_number: Some("PWA22121502".to_string()),
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
        db::insert_doc(&conn, &custom).unwrap();

        assert_eq!(normalize_known_custom_docs(&conn).unwrap(), 1);
        let docs = db::get_all_docs(&conn).unwrap();
        let polar = docs.iter().find(|d| d.id == "custom_ice").unwrap();
        assert_eq!(polar.template_id.as_deref(), Some("polar_advanced"));
        assert_eq!(polar.category, "STCW Specific");
        assert_eq!(polar.doc_number.as_deref(), Some("PWA22121502"));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn normalize_known_custom_flag_docs_promotes_to_fixed_flag_sections() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-doc-normalize-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        for (id, title) in [
            ("custom_flag_coc", "Flag CoC Endorsement"),
            ("custom_flag_book", "Flag Seaman's Book"),
        ] {
            let custom = DocRecord {
                id: id.to_string(),
                category: "Custom".to_string(),
                title: title.to_string(),
                file_name: None,
                has_expiry: true,
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
            db::insert_doc(&conn, &custom).unwrap();
        }

        assert_eq!(normalize_known_custom_docs(&conn).unwrap(), 2);
        let docs = db::get_all_docs(&conn).unwrap();
        let coc = docs.iter().find(|d| d.id == "custom_flag_coc").unwrap();
        let book = docs.iter().find(|d| d.id == "custom_flag_book").unwrap();
        assert_eq!(coc.template_id.as_deref(), Some("flag_coc_endorsement"));
        assert_eq!(coc.category, "Flag CoC Endorsement");
        assert_eq!(book.template_id.as_deref(), Some("flag_seamans_book"));
        assert_eq!(book.category, "Flag Seaman's Book");

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn normalize_known_custom_dangerous_bulk_cargo_promotes_to_bulk_specific() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-doc-normalize-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        let custom = DocRecord {
            id: "custom_bulk_dg".to_string(),
            category: "Custom".to_string(),
            title: "Ships carrying dangerous and hazardous substances in solid form in bulk and in packaged form".to_string(),
            file_name: None,
            has_expiry: true,
            valid_from: None,
            valid_to: Some("2026-07-24".to_string()),
            issued_by: None,
            doc_number: Some("41920055".to_string()),
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
        db::insert_doc(&conn, &custom).unwrap();

        assert_eq!(normalize_known_custom_docs(&conn).unwrap(), 1);
        let docs = db::get_all_docs(&conn).unwrap();
        let dg = docs.iter().find(|d| d.id == "custom_bulk_dg").unwrap();
        assert_eq!(
            dg.template_id.as_deref(),
            Some("dangerous_hazardous_substances")
        );
        assert_eq!(dg.category, "Bulk Carrier Specific");
        assert_eq!(dg.doc_number.as_deref(), Some("41920055"));
        assert_eq!(dg.valid_to.as_deref(), Some("2026-07-24"));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn refresh_known_template_metadata_renames_legacy_ecdis_slot() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-doc-refresh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        let legacy = DocRecord {
            id: "ecdis_legacy".to_string(),
            category: "Deck Training".to_string(),
            title: "ECDIS Training".to_string(),
            file_name: None,
            has_expiry: false,
            valid_from: None,
            valid_to: None,
            issued_by: None,
            doc_number: None,
            notes: Some("Generic + type-specific".to_string()),
            field_statuses: None,
            regulatory_basis: Some("STCW A-II/1, A-II/2".to_string()),
            template_id: Some("ecdis".to_string()),
            sha256: None,
            file_size: None,
            content_type: None,
            visibility: "private".to_string(),
            is_national: false,
        };
        db::insert_doc(&conn, &legacy).unwrap();

        assert_eq!(refresh_known_template_metadata(&conn).unwrap(), 1);
        let docs = db::get_all_docs(&conn).unwrap();
        let ecdis = docs.iter().find(|d| d.id == "ecdis_legacy").unwrap();
        assert_eq!(ecdis.title, "ECDIS Generic Training");
        assert!(ecdis
            .notes
            .as_deref()
            .unwrap_or("")
            .contains("type-specific ECDIS certificates"));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }
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
        if !src.exists() {
            continue;
        }
        let data = fs::read(&src).map_err(|e| format!("read {}: {}", src.display(), e))?;
        let in_zip = format!("{}/{}", doc.category, fname);
        zip.start_file(&in_zip, options)
            .map_err(|e| e.to_string())?;
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

    for entry in db::get_work_history(conn).map_err(|e| e.to_string())? {
        let entry_id = match entry.get("id").and_then(|v| v.as_str()) {
            Some(v) if !v.is_empty() => v,
            _ => continue,
        };
        let vessel_name = entry
            .get("vessel_name")
            .and_then(|v| v.as_str())
            .unwrap_or("Sea service");
        let imo = entry.get("imo").and_then(|v| v.as_str());
        let company = entry.get("company").and_then(|v| v.as_str());
        let position = entry.get("position").and_then(|v| v.as_str());
        let sign_on = entry.get("sign_on").and_then(|v| v.as_str());
        let sign_off = entry.get("sign_off").and_then(|v| v.as_str());
        let folder_name = work_history::work_entry_storage_dir(vault_path, conn, entry_id)
            .ok()
            .and_then(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| entry_id.to_string());
        for file in db::get_work_files(conn, entry_id).map_err(|e| e.to_string())? {
            let file_id = match file.get("id").and_then(|v| v.as_str()) {
                Some(v) if !v.is_empty() => v,
                _ => continue,
            };
            let fname = match file.get("file_name").and_then(|v| v.as_str()) {
                Some(v) if !v.is_empty() => v,
                _ => continue,
            };
            let kind = file.get("kind").and_then(|v| v.as_str());
            let src = work_history::resolve_work_file_path(vault_path, conn, entry_id, fname);
            if !src.exists() {
                continue;
            }
            let data = fs::read(&src).map_err(|e| format!("read {}: {}", src.display(), e))?;
            let in_zip = format!("Sea Service/{}/{}", folder_name, fname);
            zip.start_file(&in_zip, options).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
            let period = [sign_on, sign_off].into_iter().flatten().collect::<Vec<_>>().join(" - ");
            let title = [
                Some(vessel_name),
                position,
                kind,
                if period.is_empty() { None } else { Some(period.as_str()) },
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
            manifest_docs.push(serde_json::json!({
                "id": format!("sea_service_{}", file_id),
                "title": title,
                "category": "Sea Service",
                "template_id": serde_json::Value::Null,
                "is_template": false,
                "doc_number": imo,
                "issued_by": company,
                "valid_from": serde_json::Value::Null,
                "valid_to": serde_json::Value::Null,
                "file_name": fname,
                "file_path": in_zip,
                "sea_service": {
                    "entry_id": entry_id,
                    "vessel_name": vessel_name,
                    "imo": imo,
                    "position": position,
                    "sign_on": sign_on,
                    "sign_off": sign_off,
                    "kind": kind,
                },
            }));
        }
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
    let manifest_str = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(manifest_str.as_bytes())
        .map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}
