//! Skipi Assistant client. Talks to the server-side proxy at
//! `/api/assistant/*` (the server holds the Anthropic key). On first use we
//! fetch a personal `sks_…` key from the server and cache it in the vault;
//! every chat call sends it as a Bearer token. The seafarer's profile is
//! assembled locally from the vault (no raw documents, no name) and sent as
//! `profile_context`; the app-bundled Skipi knowledge base comes from the
//! frontend as `app_context`.

use crate::api;
use crate::cv;
use crate::db;
use crate::AppState;
use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone)]
struct ChatMsgOut {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct KeyReq<'a> {
    device_id: &'a str,
}

#[derive(Deserialize)]
struct KeyResp {
    key: String,
}

#[derive(Serialize, Clone)]
struct ChatReq {
    messages: Vec<ChatMsgOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_context_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    locale: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ChatReply {
    pub reply: String,
    pub model: String,
    pub remaining_today: i64,
}

/// Compact, privacy-conscious profile: professional facts only — no name,
/// DOB, address, phones, email, or document numbers.
fn build_profile_context(conn: &Connection) -> String {
    let data = match cv::build_cv_data(conn) {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    let p = &data.personal;
    let mut s = String::new();
    if let Some(r) = &p.rank {
        s.push_str(&format!("Rank: {}\n", r));
    }
    if let Some(l) = &p.stcw_level {
        s.push_str(&format!("STCW level: {}\n", l));
    }
    if let Some(v) = &p.vessel_type {
        s.push_str(&format!("Primary vessel type: {}\n", v));
    }
    if let Some(n) = &p.nationality {
        s.push_str(&format!("Nationality: {}\n", n));
    }
    if let Some(a) = &p.available_from {
        s.push_str(&format!("Available from: {}\n", a));
    }
    if data.total_sea_days > 0 {
        s.push_str(&format!("Total recorded sea time: {} days\n", data.total_sea_days));
    }
    if !data.work_history.is_empty() {
        s.push_str("Sea service (most recent first):\n");
        for w in data.work_history.iter().take(20) {
            let period = match (&w.sign_on, &w.sign_off) {
                (Some(on), Some(off)) => format!("{} to {}", on, off),
                (Some(on), None) => format!("{} to present", on),
                _ => "dates unknown".to_string(),
            };
            let vt = w.vessel_type.as_deref().unwrap_or("");
            s.push_str(&format!(
                "- {} — {} — {} — {}\n",
                w.position, w.vessel_name, vt, period
            ));
        }
    }
    if !data.certificates.is_empty() {
        s.push_str(&format!("Certificates ({}):\n", data.certificates.len()));
        for c in data.certificates.iter().take(60) {
            let validity = if c.is_permanent {
                "permanent".to_string()
            } else if let Some(to) = &c.valid_to {
                format!("valid until {}", to)
            } else {
                "no expiry".to_string()
            };
            s.push_str(&format!("- {} [{}] {} ({})\n", c.title, c.category, c.status, validity));
        }
    }
    s
}

fn ensure_device_id(conn: &Connection) -> Result<String, String> {
    if let Some(d) = db::get_vault_info_value(conn, "assistant_device_id") {
        if !d.trim().is_empty() {
            return Ok(d);
        }
    }
    let d = Uuid::new_v4().to_string();
    db::set_vault_info(conn, "assistant_device_id", &d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub fn ensure_key(conn: &Connection, client: &Client) -> Result<String, String> {
    if let Some(k) = db::get_vault_info_value(conn, "assistant_key") {
        if !k.trim().is_empty() {
            return Ok(k);
        }
    }
    let device_id = ensure_device_id(conn)?;
    let resp: KeyResp = api::post_json(client, "/api/assistant/key", &KeyReq { device_id: &device_id })?;
    db::set_vault_info(conn, "assistant_key", &resp.key).map_err(|e| e.to_string())?;
    Ok(resp.key)
}

/// Blocking HTTP client with the assistant's timeouts. Must only be built and
/// used inside `spawn_blocking` tasks: a `reqwest::blocking` client on the
/// async runtime (or the main thread) blocks/panics — that was bug №140.
fn chat_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(70))
        .connect_timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())
}

/// Bearer-authenticated POST that walks the same api_bases() fallback chain
/// the rest of the app uses. Auth/limit failures (401/429) are returned
/// immediately; transport/5xx failures fall through to the next base.
fn post_authed(client: &Client, path: &str, key: &str, body: &ChatReq) -> Result<ChatReply, String> {
    let mut last = String::from("API unavailable");
    for base in api::api_bases() {
        let url = format!("{}{}", base.trim_end_matches('/'), path);
        match client.post(&url).bearer_auth(key).json(body).send() {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().unwrap_or_default();
                if status.is_success() {
                    return serde_json::from_str(&text).map_err(|e| format!("parse error: {}", e));
                }
                last = format!("HTTP {}: {}", status.as_u16(), text);
                if status.as_u16() == 401 || status.as_u16() == 429 || status.as_u16() == 503 {
                    return Err(last);
                }
            }
            Err(e) => last = format!("{}", e),
        }
    }
    Err(last)
}

/// Lock-frugal async counterpart of `ensure_key` for the chat path: vault
/// reads/writes happen under short-lived conn locks, while the HTTP key
/// request runs in `spawn_blocking` with no lock held.
async fn issue_and_store_key(state: &AppState) -> Result<String, String> {
    let device_id = {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = lock.as_ref().ok_or("No vault open")?;
        ensure_device_id(conn)?
    };
    let key = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let client = chat_client()?;
        let resp: KeyResp =
            api::post_json(&client, "/api/assistant/key", &KeyReq { device_id: &device_id })?;
        Ok(resp.key)
    })
    .await
    .map_err(|e| format!("assistant task failed: {}", e))??;
    {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = lock.as_ref().ok_or("No vault open")?;
        db::set_vault_info(conn, "assistant_key", &key).map_err(|e| e.to_string())?;
    }
    Ok(key)
}

/// One chat POST in a blocking task — no vault lock is (or can be) held here.
async fn send_chat(key: String, body: ChatReq) -> Result<ChatReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = chat_client()?;
        post_authed(&client, "/api/assistant/chat", &key, &body)
    })
    .await
    .map_err(|e| format!("assistant task failed: {}", e))?
}

/// Async command (№140): a sync #[tauri::command] runs on the main thread, so
/// the old blocking version froze the whole webview for up to 70s per message.
/// Vault access happens under short-lived conn locks; all HTTP runs in
/// `spawn_blocking` tasks with no lock held, so other vault commands (and the
/// UI) stay responsive while the assistant is thinking.
#[tauri::command]
pub async fn assistant_chat(
    state: State<'_, AppState>,
    messages: Vec<ChatMsg>,
    app_context: Option<String>,
    app_context_version: Option<String>,
    locale: Option<String>,
) -> Result<ChatReply, String> {
    // Vault reads under a short-lived lock; released before any network I/O.
    let (profile, cached_key) = {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = lock.as_ref().ok_or("No vault open")?;
        let profile = build_profile_context(conn);
        let key = db::get_vault_info_value(conn, "assistant_key").filter(|k| !k.trim().is_empty());
        (profile, key)
    };

    let body = ChatReq {
        messages: messages
            .into_iter()
            .map(|m| ChatMsgOut { role: m.role, content: m.content })
            .collect(),
        profile_context: if profile.is_empty() { None } else { Some(profile) },
        app_context,
        app_context_version,
        locale,
    };

    let key = match cached_key {
        Some(k) => k,
        None => issue_and_store_key(&state).await?,
    };

    match send_chat(key, body.clone()).await {
        Ok(r) => Ok(r),
        Err(e) if e.contains("HTTP 401") => {
            // Key unknown/revoked — drop it, re-issue, retry once.
            {
                let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
                let conn = lock.as_ref().ok_or("No vault open")?;
                let _ = db::set_vault_info(conn, "assistant_key", "");
            }
            let key = issue_and_store_key(&state).await?;
            send_chat(key, body).await
        }
        Err(e) => Err(e),
    }
}
