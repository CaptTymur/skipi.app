//! Seafarer profile ⇄ Skipi account import/export (№96(б) Фаза 2,
//! OWNER DECISIONS 2026-08-05 (22) + 2026-08-06 (25)).
//!
//! The private seafarer profile lives on assistant.skipi.app (NOT
//! api.skipi.app — that host serves the public identity claim and must not
//! be touched here). The app talks to it with a scoped bearer token
//! (`skd_…`) obtained once through device pairing: the user copies a
//! short-lived link code from the assistant.skipi.app cabinet, the app
//! exchanges it via POST /api/device-pairing/claim and stores the token in
//! vault_info under `skipi_device_token`. Both directions of profile sync
//! run ONLY on an explicit user action — never automatically.
//!
//! Wire contract (byte-exact with webapp/seafarer_profile.py VAULT_KEYS):
//! GET  /api/seafarer-profile  -> {"profile": {<long key>: <string>, …}}
//! POST /api/seafarer-profile  <- {<long key>: <string>, …} (non-empty only)
//! The 38 long keys below equal the app's own vault_info keys 1:1, so the
//! import path writes vault_info directly and the export path reads the
//! same canonical keys (никаких fallback-алиасов rank/position/…).
//! `personal_photo_path` is a machine-local file path and is NEVER synced.

use rusqlite::Connection;
use serde_json::{json, Map, Value};
use tauri::State;

use crate::db;
use crate::identity;
use crate::AppState;

/// Profile host. Separate from api::PRIMARY_API on purpose: the profile
/// endpoints do not exist on api.skipi.app and the existing api.rs fallback
/// chain must keep its behavior untouched.
pub(crate) const ASSISTANT_API: &str = "https://assistant.skipi.app";

/// vault_info key holding the plaintext bearer token (vault-only storage).
pub(crate) const DEVICE_TOKEN_KEY: &str = "skipi_device_token";
pub(crate) const DEVICE_TOKEN_LABEL_KEY: &str = "skipi_device_token_label";
pub(crate) const DEVICE_TOKEN_LINKED_AT_KEY: &str = "skipi_device_token_linked_at";

/// The canonical 38-key wire contract, order = contract
/// (handoff №96(б) §1; source of truth webapp/seafarer_profile.py).
pub(crate) const PROFILE_WIRE_KEYS: [&str; 38] = [
    "personal_rank",
    "personal_available_from",
    "personal_surname",
    "personal_first_name",
    "personal_middle_name",
    "personal_dob",
    "personal_place_of_birth",
    "personal_nationality",
    "personal_nationality_code",
    "personal_home_address",
    "personal_phones",
    "personal_email",
    "personal_nearest_airport",
    "personal_nearest_intl_airport",
    "personal_passport_no",
    "personal_passport_issue",
    "personal_passport_expiry",
    "personal_seaman_book_no",
    "personal_seaman_book_issue",
    "personal_seaman_book_expiry",
    "personal_height_cm",
    "personal_weight_kg",
    "personal_coverall_size",
    "personal_shoe_size_eu",
    "personal_blood_type",
    "personal_marital_status",
    "personal_children_count",
    "personal_next_of_kin_name",
    "personal_next_of_kin_relation",
    "personal_next_of_kin_phone",
    "personal_visa_countries",
    "personal_min_salary",
    "personal_currency",
    "personal_languages",
    "personal_english_level",
    "preferred_vessel_types",
    "personal_ready_for_offers",
    "personal_preferred_messenger",
];

/// Base URL for assistant.skipi.app with a test/dev override, mirroring the
/// SKIPI_API_BASE pattern of api.rs (single base — no fallback chain here:
/// the profile lives on exactly one host).
pub(crate) fn assistant_api_base() -> String {
    std::env::var("SKIPI_ASSISTANT_API_BASE")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ASSISTANT_API.to_string())
}

// ── vault-side (Connection-level, unit-testable) ─────────────────────────

/// Import/export are seafarer-vault-only (same gate as other seafarer cmds).
pub(crate) fn require_seafarer_vault(conn: &Connection) -> Result<(), String> {
    if db::get_vault_info_value(conn, "account_type").as_deref() != Some("seafarer") {
        return Err(
            "Account profile import/export is available only for seafarer vaults".to_string(),
        );
    }
    Ok(())
}

/// Stored bearer token; honest error when the device was never linked.
pub(crate) fn stored_device_token(conn: &Connection) -> Result<String, String> {
    match db::get_vault_info_value(conn, DEVICE_TOKEN_KEY).filter(|s| !s.trim().is_empty()) {
        Some(token) => Ok(token.trim().to_string()),
        None => Err(
            "This device is not linked to your Skipi account yet. Get a link code at \
             assistant.skipi.app (Linked devices) and link this device first."
                .to_string(),
        ),
    }
}

/// Read the canonical 38 keys from vault_info; only non-empty values are
/// exported; `personal_photo_path` and legacy aliases are never read.
pub(crate) fn export_profile_fields(conn: &Connection) -> Map<String, Value> {
    let mut out = Map::new();
    for key in PROFILE_WIRE_KEYS.iter() {
        if let Some(value) = db::get_vault_info_value(conn, key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                out.insert((*key).to_string(), Value::String(trimmed.to_string()));
            }
        }
    }
    out
}

fn truthy_flag(s: &str) -> bool {
    s.eq_ignore_ascii_case("true") || s == "1" || s.eq_ignore_ascii_case("yes")
}

fn readiness_missing_labels(readiness: &Value) -> Vec<String> {
    readiness
        .get("missing")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("label").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Apply an account profile object to vault_info. Fail-closed: unknown key
/// or non-string value → Err. Empty/absent source values keep the local
/// value untouched. `personal_ready_for_offers` is applied last and honors
/// the app readiness gate (skipped + reported when the profile is not
/// ready). Returns {applied, ready_for_offers_skipped, ready_missing,
/// framework}.
pub(crate) fn apply_profile_import(
    conn: &Connection,
    vault_path: Option<&std::path::Path>,
    profile: &Value,
) -> Result<Value, String> {
    require_seafarer_vault(conn)?;
    let obj = profile
        .as_object()
        .ok_or("Import payload must be a JSON object")?;
    // Fail-closed validation before any write: only the 38 wire keys, only
    // string/null values (in particular personal_photo_path is rejected).
    for (key, value) in obj.iter() {
        if !PROFILE_WIRE_KEYS.contains(&key.as_str()) {
            return Err(format!("unknown_field: {key}"));
        }
        if !(value.is_string() || value.is_null()) {
            return Err(format!("invalid_value: {key} must be a string"));
        }
    }

    let mut applied: Vec<String> = Vec::new();
    let mut ready_request: Option<String> = None;
    for key in PROFILE_WIRE_KEYS.iter() {
        let Some(value) = obj.get(*key) else { continue };
        let incoming = value.as_str().unwrap_or("").trim().to_string();
        if incoming.is_empty() {
            // Empty/null source = "do not touch the local value" (§4.3).
            continue;
        }
        if *key == "personal_ready_for_offers" {
            // Applied last, behind the app readiness gate (§4.1).
            ready_request = Some(incoming);
            continue;
        }
        if db::get_vault_info_value(conn, key).as_deref() != Some(incoming.as_str()) {
            db::set_vault_info(conn, key, &incoming).map_err(|e| e.to_string())?;
            applied.push((*key).to_string());
        }
    }

    let mut ready_skipped = false;
    let mut ready_missing: Vec<String> = Vec::new();
    if let Some(requested) = ready_request {
        let key = "personal_ready_for_offers";
        if truthy_flag(&requested) {
            // Same gate as set_seafarer_personal: profile completeness +
            // documents + experience. Runs AFTER the fact-fields above, so
            // an import that completes the profile can honestly enable it.
            let readiness =
                super::profile::seafarer_jobs_readiness_status(conn, &json!({}))?;
            if readiness.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                if db::get_vault_info_value(conn, key).as_deref() != Some("true") {
                    db::set_vault_info(conn, key, "true").map_err(|e| e.to_string())?;
                    applied.push(key.to_string());
                }
            } else {
                ready_skipped = true;
                ready_missing = readiness_missing_labels(&readiness);
                if ready_missing.is_empty() {
                    ready_missing.push("profile readiness".to_string());
                }
            }
        } else if db::get_vault_info_value(conn, key).as_deref() != Some(requested.as_str()) {
            db::set_vault_info(conn, key, &requested).map_err(|e| e.to_string())?;
            applied.push(key.to_string());
        }
    }

    if !applied.is_empty() {
        let _ = identity::sync_identity_fingerprint(conn);
        let _ = db::log_event(conn, "profile_updated", "vault_info", None, None);
    }
    // Rank / vessel type may have changed → recompute the document
    // framework exactly like set_seafarer_personal does (reads vault_info).
    let framework = if let Some(path) = vault_path {
        super::profile::sync_seafarer_document_framework(conn, path, &json!({}))?
    } else {
        json!({
            "metadata_changed": false,
            "requirements_changed": false,
            "docs_added": 0,
            "requirements_added": [],
            "requirements_removed": [],
        })
    };

    Ok(json!({
        "applied": applied,
        "ready_for_offers_skipped": ready_skipped,
        "ready_missing": ready_missing,
        "framework": framework,
    }))
}

// ── network (base passed in, unit-testable against a local mock) ─────────

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())
}

fn profile_url(base: &str) -> String {
    format!("{}/api/seafarer-profile", base.trim_end_matches('/'))
}

/// Honest user-facing messages for the bearer failure modes of
/// /api/seafarer-profile (401 = guest/unknown token, 403 = revoked/role).
fn profile_auth_error(status: u16, body: &str) -> Option<String> {
    match status {
        401 => Some(
            "Your Skipi account did not accept this device link. Get a new link code at \
             assistant.skipi.app and link this device again."
                .to_string(),
        ),
        403 => {
            if body.contains("token_revoked") {
                Some(
                    "This device link was revoked in your Skipi account. Get a new link \
                     code at assistant.skipi.app and link this device again."
                        .to_string(),
                )
            } else {
                Some(
                    "Your Skipi account refused this request (a seafarer account is \
                     required)."
                        .to_string(),
                )
            }
        }
        _ => None,
    }
}

/// POST {base}/api/device-pairing/claim {code, label} → plaintext token.
pub(crate) fn claim_device_token(
    base: &str,
    client: &reqwest::blocking::Client,
    code: &str,
    label: &str,
) -> Result<String, String> {
    let url = format!("{}/api/device-pairing/claim", base.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&json!({"code": code, "label": label}))
        .send()
        .map_err(|e| format!("assistant.skipi.app network: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    match status.as_u16() {
        403 => Err(
            "Invalid or expired link code. Get a fresh code at assistant.skipi.app \
             (codes live 10 minutes and work once) and try again."
                .to_string(),
        ),
        429 => Err("Too many attempts. Wait a minute and try again.".to_string()),
        code_status if (200..300).contains(&code_status) => {
            let parsed: Value =
                serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;
            let token = parsed
                .get("token")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            if token.is_empty() {
                return Err("assistant.skipi.app returned no device token".to_string());
            }
            Ok(token)
        }
        _ => Err(format!("assistant.skipi.app returned {status}: {body}")),
    }
}

/// GET {base}/api/seafarer-profile with `Authorization: Bearer` → profile
/// object (the inner {"profile": …} value).
pub(crate) fn fetch_account_profile(
    base: &str,
    client: &reqwest::blocking::Client,
    token: &str,
) -> Result<Value, String> {
    let resp = client
        .get(profile_url(base))
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("assistant.skipi.app network: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if let Some(msg) = profile_auth_error(status.as_u16(), &body) {
        return Err(msg);
    }
    if !status.is_success() {
        return Err(format!("assistant.skipi.app returned {status}: {body}"));
    }
    let parsed: Value = serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;
    parsed
        .get("profile")
        .cloned()
        .ok_or_else(|| "assistant.skipi.app response had no profile".to_string())
}

/// POST {base}/api/seafarer-profile with bearer; body = non-empty canonical
/// fields only (server validates fail-closed).
pub(crate) fn push_account_profile(
    base: &str,
    client: &reqwest::blocking::Client,
    token: &str,
    fields: &Map<String, Value>,
) -> Result<(), String> {
    let resp = client
        .post(profile_url(base))
        .bearer_auth(token)
        .json(&Value::Object(fields.clone()))
        .send()
        .map_err(|e| format!("assistant.skipi.app network: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if let Some(msg) = profile_auth_error(status.as_u16(), &body) {
        return Err(msg);
    }
    if status.as_u16() == 400 {
        return Err(format!("Your Skipi account rejected the data: {body}"));
    }
    if !status.is_success() {
        return Err(format!("assistant.skipi.app returned {status}: {body}"));
    }
    Ok(())
}

// ── Tauri commands (explicit user actions only — no background sync) ─────

#[tauri::command]
pub fn link_account_device(
    state: State<AppState>,
    code: String,
    label: String,
) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    require_seafarer_vault(conn)?;
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("Enter the link code from assistant.skipi.app".to_string());
    }
    let label = label.trim().to_string();
    let client = http_client()?;
    let token = claim_device_token(&assistant_api_base(), &client, &code, &label)?;
    db::set_vault_info(conn, DEVICE_TOKEN_KEY, &token).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, DEVICE_TOKEN_LABEL_KEY, &label).map_err(|e| e.to_string())?;
    db::set_vault_info(
        conn,
        DEVICE_TOKEN_LINKED_AT_KEY,
        &chrono::Utc::now().to_rfc3339(),
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"linked": true, "label": label}))
}

#[tauri::command]
pub fn get_account_link_status(state: State<AppState>) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let linked = db::get_vault_info_value(conn, DEVICE_TOKEN_KEY)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    Ok(json!({
        "linked": linked,
        "label": db::get_vault_info_value(conn, DEVICE_TOKEN_LABEL_KEY).unwrap_or_default(),
        "linked_at": db::get_vault_info_value(conn, DEVICE_TOKEN_LINKED_AT_KEY)
            .unwrap_or_default(),
    }))
}

/// Forget the token in THIS vault. Server-side revocation lives in the
/// assistant.skipi.app cabinet (Linked devices → revoke).
#[tauri::command]
pub fn unlink_account_device(state: State<AppState>) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    for key in [
        DEVICE_TOKEN_KEY,
        DEVICE_TOKEN_LABEL_KEY,
        DEVICE_TOKEN_LINKED_AT_KEY,
    ] {
        db::set_vault_info(conn, key, "").map_err(|e| e.to_string())?;
    }
    Ok(json!({"linked": false}))
}

/// GET the account profile and compute the preview diff. Nothing is written:
/// the user confirms the diff first, then apply_account_profile_import runs.
#[tauri::command]
pub fn preview_account_profile_import(state: State<AppState>) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    require_seafarer_vault(conn)?;
    let token = stored_device_token(conn)?;
    let client = http_client()?;
    let remote = fetch_account_profile(&assistant_api_base(), &client, &token)?;
    let remote_obj = remote
        .as_object()
        .ok_or("assistant.skipi.app profile is not an object")?;
    // Keep only the known wire keys (fail-closed against server drift) and
    // list what would change: remote non-empty AND different from local.
    let mut profile = Map::new();
    let mut changes: Vec<Value> = Vec::new();
    for key in PROFILE_WIRE_KEYS.iter() {
        let incoming = remote_obj
            .get(*key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if incoming.is_empty() {
            continue;
        }
        profile.insert((*key).to_string(), Value::String(incoming.clone()));
        let local = db::get_vault_info_value(conn, key).unwrap_or_default();
        if local.trim() != incoming {
            changes.push(json!({"key": key, "local": local, "remote": incoming}));
        }
    }
    Ok(json!({"profile": Value::Object(profile), "changes": changes}))
}

/// Write the user-confirmed profile object into vault_info (38 long keys).
#[tauri::command]
pub fn apply_account_profile_import(
    state: State<AppState>,
    profile: Value,
) -> Result<Value, String> {
    let vault_path = state
        .vault_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    apply_profile_import(conn, vault_path.as_deref(), &profile)
}

/// Show exactly which fields would leave the vault (nothing is sent yet).
#[tauri::command]
pub fn preview_account_profile_export(state: State<AppState>) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    require_seafarer_vault(conn)?;
    stored_device_token(conn)?; // fail early with the honest link-first error
    Ok(json!({"fields": Value::Object(export_profile_fields(conn))}))
}

/// POST the canonical non-empty fields to the account (explicit action).
#[tauri::command]
pub fn send_account_profile(state: State<AppState>) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    require_seafarer_vault(conn)?;
    let token = stored_device_token(conn)?;
    let fields = export_profile_fields(conn);
    if fields.is_empty() {
        return Err("Nothing to send — the seafarer profile in this vault is empty".to_string());
    }
    let client = http_client()?;
    push_account_profile(&assistant_api_base(), &client, &token, &fields)?;
    Ok(json!({"sent": fields.len()}))
}

// ── tests (failing-first RED harness for Фаза 2) ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::mpsc;

    fn test_vault(name: &str) -> (PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!(
            "skipi-accsync-test-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let conn = db::open_db(&dir).unwrap();
        db::set_vault_info(&conn, "account_type", "seafarer").unwrap();
        (dir, conn)
    }

    fn cleanup(dir: PathBuf, conn: Connection) {
        drop(conn);
        let _ = fs::remove_dir_all(dir);
    }

    /// One-shot local HTTP mock: answers a single request with the given
    /// status line + JSON body and hands the raw request text back through
    /// the channel, so tests can assert method, path, headers and body.
    fn mock_server(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut raw: Vec<u8> = Vec::new();
            let mut buf = [0u8; 4096];
            // Read headers first…
            let header_end = loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break raw.len();
                }
                raw.extend_from_slice(&buf[..n]);
                if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos + 4;
                }
            };
            // …then the Content-Length body, if any.
            let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
            let content_length: usize = head
                .lines()
                .find_map(|l| {
                    let l = l.to_ascii_lowercase();
                    l.strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap_or(0))
                })
                .unwrap_or(0);
            while raw.len() < header_end + content_length {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
            }
            let request_text = String::from_utf8_lossy(&raw).to_string();
            let response = format!(
                "{status_line}\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = tx.send(request_text);
        });
        (format!("http://{addr}"), rx)
    }

    fn client() -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[test]
    fn round_trips_all_38_keys_vault_to_wire_to_vault_without_loss() {
        let (dir_a, conn_a) = test_vault("rt-a");
        for key in PROFILE_WIRE_KEYS.iter() {
            let value = if *key == "personal_ready_for_offers" {
                "false".to_string()
            } else {
                format!("v_{key}")
            };
            db::set_vault_info(&conn_a, key, &value).unwrap();
        }
        let wire = export_profile_fields(&conn_a);
        assert_eq!(wire.len(), 38, "export must carry exactly the 38 keys");
        for key in PROFILE_WIRE_KEYS.iter() {
            assert!(wire.contains_key(*key), "export missing key {key}");
        }

        let (dir_b, conn_b) = test_vault("rt-b");
        let outcome =
            apply_profile_import(&conn_b, None, &Value::Object(wire.clone())).unwrap();
        for key in PROFILE_WIRE_KEYS.iter() {
            let expected = wire.get(*key).and_then(|v| v.as_str()).unwrap().to_string();
            assert_eq!(
                db::get_vault_info_value(&conn_b, key),
                Some(expected),
                "round-trip lost or renamed key {key}"
            );
        }
        assert_eq!(
            outcome.get("applied").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(38),
            "all 38 keys must be reported as applied"
        );
        cleanup(dir_a, conn_a);
        cleanup(dir_b, conn_b);
    }

    #[test]
    fn export_reads_canonical_keys_not_legacy_aliases() {
        let (dir, conn) = test_vault("aliases");
        // Legacy onboarding heuristics only — no canonical keys set.
        db::set_vault_info(&conn, "rank", "Master (alias)").unwrap();
        db::set_vault_info(&conn, "position", "master").unwrap();
        db::set_vault_info(&conn, "vessel_category", "dry_cargo").unwrap();
        db::set_vault_info(&conn, "personal_email", "s@example.com").unwrap();
        let wire = export_profile_fields(&conn);
        assert_eq!(
            wire.get("personal_email").and_then(|v| v.as_str()),
            Some("s@example.com"),
            "canonical non-empty field must be exported"
        );
        assert!(
            !wire.contains_key("personal_rank"),
            "alias `rank` must NOT leak into personal_rank"
        );
        assert!(
            !wire.contains_key("preferred_vessel_types"),
            "alias `vessel_category` must NOT leak into preferred_vessel_types"
        );
        cleanup(dir, conn);
    }

    #[test]
    fn photo_never_leaves_and_never_enters_the_vault() {
        let (dir, conn) = test_vault("photo");
        db::set_vault_info(&conn, "personal_photo_path", "_profile/photo.jpg").unwrap();
        db::set_vault_info(&conn, "personal_surname", "Rudov").unwrap();
        let wire = export_profile_fields(&conn);
        assert!(
            !wire.contains_key("personal_photo_path"),
            "photo path must never be exported"
        );
        assert!(wire.contains_key("personal_surname"));

        let err = apply_profile_import(
            &conn,
            None,
            &json!({"personal_photo_path": "/tmp/evil.jpg"}),
        )
        .unwrap_err();
        assert!(
            err.contains("unknown_field"),
            "photo import must be rejected fail-closed, got: {err}"
        );
        cleanup(dir, conn);
    }

    #[test]
    fn unknown_wire_field_is_rejected_fail_closed() {
        let (dir, conn) = test_vault("unknown");
        let err = apply_profile_import(&conn, None, &json!({"personal_hacked": "x"}))
            .unwrap_err();
        assert!(err.contains("unknown_field"), "got: {err}");
        cleanup(dir, conn);
    }

    #[test]
    fn empty_or_null_source_fields_keep_local_values() {
        let (dir, conn) = test_vault("empty-keeps");
        db::set_vault_info(&conn, "personal_surname", "Rudov").unwrap();
        let outcome = apply_profile_import(
            &conn,
            None,
            &json!({
                "personal_surname": "",
                "personal_first_name": null,
                "personal_email": "x@example.com"
            }),
        )
        .unwrap();
        assert_eq!(
            db::get_vault_info_value(&conn, "personal_surname"),
            Some("Rudov".to_string()),
            "empty source value must not erase the local one"
        );
        assert!(
            db::get_vault_info_value(&conn, "personal_first_name")
                .unwrap_or_default()
                .is_empty(),
            "null source value must not create data"
        );
        assert_eq!(
            db::get_vault_info_value(&conn, "personal_email"),
            Some("x@example.com".to_string())
        );
        let applied: Vec<String> = outcome
            .get("applied")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(applied, vec!["personal_email".to_string()]);
        cleanup(dir, conn);
    }

    #[test]
    fn ready_for_offers_gate_is_honored_on_import() {
        let (dir, conn) = test_vault("ready-gate");
        // Profile deliberately incomplete → the app gate must veto the flag.
        let outcome = apply_profile_import(
            &conn,
            None,
            &json!({"personal_ready_for_offers": "true"}),
        )
        .unwrap();
        assert_ne!(
            db::get_vault_info_value(&conn, "personal_ready_for_offers").as_deref(),
            Some("true"),
            "ready_for_offers must NOT be enabled on an incomplete profile"
        );
        assert_eq!(
            outcome.get("ready_for_offers_skipped").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(
            outcome
                .get("ready_missing")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false),
            "the user must be told what is missing"
        );
        cleanup(dir, conn);
    }

    #[test]
    fn non_seafarer_vault_is_refused() {
        let (dir, conn) = test_vault("vessel");
        db::set_vault_info(&conn, "account_type", "vessel").unwrap();
        let gate = require_seafarer_vault(&conn).unwrap_err();
        assert!(gate.contains("seafarer"), "got: {gate}");
        let err = apply_profile_import(&conn, None, &json!({"personal_email": "x@y"}))
            .unwrap_err();
        assert!(err.contains("seafarer"), "got: {err}");
        cleanup(dir, conn);
    }

    #[test]
    fn missing_token_gives_honest_link_first_error() {
        let (dir, conn) = test_vault("no-token");
        let err = stored_device_token(&conn).unwrap_err();
        assert!(
            err.to_lowercase().contains("not linked"),
            "error must tell the user to link the device first, got: {err}"
        );
        cleanup(dir, conn);
    }

    #[test]
    fn claim_posts_code_and_label_and_returns_token() {
        let (base, rx) = mock_server(
            "HTTP/1.1 200 OK",
            "{\"token\": \"skd_test_token_1\", \"scope\": \"seafarer-profile\"}",
        );
        let token = claim_device_token(&base, &client(), "ABCD2345", "Test device").unwrap();
        assert_eq!(token, "skd_test_token_1");
        let req = rx.recv().unwrap();
        assert!(req.starts_with("POST /api/device-pairing/claim"), "got: {req}");
        assert!(req.contains("ABCD2345"), "claim body must carry the code");
        assert!(req.contains("Test device"), "claim body must carry the label");
    }

    #[test]
    fn claim_invalid_code_maps_to_honest_error() {
        let (base, _rx) = mock_server(
            "HTTP/1.1 403 Forbidden",
            "{\"error\": \"invalid_code\"}",
        );
        let err = claim_device_token(&base, &client(), "WRONGCOD", "Test device").unwrap_err();
        assert!(
            err.to_lowercase().contains("link code"),
            "got: {err}"
        );
    }

    #[test]
    fn fetch_profile_sends_bearer_and_unwraps_profile_object() {
        let (base, rx) = mock_server(
            "HTTP/1.1 200 OK",
            "{\"profile\": {\"personal_rank\": \"Master\"}}",
        );
        let profile = fetch_account_profile(&base, &client(), "skd_test_token_1").unwrap();
        assert_eq!(
            profile.get("personal_rank").and_then(|v| v.as_str()),
            Some("Master")
        );
        let req = rx.recv().unwrap();
        assert!(req.starts_with("GET /api/seafarer-profile"), "got: {req}");
        assert!(
            req.contains("Bearer skd_test_token_1"),
            "GET must carry the bearer token, got: {req}"
        );
    }

    #[test]
    fn push_sends_only_nonempty_canonical_fields_with_bearer() {
        let (dir, conn) = test_vault("push");
        db::set_vault_info(&conn, "personal_rank", "Master").unwrap();
        db::set_vault_info(&conn, "personal_email", "").unwrap(); // empty → omit
        db::set_vault_info(&conn, "personal_photo_path", "_profile/photo.jpg").unwrap();
        let fields = export_profile_fields(&conn);
        let (base, rx) = mock_server("HTTP/1.1 200 OK", "{\"ok\": true}");
        push_account_profile(&base, &client(), "skd_test_token_1", &fields).unwrap();
        let req = rx.recv().unwrap();
        assert!(req.starts_with("POST /api/seafarer-profile"), "got: {req}");
        assert!(req.contains("Bearer skd_test_token_1"));
        assert!(req.contains("personal_rank"));
        assert!(!req.contains("personal_photo_path"), "photo must not be sent");
        assert!(!req.contains("personal_email"), "empty field must be omitted");
        cleanup(dir, conn);
    }

    #[test]
    fn push_maps_server_rejection_to_honest_error() {
        let (base, _rx) = mock_server(
            "HTTP/1.1 400 Bad Request",
            "{\"error\": \"unknown_field:personal_x\"}",
        );
        let err = push_account_profile(
            &base,
            &client(),
            "skd_test_token_1",
            &Map::new(),
        )
        .unwrap_err();
        assert!(err.contains("unknown_field"), "got: {err}");
    }
}
