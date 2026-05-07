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

fn identity_dir(vault_path: &Path) -> PathBuf {
    vault_path.join("_identity")
}

fn secret_key_path(vault_path: &Path) -> PathBuf {
    identity_dir(vault_path).join("sk.bin")
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
