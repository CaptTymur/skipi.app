use crate::db::{self, VaultInfo};
use crate::{api, demo, frameworks, identity, profiles, AppState};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn get_profile_taxonomy() -> serde_json::Value {
    let levels: Vec<serde_json::Value> = profiles::StcwLevel::all()
        .iter()
        .map(|l| {
            serde_json::json!({
                "id": l.id(),
                "label": l.label(),
            })
        })
        .collect();

    let vessel_nodes: Vec<serde_json::Value> = profiles::vessel_tree()
        .iter()
        .map(|v| {
            serde_json::json!({
                "id": v.id,
                "label": v.label,
                "parent": v.parent,
                "is_leaf": v.is_leaf,
            })
        })
        .collect();

    let pos: Vec<serde_json::Value> = profiles::positions()
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "label": p.label,
                "display_label": profiles::position_display_label(p.id).unwrap_or(p.label),
                "level": p.level.id(),
                "dept": p.dept,
            })
        })
        .collect();

    serde_json::json!({
        "levels": levels,
        "vessel_tree": vessel_nodes,
        "positions": pos,
    })
}

#[tauri::command]
pub fn get_optional_categories() -> Vec<String> {
    profiles::optional_categories()
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

#[tauri::command]
pub fn get_required_docs(
    level_id: String,
    vessel_id: String,
    position_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let level = profiles::StcwLevel::from_id(&level_id).ok_or("Unknown STCW level")?;
    let templates = profiles::required_docs_for_profile(level, &vessel_id, &position_id);
    Ok(templates
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "title": t.title,
                "category": t.category,
                "regulatory_basis": t.regulatory_basis,
                "has_expiry": t.has_expiry,
                "typical_years": t.typical_years,
                "notes": t.notes,
            })
        })
        .collect())
}

#[tauri::command]
pub fn create_profile_vault(
    state: State<AppState>,
    path: String,
    name: String,
    stcw_level: String,
    vessel_category: String,
    position: String,
    position_label: Option<String>,
    recovery_key: Option<String>,
) -> Result<VaultInfo, String> {
    let vault_path = PathBuf::from(&path);
    if vault_path.join("skipi.db").exists() {
        return Err("A Skipi vault already exists in that folder. Use Open Existing Vault, or choose a different parent folder/name.".to_string());
    }
    fs::create_dir_all(&vault_path).map_err(|e| e.to_string())?;

    let conn = db::open_db(&vault_path).map_err(|e| e.to_string())?;
    crate::reset_vault_content(&conn);
    if let Some(key) = recovery_key.as_deref().filter(|s| !s.trim().is_empty()) {
        identity::install_recovery_key(&vault_path, key)?;
    }
    identity::ensure_vault_identity(&conn, &vault_path)?;

    db::set_vault_info(&conn, "account_type", "seafarer").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "name", &name).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "stcw_level", &stcw_level).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "vessel_category", &vessel_category).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "position", &position).map_err(|e| e.to_string())?;

    let rank_label: Option<String> =
        if let Some(lbl) = position_label.as_ref().filter(|s| !s.trim().is_empty()) {
            db::set_vault_info(&conn, "position_custom", lbl).map_err(|e| e.to_string())?;
            Some(lbl.trim().to_string())
        } else if let Some(p) = profiles::position(&position) {
            Some(p.label.to_string())
        } else {
            None
        };
    if let Some(ref lbl) = rank_label {
        db::set_vault_info(&conn, "rank", lbl).map_err(|e| e.to_string())?;
    }
    let vessel_label: Option<String> = profiles::vessel_tree()
        .into_iter()
        .find(|v| v.id == vessel_category)
        .map(|v| v.label.to_string());
    if let Some(lbl) = &vessel_label {
        db::set_vault_info(&conn, "vessel_type", lbl).map_err(|e| e.to_string())?;
    }

    let level = profiles::StcwLevel::from_id(&stcw_level).ok_or("Unknown STCW level")?;
    let templates = profiles::required_docs_for_profile(level, &vessel_category, &position);

    let mut categories_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for t in &templates {
        let rec = frameworks::record_from_profile_template(t);
        if categories_seen.insert(rec.category.clone()) {
            let cat_dir = vault_path.join(&rec.category);
            fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;
        }
        let payload = serde_json::json!({
            "category": rec.category.clone(),
            "kind": "framework",
            "template_id": rec.template_id.clone(),
            "account_type": "seafarer",
        })
        .to_string();
        let rec_id = rec.id.clone();
        db::insert_doc(&conn, &rec).map_err(|e| e.to_string())?;
        let _ = db::log_event(
            &conn,
            "doc_added",
            "document",
            Some(&rec_id),
            Some(&payload),
        );
    }

    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;
    crate::save_last_vault(&path);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
    Ok(info)
}

fn current_required_profile_templates(
    conn: &Connection,
) -> Result<Vec<profiles::DocTemplate>, String> {
    let g = |k: &str| db::get_vault_info_value(conn, k);
    if g("account_type").as_deref() != Some("seafarer") {
        return Ok(Vec::new());
    }

    let level_id = match g("stcw_level") {
        Some(v) if !v.is_empty() => v,
        _ => return Ok(Vec::new()),
    };
    let vessel_category = g("vessel_category").unwrap_or_default();
    let position = g("position").unwrap_or_default();
    let level = match profiles::StcwLevel::from_id(&level_id) {
        Some(l) => l,
        None => return Ok(Vec::new()),
    };

    Ok(profiles::required_docs_for_profile(
        level,
        &vessel_category,
        &position,
    ))
}

fn set_vault_info_if_changed(conn: &Connection, key: &str, value: &str) -> Result<bool, String> {
    if db::get_vault_info_value(conn, key).as_deref() == Some(value) {
        return Ok(false);
    }
    db::set_vault_info(conn, key, value).map_err(|e| e.to_string())?;
    Ok(true)
}

fn json_field_string(fields: &serde_json::Value, key: &str) -> Option<String> {
    let value = fields.get(key)?;
    let s = match value {
        serde_json::Value::Null => return None,
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn requested_ready_for_offers(fields: &serde_json::Value) -> bool {
    json_field_string(fields, "ready_for_offers")
        .map(|s| s.eq_ignore_ascii_case("true") || s == "1" || s.eq_ignore_ascii_case("yes"))
        .unwrap_or(false)
}

fn field_or_vault_info(
    conn: &Connection,
    fields: &serde_json::Value,
    field_key: &str,
    db_keys: &[&str],
) -> Option<String> {
    let field_candidates: &[&str] = match field_key {
        "nationality" => &["nationality", "nationality_code"],
        "rank" => &["rank", "position"],
        "preferred_vessel_types" => &["preferred_vessel_types", "vessel_category", "vessel_type"],
        _ => std::slice::from_ref(&field_key),
    };
    field_candidates
        .iter()
        .find_map(|key| json_field_string(fields, key))
        .or_else(|| {
            db_keys.iter().find_map(|key| {
                db::get_vault_info_value(conn, key).filter(|s| !s.trim().is_empty())
            })
        })
}

fn seafarer_ready_profile_missing(
    conn: &Connection,
    fields: &serde_json::Value,
) -> Vec<&'static str> {
    let required: [(&str, &[&str], &str); 14] = [
        ("surname", &["personal_surname"], "Surname"),
        ("first_name", &["personal_first_name"], "First name"),
        ("date_of_birth", &["personal_dob"], "Date of birth"),
        (
            "place_of_birth",
            &["personal_place_of_birth"],
            "Place of birth",
        ),
        (
            "nationality",
            &["personal_nationality", "personal_nationality_code"],
            "Citizenship",
        ),
        ("phones", &["personal_phones"], "Phone"),
        ("email", &["personal_email"], "Email"),
        ("rank", &["personal_rank", "rank", "position"], "Rank"),
        (
            "preferred_vessel_types",
            &["preferred_vessel_types", "vessel_category", "vessel_type"],
            "Vessel type",
        ),
        (
            "nearest_airport",
            &["personal_nearest_airport"],
            "Nearest airport",
        ),
        (
            "nearest_intl_airport",
            &["personal_nearest_intl_airport"],
            "Nearest international airport",
        ),
        (
            "available_from",
            &["personal_available_from"],
            "Available for joining",
        ),
        ("min_salary", &["personal_min_salary"], "Minimum salary"),
        ("home_address", &["personal_home_address"], "Home address"),
    ];

    required
        .iter()
        .filter_map(|(field_key, db_keys, label)| {
            if field_or_vault_info(conn, fields, field_key, db_keys)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
            {
                None
            } else {
                Some(*label)
            }
        })
        .collect()
}

fn readiness_rank_label(conn: &Connection, fields: &serde_json::Value) -> Option<String> {
    json_field_string(fields, "rank")
        .or_else(|| db::get_vault_info_value(conn, "personal_rank"))
        .or_else(|| db::get_vault_info_value(conn, "rank"))
        .or_else(|| db::get_vault_info_value(conn, "position"))
}

fn normalized_readiness_key(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn experience_optional_for_rank(rank: Option<&str>) -> bool {
    let rank = match rank {
        Some(v) if !v.trim().is_empty() => v.trim(),
        _ => return false,
    };
    let key = normalized_readiness_key(rank);
    if key.contains("cadet") || key.contains("student") {
        return true;
    }
    if matches!(
        key.as_str(),
        "deckcadet"
            | "enginecadet"
            | "ordinaryseaman"
            | "os"
            | "wiper"
            | "messman"
            | "steward"
            | "messmansteward"
    ) {
        return true;
    }
    matches!(
        profiles::position_id_from_rank_label(rank),
        Some("os" | "wiper" | "messman")
    )
}

fn has_sea_service_entry(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM work_history
         WHERE TRIM(COALESCE(vessel_name, '')) <> ''
            OR TRIM(COALESCE(position, '')) <> ''
            OR TRIM(COALESCE(sign_on, '')) <> ''
            OR TRIM(COALESCE(sign_off, '')) <> ''",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn document_matches_template(doc: &db::DocRecord, template: &profiles::DocTemplate) -> bool {
    doc.template_id.as_deref() == Some(template.id)
        || (doc.template_id.as_deref().unwrap_or("").is_empty()
            && doc.title.eq_ignore_ascii_case(template.title))
}

fn required_document_gaps(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let templates = current_required_profile_templates(conn)?;
    if templates.is_empty() {
        return Ok(Vec::new());
    }
    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let today = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let mut gaps = Vec::new();
    for template in templates.iter() {
        let matches: Vec<&db::DocRecord> = docs
            .iter()
            .filter(|doc| document_matches_template(doc, template))
            .collect();
        let reason = if matches.is_empty() {
            Some("missing")
        } else {
            let with_file: Vec<&db::DocRecord> = matches
                .iter()
                .copied()
                .filter(|doc| {
                    doc.file_name
                        .as_deref()
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false)
                })
                .collect();
            if with_file.is_empty() {
                Some("no_file")
            } else if with_file.iter().all(|doc| {
                doc.valid_to
                    .as_deref()
                    .map(|v| !v.trim().is_empty() && v < today.as_str())
                    .unwrap_or(false)
            }) {
                Some("expired")
            } else {
                None
            }
        };
        if let Some(reason) = reason {
            gaps.push(serde_json::json!({
                "kind": "document",
                "reason": reason,
                "id": template.id,
                "label": template.title,
                "category": template.category,
                "regulatory_basis": template.regulatory_basis,
            }));
        }
    }
    Ok(gaps)
}

fn seafarer_jobs_readiness_status(
    conn: &Connection,
    fields: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let profile_missing: Vec<serde_json::Value> = seafarer_ready_profile_missing(conn, fields)
        .into_iter()
        .map(|label| serde_json::json!({"kind": "profile", "label": label}))
        .collect();
    let document_missing = required_document_gaps(conn)?;
    let rank_label = readiness_rank_label(conn, fields);
    let experience_exempt = experience_optional_for_rank(rank_label.as_deref());
    let experience_missing = !experience_exempt && !has_sea_service_entry(conn);
    let mut missing = Vec::new();
    missing.extend(profile_missing.iter().cloned());
    missing.extend(document_missing.iter().cloned());
    if experience_missing {
        missing.push(serde_json::json!({
            "kind": "experience",
            "label": "Sea service / work experience",
            "reason": "missing",
        }));
    }
    Ok(serde_json::json!({
        "ok": missing.is_empty(),
        "profile_missing": profile_missing,
        "document_missing": document_missing,
        "experience_missing": experience_missing,
        "experience_exempt": experience_exempt,
        "rank": rank_label,
        "missing": missing,
    }))
}

fn readiness_error_message(status: &serde_json::Value) -> String {
    let labels: Vec<String> = status
        .get("missing")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("label").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    if labels.is_empty() {
        "Complete seafarer readiness before enabling job offers".to_string()
    } else {
        format!(
            "Complete seafarer readiness before enabling job offers: {}",
            labels.join(", ")
        )
    }
}

fn template_change_items(
    templates: &[profiles::DocTemplate],
    other_ids: &std::collections::HashSet<String>,
) -> Vec<serde_json::Value> {
    templates
        .iter()
        .filter(|t| !other_ids.contains(t.id))
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "title": t.title,
                "category": t.category,
                "regulatory_basis": t.regulatory_basis,
            })
        })
        .collect()
}

fn sync_seafarer_document_framework(
    conn: &Connection,
    vault_path: &std::path::Path,
    fields: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    if db::get_vault_info_value(conn, "account_type").as_deref() != Some("seafarer") {
        return Ok(serde_json::json!({
            "metadata_changed": false,
            "requirements_changed": false,
            "docs_added": 0,
            "requirements_added": [],
            "requirements_removed": [],
        }));
    }

    let before_templates = current_required_profile_templates(conn)?;
    let before_ids: std::collections::HashSet<String> =
        before_templates.iter().map(|t| t.id.to_string()).collect();

    let rank_input = json_field_string(fields, "rank")
        .or_else(|| db::get_vault_info_value(conn, "personal_rank"))
        .or_else(|| db::get_vault_info_value(conn, "rank"));
    let vessel_input = json_field_string(fields, "preferred_vessel_types")
        .or_else(|| db::get_vault_info_value(conn, "preferred_vessel_types"))
        .or_else(|| db::get_vault_info_value(conn, "vessel_category"))
        .or_else(|| db::get_vault_info_value(conn, "vessel_type"));

    let mut changed = false;
    let mut framework_known = false;
    let mut position_id: Option<&'static str> = None;
    let mut level_id: Option<&'static str> = None;
    let mut vessel_id: Option<&'static str> = None;

    if let Some(rank) = rank_input.as_deref() {
        if let Some(pid) = profiles::position_id_from_rank_label(rank) {
            position_id = Some(pid);
            framework_known = true;
            changed |= set_vault_info_if_changed(conn, "position", pid)?;
            if let Some(pos) = profiles::position(pid) {
                level_id = Some(pos.level.id());
                changed |= set_vault_info_if_changed(conn, "stcw_level", pos.level.id())?;
                changed |= set_vault_info_if_changed(conn, "rank", pos.label)?;
            }
        }
    }

    if let Some(vessel) = vessel_input.as_deref() {
        if let Some(vid) = profiles::vessel_id_from_label_or_id(vessel) {
            vessel_id = Some(vid);
            framework_known = true;
            changed |= set_vault_info_if_changed(conn, "vessel_category", vid)?;
            if let Some(label) = profiles::vessel_label(vid) {
                changed |= set_vault_info_if_changed(conn, "vessel_type", label)?;
            }
        }
    }

    let docs_added = if framework_known {
        ensure_profile_templates(conn, vault_path)?
    } else {
        0
    };

    let after_templates = current_required_profile_templates(conn)?;
    let after_ids: std::collections::HashSet<String> =
        after_templates.iter().map(|t| t.id.to_string()).collect();
    let requirements_added = template_change_items(&after_templates, &before_ids);
    let requirements_removed = template_change_items(&before_templates, &after_ids);
    let requirements_changed = before_ids != after_ids;
    let result = serde_json::json!({
        "metadata_changed": changed,
        "requirements_changed": requirements_changed,
        "docs_added": docs_added,
        "requirements_added": requirements_added,
        "requirements_removed": requirements_removed,
        "position": position_id,
        "stcw_level": level_id,
        "vessel_category": vessel_id,
        "rank": position_id.and_then(profiles::position).map(|p| p.label.to_string()),
        "vessel_type": vessel_id.and_then(profiles::vessel_label),
    });

    if changed || docs_added > 0 || requirements_changed {
        let payload = serde_json::json!({
            "position": position_id,
            "stcw_level": level_id,
            "vessel_category": vessel_id,
            "docs_added": docs_added,
            "requirements_changed": requirements_changed,
        })
        .to_string();
        let _ = db::log_event(
            conn,
            "profile_framework_updated",
            "vault_info",
            None,
            Some(&payload),
        );
    }

    Ok(result)
}

/// Seeds missing required-template rows into an existing vault.
/// Called from `open_vault` so vaults created before we added a template
/// (e.g. the Visas category added in v0.4.21) pick it up automatically on
/// the next launch — without requiring a manual reset/recreate.
///
/// Only inserts rows whose `template_id` is not already present in the
/// `documents` table; never overwrites or deletes anything.
pub fn ensure_profile_templates(
    conn: &rusqlite::Connection,
    vault_path: &std::path::Path,
) -> Result<usize, String> {
    let _ = crate::commands::documents::normalize_known_custom_docs(conn);
    let _ = crate::commands::documents::refresh_known_template_metadata(conn);
    let _ = crate::commands::documents::prune_empty_catalog_only_docs(conn);
    let g = |k: &str| db::get_vault_info_value(conn, k);
    if g("account_type").as_deref() != Some("seafarer") {
        return Ok(0);
    }
    let level_id = match g("stcw_level") {
        Some(v) if !v.is_empty() => v,
        _ => return Ok(0),
    };
    let vessel_category = g("vessel_category").unwrap_or_default();
    let position = g("position").unwrap_or_default();

    let level = match profiles::StcwLevel::from_id(&level_id) {
        Some(l) => l,
        None => return Ok(0),
    };
    let templates = profiles::required_docs_for_profile(level, &vessel_category, &position);
    for t in &templates {
        let _ = crate::commands::documents::mark_template_visible(conn, t.id);
    }
    let hidden_templates = crate::commands::documents::hidden_template_ids(conn);

    // Collect existing template_ids in one query to avoid N selects.
    let mut existing: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT template_id FROM documents WHERE template_id IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut inserted = 0usize;
    for t in &templates {
        if existing.contains(t.id) {
            continue;
        }
        let rec = frameworks::record_from_profile_template(t);
        let cat_dir = vault_path.join(&rec.category);
        let _ = std::fs::create_dir_all(&cat_dir);
        let payload = serde_json::json!({
            "category": rec.category.clone(),
            "kind": "framework",
            "template_id": rec.template_id.clone(),
            "account_type": "seafarer",
            "source": "ensure_profile_templates",
        })
        .to_string();
        let rec_id = rec.id.clone();
        if let Some(template_id) = rec.template_id.clone() {
            existing.insert(template_id);
        }
        db::insert_doc(conn, &rec).map_err(|e| e.to_string())?;
        let _ = db::log_event(
            conn,
            "doc_seeded",
            "document",
            Some(&rec_id),
            Some(&payload),
        );
        inserted += 1;
    }
    for t in profiles::conditional_seafarer_doc_templates() {
        if hidden_templates.contains(t.id) {
            continue;
        }
        if existing.contains(t.id) {
            continue;
        }
        let rec = frameworks::record_from_profile_template(&t);
        let cat_dir = vault_path.join(&rec.category);
        let _ = std::fs::create_dir_all(&cat_dir);
        let payload = serde_json::json!({
            "category": rec.category.clone(),
            "kind": "conditional_framework",
            "template_id": rec.template_id.clone(),
            "account_type": "seafarer",
            "source": "ensure_profile_templates",
        })
        .to_string();
        let rec_id = rec.id.clone();
        if let Some(template_id) = rec.template_id.clone() {
            existing.insert(template_id);
        }
        db::insert_doc(conn, &rec).map_err(|e| e.to_string())?;
        let _ = db::log_event(
            conn,
            "doc_seeded",
            "document",
            Some(&rec_id),
            Some(&payload),
        );
    }
    Ok(inserted)
}

#[tauri::command]
pub fn get_active_template_ids(state: State<AppState>) -> Result<Vec<String>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    Ok(current_required_profile_templates(conn)?
        .into_iter()
        .map(|t| t.id.to_string())
        .collect())
}

#[tauri::command]
pub fn get_conditional_template_ids() -> Vec<String> {
    profiles::conditional_seafarer_doc_templates()
        .into_iter()
        .map(|t| t.id.to_string())
        .collect()
}

#[tauri::command]
pub fn get_seafarer_frameworks(
    level_id: String,
    vessel_id: String,
    position_id: String,
) -> Result<Vec<profiles::Framework>, String> {
    let level = profiles::StcwLevel::from_id(&level_id).ok_or("Unknown STCW level")?;
    Ok(profiles::applicable_frameworks_for_seafarer(
        level,
        &vessel_id,
        &position_id,
    ))
}

#[tauri::command]
pub fn get_vessel_frameworks(
    vessel_id: String,
    size_id: String,
    trade_id: String,
) -> Result<Vec<profiles::Framework>, String> {
    let size = profiles::VesselSize::from_id(&size_id).ok_or("Unknown vessel size band")?;
    let trade = profiles::TradeArea::from_id(&trade_id).ok_or("Unknown trade area")?;
    Ok(profiles::applicable_frameworks_for_vessel(
        &vessel_id, size, trade,
    ))
}

#[tauri::command]
pub fn get_vessel_required_docs(
    vessel_id: String,
    size_id: String,
    trade_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let size = profiles::VesselSize::from_id(&size_id).ok_or("Unknown vessel size band")?;
    let trade = profiles::TradeArea::from_id(&trade_id).ok_or("Unknown trade area")?;
    let templates = profiles::required_docs_for_vessel(&vessel_id, size, trade);
    Ok(templates
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "title": t.title,
                "category": t.category,
                "regulatory_basis": t.regulatory_basis,
                "has_expiry": t.has_expiry,
                "typical_years": t.typical_years,
                "notes": t.notes,
            })
        })
        .collect())
}

#[tauri::command]
pub fn get_vessel_taxonomy() -> serde_json::Value {
    let vessel_nodes: Vec<serde_json::Value> = profiles::vessel_tree()
        .iter()
        .map(|v| {
            serde_json::json!({
                "id": v.id,
                "label": v.label,
                "parent": v.parent,
                "is_leaf": v.is_leaf,
            })
        })
        .collect();

    let sizes: Vec<serde_json::Value> = profiles::VesselSize::all()
        .iter()
        .map(|s| serde_json::json!({ "id": s.id(), "label": s.label() }))
        .collect();

    let trades: Vec<serde_json::Value> = profiles::TradeArea::all()
        .iter()
        .map(|t| serde_json::json!({ "id": t.id(), "label": t.label() }))
        .collect();

    serde_json::json!({
        "vessel_tree": vessel_nodes,
        "sizes": sizes,
        "trades": trades,
    })
}

#[tauri::command]
pub fn create_vessel_profile_vault(
    state: State<AppState>,
    path: String,
    name: String,
    vessel_category: String,
    vessel_size: String,
    trade_area: String,
    flag: Option<String>,
    imo: Option<String>,
) -> Result<VaultInfo, String> {
    let vault_path = PathBuf::from(&path);
    if vault_path.join("skipi.db").exists() {
        return Err("A Skipi vault already exists in that folder. Use Open Existing Vault, or choose a different parent folder/name.".to_string());
    }
    fs::create_dir_all(&vault_path).map_err(|e| e.to_string())?;

    let conn = db::open_db(&vault_path).map_err(|e| e.to_string())?;
    crate::reset_vault_content(&conn);
    identity::ensure_vault_identity(&conn, &vault_path)?;

    db::set_vault_info(&conn, "account_type", "vessel").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "name", &name).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "vessel_category", &vessel_category).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "vessel_size", &vessel_size).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "trade_area", &trade_area).map_err(|e| e.to_string())?;
    if let Some(f) = flag.as_ref().filter(|s| !s.trim().is_empty()) {
        db::set_vault_info(&conn, "flag", f.trim()).map_err(|e| e.to_string())?;
    }
    if let Some(i) = imo.as_ref().filter(|s| !s.trim().is_empty()) {
        db::set_vault_info(&conn, "imo", i.trim()).map_err(|e| e.to_string())?;
    }

    let vessel_label: Option<String> = profiles::vessel_tree()
        .into_iter()
        .find(|v| v.id == vessel_category)
        .map(|v| v.label.to_string());
    if let Some(lbl) = &vessel_label {
        db::set_vault_info(&conn, "vessel_type", lbl).map_err(|e| e.to_string())?;
    }

    let size = profiles::VesselSize::from_id(&vessel_size).ok_or("Unknown vessel size band")?;
    let trade = profiles::TradeArea::from_id(&trade_area).ok_or("Unknown trade area")?;
    let templates = profiles::required_docs_for_vessel(&vessel_category, size, trade);

    let mut categories_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for t in &templates {
        let rec = frameworks::record_from_profile_template(t);
        if categories_seen.insert(rec.category.clone()) {
            let cat_dir = vault_path.join(&rec.category);
            fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;
        }
        let payload = serde_json::json!({
            "category": rec.category.clone(),
            "kind": "framework",
            "template_id": rec.template_id.clone(),
            "account_type": "vessel",
        })
        .to_string();
        let rec_id = rec.id.clone();
        db::insert_doc(&conn, &rec).map_err(|e| e.to_string())?;
        let _ = db::log_event(
            &conn,
            "doc_added",
            "document",
            Some(&rec_id),
            Some(&payload),
        );
    }

    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;
    crate::save_last_vault(&path);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
    Ok(info)
}

/// Create (or overwrite) a demo vault at the given path and open it.
#[tauri::command]
pub fn create_demo_vault(state: State<AppState>, path: String) -> Result<VaultInfo, String> {
    let vault_path = PathBuf::from(&path);
    let conn = demo::populate_demo_vault(&vault_path)?;
    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;
    crate::save_last_vault(&path);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
    Ok(info)
}

fn demo_vault_auto_path(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        use tauri::Manager;
        let base = _app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Could not resolve app data folder: {}", e))?
            .join("vaults");
        fs::create_dir_all(&base)
            .map_err(|e| format!("Could not create mobile Skipi vault folder: {}", e))?;
        return Ok(base.join("Skipi Demo"));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let base = dirs::document_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        Ok(base.join("Skipi Demo"))
    }
}

/// Auto-create a demo vault in the platform default location (no folder picker).
#[tauri::command]
pub fn create_demo_vault_auto(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<VaultInfo, String> {
    let vault_path = demo_vault_auto_path(&app)?;
    let conn = demo::populate_demo_vault(&vault_path)?;
    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;
    let path_str = vault_path.to_string_lossy().to_string();
    crate::save_last_vault(&path_str);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
    Ok(info)
}

// ========== MATCHABLE PROFILE ====================================

const MATCHABLE_VERSION: u32 = 1;

fn compute_age_bucket(dob: Option<&str>) -> Option<String> {
    let dob = dob?;
    let parsed = chrono::NaiveDate::parse_from_str(dob, "%Y-%m-%d").ok()?;
    let today = chrono::Utc::now().date_naive();
    let years = today.years_since(parsed)? as u32;
    let bucket = match years {
        0..=17 => "under-18",
        18..=24 => "18-24",
        25..=29 => "25-29",
        30..=39 => "30-39",
        40..=49 => "40-49",
        50..=59 => "50-59",
        _ => "60+",
    };
    Some(bucket.to_string())
}

fn compute_years_experience(conn: &Connection) -> Option<i64> {
    let mut stmt = conn
        .prepare("SELECT sign_on, sign_off FROM work_history WHERE sign_on IS NOT NULL AND sign_off IS NOT NULL")
        .ok()?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .ok()?;
    let mut total_days: i64 = 0;
    for row in rows.flatten() {
        if let (Ok(a), Ok(b)) = (
            chrono::NaiveDate::parse_from_str(&row.0, "%Y-%m-%d"),
            chrono::NaiveDate::parse_from_str(&row.1, "%Y-%m-%d"),
        ) {
            let d = (b - a).num_days();
            if d > 0 {
                total_days += d;
            }
        }
    }
    Some(total_days / 365)
}

fn csv_list(s: Option<String>) -> Vec<String> {
    s.unwrap_or_default()
        .split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

#[tauri::command]
pub fn get_matchable_profile(state: State<AppState>) -> Result<serde_json::Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let _ = identity::sync_identity_fingerprint(conn);

    let g = |k: &str| db::get_vault_info_value(conn, k);
    let age_bucket = compute_age_bucket(g("personal_dob").as_deref());
    let years_exp = compute_years_experience(conn);

    Ok(serde_json::json!({
        "matchable_version": MATCHABLE_VERSION,
        "user_id": g("user_id"),
        "identity_pubkey": g("identity_pubkey"),
        "identity_fingerprint": g("identity_fingerprint"),
        "identity_trust_status": g("identity_trust_status"),
        "public_seafarer_id": g("skipi_public_seafarer_id"),
        "identity_claim_status": g("skipi_identity_claim_status"),
        "rank_id": g("position"),
        "rank_label": None::<String>,
        "stcw_level": g("stcw_level"),
        "vessel_type_ids": csv_list(g("preferred_vessel_types")),
        "position_id": g("position"),
        "available_from": g("personal_available_from"),
        "years_experience": years_exp,
        "nationality_code": g("personal_nationality_code"),
        "visa_countries": csv_list(g("personal_visa_countries")),
        "min_salary": g("personal_min_salary")
            .and_then(|s| s.parse::<i64>().ok()),
        "currency": g("personal_currency"),
        "age_bucket": age_bucket,
        "languages": csv_list(g("personal_languages")),
        "english_level": g("personal_english_level"),
    }))
}

#[derive(Debug, Clone, Serialize)]
struct SeafarerIdentityClaimRequest {
    vault_user_id: String,
    first_name: String,
    last_name: String,
    date_of_birth: String,
    nationality_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct SeafarerIdentityClaimResponse {
    status: String,
    duplicate: bool,
    public_seafarer_id: Option<String>,
    trust_level: String,
    identity_recovery_key: Option<String>,
    message: String,
}

fn required_identity_field(conn: &Connection, key: &str, label: &str) -> Result<String, String> {
    let value = db::get_vault_info_value(conn, key).unwrap_or_default();
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("Fill {label} before claiming Skipi ID"))
    } else {
        Ok(trimmed.to_string())
    }
}

#[tauri::command]
pub fn claim_seafarer_identity(state: State<AppState>) -> Result<serde_json::Value, String> {
    let vault_path = state
        .vault_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .ok_or("No vault open")?
        .clone();
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;

    identity::ensure_vault_identity(conn, &vault_path)?;
    let vault_user_id = required_identity_field(conn, "user_id", "vault User ID")?;
    let first_name = required_identity_field(conn, "personal_first_name", "first name")?;
    let last_name = required_identity_field(conn, "personal_surname", "surname")?;
    let date_of_birth = required_identity_field(conn, "personal_dob", "date of birth")?;
    let nationality_code = db::get_vault_info_value(conn, "personal_nationality_code")
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty());

    let body = SeafarerIdentityClaimRequest {
        vault_user_id,
        first_name,
        last_name,
        date_of_birth,
        nationality_code,
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let response: SeafarerIdentityClaimResponse =
        api::post_json(&client, "/api/seafarer-identity/claim", &body)?;

    db::set_vault_info(conn, "skipi_identity_claim_status", &response.status)
        .map_err(|e| e.to_string())?;
    db::set_vault_info(
        conn,
        "skipi_identity_duplicate",
        if response.duplicate { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())?;
    db::set_vault_info(conn, "skipi_identity_trust_level", &response.trust_level)
        .map_err(|e| e.to_string())?;
    db::set_vault_info(conn, "skipi_identity_message", &response.message)
        .map_err(|e| e.to_string())?;
    db::set_vault_info(
        conn,
        "skipi_identity_last_claim_at",
        &chrono::Utc::now().to_rfc3339(),
    )
    .map_err(|e| e.to_string())?;
    db::set_vault_info(
        conn,
        "skipi_public_seafarer_id",
        response.public_seafarer_id.as_deref().unwrap_or(""),
    )
    .map_err(|e| e.to_string())?;
    if let Some(key) = response
        .identity_recovery_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        db::set_vault_info(conn, "skipi_identity_recovery_key", key).map_err(|e| e.to_string())?;
    }
    let _ = identity::sync_identity_fingerprint(conn);

    serde_json::to_value(response).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_jobs_readiness_status(state: State<AppState>) -> Result<serde_json::Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    seafarer_jobs_readiness_status(conn, &serde_json::json!({}))
}

// ========== SEAFARER PERSONAL DETAILS ============================

#[tauri::command]
pub fn get_seafarer_personal(state: State<AppState>) -> Result<serde_json::Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let g = |k: &str| db::get_vault_info_value(conn, k);
    let rank = g("personal_rank").or_else(|| g("rank"));
    let preferred_vessel_types = g("preferred_vessel_types").or_else(|| g("vessel_category"));
    Ok(serde_json::json!({
        "rank": rank,
        "available_from": g("personal_available_from"),
        "surname": g("personal_surname"),
        "first_name": g("personal_first_name"),
        "middle_name": g("personal_middle_name"),
        "date_of_birth": g("personal_dob"),
        "place_of_birth": g("personal_place_of_birth"),
        "nationality": g("personal_nationality"),
        "nationality_code": g("personal_nationality_code"),
        "home_address": g("personal_home_address"),
        "phones": g("personal_phones"),
        "email": g("personal_email"),
        "nearest_airport": g("personal_nearest_airport"),
        "nearest_intl_airport": g("personal_nearest_intl_airport"),
        "photo_path": g("personal_photo_path"),
        "passport_no": g("personal_passport_no"),
        "passport_issue_date": g("personal_passport_issue"),
        "passport_expiry": g("personal_passport_expiry"),
        "seaman_book_no": g("personal_seaman_book_no"),
        "seaman_book_issue_date": g("personal_seaman_book_issue"),
        "seaman_book_expiry": g("personal_seaman_book_expiry"),
        "height_cm": g("personal_height_cm"),
        "weight_kg": g("personal_weight_kg"),
        "coverall_size": g("personal_coverall_size"),
        "shoe_size_eu": g("personal_shoe_size_eu"),
        "blood_type": g("personal_blood_type"),
        "marital_status": g("personal_marital_status"),
        "children_count": g("personal_children_count"),
        "next_of_kin_name": g("personal_next_of_kin_name"),
        "next_of_kin_relation": g("personal_next_of_kin_relation"),
        "next_of_kin_phone": g("personal_next_of_kin_phone"),
        "visa_countries": g("personal_visa_countries"),
        "min_salary": g("personal_min_salary"),
        "currency": g("personal_currency"),
        "languages": g("personal_languages"),
        "english_level": g("personal_english_level"),
        "preferred_vessel_types": preferred_vessel_types,
        "ready_for_offers": g("personal_ready_for_offers"),
        "preferred_messenger": g("personal_preferred_messenger"),
    }))
}

#[tauri::command]
pub fn set_seafarer_personal(
    state: State<AppState>,
    fields: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let vault_path = state
        .vault_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let allowed = [
        ("rank", "personal_rank"),
        ("available_from", "personal_available_from"),
        ("surname", "personal_surname"),
        ("first_name", "personal_first_name"),
        ("middle_name", "personal_middle_name"),
        ("date_of_birth", "personal_dob"),
        ("place_of_birth", "personal_place_of_birth"),
        ("nationality", "personal_nationality"),
        ("nationality_code", "personal_nationality_code"),
        ("home_address", "personal_home_address"),
        ("phones", "personal_phones"),
        ("email", "personal_email"),
        ("nearest_airport", "personal_nearest_airport"),
        ("nearest_intl_airport", "personal_nearest_intl_airport"),
        ("passport_no", "personal_passport_no"),
        ("passport_issue_date", "personal_passport_issue"),
        ("passport_expiry", "personal_passport_expiry"),
        ("seaman_book_no", "personal_seaman_book_no"),
        ("seaman_book_issue_date", "personal_seaman_book_issue"),
        ("seaman_book_expiry", "personal_seaman_book_expiry"),
        ("height_cm", "personal_height_cm"),
        ("weight_kg", "personal_weight_kg"),
        ("coverall_size", "personal_coverall_size"),
        ("shoe_size_eu", "personal_shoe_size_eu"),
        ("blood_type", "personal_blood_type"),
        ("marital_status", "personal_marital_status"),
        ("children_count", "personal_children_count"),
        ("next_of_kin_name", "personal_next_of_kin_name"),
        ("next_of_kin_relation", "personal_next_of_kin_relation"),
        ("next_of_kin_phone", "personal_next_of_kin_phone"),
        ("visa_countries", "personal_visa_countries"),
        ("min_salary", "personal_min_salary"),
        ("currency", "personal_currency"),
        ("languages", "personal_languages"),
        ("english_level", "personal_english_level"),
        ("preferred_vessel_types", "preferred_vessel_types"),
        ("ready_for_offers", "personal_ready_for_offers"),
        ("preferred_messenger", "personal_preferred_messenger"),
    ];
    if requested_ready_for_offers(&fields) {
        let missing = seafarer_ready_profile_missing(conn, &fields);
        if !missing.is_empty() {
            return Err(format!(
                "Complete seafarer profile before enabling job offers: {}",
                missing.join(", ")
            ));
        }
    }
    let mut changed = false;
    for (k, db_key) in allowed.iter() {
        if let Some(v) = fields.get(*k) {
            let s = match v {
                serde_json::Value::Null => String::new(),
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            db::set_vault_info(conn, db_key, &s).map_err(|e| e.to_string())?;
            changed = true;
        }
    }
    if changed {
        let _ = identity::sync_identity_fingerprint(conn);
        let _ = db::log_event(conn, "profile_updated", "vault_info", None, None);
    }
    let framework = if let Some(path) = vault_path.as_ref() {
        sync_seafarer_document_framework(conn, path, &fields)?
    } else {
        serde_json::json!({
            "metadata_changed": false,
            "requirements_changed": false,
            "docs_added": 0,
            "requirements_added": [],
            "requirements_removed": [],
        })
    };
    let framework_changed = framework
        .get("metadata_changed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || framework
            .get("requirements_changed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
    let docs_added = framework
        .get("docs_added")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if requested_ready_for_offers(&fields) {
        let readiness = seafarer_jobs_readiness_status(conn, &serde_json::json!({}))?;
        if !readiness
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            db::set_vault_info(conn, "personal_ready_for_offers", "false")
                .map_err(|e| e.to_string())?;
            return Err(readiness_error_message(&readiness));
        }
    }
    Ok(serde_json::json!({
        "saved": changed,
        "framework_changed": framework_changed,
        "docs_added": docs_added,
        "framework": framework,
    }))
}

// ========== PROFILE PHOTO ========================================

#[tauri::command]
pub fn upload_profile_photo(state: State<AppState>, source_path: String) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err("Source photo does not exist".to_string());
    }
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let profile_dir = vault_path.join("_profile");
    fs::create_dir_all(&profile_dir).map_err(|e| e.to_string())?;
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "jpg".to_string());
    if profile_dir.exists() {
        if let Ok(entries) = fs::read_dir(&profile_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if let Some(n) = name.to_str() {
                    if n.starts_with("photo.") {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
    let dest_name = format!("photo.{}", ext);
    let dest = profile_dir.join(&dest_name);
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    let rel = format!("_profile/{}", dest_name);
    {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        db::set_vault_info(conn, "personal_photo_path", &rel).map_err(|e| e.to_string())?;
    }
    Ok(rel)
}

#[tauri::command]
pub fn clear_profile_photo(state: State<AppState>) -> Result<(), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    if let Some(rel) = db::get_vault_info_value(conn, "personal_photo_path") {
        let abs = vault_path.join(&rel);
        let _ = fs::remove_file(&abs);
    }
    db::set_vault_info(conn, "personal_photo_path", "").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_profile_photo_abs_path(state: State<AppState>) -> Result<Option<String>, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    match db::get_vault_info_value(conn, "personal_photo_path") {
        Some(rel) => {
            let abs = vault_path.join(&rel);
            if abs.exists() {
                Ok(Some(abs.to_string_lossy().to_string()))
            } else {
                Ok(None)
            }
        }
        None => Ok(None),
    }
}

/// Returns the profile photo encoded as a `data:image/...;base64,...` URL so
/// the frontend can assign it straight to `<img src>`. We avoid the asset
/// protocol here because it requires an extra capability + scope list; the
/// photo is tiny (<200kB), so inlining is fine.
#[tauri::command]
pub fn get_profile_photo_data_url(state: State<AppState>) -> Result<Option<String>, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    let rel = match db::get_vault_info_value(conn, "personal_photo_path") {
        Some(r) if !r.is_empty() => r,
        _ => return Ok(None),
    };
    let abs = vault_path.join(&rel);
    if !abs.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "jpg".to_string());
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };
    let b64 = crate::base64_encode(&bytes);
    Ok(Some(format!("data:{};base64,{}", mime, b64)))
}

// ========== PROFILE STATUS =======================================

fn doc_text_present(value: Option<&String>) -> bool {
    value.map(|s| !s.trim().is_empty()).unwrap_or(false)
}

fn doc_has_attached_file(doc: &db::DocRecord) -> bool {
    doc_text_present(doc.file_name.as_ref())
        || doc_text_present(doc.sha256.as_ref())
        || doc.file_size.unwrap_or(0) > 0
}

fn required_profile_status_from_docs(
    templates: &[profiles::DocTemplate],
    docs: &[db::DocRecord],
) -> (Vec<serde_json::Value>, Vec<String>, f64) {
    let have: std::collections::HashSet<String> = docs
        .iter()
        .filter_map(|d| {
            if doc_has_attached_file(d) {
                d.template_id.clone()
            } else {
                None
            }
        })
        .collect();

    let total = templates.len() as f64;
    let mut missing_ids: Vec<String> = Vec::new();
    let required_json: Vec<serde_json::Value> = templates
        .iter()
        .map(|t| {
            let has = have.contains(t.id);
            if !has {
                missing_ids.push(t.id.to_string());
            }
            serde_json::json!({
                "id": t.id,
                "title": t.title,
                "category": t.category,
                "regulatory_basis": t.regulatory_basis,
                "has": has,
            })
        })
        .collect();
    let pct = if total > 0.0 {
        (total - missing_ids.len() as f64) / total * 100.0
    } else {
        0.0
    };
    (required_json, missing_ids, pct)
}

#[tauri::command]
pub fn get_profile_status(state: State<AppState>) -> Result<serde_json::Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;

    let stcw_level = db::get_vault_info_value(conn, "stcw_level");
    let vessel_category = db::get_vault_info_value(conn, "vessel_category");
    let position = db::get_vault_info_value(conn, "position");

    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;

    let (required, missing, completeness): (Vec<serde_json::Value>, Vec<String>, f64) =
        if let (Some(l), Some(v), Some(p)) = (
            stcw_level.clone(),
            vessel_category.clone(),
            position.clone(),
        ) {
            if let Some(level) = profiles::StcwLevel::from_id(&l) {
                let tpls = profiles::required_docs_for_profile(level, &v, &p);
                required_profile_status_from_docs(&tpls, &docs)
            } else {
                (vec![], vec![], 0.0)
            }
        } else {
            (vec![], vec![], 0.0)
        };

    Ok(serde_json::json!({
        "stcw_level": stcw_level,
        "vessel_category": vessel_category,
        "position": position,
        "is_demo": db::get_vault_info_value(conn, "is_demo"),
        "required": required,
        "missing_ids": missing,
        "completeness_pct": completeness,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ready_for_offers_requires_matchable_profile_fields() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-ready-profile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        for (key, value) in [
            ("personal_surname", "Petrov"),
            ("personal_first_name", "Ivan"),
            ("personal_dob", "1988-02-03"),
            ("personal_place_of_birth", "Odesa"),
            ("personal_nationality", "Ukrainian"),
            ("personal_phones", "+380000000000"),
            ("personal_email", "ivan@example.com"),
            ("personal_rank", "Second Officer"),
            ("personal_nearest_airport", "Odesa (ODS)"),
            ("personal_nearest_intl_airport", "Warsaw (WAW)"),
            ("personal_available_from", "2026-06-01"),
            ("personal_min_salary", "4500"),
            ("personal_home_address", "Odesa, Ukraine"),
        ] {
            db::set_vault_info(&conn, key, value).unwrap();
        }

        let fields = serde_json::json!({"ready_for_offers": "true"});
        let missing = seafarer_ready_profile_missing(&conn, &fields);
        assert!(missing.contains(&"Vessel type"));

        let fields = serde_json::json!({
            "ready_for_offers": "true",
            "preferred_vessel_types": "bulker",
        });
        assert!(seafarer_ready_profile_missing(&conn, &fields).is_empty());

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn job_readiness_requires_required_docs_and_experience() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-job-ready-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        for (key, value) in [
            ("account_type", "seafarer"),
            ("personal_surname", "Petrov"),
            ("personal_first_name", "Ivan"),
            ("personal_dob", "1988-02-03"),
            ("personal_place_of_birth", "Odesa"),
            ("personal_nationality", "Ukrainian"),
            ("personal_phones", "+380000000000"),
            ("personal_email", "ivan@example.com"),
            ("personal_rank", "Second Officer"),
            ("rank", "Second Officer"),
            ("position", "second_officer"),
            ("stcw_level", "operational"),
            ("preferred_vessel_types", "bulker"),
            ("vessel_category", "bulker"),
            ("personal_nearest_airport", "Odesa (ODS)"),
            ("personal_nearest_intl_airport", "Warsaw (WAW)"),
            ("personal_available_from", "2026-06-01"),
            ("personal_min_salary", "4500"),
            ("personal_home_address", "Odesa, Ukraine"),
        ] {
            db::set_vault_info(&conn, key, value).unwrap();
        }

        let status = seafarer_jobs_readiness_status(&conn, &serde_json::json!({})).unwrap();
        assert!(!status["ok"].as_bool().unwrap());
        assert!(status["experience_missing"].as_bool().unwrap());
        assert!(status["document_missing"].as_array().unwrap().len() > 3);

        assert!(experience_optional_for_rank(Some("Deck Cadet")));
        assert!(experience_optional_for_rank(Some("Ordinary Seaman (OS)")));
        assert!(!experience_optional_for_rank(Some("Second Officer")));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn profile_completeness_ignores_seeded_expiry_dates() {
        let templates = profiles::required_docs_for_profile(
            profiles::StcwLevel::Management,
            "bulker",
            "master",
        );
        assert!(templates.len() > 1);
        let mut docs: Vec<db::DocRecord> = templates
            .iter()
            .map(frameworks::record_from_profile_template)
            .collect();
        assert!(docs.iter().any(|d| d.valid_to.is_some()));

        let (_, missing, pct) = required_profile_status_from_docs(&templates, &docs);
        assert_eq!(missing.len(), templates.len());
        assert_eq!(pct, 0.0);

        let passport = docs
            .iter_mut()
            .find(|d| d.template_id.as_deref() == Some("passport"))
            .expect("master/bulker profile should require a passport");
        passport.file_name = Some("Passport/passport.jpg".to_string());
        passport.sha256 = Some("abc123".to_string());
        passport.file_size = Some(2048);

        let (_, missing, pct) = required_profile_status_from_docs(&templates, &docs);
        assert_eq!(missing.len(), templates.len() - 1);
        let expected = 100.0 / templates.len() as f64;
        assert!((pct - expected).abs() < 0.0001);
    }

    #[test]
    fn rank_change_adds_master_slots_without_deleting_oow_history() {
        let vault_path = std::env::temp_dir().join(format!(
            "skipi-framework-migration-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        db::set_vault_info(&conn, "account_type", "seafarer").unwrap();
        db::set_vault_info(&conn, "stcw_level", "operational").unwrap();
        db::set_vault_info(&conn, "vessel_category", "bulker").unwrap();
        db::set_vault_info(&conn, "position", "second_officer").unwrap();
        db::set_vault_info(&conn, "rank", "Second Officer").unwrap();

        let level = profiles::StcwLevel::from_id("operational").unwrap();
        for t in profiles::required_docs_for_profile(level, "bulker", "second_officer") {
            let rec = frameworks::record_from_profile_template(&t);
            db::insert_doc(&conn, &rec).unwrap();
        }

        let fields = serde_json::json!({
            "rank": "Master",
            "preferred_vessel_types": "bulker",
        });
        let sync = sync_seafarer_document_framework(&conn, &vault_path, &fields).unwrap();
        assert_eq!(sync["metadata_changed"].as_bool(), Some(true));
        assert_eq!(sync["requirements_changed"].as_bool(), Some(true));
        assert!(sync["docs_added"].as_u64().unwrap_or(0) >= 4);
        let added = sync["requirements_added"].as_array().unwrap();
        assert!(added.iter().any(|d| d["id"] == "sso"));

        let active_ids: HashSet<&'static str> = current_required_profile_templates(&conn)
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert!(active_ids.contains("sso"));
        assert!(active_ids.contains("radar_arpa"));
        assert!(active_ids.contains("coc_master"));
        assert!(!active_ids.contains("polar_advanced"));
        assert!(!active_ids.contains("dangerous_hazardous_substances"));
        assert!(!active_ids.contains("flag_coc_endorsement"));
        assert!(!active_ids.contains("flag_seamans_book"));
        assert!(!active_ids.contains("coc_oow"));

        let docs = db::get_all_docs(&conn).unwrap();
        assert!(docs
            .iter()
            .any(|d| d.template_id.as_deref() == Some("polar_advanced")));
        assert!(!docs
            .iter()
            .any(|d| d.template_id.as_deref() == Some("dangerous_hazardous_substances")));
        assert!(docs
            .iter()
            .any(|d| d.template_id.as_deref() == Some("flag_coc_endorsement")));
        assert!(docs
            .iter()
            .any(|d| d.template_id.as_deref() == Some("flag_seamans_book")));
        assert!(docs.iter().any(|d| d.template_id.as_deref() == Some("sso")));
        assert!(docs
            .iter()
            .any(|d| d.template_id.as_deref() == Some("coc_oow")));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }

    #[test]
    fn hidden_conditional_template_is_not_reseeded() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-framework-hidden-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        db::set_vault_info(&conn, "account_type", "seafarer").unwrap();
        db::set_vault_info(&conn, "stcw_level", "operational").unwrap();
        db::set_vault_info(&conn, "vessel_category", "bulker").unwrap();
        db::set_vault_info(&conn, "position", "second_officer").unwrap();
        crate::commands::documents::mark_template_hidden(&conn, "polar_advanced").unwrap();

        ensure_profile_templates(&conn, &vault_path).unwrap();
        let docs = db::get_all_docs(&conn).unwrap();
        assert!(!docs
            .iter()
            .any(|d| d.template_id.as_deref() == Some("polar_advanced")));
        assert!(docs
            .iter()
            .any(|d| d.template_id.as_deref() == Some("flag_coc_endorsement")));
        assert!(docs
            .iter()
            .any(|d| d.template_id.as_deref() == Some("ecdis")));

        drop(conn);
        let _ = std::fs::remove_dir_all(vault_path);
    }
}
