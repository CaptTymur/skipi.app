//! App login (hard gate) — BACKLOG №117, OWNER 2026-08-10
//! («в приложения нужно логиниться»: hard gate, reuse assistant.skipi.app
//! registration as-is).
//!
//! The user registers on assistant.skipi.app (unchanged web flow) and then
//! logs into the packaged app with the SAME email+password. The app POSTs to
//! `assistant.skipi.app/api/app/login` and receives a narrow revocable bearer
//! token (scope `app_full`), which it stores in plaintext in the vault under
//! `skipi_user_token` (the vault is a plain, UNENCRYPTED SQLite file). On
//! startup the frontend blocks the whole shell until a
//! valid token exists; a cached token allows reopening offline (only the FIRST
//! login needs network). Logout revokes the token server-side (best-effort)
//! and clears it locally — WITHOUT wiping any vault data (the gate is on
//! access, not on data).
//!
//! The endpoint lives on assistant.skipi.app (the webapp with the users
//! table), NOT api.skipi.app — same host as account_sync's device pairing.
//! Token is stored plaintext in vault_info, exactly like the existing
//! device-pairing token (`skipi_device_token`). The vault is NOT an encryption
//! boundary — it is a plain SQLite file (0644 perms) on the local filesystem;
//! the boundary is the local filesystem / OS user account, not cryptography.

use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::State;

use crate::commands::account_sync::assistant_api_base;
use crate::db;
use crate::AppState;

/// vault_info key holding the plaintext app-login bearer token.
pub(crate) const USER_TOKEN_KEY: &str = "skipi_user_token";
pub(crate) const USER_EMAIL_KEY: &str = "skipi_user_email";
pub(crate) const USER_LOGIN_AT_KEY: &str = "skipi_user_login_at";

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())
}

/// Stored app-login token (non-empty) or None.
pub(crate) fn stored_user_token(conn: &Connection) -> Option<String> {
    db::get_vault_info_value(conn, USER_TOKEN_KEY)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// POST {base}/api/app/login {email,password,label} → plaintext token.
/// Wrong password AND unknown email both return a uniform 403 from the server
/// (no email-existence leak); we surface one honest message for both.
fn post_app_login(
    base: &str,
    client: &reqwest::blocking::Client,
    email: &str,
    password: &str,
    label: &str,
) -> Result<String, String> {
    let url = format!("{}/api/app/login", base.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&json!({"email": email, "password": password, "label": label}))
        .send()
        .map_err(|e| format!("assistant.skipi.app network: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    match status.as_u16() {
        403 => Err("Wrong email or password.".to_string()),
        429 => Err("Too many attempts. Wait a minute and try again.".to_string()),
        code if (200..300).contains(&code) => {
            let parsed: Value =
                serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;
            let token = parsed
                .get("token")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            if token.is_empty() {
                return Err("assistant.skipi.app returned no token".to_string());
            }
            Ok(token)
        }
        _ => Err(format!("assistant.skipi.app returned {status}: {body}")),
    }
}

/// POST {base}/api/app/logout with Authorization: Bearer — best-effort
/// server-side revoke. Failure is non-fatal (we still clear locally).
fn post_app_logout(base: &str, client: &reqwest::blocking::Client, token: &str) {
    let url = format!("{}/api/app/logout", base.trim_end_matches('/'));
    let _ = client.post(&url).bearer_auth(token).send();
}

// ── Tauri commands (explicit user actions only) ─────────────────────────

/// True when a cached login token exists in the open vault. Used by the
/// startup gate to decide whether to block the shell. Does NOT hit the
/// network — a cached token allows opening the app offline.
#[tauri::command]
pub fn app_login_status(state: State<AppState>) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    Ok(json!({
        "logged_in": stored_user_token(conn).is_some(),
        "email": db::get_vault_info_value(conn, USER_EMAIL_KEY).unwrap_or_default(),
        "login_at": db::get_vault_info_value(conn, USER_LOGIN_AT_KEY).unwrap_or_default(),
    }))
}

/// Log in with email+password against assistant.skipi.app, store the returned
/// bearer token in the vault. First login requires network.
#[tauri::command]
pub fn app_login(
    state: State<AppState>,
    email: String,
    password: String,
) -> Result<Value, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() || password.is_empty() {
        return Err("Enter your email and password.".to_string());
    }
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let client = http_client()?;
    let label = format!("Skipi app ({})", std::env::consts::OS);
    let token = post_app_login(&assistant_api_base(), &client, &email, &password, &label)?;
    db::set_vault_info(conn, USER_TOKEN_KEY, &token).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, USER_EMAIL_KEY, &email).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, USER_LOGIN_AT_KEY, &chrono::Utc::now().to_rfc3339())
        .map_err(|e| e.to_string())?;
    Ok(json!({"logged_in": true, "email": email}))
}

/// Log out: best-effort server-side revoke of the token, then clear it
/// locally. Vault DATA is untouched — the gate is on access, not on data.
#[tauri::command]
pub fn app_logout(state: State<AppState>) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    if let Some(token) = stored_user_token(conn) {
        // Best-effort revoke; ignore network errors (we still clear locally).
        if let Ok(client) = http_client() {
            post_app_logout(&assistant_api_base(), &client, &token);
        }
    }
    for key in [USER_TOKEN_KEY, USER_EMAIL_KEY, USER_LOGIN_AT_KEY] {
        db::set_vault_info(conn, key, "").map_err(|e| e.to_string())?;
    }
    Ok(json!({"logged_in": false}))
}
