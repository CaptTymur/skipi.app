//! Crew Flow of the crewing role (tasks/018, owner 25.11.2026: one Skipi app,
//! one sign-in, «чтобы я мог залогиниться в skipi с аккаунтом crewing… и
//! продолжать пилот»).
//!
//! The app is signed in on assistant.skipi.app only. The Crewing server accepts
//! that sign-in: the stored app token is presented once to
//! `POST /api/app/login/skipi-account`, which answers with the server's own
//! application session; `POST /api/app/crewing/bootstrap` then issues the
//! short-lived workspace credential every `/api/crewings/{id}/…` read uses.
//! No second password exists anywhere.
//!
//! Everything this module keeps lives in the account cache (`vault_info`) of
//! the signed-in crewing account: the server's application session, the current
//! workspace credential and the forwarding address once revealed (each reveal
//! writes an audit row on the server, so it is asked once per address).
//!
//! The frontend never sees a credential: one command returns the screen's data.

use serde_json::{json, Value};
use tauri::State;

use crate::commands::app_login::stored_user_token;
use crate::db;
use crate::AppState;

const CREWING_ORIGIN: &str = "https://crewing.skipi.app";
/// Origins the bootstrap answer may name as the workspace server.
const TRUSTED_ORIGINS: [&str; 4] = [
    "https://crewing.skipi.app",
    "https://api.skipi.app",
    "https://api-ru.skipi.app",
    "https://api.skipi.app:8444",
];
const SESSION_KEY: &str = "crewing_app_session";
const CONNECTION_KEY: &str = "crewing_connection";
const ADDRESS_KEY: &str = "crewing_intake_address";
const QUEUE_LIMIT: u32 = 50;

/// Sign-in origin of the Crewing server. Debug builds may point it at a
/// loopback stand (same rule as `assistant_api_base`).
fn crewing_origin() -> String {
    #[cfg(debug_assertions)]
    {
        if let Ok(base) = std::env::var("SKIPI_CREWING_API_BASE") {
            if let Ok(url) = reqwest::Url::parse(base.trim()) {
                if url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "10.0.2.2"))
                    && url.port().is_some()
                    && url.path() == "/"
                {
                    return base.trim().trim_end_matches('/').to_string();
                }
            }
        }
    }
    CREWING_ORIGIN.to_string()
}

fn trusted_server(url: &str) -> bool {
    TRUSTED_ORIGINS.contains(&url) || url == crewing_origin()
}

/// A failure the frontend maps to a text by `code`; `detail` is technical.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct CrewingError {
    pub code: &'static str,
    pub detail: String,
}

impl CrewingError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        CrewingError {
            code,
            detail: detail.into(),
        }
    }
}

/// Classify a refusal of the Crewing server. Bodies are `{"error": code}`
/// (account routes), `{"detail": text}` (workspace routes) or the trial gate's
/// `{"code": "trial_expired"}`.
fn refusal(status: u16, body: &str) -> CrewingError {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let word = parsed
        .get("error")
        .or_else(|| parsed.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let code = match (status, word) {
        (_, "trial_expired") => "trial_expired",
        (_, "account_not_provisioned") | (_, "entitlement_missing") => "no_workspace",
        (_, "scope_denied") => "not_crewing",
        (401, _) | (_, "login_required") | (_, "invalid_credentials") => "login_required",
        (429, _) => "rate_limited",
        (404, _) => "not_available",
        _ => "other",
    };
    let shown: String = body.trim().chars().take(300).collect();
    CrewingError::new(code, format!("HTTP {status}: {shown}"))
}

fn http_client() -> Result<reqwest::blocking::Client, CrewingError> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| CrewingError::new("other", e.to_string()))
}

fn read(resp: reqwest::blocking::Response) -> Result<Value, CrewingError> {
    let status = resp.status().as_u16();
    let body = resp.text().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(refusal(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| CrewingError::new("other", format!("bad JSON: {e}")))
}

fn post(
    client: &reqwest::blocking::Client,
    url: &str,
    bearer: Option<&str>,
    body: Value,
) -> Result<Value, CrewingError> {
    let mut request = client.post(url).json(&body);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    read(request
        .send()
        .map_err(|e| CrewingError::new("network", e.to_string()))?)
}

fn get(client: &reqwest::blocking::Client, url: &str, bearer: &str) -> Result<Value, CrewingError> {
    read(client
        .get(url)
        .bearer_auth(bearer)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| CrewingError::new("network", e.to_string()))?)
}

/// What the account cache holds between calls.
#[derive(Clone, Debug, Default, PartialEq)]
struct Kept {
    session: Option<String>,
    connection: Option<Value>,
    address: Option<Value>,
}

/// The workspace credential is usable when it names a trusted server and has
/// more than a minute left.
fn connection_live(connection: &Value, now: chrono::DateTime<chrono::Utc>) -> bool {
    let field = |k: &str| connection.get(k).and_then(Value::as_str).unwrap_or("");
    let expires = chrono::DateTime::parse_from_rfc3339(field("expires_at"))
        .map(|t| t.with_timezone(&chrono::Utc));
    trusted_server(field("server_url"))
        && !field("workspace_id").is_empty()
        && field("bearer_token").starts_with("skn_")
        && matches!(expires, Ok(t) if t > now + chrono::Duration::seconds(60))
}

fn bootstrap(
    client: &reqwest::blocking::Client,
    origin: &str,
    session: &str,
) -> Result<Value, CrewingError> {
    // Never creates a workspace: this app continues an existing one.
    let answer = post(
        client,
        &format!("{origin}/api/app/crewing/bootstrap"),
        Some(session),
        json!({"create_if_missing": false}),
    )?;
    let connection = answer.get("connection").cloned().unwrap_or(Value::Null);
    if !connection_live(&connection, chrono::Utc::now()) {
        return Err(CrewingError::new(
            "other",
            "the Crewing server answered with an unusable workspace connection",
        ));
    }
    Ok(connection)
}

/// A live workspace connection: the kept one, or a fresh one from the kept
/// application session, or — when that session is gone — from the Skipi sign-in.
fn connect(
    client: &reqwest::blocking::Client,
    user_token: &str,
    kept: &mut Kept,
) -> Result<Value, CrewingError> {
    if let Some(connection) = kept.connection.as_ref() {
        if connection_live(connection, chrono::Utc::now()) {
            return Ok(connection.clone());
        }
    }
    let origin = crewing_origin();
    if let Some(session) = kept.session.clone() {
        match bootstrap(client, &origin, &session) {
            Ok(connection) => {
                kept.connection = Some(connection.clone());
                return Ok(connection);
            }
            Err(e) if e.code == "login_required" => kept.session = None,
            Err(e) => return Err(e),
        }
    }
    let label = format!("Skipi app ({})", std::env::consts::OS);
    let answer = post(
        client,
        &format!("{origin}/api/app/login/skipi-account"),
        None,
        json!({"token": user_token, "label": label}),
    )?;
    let session = answer
        .get("token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| CrewingError::new("other", "the Crewing server returned no session"))?
        .to_string();
    kept.session = Some(session.clone());
    let connection = bootstrap(client, &origin, &session)?;
    kept.connection = Some(connection.clone());
    Ok(connection)
}

/// The forwarding address of the workspace's active alias. Revealed once per
/// alias id + generation and kept; `None` when the workspace has no active alias
/// or the server no longer stores the address.
fn intake_address(
    client: &reqwest::blocking::Client,
    base: &str,
    bearer: &str,
    kept: &mut Kept,
) -> Result<Option<String>, CrewingError> {
    let aliases = get(client, &format!("{base}/intake-aliases"), bearer)?;
    let active = aliases
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|a| a.get("state").and_then(Value::as_str) == Some("active"))
        })
        .cloned();
    let Some(alias) = active else {
        kept.address = None;
        return Ok(None);
    };
    let id = alias.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let generation = alias.get("generation").cloned().unwrap_or(Value::Null);
    if let Some(known) = kept.address.as_ref() {
        if known.get("alias_id").and_then(Value::as_str) == Some(id.as_str())
            && known.get("generation") == Some(&generation)
        {
            return Ok(known
                .get("address")
                .and_then(Value::as_str)
                .map(str::to_string));
        }
    }
    let revealed = post(
        client,
        &format!("{base}/intake-aliases/{id}/reveal"),
        Some(bearer),
        json!({}),
    )?;
    let address = revealed
        .get("address")
        .and_then(Value::as_str)
        .map(str::to_string);
    kept.address = Some(json!({"alias_id": id, "generation": generation, "address": address}));
    Ok(address)
}

fn overview(user_token: &str, kept: &mut Kept) -> Result<Value, CrewingError> {
    let client = http_client()?;
    let connection = connect(&client, user_token, kept)?;
    let field = |k: &str| connection.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (bearer, base) = (
        field("bearer_token"),
        format!("{}/api/crewings/{}", field("server_url"), field("workspace_id")),
    );
    let address = intake_address(&client, &base, &bearer, kept)?;
    let queue = get(
        &client,
        &format!("{base}/candidate-intake?limit={QUEUE_LIMIT}&offset=0"),
        &bearer,
    )?;
    let profiles = get(
        &client,
        &format!("{base}/matching-profiles?include_archived=true"),
        &bearer,
    )?;
    let profiles: Vec<Value> = profiles
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|p| json!({"id": p.get("id"), "name": p.get("name"), "rank": p.get("rank")}))
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "address": address,
        "items": queue.get("items").cloned().unwrap_or_else(|| json!([])),
        "total": queue.get("total").cloned().unwrap_or(Value::Null),
        "profiles": profiles,
    }))
}

fn kept_value(conn: &rusqlite::Connection, key: &str) -> Option<Value> {
    db::get_vault_info_value(conn, key)
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn load_kept(conn: &rusqlite::Connection) -> Kept {
    Kept {
        session: db::get_vault_info_value(conn, SESSION_KEY).filter(|s| !s.trim().is_empty()),
        connection: kept_value(conn, CONNECTION_KEY),
        address: kept_value(conn, ADDRESS_KEY),
    }
}

fn store_kept(conn: &rusqlite::Connection, kept: &Kept) -> Result<(), String> {
    let text = |v: &Option<Value>| v.as_ref().map(Value::to_string).unwrap_or_default();
    db::set_vault_info(conn, SESSION_KEY, kept.session.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    db::set_vault_info(conn, CONNECTION_KEY, &text(&kept.connection)).map_err(|e| e.to_string())?;
    db::set_vault_info(conn, ADDRESS_KEY, &text(&kept.address)).map_err(|e| e.to_string())
}

/// Crew Flow screen data of the signed-in crewing account: the forwarding
/// address, the newest candidates of the queue and the names of the matching
/// profiles. Network runs with no cache lock held.
#[tauri::command]
pub async fn crewing_flow_overview(state: State<'_, AppState>) -> Result<Value, CrewingError> {
    let (user_token, before) = {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = lock
            .as_ref()
            .ok_or_else(|| CrewingError::new("login_required", "no account cache is open"))?;
        if db::get_vault_info_value(conn, "account_type").as_deref() != Some("crewing") {
            return Err(CrewingError::new("not_crewing", "not a crewing account"));
        }
        let token = stored_user_token(conn)
            .ok_or_else(|| CrewingError::new("login_required", "not signed in"))?;
        (token, load_kept(conn))
    };
    let (result, after) = {
        let token = user_token.clone();
        let mut kept = before.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = overview(&token, &mut kept);
            (result, kept)
        })
        .await
        .map_err(|e| CrewingError::new("other", format!("crew flow task failed: {e}")))?
    };
    if after != before {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(conn) = lock.as_ref() {
            // Only into the cache of the very sign-in that was used.
            if stored_user_token(conn).as_deref() == Some(user_token.as_str()) {
                store_kept(conn, &after).map_err(|e| CrewingError::new("other", e))?;
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_are_classified_for_the_screen() {
        assert_eq!(refusal(403, r#"{"error":"account_not_provisioned"}"#).code, "no_workspace");
        assert_eq!(refusal(403, r#"{"error":"entitlement_missing"}"#).code, "no_workspace");
        assert_eq!(refusal(403, r#"{"error":"scope_denied"}"#).code, "not_crewing");
        assert_eq!(refusal(403, r#"{"error":"invalid_credentials"}"#).code, "login_required");
        assert_eq!(refusal(401, r#"{"error":"login_required"}"#).code, "login_required");
        assert_eq!(refusal(401, r#"{"detail":"missing bearer token"}"#).code, "login_required");
        assert_eq!(
            refusal(403, r#"{"ok":false,"detail":"trial expired","code":"trial_expired"}"#).code,
            "trial_expired"
        );
        assert_eq!(refusal(429, r#"{"error":"too_many_attempts"}"#).code, "rate_limited");
        assert_eq!(refusal(404, r#"{"detail":"Not Found"}"#).code, "not_available");
        assert_eq!(refusal(500, "boom").code, "other");
    }

    #[test]
    fn a_workspace_connection_is_used_only_while_trusted_and_alive() {
        let now = chrono::Utc::now();
        let at = |minutes: i64| (now + chrono::Duration::minutes(minutes)).to_rfc3339();
        let connection = |server: &str, bearer: &str, expires: String| {
            json!({"server_url": server, "workspace_id": "ws-1", "bearer_token": bearer, "expires_at": expires})
        };
        assert!(connection_live(&connection(CREWING_ORIGIN, "skn_x", at(10)), now));
        assert!(!connection_live(&connection(CREWING_ORIGIN, "skn_x", at(0)), now));
        assert!(!connection_live(&connection(CREWING_ORIGIN, "skn_x", "garbage".into()), now));
        assert!(!connection_live(&connection("https://evil.example", "skn_x", at(10)), now));
        assert!(!connection_live(&connection(CREWING_ORIGIN, "ska_x", at(10)), now));
        assert!(!connection_live(&json!({}), now));
    }

    #[test]
    fn what_is_kept_round_trips_through_the_account_cache() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE vault_info(key TEXT PRIMARY KEY,value TEXT)")
            .unwrap();
        assert_eq!(load_kept(&conn), Kept::default());
        let kept = Kept {
            session: Some("ska_session".into()),
            connection: Some(json!({"server_url": CREWING_ORIGIN, "workspace_id": "ws-1"})),
            address: Some(json!({"alias_id": "a1", "generation": 1, "address": "x@in.skipi.app"})),
        };
        store_kept(&conn, &kept).unwrap();
        assert_eq!(load_kept(&conn), kept);
        store_kept(&conn, &Kept::default()).unwrap();
        assert_eq!(load_kept(&conn), Kept::default());
    }
}
