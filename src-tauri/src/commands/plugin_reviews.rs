//! Ratings and reviews of plugins (Apps → a plugin's page).
//!
//! Owner, 25.11.2026: «возможность публиковать отзывы на плагины и давать оценку»;
//! «текст можно не модерировать, публиковать сразу».
//!
//! The reviews live with the Skipi account on assistant.skipi.app
//! (`webapp/plugin_reviews.py`). Reading is open; rating, removing and reporting
//! need the signed-in account. The page never holds the account token: these
//! commands take it from the app's own session and talk to the server.

use serde_json::{json, Value};
use tauri::State;

use crate::commands::account_sync::assistant_api_base;
use crate::commands::app_login::stored_user_token;
use crate::AppState;

const MAX_TEXT_CHARS: usize = 2000;
const MAX_REASON_CHARS: usize = 500;

/// A plugin slug as the catalog writes it; anything else never reaches a URL.
fn valid_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn slug_or_err(slug: &str) -> Result<&str, String> {
    if valid_slug(slug) {
        Ok(slug)
    } else {
        Err("unknown plugin".to_string())
    }
}

fn cap(text: Option<String>, limit: usize) -> String {
    text.unwrap_or_default().chars().take(limit).collect()
}

/// What the page is told when the server refuses. The codes are stable: the page
/// shows its own wording for each.
fn refusal(status: u16, body: &Value) -> String {
    match status {
        401 | 403 => "sign_in".to_string(),
        404 => "not_found".to_string(),
        _ => body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("failed")
            .to_string(),
    }
}

/// Must only be built and used inside `spawn_blocking` (see `app_login::http_client`).
fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|_| "offline".to_string())
}

fn session_token(state: &State<'_, AppState>) -> Option<String> {
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
}

enum Call {
    Get,
    Put(Value),
    Delete,
    Post(Value),
}

fn send(path: String, call: Call, token: Option<String>) -> Result<Value, String> {
    let client = http_client()?;
    let url = format!("{}{}", assistant_api_base(), path);
    let mut request = match call {
        Call::Get => client.get(&url),
        Call::Put(body) => client.put(&url).json(&body),
        Call::Delete => client.delete(&url),
        Call::Post(body) => client.post(&url).json(&body),
    };
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|_| "offline".to_string())?;
    let status = response.status().as_u16();
    let body: Value = response.json().unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        Ok(body)
    } else {
        Err(refusal(status, &body))
    }
}

async fn run(path: String, call: Call, token: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || send(path, call, token))
        .await
        .map_err(|_| "failed".to_string())?
}

/// `{ratings: {slug: {average, count}}}` for the whole catalog. Open.
#[tauri::command]
pub async fn plugin_ratings() -> Result<Value, String> {
    run("/api/app/plugins/ratings".to_string(), Call::Get, None).await
}

/// `{rating, reviews: [{id, stars, text, updated_at, mine}], more, mine, signed_in}` for one plugin.
#[tauri::command]
pub async fn plugin_reviews_list(
    state: State<'_, AppState>,
    slug: String,
    offset: Option<u32>,
) -> Result<Value, String> {
    let slug = slug_or_err(&slug)?.to_string();
    let token = session_token(&state);
    let signed_in = token.is_some();
    let path = format!(
        "/api/app/plugins/{}/reviews?offset={}",
        slug,
        offset.unwrap_or(0)
    );
    let mut body = run(path, Call::Get, token).await?;
    if let Some(map) = body.as_object_mut() {
        map.insert("signed_in".to_string(), json!(signed_in));
    }
    Ok(body)
}

/// Rate a plugin 1–5 with an optional text; replaces the account's earlier review.
#[tauri::command]
pub async fn plugin_review_save(
    state: State<'_, AppState>,
    slug: String,
    stars: u8,
    text: Option<String>,
    lang: Option<String>,
    version: Option<String>,
) -> Result<Value, String> {
    let slug = slug_or_err(&slug)?.to_string();
    if !(1..=5).contains(&stars) {
        return Err("bad_stars".to_string());
    }
    let token = session_token(&state).ok_or_else(|| "sign_in".to_string())?;
    let body = json!({ "stars": stars, "text": cap(text, MAX_TEXT_CHARS), "lang": lang, "version": version });
    run(
        format!("/api/app/plugins/{}/review", slug),
        Call::Put(body),
        Some(token),
    )
    .await
}

#[tauri::command]
pub async fn plugin_review_delete(
    state: State<'_, AppState>,
    slug: String,
) -> Result<Value, String> {
    let slug = slug_or_err(&slug)?.to_string();
    let token = session_token(&state).ok_or_else(|| "sign_in".to_string())?;
    run(
        format!("/api/app/plugins/{}/review", slug),
        Call::Delete,
        Some(token),
    )
    .await
}

/// Report someone else's review to the owner.
#[tauri::command]
pub async fn plugin_review_report(
    state: State<'_, AppState>,
    slug: String,
    review_id: u64,
    reason: Option<String>,
) -> Result<Value, String> {
    let slug = slug_or_err(&slug)?.to_string();
    let token = session_token(&state).ok_or_else(|| "sign_in".to_string())?;
    run(
        format!("/api/app/plugins/{}/reviews/{}/report", slug, review_id),
        Call::Post(json!({ "reason": cap(reason, MAX_REASON_CHARS) })),
        Some(token),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_catalog_slug_reaches_a_url() {
        for ok in ["marine-clinometer", "bnwas-time-anchor", "a", "9lives"] {
            assert!(valid_slug(ok), "{ok}");
        }
        let long = "a".repeat(65);
        for bad in [
            "",
            "-x",
            "Bad",
            "a/b",
            "../etc",
            "a b",
            "a?x=1",
            "a%2f",
            "ä",
            long.as_str(),
        ] {
            assert!(!valid_slug(bad), "{bad}");
        }
        assert_eq!(slug_or_err("../etc"), Err("unknown plugin".to_string()));
    }

    #[test]
    fn text_is_capped_by_characters_not_bytes() {
        assert_eq!(
            cap(Some("я".repeat(5000)), MAX_TEXT_CHARS).chars().count(),
            2000
        );
        assert_eq!(cap(None, MAX_TEXT_CHARS), "");
        assert_eq!(cap(Some("ok".into()), MAX_REASON_CHARS), "ok");
    }

    #[test]
    fn a_refusal_becomes_a_stable_code() {
        assert_eq!(refusal(401, &Value::Null), "sign_in");
        assert_eq!(refusal(403, &json!({"error": "wrong_role"})), "sign_in");
        assert_eq!(refusal(404, &Value::Null), "not_found");
        assert_eq!(refusal(400, &json!({"error": "own_review"})), "own_review");
        assert_eq!(refusal(500, &Value::Null), "failed");
    }
}
