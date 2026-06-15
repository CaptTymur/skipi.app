use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgencyMailingAgency {
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgencyMailingNationalityDb {
    pub code: String,
    pub label: String,
    #[serde(default)]
    pub agencies: Vec<AgencyMailingAgency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgencyMailingDbFile {
    pub version: u32,
    pub updated_at: String,
    pub nationalities: Vec<AgencyMailingNationalityDb>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgencyMailingDbResult {
    pub db_path: String,
    pub nationality_code: String,
    pub nationality_label: String,
    pub profile_pct: u32,
    pub total_addresses: usize,
    pub allowed_addresses: usize,
    pub locked_addresses: usize,
    pub agencies: Vec<AgencyMailingAgency>,
}

fn db_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("skipi");
    fs::create_dir_all(&dir).map_err(|e| format!("Create config dir failed: {e}"))?;
    Ok(dir.join("agency_mailing_db.json"))
}

fn template_db() -> AgencyMailingDbFile {
    const SEED_JSON: &str = include_str!("../../resources/agency_mailing_db.seed.json");
    serde_json::from_str(SEED_JSON).unwrap_or_else(|_| AgencyMailingDbFile {
        version: 1,
        updated_at: Utc::now().to_rfc3339(),
        nationalities: vec![
            nationality("UA", "Ukraine"),
            nationality("RU", "Russia"),
            nationality("IN", "India"),
            nationality("PH", "Philippines"),
            nationality("ID", "Indonesia"),
        ],
    })
}

fn nationality(code: &str, label: &str) -> AgencyMailingNationalityDb {
    AgencyMailingNationalityDb {
        code: code.to_string(),
        label: label.to_string(),
        agencies: vec![],
    }
}

fn ensure_db_file() -> Result<(PathBuf, AgencyMailingDbFile), String> {
    let path = db_path()?;
    let seed_db = template_db();
    if !path.exists() {
        let text = serde_json::to_string_pretty(&seed_db)
            .map_err(|e| format!("Serialize agency database template failed: {e}"))?;
        fs::write(&path, text)
            .map_err(|e| format!("Write agency database template failed: {e}"))?;
        return Ok((path, seed_db));
    }

    let text =
        fs::read_to_string(&path).map_err(|e| format!("Read agency database failed: {e}"))?;
    let mut db: AgencyMailingDbFile =
        serde_json::from_str(&text).map_err(|e| format!("Parse agency database failed: {e}"))?;
    if should_upgrade_db(&db, &seed_db) {
        let mut changed = merge_seed_db(&mut db, &seed_db);
        if seed_db.version > db.version {
            db.version = seed_db.version;
            changed = true;
        }
        if seed_db.updated_at > db.updated_at {
            db.updated_at = seed_db.updated_at.clone();
            changed = true;
        }
        if changed {
            let text = serde_json::to_string_pretty(&db)
                .map_err(|e| format!("Serialize upgraded agency database failed: {e}"))?;
            fs::write(&path, text)
                .map_err(|e| format!("Write upgraded agency database failed: {e}"))?;
        }
    }
    Ok((path, db))
}

fn should_upgrade_db(existing: &AgencyMailingDbFile, seed: &AgencyMailingDbFile) -> bool {
    seed.version > existing.version
        || (seed.version == existing.version && seed.updated_at > existing.updated_at)
}

fn merge_seed_db(existing: &mut AgencyMailingDbFile, seed: &AgencyMailingDbFile) -> bool {
    let mut changed = false;
    for seed_bucket in &seed.nationalities {
        if let Some(bucket) = existing
            .nationalities
            .iter_mut()
            .find(|b| b.code.eq_ignore_ascii_case(&seed_bucket.code))
        {
            if bucket.label.trim().is_empty() && !seed_bucket.label.trim().is_empty() {
                bucket.label = seed_bucket.label.clone();
                changed = true;
            }
            let mut seen: HashSet<String> = bucket
                .agencies
                .iter()
                .map(|a| a.email.trim().to_lowercase())
                .filter(|email| !email.is_empty())
                .collect();
            for agency in &seed_bucket.agencies {
                let email = agency.email.trim();
                if !valid_email(email) {
                    continue;
                }
                if seen.insert(email.to_lowercase()) {
                    bucket.agencies.push(agency.clone());
                    changed = true;
                }
            }
        } else {
            existing.nationalities.push(seed_bucket.clone());
            changed = true;
        }
    }
    changed
}

fn normalize_nationality(input: Option<String>) -> Option<(&'static str, &'static str)> {
    let raw = input.unwrap_or_default().trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }
    let compact = raw.replace([' ', '-', '_'], "");
    match compact.as_str() {
        "ua" | "ukr" | "ukraine" | "ukrainian" | "украина" | "україна" | "украинец"
        | "українець" => Some(("UA", "Ukraine")),
        "ru" | "rus" | "russia" | "russian" | "россия" | "росія" | "русский" => {
            Some(("RU", "Russia"))
        }
        "in" | "ind" | "india" | "indian" | "индия" => Some(("IN", "India")),
        "ph" | "phl" | "philippines" | "philippine" | "filipino" | "filipina" | "филиппины"
        | "філіппіни" => Some(("PH", "Philippines")),
        "id" | "idn" | "indonesia" | "indonesian" | "индонезия" | "індонезія" => {
            Some(("ID", "Indonesia"))
        }
        _ => None,
    }
}

fn valid_email(email: &str) -> bool {
    let email = email.trim();
    if email.is_empty() || email.contains(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn unique_valid_agencies(agencies: &[AgencyMailingAgency]) -> Vec<AgencyMailingAgency> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for agency in agencies {
        let email = agency.email.trim();
        if !valid_email(email) {
            continue;
        }
        let key = email.to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let mut item = agency.clone();
        item.email = email.to_string();
        out.push(item);
    }
    out
}

#[tauri::command]
pub fn agency_mailing_database_path() -> Result<String, String> {
    let (path, _) = ensure_db_file()?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn fetch_agency_mailing_database(
    nationality: Option<String>,
    profile_pct: Option<u32>,
) -> Result<AgencyMailingDbResult, String> {
    let (path, db) = ensure_db_file()?;
    let normalized = normalize_nationality(nationality);
    let pct = profile_pct.unwrap_or(0).min(100);

    let Some((code, fallback_label)) = normalized else {
        return Ok(AgencyMailingDbResult {
            db_path: path.to_string_lossy().to_string(),
            nationality_code: String::new(),
            nationality_label: "Unknown nationality".to_string(),
            profile_pct: pct,
            total_addresses: 0,
            allowed_addresses: 0,
            locked_addresses: 0,
            agencies: vec![],
        });
    };

    let bucket = db
        .nationalities
        .iter()
        .find(|n| n.code.eq_ignore_ascii_case(code));
    let agencies = bucket
        .map(|b| unique_valid_agencies(&b.agencies))
        .unwrap_or_default();
    let total = agencies.len();
    let allowed = if pct >= 100 {
        total
    } else {
        total.saturating_mul(pct as usize) / 100
    };
    let label = bucket
        .map(|b| b.label.clone())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| fallback_label.to_string());
    Ok(AgencyMailingDbResult {
        db_path: path.to_string_lossy().to_string(),
        nationality_code: code.to_string(),
        nationality_label: label,
        profile_pct: pct,
        total_addresses: total,
        allowed_addresses: allowed,
        locked_addresses: total.saturating_sub(allowed),
        agencies: agencies.into_iter().take(allowed).collect(),
    })
}
