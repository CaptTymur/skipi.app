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
    let _ = ASSISTANT_API;
    unimplemented_base()
}

fn unimplemented_base() -> String {
    // RED stub — replaced by the real implementation.
    String::new()
}

fn not_implemented<T>() -> Result<T, String> {
    Err("not implemented".to_string())
}

// ── vault-side (Connection-level, unit-testable) ─────────────────────────

/// Import/export are seafarer-vault-only (same gate as other seafarer cmds).
pub(crate) fn require_seafarer_vault(conn: &Connection) -> Result<(), String> {
    let _ = conn;
    not_implemented()
}

/// Stored bearer token; honest error when the device was never linked.
pub(crate) fn stored_device_token(conn: &Connection) -> Result<String, String> {
    let _ = conn;
    not_implemented()
}

/// Read the canonical 38 keys from vault_info; only non-empty values are
/// exported; `personal_photo_path` and legacy aliases are never read.
pub(crate) fn export_profile_fields(conn: &Connection) -> Map<String, Value> {
    let _ = conn;
    Map::new()
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
    let _ = (conn, vault_path, profile);
    let _ = json!({});
    not_implemented()
}

// ── network (base passed in, unit-testable against a local mock) ─────────

/// POST {base}/api/device-pairing/claim {code, label} → plaintext token.
pub(crate) fn claim_device_token(
    base: &str,
    client: &reqwest::blocking::Client,
    code: &str,
    label: &str,
) -> Result<String, String> {
    let _ = (base, client, code, label);
    not_implemented()
}

/// GET {base}/api/seafarer-profile with `Authorization: Bearer` → profile
/// object (the inner {"profile": …} value).
pub(crate) fn fetch_account_profile(
    base: &str,
    client: &reqwest::blocking::Client,
    token: &str,
) -> Result<Value, String> {
    let _ = (base, client, token);
    not_implemented()
}

/// POST {base}/api/seafarer-profile with bearer; body = non-empty canonical
/// fields only (server validates fail-closed).
pub(crate) fn push_account_profile(
    base: &str,
    client: &reqwest::blocking::Client,
    token: &str,
    fields: &Map<String, Value>,
) -> Result<(), String> {
    let _ = (base, client, token, fields);
    not_implemented()
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
