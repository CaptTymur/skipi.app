// Vault identity — Ed25519 keypair stored once at vault creation and reused
// for the entire lifetime of the vault. Implements inv. I-1 from
// docs/ARCHITECTURE_PHASE2.md.
//
// Rationale. In phase 2 the matchmaking server needs a stable way to say
// "this is the same seafarer as yesterday, even though they reinstalled the
// app". A per-vault Ed25519 pair gives us that:
//   * The private key is generated once, on first create_*_vault call, and
//     written to `<vault>/_identity/sk.bin` as 32 raw bytes.
//   * The public key and a derived `user_id` (base32 of sha256(pubkey)) are
//     stored in vault_info so everything that needs to know "who owns this
//     vault" can read it with a single get_vault_info_value call.
//   * Moving a vault from Mac to Windows just copies the file — the
//     identity travels with it.
//
// Nothing in phase 1 actually *uses* the keypair. It sits there waiting for
// phase 2, and the investment now is tiny compared to retrofitting identity
// onto thousands of existing vaults later.
//
// Security note. In phase 1 `sk.bin` is written unencrypted next to
// `skipi.db`. That matches the current threat model: an attacker with
// read access to the vault folder already has everything (DB, PDFs, photo).
// Phase 2 will add OS-keychain storage + optional passphrase encryption —
// but the *format* of sk.bin stays the same (32 raw bytes), so that change
// will be opt-in and non-breaking.

use crate::db;
use data_encoding::BASE32_NOPAD;
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// Current identity scheme version. If we ever migrate to a new signature
/// algorithm we bump this and keep the old path around for legacy vaults.
pub const IDENTITY_VERSION: u32 = 1;
const RECOVERY_KEY_PREFIX: &str = "SKIPI-RECOVERY-V1";

fn identity_dir(vault_path: &Path) -> PathBuf {
    vault_path.join("_identity")
}

fn secret_key_path(vault_path: &Path) -> PathBuf {
    identity_dir(vault_path).join("sk.bin")
}

fn grouped(s: &str, group_size: usize) -> String {
    s.as_bytes()
        .chunks(group_size)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .collect::<Vec<_>>()
        .join("-")
}

fn recovery_key_from_secret(secret: &[u8; 32]) -> String {
    let encoded = BASE32_NOPAD.encode(secret);
    format!("{}-{}", RECOVERY_KEY_PREFIX, grouped(&encoded, 4))
}

fn parse_recovery_key(input: &str) -> Result<[u8; 32], String> {
    let normalized = input.trim().to_ascii_uppercase();
    let prefix = format!("{}-", RECOVERY_KEY_PREFIX);
    let body = normalized
        .strip_prefix(&prefix)
        .ok_or_else(|| "Recovery key must start with SKIPI-RECOVERY-V1".to_string())?;
    let compact = body
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>();
    let bytes = BASE32_NOPAD
        .decode(compact.as_bytes())
        .map_err(|_| "Invalid recovery key format".to_string())?;
    if bytes.len() != 32 {
        return Err(format!(
            "Recovery key decodes to {} bytes, expected 32",
            bytes.len()
        ));
    }
    let mut secret = [0u8; 32];
    secret.copy_from_slice(&bytes);
    Ok(secret)
}

/// Derive a compact, human-friendlyish user_id from the raw public key.
/// Format: first 16 chars of lowercase base32 of sha256(pubkey). 16 chars
/// of base32 = 80 bits of entropy which is plenty for a client-side handle
/// and short enough to appear in logs without being unwieldy.
fn derive_user_id(pubkey: &[u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pubkey);
    let digest = hasher.finalize();
    let encoded = BASE32_NOPAD.encode(&digest);
    encoded.chars().take(16).collect::<String>().to_lowercase()
}

/// Public derivation of the vault user_id from an Ed25519 public key, using the
/// exact same scheme the app uses everywhere. Exposed for the On Board crew
/// accept signer so it returns a `vault_user_id` consistent with this identity.
pub fn user_id_for_pubkey(pubkey: &[u8; 32]) -> String {
    derive_user_id(pubkey)
}

/// Load (or first-time create) the vault's Ed25519 signing key WITHOUT needing a
/// db connection. Mirrors the key half of `ensure_vault_identity`. Used only by
/// the On Board crew accept signer.
pub fn vault_signing_key(vault_path: &Path) -> Result<SigningKey, String> {
    let dir = identity_dir(vault_path);
    fs::create_dir_all(&dir).map_err(|e| format!("identity dir: {}", e))?;
    let sk_path = secret_key_path(vault_path);
    if sk_path.exists() {
        let bytes = fs::read(&sk_path).map_err(|e| format!("read sk.bin: {}", e))?;
        if bytes.len() != 32 {
            return Err(format!("sk.bin is {} bytes, expected 32", bytes.len()));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        Ok(SigningKey::from_bytes(&arr))
    } else {
        let mut csprng = OsRng;
        let sk = SigningKey::generate(&mut csprng);
        let tmp = sk_path.with_extension("tmp");
        fs::write(&tmp, sk.to_bytes()).map_err(|e| format!("write sk.tmp: {}", e))?;
        fs::rename(&tmp, &sk_path).map_err(|e| format!("rename sk.bin: {}", e))?;
        Ok(sk)
    }
}

/// Canonicalise a crew invite code EXACTLY as the backend's `_canon` does
/// (`(raw or "").strip().upper()`), so the signed message matches byte-for-byte.
/// The valid code charset is ASCII, where Rust `to_uppercase()` == Python
/// `str.upper()`.
fn canon_crew_code(code: &str) -> String {
    code.trim().to_uppercase()
}

/// Build the canonical On Board crew-accept message the seafarer signs. Must be
/// byte-for-byte identical to the backend `accept_message()` in
/// `app/onboard_crew.py`:
///   skipi-onboard-crew:v1:accept:<public_seafarer_id>:<vault_user_id>:<CANON(code)>:<ts>
/// vessel_imo is intentionally NOT in the message (the server resolves it from
/// the code). This is the ONLY thing this signer will ever sign — there is no
/// generic arbitrary-bytes signer.
pub fn onboard_crew_accept_message(
    public_seafarer_id: &str,
    vault_user_id: &str,
    code: &str,
    ts: i64,
) -> String {
    format!(
        "skipi-onboard-crew:v1:accept:{}:{}:{}:{}",
        public_seafarer_id,
        vault_user_id,
        canon_crew_code(code),
        ts
    )
}

/// Build the canonical self-signature message for registering the vault's
/// Ed25519 identity key. Must match the backend `identity_key_register_message()`
/// in `app/identity_service.py` byte-for-byte:
///   skipi-seafarer-identity-key:v1:<vault_user_id>:<identity_pubkey_b64>
/// Signing it with the vault key proves the registrant controls the private key.
/// A second specific message (not a generic signer).
pub fn identity_key_register_message(vault_user_id: &str, identity_pubkey_b64: &str) -> String {
    format!(
        "skipi-seafarer-identity-key:v1:{}:{}",
        vault_user_id, identity_pubkey_b64
    )
}

fn normalize_identity_part(value: Option<String>) -> Option<String> {
    let normalized = value?
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect::<String>();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn display_identity_name(conn: &Connection) -> String {
    let first = db::get_vault_info_value(conn, "personal_first_name").unwrap_or_default();
    let surname = db::get_vault_info_value(conn, "personal_surname").unwrap_or_default();
    let name = [first.trim(), surname.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if !name.is_empty() {
        return name;
    }
    db::get_vault_info_value(conn, "name").unwrap_or_else(|| "Unnamed vault".to_string())
}

fn identity_canonical_string(conn: &Connection) -> Option<String> {
    let first = normalize_identity_part(db::get_vault_info_value(conn, "personal_first_name"))?;
    let surname = normalize_identity_part(db::get_vault_info_value(conn, "personal_surname"))?;
    let dob = normalize_identity_part(db::get_vault_info_value(conn, "personal_dob"))?;
    Some(format!("{first}|{surname}|{dob}"))
}

pub fn calculate_identity_fingerprint(conn: &Connection) -> Option<String> {
    let canonical = identity_canonical_string(conn)?;
    let mut hasher = Sha256::new();
    hasher.update(b"skipi-local-identity-fingerprint-v1\0");
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    Some(format!("idfp1_{}", &hex::encode(digest)[..24]))
}

pub fn sync_identity_fingerprint(conn: &Connection) -> Result<Option<String>, String> {
    let fingerprint = calculate_identity_fingerprint(conn);
    db::set_vault_info(conn, "identity_fingerprint_version", "1").map_err(|e| e.to_string())?;
    db::set_vault_info(
        conn,
        "identity_fingerprint",
        fingerprint.as_deref().unwrap_or(""),
    )
    .map_err(|e| e.to_string())?;
    Ok(fingerprint)
}

fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a.to_string_lossy() == b.to_string_lossy(),
    }
}

fn related_vault_json(conn: &Connection, path: &Path, relation: &str) -> serde_json::Value {
    serde_json::json!({
        "path": path.to_string_lossy(),
        "name": display_identity_name(conn),
        "date_of_birth": db::get_vault_info_value(conn, "personal_dob"),
        "nationality": db::get_vault_info_value(conn, "personal_nationality"),
        "user_id": db::get_vault_info_value(conn, "user_id"),
        "relation": relation,
    })
}

pub fn get_identity_trust_status(
    conn: &Connection,
    vault_path: &Path,
    recent_paths: Vec<String>,
) -> Result<serde_json::Value, String> {
    ensure_vault_identity(conn, vault_path)?;
    let current_user_id = db::get_vault_info_value(conn, "user_id").unwrap_or_default();
    let current_fingerprint = sync_identity_fingerprint(conn)?;

    let mut possible_duplicates = Vec::new();
    let mut linked_copies = Vec::new();

    if let Some(fp) = current_fingerprint.as_deref().filter(|s| !s.is_empty()) {
        let mut seen_paths = std::collections::HashSet::new();
        for raw in recent_paths {
            if raw.trim().is_empty() {
                continue;
            }
            if !seen_paths.insert(raw.clone()) {
                continue;
            }
            let path = PathBuf::from(&raw);
            if same_path(vault_path, &path) || !path.join("skipi.db").is_file() {
                continue;
            }
            let Ok(other_conn) = db::open_db(&path) else {
                continue;
            };
            let other_fp = db::get_vault_info_value(&other_conn, "identity_fingerprint")
                .filter(|s| !s.trim().is_empty())
                .or_else(|| calculate_identity_fingerprint(&other_conn));
            if other_fp.as_deref() != Some(fp) {
                continue;
            }
            let other_user_id =
                db::get_vault_info_value(&other_conn, "user_id").unwrap_or_default();
            if !other_user_id.is_empty() && other_user_id == current_user_id {
                linked_copies.push(related_vault_json(&other_conn, &path, "same_identity_copy"));
            } else {
                possible_duplicates.push(related_vault_json(
                    &other_conn,
                    &path,
                    "possible_duplicate",
                ));
            }
        }
    }

    let status = if current_fingerprint
        .as_deref()
        .map(|s| s.is_empty())
        .unwrap_or(true)
    {
        "incomplete"
    } else if !possible_duplicates.is_empty() {
        "possible_duplicate"
    } else {
        "unique"
    };
    db::set_vault_info(conn, "identity_trust_status", status).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "status": status,
        "user_id": current_user_id,
        "identity_fingerprint": current_fingerprint,
        "fingerprint_version": 1,
        "server_identity": {
            "public_seafarer_id": db::get_vault_info_value(conn, "skipi_public_seafarer_id").filter(|s| !s.trim().is_empty()),
            "claim_status": db::get_vault_info_value(conn, "skipi_identity_claim_status").filter(|s| !s.trim().is_empty()),
            "duplicate": db::get_vault_info_value(conn, "skipi_identity_duplicate").map(|s| s == "true").unwrap_or(false),
            "trust_level": db::get_vault_info_value(conn, "skipi_identity_trust_level").filter(|s| !s.trim().is_empty()),
            "message": db::get_vault_info_value(conn, "skipi_identity_message").filter(|s| !s.trim().is_empty()),
            "last_claim_at": db::get_vault_info_value(conn, "skipi_identity_last_claim_at").filter(|s| !s.trim().is_empty()),
            "has_recovery_key": db::get_vault_info_value(conn, "skipi_identity_recovery_key").map(|s| !s.trim().is_empty()).unwrap_or(false),
        },
        "profile": {
            "name": display_identity_name(conn),
            "date_of_birth": db::get_vault_info_value(conn, "personal_dob"),
            "nationality": db::get_vault_info_value(conn, "personal_nationality"),
        },
        "possible_duplicates": possible_duplicates,
        "linked_copies": linked_copies,
    }))
}

/// Ensure that `<vault>/_identity/sk.bin` exists. If it does, load the
/// keypair from it; otherwise generate a fresh one. Either way, write the
/// public key and derived `user_id` into `vault_info`.
///
/// Called from create_*_vault paths AFTER reset_vault_content so the
/// identity survives any content wipe. This function is idempotent —
/// calling it on an existing vault is a no-op beyond re-stamping vault_info.
pub fn ensure_vault_identity(conn: &Connection, vault_path: &Path) -> Result<(), String> {
    let dir = identity_dir(vault_path);
    fs::create_dir_all(&dir).map_err(|e| format!("identity dir: {}", e))?;

    let sk_path = secret_key_path(vault_path);
    let signing: SigningKey = if sk_path.exists() {
        let bytes = fs::read(&sk_path).map_err(|e| format!("read sk.bin: {}", e))?;
        if bytes.len() != 32 {
            return Err(format!(
                "sk.bin is {} bytes, expected 32 — refusing to overwrite",
                bytes.len()
            ));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        SigningKey::from_bytes(&arr)
    } else {
        let mut csprng = OsRng;
        let sk = SigningKey::generate(&mut csprng);
        // Write atomically-ish: tmp + rename to avoid leaving a half-written
        // file if the process dies mid-write.
        let tmp = sk_path.with_extension("tmp");
        fs::write(&tmp, sk.to_bytes()).map_err(|e| format!("write sk.tmp: {}", e))?;
        fs::rename(&tmp, &sk_path).map_err(|e| format!("rename sk.bin: {}", e))?;
        sk
    };

    let verifying: VerifyingKey = signing.verifying_key();
    let pub_bytes: [u8; 32] = verifying.to_bytes();
    let pub_hex = hex::encode(pub_bytes);
    let user_id = derive_user_id(&pub_bytes);

    db::set_vault_info(conn, "identity_pubkey", &pub_hex).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, "user_id", &user_id).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, "identity_version", &IDENTITY_VERSION.to_string())
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Install an existing recovery key before ensure_vault_identity() stamps the
/// public identity into vault_info. Used when a seafarer creates a vault on a
/// second device and wants to keep the same Skipi identity.
pub fn install_recovery_key(vault_path: &Path, recovery_key: &str) -> Result<(), String> {
    let secret = parse_recovery_key(recovery_key)?;
    let dir = identity_dir(vault_path);
    fs::create_dir_all(&dir).map_err(|e| format!("identity dir: {}", e))?;
    let sk_path = secret_key_path(vault_path);
    if sk_path.exists() {
        let existing = fs::read(&sk_path).map_err(|e| format!("read sk.bin: {}", e))?;
        if existing.as_slice() == secret {
            return Ok(());
        }
        return Err("This vault already has a different identity key".to_string());
    }
    let tmp = sk_path.with_extension("tmp");
    fs::write(&tmp, secret).map_err(|e| format!("write sk.tmp: {}", e))?;
    fs::rename(&tmp, &sk_path).map_err(|e| format!("rename sk.bin: {}", e))?;
    Ok(())
}

/// Return the human-visible vault recovery material for Settings.
///
/// `recovery_key` is the encoded signing secret from `_identity/sk.bin`. It is
/// enough to recreate the same vault identity on another device, so the UI must
/// keep it hidden until the seafarer explicitly reveals or copies it.
pub fn get_vault_identity_key(
    conn: &Connection,
    vault_path: &Path,
) -> Result<serde_json::Value, String> {
    ensure_vault_identity(conn, vault_path)?;

    let bytes = fs::read(secret_key_path(vault_path)).map_err(|e| format!("read sk.bin: {}", e))?;
    if bytes.len() != 32 {
        return Err(format!(
            "sk.bin is {} bytes, expected 32 - cannot show recovery key",
            bytes.len()
        ));
    }
    let mut secret = [0u8; 32];
    secret.copy_from_slice(&bytes);
    let signing = SigningKey::from_bytes(&secret);
    let pub_bytes: [u8; 32] = signing.verifying_key().to_bytes();

    Ok(serde_json::json!({
        "version": IDENTITY_VERSION,
        "user_id": derive_user_id(&pub_bytes),
        "identity_pubkey": hex::encode(pub_bytes),
        "identity_fingerprint": sync_identity_fingerprint(conn)?,
        "recovery_key": recovery_key_from_secret(&secret),
        "profile": {
            "name": db::get_vault_info_value(conn, "name"),
            "surname": db::get_vault_info_value(conn, "personal_surname"),
            "first_name": db::get_vault_info_value(conn, "personal_first_name"),
            "date_of_birth": db::get_vault_info_value(conn, "personal_dob"),
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_key_is_readable_and_unpadded() {
        let secret = [0u8; 32];
        let key = recovery_key_from_secret(&secret);
        assert!(key.starts_with("SKIPI-RECOVERY-V1-"));
        assert!(!key.contains('='));
        assert!(key
            .trim_start_matches("SKIPI-RECOVERY-V1-")
            .split('-')
            .all(|part| part.len() == 4));
    }

    #[test]
    fn recovery_key_roundtrips_secret() {
        let mut secret = [0u8; 32];
        secret[0] = 42;
        secret[31] = 7;
        let key = recovery_key_from_secret(&secret);
        assert_eq!(parse_recovery_key(&key).unwrap(), secret);
        assert_eq!(
            parse_recovery_key(&key.to_ascii_lowercase()).unwrap(),
            secret
        );
    }

    #[test]
    fn vault_identity_key_export_is_stable() {
        let vault_path =
            std::env::temp_dir().join(format!("skipi-identity-key-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();
        db::set_vault_info(&conn, "name", "Test Seafarer").unwrap();
        db::set_vault_info(&conn, "personal_first_name", "Ivan").unwrap();
        db::set_vault_info(&conn, "personal_surname", "Petrov").unwrap();
        db::set_vault_info(&conn, "personal_dob", "1988-02-03").unwrap();

        let first = get_vault_identity_key(&conn, &vault_path).unwrap();
        let second = get_vault_identity_key(&conn, &vault_path).unwrap();

        assert_eq!(first["recovery_key"], second["recovery_key"]);
        assert_eq!(first["user_id"], second["user_id"]);
        assert_eq!(first["profile"]["first_name"], "Ivan");
        assert_eq!(first["profile"]["surname"], "Petrov");
        assert_eq!(first["profile"]["date_of_birth"], "1988-02-03");
        assert!(first["recovery_key"]
            .as_str()
            .unwrap()
            .starts_with("SKIPI-RECOVERY-V1-"));

        drop(conn);
        let _ = fs::remove_dir_all(&vault_path);
    }

    #[test]
    fn installed_recovery_key_controls_new_vault_identity() {
        let source_secret = [9u8; 32];
        let recovery_key = recovery_key_from_secret(&source_secret);
        let vault_path = std::env::temp_dir().join(format!(
            "skipi-identity-install-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&vault_path).unwrap();
        let conn = db::open_db(&vault_path).unwrap();

        install_recovery_key(&vault_path, &recovery_key).unwrap();
        let exported = get_vault_identity_key(&conn, &vault_path).unwrap();

        assert_eq!(
            exported["recovery_key"].as_str().unwrap(),
            recovery_key.as_str()
        );

        drop(conn);
        let _ = fs::remove_dir_all(&vault_path);
    }

    fn seed_identity_profile(conn: &Connection, first: &str, surname: &str, dob: &str) {
        db::set_vault_info(conn, "personal_first_name", first).unwrap();
        db::set_vault_info(conn, "personal_surname", surname).unwrap();
        db::set_vault_info(conn, "personal_dob", dob).unwrap();
        db::set_vault_info(conn, "personal_nationality", "Ukrainian").unwrap();
    }

    #[test]
    fn identity_fingerprint_detects_duplicate_candidates() {
        let a = std::env::temp_dir().join(format!("skipi-id-a-{}", uuid::Uuid::new_v4()));
        let b = std::env::temp_dir().join(format!("skipi-id-b-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let conn_a = db::open_db(&a).unwrap();
        let conn_b = db::open_db(&b).unwrap();
        ensure_vault_identity(&conn_a, &a).unwrap();
        ensure_vault_identity(&conn_b, &b).unwrap();
        seed_identity_profile(&conn_a, "Mikhail", "Petrov", "1990-01-02");
        seed_identity_profile(&conn_b, "mikhail", "petrov", "1990-01-02");

        let status = get_identity_trust_status(
            &conn_a,
            &a,
            vec![
                a.to_string_lossy().to_string(),
                b.to_string_lossy().to_string(),
            ],
        )
        .unwrap();

        assert_eq!(status["status"], "possible_duplicate");
        assert_eq!(status["possible_duplicates"].as_array().unwrap().len(), 1);
        assert_eq!(status["linked_copies"].as_array().unwrap().len(), 0);

        drop(conn_a);
        drop(conn_b);
        let _ = fs::remove_dir_all(a);
        let _ = fs::remove_dir_all(b);
    }

    #[test]
    fn same_recovery_key_is_linked_copy_not_duplicate() {
        let a = std::env::temp_dir().join(format!("skipi-id-copy-a-{}", uuid::Uuid::new_v4()));
        let b = std::env::temp_dir().join(format!("skipi-id-copy-b-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let conn_a = db::open_db(&a).unwrap();
        ensure_vault_identity(&conn_a, &a).unwrap();
        seed_identity_profile(&conn_a, "Mikhail", "Petrov", "1990-01-02");
        let key = get_vault_identity_key(&conn_a, &a).unwrap()["recovery_key"]
            .as_str()
            .unwrap()
            .to_string();

        install_recovery_key(&b, &key).unwrap();
        let conn_b = db::open_db(&b).unwrap();
        ensure_vault_identity(&conn_b, &b).unwrap();
        seed_identity_profile(&conn_b, "Mikhail", "Petrov", "1990-01-02");

        let status = get_identity_trust_status(
            &conn_a,
            &a,
            vec![
                a.to_string_lossy().to_string(),
                b.to_string_lossy().to_string(),
            ],
        )
        .unwrap();

        assert_eq!(status["status"], "unique");
        assert_eq!(status["possible_duplicates"].as_array().unwrap().len(), 0);
        assert_eq!(status["linked_copies"].as_array().unwrap().len(), 1);

        drop(conn_a);
        drop(conn_b);
        let _ = fs::remove_dir_all(a);
        let _ = fs::remove_dir_all(b);
    }

    // --- On Board crew accept signer (PR C) ---

    #[test]
    fn crew_accept_message_is_byte_for_byte_canonical() {
        // Lower-case + surrounding whitespace in the code must be canonicalised
        // (strip + UPPER) exactly like the backend `_canon`.
        let msg = onboard_crew_accept_message(
            "SKP-SF-ABC123",
            "abcd1234ef567890",
            "  k7p49qxz  ",
            1750000000,
        );
        assert_eq!(
            msg,
            "skipi-onboard-crew:v1:accept:SKP-SF-ABC123:abcd1234ef567890:K7P49QXZ:1750000000"
        );
    }

    #[test]
    fn identity_key_register_message_is_byte_for_byte_canonical() {
        // Must match backend identity_key_register_message() exactly.
        let msg = identity_key_register_message("abcd1234ef567890", "Aa+/Bb==");
        assert_eq!(
            msg,
            "skipi-seafarer-identity-key:v1:abcd1234ef567890:Aa+/Bb=="
        );
    }

    #[test]
    fn identity_key_self_signature_verifies() {
        use ed25519_dalek::{Signer, Verifier};
        use base64::Engine;
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk: VerifyingKey = sk.verifying_key();
        let b64 = base64::engine::general_purpose::STANDARD;
        let pub_b64 = b64.encode(vk.to_bytes());
        let uid = user_id_for_pubkey(&vk.to_bytes());
        let msg = identity_key_register_message(&uid, &pub_b64);
        let sig = sk.sign(msg.as_bytes());
        assert!(vk.verify(msg.as_bytes(), &sig).is_ok());
    }

    // Emits a real identity-key registration self-signature for a LIVE smoke
    // against POST /api/seafarer-identity/identity-key.
    // Run: `cargo test --lib identkey_emit -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn identkey_emit_for_live_smoke() {
        use ed25519_dalek::Signer;
        use base64::Engine;
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let vk = sk.verifying_key();
        let b64 = base64::engine::general_purpose::STANDARD;
        let pub_b64 = b64.encode(vk.to_bytes());
        let uid = user_id_for_pubkey(&vk.to_bytes());
        let msg = identity_key_register_message(&uid, &pub_b64);
        let sig = b64.encode(sk.sign(msg.as_bytes()).to_bytes());
        println!("IDK vault_user_id={}", uid);
        println!("IDK identity_pubkey_b64={}", pub_b64);
        println!("IDK signature={}", sig);
    }

    #[test]
    fn crew_accept_message_omits_vessel_imo_and_keeps_field_order() {
        // No vessel_imo segment; exactly 7 colon-separated head fields + ts.
        let msg = onboard_crew_accept_message("SKP-SF-X", "vault01", "ABCD", 42);
        assert_eq!(msg, "skipi-onboard-crew:v1:accept:SKP-SF-X:vault01:ABCD:42");
        assert!(!msg.contains("9415271"));
    }

    #[test]
    fn crew_accept_signature_verifies_against_returned_pubkey() {
        use ed25519_dalek::{Signer, Verifier};
        // Deterministic key for the test (the real command loads the vault key).
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk: VerifyingKey = sk.verifying_key();
        let pub_bytes = vk.to_bytes();
        let vault_user_id = user_id_for_pubkey(&pub_bytes);

        let ts = 1750000123i64;
        let msg = onboard_crew_accept_message("SKP-SF-TEST", &vault_user_id, "k7p49qxz", ts);
        let sig = sk.sign(msg.as_bytes());

        // The server verifies the SAME bytes against the registered pubkey.
        assert!(vk.verify(msg.as_bytes(), &sig).is_ok());

        // A tampered timestamp must NOT verify (consent is bound to the message).
        let bad = onboard_crew_accept_message("SKP-SF-TEST", &vault_user_id, "k7p49qxz", ts + 1);
        assert!(vk.verify(bad.as_bytes(), &sig).is_err());
    }

    // Emits a real Rust signature for cross-verification against the Python
    // backend's verify_vault_signature(). Run: `cargo test --lib crew_emit -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn crew_accept_emit_for_interop() {
        use ed25519_dalek::Signer;
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pub_bytes = sk.verifying_key().to_bytes();
        let vault_user_id = user_id_for_pubkey(&pub_bytes);
        let ts = 1750000123i64;
        let msg = onboard_crew_accept_message("SKP-SF-TEST", &vault_user_id, "k7p49qxz", ts);
        let sig = sk.sign(msg.as_bytes());
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        println!("INTEROP pubkey_b64={}", b64.encode(pub_bytes));
        println!("INTEROP vault_user_id={}", vault_user_id);
        println!("INTEROP message={}", msg);
        println!("INTEROP signature_b64={}", b64.encode(sig.to_bytes()));
    }

    #[test]
    fn vault_user_id_derivation_matches_identity_scheme() {
        // user_id_for_pubkey must equal the canonical derive_user_id (16 lc base32).
        let pubkey = [9u8; 32];
        let id = user_id_for_pubkey(&pubkey);
        assert_eq!(id, derive_user_id(&pubkey));
        assert_eq!(id.len(), 16);
        assert_eq!(id, id.to_lowercase());
    }
}
