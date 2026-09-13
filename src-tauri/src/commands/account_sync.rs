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
    #[cfg(debug_assertions)]
    {
        let candidate = std::env::var("SKIPI_ASSISTANT_API_BASE")
            .ok()
            .or_else(|| option_env!("SKIPI_SYNC_TEST_BASE").map(str::to_string));
        if let Some(base) = candidate {
            if let Ok(url) = reqwest::Url::parse(base.trim()) {
                if url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "10.0.2.2"))
                    && url.port().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none()
                {
                    return base.trim().trim_end_matches('/').to_string();
                }
            }
        }
    }
    ASSISTANT_API.to_string()
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
            let readiness = super::profile::seafarer_jobs_readiness_status(conn, &json!({}))?;
            if readiness
                .get("ok")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
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
        let outcome = apply_profile_import(&conn_b, None, &Value::Object(wire.clone())).unwrap();
        for key in PROFILE_WIRE_KEYS.iter() {
            let expected = wire.get(*key).and_then(|v| v.as_str()).unwrap().to_string();
            assert_eq!(
                db::get_vault_info_value(&conn_b, key),
                Some(expected),
                "round-trip lost or renamed key {key}"
            );
        }
        assert_eq!(
            outcome
                .get("applied")
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
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
        let err = apply_profile_import(&conn, None, &json!({"personal_hacked": "x"})).unwrap_err();
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
        let outcome =
            apply_profile_import(&conn, None, &json!({"personal_ready_for_offers": "true"}))
                .unwrap();
        assert_ne!(
            db::get_vault_info_value(&conn, "personal_ready_for_offers").as_deref(),
            Some("true"),
            "ready_for_offers must NOT be enabled on an incomplete profile"
        );
        assert_eq!(
            outcome
                .get("ready_for_offers_skipped")
                .and_then(|v| v.as_bool()),
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
        let err = apply_profile_import(&conn, None, &json!({"personal_email": "x@y"})).unwrap_err();
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
        assert!(
            req.starts_with("POST /api/device-pairing/claim"),
            "got: {req}"
        );
        assert!(req.contains("ABCD2345"), "claim body must carry the code");
        assert!(
            req.contains("Test device"),
            "claim body must carry the label"
        );
    }

    #[test]
    fn claim_invalid_code_maps_to_honest_error() {
        let (base, _rx) = mock_server("HTTP/1.1 403 Forbidden", "{\"error\": \"invalid_code\"}");
        let err = claim_device_token(&base, &client(), "WRONGCOD", "Test device").unwrap_err();
        assert!(err.to_lowercase().contains("link code"), "got: {err}");
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
        assert!(
            !req.contains("personal_photo_path"),
            "photo must not be sent"
        );
        assert!(
            !req.contains("personal_email"),
            "empty field must be omitted"
        );
        cleanup(dir, conn);
    }

    #[test]
    fn push_maps_server_rejection_to_honest_error() {
        let (base, _rx) = mock_server(
            "HTTP/1.1 400 Bad Request",
            "{\"error\": \"unknown_field:personal_x\"}",
        );
        let err =
            push_account_profile(&base, &client(), "skd_test_token_1", &Map::new()).unwrap_err();
        assert!(err.contains("unknown_field"), "got: {err}");
    }
}

// Complete account-vault synchronization. The legacy manual 38-field API above
// retains its old semantics; this protocol has explicit clears and server CAS.
pub mod vault_sync {
    use super::*;
    use rusqlite::params;
    use sha2::{Digest, Sha256};
    use std::{
        collections::{BTreeMap, BTreeSet},
        fs,
        io::Read,
        path::{Path, PathBuf},
        sync::atomic::Ordering,
    };
    use tauri::Manager;

    const MAX_BLOB: usize = 25 * 1024 * 1024;
    const MAX_JSON: usize = 35 * 1024 * 1024;
    const EXTRA_PROFILE: [&str; 8] = [
        "rank_dept_code",
        "rank_code",
        "rank_dept_free",
        "rank_free_text",
        "stcw_level",
        "vessel_category",
        "position",
        "position_custom",
    ];
    const KINDS: [&str; 5] = [
        "profile",
        "photo",
        "experience",
        "experience_file",
        "document",
    ];
    fn err(e: impl std::fmt::Display) -> String {
        e.to_string()
    }
    fn digest(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }
    fn value_hash(v: &Value) -> String {
        digest(v.to_string().as_bytes())
    }
    fn uid() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    pub fn edit_revision(conn: &Connection, kind: &str, id: &str) -> Result<String, String> {
        let value = match kind {
            "document" => db::get_all_docs(conn)
                .map_err(err)?
                .iter()
                .find(|d| d.id == id)
                .map(serde_json::to_value)
                .transpose()
                .map_err(err)?
                .unwrap_or(Value::Null),
            "experience" => {
                json!({"entry":db::get_work_history(conn).map_err(err)?.into_iter().find(|e|text(e,"id")==id),"files":db::get_work_files(conn,id).map_err(err)?})
            }
            "experience_file" => {
                serde_json::to_value(db::get_work_file(conn, id).map_err(err)?).map_err(err)?
            }
            "profile" | "photo" => {
                let mut m = Map::new();
                for k in PROFILE_WIRE_KEYS
                    .iter()
                    .chain(EXTRA_PROFILE.iter())
                    .chain(["personal_photo_path", "sync_photo_edit_counter"].iter())
                {
                    m.insert(
                        (*k).into(),
                        db::get_vault_info_value(conn, k)
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    );
                }
                Value::Object(m)
            }
            _ => return Err("Unknown edited entity".into()),
        };
        Ok(value_hash(&value))
    }
    pub fn require_edit_revision(
        conn: &Connection,
        kind: &str,
        id: &str,
        expected: Option<&Value>,
    ) -> Result<(), String> {
        if expected.is_none()
            && db::get_vault_info_value(conn, "sync_enabled").as_deref() != Some("1")
        {
            return Ok(());
        }
        if expected.and_then(Value::as_str) != Some(edit_revision(conn, kind, id)?.as_str()) {
            return Err("This item changed since you opened it. Your form is retained; reload and compare before saving.".into());
        }
        Ok(())
    }
    pub fn edit_result(conn: &Connection, kind: &str, id: &str) -> Result<Value, String> {
        Ok(json!({"sync_revision":edit_revision(conn,kind,id)?}))
    }
    pub fn photo_changed(conn: &Connection) -> Result<(), String> {
        let n = db::get_vault_info_value(conn, "sync_photo_edit_counter")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        db::set_vault_info(
            conn,
            "sync_photo_edit_counter",
            &n.saturating_add(1).to_string(),
        )
        .map_err(err)
    }
    fn key(kind: &str, id: &str) -> String {
        format!("{kind}:{id}")
    }
    fn text<'a>(v: &'a Value, k: &str) -> &'a str {
        v.get(k).and_then(Value::as_str).unwrap_or("")
    }
    fn valid_id(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 80
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }
    fn content(e: &Value) -> Value {
        json!({"deleted":e["deleted"],"data":e["data"],"blob":e["blob"]})
    }
    fn content_hash(e: &Value) -> String {
        value_hash(&content(e))
    }
    fn entity(kind: &str, id: &str, data: Value, blob: Value) -> Value {
        json!({"kind":kind,"id":id,"revision":0,"deleted":false,"data":data,"blob":blob})
    }
    fn deleted(kind: &str, id: &str) -> Value {
        json!({"kind":kind,"id":id,"revision":0,"deleted":true,"data":null,"blob":null})
    }
    fn require_bound(conn: &Connection) -> Result<(String, String, String), String> {
        if db::get_vault_info_value(conn, "sync_enabled").as_deref() != Some("1") {
            return Err("Synchronization is disabled".into());
        }
        let a = db::get_vault_info_value(conn, "sync_account_id").unwrap_or_default();
        let t = db::get_vault_info_value(conn, "sync_token").unwrap_or_default();
        let p = super::super::app_login::stored_user_token(conn).unwrap_or_default();
        if a.is_empty() || t.is_empty() || p.is_empty() {
            return Err("Sign in to your linked account again".into());
        }
        if db::get_vault_info_value(conn, "sync_parent_hash").as_deref()
            != Some(digest(p.as_bytes()).as_str())
        {
            return Err("Account session changed. Enable synchronization again.".into());
        }
        Ok((a, t, p))
    }
    pub fn invalidate(state: &AppState) {
        state.sync_epoch.fetch_add(1, Ordering::SeqCst);
    }
    fn vault_uuid(conn: &Connection) -> Result<String, String> {
        if let Some(v) = db::get_vault_info_value(conn, "sync_vault_uuid") {
            if valid_id(&v) {
                return Ok(v);
            }
        }
        let v = uid();
        db::set_vault_info(conn, "sync_vault_uuid", &v).map_err(err)?;
        Ok(v)
    }
    #[derive(Clone)]
    struct Pin {
        path: PathBuf,
        vault: String,
        account: String,
        token: String,
        parent: String,
        epoch: u64,
    }
    fn pinned<T>(
        state: &AppState,
        pin: &Pin,
        f: impl FnOnce(&Connection, &Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let path = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
        let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn.as_ref().ok_or("Vault closed")?;
        if path.as_ref() != Some(&pin.path)
            || state.sync_epoch.load(Ordering::SeqCst) != pin.epoch
            || db::get_vault_info_value(conn, "sync_vault_uuid").as_deref() != Some(&pin.vault)
        {
            return Err("Vault or account changed; synchronization stopped".into());
        }
        let (a, t, p) = require_bound(conn)?;
        if a != pin.account || t != pin.token || p != pin.parent {
            return Err("Account session changed; synchronization stopped".into());
        }
        f(conn, &pin.path)
    }
    fn pin(state: &AppState) -> Result<Pin, String> {
        let path = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
        let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn.as_ref().ok_or("No vault open")?;
        require_seafarer_vault(conn)?;
        let (account, token, parent) = require_bound(conn)?;
        Ok(Pin {
            path: path.as_ref().ok_or("No vault open")?.clone(),
            vault: vault_uuid(conn)?,
            account,
            token,
            parent,
            epoch: state.sync_epoch.load(Ordering::SeqCst),
        })
    }
    fn client() -> Result<reqwest::blocking::Client, String> {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .connect_timeout(std::time::Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(err)
    }
    fn read_response(
        mut resp: reqwest::blocking::Response,
        limit: usize,
    ) -> Result<(u16, Vec<u8>), String> {
        let status = resp.status().as_u16();
        if resp.content_length().unwrap_or(0) > limit as u64 {
            return Err("Server response exceeds supported limit".into());
        }
        let mut bytes = Vec::new();
        resp.by_ref()
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > limit {
            return Err("Server response exceeds supported limit".into());
        }
        Ok((status, bytes))
    }
    fn http_json(req: reqwest::blocking::RequestBuilder) -> Result<(u16, Value), String> {
        let (s, b) = read_response(
            req.send()
                .map_err(|_| "Network unavailable. Local changes are retained.")?,
            MAX_JSON,
        )?;
        let v = serde_json::from_slice(&b).map_err(|_| "Invalid server response")?;
        Ok((s, v))
    }
    fn status_error(s: u16) -> String {
        match s {
            401 => "Account session expired or revoked. Sign in again.",
            403 => "Account does not permit vault synchronization.",
            413 => "File exceeds synchronization limit; local file retained.",
            503 => "Synchronization is temporarily unavailable.",
            _ => "Synchronization failed; local changes are retained.",
        }
        .into()
    }
    fn api(path: &str) -> String {
        format!("{}{}", assistant_api_base(), path)
    }
    fn endpoint(e: &Value) -> String {
        api(&format!(
            "/api/vault/sync/entities/{}/{}",
            text(e, "kind"),
            text(e, "id")
        ))
    }
    fn safe_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Unsafe local attachment path".into());
        }
        let path = root.join(relative);
        let canonical_root = root.canonicalize().map_err(err)?;
        let mut cursor = path.as_path();
        while !cursor.exists() {
            cursor = cursor.parent().ok_or("Invalid attachment path")?;
        }
        if !cursor
            .canonicalize()
            .map_err(err)?
            .starts_with(&canonical_root)
        {
            return Err("Attachment resolves outside this vault".into());
        }
        Ok(path)
    }
    fn shareable_relative(kind: &str, relative: &Path) -> bool {
        let mut parts = Vec::new();
        for component in relative.components() {
            match component {
                std::path::Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
                _ => return false,
            }
        }
        if parts.iter().any(|s| {
            matches!(
                s.as_str(),
                "_identity" | "_sync" | "_conflicts" | "_keys" | "_secrets"
            )
        }) {
            return false;
        }
        match kind {
            "photo" => parts.len() == 2 && parts[0] == "_profile",
            "experience_file" => {
                parts.len() == 3 && matches!(parts[0].as_str(), "Sea Service" | "_work_history")
            }
            "document" => parts.len() >= 2 && !parts[0].starts_with('_'),
            _ => false,
        }
    }
    /// Domain policy is checked both on the logical name and the resolved
    /// target; an inward symlink to a private sibling is still forbidden.
    pub fn shareable_path(root: &Path, kind: &str, relative: &Path) -> Result<PathBuf, String> {
        if !shareable_relative(kind, relative) {
            return Err(
                "Private or invalid attachment location; file was not read or shared".into(),
            );
        }
        let path = safe_path(root, relative)?;
        let canonical_root = root.canonicalize().map_err(err)?;
        let mut existing = path.as_path();
        let mut remaining = Vec::new();
        while !existing.exists() {
            remaining.push(
                existing
                    .file_name()
                    .ok_or("Invalid attachment path")?
                    .to_os_string(),
            );
            existing = existing.parent().ok_or("Invalid attachment parent")?;
        }
        let canonical = existing.canonicalize().map_err(err)?;
        let mut resolved = canonical
            .strip_prefix(&canonical_root)
            .map_err(|_| "Attachment points outside this vault")?
            .to_path_buf();
        for part in remaining.iter().rev() {
            resolved.push(part);
        }
        if !shareable_relative(kind, &resolved) {
            return Err(
                "Attachment resolves into private storage; file was not read or shared".into(),
            );
        }
        Ok(path)
    }
    fn mime(filename: &str) -> &'static str {
        match Path::new(filename)
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "pdf" => "application/pdf",
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            "doc" => "application/msword",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "txt" => "text/plain",
            _ => "application/octet-stream",
        }
    }
    fn file_bytes(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
        let meta = fs::metadata(path).map_err(|_| {
            "A registered file is missing or unavailable; synchronization is incomplete"
        })?;
        if !meta.is_file() || meta.len() > limit as u64 {
            return Err(format!(
                "File exceeds supported {} MiB limit; it remains local",
                limit / 1024 / 1024
            ));
        }
        let mut b = Vec::new();
        fs::File::open(path)
            .map_err(err)?
            .take((limit + 1) as u64)
            .read_to_end(&mut b)
            .map_err(err)?;
        if b.len() > limit {
            return Err("File grew beyond synchronization limit".into());
        }
        Ok(b)
    }
    fn blob(path: &Path, limit: usize) -> Result<Value, String> {
        let b = file_bytes(path, limit)?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid attachment filename")?;
        Ok(json!({"sha256":digest(&b),"size":b.len(),"mime":mime(name),"filename":name}))
    }

    // Save recoverable copies before every destructive writer, even offline.
    // Names are generated locally; source paths never become remote metadata.
    fn recovery_dir(root: &Path) -> Result<PathBuf, String> {
        let mut path = root.to_path_buf();
        for component in ["_sync", "recovery"] {
            path.push(component);
            if fs::symlink_metadata(&path)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err("Recovery path is a symlink; original retained".into());
            }
        }
        let path = safe_path(root, Path::new("_sync/recovery"))?;
        fs::create_dir_all(&path).map_err(err)?;
        Ok(path)
    }
    pub fn preserve_file(root: &Path, path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "Recovery source outside vault")?;
        if rel.components().any(|c|matches!(c,std::path::Component::Normal(s) if matches!(s.to_str(),Some("_identity"|"_sync"|"_conflicts"|"_keys"|"_secrets")))){return Err("Private recovery source rejected".into())}
        let path = safe_path(root, rel)?;
        let resolved = path.canonicalize().map_err(err)?;
        let canonical_root = root.canonicalize().map_err(err)?;
        if resolved.strip_prefix(canonical_root).map_err(err)?.components().any(|c|matches!(c,std::path::Component::Normal(s) if matches!(s.to_str(),Some("_identity"|"_sync"|"_conflicts"|"_keys"|"_secrets")))){return Err("Recovery source resolves to private storage".into())}
        let dir = recovery_dir(root)?;
        let target = dir.join(uid());
        fs::copy(&path, &target).map_err(err)?;
        let metadata = json!({"original_relative_path":rel.to_string_lossy(),"copy":target.file_name().unwrap().to_string_lossy()});
        fs::write(target.with_extension("json"), metadata.to_string()).map_err(err)?;
        Ok(())
    }
    pub fn preserve_tree(root: &Path, path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        if fs::symlink_metadata(path)
            .map_err(err)?
            .file_type()
            .is_symlink()
        {
            return Err("Evidence contains a symlink; deletion stopped".into());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Evidence outside vault")?;
        if path.is_dir() {
            shareable_path(root, "experience_file", &relative.join("attachment"))?;
        } else {
            shareable_path(root, "experience_file", relative)?;
        }
        if path.is_dir() {
            for child in fs::read_dir(path).map_err(err)? {
                let child = child.map_err(err)?;
                if child.file_type().map_err(err)?.is_symlink() {
                    return Err("Evidence contains a symlink; deletion stopped".into());
                }
                preserve_tree(root, &child.path())?;
            }
        } else {
            preserve_file(root, path)?;
        }
        Ok(())
    }
    pub fn preserve_doc(conn: &Connection, root: &Path, id: &str) -> Result<(), String> {
        if let Some(d) = db::get_all_docs(conn)
            .map_err(err)?
            .into_iter()
            .find(|d| d.id == id)
        {
            if let Some(f) = &d.file_name {
                preserve_file(
                    root,
                    &shareable_path(root, "document", &Path::new(&d.category).join(f))?,
                )?;
            }
            recovery_metadata(
                root,
                "document",
                id,
                &serde_json::to_value(&d).map_err(err)?,
            )?;
        }
        Ok(())
    }
    fn recovery_metadata(root: &Path, kind: &str, id: &str, v: &Value) -> Result<(), String> {
        let dir = recovery_dir(root)?;
        fs::write(
            dir.join(format!("{}.json", uid())),
            json!({"kind":kind,"id":id,"entity":v}).to_string(),
        )
        .map_err(err)
    }
    fn ledger(conn: &Connection, account: &str) -> Result<BTreeMap<String, Value>, String> {
        let mut st=conn.prepare("SELECT kind,entity_id,baseline,local_hash,queued,conflict FROM account_sync_entities WHERE account_id=?1").map_err(err)?;
        let rows = st
            .query_map([account], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(err)?;
        let mut out = BTreeMap::new();
        for r in rows {
            let (k, id, b, h, q, c) = r.map_err(err)?;
            out.insert(key(&k,&id),json!({"baseline":serde_json::from_str::<Value>(&b).map_err(err)?,"local_hash":h,"queued":q.map(|x|serde_json::from_str::<Value>(&x)).transpose().map_err(err)?,"conflict":c.map(|x|serde_json::from_str::<Value>(&x)).transpose().map_err(err)?}));
        }
        Ok(out)
    }
    fn write_ledger(
        conn: &Connection,
        a: &str,
        e: &Value,
        hash: &str,
        q: Option<&Value>,
        conflict: Option<&Value>,
    ) -> Result<(), String> {
        conn.execute("INSERT INTO account_sync_entities(account_id,kind,entity_id,baseline,local_hash,queued,conflict) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(account_id,kind,entity_id) DO UPDATE SET baseline=excluded.baseline,local_hash=excluded.local_hash,queued=excluded.queued,conflict=excluded.conflict",params![a,text(e,"kind"),text(e,"id"),e.to_string(),hash,q.map(Value::to_string),conflict.map(Value::to_string)]).map_err(err)?;
        Ok(())
    }
    fn extras(mut data: Value, confirmed: Option<&Value>) -> Value {
        if data["created_at"].is_null() {
            data["created_at"] = confirmed
                .map(|e| e["data"]["created_at"].clone())
                .unwrap_or(Value::Null);
        }
        data
    }
    fn scan(
        conn: &Connection,
        root: &Path,
        account: &str,
    ) -> Result<BTreeMap<String, Value>, String> {
        let known = ledger(conn, account)?;
        let mut out = BTreeMap::new();
        let mut profile = Map::new();
        for k in PROFILE_WIRE_KEYS.iter().chain(EXTRA_PROFILE.iter()) {
            profile.insert(
                (*k).into(),
                (if *k == "personal_ready_for_offers" {
                    db::get_vault_info_value(conn, "sync_ready_preference")
                        .or_else(|| db::get_vault_info_value(conn, k))
                } else {
                    db::get_vault_info_value(conn, k)
                })
                .filter(|s| !s.is_empty())
                .map(Value::String)
                .unwrap_or(Value::Null),
            );
        }
        let p = entity("profile", "main", Value::Object(profile), Value::Null);
        out.insert(key("profile", "main"), p);
        if let Some(rel) =
            db::get_vault_info_value(conn, "personal_photo_path").filter(|s| !s.is_empty())
        {
            let path = shareable_path(root, "photo", Path::new(&rel))?;
            out.insert(
                key("photo", "main"),
                entity("photo", "main", json!({}), blob(&path, 5 * 1024 * 1024)?),
            );
        }
        for d in db::get_all_docs(conn).map_err(err)? {
            if !valid_id(&d.id) {
                return Err("Document has an unsupported identifier".into());
            }
            let mut data = serde_json::to_value(&d).map_err(err)?;
            for k in ["id", "file_name", "sha256", "file_size", "content_type"] {
                data.as_object_mut().unwrap().remove(k);
            }
            let k = key("document", &d.id);
            data = extras(data, known.get(&k).map(|v| &v["baseline"]));
            let b = match &d.file_name {
                Some(f) if !f.is_empty() => blob(
                    &shareable_path(root, "document", &Path::new(&d.category).join(f))?,
                    MAX_BLOB,
                )?,
                _ => Value::Null,
            };
            out.insert(k, entity("document", &d.id, data, b));
        }
        for w in db::get_work_history(conn).map_err(err)? {
            let id = text(&w, "id");
            if !valid_id(id) {
                return Err("Experience has an unsupported identifier".into());
            }
            let mut data = Map::new();
            for k in [
                "vessel_name",
                "imo",
                "vessel_type",
                "flag",
                "company",
                "position",
                "sign_on",
                "sign_off",
                "dwt",
                "teu",
                "notes",
                "created_at",
            ] {
                data.insert(k.into(), w[k].clone());
            }
            out.insert(
                key("experience", id),
                entity("experience", id, Value::Object(data), Value::Null),
            );
            for f in db::get_work_files(conn, id).map_err(err)? {
                let fid = text(&f, "id");
                if !valid_id(fid) {
                    return Err("Evidence has an unsupported identifier".into());
                }
                let filename = text(&f, "file_name");
                let path =
                    super::super::work_history::resolve_work_file_path(root, conn, id, filename);
                let path = shareable_path(
                    root,
                    "experience_file",
                    path.strip_prefix(root).map_err(err)?,
                )?;
                let k = key("experience_file", fid);
                let data = extras(
                    json!({"entry_id":id,"kind":f["kind"],"created_at":null}),
                    known.get(&k).map(|v| &v["baseline"]),
                );
                out.insert(
                    k,
                    entity("experience_file", fid, data, blob(&path, MAX_BLOB)?),
                );
            }
        }
        for (k, e) in out.iter_mut() {
            if !e["blob"].is_null() {
                if let Some(b) = known.get(k) {
                    if e["blob"]["sha256"] == b["baseline"]["blob"]["sha256"]
                        && e["blob"]["size"] == b["baseline"]["blob"]["size"]
                    {
                        e["blob"] = b["baseline"]["blob"].clone();
                    }
                }
            }
        }
        Ok(out)
    }
    fn validate_entity(e: &Value) -> Result<(), String> {
        let kind = text(e, "kind");
        let id = text(e, "id");
        if !KINDS.contains(&kind)
            || !valid_id(id)
            || (["profile", "photo"].contains(&kind) && id != "main")
            || e["revision"].as_u64().unwrap_or(0) == 0
            || !e["deleted"].is_boolean()
        {
            return Err("Invalid sync entity".into());
        }
        if e["deleted"] == true {
            if !e["data"].is_null() || !e["blob"].is_null() {
                return Err("Invalid tombstone".into());
            }
            return Ok(());
        }
        let data = e["data"].as_object().ok_or("Invalid entity data")?;
        let fields: &[&str] = match kind {
            "profile" => &[],
            "photo" => &[],
            "experience" => &[
                "vessel_name",
                "imo",
                "vessel_type",
                "flag",
                "company",
                "position",
                "sign_on",
                "sign_off",
                "dwt",
                "teu",
                "notes",
                "created_at",
            ],
            "experience_file" => &["entry_id", "kind", "created_at"],
            _ => &[
                "category",
                "title",
                "valid_from",
                "valid_to",
                "issued_by",
                "doc_number",
                "notes",
                "field_statuses",
                "regulatory_basis",
                "template_id",
                "has_expiry",
                "is_permanent",
                "is_national",
                "visibility",
                "created_at",
            ],
        };
        for (k, v) in data {
            let allowed = if kind == "profile" {
                PROFILE_WIRE_KEYS.contains(&k.as_str()) || EXTRA_PROFILE.contains(&k.as_str())
            } else {
                fields.contains(&k.as_str())
            };
            if !allowed {
                return Err("Unknown sync field".into());
            }
            if ["has_expiry", "is_permanent", "is_national"].contains(&k.as_str()) {
                if !v.is_boolean() {
                    return Err("Invalid document flag".into());
                }
            } else if !v.is_string() && !v.is_null() {
                return Err("Invalid sync field value".into());
            }
        }
        if e["data"].to_string().len() > 65536 {
            return Err("Entity metadata exceeds limit".into());
        }
        if kind == "experience"
            && (text(&e["data"], "vessel_name").is_empty()
                || text(&e["data"], "position").is_empty())
        {
            return Err("Incomplete experience".into());
        }
        if kind == "document" {
            let cat = text(&e["data"], "category");
            if cat.is_empty() || !shareable_relative("document", &Path::new(cat).join("attachment"))
            {
                return Err("Unsafe document category".into());
            }
        }
        if kind == "experience" {
            super::super::work_history::normalize_required_imo(
                e["data"]["imo"].as_str().map(str::to_string),
            )?;
        }
        let b = &e["blob"];
        if kind == "photo" && !matches!(text(b, "mime"), "image/jpeg" | "image/png" | "image/webp")
        {
            return Err("Unsupported profile photo type".into());
        }
        if !b.is_null() {
            let h = text(b, "sha256");
            let f = text(b, "filename");
            if h.len() != 64
                || !h
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                || b["size"].as_u64().unwrap_or(u64::MAX)
                    > (if kind == "photo" {
                        5 * 1024 * 1024
                    } else {
                        MAX_BLOB
                    }) as u64
                || f.is_empty()
                || f.contains('/')
                || f.contains('\\')
                || f == "."
                || f == ".."
            {
                return Err("Invalid blob descriptor".into());
            }
        }
        if ["photo", "experience_file"].contains(&kind) && b.is_null() {
            return Err("Missing attachment descriptor".into());
        }
        Ok(())
    }
    fn manifest(
        client: &reqwest::blocking::Client,
        pin: &Pin,
    ) -> Result<(u64, BTreeMap<String, Value>), String> {
        let (s, v) = http_json(
            client
                .get(api("/api/vault/sync/manifest"))
                .bearer_auth(&pin.token),
        )?;
        if s != 200 {
            return Err(status_error(s));
        }
        validate_manifest(&v, &pin.account)
    }
    fn validate_manifest(
        v: &Value,
        account: &str,
    ) -> Result<(u64, BTreeMap<String, Value>), String> {
        if v["schema"] != 1 || text(v, "account_id") != account || v["complete"] != true {
            return Err("Incomplete or foreign account manifest".into());
        }
        let gen = v["generation"].as_u64().ok_or("Invalid generation")?;
        let list = v["entities"].as_array().ok_or("Missing entity inventory")?;
        let mut out = BTreeMap::new();
        for e in list {
            validate_entity(e)?;
            if out
                .insert(key(text(e, "kind"), text(e, "id")), e.clone())
                .is_some()
            {
                return Err("Duplicate entity identity".into());
            }
        }
        for e in out
            .values()
            .filter(|e| text(e, "kind") == "experience_file" && e["deleted"] == false)
        {
            let id = text(&e["data"], "entry_id");
            if !valid_id(id)
                || out
                    .get(&key("experience", id))
                    .map(|p| p["deleted"] != false)
                    .unwrap_or(true)
            {
                return Err("Evidence parent missing".into());
            }
        }
        Ok((gen, out))
    }
    fn local_file(conn: &Connection, root: &Path, e: &Value) -> Result<PathBuf, String> {
        match text(e, "kind") {
            "photo" => shareable_path(
                root,
                "photo",
                Path::new(
                    &db::get_vault_info_value(conn, "personal_photo_path")
                        .ok_or("Missing photo")?,
                ),
            ),
            "document" => {
                let d = db::get_all_docs(conn)
                    .map_err(err)?
                    .into_iter()
                    .find(|d| d.id == text(e, "id"))
                    .ok_or("Missing document")?;
                shareable_path(
                    root,
                    "document",
                    &Path::new(&d.category).join(d.file_name.ok_or("Missing attachment")?),
                )
            }
            "experience_file" => {
                let (entry, name) = db::get_work_file(conn, text(e, "id"))
                    .map_err(err)?
                    .ok_or("Missing evidence")?;
                let p =
                    super::super::work_history::resolve_work_file_path(root, conn, &entry, &name);
                shareable_path(root, "experience_file", p.strip_prefix(root).map_err(err)?)
            }
            _ => Err("Entity has no blob".into()),
        }
    }
    fn download(
        client: &reqwest::blocking::Client,
        pin: &Pin,
        e: &Value,
    ) -> Result<Option<Vec<u8>>, String> {
        if e["blob"].is_null() {
            return Ok(None);
        }
        let (s, b) = read_response(
            client
                .get(format!("{}/blob?revision={}", endpoint(e), e["revision"]))
                .bearer_auth(&pin.token)
                .send()
                .map_err(|_| "Attachment download interrupted")?,
            MAX_BLOB,
        )?;
        if s != 200 {
            return Err(status_error(s));
        }
        if b.len() as u64 != e["blob"]["size"].as_u64().unwrap_or(u64::MAX)
            || digest(&b) != text(&e["blob"], "sha256")
        {
            return Err("Attachment content check failed; original retained".into());
        }
        Ok(Some(b))
    }
    fn staged_file(
        conn: &Connection,
        root: &Path,
        e: &Value,
        bytes: Option<&[u8]>,
    ) -> Result<Option<String>, String> {
        let Some(b) = bytes else { return Ok(None) };
        let dir = match text(e, "kind") {
            "photo" => PathBuf::from("_profile"),
            "experience_file" => super::super::work_history::work_entry_storage_dir(
                root,
                conn,
                text(&e["data"], "entry_id"),
            )?
            .strip_prefix(root)
            .map_err(err)?
            .to_path_buf(),
            _ => PathBuf::from(text(&e["data"], "category")),
        };
        let ext = Path::new(text(&e["blob"], "filename"))
            .extension()
            .and_then(|s| s.to_str())
            .filter(|s| s.len() <= 12 && s.bytes().all(|b| b.is_ascii_alphanumeric()))
            .unwrap_or("bin");
        let name = format!("sync-{}.{}", uid(), ext);
        let dest = shareable_path(root, text(e, "kind"), &dir.join(&name))?;
        fs::create_dir_all(dest.parent().ok_or("Invalid attachment parent")?).map_err(err)?;
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&dest)
            .map_err(err)?;
        use std::io::Write;
        f.write_all(b).map_err(err)?;
        f.sync_all().map_err(err)?;
        Ok(Some(if text(e, "kind") == "photo" {
            dir.join(name).to_string_lossy().into_owned()
        } else {
            name
        }))
    }
    fn apply_entity(
        conn: &Connection,
        root: &Path,
        e: &Value,
        bytes: Option<&[u8]>,
    ) -> Result<(), String> {
        let kind = text(e, "kind");
        let id = text(e, "id");
        if kind == "photo" {
            photo_changed(conn)?;
        }
        let d = &e["data"];
        recovery_metadata(root, kind, id, e)?;
        if let Ok(p) = local_file(conn, root, e) {
            preserve_file(root, &p)?;
        }
        let file = staged_file(conn, root, e, bytes)?;
        if e["deleted"] == true {
            match kind {
                "profile" => {
                    for k in PROFILE_WIRE_KEYS.iter().chain(EXTRA_PROFILE.iter()) {
                        db::set_vault_info(conn, k, "").map_err(err)?;
                    }
                }
                "photo" => db::set_vault_info(conn, "personal_photo_path", "").map_err(err)?,
                "document" => {
                    conn.execute("DELETE FROM documents WHERE id=?1", [id])
                        .map_err(err)?;
                }
                "experience_file" => db::delete_work_file(conn, id).map_err(err)?,
                "experience" => {
                    db::delete_work_entry(conn, id).map_err(err)?;
                }
                _ => {}
            }
            return Ok(());
        }
        match kind {
            "profile" => {
                db::set_vault_info(
                    conn,
                    "sync_ready_preference",
                    text(d, "personal_ready_for_offers"),
                )
                .map_err(err)?;
                for k in PROFILE_WIRE_KEYS.iter().chain(EXTRA_PROFILE.iter()) {
                    db::set_vault_info(conn, k, text(d, k)).map_err(err)?;
                }
                super::super::profile::sync_seafarer_document_framework(conn, root, &json!({}))?;
                db::set_vault_info(conn, "personal_ready_for_offers", "false").map_err(err)?;
                let _ = identity::sync_identity_fingerprint(conn);
            }
            "photo" => db::set_vault_info(
                conn,
                "personal_photo_path",
                file.as_deref().ok_or("Missing staged photo")?,
            )
            .map_err(err)?,
            "document" => {
                let record = db::DocRecord {
                    id: id.into(),
                    category: text(d, "category").into(),
                    title: text(d, "title").into(),
                    file_name: file,
                    has_expiry: d["has_expiry"].as_bool().unwrap_or(false),
                    is_permanent: d["is_permanent"].as_bool().unwrap_or(false),
                    valid_from: d["valid_from"].as_str().map(str::to_string),
                    valid_to: d["valid_to"].as_str().map(str::to_string),
                    issued_by: d["issued_by"].as_str().map(str::to_string),
                    doc_number: d["doc_number"].as_str().map(str::to_string),
                    notes: d["notes"].as_str().map(str::to_string),
                    field_statuses: d["field_statuses"].as_str().map(str::to_string),
                    regulatory_basis: d["regulatory_basis"].as_str().map(str::to_string),
                    template_id: d["template_id"].as_str().map(str::to_string),
                    sha256: e["blob"]["sha256"].as_str().map(str::to_string),
                    file_size: e["blob"]["size"].as_i64(),
                    content_type: e["blob"]["mime"].as_str().map(str::to_string),
                    visibility: text(d, "visibility").into(),
                    is_national: d["is_national"].as_bool().unwrap_or(false),
                };
                db::insert_doc(conn, &record).map_err(err)?;
            }
            "experience" => {
                let exists: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM work_history WHERE id=?1)",
                        [id],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                if exists {
                    super::super::work_history::work_entry_storage_dir(root, conn, id)?;
                }
                conn.execute("INSERT INTO work_history(id,vessel_name,imo,vessel_type,flag,company,position,sign_on,sign_off,dwt,teu,notes,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(id) DO UPDATE SET vessel_name=excluded.vessel_name,imo=excluded.imo,vessel_type=excluded.vessel_type,flag=excluded.flag,company=excluded.company,position=excluded.position,sign_on=excluded.sign_on,sign_off=excluded.sign_off,dwt=excluded.dwt,teu=excluded.teu,notes=excluded.notes",params![id,text(d,"vessel_name"),d["imo"].as_str(),d["vessel_type"].as_str(),d["flag"].as_str(),d["company"].as_str(),text(d,"position"),d["sign_on"].as_str(),d["sign_off"].as_str(),d["dwt"].as_str(),d["teu"].as_str(),d["notes"].as_str(),d["created_at"].as_str().unwrap_or("1970-01-01T00:00:00Z")]).map_err(err)?;
            }
            "experience_file" => {
                conn.execute("INSERT INTO work_history_files(id,entry_id,file_name,kind) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET entry_id=excluded.entry_id,file_name=excluded.file_name,kind=excluded.kind",params![id,text(d,"entry_id"),file.ok_or("Missing staged evidence")?,d["kind"].as_str()]).map_err(err)?;
            }
            _ => return Err("Unknown sync kind".into()),
        }
        Ok(())
    }
    fn transaction<T>(
        conn: &Connection,
        f: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        conn.execute_batch("SAVEPOINT account_sync_apply")
            .map_err(err)?;
        match f() {
            Ok(v) => {
                conn.execute_batch("RELEASE account_sync_apply")
                    .map_err(err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn
                    .execute_batch("ROLLBACK TO account_sync_apply; RELEASE account_sync_apply");
                Err(e)
            }
        }
    }
    fn current_entity(all: &BTreeMap<String, Value>, kind: &str, id: &str) -> Value {
        all.get(&key(kind, id))
            .cloned()
            .unwrap_or_else(|| deleted(kind, id))
    }
    fn empty_profile(e: &Value) -> bool {
        e["data"]
            .as_object()
            .map(|o| o.values().all(|v| v.is_null() || v.as_str() == Some("")))
            .unwrap_or(true)
    }
    fn record_conflict(
        conn: &Connection,
        a: &str,
        base: &Value,
        hash: &str,
        queue: Option<&Value>,
        local: &Value,
        remote: &Value,
    ) -> Result<(), String> {
        write_ledger(
            conn,
            a,
            base,
            hash,
            queue,
            Some(&json!({"local":local,"remote":remote})),
        )
    }
    fn apply_remote(
        state: &AppState,
        pin: &Pin,
        client: &reqwest::blocking::Client,
        remote: &Value,
        before: &str,
    ) -> Result<(), String> {
        let bytes = download(client, pin, remote)?;
        pinned(state, pin, |conn, root| {
            let all = scan(conn, root, &pin.account)?;
            let local = current_entity(&all, text(remote, "kind"), text(remote, "id"));
            if content_hash(&local) != before {
                return Err("Local data changed during download; retry synchronization".into());
            }
            if text(remote, "kind") == "experience" && remote["deleted"] == true {
                let known = ledger(conn, &pin.account)?;
                for (k, e) in all.iter().filter(|(_, e)| {
                    text(e, "kind") == "experience_file"
                        && text(&e["data"], "entry_id") == text(remote, "id")
                }) {
                    if known
                        .get(k)
                        .map(|b| text(b, "local_hash") != content_hash(e))
                        .unwrap_or(true)
                    {
                        return Err(
                            "Experience deletion conflicts with local evidence edits".into()
                        );
                    }
                    if let Ok(p) = local_file(conn, root, e) {
                        preserve_file(root, &p)?;
                    }
                    recovery_metadata(root, "experience_file", text(e, "id"), e)?;
                }
            }
            recovery_metadata(root, text(&local, "kind"), text(&local, "id"), &local)?;
            transaction(conn, || {
                apply_entity(conn, root, remote, bytes.as_deref())?;
                // Baseline must be available while scanning server-only metadata.
                write_ledger(conn, &pin.account, remote, "", None, None)?;
                let after = scan(conn, root, &pin.account)?;
                let value = current_entity(&after, text(remote, "kind"), text(remote, "id"));
                write_ledger(
                    conn,
                    &pin.account,
                    remote,
                    &content_hash(&value),
                    None,
                    None,
                )
            })
        })
    }
    fn queue_entity(
        conn: &Connection,
        root: &Path,
        pin: &Pin,
        local: &Value,
        baseline: &Value,
    ) -> Result<Value, String> {
        let mut request = json!({"schema":1,"account_id":pin.account,"expected_revision":baseline["revision"].as_u64().unwrap_or(0),"mutation_id":uid()});
        if local["deleted"] != true {
            request["data"] = local["data"].clone();
            request["blob"] = local["blob"].clone();
            if !local["blob"].is_null() && local["blob"] != baseline["blob"] {
                let bytes = file_bytes(&local_file(conn, root, local)?, MAX_BLOB)?;
                if digest(&bytes) != text(&local["blob"], "sha256") {
                    return Err("Attachment changed while queuing; retry".into());
                }
                request["blob_base64"] = Value::String(data_encoding::BASE64.encode(&bytes));
            }
        }
        let q = json!({"request":request,"entity":local,"local_hash":content_hash(local)});
        let previous = ledger(conn, &pin.account)?
            .get(&key(text(local, "kind"), text(local, "id")))
            .cloned();
        write_ledger(
            conn,
            &pin.account,
            baseline,
            previous
                .as_ref()
                .map(|v| text(v, "local_hash"))
                .unwrap_or(""),
            Some(&q),
            None,
        )?;
        Ok(q)
    }
    fn send_queue(
        state: &AppState,
        pin: &Pin,
        client: &reqwest::blocking::Client,
        q: &Value,
    ) -> Result<bool, String> {
        pinned(state, pin, |_, _| Ok(()))?;
        let e = &q["entity"];
        let req = if e["deleted"] == true {
            client.delete(endpoint(e))
        } else {
            client.put(endpoint(e))
        };
        let (s, v) = http_json(req.bearer_auth(&pin.token).json(&q["request"]))?;
        if s == 409 {
            pinned(state, pin, |conn, root| {
                let known = ledger(conn, &pin.account)?;
                let k = key(text(e, "kind"), text(e, "id"));
                let old = known.get(&k).ok_or("Queued entity disappeared")?;
                let remote = &v["entity"];
                if !remote.is_null() {
                    validate_entity(remote)?;
                }
                let all = scan(conn, root, &pin.account)?;
                record_conflict(
                    conn,
                    &pin.account,
                    &old["baseline"],
                    text(old, "local_hash"),
                    Some(q),
                    &current_entity(&all, text(e, "kind"), text(e, "id")),
                    remote,
                )
            })?;
            return Ok(false);
        }
        if s != 200 {
            return Err(status_error(s));
        }
        if v["schema"] != 1 || text(&v, "account_id") != pin.account {
            return Err("Foreign mutation response".into());
        }
        validate_entity(&v["entity"])?;
        if text(&v["entity"], "kind") != text(e, "kind")
            || text(&v["entity"], "id") != text(e, "id")
        {
            return Err("Mutation response identity mismatch".into());
        }
        pinned(state, pin, |conn, _| {
            let known = ledger(conn, &pin.account)?;
            let old = known
                .get(&key(text(e, "kind"), text(e, "id")))
                .ok_or("Queued entity disappeared")?;
            if old["queued"]["request"]["mutation_id"] != q["request"]["mutation_id"] {
                return Err("Queued version changed; acknowledgement rejected".into());
            }
            // Hash is the exact queued local version, never whatever is now on disk.
            write_ledger(
                conn,
                &pin.account,
                &v["entity"],
                text(q, "local_hash"),
                None,
                None,
            )
        })?;
        Ok(true)
    }
    fn map_empty_framework_rows(
        conn: &Connection,
        account: &str,
        remote: &BTreeMap<String, Value>,
    ) -> Result<(), String> {
        let docs = db::get_all_docs(conn).map_err(err)?;
        let known = ledger(conn, account)?;
        for doc in &docs {
            let Some(template) = doc.template_id.as_deref() else {
                continue;
            };
            if doc.file_name.is_some()
                || doc.doc_number.is_some()
                || doc.valid_from.is_some()
                || doc.valid_to.is_some()
                || doc.issued_by.is_some()
                || doc.notes.as_deref().is_some_and(|v| !v.is_empty())
                || !matches!(doc.field_statuses.as_deref(), None | Some("") | Some("{}"))
                || known.contains_key(&key("document", &doc.id))
            {
                continue;
            }
            if docs
                .iter()
                .filter(|d| d.template_id.as_deref() == Some(template))
                .count()
                != 1
            {
                continue;
            }
            let matches: Vec<&Value> = remote
                .values()
                .filter(|e| {
                    text(e, "kind") == "document"
                        && e["deleted"] == false
                        && text(&e["data"], "template_id") == template
                        && text(&e["data"], "title") == doc.title
                        && text(&e["data"], "category") == doc.category
                })
                .collect();
            if matches.len() != 1 {
                continue;
            }
            let id = text(matches[0], "id");
            if id == doc.id || docs.iter().any(|d| d.id == id) {
                continue;
            }
            // This is a generated scaffold, not a user's independently filled record.
            conn.execute(
                "UPDATE documents SET id=?1 WHERE id=?2",
                params![id, doc.id],
            )
            .map_err(err)?;
        }
        Ok(())
    }
    fn changed_remote_conflict(
        conn: &Connection,
        account: &str,
        old: &Value,
        local: &Value,
        remote: &Value,
    ) -> Result<bool, String> {
        let baseline = &old["baseline"];
        if remote["revision"] != baseline["revision"] {
            record_conflict(
                conn,
                account,
                baseline,
                text(old, "local_hash"),
                None,
                local,
                remote,
            )?;
            return Ok(true);
        }
        Ok(false)
    }
    fn run_sync(state: &AppState) -> Result<Value, String> {
        let _single = state.sync_worker.lock().unwrap_or_else(|e| e.into_inner());
        let pin = pin(state)?;
        let client = client()?;
        pinned(state, &pin, |conn, _| {
            db::set_vault_info(conn, "sync_state", "syncing").map_err(err)
        })?;
        let result: Result<Value, String> = (|| {
            let (generation, mut remote) = manifest(&client, &pin)?;
            pinned(state, &pin, |conn, _| {
                let previous = db::get_vault_info_value(conn, "sync_generation")
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                if generation < previous {
                    return Err("Server generation moved backwards; local data retained".into());
                }
                Ok(())
            })?;
            let (local, known) = pinned(state, &pin, |conn, root| {
                map_empty_framework_rows(conn, &pin.account, &remote)?;
                Ok((scan(conn, root, &pin.account)?, ledger(conn, &pin.account)?))
            })?;
            let mut keys: BTreeSet<String> = local
                .keys()
                .chain(remote.keys())
                .chain(known.keys())
                .cloned()
                .collect();
            // Parents precede attachments; deletions with changed children are
            // checked again in the local transaction and by server parent CAS.
            let mut ordered: Vec<String> = keys.iter().cloned().collect();
            ordered.sort_by_key(|k| {
                if k.starts_with("experience:") {
                    0
                } else if k.starts_with("experience_file:") {
                    2
                } else {
                    1
                }
            });
            for k in ordered.drain(..) {
                let (local, old) = pinned(state, &pin, |conn, root| {
                    let all = scan(conn, root, &pin.account)?;
                    let mut parts = k.splitn(2, ':');
                    let kind = parts.next().unwrap();
                    let id = parts.next().unwrap();
                    Ok((
                        current_entity(&all, kind, id),
                        ledger(conn, &pin.account)?.get(&k).cloned(),
                    ))
                })?;
                if let Some(old) = &old {
                    if !old["conflict"].is_null() {
                        continue;
                    }
                    if !old["queued"].is_null() {
                        if send_queue(state, &pin, &client, &old["queued"])? {
                            remote = manifest(&client, &pin)?.1;
                        }
                        continue;
                    }
                }
                let r = remote.get(&k);
                let local_hash = content_hash(&local);
                let baseline = old.as_ref().map(|v| &v["baseline"]);
                let changed = old
                    .as_ref()
                    .map(|v| text(v, "local_hash") != local_hash)
                    .unwrap_or(local["deleted"] != true);
                match r {
                    None => {
                        if baseline.is_some_and(|b| b["revision"].as_u64().unwrap_or(0) > 0) {
                            return Err(
                                "Confirmed entity missing from complete manifest; nothing deleted"
                                    .into(),
                            );
                        }
                        if local["deleted"] == true {
                            continue;
                        }
                        let base = entity(
                            text(&local, "kind"),
                            text(&local, "id"),
                            Value::Null,
                            Value::Null,
                        );
                        let q = pinned(state, &pin, |conn, root| {
                            queue_entity(conn, root, &pin, &local, &base)
                        })?;
                        if send_queue(state, &pin, &client, &q)? {
                            remote = manifest(&client, &pin)?.1;
                        }
                    }
                    Some(r) => {
                        if let Some(old) = &old {
                            let b = &old["baseline"];
                            if r["revision"].as_u64() < b["revision"].as_u64() {
                                return Err(
                                    "Server revision moved backwards; local data retained".into()
                                );
                            }
                            let remote_changed = r["revision"] != b["revision"];
                            if !changed {
                                if remote_changed {
                                    apply_remote(state, &pin, &client, r, &local_hash)?;
                                }
                                continue;
                            }
                            if pinned(state, &pin, |conn, _| {
                                changed_remote_conflict(conn, &pin.account, old, &local, r)
                            })? {
                                continue;
                            }
                            if local["deleted"] == true && r["deleted"] == true {
                                pinned(state, &pin, |conn, _| {
                                    write_ledger(conn, &pin.account, r, &local_hash, None, None)
                                })?;
                                continue;
                            }
                            let q = pinned(state, &pin, |conn, root| {
                                queue_entity(conn, root, &pin, &local, r)
                            })?;
                            if send_queue(state, &pin, &client, &q)? {
                                remote = manifest(&client, &pin)?.1;
                            }
                        } else if local["deleted"] == true
                            || text(&local, "kind") == "document"
                                && local["blob"].is_null()
                                && local["data"]["template_id"].is_string()
                                && ["valid_from", "valid_to", "issued_by", "doc_number", "notes"]
                                    .iter()
                                    .all(|k| local["data"][*k].is_null() || local["data"][*k] == "")
                            || text(&local, "kind") == "profile" && empty_profile(&local)
                        {
                            apply_remote(state, &pin, &client, r, &local_hash)?;
                        } else if content_hash(&local) == content_hash(r) {
                            pinned(state, &pin, |conn, _| {
                                write_ledger(conn, &pin.account, r, &local_hash, None, None)
                            })?;
                        } else {
                            pinned(state, &pin, |conn, _| {
                                record_conflict(conn, &pin.account, r, "", None, &local, r)
                            })?;
                        }
                    }
                }
            }
            let (generation, final_remote) = manifest(&client, &pin)?;
            keys.extend(final_remote.keys().cloned());
            let result = pinned(state, &pin, |conn, root| {
                let all = scan(conn, root, &pin.account)?;
                let known = ledger(conn, &pin.account)?;
                for (k, b) in &known {
                    if b["queued"].is_null() && b["conflict"].is_null() {
                        if let (Some(local), Some(remote)) = (all.get(k), final_remote.get(k)) {
                            if text(b, "local_hash") == content_hash(local)
                                && content_hash(&b["baseline"]) == content_hash(remote)
                            {
                                write_ledger(
                                    conn,
                                    &pin.account,
                                    remote,
                                    text(b, "local_hash"),
                                    None,
                                    None,
                                )?;
                            }
                        }
                    }
                }
                let known = ledger(conn, &pin.account)?;
                let pending = keys
                    .iter()
                    .filter(|k| {
                        let Some(b) = known.get(*k) else { return true };
                        if !b["queued"].is_null() || !b["conflict"].is_null() {
                            return true;
                        }
                        let mut parts = k.splitn(2, ':');
                        let e = current_entity(&all, parts.next().unwrap(), parts.next().unwrap());
                        text(b, "local_hash") != content_hash(&e)
                            || final_remote
                                .get(*k)
                                .map(|r| r["revision"] != b["baseline"]["revision"])
                                .unwrap_or(true)
                    })
                    .count();
                db::set_vault_info(
                    conn,
                    "sync_state",
                    if pending == 0 { "current" } else { "pending" },
                )
                .map_err(err)?;
                db::set_vault_info(conn, "sync_generation", &generation.to_string())
                    .map_err(err)?;
                db::set_vault_info(conn, "sync_error", "").map_err(err)?;
                let preference = db::get_vault_info_value(conn, "sync_ready_preference")
                    .or_else(|| db::get_vault_info_value(conn, "personal_ready_for_offers"))
                    .unwrap_or_default();
                db::set_vault_info(conn, "sync_ready_preference", &preference).map_err(err)?;
                let ready =
                    super::super::profile::seafarer_jobs_readiness_status(conn, &json!({}))?;
                db::set_vault_info(
                    conn,
                    "personal_ready_for_offers",
                    if pending == 0 && truthy_flag(&preference) && ready["ok"] == true {
                        "true"
                    } else {
                        "false"
                    },
                )
                .map_err(err)?;
                if pending == 0 {
                    db::set_vault_info(
                        conn,
                        "sync_last_completed",
                        &chrono::Utc::now().to_rfc3339(),
                    )
                    .map_err(err)?;
                }
                status(conn)
            })?;
            Ok(result)
        })();
        if let Err(e) = &result {
            let _ = pinned(state, &pin, |conn, _| {
                db::set_vault_info(conn, "sync_state", "error").map_err(err)?;
                db::set_vault_info(conn, "sync_error", e).map_err(err)
            });
        }
        result
    }
    fn status(conn: &Connection) -> Result<Value, String> {
        let account = db::get_vault_info_value(conn, "sync_account_id").unwrap_or_default();
        let known = ledger(conn, &account)?;
        let conflicts:Vec<Value>=known.values().filter(|b|!b["conflict"].is_null()).map(|b|json!({"kind":b["baseline"]["kind"],"id":b["baseline"]["id"],"revision":b["conflict"]["remote"]["revision"],"local":b["conflict"]["local"]["data"],"remote":b["conflict"]["remote"]["data"]})).collect();
        Ok(
            json!({"enabled":require_bound(conn).is_ok(),"account_id":account,"account_email":db::get_vault_info_value(conn,"skipi_user_email").unwrap_or_default(),"state":if conflicts.is_empty(){db::get_vault_info_value(conn,"sync_state").unwrap_or_else(||"disabled".into())}else{"conflict".into()},"conflicts":conflicts,"pending":known.values().filter(|b|!b["queued"].is_null()).count(),"error":db::get_vault_info_value(conn,"sync_error").unwrap_or_default(),"last_completed":db::get_vault_info_value(conn,"sync_last_completed").unwrap_or_default()}),
        )
    }
    #[tauri::command]
    pub fn get_account_sync_status(state: State<AppState>) -> Result<Value, String> {
        let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        match conn.as_ref() {
            Some(conn) => status(conn),
            None => Ok(json!({"enabled":false,"state":"disabled","conflicts":[]})),
        }
    }
    #[tauri::command]
    pub async fn enable_account_sync(
        app: tauri::AppHandle,
        consent: bool,
    ) -> Result<Value, String> {
        if !consent {
            return Err("Explicit consent is required to synchronize profile, sea service and all attached files".into());
        }
        tauri::async_runtime::spawn_blocking(move||{
            let state=app.state::<AppState>();let _single=state.sync_worker.lock().unwrap_or_else(|e|e.into_inner());
            let(path,vault,epoch,parent,device)={let path=state.vault_path.lock().unwrap_or_else(|e|e.into_inner());let conn=state.conn.lock().unwrap_or_else(|e|e.into_inner());let conn=conn.as_ref().ok_or("Open a profile first")?;require_seafarer_vault(conn)?;if db::get_vault_info_value(conn,"is_demo").as_deref()==Some("1"){return Err("Open your own profile to enable synchronization".into())}let parent=super::super::app_login::stored_user_token(conn).ok_or("Sign in first")?;let device=db::get_vault_info_value(conn,"sync_device_id").filter(|v|valid_id(v)).unwrap_or_else(uid);db::set_vault_info(conn,"sync_device_id",&device).map_err(err)?;(path.clone().ok_or("No vault open")?,vault_uuid(conn)?,state.sync_epoch.load(Ordering::SeqCst),parent,device)};
            let(s,v)=http_json(client()?.post(api("/api/app/vault-token")).bearer_auth(&parent).json(&json!({"device_id":device,"consent_vault":true})))?;if s!=200{return Err(status_error(s))}let account=text(&v,"account_id");let token=text(&v,"token");if v["schema"]!=1||text(&v,"scope")!="seafarer-profile+vault"||text(&v,"device_id")!=device||account.is_empty()||token.is_empty(){return Err("Invalid account binding response".into())}
            let path_lock=state.vault_path.lock().unwrap_or_else(|e|e.into_inner());let conn=state.conn.lock().unwrap_or_else(|e|e.into_inner());let conn=conn.as_ref().ok_or("Vault closed")?;
            if path_lock.as_ref()!=Some(&path)||state.sync_epoch.load(Ordering::SeqCst)!=epoch||db::get_vault_info_value(conn,"sync_vault_uuid").as_deref()!=Some(&vault)||super::super::app_login::stored_user_token(conn).as_deref()!=Some(&parent){return Err("Vault or login changed during consent".into())}
            if let Some(bound)=db::get_vault_info_value(conn,"sync_account_id").filter(|s|!s.is_empty()){if bound!=account{return Err("This local profile belongs to another sync account. Open or create a separate profile.".into())}}
            let parent_hash=digest(parent.as_bytes());transaction(conn,||{for(k,val)in [("sync_account_id",account),("sync_token",token),("sync_enabled","1"),("sync_parent_hash",parent_hash.as_str()),("sync_state","pending")]{db::set_vault_info(conn,k,val).map_err(err)?;}status(conn)})
        }).await.map_err(err)?
    }
    #[tauri::command]
    pub fn disable_account_sync(state: State<AppState>) -> Result<Value, String> {
        invalidate(&state);
        let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn.as_ref().ok_or("No vault open")?;
        db::set_vault_info(conn, "sync_enabled", "0").map_err(err)?;
        db::set_vault_info(conn, "sync_token", "").map_err(err)?;
        db::set_vault_info(conn, "sync_state", "disabled").map_err(err)?;
        status(conn)
    }
    #[tauri::command]
    pub async fn sync_account_now(app: tauri::AppHandle) -> Result<Value, String> {
        tauri::async_runtime::spawn_blocking(move || run_sync(&app.state::<AppState>()))
            .await
            .map_err(err)?
    }
    #[tauri::command]
    pub async fn resolve_account_sync_conflict(
        app: tauri::AppHandle,
        kind: String,
        id: String,
        choice: String,
        revision: u64,
    ) -> Result<Value, String> {
        if !KINDS.contains(&kind.as_str())
            || !valid_id(&id)
            || !["local", "remote"].contains(&choice.as_str())
        {
            return Err("Invalid conflict resolution".into());
        }
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let _single = state.sync_worker.lock().unwrap_or_else(|e| e.into_inner());
            let pin = pin(&state)?;
            let client = client()?;
            let (_, manifest) = manifest(&client, &pin)?;
            let remote = manifest
                .get(&key(&kind, &id))
                .ok_or("Remote entity disappeared")?;
            let local = pinned(&state, &pin, |conn, root| {
                let known = ledger(conn, &pin.account)?;
                let entry = known
                    .get(&key(&kind, &id))
                    .ok_or("Conflict no longer exists")?;
                if entry["conflict"].is_null()
                    || entry["conflict"]["remote"]["revision"].as_u64() != Some(revision)
                    || remote["revision"].as_u64() != Some(revision)
                {
                    return Err("Conflict changed. Refresh before choosing a version.".into());
                }
                Ok(current_entity(&scan(conn, root, &pin.account)?, &kind, &id))
            })?;
            if choice == "remote" {
                apply_remote(&state, &pin, &client, remote, &content_hash(&local))?;
            } else {
                pinned(&state, &pin, |conn, root| {
                    recovery_metadata(root, &kind, &id, remote)?;
                    write_ledger(
                        conn,
                        &pin.account,
                        remote,
                        "explicit-local-choice",
                        None,
                        None,
                    )
                })?;
            }
            pinned(&state, &pin, |conn, _| status(conn))
        })
        .await
        .map_err(err)?
    }

    #[cfg(test)]
    mod sync_tests {
        use super::*;
        fn fixture() -> (PathBuf, Connection) {
            let path = std::env::current_dir()
                .unwrap()
                .join("../scratchpad/one-account-sync-20260913")
                .join(uid());
            fs::create_dir_all(&path).unwrap();
            let conn = db::open_db(&path).unwrap();
            db::set_vault_info(&conn, "account_type", "seafarer").unwrap();
            (path, conn)
        }
        fn wire_doc(id: &str, bytes: Option<&[u8]>) -> Value {
            let mut e=entity("document",id,json!({"category":"Other","title":"Same title","valid_from":null,"valid_to":null,"issued_by":null,"doc_number":null,"notes":"preserved notes","field_statuses":"{\"doc_number\":\"verified\"}","regulatory_basis":"custom basis","template_id":null,"has_expiry":false,"is_permanent":true,"is_national":false,"visibility":"private","created_at":null}),bytes.map(|b|json!({"sha256":digest(b),"size":b.len(),"mime":"application/msword","filename":"scan.doc"})).unwrap_or(Value::Null));
            e["revision"] = json!(1);
            e
        }
        #[test]
        fn private_registered_paths_never_enter_inventory_or_incoming_storage() {
            let (root, conn) = fixture();
            fs::create_dir_all(root.join("_identity")).unwrap();
            fs::write(root.join("_identity/key.doc"), b"synthetic_private_key").unwrap();
            let doc = wire_doc("malicious", None);
            apply_entity(&conn, &root, &doc, None).unwrap();
            conn.execute("UPDATE documents SET category='_identity',file_name='key.doc' WHERE id='malicious'",[]).unwrap();
            assert!(
                scan(&conn, &root, "A").is_err(),
                "private document must be rejected before reading"
            );
            conn.execute("DELETE FROM documents WHERE id='malicious'", [])
                .unwrap();
            db::set_vault_info(&conn, "personal_photo_path", "_identity/key.doc").unwrap();
            assert!(scan(&conn, &root, "A").is_err());
            db::set_vault_info(&conn, "personal_photo_path", "").unwrap();
            let mut incoming = wire_doc("new", Some(b"public"));
            incoming["data"]["category"] = json!("_identity/new-folder");
            assert!(validate_entity(&incoming).is_err());
            assert!(staged_file(&conn, &root, &incoming, Some(b"public")).is_err());
            assert!(!root.join("_identity/new-folder").exists());
            assert_eq!(
                fs::read(root.join("_identity/key.doc")).unwrap(),
                b"synthetic_private_key"
            );
            assert!(ledger(&conn, "A").unwrap().is_empty());
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
        #[cfg(unix)]
        #[test]
        fn inward_symlinks_cannot_share_private_files_or_create_private_targets() {
            use std::os::unix::fs::symlink;
            let (root, conn) = fixture();
            fs::create_dir_all(root.join("_identity")).unwrap();
            fs::write(root.join("_identity/key.doc"), b"synthetic_private_key").unwrap();
            symlink(root.join("_identity"), root.join("Other")).unwrap();
            assert!(shareable_path(&root, "document", Path::new("Other/key.doc")).is_err());
            assert!(shareable_path(&root, "document", Path::new("Other/new/file.doc")).is_err());
            let mut incoming = wire_doc("new", Some(b"public"));
            incoming["data"]["category"] = json!("Other/new");
            assert!(staged_file(&conn, &root, &incoming, Some(b"public")).is_err());
            assert!(!root.join("_identity/new").exists());
            symlink(root.join("_identity"), root.join("_sync")).unwrap();
            assert!(recovery_metadata(&root, "document", "new", &incoming).is_err());
            assert!(!root.join("_identity/recovery").exists());
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn local_parent_delete_conflicts_with_remote_child_revision_without_upgrading_cas() {
            let (root, conn) = fixture();
            let mut baseline = entity(
                "experience",
                "work",
                json!({"vessel_name":"Vessel","position":"Master"}),
                Value::Null,
            );
            baseline["revision"] = json!(1);
            let mut remote = baseline.clone();
            remote["revision"] = json!(2);
            let mut local = baseline.clone();
            local["deleted"] = json!(true);
            local["data"] = Value::Null;
            let old = json!({"baseline":baseline,"local_hash":content_hash(&baseline)});
            assert!(
                changed_remote_conflict(&conn, "A", &old, &local, &remote).unwrap(),
                "child revision protects unseen evidence even if parent metadata matches"
            );
            let rows = ledger(&conn, "A").unwrap();
            assert!(!rows["experience:work"]["conflict"].is_null());
            assert!(rows["experience:work"]["queued"].is_null());
            assert_eq!(rows["experience:work"]["baseline"]["revision"], 1);
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn native_apply_preserves_metadata_all_rows_word_bytes_and_replacement_recovery() {
            let (root, conn) = fixture();
            let a = wire_doc("document-A", Some(b"old DOC scan"));
            let b = wire_doc("document-B", Some(b"second DOC scan"));
            let empty = wire_doc("metadata-only", None);
            for (e, bytes) in [
                (&a, Some(b"old DOC scan".as_slice())),
                (&b, Some(b"second DOC scan".as_slice())),
                (&empty, None),
            ] {
                validate_entity(e).unwrap();
                apply_entity(&conn, &root, e, bytes).unwrap();
                write_ledger(&conn, "A", e, "", None, None).unwrap();
            }
            let all = scan(&conn, &root, "A").unwrap();
            assert_eq!(all.values().filter(|e| e["kind"] == "document").count(), 3);
            assert_eq!(
                all["document:document-A"]["data"]["notes"],
                "preserved notes"
            );
            assert_eq!(all["document:document-A"]["blob"], a["blob"]);
            let changed = wire_doc("document-A", Some(b"replacement"));
            apply_entity(&conn, &root, &changed, Some(b"replacement")).unwrap();
            assert!(fs::read_dir(root.join("_sync/recovery"))
                .unwrap()
                .any(|e| fs::read(e.unwrap().path()).ok().as_deref() == Some(b"old DOC scan")));
            let mut tombstone = deleted("document", "document-A");
            tombstone["revision"] = json!(3);
            apply_entity(&conn, &root, &tombstone, None).unwrap();
            assert!(db::get_all_docs(&conn)
                .unwrap()
                .iter()
                .all(|d| d.id != "document-A"));
            assert!(fs::read_dir(root.join("_sync/recovery"))
                .unwrap()
                .any(|e| fs::read(e.unwrap().path()).ok().as_deref() == Some(b"replacement")));
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn opened_native_form_cannot_overwrite_background_sync() {
            let (root, conn) = fixture();
            let original = wire_doc("doc", None);
            apply_entity(&conn, &root, &original, None).unwrap();
            let displayed = Value::String(edit_revision(&conn, "document", "doc").unwrap());
            let mut incoming = original.clone();
            incoming["data"]["notes"] = json!("new value from another device");
            apply_entity(&conn, &root, &incoming, None).unwrap();
            assert!(require_edit_revision(&conn, "document", "doc", Some(&displayed)).is_err());
            assert_eq!(
                db::get_all_docs(&conn).unwrap()[0].notes.as_deref(),
                Some("new value from another device")
            );
            let fresh = Value::String(edit_revision(&conn, "document", "doc").unwrap());
            assert!(require_edit_revision(&conn, "document", "doc", Some(&fresh)).is_ok());
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn vault_epoch_and_account_switch_reject_delayed_completion() {
            let (root, conn) = fixture();
            for (k, v) in [
                ("sync_enabled", "1"),
                ("sync_account_id", "public-A"),
                ("sync_token", "synthetic-child"),
                ("skipi_user_token", "synthetic-parent"),
            ] {
                db::set_vault_info(&conn, k, v).unwrap();
            }
            db::set_vault_info(&conn, "sync_parent_hash", &digest(b"synthetic-parent")).unwrap();
            let state = AppState {
                conn: std::sync::Mutex::new(Some(conn)),
                vault_path: std::sync::Mutex::new(Some(root.clone())),
                login_pending: std::sync::Mutex::new(None),
                sync_epoch: std::sync::atomic::AtomicU64::new(0),
                sync_worker: std::sync::Mutex::new(()),
            };
            let original = pin(&state).unwrap();
            assert!(pinned(&state, &original, |_, _| Ok(())).is_ok());
            invalidate(&state);
            assert!(
                pinned::<()>(&state, &original, |_, _| panic!("late apply must not run")).is_err()
            );
            drop(state);
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn sea_service_keeps_two_evidence_files_across_imo_and_date_edits() {
            let (root, conn) = fixture();
            let mut work = entity(
                "experience",
                "work-A",
                json!({"vessel_name":"Vessel","position":"Master","imo":"1234567","sign_on":"2026-01-01","created_at":"2026-01-01T00:00:00Z"}),
                Value::Null,
            );
            work["revision"] = json!(1);
            apply_entity(&conn, &root, &work, None).unwrap();
            for (id, bytes) in [
                ("file-A", b"scan one".as_slice()),
                ("file-B", b"scan two".as_slice()),
            ] {
                let mut e = entity(
                    "experience_file",
                    id,
                    json!({"entry_id":"work-A","kind":"<manual>","created_at":null}),
                    json!({"sha256":digest(bytes),"size":bytes.len(),"mime":"application/pdf","filename":"proof.pdf"}),
                );
                e["revision"] = json!(1);
                apply_entity(&conn, &root, &e, Some(bytes)).unwrap();
                write_ledger(&conn, "A", &e, "", None, None).unwrap();
            }
            work["data"]["imo"] = json!("7654321");
            work["data"]["sign_on"] = json!("2026-06-01");
            apply_entity(&conn, &root, &work, None).unwrap();
            let all = scan(&conn, &root, "A").unwrap();
            assert_eq!(
                all.values()
                    .filter(|e| e["kind"] == "experience_file")
                    .count(),
                2
            );
            assert_eq!(
                all["experience_file:file-A"]["blob"]["sha256"],
                digest(b"scan one")
            );
            assert_eq!(
                all["experience_file:file-B"]["blob"]["sha256"],
                digest(b"scan two")
            );
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn profile_explicit_clear_and_ready_preference_do_not_grant_eligibility() {
            let (root, conn) = fixture();
            db::set_vault_info(&conn, "personal_first_name", "previous").unwrap();
            let mut e = entity(
                "profile",
                "main",
                json!({"personal_first_name":null,"personal_ready_for_offers":"true"}),
                Value::Null,
            );
            e["revision"] = json!(1);
            apply_entity(&conn, &root, &e, None).unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT value FROM vault_info WHERE key='personal_first_name'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                ""
            );
            assert_eq!(
                db::get_vault_info_value(&conn, "personal_ready_for_offers").as_deref(),
                Some("false")
            );
            assert_eq!(
                scan(&conn, &root, "A").unwrap()["profile:main"]["data"]
                    ["personal_ready_for_offers"],
                "true"
            );
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn manifest_is_all_or_nothing_and_identity_is_kind_plus_id() {
            let p = entity("profile", "main", json!({}), Value::Null);
            let mut p = p;
            p["revision"] = json!(1);
            let v = json!({"schema":1,"account_id":"public-A","generation":1,"complete":true,"entities":[p]});
            assert!(validate_manifest(&v, "public-A").is_ok());
            assert!(validate_manifest(&v, "public-B").is_err());
            let mut bad = v.clone();
            bad["complete"] = json!(false);
            assert!(validate_manifest(&bad, "public-A").is_err());
            bad = v.clone();
            let duplicate = bad["entities"][0].clone();
            bad["entities"].as_array_mut().unwrap().push(duplicate);
            assert!(validate_manifest(&bad, "public-A").is_err());
        }
        #[test]
        fn recovery_preserves_original_bytes_and_rejects_parent_traversal() {
            let (root, _conn) = fixture();
            let file = root.join("scan.pdf");
            fs::write(&file, b"original").unwrap();
            preserve_file(&root, &file).unwrap();
            fs::write(&file, b"replacement").unwrap();
            assert!(fs::read_dir(root.join("_sync/recovery"))
                .unwrap()
                .any(|e| fs::read(e.unwrap().path()).ok().as_deref() == Some(b"original")));
            assert!(safe_path(&root, Path::new("../outside")).is_err());
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn queue_survives_restart_and_ack_does_not_ack_later_edit() {
            let (root, conn) = fixture();
            let local = entity(
                "profile",
                "main",
                json!({"personal_first_name":"one"}),
                Value::Null,
            );
            let base = entity("profile", "main", Value::Null, Value::Null);
            let pin = Pin {
                path: root.clone(),
                vault: uid(),
                account: "public-A".into(),
                token: "synthetic".into(),
                parent: "synthetic".into(),
                epoch: 0,
            };
            let q = queue_entity(&conn, &root, &pin, &local, &base).unwrap();
            drop(conn);
            let conn = db::open_db(&root).unwrap();
            let persisted = ledger(&conn, "public-A").unwrap();
            assert_eq!(
                persisted["profile:main"]["queued"]["request"]["mutation_id"],
                q["request"]["mutation_id"]
            );
            let mut later = local.clone();
            later["data"]["personal_first_name"] = json!("two");
            assert_ne!(text(&q, "local_hash"), content_hash(&later));
            assert!(ledger(&conn, "public-B").unwrap().is_empty());
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
    }
}
