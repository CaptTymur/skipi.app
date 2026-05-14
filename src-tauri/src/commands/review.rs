// Review identity material. Kept deliberately separate from
// `_identity/sk.bin` (the crewing-facing vault identity) so a hostile
// crewing party cannot cross-link a seafarer's apply/messaging activity
// with their vessel reviews. The raw review_pubkey is sent only with the
// review request; the server stores a secret-derived reviewer_hash.

use crate::{db, AppState};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

fn review_sk_path(vault: &Path) -> PathBuf {
    vault.join("_identity").join("review_sk.bin")
}

fn normalize_imo(imo: &str) -> Result<String, String> {
    let digits: String = imo.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 7 {
        return Err("IMO number is required and must contain exactly 7 digits".to_string());
    }
    Ok(digits)
}

fn is_locked(lock_until: Option<&str>) -> bool {
    let Some(lock_until) = lock_until else {
        return false;
    };
    DateTime::parse_from_rfc3339(lock_until)
        .map(|dt| dt.with_timezone(&Utc) > Utc::now())
        .unwrap_or(false)
}

fn ensure_review_keypair(vault: &Path) -> Result<SigningKey, String> {
    let dir = vault.join("_identity");
    fs::create_dir_all(&dir).map_err(|e| format!("identity dir: {}", e))?;
    let sk_path = review_sk_path(vault);
    if sk_path.exists() {
        let bytes = fs::read(&sk_path).map_err(|e| format!("read review_sk: {}", e))?;
        if bytes.len() != 32 {
            return Err(format!(
                "review_sk size {} != 32 — refusing to overwrite",
                bytes.len()
            ));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        Ok(SigningKey::from_bytes(&arr))
    } else {
        let mut csprng = OsRng;
        let sk = SigningKey::generate(&mut csprng);
        let tmp = sk_path.with_extension("tmp");
        fs::write(&tmp, sk.to_bytes()).map_err(|e| format!("write review_sk tmp: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, &sk_path).map_err(|e| format!("rename review_sk: {}", e))?;
        Ok(sk)
    }
}

#[tauri::command]
pub fn get_or_create_review_pubkey(state: State<AppState>) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let sk = ensure_review_keypair(vault_path)?;
    let pk = sk.verifying_key().to_bytes();
    Ok(base64::engine::general_purpose::STANDARD.encode(pk))
}

#[tauri::command]
pub fn compute_local_experience_hash(
    state: State<AppState>,
    work_history_id: String,
) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let sk = ensure_review_keypair(vault_path)?;
    let pk = sk.verifying_key().to_bytes();
    let mut hasher = Sha256::new();
    hasher.update(pk);
    hasher.update(b"|");
    hasher.update(work_history_id.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

#[tauri::command]
pub fn record_local_vessel_review(
    state: State<AppState>,
    work_history_id: String,
    vessel_imo: String,
    vessel_name: Option<String>,
    overall_rating: f64,
    summary_json: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !overall_rating.is_finite() || !(1.0..=5.0).contains(&overall_rating) {
        return Err("Overall rating must be between 1 and 5".to_string());
    }
    let imo = normalize_imo(&vessel_imo)?;
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;

    let entry_imo: Option<String> = conn
        .query_row(
            "SELECT imo FROM work_history WHERE id = ?1",
            rusqlite::params![work_history_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let entry_imo = entry_imo.ok_or("Work history entry not found")?;
    if normalize_imo(&entry_imo)? != imo {
        return Err("Review IMO does not match the Sea Service entry".to_string());
    }

    if let Some(existing) =
        db::get_vessel_review_receipt(conn, &work_history_id).map_err(|e| e.to_string())?
    {
        let lock_until = existing.get("lock_until").and_then(|v| v.as_str());
        if is_locked(lock_until) {
            return Err(format!(
                "This vessel review is locked until {}",
                lock_until.unwrap_or("the lock date")
            ));
        }
    }

    let now = Utc::now();
    let submitted_at = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let lock_until = (now + Duration::days(30))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let summary_text = serde_json::to_string(&summary_json).map_err(|e| e.to_string())?;
    let receipt_id = uuid::Uuid::new_v4().to_string();

    db::upsert_vessel_review_receipt(
        conn,
        &receipt_id,
        &work_history_id,
        &imo,
        vessel_name.as_deref(),
        overall_rating,
        &summary_text,
        &submitted_at,
        &lock_until,
    )
    .map_err(|e| e.to_string())?;

    db::get_vessel_review_receipt(conn, &work_history_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Review receipt was not saved".to_string())
}
