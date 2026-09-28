//! Public jobs board client. It polls the configured Skipi API, falling back
//! from the primary endpoint to the Timeweb RF bridge when needed.
//!
//! Privacy: the desktop app sends only the broad filter parameters in the
//! query string; the server never sees the seafarer's identity.

use serde::{Deserialize, Serialize};

use crate::api;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VesselRatingSummary {
    #[serde(default)]
    pub average_overall: Option<f64>,
    #[serde(default)]
    pub review_count: i64,
    #[serde(default)]
    pub signals_available: bool,
    #[serde(default)]
    pub min_reviews: i64,
    #[serde(default)]
    pub low_sample: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicVacancy {
    pub id: String,
    pub crewing_ref: String,
    #[serde(default)]
    pub crewing_jurisdiction: Option<String>,
    pub rank: String,
    pub vessel_type: String,
    #[serde(default)]
    pub flag: Option<String>,
    #[serde(default)]
    pub trading_area: Option<String>,
    #[serde(default)]
    pub russia_trading: bool,
    #[serde(default)]
    pub joining_window_from: Option<String>,
    #[serde(default)]
    pub joining_window_to: Option<String>,
    #[serde(default)]
    pub contract_months: Option<i64>,
    #[serde(default)]
    pub salary_min: Option<i64>,
    #[serde(default)]
    pub salary_max: Option<i64>,
    #[serde(default)]
    pub salary_currency: Option<String>,
    #[serde(default)]
    pub salary_negotiable: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub vessel_name: Option<String>,
    #[serde(default)]
    pub join_port: Option<String>,
    #[serde(default)]
    pub client_name: Option<String>,
    pub published_at: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    pub status: String,
    #[serde(default)]
    pub vessel_imo: Option<i64>,
    /// Crewing's X25519 pubkey for E2E messaging. NULL means crewing
    /// hasn't installed Skipi Crewing yet → seafarer apply falls back
    /// to email/.eml.
    #[serde(default)]
    pub crewing_pubkey: Option<String>,
    /// Crewing's E2E user_id (16-char base32). Paired with crewing_pubkey.
    #[serde(default)]
    pub crewing_user_id: Option<String>,
    #[serde(default)]
    pub crewing_description: Option<String>,
    #[serde(default)]
    pub crewing_trust_status: Option<String>,
    #[serde(default)]
    pub crewing_trust_label: Option<String>,
    #[serde(default)]
    pub vessel_rating: Option<VesselRatingSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicMailingRequest {
    pub id: String,
    pub crewing_id: String,
    pub crewing_ref: String,
    pub title: String,
    pub rank: String,
    pub vessel_type: String,
    pub reply_to: String,
    #[serde(default)]
    pub client_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub min_experience_years: Option<i64>,
    #[serde(default)]
    pub required_certs: Option<Vec<String>>,
    #[serde(default)]
    pub languages: Option<Vec<String>>,
    pub published_at: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    pub status: String,
    #[serde(default)]
    pub send_click_count: i64,
    #[serde(default)]
    pub hide_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentVesselReview {
    pub imo: i64,
    #[serde(default)]
    pub name_current: Option<String>,
    #[serde(default)]
    pub flag_current: Option<String>,
    #[serde(default)]
    pub vessel_type: Option<String>,
    #[serde(default)]
    pub latest_review_at: Option<String>,
    #[serde(default)]
    pub review_count: i64,
    #[serde(default)]
    pub signals_available: bool,
    #[serde(default)]
    pub average_overall: Option<f64>,
    #[serde(default)]
    pub low_sample: bool,
    #[serde(default)]
    pub min_reviews: i64,
}

/// One open-ended requirement a crewing attached to a published profile.
/// Free-form and crewing-authored: Skipi Seafarer cannot verify it from the
/// vault, so the UI shows it as "unknown", never as met.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedProfileRequirement {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// One published crewing matching profile, as `GET /api/published-profiles`
/// returns it. Criteria only — the agency's commercial context (customer,
/// vessel name, embarkation date, places, deadline) and the profile's internal
/// name are not on that surface, and there is nothing here to hold them.
///
/// EVERY CRITERION IS `Option`, AND THAT IS THE POINT. The neighbouring
/// `PublicVacancy` above declares `rank: String` and `vessel_type: String`:
/// one row with a null rank there makes serde fail the WHOLE list, and the
/// seafarer's Jobs tab goes empty with no explanation. A missing criterion
/// must arrive here as a value this client can refuse for that one row —
/// which is exactly what "unknown is not a match" requires — and not as a
/// parse error that takes every other row down with it.
///
/// `profile_id` is the exception and stays required: it is the row's
/// identity, not a criterion, and the server's own schema declares it `str`.
/// A row without one could not be rendered, keyed or deduplicated anyway.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedProfile {
    pub profile_id: String,
    #[serde(default)]
    pub crewing_id: Option<String>,
    /// The profile version AS AT PUBLICATION, read from the frozen snapshot.
    /// Its absence means the row is not snapshot-backed; the UI drops it
    /// rather than showing criteria whose provenance it cannot name.
    #[serde(default)]
    pub published_version: Option<i64>,
    #[serde(default)]
    pub rank: Option<String>,
    #[serde(default)]
    pub vessel_type: Option<String>,
    #[serde(default)]
    pub mandatory_certs: Vec<String>,
    #[serde(default)]
    pub extra_requirements: Vec<PublishedProfileRequirement>,
}

#[derive(Debug, Clone, Deserialize)]
struct VacancyListResp {
    items: Vec<PublicVacancy>,
}

#[derive(Debug, Clone, Deserialize)]
struct PublishedProfileListResp {
    #[serde(default)]
    items: Vec<PublishedProfile>,
}

#[derive(Debug, Clone, Deserialize)]
struct MailingRequestListResp {
    items: Vec<PublicMailingRequest>,
}

#[derive(Debug, Clone, Deserialize)]
struct RecentVesselReviewListResp {
    items: Vec<RecentVesselReview>,
}

#[tauri::command]
pub fn fetch_jobs(
    rank: Option<String>,
    vessel_type: Option<String>,
    nationality: Option<String>,
) -> Result<Vec<PublicVacancy>, String> {
    let mut path = "/api/vacancies?limit=100".to_string();
    if let Some(r) = rank.as_deref().filter(|s| !s.is_empty()) {
        path.push_str(&format!("&rank={}", urlencoding(r)));
    }
    if let Some(v) = vessel_type.as_deref().filter(|s| !s.is_empty()) {
        path.push_str(&format!("&vessel_type={}", urlencoding(v)));
    }
    if let Some(n) = nationality.as_deref().filter(|s| !s.is_empty()) {
        path.push_str(&format!("&nationality={}", urlencoding(n)));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let parsed: VacancyListResp = api::get_json(&client, &path)?;
    Ok(parsed.items)
}

/// Published crewing matching profiles that fit this seafarer.
///
/// A SEPARATE SURFACE FROM `fetch_jobs` ABOVE, ON PURPOSE. Both sides of the
/// product hold `/api/vacancies` to concrete vessel offers — the server drops
/// rows without a `vessel_imo`, and this client filters again on a valid
/// 7-digit one in five places. A matching profile is not an offer on a vessel
/// and has no IMO, so putting profiles into that feed had exactly two
/// available outcomes, weakening the IMO filter or inventing an IMO, and both
/// are forbidden outright. The profiles get their own route; the seafarer
/// still sees them inside the Jobs module he already has, as a section of it.
///
/// THE FOURTH UNKNOWN, AT ITS NATIVE CALL SITE. `fetch_jobs` appends a filter
/// to the query string only when the string is non-empty, and a list route
/// that answers an absent filter by not filtering hands a seafarer with a
/// half-filled profile EVERY published row there is — the direct inversion of
/// the rule, visible on the first screen. So an empty rank or vessel type is
/// refused HERE, before the request exists, and the refusal is an empty list
/// rather than a fall-through. The server refuses the same way; two
/// independent refusals is the intent, not a duplication to be tidied away.
#[tauri::command]
pub fn fetch_published_profiles(
    rank: Option<String>,
    vessel_type: Option<String>,
) -> Result<Vec<PublishedProfile>, String> {
    let rank = rank.unwrap_or_default();
    let rank = rank.trim();
    let vessel_type = vessel_type.unwrap_or_default();
    let vessel_type = vessel_type.trim();
    if rank.is_empty() || vessel_type.is_empty() {
        return Ok(Vec::new());
    }
    let path = format!(
        "/api/published-profiles?limit=50&rank={}&vessel_type={}",
        urlencoding(rank),
        urlencoding(vessel_type)
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let parsed: PublishedProfileListResp = api::get_json(&client, &path)?;
    Ok(parsed.items)
}

#[tauri::command]
pub fn fetch_mailing_requests(
    rank: Option<String>,
    vessel_type: Option<String>,
) -> Result<Vec<PublicMailingRequest>, String> {
    let mut path = "/api/mailing-requests?limit=100".to_string();
    if let Some(r) = rank.as_deref().filter(|s| !s.is_empty()) {
        path.push_str(&format!("&rank={}", urlencoding(r)));
    }
    if let Some(v) = vessel_type.as_deref().filter(|s| !s.is_empty()) {
        path.push_str(&format!("&vessel_type={}", urlencoding(v)));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let parsed: MailingRequestListResp = api::get_json(&client, &path)?;
    Ok(parsed.items)
}

#[tauri::command]
pub fn fetch_vessel_projection(imo: String) -> Result<serde_json::Value, String> {
    let digits: String = imo.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 7 {
        return Err("IMO must contain exactly 7 digits".to_string());
    }
    let path = format!("/api/vessels/{}", digits);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = api::get_json(&client, &path)?;
    Ok(parsed)
}

#[tauri::command]
pub fn fetch_recent_vessel_reviews(limit: Option<i64>) -> Result<Vec<RecentVesselReview>, String> {
    let limit = limit.unwrap_or(10).clamp(1, 25);
    let path = format!("/api/vessels/recent-reviews?limit={}", limit);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let parsed: RecentVesselReviewListResp = api::get_json(&client, &path)?;
    Ok(parsed.items)
}

/// Fetch the public Skipi.info Vacancy Index as an anonymous document.
/// Matching to the local profile happens in the WebView; no rank, vessel,
/// identity, or vault data is sent to skipi.info.
#[tauri::command]
pub fn fetch_skipi_info_index() -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://skipi.info/data/index_latest.json")
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("skipi.info network: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("skipi.info returned {status}: {body}"));
    }
    resp.json().map_err(|e| format!("bad Skipi.info JSON: {e}"))
}

#[tauri::command]
pub fn mailing_request_send_click(request_id: String) -> Result<(), String> {
    let path = format!("/api/mailing-requests/{}/send-click", request_id);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    api::post_empty(&client, &path)
}

/// Tell the public board that someone hit Apply on this vacancy.
/// Anonymous counter — no per-user info.
#[tauri::command]
pub fn job_apply_click(vacancy_id: String) -> Result<(), String> {
    bump_counter(&vacancy_id, "apply-click")
}

/// Open the user's preferred mail composer with subject + body + the
/// supplied attachment path (the redacted-CV PDF generated client-side).
///
/// Linux: prefer Thunderbird's native `-compose` CLI when available — it
/// reliably honours subject / body / attachment, unlike xdg-email + snap
/// Thunderbird which drops everything except recipient. Falls back to
/// xdg-email otherwise.
///
/// macOS / Windows: open mailto:; attachment is dropped (mailto: doesn't
/// carry attachments) — the JS layer should toast the file path so the
/// user can attach manually.
#[tauri::command]
pub fn open_mail_with_attachment(
    to: String,
    subject: String,
    body: String,
    attachment_path: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // Thunderbird's compose URI: comma-separated key=value list; values
        // with literal commas / quotes need to be escaped per
        // https://kb.mozillazine.org/Command_line_arguments_-_Thunderbird
        // For simplicity we URL-encode commas and quotes inside subject /
        // body which Thunderbird's parser tolerates.
        fn esc(s: &str) -> String {
            s.replace('\'', "%27")
                .replace('"', "%22")
                .replace(',', "%2C")
        }
        let attach_part = attachment_path
            .as_deref()
            .filter(|p| !p.is_empty() && std::path::Path::new(p).exists())
            .map(|p| format!(",attachment='{}'", p))
            .unwrap_or_default();
        let compose_uri = format!(
            "to={},subject='{}',body='{}'{}",
            to.trim(),
            esc(&subject),
            esc(&body),
            attach_part
        );
        // Try thunderbird first (most users on Linux use TB; native CLI is
        // robust with subject/body/attachments even under snap).
        if std::process::Command::new("thunderbird")
            .arg("-compose")
            .arg(&compose_uri)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        // Fallback: xdg-email
        let mut cmd = std::process::Command::new("xdg-email");
        cmd.arg("--utf8")
            .arg("--subject")
            .arg(&subject)
            .arg("--body")
            .arg(&body);
        if let Some(p) = attachment_path.as_deref().filter(|s| !s.is_empty()) {
            if std::path::Path::new(p).exists() {
                cmd.arg("--attach").arg(p);
            }
        }
        cmd.arg(&to);
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let url = format!(
            "mailto:{}?subject={}&body={}",
            urlencoding(&to),
            urlencoding(&subject),
            urlencoding(&body)
        );
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let url = format!(
            "mailto:{}?subject={}&body={}",
            urlencoding(&to),
            urlencoding(&subject),
            urlencoding(&body)
        );
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(&["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Unsupported OS".to_string())
}

/// Tell the public board that someone hid this vacancy.
#[tauri::command]
pub fn job_hide(vacancy_id: String) -> Result<(), String> {
    bump_counter(&vacancy_id, "hide")
}

/// Resolve the user's Downloads folder cross-platform (~/Downloads on Linux/Mac,
/// %USERPROFILE%\Downloads on Windows). Used by the Apply flow to drop the
/// generated redacted-CV PDF in a predictable, attach-friendly location.
#[tauri::command]
pub fn get_downloads_dir() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let p = std::path::PathBuf::from("/storage/emulated/0/Download");
        std::fs::create_dir_all(&p)
            .map_err(|e| format!("Could not create Android Downloads dir: {e}"))?;
        return Ok(p.to_string_lossy().to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        let p = dirs::download_dir()
            .or_else(dirs::home_dir)
            .ok_or_else(|| "Could not resolve user home / downloads dir".to_string())?;
        Ok(p.to_string_lossy().to_string())
    }
}

fn bump_counter(vacancy_id: &str, action: &str) -> Result<(), String> {
    let path = format!("/api/vacancies/{}/{}", vacancy_id, action);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    api::post_empty(&client, &path)
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                (b as char).to_string()
            } else {
                format!("%{:02X}", b)
            }
        })
        .collect()
}
