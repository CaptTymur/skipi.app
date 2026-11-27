//! The vessel as the crew's shared space (My Vessel → `@skipi/vessel`).
//!
//! Owner, 27.11.2026 (case 265): «моряк может зачекиниться на судне. и судно становится
//! общим пространством для тех кто на нем зачекинен»; «судно будет только одно по имо
//! номеру. и один моряк будет зарегистрирован на одном судне»; «базовую функцию можно
//! сделать — доска объявлений».
//!
//! Check-ins and notices live with the Skipi account on assistant.skipi.app
//! (`webapp/vessel_space.py`); every call needs the signed-in account. The page never
//! holds the account token: these commands take it from the app's own session.

use serde_json::{json, Value};
use tauri::State;

use crate::commands::plugin_reviews::{
    cap, run, session_token, Call, MAX_REASON_CHARS, MAX_TEXT_CHARS,
};
use crate::AppState;

const MAX_NAME_CHARS: usize = 80;

/// An IMO number: seven digits, the last one a check digit
/// (`d1*7 + d2*6 + … + d6*2`, mod 10). Anything else never reaches a URL.
fn valid_imo(imo: &str) -> bool {
    let b = imo.as_bytes();
    if b.len() != 7 || !b.iter().all(u8::is_ascii_digit) {
        return false;
    }
    let sum: u32 = b[..6]
        .iter()
        .zip((2..=7).rev())
        .map(|(d, w)| u32::from(d - b'0') * w)
        .sum();
    sum % 10 == u32::from(b[6] - b'0')
}

fn imo_or_err(imo: &str) -> Result<&str, String> {
    if valid_imo(imo) {
        Ok(imo)
    } else {
        Err("bad_imo".to_string())
    }
}

fn token_or_err(state: &State<'_, AppState>) -> Result<String, String> {
    session_token(state).ok_or_else(|| "sign_in".to_string())
}

/// `{vessel: null}` or `{vessel: {imo, name}, since, crew, notices, more}`.
#[tauri::command]
pub async fn vessel_space_me(state: State<'_, AppState>) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run("/api/app/vessel/me".to_string(), Call::Get, Some(token)).await
}

/// What is known about a vessel before checking in: `{imo, name | null, source, crew_count}`.
#[tauri::command]
pub async fn vessel_space_lookup(state: State<'_, AppState>, imo: String) -> Result<Value, String> {
    let imo = imo_or_err(&imo)?.to_string();
    let token = token_or_err(&state)?;
    run(
        format!("/api/app/vessel/lookup/{}", imo),
        Call::Get,
        Some(token),
    )
    .await
}

/// Check in on a vessel; `name` names a vessel nobody has checked in on before.
#[tauri::command]
pub async fn vessel_space_checkin(
    state: State<'_, AppState>,
    imo: String,
    name: Option<String>,
) -> Result<Value, String> {
    let imo = imo_or_err(&imo)?.to_string();
    let token = token_or_err(&state)?;
    run(
        "/api/app/vessel/checkin".to_string(),
        Call::Post(json!({ "imo": imo, "name": cap(name, MAX_NAME_CHARS) })),
        Some(token),
    )
    .await
}

#[tauri::command]
pub async fn vessel_space_leave(state: State<'_, AppState>) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(
        "/api/app/vessel/leave".to_string(),
        Call::Post(json!({})),
        Some(token),
    )
    .await
}

/// A further page of the notice board: `{notices, more}`.
#[tauri::command]
pub async fn vessel_notices_list(
    state: State<'_, AppState>,
    offset: Option<u32>,
) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(
        format!("/api/app/vessel/notices?offset={}", offset.unwrap_or(0)),
        Call::Get,
        Some(token),
    )
    .await
}

#[tauri::command]
pub async fn vessel_notice_post(state: State<'_, AppState>, text: String) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(
        "/api/app/vessel/notices".to_string(),
        Call::Post(json!({ "text": cap(Some(text), MAX_TEXT_CHARS) })),
        Some(token),
    )
    .await
}

#[tauri::command]
pub async fn vessel_notice_delete(
    state: State<'_, AppState>,
    notice_id: u64,
) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(
        format!("/api/app/vessel/notices/{}", notice_id),
        Call::Delete,
        Some(token),
    )
    .await
}

/// Report someone else's notice to the owner.
#[tauri::command]
pub async fn vessel_notice_report(
    state: State<'_, AppState>,
    notice_id: u64,
    reason: Option<String>,
) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(
        format!("/api/app/vessel/notices/{}/report", notice_id),
        Call::Post(json!({ "reason": cap(reason, MAX_REASON_CHARS) })),
        Some(token),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_imo_number_reaches_a_url() {
        for ok in ["9074729", "9319466", "9176187"] {
            assert!(valid_imo(ok), "{ok}");
        }
        for bad in [
            "", "9074728", "907472", "90747291", "IMO9074729", "907472９", "90747/9", "../etc", "9074 29",
        ] {
            assert!(!valid_imo(bad), "{bad}");
        }
        assert_eq!(imo_or_err("../etc"), Err("bad_imo".to_string()));
    }
}
