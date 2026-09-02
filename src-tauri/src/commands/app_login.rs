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

use std::sync::Mutex;

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

/// Login accepted BEFORE any vault exists (№162b, App Review 2.1(a) reject №2,
/// 2026-09-02 «we had no option to log in»). The durable store for the token
/// stays the vault (`vault_info`, plaintext, see above) — but on a fresh
/// install the login gate is now the FIRST screen, ahead of the profile wizard
/// that creates the first vault, so at sign-in time there is no vault to
/// write into yet. The accepted login is parked here and persisted into the
/// first vault that opens (`app_login_status` → `persist_pending_login`).
/// Process-scoped: lost on app restart — the user simply signs in again (the
/// gate stays fail-closed; nothing is weakened).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingLogin {
    pub token: String,
    pub email: String,
    pub login_at: String,
}

pub(crate) type PendingLoginSlot = Mutex<Option<PendingLogin>>;

/// Write the three login keys into the open vault.
fn write_login(conn: &Connection, token: &str, email: &str, login_at: &str) -> Result<(), String> {
    db::set_vault_info(conn, USER_TOKEN_KEY, token).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, USER_EMAIL_KEY, email).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, USER_LOGIN_AT_KEY, login_at).map_err(|e| e.to_string())
}

/// Move a parked pre-vault login into the open vault. Returns Ok(true) when
/// the pending login was written. A token already stored in the vault wins
/// (the vault is the authoritative store); the slot is cleared either way so
/// a stale pre-vault login can never leak into a later vault.
pub(crate) fn persist_pending_login(
    conn: &Connection,
    slot: &PendingLoginSlot,
) -> Result<bool, String> {
    let pending = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    let pending = match pending {
        Some(p) => p,
        None => return Ok(false),
    };
    if stored_user_token(conn).is_some() {
        return Ok(false);
    }
    write_login(conn, &pending.token, &pending.email, &pending.login_at)?;
    Ok(true)
}

/// Login status as seen by the startup gate. With an open vault the vault
/// token is authoritative (a parked login is persisted first). Without a
/// vault (fresh install, gate-first screen) only a parked login counts —
/// fail-closed: no login → `logged_in: false`, never an error.
fn login_status_json(conn: Option<&Connection>, slot: &PendingLoginSlot) -> Result<Value, String> {
    match conn {
        Some(conn) => {
            persist_pending_login(conn, slot)?;
            Ok(json!({
                "logged_in": stored_user_token(conn).is_some(),
                "email": db::get_vault_info_value(conn, USER_EMAIL_KEY).unwrap_or_default(),
                "login_at": db::get_vault_info_value(conn, USER_LOGIN_AT_KEY).unwrap_or_default(),
                "pending": false,
            }))
        }
        None => {
            let parked = slot.lock().unwrap_or_else(|e| e.into_inner());
            Ok(json!({
                "logged_in": parked.is_some(),
                "email": parked.as_ref().map(|p| p.email.clone()).unwrap_or_default(),
                "login_at": parked.as_ref().map(|p| p.login_at.clone()).unwrap_or_default(),
                "pending": parked.is_some(),
            }))
        }
    }
}

/// Blocking HTTP client with the login timeouts. Must only be built and used
/// inside `spawn_blocking` tasks: a `reqwest::blocking` client on the async
/// runtime (or the main thread) blocks/panics — that was bug class №140/№162.
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

/// Successful login response: the app-bearer token plus the account's declared
/// role from the server (`seafarer` | `broker` | `crewing` | None). Role drives
/// the per-app policy check (DECISIONS 59/60 «one email = one role»).
struct AppLoginOk {
    token: String,
    role: Option<String>,
}

/// POST {base}/api/app/login {email,password,label} → token + role.
/// Wrong password AND unknown email both return a uniform 403 from the server
/// (no email-existence leak); we surface one honest message for both.
fn post_app_login(
    base: &str,
    client: &reqwest::blocking::Client,
    email: &str,
    password: &str,
    label: &str,
) -> Result<AppLoginOk, String> {
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
            // role may be absent/null (legacy or brand-new seafarer with no
            // declared role yet) — treated as "unset" by the policy check.
            let role = parsed
                .get("role")
                .and_then(|r| r.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Ok(AppLoginOk { token, role })
        }
        _ => Err(format!("assistant.skipi.app returned {status}: {body}")),
    }
}

/// This is the FREE seafarer app. Per-app role check (DECISIONS 59/60 «one
/// email = one role», roles mutually exclusive). Returns Err with a clear,
/// policy-safe message when the account belongs to another app; Ok(()) when
/// the account may use the seafarer app.
///
/// Manager's flagged default (owner may adjust): ALLOW `seafarer` OR unset/null
/// role (legacy/new seafarers may not have a role yet); REJECT explicit
/// `broker` / `crewing`. The rejection does NOT store a token — the login gate
/// stays shown.
fn seafarer_role_allowed(role: Option<&str>) -> Result<(), String> {
    match role {
        Some("broker") => Err(
            "This account is registered as Broker. \
             Please sign in with the Skipi Broker app.\n\
             Этот аккаунт зарегистрирован как Broker. \
             Войдите в приложение Skipi Broker."
                .to_string(),
        ),
        Some("crewing") => Err(
            "This account is registered as Crewing. \
             Please sign in with the Skipi Crewing app.\n\
             Этот аккаунт зарегистрирован как Crewing. \
             Войдите в приложение Skipi Crewing."
                .to_string(),
        ),
        // "seafarer", unset/null, or any unknown value → allowed on this app.
        _ => Ok(()),
    }
}

/// POST {base}/api/app/logout with Authorization: Bearer — best-effort
/// server-side revoke. Failure is non-fatal (we still clear locally).
fn post_app_logout(base: &str, client: &reqwest::blocking::Client, token: &str) {
    let url = format!("{}/api/app/logout", base.trim_end_matches('/'));
    let _ = client.post(&url).bearer_auth(token).send();
}

// ── Tauri commands (explicit user actions only) ─────────────────────────

/// True when a cached login token exists in the open vault — or, with no
/// vault open yet (fresh install), when a login was accepted on the
/// gate-first screen (№162b; persisted into the first vault that opens).
/// Used by the startup gate to decide whether to block the shell. Does NOT
/// hit the network — a cached token allows opening the app offline. Never
/// errors on "no vault": answers fail-closed instead.
#[tauri::command]
pub fn app_login_status(state: State<AppState>) -> Result<Value, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    login_status_json(lock.as_ref(), &state.login_pending)
}

/// Log in with email+password against assistant.skipi.app, store the returned
/// bearer token in the vault — or, when no vault is open yet (fresh install,
/// gate-first screen, №162b), park it in `AppState::login_pending` until the
/// first vault opens. First login requires network.
///
/// Async command (№162, App Review 2.1(a) reject 29.08; same defect class as
/// №140 assistant_chat, fixed mirroring efa5d2f): the old sync version ran on
/// the main thread AND held the vault conn mutex across a blocking login POST
/// (15s timeout) — the reviewer's login never even left the device. Now the
/// vault lock is only taken in short-lived scopes (open-vault check before,
/// token store after); the HTTP round-trip runs in `spawn_blocking` with no
/// lock held.
#[tauri::command]
pub async fn app_login(
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> Result<Value, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() || password.is_empty() {
        return Err("Enter your email and password.".to_string());
    }
    let ok = {
        let email = email.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<AppLoginOk, String> {
            let client = http_client()?;
            let label = format!("Skipi app ({})", std::env::consts::OS);
            post_app_login(&assistant_api_base(), &client, &email, &password, &label)
        })
        .await
        .map_err(|e| format!("app login task failed: {}", e))??
    };
    // Per-app role gate (DECISIONS 59/60): reject foreign roles BEFORE storing
    // the token, so a rejected broker/crewing account never unlocks the shell
    // and no token is persisted (the login gate stays shown).
    seafarer_role_allowed(ok.role.as_deref())?;
    let token = ok.token;
    let login_at = chrono::Utc::now().to_rfc3339();
    // Short-lived lock (no network inside): vault open → store now; no vault
    // yet → park until the first vault opens (persisted by app_login_status).
    let pending = {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        match lock.as_ref() {
            Some(conn) => {
                write_login(conn, &token, &email, &login_at)?;
                false
            }
            None => {
                *state.login_pending.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(PendingLogin {
                        token,
                        email: email.clone(),
                        login_at,
                    });
                true
            }
        }
    };
    Ok(json!({"logged_in": true, "email": email, "pending": pending}))
}

/// Log out: best-effort server-side revoke of the token, then clear it
/// locally. Vault DATA is untouched — the gate is on access, not on data.
///
/// Async command (№162, same pattern as app_login): token read and local
/// clear happen under short-lived vault locks; the best-effort revoke POST
/// runs in `spawn_blocking` with no lock held.
#[tauri::command]
pub async fn app_logout(state: State<'_, AppState>) -> Result<Value, String> {
    // Short-lived lock: read the stored token (vault, or the parked pre-vault
    // login when no vault is open); released before any network.
    let token = {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        match lock.as_ref() {
            Some(conn) => stored_user_token(conn),
            None => state
                .login_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .map(|p| p.token.clone()),
        }
    };
    if let Some(token) = token {
        // Best-effort revoke; ignore network errors AND task-join errors
        // (we still clear locally either way).
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(client) = http_client() {
                post_app_logout(&assistant_api_base(), &client, &token);
            }
        })
        .await;
    }
    {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(conn) = lock.as_ref() {
            for key in [USER_TOKEN_KEY, USER_EMAIL_KEY, USER_LOGIN_AT_KEY] {
                db::set_vault_info(conn, key, "").map_err(|e| e.to_string())?;
            }
        }
        *state.login_pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    Ok(json!({"logged_in": false}))
}

#[cfg(test)]
mod tests {
    //! №162b regression: a login accepted before the first vault exists must
    //! (1) count as logged-in for the gate, (2) land in the first vault that
    //! opens, (3) never override or leak past a token the vault already has.
    use super::*;
    use std::{env, fs, path::PathBuf};
    use uuid::Uuid;

    fn temp_vault() -> (PathBuf, Connection) {
        let path = env::temp_dir().join(format!("skipi-login-gate-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        let conn = db::open_db(&path).unwrap();
        (path, conn)
    }

    fn parked(token: &str) -> PendingLogin {
        PendingLogin {
            token: token.to_string(),
            email: "reviewer@example.com".to_string(),
            login_at: "2026-09-02T00:00:00+00:00".to_string(),
        }
    }

    #[test]
    fn status_without_vault_is_fail_closed_until_a_login_is_parked() {
        let slot: PendingLoginSlot = Mutex::new(None);
        let st = login_status_json(None, &slot).unwrap();
        assert_eq!(st["logged_in"], false, "no vault + no login → gate stays up");
        assert_eq!(st["pending"], false);

        *slot.lock().unwrap() = Some(parked("tok-1"));
        let st = login_status_json(None, &slot).unwrap();
        assert_eq!(st["logged_in"], true, "pre-vault login counts for the gate");
        assert_eq!(st["pending"], true);
        assert_eq!(st["email"], "reviewer@example.com");
        assert!(slot.lock().unwrap().is_some(), "nothing to persist into yet — slot kept");
    }

    #[test]
    fn parked_login_is_persisted_into_the_first_opened_vault() {
        let (path, conn) = temp_vault();
        let slot: PendingLoginSlot = Mutex::new(Some(parked("tok-2")));
        assert!(stored_user_token(&conn).is_none());

        assert!(persist_pending_login(&conn, &slot).unwrap());
        assert_eq!(stored_user_token(&conn).as_deref(), Some("tok-2"));
        assert_eq!(
            db::get_vault_info_value(&conn, USER_EMAIL_KEY).as_deref(),
            Some("reviewer@example.com")
        );
        assert_eq!(
            db::get_vault_info_value(&conn, USER_LOGIN_AT_KEY).as_deref(),
            Some("2026-09-02T00:00:00+00:00")
        );
        assert!(slot.lock().unwrap().is_none(), "slot cleared once persisted");

        let st = login_status_json(Some(&conn), &slot).unwrap();
        assert_eq!(st["logged_in"], true);
        assert_eq!(st["pending"], false, "vault token is now authoritative");

        drop(conn);
        let _ = fs::remove_dir_all(&path);
    }

    #[test]
    fn status_with_vault_persists_a_parked_login_on_first_call() {
        let (path, conn) = temp_vault();
        let slot: PendingLoginSlot = Mutex::new(Some(parked("tok-3")));

        let st = login_status_json(Some(&conn), &slot).unwrap();
        assert_eq!(st["logged_in"], true);
        assert_eq!(stored_user_token(&conn).as_deref(), Some("tok-3"));
        assert!(slot.lock().unwrap().is_none());

        drop(conn);
        let _ = fs::remove_dir_all(&path);
    }

    #[test]
    fn vault_token_wins_and_a_stale_parked_login_never_leaks() {
        let (path, conn) = temp_vault();
        write_login(&conn, "vault-tok", "owner@example.com", "2026-01-01T00:00:00+00:00").unwrap();
        let slot: PendingLoginSlot = Mutex::new(Some(parked("stale")));

        assert!(!persist_pending_login(&conn, &slot).unwrap());
        assert_eq!(stored_user_token(&conn).as_deref(), Some("vault-tok"));
        assert_eq!(
            db::get_vault_info_value(&conn, USER_EMAIL_KEY).as_deref(),
            Some("owner@example.com")
        );
        assert!(slot.lock().unwrap().is_none(), "stale pre-vault login discarded");

        drop(conn);
        let _ = fs::remove_dir_all(&path);
    }

    #[test]
    fn empty_vault_without_parked_login_stays_gated() {
        let (path, conn) = temp_vault();
        let slot: PendingLoginSlot = Mutex::new(None);
        let st = login_status_json(Some(&conn), &slot).unwrap();
        assert_eq!(st["logged_in"], false);
        assert!(stored_user_token(&conn).is_none());
        drop(conn);
        let _ = fs::remove_dir_all(&path);
    }
}
