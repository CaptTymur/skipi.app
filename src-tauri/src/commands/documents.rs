use super::{messaging, work_history};
use crate::db::{self, DocRecord};
use crate::AppState;
use crate::{frameworks, profiles};
use printpdf::{Image, ImageTransform, Mm, PdfDocument};
use rusqlite::params;
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::State;

const HIDDEN_TEMPLATE_IDS_KEY: &str = "hidden_template_ids";
const MOBILE_ATTACHMENT_LIMIT_BYTES: usize = 25 * 1024 * 1024;
const MOBILE_PDF_INPUT_LIMIT_BYTES: usize = 140 * 1024 * 1024;

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
        || doc.is_permanent
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
        || doc.is_permanent
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
                 template_id = ?7,
                 is_permanent = ?8
             WHERE id = ?9",
            params![
                rec.category,
                rec.title,
                rec.has_expiry as i32,
                rec.valid_to,
                rec.notes,
                rec.regulatory_basis,
                rec.template_id,
                rec.is_permanent as i32,
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
    is_permanent: Option<bool>,
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
    let is_permanent = is_permanent.unwrap_or(false);

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
            is_permanent,
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
        "is_permanent": rec.is_permanent,
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
    let is_permanent = profiles::default_is_permanent_doc(&template_id);
    let rec = DocRecord {
        id: id.clone(),
        category: category.clone(),
        title: title.clone(),
        file_name: None,
        has_expiry,
        is_permanent,
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
        "is_permanent": is_permanent,
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
fn resolve_document_file(state: &AppState, doc_id: &str) -> Result<(PathBuf, String), String> {
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
    if !p.is_file() {
        return Err("File missing on disk".to_string());
    }
    Ok((p, file_name.clone()))
}

#[tauri::command]
pub fn get_document_file_path(state: State<AppState>, doc_id: String) -> Result<String, String> {
    let (p, _) = resolve_document_file(&state, &doc_id)?;
    Ok(p.to_string_lossy().to_string())
}

#[cfg(target_os = "android")]
fn mime_for_file_name(file_name: &str) -> &'static str {
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".pdf") {
        "application/pdf"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

#[cfg(target_os = "android")]
fn preview_file_name(doc_id: &str, file_name: &str) -> String {
    let clean_name: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean_name = clean_name.trim_matches('_');
    if clean_name.is_empty() {
        format!("{}-document", doc_id)
    } else {
        format!("{}-{}", doc_id, clean_name)
    }
}

#[cfg(target_os = "android")]
fn copy_document_to_preview_cache(
    app: &tauri::AppHandle,
    source: &Path,
    doc_id: &str,
    file_name: &str,
) -> Result<PathBuf, String> {
    use tauri::Manager;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Resolve cache dir: {}", e))?
        .join("skipi-preview");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("Create preview cache: {}", e))?;
    let target = cache_dir.join(preview_file_name(doc_id, file_name));
    fs::copy(source, &target).map_err(|e| format!("Prepare preview file: {}", e))?;
    Ok(target)
}

#[cfg(target_os = "android")]
fn open_path_android(window: tauri::WebviewWindow, path: &Path, mime: &str) -> Result<(), String> {
    use jni::objects::{JObject, JString, JValue};
    use std::sync::mpsc;
    use std::time::Duration;

    let path = path.to_string_lossy().to_string();
    let mime = mime.to_string();
    let (tx, rx) = mpsc::channel();

    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                let result = (|| -> Result<(), String> {
                    let path_string = env
                        .new_string(path)
                        .map_err(|e| format!("Android path string: {}", e))?;
                    let mime_string = env
                        .new_string(mime)
                        .map_err(|e| format!("Android mime string: {}", e))?;
                    let path_object = JObject::from(path_string);
                    let mime_object = JObject::from(mime_string);
                    let value = env
                        .call_method(
                            activity,
                            "openSkipiFile",
                            "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                            &[JValue::Object(&path_object), JValue::Object(&mime_object)],
                        )
                        .map_err(|e| format!("Open file on Android: {}", e))?
                        .l()
                        .map_err(|e| format!("Open file result: {}", e))?;
                    if value.is_null() {
                        return Ok(());
                    }
                    let message: String = env
                        .get_string(&JString::from(value))
                        .map_err(|e| format!("Open file error string: {}", e))?
                        .into();
                    Err(message)
                })();
                let _ = tx.send(result);
            });
        })
        .map_err(|e| e.to_string())?;

    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out while opening file".to_string())?
}

#[cfg(target_os = "android")]
fn render_pdf_page_android(
    window: tauri::WebviewWindow,
    path: &Path,
    max_width: i32,
) -> Result<PathBuf, String> {
    use jni::objects::{JObject, JString, JValue};
    use std::sync::mpsc;
    use std::time::Duration;

    let path = path.to_string_lossy().to_string();
    let (tx, rx) = mpsc::channel();

    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                let result = (|| -> Result<PathBuf, String> {
                    let path_string = env
                        .new_string(path)
                        .map_err(|e| format!("Android PDF path string: {}", e))?;
                    let path_object = JObject::from(path_string);
                    let value = env
                        .call_method(
                            activity,
                            "renderSkipiPdfPage",
                            "(Ljava/lang/String;I)Ljava/lang/String;",
                            &[JValue::Object(&path_object), JValue::Int(max_width)],
                        )
                        .map_err(|e| format!("Render PDF on Android: {}", e))?
                        .l()
                        .map_err(|e| format!("Render PDF result: {}", e))?;
                    if value.is_null() {
                        return Err("Android PDF renderer returned no preview path".to_string());
                    }
                    let rendered_path: String = env
                        .get_string(&JString::from(value))
                        .map_err(|e| format!("Render PDF result string: {}", e))?
                        .into();
                    if let Some(message) = rendered_path.strip_prefix("ERROR:") {
                        return Err(message.to_string());
                    }
                    Ok(PathBuf::from(rendered_path))
                })();
                let _ = tx.send(result);
            });
        })
        .map_err(|e| e.to_string())?;

    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Timed out while rendering PDF preview".to_string())?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn open_path_desktop(path: &Path) -> Result<(), String> {
    let path = path.to_string_lossy().to_string();
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_document_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
    doc_id: String,
) -> Result<(), String> {
    let (path, file_name) = resolve_document_file(&state, &doc_id)?;

    #[cfg(target_os = "android")]
    {
        let mime = mime_for_file_name(&file_name);
        let preview_path = copy_document_to_preview_cache(&app, &path, &doc_id, &file_name)?;
        return open_path_android(window, &preview_path, mime);
    }

    #[cfg(target_os = "ios")]
    {
        let _ = (app, window, file_name);
        return Err("Opening attached files is not wired for iOS yet.".to_string());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, window, file_name);
        open_path_desktop(&path)
    }
}

#[tauri::command]
pub fn render_document_pdf_preview(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    doc_id: String,
) -> Result<(String, String), String> {
    let (path, file_name) = resolve_document_file(&state, &doc_id)?;
    if !file_name.to_lowercase().ends_with(".pdf") {
        return Err("Attached file is not a PDF.".to_string());
    }
    let _ = &path;

    #[cfg(target_os = "android")]
    {
        let preview_path = render_pdf_page_android(window, &path, 1000)?;
        let data = fs::read(&preview_path).map_err(|e| format!("Read PDF preview: {}", e))?;
        return Ok((crate::base64_encode(&data), "image/png".to_string()));
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = window;
        Err("Built-in PDF preview is only wired for Android for now.".to_string())
    }
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

#[tauri::command]
pub fn render_document_thumbnail(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    doc_id: String,
) -> Result<(String, String), String> {
    let (path, file_name) = resolve_document_file(&state, &doc_id)?;
    let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();

    if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "bmp") {
        let data = fs::read(&path).map_err(|e| format!("Cannot read image: {}", e))?;
        let image = image::load_from_memory(&data)
            .map_err(|e| format!("Cannot decode thumbnail image: {}", e))?;
        let thumb = image.thumbnail(180, 220);
        let mut out = Vec::new();
        thumb
            .write_to(
                &mut Cursor::new(&mut out),
                image::ImageOutputFormat::Jpeg(78),
            )
            .map_err(|e| format!("Cannot encode thumbnail: {}", e))?;
        return Ok((crate::base64_encode(&out), "image/jpeg".to_string()));
    }

    if ext == "pdf" {
        #[cfg(target_os = "android")]
        {
            let preview_path = render_pdf_page_android(window.clone(), &path, 220)?;
            let data = fs::read(&preview_path).map_err(|e| format!("Read PDF thumbnail: {}", e))?;
            return Ok((crate::base64_encode(&data), "image/png".to_string()));
        }

        #[cfg(not(target_os = "android"))]
        {
            let _ = &window;
            return Err("PDF thumbnails are available on Android builds.".to_string());
        }
    }

    let _ = &window;
    Err("Thumbnail is not available for this file type.".to_string())
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageImage {
    pub file_name: Option<String>,
    pub data_base64: String,
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

fn attach_bytes_to_vault(
    conn: &rusqlite::Connection,
    vault_path: &Path,
    doc_id: &str,
    original_file_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("File is empty".to_string());
    }
    if bytes.len() > MOBILE_ATTACHMENT_LIMIT_BYTES {
        return Err("File is too large for mobile upload (25 MB max).".to_string());
    }

    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let doc = docs
        .iter()
        .find(|d| d.id == doc_id)
        .ok_or("Document not found")?;

    let ext = Path::new(original_file_name)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "jpg".to_string());
    let dest_name = attachment_file_name(doc, &ext);

    let cat_dir = vault_path.join(&doc.category);
    fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;

    let dest = cat_dir.join(&dest_name);
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;

    let old_file_name = doc.file_name.as_deref();
    db::update_doc_file(conn, doc_id, &dest_name).map_err(|e| e.to_string())?;
    remove_unreferenced_old_attachment(vault_path, &docs, doc, old_file_name, &dest_name);

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = hex::encode(hasher.finalize());
    let size = bytes.len() as i64;
    let content_type = content_type_for_ext(&ext);
    let _ = db::update_doc_content_hash(conn, doc_id, &hash, size, content_type);
    let payload = serde_json::json!({
        "sha256": hash,
        "file_size": size,
        "content_type": content_type,
        "source": "mobile_bytes",
    })
    .to_string();
    let _ = db::log_event(
        conn,
        "file_attached",
        "document",
        Some(doc_id),
        Some(&payload),
    );

    Ok(dest_name)
}

fn decode_pdf_page_images(pages: &[PdfPageImage]) -> Result<Vec<image::DynamicImage>, String> {
    let mut decoded = Vec::with_capacity(pages.len());
    let mut total_input_bytes = 0usize;
    for (idx, page) in pages.iter().enumerate() {
        let label = page
            .file_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(|name| format!("page {} ({})", idx + 1, name))
            .unwrap_or_else(|| format!("page {}", idx + 1));
        if page.data_base64.trim().is_empty() {
            return Err(format!("{} is empty.", label));
        }
        let bytes = data_encoding::BASE64
            .decode(page.data_base64.as_bytes())
            .map_err(|e| format!("Invalid image encoding on {}: {}", label, e))?;
        total_input_bytes += bytes.len();
        if total_input_bytes > MOBILE_PDF_INPUT_LIMIT_BYTES {
            return Err("Selected pages are too large for one mobile PDF.".to_string());
        }
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("Cannot decode image {}: {}", label, e))?;
        if img.width() == 0 || img.height() == 0 {
            return Err(format!("Image {} has invalid dimensions.", label));
        }
        decoded.push(img);
    }
    Ok(decoded)
}

fn normalize_scan_page(img: &image::DynamicImage, max_long_edge: u32) -> image::DynamicImage {
    let long_edge = img.width().max(img.height());
    let resized = if long_edge > max_long_edge {
        let scale = max_long_edge as f64 / long_edge as f64;
        let next_w = ((img.width() as f64 * scale).round() as u32).max(1);
        let next_h = ((img.height() as f64 * scale).round() as u32).max(1);
        img.resize_exact(next_w, next_h, image::imageops::FilterType::Lanczos3)
    } else {
        img.clone()
    };
    image::DynamicImage::ImageLuma8(resized.to_luma8())
}

fn render_decoded_images_pdf(
    decoded: &[image::DynamicImage],
    max_long_edge: u32,
) -> Result<Vec<u8>, String> {
    let page_w = 210.0_f64;
    let page_h = 297.0_f64;
    let margin = 8.0_f64;
    let box_w = page_w - margin * 2.0;
    let box_h = page_h - margin * 2.0;
    let dpi = 220.0_f64;
    let mm_per_px = 25.4 / dpi;

    let (doc, page1, layer1) = PdfDocument::new(
        "Skipi document scan",
        Mm(page_w as f32),
        Mm(page_h as f32),
        "Page 1",
    );

    for (idx, raw_img) in decoded.iter().enumerate() {
        let dyn_img = normalize_scan_page(raw_img, max_long_edge);
        let layer = if idx == 0 {
            doc.get_page(page1).get_layer(layer1)
        } else {
            let (page, layer) = doc.add_page(
                Mm(page_w as f32),
                Mm(page_h as f32),
                &format!("Page {}", idx + 1),
            );
            doc.get_page(page).get_layer(layer)
        };

        let px_w = dyn_img.width() as f64;
        let px_h = dyn_img.height() as f64;
        let native_w_mm = px_w * mm_per_px;
        let native_h_mm = px_h * mm_per_px;
        let scale = (box_w / native_w_mm).min(box_h / native_h_mm);
        let final_w_mm = native_w_mm * scale;
        let final_h_mm = native_h_mm * scale;
        let tx = margin + (box_w - final_w_mm) / 2.0;
        let ty = margin + (box_h - final_h_mm) / 2.0;

        let image = Image::from_dynamic_image(&dyn_img);
        image.add_to_layer(
            layer,
            ImageTransform {
                translate_x: Some(Mm(tx as f32)),
                translate_y: Some(Mm(ty as f32)),
                scale_x: Some(scale as f32),
                scale_y: Some(scale as f32),
                dpi: Some(dpi as f32),
                ..Default::default()
            },
        );
    }

    let mut pdf = Vec::new();
    {
        let mut writer = std::io::BufWriter::new(&mut pdf);
        doc.save(&mut writer).map_err(|e| e.to_string())?;
    }
    Ok(pdf)
}

fn render_image_pages_pdf(pages: &[PdfPageImage]) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("Add at least one page before creating PDF.".to_string());
    }
    if pages.len() > 40 {
        return Err("Too many pages for one mobile PDF (40 pages max).".to_string());
    }

    let decoded = decode_pdf_page_images(pages)?;
    let quality_steps: &[u32] = if pages.len() <= 3 {
        &[2200, 1800, 1400, 1100]
    } else if pages.len() <= 8 {
        &[1800, 1400, 1100, 900]
    } else {
        &[1400, 1100, 900, 760]
    };

    let mut last_size = 0usize;
    for max_long_edge in quality_steps {
        let pdf = render_decoded_images_pdf(&decoded, *max_long_edge)?;
        last_size = pdf.len();
        if pdf.len() <= MOBILE_ATTACHMENT_LIMIT_BYTES {
            return Ok(pdf);
        }
    }

    Err(format!(
        "PDF is still too large after compression ({} MB). Split it into fewer pages.",
        (last_size + 1024 * 1024 - 1) / (1024 * 1024)
    ))
}

fn attach_pdf_pages_to_vault(
    conn: &rusqlite::Connection,
    vault_path: &Path,
    doc_id: &str,
    file_name: &str,
    pages: &[PdfPageImage],
) -> Result<String, String> {
    let pdf = render_image_pages_pdf(pages)?;
    let safe_file_name = if file_name.trim().is_empty() {
        "document.pdf"
    } else {
        file_name.trim()
    };
    let pdf_file_name = if safe_file_name.to_lowercase().ends_with(".pdf") {
        safe_file_name.to_string()
    } else {
        format!("{}.pdf", safe_file_name)
    };
    attach_bytes_to_vault(conn, vault_path, doc_id, &pdf_file_name, &pdf)
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

#[tauri::command]
pub fn attach_file_bytes(
    state: State<AppState>,
    doc_id: String,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let bytes = data_encoding::BASE64
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("Invalid file encoding: {}", e))?;
    attach_bytes_to_vault(conn, vault_path, &doc_id, &file_name, &bytes)
}

#[tauri::command]
pub fn attach_pdf_pages(
    state: State<AppState>,
    doc_id: String,
    file_name: String,
    pages: Vec<PdfPageImage>,
) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    attach_pdf_pages_to_vault(conn, vault_path, &doc_id, &file_name, &pages)
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
            is_permanent: false,
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
        assert!(
            vault_copy.exists(),
            "vault copy disappeared after source delete"
        );
        assert!(std::fs::read_to_string(vault_copy)
            .unwrap()
            .contains("DOC_ID=passport"));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    fn tiny_png_base64(rgb: [u8; 3]) -> String {
        let img = image::RgbImage::from_pixel(4, 4, image::Rgb(rgb));
        let dyn_img = image::DynamicImage::ImageRgb8(img);
        let mut bytes = Vec::new();
        dyn_img
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageOutputFormat::Png,
            )
            .unwrap();
        crate::base64_encode(&bytes)
    }

    #[test]
    fn attach_pdf_pages_creates_single_pdf_attachment() {
        let (vault_path, conn) = create_temp_vault("skipi-pdf-pages");
        let doc = test_doc(
            "multi_page_cert",
            "STCW Mandatory",
            "Multi Page Certificate",
        );
        db::insert_doc(&conn, &doc).unwrap();

        let pages = vec![
            PdfPageImage {
                file_name: Some("page-1.png".to_string()),
                data_base64: tiny_png_base64([220, 230, 255]),
            },
            PdfPageImage {
                file_name: Some("page-2.png".to_string()),
                data_base64: tiny_png_base64([235, 255, 230]),
            },
        ];

        let dest_name = attach_pdf_pages_to_vault(
            &conn,
            &vault_path,
            &doc.id,
            "Multi Page Certificate.pdf",
            &pages,
        )
        .unwrap();
        assert!(dest_name.ends_with(".pdf"));

        let pdf_path = vault_path.join(&doc.category).join(&dest_name);
        let pdf = std::fs::read(pdf_path).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        assert!(pdf.len() > 1000);

        let docs = db::get_all_docs(&conn).unwrap();
        let attached = docs.iter().find(|d| d.id == doc.id).unwrap();
        assert_eq!(attached.file_name.as_deref(), Some(dest_name.as_str()));
        assert_eq!(attached.content_type.as_deref(), Some("application/pdf"));
        assert_eq!(attached.file_size, Some(pdf.len() as i64));

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

        let large_name =
            attach_file_to_vault(&conn, &vault_path, &large.id, &large_source).unwrap();
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
            is_permanent: false,
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
            is_permanent: false,
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
                is_permanent: false,
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
            is_permanent: false,
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
            is_permanent: false,
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
                    "is_permanent": doc.is_permanent,
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
            "is_permanent": doc.is_permanent,
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
            .and_then(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
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
            zip.start_file(&in_zip, options)
                .map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
            let period = [sign_on, sign_off]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" - ");
            let title = [
                Some(vessel_name),
                position,
                kind,
                if period.is_empty() {
                    None
                } else {
                    Some(period.as_str())
                },
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
    let messaging_identity = messaging::identity_for_vault(vault_path)?;
    let messaging_user_id = messaging_identity.user_id;
    let messaging_pubkey_b64 = messaging_identity.pubkey_b64;
    let vault_user_id = db::get_vault_info_value(conn, "user_id");
    let vault_identity_pubkey = db::get_vault_info_value(conn, "identity_pubkey");
    let manifest = serde_json::json!({
        "schema_version": 1,
        "exported_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "skipi_identity": {
            "schema_version": 1,
            "role": "seafarer",
            "messaging_user_id": &messaging_user_id,
            "messaging_pubkey_b64": &messaging_pubkey_b64,
            "vault_user_id": vault_user_id.as_deref(),
            "vault_identity_pubkey": vault_identity_pubkey.as_deref(),
        },
        "exported_by": {
            "name": info.name,
            "rank": info.rank,
            "vessel_type": info.vessel_type,
            "position": info.position,
            "vessel_category": info.vessel_category,
            "user_id": &messaging_user_id,
            "messaging_user_id": &messaging_user_id,
            "messaging_pubkey_b64": &messaging_pubkey_b64,
            "vault_user_id": vault_user_id.as_deref(),
            "identity_pubkey": vault_identity_pubkey.as_deref(),
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
