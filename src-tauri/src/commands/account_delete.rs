//! Account deletion from INSIDE the app — App Store Guideline 5.1.1(v).
//!
//! An app that lets a user create an account must let the same user delete it
//! without leaving the app. Skipi Seafarer has a Register door on its first
//! screen, so the requirement applies to the shipping build. The whole path is
//! native: Settings → Account → Delete → confirm with the account password.
//! Nothing here opens a browser, and nothing here is a link — a reviewer who
//! is handed a URL reports «the account cannot be deleted in the app».
//!
//! Server contract (assistant.skipi.app, same host and same bearer token as
//! `/api/app/login`; checks run in this order: token → password present →
//! rate-limit → password → delete):
//!
//! ```text
//! POST /api/app/account/delete
//! Authorization: Bearer <token from /api/app/login>
//! {"password": "<the user's current password>"}
//!
//! 200 {"deleted": true, "completes_at": null}   completes_at may be null
//! 400 {"error": "bad_request"}                  no password sent
//! 401 {"error": "invalid_token"}                unknown/revoked/foreign token
//!                                               (a repeat call after deletion
//!                                               lands here too)
//! 403 {"error": "invalid_password"}
//! 429 {"error": "too_many_attempts"}            5 per account / 20 per IP, 900s
//! ```
//!
//! WHAT THIS COMMAND DOES NOT DO — and it is a contract, not an oversight:
//! it never touches the local vault DATA or any document file on the device.
//! Deleting the Skipi account and wiping the phone are different acts; the
//! user is told so on the confirmation screen in words, and the drill
//! DEL2 (`tests/bundled_plugin_isolation_harness.mjs`) fails this build if a
//! file-removal / vault-closing call ever appears in this file. The only
//! local write on success is clearing the three login keys (token, email,
//! login time) — the token is dead server-side the instant the account is
//! gone, and leaving it behind would keep the shell unlocked against an
//! account that no longer exists. That is session state, not user data, and
//! is exactly what `app_logout` already clears.
//!
//! Timing: the response may carry `completes_at`. When the server does not
//! name a moment (null/absent), the app promises no deadline of its own —
//! rule (324). The value is passed to the UI untouched.

use serde_json::{json, Value};
use tauri::State;

use crate::commands::account_sync::assistant_api_base;
use crate::commands::app_login::stored_user_token;
use crate::AppState;

/// The three vault_info keys that make up a signed-in session. Cleared on a
/// successful deletion — the same keys `app_logout` clears, and nothing else.
const SESSION_KEYS: [&str; 3] = [
    crate::commands::app_login::USER_TOKEN_KEY,
    crate::commands::app_login::USER_EMAIL_KEY,
    crate::commands::app_login::USER_LOGIN_AT_KEY,
];

fn delete_url(base: &str) -> String {
    format!("{}/api/app/account/delete", base.trim_end_matches('/'))
}

/// Blocking HTTP client with the login-family timeouts. A local copy on
/// purpose: `app_login::http_client` and `account_sync::http_client` are both
/// private to their modules, and the gate route authorised for this change
/// (`mobile-189-native`) does not include either file, so widening one of them
/// is not available here. Same 15s/4s budget, same rule — build and use it
/// only inside `spawn_blocking`: a `reqwest::blocking` client on the async
/// runtime blocks or panics (bug class №140/№162).
fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())
}

/// Every documented status code gets ONE honest bilingual sentence (EN then
/// RU) the user can act on. Two of them say, in as many words, that the
/// account is still there — a failed deletion that reads like a success is
/// worse than an error.
pub(crate) fn delete_error_message(status: u16, body: &str) -> String {
    match status {
        400 => "Enter your current password to confirm deletion.\n\
                Введите текущий пароль, чтобы подтвердить удаление."
            .to_string(),
        401 => "Your sign-in has expired or was revoked. Sign in again, then repeat the deletion.\n\
                Вход истёк или был отозван. Войдите заново и повторите удаление."
            .to_string(),
        403 => "Wrong password — the account was NOT deleted. Check the password you use to sign in to Skipi.\n\
                Неверный пароль — аккаунт НЕ удалён. Проверьте пароль, которым вы входите в Skipi."
            .to_string(),
        429 => "Too many attempts — the account was NOT deleted. Wait 15 minutes and try again.\n\
                Слишком много попыток — аккаунт НЕ удалён. Подождите 15 минут и попробуйте снова."
            .to_string(),
        _ => format!(
            "assistant.skipi.app returned {status} — the account was NOT deleted. \
             Try again later.\nassistant.skipi.app ответил {status} — аккаунт НЕ удалён. \
             Попробуйте позже.{}",
            if body.trim().is_empty() {
                String::new()
            } else {
                format!("\n{}", body.trim())
            }
        ),
    }
}

/// POST the deletion. Returns the parsed success payload: `deleted` plus the
/// server's own `completes_at` (kept as-is, including `null`).
fn post_account_delete(
    base: &str,
    client: &reqwest::blocking::Client,
    token: &str,
    password: &str,
) -> Result<Value, String> {
    let resp = client
        .post(delete_url(base))
        .bearer_auth(token)
        .json(&json!({ "password": password }))
        .send()
        .map_err(|e| format!("assistant.skipi.app network: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(delete_error_message(status.as_u16(), &body));
    }
    Ok(parse_delete_ok(&body)?)
}

/// A 2xx is only a deletion when the body says so. A body that parses but
/// does not claim `deleted: true` is treated as a failure — the user must
/// never be told the account is gone on the strength of a status code alone.
pub(crate) fn parse_delete_ok(body: &str) -> Result<Value, String> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|e| format!("assistant.skipi.app sent an unreadable answer: {e}"))?;
    if parsed.get("deleted").and_then(|d| d.as_bool()) != Some(true) {
        return Err(
            "assistant.skipi.app did not confirm the deletion — the account may still exist.\n\
             assistant.skipi.app не подтвердил удаление — аккаунт может быть на месте."
                .to_string(),
        );
    }
    // `completes_at` is the server's word, never ours: absent or null means
    // the app names no deadline at all (rule (324)).
    let completes_at = parsed.get("completes_at").cloned().unwrap_or(Value::Null);
    Ok(json!({ "deleted": true, "completes_at": completes_at }))
}

// ── Tauri command ────────────────────────────────────────────────────────

/// Delete the signed-in Skipi account on the server, confirming with the
/// account password. Async for the same reason `app_login` is (№162): the
/// vault mutex is only held in short-lived scopes, never across the network
/// round-trip.
///
/// On success the local session keys are cleared so the shell falls back to
/// the login gate. The vault file, its documents and every file on disk are
/// left exactly as they were.
#[tauri::command]
pub async fn delete_account(state: State<'_, AppState>, password: String) -> Result<Value, String> {
    if password.trim().is_empty() {
        return Err(delete_error_message(400, ""));
    }
    // Short-lived lock: read the session token (from the open vault, or from a
    // login parked before the first vault exists — №162b). Released before any
    // network call.
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
    let token = match token {
        Some(t) => t,
        None => return Err(delete_error_message(401, "")),
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let client = http_client()?;
        post_account_delete(&assistant_api_base(), &client, &token, &password)
    })
    .await
    .map_err(|e| format!("account delete task failed: {e}"))??;

    // The account is gone; the token it belonged to is dead. Clear the session
    // so the app cannot keep pretending to be signed in. Vault DATA untouched.
    {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(conn) = lock.as_ref() {
            for key in SESSION_KEYS {
                crate::db::set_vault_info(conn, key, "").map_err(|e| e.to_string())?;
            }
        }
        *state.login_pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_is_the_agreed_endpoint_on_whatever_base_is_configured() {
        assert_eq!(
            delete_url("https://assistant.skipi.app"),
            "https://assistant.skipi.app/api/app/account/delete"
        );
        assert_eq!(
            delete_url("https://assistant.skipi.app/"),
            "https://assistant.skipi.app/api/app/account/delete",
            "a trailing slash must not produce a double slash"
        );
    }

    #[test]
    fn every_documented_status_gets_its_own_bilingual_message() {
        for (code, en_marker, ru_marker) in [
            (400u16, "Enter your current password", "Введите текущий пароль"),
            (401, "Sign in again", "Войдите заново"),
            (403, "Wrong password", "Неверный пароль"),
            (429, "Too many attempts", "Слишком много попыток"),
        ] {
            let msg = delete_error_message(code, "{\"error\":\"x\"}");
            assert!(msg.contains(en_marker), "{code} EN: {msg}");
            assert!(msg.contains(ru_marker), "{code} RU: {msg}");
        }
        let other = delete_error_message(500, "boom");
        assert!(other.contains("500") && other.contains("NOT deleted"));
    }

    #[test]
    fn a_failed_deletion_says_the_account_is_still_there() {
        // The three codes that mean "nothing was deleted" must say so, or the
        // user closes the screen believing the account is gone.
        for code in [403u16, 429, 500] {
            let msg = delete_error_message(code, "");
            assert!(
                msg.contains("NOT deleted") && msg.contains("НЕ удалён"),
                "{code} must state the account survived: {msg}"
            );
        }
    }

    #[test]
    fn success_passes_the_servers_completes_at_through_untouched() {
        let null_case = parse_delete_ok("{\"deleted\": true, \"completes_at\": null}").unwrap();
        assert_eq!(null_case["deleted"], true);
        assert!(null_case["completes_at"].is_null(), "no server deadline → none invented");

        let dated = parse_delete_ok("{\"deleted\": true, \"completes_at\": \"2026-10-06T00:00:00Z\"}")
            .unwrap();
        assert_eq!(dated["completes_at"], "2026-10-06T00:00:00Z");

        let absent = parse_delete_ok("{\"deleted\": true}").unwrap();
        assert!(absent["completes_at"].is_null(), "absent field is null, not an error");
    }

    #[test]
    fn a_two_hundred_that_does_not_confirm_deletion_is_not_a_success() {
        for body in ["{\"deleted\": false}", "{}", "{\"deleted\": \"true\"}"] {
            let err = parse_delete_ok(body).unwrap_err();
            assert!(
                err.contains("did not confirm") && err.contains("не подтвердил"),
                "body {body} must not read as a deletion: {err}"
            );
        }
        assert!(parse_delete_ok("not json").unwrap_err().contains("unreadable"));
    }
}
