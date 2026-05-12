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
}
