//! Compliance Profile commands of the crewing role, carried over from the pilot
//! client (skipi-crewing `src-tauri/src/lib.rs` at 4b82cd8: the four
//! `*_compliance_profile(s)` commands and their data shapes) — tasks/018, owner
//! 25.11.2026: the modules are the pilot's, carried over in the order Crew Flow,
//! Compliance Profile, Seafarers DB.
//!
//! Requests, bodies and answers are the pilot's. Two differences: the connection
//! comes from the one Skipi sign-in (`crewing::live_connection`) instead of the
//! pilot's settings file, and the commands are async with the HTTP call off the
//! UI thread (the pilot's were synchronous).

use reqwest::blocking::Client;
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::commands::crewing::{self, LiveConnection};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplianceExtraRequirement {
    pub id: String,
    pub label: String,
    pub weight: i64,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ComplianceProfileDraft {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub rank: Option<String>,
    /// P2/S1. The second thing a crewing matches on, and a profile cannot be
    /// published without it.
    #[serde(default)]
    pub vessel_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mandatory_certs: Option<Vec<String>>,
    #[serde(default)]
    pub extra_requirements: Option<Vec<ComplianceExtraRequirement>>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerComplianceProfile {
    pub id: String,
    pub crewing_id: String,
    pub name: String,
    #[serde(default)]
    pub rank: Option<String>,
    #[serde(default)]
    pub vessel_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mandatory_certs: Option<Vec<String>>,
    #[serde(default)]
    pub extra_requirements: Option<Vec<ComplianceExtraRequirement>>,
    pub status: String,
    /// P2/S1, READ-ONLY on this surface: "unpublished" | "published".
    /// Publication is only ever CHANGED through the matching-profile route,
    /// which is the one that owns the version and the frozen snapshot. It is
    /// read here so the profile card can draw the button in the right state
    /// without a second round-trip. `serde(default)` because an older server
    /// does not send it, and a crewing on an older pilot must still be able
    /// to open its own profiles.
    #[serde(default = "unpublished_state")]
    pub publication_state: String,
    #[serde(default)]
    pub published_snapshot: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

fn unpublished_state() -> String {
    "unpublished".to_string()
}

#[derive(Debug, Clone, Deserialize)]
struct ComplianceProfileListResp {
    items: Vec<ServerComplianceProfile>,
}

fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// One JSON request to the workspace's server. Errors keep the pilot's wording
/// (`server returned <status>: <body>`), which the screen prints after its own
/// «Save failed: ».
fn request<T: DeserializeOwned>(
    live: &LiveConnection,
    method: Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<T, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}{}", live.server_url.trim_end_matches('/'), path);
    let mut req = client
        .request(method, &url)
        .bearer_auth(&live.bearer_token)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req.send().map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        return resp.json().map_err(|e| format!("bad JSON: {e}"));
    }
    let text = resp.text().unwrap_or_default();
    Err(format!("server returned {status}: {text}"))
}

async fn live(state: &tauri::State<'_, AppState>) -> Result<LiveConnection, String> {
    crewing::live_connection(state)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.detail))
}

async fn off_ui<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| format!("request task failed: {e}"))?
}

#[tauri::command]
pub async fn fetch_compliance_profiles(
    include_archived: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ServerComplianceProfile>, String> {
    let live = live(&state).await?;
    off_ui(move || {
        let path = format!(
            "/api/compliance-profiles?crewing_id={}&include_archived={}",
            urlenc(&live.workspace_id),
            if include_archived.unwrap_or(false) { "true" } else { "false" }
        );
        let parsed: ComplianceProfileListResp = request(&live, Method::GET, &path, None)?;
        Ok(parsed.items)
    })
    .await
}

/// The body of a create, as the pilot built it.
fn create_body(crewing_id: &str, draft: ComplianceProfileDraft) -> Result<serde_json::Value, String> {
    let name = draft
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Profile name is required.".to_string())?;
    let description = draft
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Ok(serde_json::json!({
        "crewing_id": crewing_id,
        "name": name,
        "rank": draft.rank.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        "vessel_type": draft.vessel_type.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        "description": description,
        "mandatory_certs": draft.mandatory_certs.unwrap_or_default(),
        "extra_requirements": draft.extra_requirements.unwrap_or_default(),
    }))
}

/// The body of an update, as the pilot built it: only the fields the draft
/// carries; an emptied text field is sent as null.
fn update_body(draft: ComplianceProfileDraft) -> Result<serde_json::Value, String> {
    let text_or_null = |value: String| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(trimmed)
        }
    };
    let mut body = serde_json::Map::new();
    if let Some(name) = draft.name {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return Err("Profile name is required.".into());
        }
        body.insert("name".into(), serde_json::Value::String(trimmed));
    }
    if let Some(description) = draft.description {
        body.insert("description".into(), text_or_null(description));
    }
    if let Some(rank) = draft.rank {
        body.insert("rank".into(), text_or_null(rank));
    }
    if let Some(vessel_type) = draft.vessel_type {
        body.insert("vessel_type".into(), text_or_null(vessel_type));
    }
    if let Some(certs) = draft.mandatory_certs {
        body.insert(
            "mandatory_certs".into(),
            serde_json::to_value(certs).map_err(|e| e.to_string())?,
        );
    }
    if let Some(extras) = draft.extra_requirements {
        body.insert(
            "extra_requirements".into(),
            serde_json::to_value(extras).map_err(|e| e.to_string())?,
        );
    }
    if let Some(status) = draft.status {
        body.insert("status".into(), serde_json::Value::String(status));
    }
    Ok(serde_json::Value::Object(body))
}

/// A profile id goes into a path: only the characters of a server id.
fn checked_profile_id(profile_id: &str) -> Result<String, String> {
    let id = profile_id.trim();
    if id.is_empty()
        || id.len() > 64
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Profile id is not valid.".into());
    }
    Ok(id.to_string())
}

#[tauri::command]
pub async fn create_compliance_profile(
    draft: ComplianceProfileDraft,
    state: tauri::State<'_, AppState>,
) -> Result<ServerComplianceProfile, String> {
    let live = live(&state).await?;
    let body = create_body(&live.workspace_id, draft)?;
    off_ui(move || request(&live, Method::POST, "/api/compliance-profiles", Some(body))).await
}

#[tauri::command]
pub async fn update_compliance_profile(
    profile_id: String,
    draft: ComplianceProfileDraft,
    state: tauri::State<'_, AppState>,
) -> Result<ServerComplianceProfile, String> {
    let id = checked_profile_id(&profile_id)?;
    let body = update_body(draft)?;
    let live = live(&state).await?;
    off_ui(move || {
        request(&live, Method::PATCH, &format!("/api/compliance-profiles/{id}"), Some(body))
    })
    .await
}

#[tauri::command]
pub async fn archive_compliance_profile(
    profile_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ServerComplianceProfile, String> {
    let id = checked_profile_id(&profile_id)?;
    let live = live(&state).await?;
    off_ui(move || {
        request(&live, Method::POST, &format!("/api/compliance-profiles/{id}/archive"), None)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_create_needs_a_name_and_sends_the_workspace() {
        assert_eq!(
            create_body("ws-1", ComplianceProfileDraft::default()).unwrap_err(),
            "Profile name is required."
        );
        let body = create_body(
            "ws-1",
            ComplianceProfileDraft {
                name: Some("  Ice Advisor ".into()),
                rank: Some(" ".into()),
                vessel_type: Some("Bulk Carrier".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(body["crewing_id"], "ws-1");
        assert_eq!(body["name"], "Ice Advisor");
        assert!(body["rank"].is_null());
        assert_eq!(body["vessel_type"], "Bulk Carrier");
        assert_eq!(body["mandatory_certs"], serde_json::json!([]));
        assert_eq!(body["extra_requirements"], serde_json::json!([]));
    }

    #[test]
    fn an_update_sends_only_what_the_draft_carries() {
        let body = update_body(ComplianceProfileDraft {
            status: Some("active".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(body, serde_json::json!({"status": "active"}));
        let body = update_body(ComplianceProfileDraft {
            name: Some(" Master ".into()),
            description: Some("  ".into()),
            mandatory_certs: Some(vec!["coc".into()]),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            body,
            serde_json::json!({"name": "Master", "description": null, "mandatory_certs": ["coc"]})
        );
        assert_eq!(
            update_body(ComplianceProfileDraft { name: Some(" ".into()), ..Default::default() })
                .unwrap_err(),
            "Profile name is required."
        );
    }

    #[test]
    fn a_profile_id_cannot_reach_another_path() {
        assert_eq!(
            checked_profile_id(" 6f0c2a1e-1111-4222-8333-444455556666 ").unwrap(),
            "6f0c2a1e-1111-4222-8333-444455556666"
        );
        for bad in ["", "a/b", "../x", "a?b=1", "a b", "a%2Fb"] {
            assert!(checked_profile_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_profile_of_an_older_server_still_parses() {
        let parsed: ComplianceProfileListResp = serde_json::from_str(
            r#"{"items":[{"id":"p1","crewing_id":"ws-1","name":"Ice Advisor","status":"active",
                "created_at":"2026-11-21T00:00:00Z","updated_at":"2026-11-21T00:00:00Z"}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.items[0].publication_state, "unpublished");
        assert!(parsed.items[0].mandatory_certs.is_none());
    }

    #[test]
    fn a_workspace_id_is_escaped_in_the_query() {
        assert_eq!(urlenc("090f9136-9c66"), "090f9136-9c66");
        assert_eq!(urlenc("a b&c=d"), "a%20b%26c%3Dd");
    }
}
