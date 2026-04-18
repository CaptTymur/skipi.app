use crate::db::{self, VaultInfo};
use crate::{frameworks, identity, profiles, demo, AppState};
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn get_profile_taxonomy() -> serde_json::Value {
    let levels: Vec<serde_json::Value> = profiles::StcwLevel::all().iter().map(|l| {
        serde_json::json!({
            "id": l.id(),
            "label": l.label(),
        })
    }).collect();

    let vessel_nodes: Vec<serde_json::Value> = profiles::vessel_tree().iter().map(|v| {
        serde_json::json!({
            "id": v.id,
            "label": v.label,
            "parent": v.parent,
            "is_leaf": v.is_leaf,
        })
    }).collect();

    let pos: Vec<serde_json::Value> = profiles::positions().iter().map(|p| {
        serde_json::json!({
            "id": p.id,
            "label": p.label,
            "level": p.level.id(),
            "dept": p.dept,
        })
    }).collect();

    serde_json::json!({
        "levels": levels,
        "vessel_tree": vessel_nodes,
        "positions": pos,
    })
}

#[tauri::command]
pub fn get_optional_categories() -> Vec<String> {
    profiles::optional_categories().into_iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
pub fn get_required_docs(level_id: String, vessel_id: String, position_id: String) -> Result<Vec<serde_json::Value>, String> {
    let level = profiles::StcwLevel::from_id(&level_id).ok_or("Unknown STCW level")?;
    let templates = profiles::required_docs_for_profile(level, &vessel_id, &position_id);
    Ok(templates.iter().map(|t| serde_json::json!({
        "id": t.id,
        "title": t.title,
        "category": t.category,
        "regulatory_basis": t.regulatory_basis,
        "has_expiry": t.has_expiry,
        "typical_years": t.typical_years,
        "notes": t.notes,
    })).collect())
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
) -> Result<VaultInfo, String> {
    let vault_path = PathBuf::from(&path);
    fs::create_dir_all(&vault_path).map_err(|e| e.to_string())?;

    let conn = db::open_db(&vault_path).map_err(|e| e.to_string())?;
    crate::reset_vault_content(&conn);
    identity::ensure_vault_identity(&conn, &vault_path)?;

    db::set_vault_info(&conn, "account_type", "seafarer").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "name", &name).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "stcw_level", &stcw_level).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "vessel_category", &vessel_category).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "position", &position).map_err(|e| e.to_string())?;

    let rank_label: Option<String> = if let Some(lbl) = position_label.as_ref().filter(|s| !s.trim().is_empty()) {
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
    let vessel_label: Option<String> = profiles::vessel_tree().into_iter()
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
        let _ = db::log_event(&conn, "doc_added", "document", Some(&rec_id), Some(&payload));
    }

    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;
    crate::save_last_vault(&path);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
    Ok(info)
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
) -> Result<(), String> {
    let g = |k: &str| db::get_vault_info_value(conn, k);
    if g("account_type").as_deref() != Some("seafarer") {
        return Ok(());
    }
    let level_id = match g("stcw_level") {
        Some(v) if !v.is_empty() => v,
        _ => return Ok(()),
    };
    let vessel_category = g("vessel_category").unwrap_or_default();
    let position = g("position").unwrap_or_default();

    let level = match profiles::StcwLevel::from_id(&level_id) {
        Some(l) => l,
        None => return Ok(()),
    };
    let templates = profiles::required_docs_for_profile(level, &vessel_category, &position);

    // Collect existing template_ids in one query to avoid N selects.
    let existing: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT template_id FROM documents WHERE template_id IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

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
        db::insert_doc(conn, &rec).map_err(|e| e.to_string())?;
        let _ = db::log_event(conn, "doc_seeded", "document", Some(&rec_id), Some(&payload));
    }
    Ok(())
}

#[tauri::command]
pub fn get_seafarer_frameworks(
    level_id: String,
    vessel_id: String,
    position_id: String,
) -> Result<Vec<profiles::Framework>, String> {
    let level = profiles::StcwLevel::from_id(&level_id).ok_or("Unknown STCW level")?;
    Ok(profiles::applicable_frameworks_for_seafarer(level, &vessel_id, &position_id))
}

#[tauri::command]
pub fn get_vessel_frameworks(
    vessel_id: String,
    size_id: String,
    trade_id: String,
) -> Result<Vec<profiles::Framework>, String> {
    let size = profiles::VesselSize::from_id(&size_id).ok_or("Unknown vessel size band")?;
    let trade = profiles::TradeArea::from_id(&trade_id).ok_or("Unknown trade area")?;
    Ok(profiles::applicable_frameworks_for_vessel(&vessel_id, size, trade))
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
    Ok(templates.iter().map(|t| serde_json::json!({
        "id": t.id,
        "title": t.title,
        "category": t.category,
        "regulatory_basis": t.regulatory_basis,
        "has_expiry": t.has_expiry,
        "typical_years": t.typical_years,
        "notes": t.notes,
    })).collect())
}

#[tauri::command]
pub fn get_vessel_taxonomy() -> serde_json::Value {
    let vessel_nodes: Vec<serde_json::Value> = profiles::vessel_tree().iter().map(|v| {
        serde_json::json!({
            "id": v.id,
            "label": v.label,
            "parent": v.parent,
            "is_leaf": v.is_leaf,
        })
    }).collect();

    let sizes: Vec<serde_json::Value> = profiles::VesselSize::all().iter().map(|s| {
        serde_json::json!({ "id": s.id(), "label": s.label() })
    }).collect();

    let trades: Vec<serde_json::Value> = profiles::TradeArea::all().iter().map(|t| {
        serde_json::json!({ "id": t.id(), "label": t.label() })
    }).collect();

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

    let vessel_label: Option<String> = profiles::vessel_tree().into_iter()
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
        let _ = db::log_event(&conn, "doc_added", "document", Some(&rec_id), Some(&payload));
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

/// Auto-create a demo vault in ~/Documents/Skipi Demo (no folder picker).
#[tauri::command]
pub fn create_demo_vault_auto(state: State<AppState>) -> Result<VaultInfo, String> {
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let vault_path = base.join("Skipi Demo");
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

    let g = |k: &str| db::get_vault_info_value(conn, k);
    let age_bucket = compute_age_bucket(g("personal_dob").as_deref());
    let years_exp = compute_years_experience(conn);

    Ok(serde_json::json!({
        "matchable_version": MATCHABLE_VERSION,
        "user_id": g("user_id"),
        "identity_pubkey": g("identity_pubkey"),
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

// ========== SEAFARER PERSONAL DETAILS ============================

#[tauri::command]
pub fn get_seafarer_personal(state: State<AppState>) -> Result<serde_json::Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let g = |k: &str| db::get_vault_info_value(conn, k);
    Ok(serde_json::json!({
        "rank": g("personal_rank"),
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
        "preferred_vessel_types": g("preferred_vessel_types"),
        "ready_for_offers": g("personal_ready_for_offers"),
        "preferred_messenger": g("personal_preferred_messenger"),
    }))
}

#[tauri::command]
pub fn set_seafarer_personal(
    state: State<AppState>,
    fields: serde_json::Value,
) -> Result<(), String> {
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
        let _ = db::log_event(conn, "profile_updated", "vault_info", None, None);
    }
    Ok(())
}

// ========== PROFILE PHOTO ========================================

#[tauri::command]
pub fn upload_profile_photo(
    state: State<AppState>,
    source_path: String,
) -> Result<String, String> {
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

#[tauri::command]
pub fn get_profile_status(state: State<AppState>) -> Result<serde_json::Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;

    let stcw_level = db::get_vault_info_value(conn, "stcw_level");
    let vessel_category = db::get_vault_info_value(conn, "vessel_category");
    let position = db::get_vault_info_value(conn, "position");

    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;

    let (required, missing, completeness): (Vec<serde_json::Value>, Vec<String>, f64) = if let (Some(l), Some(v), Some(p)) = (stcw_level.clone(), vessel_category.clone(), position.clone()) {
        if let Some(level) = profiles::StcwLevel::from_id(&l) {
            let tpls = profiles::required_docs_for_profile(level, &v, &p);
            let have: std::collections::HashSet<String> = docs.iter().filter_map(|d| {
                let filled = d.file_name.is_some()
                    || (d.doc_number.as_ref().map(|s| !s.is_empty()).unwrap_or(false))
                    || (d.valid_to.as_ref().map(|s| !s.is_empty()).unwrap_or(false));
                if filled { d.template_id.clone() } else { None }
            }).collect();

            let total = tpls.len() as f64;
            let mut missing_ids: Vec<String> = Vec::new();
            let required_json: Vec<serde_json::Value> = tpls.iter().map(|t| {
                let has = have.contains(t.id);
                if !has { missing_ids.push(t.id.to_string()); }
                serde_json::json!({
                    "id": t.id,
                    "title": t.title,
                    "category": t.category,
                    "regulatory_basis": t.regulatory_basis,
                    "has": has,
                })
            }).collect();
            let pct = if total > 0.0 { (total - missing_ids.len() as f64) / total * 100.0 } else { 0.0 };
            (required_json, missing_ids, pct)
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
        "required": required,
        "missing_ids": missing,
        "completeness_pct": completeness,
    }))
}
