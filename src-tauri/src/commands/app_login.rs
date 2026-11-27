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
/// vault_info key holding the account role the session was signed in with.
pub(crate) const USER_ROLE_KEY: &str = "skipi_user_role";

/// One app, modules by account role (owner 25.11.2026): the role the server
/// returned at sign-in, normalised to the three known ones. Absent, empty or
/// unknown → `seafarer` (legacy and brand-new seafarer accounts carry no role).
pub(crate) fn account_role(role: Option<&str>) -> &'static str {
    match role.map(str::trim) {
        Some("crewing") => "crewing",
        Some("broker") => "broker",
        _ => "seafarer",
    }
}

/// The role a local cache was created for (its `account_type`).
fn vault_role(conn: &Connection) -> &'static str {
    account_role(db::get_vault_info_value(conn, "account_type").as_deref())
}

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
    pub account_id: Option<String>,
    pub role: &'static str,
}

pub(crate) type PendingLoginSlot = Mutex<Option<PendingLogin>>;

/// Sign-in failure classified on the Rust side (tasks/003, 2026-11-20). The
/// frontend maps `code` to a text in the UI language and never parses
/// `detail` (English, technical — shown small under the main text for
/// `other`, logged for the rest).
///
/// Codes: `network` (request never got an HTTP answer: offline, DNS, timeout,
/// refused), `credentials` (403 — wrong password OR unknown email, uniform by
/// design), `rate_limited` (429), `rejected` (login refused for a reason the
/// user must read as-is: foreign role, profile bound to another account),
/// `other` (anything else — server 5xx, bad JSON, local vault write).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct LoginError {
    pub code: &'static str,
    pub detail: String,
}

impl LoginError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        LoginError {
            code,
            detail: detail.into(),
        }
    }
    fn other(detail: impl Into<String>) -> Self {
        LoginError::new("other", detail)
    }
    fn rejected(detail: impl Into<String>) -> Self {
        LoginError::new("rejected", detail)
    }
    /// Classify an HTTP answer from `/api/app/login` that is not a success.
    fn from_status(status: u16, body: &str) -> Self {
        match status {
            403 => LoginError::new("credentials", format!("HTTP 403: {}", body.trim())),
            429 => LoginError::new("rate_limited", format!("HTTP 429: {}", body.trim())),
            code => LoginError::other(format!("assistant.skipi.app returned {code}: {}", body.trim())),
        }
    }
}

/// Plain-string failures (vault I/O, task join, JSON) are `other`.
impl From<String> for LoginError {
    fn from(detail: String) -> Self {
        LoginError::other(detail)
    }
}

/// Write the login keys into the open vault.
fn write_login(
    conn: &Connection,
    token: &str,
    email: &str,
    login_at: &str,
    role: &str,
) -> Result<(), String> {
    db::set_vault_info(conn, USER_TOKEN_KEY, token).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, USER_ROLE_KEY, role).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, USER_EMAIL_KEY, email).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, USER_LOGIN_AT_KEY, login_at).map_err(|e| e.to_string())
}

fn check_sync_account(conn: &Connection, account: Option<&str>) -> Result<(), String> {
    if let Some(bound) = db::get_vault_info_value(conn, "sync_account_id").filter(|v| !v.is_empty())
    {
        if account != Some(bound.as_str()) {
            return Err("This local profile is linked to another account. Open a separate profile for this account.".into());
        }
    }
    Ok(())
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
    if vault_role(conn) != pending.role {
        return Err("This local profile belongs to an account with another role.".into());
    }
    check_sync_account(conn, pending.account_id.as_deref())?;
    if stored_user_token(conn).is_some() {
        return Ok(false);
    }
    write_login(
        conn,
        &pending.token,
        &pending.email,
        &pending.login_at,
        pending.role,
    )?;
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
                "role": account_role(db::get_vault_info_value(conn, USER_ROLE_KEY).as_deref()),
                "pending": false,
            }))
        }
        None => {
            let parked = slot.lock().unwrap_or_else(|e| e.into_inner());
            Ok(json!({
                "logged_in": parked.is_some(),
                "email": parked.as_ref().map(|p| p.email.clone()).unwrap_or_default(),
                "login_at": parked.as_ref().map(|p| p.login_at.clone()).unwrap_or_default(),
                "role": parked.as_ref().map(|p| p.role).unwrap_or("seafarer"),
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
        .redirect(reqwest::redirect::Policy::none())
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
    account_id: Option<String>,
}

/// POST {base}/api/app/login {email,password,label} → token + role.
/// Wrong password AND unknown email both return a uniform 403 from the server
/// (no email-existence leak); both map to one code, `credentials`.
fn post_app_login(
    base: &str,
    client: &reqwest::blocking::Client,
    email: &str,
    password: &str,
    label: &str,
) -> Result<AppLoginOk, LoginError> {
    let url = format!("{}/api/app/login", base.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&json!({"email": email, "password": password, "label": label}))
        .send()
        .map_err(|e| LoginError::new("network", e.to_string()))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    match status.as_u16() {
        code if (200..300).contains(&code) => {
            let parsed: Value = serde_json::from_str(&body)
                .map_err(|e| LoginError::other(format!("bad JSON: {e}")))?;
            let token = parsed
                .get("token")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            if token.is_empty() {
                return Err(LoginError::other("assistant.skipi.app returned no token"));
            }
            // role may be absent/null (legacy or brand-new seafarer with no
            // declared role yet) — treated as "unset" by the policy check.
            let role = parsed
                .get("role")
                .and_then(|r| r.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let account_id = parsed
                .get("account_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Ok(AppLoginOk {
                token,
                role,
                account_id,
            })
        }
        code => Err(LoginError::from_status(code, &body)),
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
) -> Result<Value, LoginError> {
    crate::commands::account_sync::vault_sync::invalidate(&state);
    let epoch = state.sync_epoch.load(std::sync::atomic::Ordering::SeqCst);
    let email = email.trim().to_lowercase();
    if email.is_empty() || password.is_empty() {
        return Err(LoginError::rejected("Enter your email and password."));
    }
    let ok = {
        let email = email.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<AppLoginOk, LoginError> {
            let client = http_client()?;
            let label = format!("Skipi app ({})", std::env::consts::OS);
            post_app_login(&assistant_api_base(), &client, &email, &password, &label)
        })
        .await
        .map_err(|e| format!("app login task failed: {}", e))??
    };
    // One app for every role (owner 25.11.2026): seafarer, crewing and broker
    // accounts all sign in here; the role decides the module set. A session is
    // only ever written into a local cache of the SAME role. Signing in over an
    // open cache of another role parks the login instead (`profile_mismatch`):
    // the frontend closes that cache and opens the one for this role.
    let role = account_role(ok.role.as_deref());
    let stored: Result<(bool, bool), LoginError> = (|| {
        let login_at = chrono::Utc::now().to_rfc3339();
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        if state.sync_epoch.load(std::sync::atomic::Ordering::SeqCst) != epoch {
            return Err(LoginError::other(
                "Vault or account changed during sign in; please retry.",
            ));
        }
        match lock.as_ref() {
            Some(conn) if vault_role(conn) == role => {
                check_sync_account(conn, ok.account_id.as_deref()).map_err(LoginError::rejected)?;
                write_login(conn, &ok.token, &email, &login_at, role)?;
                Ok((false, false))
            }
            other => {
                *state
                    .login_pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(PendingLogin {
                    token: ok.token.clone(),
                    email: email.clone(),
                    login_at,
                    account_id: ok.account_id.clone(),
                    role,
                });
                Ok((true, other.is_some()))
            }
        }
    })();
    let (pending, profile_mismatch) = match stored {
        Ok(outcome) => outcome,
        Err(reason) => {
            let rejected_token = ok.token;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Ok(client) = http_client() {
                    post_app_logout(&assistant_api_base(), &client, &rejected_token);
                }
            })
            .await;
            return Err(reason);
        }
    };
    Ok(json!({
        "logged_in": true,
        "email": email,
        "pending": pending,
        "role": role,
        "profile_mismatch": profile_mismatch,
    }))
}

/// Log out: best-effort server-side revoke of the token, then clear it
/// locally. Vault DATA is untouched — the gate is on access, not on data.
///
/// Async command (№162, same pattern as app_login): token read and local
/// clear happen under short-lived vault locks; the best-effort revoke POST
/// runs in `spawn_blocking` with no lock held.
#[tauri::command]
pub async fn app_logout(state: State<'_, AppState>) -> Result<Value, String> {
    crate::commands::account_sync::vault_sync::invalidate(&state);
    let token = {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let token = match lock.as_ref() {
            Some(conn) => stored_user_token(conn),
            None => state
                .login_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .map(|p| p.token.clone()),
        };
        if let Some(conn) = lock.as_ref() {
            for key in [
                USER_TOKEN_KEY,
                USER_EMAIL_KEY,
                USER_LOGIN_AT_KEY,
                "sync_token",
                "sync_enabled",
                "sync_parent_hash",
            ] {
                db::set_vault_info(conn, key, "").map_err(|e| e.to_string())?;
            }
        }
        *state
            .login_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        token
    };
    if let Some(token) = token {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(client) = http_client() {
                post_app_logout(&assistant_api_base(), &client, &token);
            }
        })
        .await;
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

    #[test]
    fn pending_other_account_cannot_open_an_already_bound_vault() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE vault_info(key TEXT PRIMARY KEY,value TEXT)")
            .unwrap();
        db::set_vault_info(&conn, "sync_account_id", "public-A").unwrap();
        assert!(check_sync_account(&conn, Some("public-B")).is_err());
        assert!(check_sync_account(&conn, None).is_err());
        assert!(check_sync_account(&conn, Some("public-A")).is_ok());
        let slot = Mutex::new(Some(PendingLogin {
            token: "synthetic-B".into(),
            email: "b@example.test".into(),
            login_at: "test".into(),
            account_id: Some("public-B".into()),
            role: "seafarer",
        }));
        assert!(persist_pending_login(&conn, &slot).is_err());
        assert!(stored_user_token(&conn).is_none());
    }
    fn parked(token: &str) -> PendingLogin {
        PendingLogin {
            token: token.to_string(),
            email: "reviewer@example.com".to_string(),
            login_at: "2026-09-02T00:00:00+00:00".to_string(),
            account_id: None,
            role: "seafarer",
        }
    }

    /// tasks/018: one app, modules by account role. Every role signs in; the
    /// session lands only in a local cache created for the same role.
    #[test]
    fn every_account_role_signs_in_and_the_role_is_kept_with_the_session() {
        assert_eq!(account_role(Some("crewing")), "crewing");
        assert_eq!(account_role(Some("broker")), "broker");
        assert_eq!(account_role(Some("seafarer")), "seafarer");
        assert_eq!(account_role(Some("something-new")), "seafarer");
        assert_eq!(account_role(None), "seafarer");

        let slot = Mutex::new(Some(PendingLogin {
            role: "crewing",
            ..parked("tok-crewing")
        }));
        let st = login_status_json(None, &slot).unwrap();
        assert_eq!(st["logged_in"], true);
        assert_eq!(st["role"], "crewing");

        let (path, conn) = temp_vault();
        db::set_vault_info(&conn, "account_type", "crewing").unwrap();
        let st = login_status_json(Some(&conn), &slot).unwrap();
        assert_eq!(st["logged_in"], true);
        assert_eq!(st["role"], "crewing");
        assert_eq!(
            db::get_vault_info_value(&conn, USER_ROLE_KEY).as_deref(),
            Some("crewing")
        );
        drop(conn);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn a_parked_login_never_lands_in_a_cache_of_another_role() {
        let (path, conn) = temp_vault();
        db::set_vault_info(&conn, "account_type", "seafarer").unwrap();
        let slot = Mutex::new(Some(PendingLogin {
            role: "crewing",
            ..parked("tok-crewing")
        }));
        assert!(persist_pending_login(&conn, &slot).is_err());
        assert!(stored_user_token(&conn).is_none());
        assert!(slot.lock().unwrap().is_none());
        drop(conn);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn status_without_vault_is_fail_closed_until_a_login_is_parked() {
        let slot: PendingLoginSlot = Mutex::new(None);
        let st = login_status_json(None, &slot).unwrap();
        assert_eq!(
            st["logged_in"], false,
            "no vault + no login → gate stays up"
        );
        assert_eq!(st["pending"], false);

        *slot.lock().unwrap() = Some(parked("tok-1"));
        let st = login_status_json(None, &slot).unwrap();
        assert_eq!(st["logged_in"], true, "pre-vault login counts for the gate");
        assert_eq!(st["pending"], true);
        assert_eq!(st["email"], "reviewer@example.com");
        assert!(
            slot.lock().unwrap().is_some(),
            "nothing to persist into yet — slot kept"
        );
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
        assert!(
            slot.lock().unwrap().is_none(),
            "slot cleared once persisted"
        );

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
        write_login(
            &conn,
            "vault-tok",
            "owner@example.com",
            "2026-01-01T00:00:00+00:00",
            "seafarer",
        )
        .unwrap();
        let slot: PendingLoginSlot = Mutex::new(Some(parked("stale")));

        assert!(!persist_pending_login(&conn, &slot).unwrap());
        assert_eq!(stored_user_token(&conn).as_deref(), Some("vault-tok"));
        assert_eq!(
            db::get_vault_info_value(&conn, USER_EMAIL_KEY).as_deref(),
            Some("owner@example.com")
        );
        assert!(
            slot.lock().unwrap().is_none(),
            "stale pre-vault login discarded"
        );

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

    // tasks/003 (2026-11-20): the failure reaches the frontend as a code, not
    // as an English sentence to be parsed.
    #[test]
    fn login_error_codes_follow_http_status() {
        assert_eq!(LoginError::from_status(403, "forbidden").code, "credentials");
        assert_eq!(LoginError::from_status(429, "slow down").code, "rate_limited");
        let e = LoginError::from_status(502, "bad gateway");
        assert_eq!(e.code, "other");
        assert!(e.detail.contains("502") && e.detail.contains("bad gateway"));
    }

    #[test]
    fn login_error_from_plain_string_is_other_and_serializes_as_object() {
        let e: LoginError = "disk full".to_string().into();
        assert_eq!(e, LoginError::other("disk full"));
        let v = serde_json::to_value(&LoginError::new("network", "dns failure")).unwrap();
        assert_eq!(v["code"], "network");
        assert_eq!(v["detail"], "dns failure");
        assert_eq!(LoginError::rejected("role").code, "rejected");
    }
}
