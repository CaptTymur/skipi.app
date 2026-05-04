// Review identity material. Kept deliberately separate from
// `_identity/sk.bin` (the crewing-facing vault identity) so a hostile
// crewing party cannot cross-link a seafarer's apply/messaging activity
// with their vessel reviews. The raw review_pubkey is sent only with the
// review request; the server stores a secret-derived reviewer_hash.

use crate::AppState;
use base64::Engine;
use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

fn review_sk_path(vault: &Path) -> PathBuf {
    vault.join("_identity").join("review_sk.bin")
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
