//! Public jobs board client. It polls the configured Skipi API, falling back
//! from the primary endpoint to the Timeweb RF bridge when needed.
//!
//! Privacy: the desktop app sends only the broad filter parameters in the
//! query string; the server never sees the seafarer's identity.

use base64::Engine;
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
    /// WHO the seafarer's irreversible response goes to, in words he can read.
    /// `Crewing.display_name` on the server; never an id.
    ///
    /// SELF-ASSERTED, AND THIS COMMENT IS THE ONLY PLACE THAT SAYS SO. Read
    /// from the server's own bytes on 2026-09-29: `PATCH
    /// /api/crewings/{crewing_id}/profile` (`app/routers/crewings.py:692`)
    /// runs under scope `profile:write`, which any working crewing token
    /// carries, and applies `CrewingProfilePatch`
    /// (`app/schemas.py:33`) with a bare `setattr` loop. That model accepts
    /// `display_name`, `legal_name`, `jurisdiction`, `registration_number`,
    /// `mlc_cert_number` and `mlc_cert_valid_to` — so the name AND the
    /// jurisdiction below are what the agency says about itself, and the audit
    /// row is written after the change, not before it. Only the boolean
    /// `mlc_certified` stays out of that model and admin-gated.
    ///
    /// Nothing is decided here on account of that. It is recorded so that no
    /// later reader takes this field, or the trust badge rendered beside it,
    /// for a name somebody checked. The owner's rule is
    /// that a UUID and a conditional label ("Agency A") are both refusals, so
    /// the absence of this value is said in a sentence and never filled in
    /// from `crewing_id` above.
    ///
    /// OPTIONAL BECAUSE THE SERVER RUNNING THE PILOT TODAY DOES NOT SEND IT.
    /// The three fields below arrive with the other half of this contract; a
    /// build that made them required would stop parsing the WHOLE list against
    /// today's production answer, which is exactly the failure the doc comment
    /// above this struct was written about.
    #[serde(default)]
    pub crewing_name: Option<String>,
    /// ISO country code of the agency's registration (`Crewing.jurisdiction`).
    #[serde(default)]
    pub crewing_jurisdiction: Option<String>,
    /// The agency's raw token state — `legacy`, `active` or `trial`, the same
    /// set `published_profiles.py` will show a seafarer at all.
    ///
    /// NOT the same vocabulary as `PublicVacancy::crewing_trust_status` above,
    /// which is a MAPPED value (`verified` / `trial` / `verified_legacy`) and
    /// arrives with a ready-made `crewing_trust_label` the client only prints.
    /// This surface sends neither, so the mapping into the words the vacancy
    /// block shows is done client-side — see `jobsProfileCrewingTrust` in
    /// `dist/index.html`. It is deliberately the same three badges and not a
    /// second vocabulary: both blocks are on one screen.
    #[serde(default)]
    pub crewing_trust_status: Option<String>,
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
    let parsed: PublishedProfileListResp = get_json_for_response_path(&client, &path)?;
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

// ═════════════════════════════════════════════════════════════════════════════
// P2/S4b — the seafarer answers a published matching profile WITH A BUTTON.
//
// The whole chain lives in Rust on purpose, and each of the three reasons was
// measured before a line was written:
//
//  1. THE WEBVIEW HAS ITS OWN BASE LIST WITH A SILENT FALLBACK, AND IT DOES NOT
//     CHECK THE METHOD. `apiFetch` (dist/index.html) walks
//     [override, api.skipi.app, api-ru.skipi.app] and its `catch` branch
//     continues to the next base for ANY method — `shouldRetryApiResponse`
//     guards only the status-code branch and only for GET/HEAD/OPTIONS. A POST
//     that throws on the stand would therefore be retried against PRODUCTION,
//     carrying a seafarer's CV with it. Nothing about the response path may go
//     through that function.
//  2. THE STAND ADDRESS IS A COMPILE-TIME FACT AND ONLY RUST CAN SEE IT.
//     `option_env!` is resolved when the binary is built; on Android there is no
//     process environment to read and no way to hand the WebView a runtime one.
//  3. THE SESSION AND THE RESPONSE MUST AGREE ON ONE HOST. The bearer is minted
//     by `/api/me/session` and spent on `/api/published-profiles/.../responses`.
//     Splitting them between the WebView and Rust would mint a token on
//     production and spend it on the stand — two hosts, zero working paths.
//
// The access token never enters JavaScript and the Ed25519 private key never
// leaves the vault: the signature is produced here, over bytes this file builds
// itself, and only the acknowledgement crosses back.
// ═════════════════════════════════════════════════════════════════════════════

/// `vault_info` key prefix for the response id of ONE profile. In the vault's
/// SQLite database, so it survives the process — see `ensure_profile_response_id`.
const RESPONSE_ID_KEY_PREFIX: &str = "profile_response_id:";

/// Read from the server (`app/self_session_service.py:32`). A payload that does
/// not carry exactly this schema is not a self-session challenge and is not signed.
const SELF_SESSION_SCHEMA: &str = "skipi.identity.self_session.v1";
const SELF_SESSION_AUDIENCE: &str = "skipi-server";

/// The exact key set of `_challenge_payload_to_sign`
/// (`app/self_session_service.py:119-128`). The signer refuses anything else —
/// see `sign_self_session_challenge` for why that matters.
const SELF_SESSION_PAYLOAD_KEYS: [&str; 7] = [
    "audience",
    "challenge_id",
    "created_at",
    "nonce",
    "public_seafarer_id",
    "schema",
    "vault_user_id",
];

/// The 409s of the response route, TOLD APART BY THE SERVER'S OWN WORDS.
///
/// Four refusals share this status code and the client used to read every one
/// of them as a deleted document — so a second press told a seafarer that the
/// agency had removed his response, measured live on 2026-09-29 against a stand
/// where nothing had been removed: zero tombstones, the intake alive, one row in
/// `profile_responses`. The words are the only thing that separates them and
/// the client already holds them in `answer.body`.
///
/// WHAT THE SERVER CAN AND CANNOT SAY, read in its source rather than assumed:
/// `candidate_intake_service.py` answers a document its agency deleted with the
/// SAME sentence as an ordinary content conflict, on purpose — "an answer that
/// said 'this was deleted' would confirm to anybody able to submit that a
/// particular document once passed through this agency". A deleted document
/// therefore has NO word of its own, and the one thing true of both branches is
/// that this response is already on record and a repeat sends nothing new.
///
/// Everything else is a conflict whose reason this build does not know, and it
/// says exactly that instead of inventing one. Fail-closed on the unknown.
const INTAKE_CONTENT_CONFLICT: &str = "event already accepted with different content";
pub(crate) const RESPONSE_ALREADY_DELIVERED: &str = "RESPONSE_ALREADY_DELIVERED";
pub(crate) const RESPONSE_CONFLICT_UNKNOWN: &str = "RESPONSE_CONFLICT_UNKNOWN";

/// One 409, classified by the words it carries. The body itself never crosses
/// to the WebView: what crosses is a marker, and the sentence a seafarer reads
/// is the client's own, in his language.
fn response_conflict_token(body: &str) -> &'static str {
    if body.contains(INTAKE_CONTENT_CONFLICT) {
        RESPONSE_ALREADY_DELIVERED
    } else {
        RESPONSE_CONFLICT_UNKNOWN
    }
}

/// `vault_info` key prefix for THE SERVER'S OWN CONFIRMATION about one response.
///
/// The response id already survived the process (`ensure_profile_response_id`)
/// and the server's row already survived it — measured on 2026-09-29 — and the
/// only thing that did not was the SCREEN: after a cold start the card was
/// byte-for-byte the card from before the delivery, an irreversible button and
/// nothing else. It could not be otherwise: the acknowledgement was returned to
/// the WebView and written nowhere, so no renderer could read it.
///
/// THE BASE IS ALWAYS PART OF THIS NAME, production included — the one
/// deliberate difference from `identity_vault_key`, which keeps a bare name on
/// production because it has eight years of rows that predate the scoping. This
/// row has no legacy at all, so "the same server" is a property OF THE NAME and
/// not a check bolted on top of it.
const RESPONSE_RECEIPT_KEY_PREFIX: &str = "profile_response_receipt:";

/// The two things a receipt can be, and there is no third. `acknowledgement` is
/// the server's 2xx with both halves of the confirmation in it;
/// `already_on_record` is the ONE 409 whose words say the response is already
/// accepted for this profile at this agency. A `source` that is neither is not
/// a receipt this build wrote and is refused by the reader.
const RECEIPT_SOURCE_ACKNOWLEDGEMENT: &str = "acknowledgement";
const RECEIPT_SOURCE_ALREADY_ON_RECORD: &str = "already_on_record";

/// The normalisation of a base, and the same three steps `identity_vault_key`
/// gives one: `trim`, no trailing slash, case-folded. Case matters for the same
/// reason it matters there — `jobs_pilot_api_base` validates a PARSED url while
/// returning the RAW string, so `https://API.skipi.app:8444` is a legal base and
/// two names for one server would hide a receipt from the vault that wrote it.
fn normalized_response_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn response_receipt_key(base: &str, profile_id: &str) -> String {
    format!(
        "{RESPONSE_RECEIPT_KEY_PREFIX}{}:{}",
        normalized_response_base(base),
        profile_id.trim()
    )
}

/// WHAT THE SERVER SAID, and not one field this client invented.
///
/// Every optional field is `Option` and an absent one stays absent: a receipt
/// with a substituted value would be this build's claim about a row it cannot
/// see. `server_created_at` is the server's `created_at` and there is NO local
/// clock anywhere in here — a device clock in a receipt would let a wrong phone
/// time read as a delivery time on a screen the owner accepts from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResponseReceipt {
    pub source: String,
    pub response_id: String,
    pub profile_id: String,
    /// The host that ACTUALLY answered — see `HttpAnswer::base`.
    pub base: String,
    pub vault_user_id: String,
    pub subject_id: String,
    #[serde(default)]
    pub intake_id: Option<String>,
    #[serde(default)]
    pub published_version: Option<i64>,
    #[serde(default)]
    pub crewing_id: Option<String>,
    #[serde(default)]
    pub content_sha256: Option<String>,
    #[serde(default)]
    pub server_created_at: Option<String>,
}

fn ack_text(ack: &serde_json::Value, key: &str) -> Option<String> {
    ack.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The receipt of a CONFIRMED delivery, built from the answer of the host that
/// answered.
///
/// It takes the whole `HttpAnswer` and not a bare string on purpose. On
/// production `response_bases()` is TWO hosts and `send_on_response_bases`
/// walks them, so "the base" and "the base that answered" are different values
/// there — and a receipt naming the first one would say "delivered" about a
/// server that has no such row. On a stand and on the pilot the list is one
/// base and the two are identical, which is exactly why no test on those
/// surfaces could ever tell the difference: the property is pinned by the unit
/// test that hands this function a second base instead.
fn receipt_from_acknowledgement(
    answer: &HttpAnswer,
    ack: &serde_json::Value,
    profile_id: &str,
    response_id: &str,
    vault_user_id: &str,
    subject_id: &str,
) -> ResponseReceipt {
    ResponseReceipt {
        source: RECEIPT_SOURCE_ACKNOWLEDGEMENT.to_string(),
        response_id: response_id.trim().to_string(),
        profile_id: profile_id.trim().to_string(),
        base: answer.base.clone(),
        vault_user_id: vault_user_id.trim().to_string(),
        subject_id: subject_id.trim().to_string(),
        intake_id: ack_text(ack, "intake_id"),
        published_version: ack.get("published_version").and_then(serde_json::Value::as_i64),
        crewing_id: ack_text(ack, "crewing_id"),
        content_sha256: ack_text(ack, "content_sha256"),
        server_created_at: ack_text(ack, "created_at"),
    }
}

/// The receipt of a response the server says is ALREADY ON RECORD.
///
/// Every optional field is `None`, and that is the honest shape: a 409 carries
/// no intake id, no version and no timestamp, so there is nothing to record but
/// the refusal's own meaning. The screen therefore says exactly the sentence the
/// product already says on a repeat press, and claims nothing more.
fn receipt_already_on_record(
    answer: &HttpAnswer,
    profile_id: &str,
    response_id: &str,
    vault_user_id: &str,
    subject_id: &str,
) -> ResponseReceipt {
    ResponseReceipt {
        source: RECEIPT_SOURCE_ALREADY_ON_RECORD.to_string(),
        response_id: response_id.trim().to_string(),
        profile_id: profile_id.trim().to_string(),
        base: answer.base.clone(),
        vault_user_id: vault_user_id.trim().to_string(),
        subject_id: subject_id.trim().to_string(),
        intake_id: None,
        published_version: None,
        crewing_id: None,
        content_sha256: None,
        server_created_at: None,
    }
}

/// WHICH FILE THIS CONNECTION IS ACTUALLY WRITING TO, asked of the sqlite
/// handle itself (`sqlite3_db_filename(db, "main")`) rather than of any state
/// beside it.
///
/// An in-memory database answers with an EMPTY string rather than nothing, so
/// empty is folded into "unknown" here — and unknown is a refusal at every
/// caller. The product never holds an in-memory vault; the unit tests do, and a
/// rule that let two different in-memory handles read as "the same file" would
/// be green for the wrong reason.
fn vault_db_file(conn: &rusqlite::Connection) -> Option<String> {
    conn.path()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// MAY A RECEIPT CAPTURED AGAINST ONE VAULT BE WRITTEN TO THE VAULT THAT IS
/// OPEN NOW?
///
/// The hazard is real and not hypothetical: `submit_profile_response` reads the
/// identity, RELEASES the lock to speak to the server for up to 45 seconds, and
/// takes it again to write, and nothing forbids the open vault being replaced
/// inside that window. The receipt would then carry vault A's `vault_user_id`
/// and land in vault B's file: the reader refuses it afterwards, which is right,
/// but vault A — the one that actually delivered — would be left without its
/// receipt while a stranger's file held its metadata.
///
/// TWO NUMBERS, AND THEY MEAN DIFFERENT THINGS. An earlier version of this
/// comment said "four production sites replace the open vault" and that was
/// simply wrong — it named the second quantity while claiming the first.
/// Counted, not recalled:
///
///   * NINE sites replace the open vault: `commands/vault.rs:591`, `:616`,
///     `:626`, `:727`, `:1067` and `commands/profile.rs:166`, `:898`, `:910`,
///     `:949`. (A tenth, `restore_account_profile`, guards itself by refusing
///     while the vault is closed.) That is the size of the hazard.
///   * FOUR of them — the `profile.rs` ones — update `vault_path` and release
///     its lock BEFORE taking `conn`'s. The five in `vault.rs` hold both locks
///     together and have no lag at all.
///
/// WHY THE FILE OF THE CONNECTION AND NOT `state.vault_path`. Those four
/// lagging sites set `vault_path` FIRST and `conn` SECOND, under two separate
/// locks, so `vault_path` trails the connection during a swap and a comparison
/// against it can be wrong in both directions — including refusing a write to
/// the CORRECT vault. Asking the connection is exact:
/// the object being checked is the object about to be written, inside one
/// critical section, so the window is closed by construction instead of made
/// smaller. `state.vault_path` is also a DIRECTORY (`identity::vault_signing_key`
/// takes `identity_dir` from it), not the database file.
///
/// Fail-closed: an unknown file on either side is a refusal. The string is
/// compared as sqlite resolved it and is never canonicalised — that would mean
/// touching the filesystem while holding the vault lock.
fn same_vault_db(captured: Option<&str>, current: Option<&str>) -> bool {
    match (captured, current) {
        (Some(captured), Some(current)) => !captured.is_empty() && captured == current,
        _ => false,
    }
}

/// DOES THIS STORED RECEIPT BELONG TO THIS VAULT, THIS REGISTRY, THIS PROFILE
/// AND THIS RESPONSE? Five answers, every one of them from the device, and any
/// single "no" means there is no receipt.
///
/// It takes strings and NOTHING ELSE — no endpoint, no flags, no connection. So
/// the decision provably cannot read a non-production predicate: BACKLOG №603
/// is four inline copies of "unknown -> production", and a new call site with a
/// predicate of its own would have widened that class rather than closed it.
/// The base is compared as a normalised string; which base that is comes from
/// `jobs_response_endpoint().base` at the one call site.
///
/// AN EMPTY EXPECTATION IS A REFUSAL, not a wildcard. A vault with no public
/// seafarer id for this base, or with its response id lost, must not match a
/// receipt whose field is equally empty — that would be two absences reading as
/// agreement.
fn accepted_response_receipt(
    stored: &str,
    expected_base: &str,
    expected_vault_user_id: &str,
    expected_subject_id: &str,
    expected_profile_id: &str,
    expected_response_id: &str,
) -> Option<ResponseReceipt> {
    let receipt: ResponseReceipt = serde_json::from_str(stored).ok()?;
    if receipt.source != RECEIPT_SOURCE_ACKNOWLEDGEMENT
        && receipt.source != RECEIPT_SOURCE_ALREADY_ON_RECORD
    {
        return None;
    }
    let same = |inside: &str, expected: &str| -> bool {
        let expected = expected.trim();
        !expected.is_empty() && inside.trim() == expected
    };
    if normalized_response_base(&receipt.base) != normalized_response_base(expected_base)
        || normalized_response_base(expected_base).is_empty()
    {
        return None;
    }
    if !same(&receipt.vault_user_id, expected_vault_user_id) {
        return None;
    }
    if !same(&receipt.subject_id, expected_subject_id) {
        return None;
    }
    if !same(&receipt.profile_id, expected_profile_id) {
        return None;
    }
    if !same(&receipt.response_id, expected_response_id) {
        return None;
    }
    Some(receipt)
}

/// The stand address of a SERVICE BUILD, or nothing at all.
///
/// Compile-time (`option_env!`), inside `#[cfg(debug_assertions)]`, validated by
/// the same eight predicates the already-accepted `SKIPI_SYNC_TEST_BASE`
/// resolver uses (`commands/account_sync.rs:93-100`) — scheme, host, port,
/// username, password, path, query, fragment. A second mechanism is not
/// invented here and the host list has no wildcard.
///
/// Unlike that resolver this one does NOT also read `std::env::var`: a runtime
/// override would be a second way in that the harness cannot see and that the
/// phone cannot set anyway.
///
/// In a release build the `#[cfg]` block is not compiled and this is `None`, so
/// every caller below compiles down to today's `api::` path.
fn jobs_test_api_base() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        if let Some(raw) = option_env!("SKIPI_JOBS_TEST_BASE") {
            if let Ok(url) = reqwest::Url::parse(raw.trim()) {
                if url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "10.0.2.2"))
                    && url.port().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none()
                {
                    return Some(raw.trim().trim_end_matches('/').to_string());
                }
            }
        }
    }
    None
}

/// The PILOT address of a build the owner installs and accepts on, or nothing.
///
/// This exists because the installed release can only reach `api.skipi.app:443`
/// — the shared production server — and the surface this slice is accepted on
/// is NOT there: measured 2026-09-29 with `/health` 200 on both as the
/// calibration, `/api/published-profiles` answers 404 on production and 200 on
/// the pilot at `api.skipi.app:8444` (DECISIONS (869)). A release build with no
/// way to reach the pilot has nowhere to show the scenario at all.
///
/// It is a SECOND resolver and not a widened first one, because the first lives
/// inside `#[cfg(debug_assertions)]` and therefore does not exist in the build
/// the owner installs. This one carries no `cfg`, so it reaches the release
/// binary — and that is exactly why its validation is STRICTER than the stand's,
/// not looser:
///
///   * scheme `https` and nothing else (the stand allows `http`; this must not);
///   * host exactly `api.skipi.app`, one literal, no wildcard, no prefix match;
///   * a port is mandatory, and it may not be 443. `Url::port()` already
///     normalises the scheme default away (`url-2.5.8` doctest:
///     `https://example.com:443/` -> `None`), so the first predicate alone
///     rejects production; the second is written out so the property does not
///     depend on that crate keeping its behaviour.
///
/// Compile-time only (`option_env!`), exactly like the stand resolver and for
/// the same two reasons: an Android process cannot be handed a variable, and a
/// runtime `std::env::var` would be a second way in that the harness cannot see.
///
/// With the variable absent this returns `None` before doing anything else, so
/// every caller below compiles down to today's `api::` path and the build is
/// the one that ships today.
fn jobs_pilot_api_base() -> Option<String> {
    if let Some(raw) = option_env!("SKIPI_PILOT_API_BASE") {
        if let Ok(url) = reqwest::Url::parse(raw.trim()) {
            if url.scheme() == "https"
                && url.host_str() == Some("api.skipi.app")
                && url.port().is_some()
                && url.port() != Some(443)
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
            {
                return Some(raw.trim().trim_end_matches('/').to_string());
            }
        }
    }
    None
}

/// THE ONE PLACE that answers "is a non-production base compiled into this
/// build, and which one" — stand first, then pilot, then nothing.
///
/// One branch point rather than two, so that a reader auditing "can this build
/// write to production" has a single function to read and the two callers
/// below cannot drift apart from each other.
///
/// WHAT THIS DOES NOT MOVE, said here because the name invites the wrong
/// reading. Exactly two calls of this file take their base from
/// `response_bases()`: the published-profiles GET and the response POST. The
/// other Jobs features — the vacancy feed, the mailing-request calls, the vessel
/// projection and the recent reviews, and the counter — reach `api::` directly
/// and are production-only before and after, and TWO OF THOSE ARE WRITES. A
/// pilot build sends them to production exactly as today's build does. That set
/// is enumerated by `I10` in the harness, which reds on a new direct caller.
fn jobs_non_production_base() -> Option<String> {
    if let Some(stand) = jobs_test_api_base() {
        return Some(stand);
    }
    if let Some(pilot) = jobs_pilot_api_base() {
        return Some(pilot);
    }
    None
}

/// Every base this slice's requests may use, and NOTHING beyond them.
///
/// When a non-production base is compiled in — a stand OR the pilot — the
/// returned list is EXACTLY ONE base and the production hosts are not in it at
/// all. That is the difference between this and `api::api_bases()`, which
/// answers a loopback override with `[stand, api.skipi.app, api-ru.skipi.app]`
/// — on that list a base that is down is not an error, it is a production write.
///
/// Preference order: stand (debug builds only), then pilot, then production.
fn response_bases() -> Vec<String> {
    if let Some(only) = jobs_non_production_base() {
        return vec![only];
    }
    api::api_bases()
}

/// Which host the response path will actually talk to, and WHICH OF THE THREE
/// KINDS of build this is. The UI renders a line from this whenever the build
/// is not the production one, so the screenshot of a visual acceptance records
/// the server as well as the screen.
///
/// Three states and not two, because a pilot build IS NOT A SERVICE BUILD. The
/// owner accepts on it; calling it "service build" on his screen would name the
/// wrong thing, and the two flags are kept separate rather than one flag reused
/// for both meanings:
///
///   stand=true,  pilot=false -> a debug service build pointed at a stand
///   stand=false, pilot=true  -> an installed build pointed at the pilot
///   stand=false, pilot=false -> the production build, unchanged
///
/// `stand` keeps EXACTLY the meaning it had; the WebView guards that used to
/// read it alone now read both, because "may this build write to production" is
/// answered by the pair and not by either flag.
#[derive(Debug, Clone, Serialize)]
pub struct JobsResponseEndpoint {
    pub base: String,
    pub stand: bool,
    pub pilot: bool,
}

#[tauri::command]
pub fn jobs_response_endpoint() -> JobsResponseEndpoint {
    if let Some(stand) = jobs_test_api_base() {
        return JobsResponseEndpoint {
            base: stand,
            stand: true,
            pilot: false,
        };
    }
    if let Some(pilot) = jobs_pilot_api_base() {
        return JobsResponseEndpoint {
            base: pilot,
            stand: false,
            pilot: true,
        };
    }
    JobsResponseEndpoint {
        base: response_bases()
            .first()
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        stand: false,
        pilot: false,
    }
}

/// The GET side of the same rule as the POST side: when ANY non-production base
/// is compiled in — stand or pilot — the published-profiles list is read from
/// THAT host and from nowhere else, and a failure there is a failure. With
/// neither this is byte-for-byte today's `api::get_json`, and the build that
/// ships cannot tell the difference.
fn get_json_for_response_path<T>(
    client: &reqwest::blocking::Client,
    path: &str,
) -> Result<T, String>
where
    T: serde::de::DeserializeOwned,
{
    if jobs_non_production_base().is_some() {
        let answer = send_on_response_bases(client, false, path, None, None)?;
        if !(200..300).contains(&answer.status) {
            return Err(format!("server returned {}: {}", answer.status, answer.body));
        }
        return serde_json::from_str(&answer.body).map_err(|e| format!("bad JSON: {e}"));
    }
    api::get_json(client, path)
}

struct HttpAnswer {
    status: u16,
    body: String,
    /// THE HOST THAT ANSWERED, and not the first one tried.
    ///
    /// `send_on_response_bases` walks `response_bases()` and a transport error
    /// moves to the next base when there is one. On production that list is two
    /// hosts and the first of them is `api-ru.skipi.app`, which is down
    /// (BACKLOG №607) — so "which base" and "which base answered" are genuinely
    /// different values, and a receipt that named the wrong one would tell a
    /// seafarer his response is on a server that has never seen it.
    base: String,
}

/// One request over `response_bases()`. A transport error moves to the next
/// base ONLY IF THERE IS ONE; with a stand or the pilot compiled in there is
/// not, so the error is returned as an error and nothing is asked again
/// anywhere else. A pilot that is down is an error on the screen, never a
/// write to production.
///
/// An HTTP answer — any status — ends the walk. A 4xx/5xx from a stand or the
/// pilot is that server's answer, not a reason to ask a different host the same
/// question.
fn send_on_response_bases(
    client: &reqwest::blocking::Client,
    method_post: bool,
    path: &str,
    body: Option<&serde_json::Value>,
    bearer: Option<&str>,
) -> Result<HttpAnswer, String> {
    let bases = response_bases();
    let mut last_err = String::from("API unavailable");
    for (idx, base) in bases.iter().enumerate() {
        let url = format!("{}{}", base.trim_end_matches('/'), path);
        let mut req = if method_post {
            match body {
                Some(json) => client.post(&url).json(json),
                None => client.post(&url),
            }
        } else {
            client.get(&url)
        };
        req = req.header(reqwest::header::ACCEPT, "application/json");
        if let Some(token) = bearer {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        match req.send() {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let text = resp.text().unwrap_or_default();
                return Ok(HttpAnswer {
                    status,
                    body: text,
                    // The loop variable, and only it: this is the one place in
                    // the file that knows which walk step actually answered.
                    base: base.clone(),
                });
            }
            Err(e) => {
                last_err = format!("network: {e}");
                if idx + 1 < bases.len() {
                    continue;
                }
            }
        }
    }
    Err(last_err)
}

/// `json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`
/// — the server's `canonical_payload_bytes` (`app/trust_service.py:155-158`),
/// byte for byte, because a signature over anything else is simply invalid.
///
/// Only the flat all-string object of a self-session challenge is representable
/// here, and that is deliberate: it removes number formatting from the problem
/// entirely instead of hoping Rust and Python agree on it.
fn canonical_self_session_bytes(fields: &[(String, String)]) -> Vec<u8> {
    let mut sorted: Vec<&(String, String)> = fields.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::from("{");
    for (idx, (key, value)) in sorted.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        out.push_str(&json_ascii_string(key));
        out.push(':');
        out.push_str(&json_ascii_string(value));
    }
    out.push('}');
    out.into_bytes()
}

/// A JSON string literal the way `ensure_ascii=True` writes one: every
/// non-ASCII code point becomes `\uXXXX` (a surrogate pair above the BMP),
/// `/` is NOT escaped, and control characters use their short forms.
fn json_ascii_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if (c as u32) < 0x7f => out.push(c),
            c => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
        }
    }
    out.push('"');
    out
}

/// Sign ONE self-session challenge with the vault's Ed25519 identity key.
///
/// NOT A SIGNING ORACLE, and the checks below are what makes that true rather
/// than a hope. A command that signed whatever JSON it was handed would let any
/// script in the WebView mint a signature over arbitrary bytes with the key
/// that IS the seafarer's identity. So:
///
///   * the payload must be an object whose key set is EXACTLY the seven keys of
///     the server's `_challenge_payload_to_sign`, every value a string;
///   * `schema` and `audience` must be the self-session constants;
///   * `vault_user_id` must be THIS vault's own — derived here from the key,
///     never taken from the caller.
///
/// A payload that fails any of these is refused, not signed. The private key
/// does not leave the vault and no part of it is returned.
#[tauri::command]
pub fn sign_self_session_challenge(
    state: tauri::State<crate::AppState>,
    payload: serde_json::Value,
) -> Result<String, String> {
    use ed25519_dalek::Signer;
    let vault = {
        let guard = state
            .vault_path
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned().ok_or("No vault open")?
    };
    let signing = crate::identity::vault_signing_key(&vault)?;
    let own_user_id = crate::identity::user_id_for_pubkey(&signing.verifying_key().to_bytes());

    let object = payload
        .as_object()
        .ok_or("self-session payload must be a JSON object")?;
    let mut fields: Vec<(String, String)> = Vec::new();
    for (key, value) in object {
        let text = value
            .as_str()
            .ok_or_else(|| format!("self-session payload field '{key}' must be a string"))?;
        fields.push((key.clone(), text.to_string()));
    }
    let mut present: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    present.sort_unstable();
    if present != SELF_SESSION_PAYLOAD_KEYS {
        return Err("not a self-session challenge payload".to_string());
    }
    let field = |name: &str| -> String {
        fields
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    if field("schema") != SELF_SESSION_SCHEMA || field("audience") != SELF_SESSION_AUDIENCE {
        return Err("not a self-session challenge payload".to_string());
    }
    if field("vault_user_id") != own_user_id {
        return Err("challenge belongs to a different vault identity".to_string());
    }

    let message = canonical_self_session_bytes(&fields);
    let signature = signing.sign(&message);
    Ok(base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()))
}

/// The response id for ONE profile, created once and then returned unchanged.
///
/// It lives in the vault's `vault_info` table — the vault's own SQLite file on
/// disk — so a retry after the app was killed, or after the phone was
/// restarted, sends THE SAME id and the server recognises the retry as the same
/// response rather than storing a second one. `localStorage` would not do: it is
/// the WebView's, cleared with app data, and the vault can move between devices
/// while the response it already sent cannot.
///
/// An ASCII-safe hyphenated UUID, because the server puts this value into a
/// MIME boundary (`app/profile_response_service.py`).
#[tauri::command]
pub fn ensure_profile_response_id(
    state: tauri::State<crate::AppState>,
    profile_id: String,
) -> Result<String, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() {
        return Err("profile id is required".to_string());
    }
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let key = format!("{RESPONSE_ID_KEY_PREFIX}{profile_id}");
    if let Some(existing) = crate::db::get_vault_info_value(conn, &key) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let fresh = uuid::Uuid::new_v4().to_string();
    crate::db::set_vault_info(conn, &key, &fresh).map_err(|e| e.to_string())?;
    Ok(fresh)
}

// ════════════════════════════════════════════════════════════════════════════
// THE TEN VALUES THAT TRAVEL WITH A RESPONSE — №623 S2.
//
// A crewing that opens a response sees WHO responded. The five things it needs
// — name, age, citizenship, experience in the rank, last vessel — live in this
// seafarer's vault and in his `work_history`, and they are read FROM THERE and
// from nowhere else. Not one of them is a parameter of `submit_profile_response`
// and not one of them can become one: the moment a caller can name the first
// name on a response, the name on the crewing's screen stops being evidence of
// anything. This is the same rule the contact and the identity already follow
// one function below — "a response is delivered as the seafarer whose key signs
// for it" — and these ten go the same way for the same reason.
//
// THE RULE THAT OUTRANKS ALL TEN: none of them may make a response
// undeliverable. Every function in this block is total. There is no `?`, no
// `unwrap`, no `expect` and no arithmetic that can overflow on any input a
// vault can hold; a value that cannot be computed honestly is simply `None` and
// the field is then not sent at all. A response carries a living person's CV,
// and a defect in a metadata field has no right to destroy it.
//
// WHY A SEPARATE EXPERIENCE CALCULATION EXISTS, stated here because a reader
// will otherwise reach for one of the two that already exist:
//
//   * `cv::experience_by_position` sums `+=` per position without merging
//     overlaps and calls itself `rough`. It is NOT touched: its consumers are
//     the CV PDF and the assistant, and changing it changes both.
//   * `profile::compute_years_experience` sums EVERY position together, again
//     without merging, divides by 365, and always answers `Some` — so "no data"
//     and "zero" are one value there. It is NOT touched either: its result
//     leaves in the comparative profile, and changing what that profile
//     compares is a STOP on this card.
//
// Neither can answer "days in THIS rank, overlaps merged, absent when unknown",
// so this block answers it. The AGE question is a different case and is told
// straight in `age_years_on` below: `profile::compute_age_bucket` counts the
// same way, sharing it was written and then WITHDRAWN because that diff has no
// guard route, and the copy that remains is held to the original by a drill
// that compares the whole computation, not a symbol that does not exist.
// ════════════════════════════════════════════════════════════════════════════

/// The ten names, and the complete list of what this client may add to a
/// response body.
///
/// The server's `ProfileResponseSubmit` is `extra="forbid"`: an unknown field
/// NAME does not get ignored, it rejects the whole body — the CV with it. So
/// this list is not documentation, it is the contract, and the test below
/// asserts that nothing outside it is ever written.
pub(crate) const RESPONSE_SUMMARY_FIELDS: [&str; 10] = [
    "seafarer_first_name",
    "seafarer_surname",
    "seafarer_age_years",
    "seafarer_age_precision",
    "seafarer_citizenship",
    "seafarer_citizenship_code",
    "rank_experience_rank",
    "rank_experience_days",
    "last_vessel_name",
    "last_vessel_sign_off",
];

/// What the vault says about this seafarer. Every field optional because a
/// half-filled profile is the normal state of a real one.
#[derive(Debug, Clone, Default)]
pub(crate) struct SummaryPersonal {
    pub first_name: Option<String>,
    pub surname: Option<String>,
    pub dob: Option<String>,
    pub nationality: Option<String>,
    pub nationality_code: Option<String>,
    /// THE RANK THIS RESPONSE IS FOR, and the reason it is not a parameter.
    ///
    /// The Jobs screen asks the server for published profiles with
    /// `rank: jobsProfilesOwnRank(sp)` (`dist/index.html:14983`), which is
    /// `String(sp.rank).trim()` over `get_seafarer_personal`, whose `rank` is
    /// the vault's `personal_rank` with `rank` as the fallback
    /// (`commands/profile.rs`). The profile being responded to was SELECTED BY
    /// THE SERVER on that exact string. Reading the same value here sends the
    /// server back the string it already matched on, and no caller is given a
    /// say in it.
    pub rank: Option<String>,
}

/// One `work_history` row, reduced to the four columns this summary reads.
#[derive(Debug, Clone, Default)]
pub(crate) struct SummaryWorkRow {
    pub position: String,
    pub vessel_name: String,
    pub sign_on: Option<String>,
    pub sign_off: Option<String>,
}

/// The ten values. `None` means "this client could not say it honestly", and a
/// `None` is never sent — which is how the crewing's screen can tell "he did
/// not fill this in" from a real value, and why a zero here is a real zero.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ResponseSummary {
    pub first_name: Option<String>,
    pub surname: Option<String>,
    pub age_years: Option<i64>,
    pub age_precision: Option<&'static str>,
    pub citizenship: Option<String>,
    pub citizenship_code: Option<String>,
    pub experience_rank: Option<String>,
    pub experience_days: Option<i64>,
    pub last_vessel_name: Option<String>,
    pub last_vessel_sign_off: Option<String>,
}

/// Total days covered by a set of periods WITH OVERLAPS MERGED, never summed.
///
/// Two contracts that overlap in time are one stretch of a life, not two: a man
/// who signed on 1 January and off 1 July, and signed on 1 April and off 1
/// October, served nine months and not twelve. `cv::work_entry_days` summed by
/// `+=` is what this exists instead of, and it is left where it is.
///
/// Half-open `[on, off)`, so periods that merely touch add up to the same total
/// whether they are merged or not, and a day is never counted twice.
fn merged_interval_days(periods: &[(chrono::NaiveDate, chrono::NaiveDate)]) -> i64 {
    let mut sorted: Vec<(chrono::NaiveDate, chrono::NaiveDate)> = periods.to_vec();
    sorted.sort();
    let mut total: i64 = 0;
    let mut open: Option<(chrono::NaiveDate, chrono::NaiveDate)> = None;
    for (on, off) in sorted {
        match open {
            // The next period starts before the open one has ended (or exactly
            // when it does): one stretch, extended to whichever end is later.
            Some((start, end)) if on <= end => {
                open = Some((start, if off > end { off } else { end }));
            }
            Some((start, end)) => {
                total = total.saturating_add((end - start).num_days());
                open = Some((on, off));
            }
            None => open = Some((on, off)),
        }
    }
    if let Some((start, end)) = open {
        total = total.saturating_add((end - start).num_days());
    }
    total
}

/// A period this client is willing to measure — and the one place where "no
/// data" is told apart from "zero".
///
/// Both dates must parse, and `off` must not be BEFORE `on`. Note `>=` and not
/// `>`: signing on and off on the same day is a real contract that lasted zero
/// days, which is a fact, whereas a missing or unparsable date is not a fact at
/// all. `cv::work_entry_days` collapses both to `0` and cannot tell them apart;
/// that is exactly what this card was told to fix, and why that function is
/// left alone rather than changed under its own consumers.
fn measurable_period(row: &SummaryWorkRow) -> Option<(chrono::NaiveDate, chrono::NaiveDate)> {
    let parse =
        |s: &Option<String>| -> Option<chrono::NaiveDate> {
            chrono::NaiveDate::parse_from_str(s.as_deref()?.trim(), "%Y-%m-%d").ok()
        };
    let on = parse(&row.sign_on)?;
    let off = parse(&row.sign_off)?;
    if off >= on {
        Some((on, off))
    } else {
        None
    }
}

/// A vault string that is worth sending: trimmed, and absent when it is blank.
fn present(value: &Option<String>) -> Option<String> {
    let trimmed = value.as_deref()?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The ten values from what the vault holds. Total: no input produces an error.
fn build_response_summary(
    personal: &SummaryPersonal,
    rows: &[SummaryWorkRow],
    today: chrono::NaiveDate,
) -> ResponseSummary {
    let (age_years, age_precision) = age_with_precision(personal.dob.as_deref(), today);

    // EXPERIENCE IN THE RANK THIS RESPONSE IS FOR. The rank must be known
    // before any of it means anything, and the days and the rank are sent as a
    // pair or not at all: a number of days that does not say what they are days
    // OF is not information, it is a number on a stranger's screen.
    let experience_rank = present(&personal.rank);
    let experience_days = experience_rank.as_deref().and_then(|rank| {
        let periods: Vec<(chrono::NaiveDate, chrono::NaiveDate)> = rows
            .iter()
            .filter(|row| row.position.trim() == rank)
            .filter_map(measurable_period)
            .collect();
        // EMPTY IS NOT ZERO. No measurable period means this client cannot say
        // how long he served in the rank, and it says nothing rather than "0".
        // One period of no length means he served zero days, and it says zero.
        if periods.is_empty() {
            None
        } else {
            Some(merged_interval_days(&periods))
        }
    });
    let experience_rank = experience_rank.filter(|_| experience_days.is_some());

    let last = last_vessel(rows);

    ResponseSummary {
        first_name: present(&personal.first_name),
        surname: present(&personal.surname),
        age_years,
        age_precision,
        citizenship: present(&personal.nationality),
        citizenship_code: present(&personal.nationality_code),
        experience_rank,
        experience_days,
        last_vessel_name: last.as_ref().and_then(|row| present(&Some(row.vessel_name.clone()))),
        last_vessel_sign_off: last.as_ref().and_then(|row| present(&row.sign_off)),
    }
}

/// COMPLETED YEARS between a written date of birth and a reference day.
///
/// THE SAME ARITHMETIC AS `profile::compute_age_bucket`, AND DELIBERATELY A
/// COPY OF IT RATHER THAN A SHARED CALL. Sharing it is the better code and it
/// was written that way first: `compute_age_bucket` gave up these three lines
/// as a `pub(crate)` helper and both callers used it. That diff cannot be
/// pushed. The guard routes this area through `jobs-profile-visibility-s2`,
/// whose file set is `dist/index.html`, `commands/jobs.rs`, `lib.rs` and this
/// area's harness; a diff that also touches `commands/profile.rs` matches no
/// route, falls back to `plugin-host` and is refused. Widening that route is an
/// owner-gated change to the guard's allowlist, and spending an owner decision
/// on de-duplicating three lines is the wrong trade — so the duplication is
/// made VISIBLE here instead of being quietly convenient.
///
/// The drift this buys is real and is drilled, not hoped about: `S623-20` in
/// the harness reds if either copy stops using the same two calls.
///
/// No `trim`, for the same reason the other copy has none: what the comparative
/// profile buckets must not start changing because of this card. Callers trim
/// on their own side. `today` is a parameter so a test can state an age instead
/// of deriving it from the clock it is checking.
fn age_years_on(dob: &str, today: chrono::NaiveDate) -> Option<u32> {
    let parsed = chrono::NaiveDate::parse_from_str(dob, "%Y-%m-%d").ok()?;
    today.years_since(parsed)
}

/// How old he is, and HOW WELL THIS CLIENT KNOWS IT — never the date of birth.
///
/// A full date gives completed years and `exact`. A bare year gives the years
/// that year has turned and `year`, because saying "34" to the day when only
/// the year is written would be inventing a birthday. Anything else, and a date
/// in the future, give NEITHER — and neither half is ever sent without the
/// other, since a number without its precision is a claim this client cannot
/// support.
///
/// THE DATE ITSELF NEVER LEAVES. The server neither needs nor stores it, and a
/// field derived from the current clock would make a legitimate retry of the
/// same `response_id` disagree with the stored row for ever.
fn age_with_precision(
    dob: Option<&str>,
    today: chrono::NaiveDate,
) -> (Option<i64>, Option<&'static str>) {
    let raw = match dob.map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) => value,
        None => return (None, None),
    };
    // The comparative profile's own age function, reused rather than repeated.
    if let Some(years) = age_years_on(raw, today) {
        return (Some(i64::from(years)), Some("exact"));
    }
    // A bare year. The vault value is free text — account sync can bring in a
    // profile this app did not type — so the year-only form is a state that
    // reaches here, and the honest answer names its own coarseness.
    if raw.len() == 4 && raw.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(year) = raw.parse::<i32>() {
            let years = i64::from(chrono::Datelike::year(&today)) - i64::from(year);
            if (0..=130).contains(&years) {
                return (Some(years), Some("year"));
            }
        }
    }
    (None, None)
}

/// The ship he came off LAST — by time, not by where the row sits in the table.
///
/// Ordered by sign-off where there is one and by sign-on where there is not, so
/// a vessel he is still serving on is correctly the last one and simply has no
/// sign-off to report. A row this client cannot place in time is not a
/// candidate: "the latest" would then be a guess. Equal keys keep the later row
/// as the table returns them.
///
/// NOT filtered by the responded rank: the contract field is `last_vessel_name`
/// and the crewing is being told which ship he came off, whatever he was rated
/// as on it.
fn last_vessel(rows: &[SummaryWorkRow]) -> Option<SummaryWorkRow> {
    let parse = |s: &Option<String>| -> Option<chrono::NaiveDate> {
        chrono::NaiveDate::parse_from_str(s.as_deref()?.trim(), "%Y-%m-%d").ok()
    };
    rows.iter()
        .filter_map(|row| {
            parse(&row.sign_off)
                .or_else(|| parse(&row.sign_on))
                .map(|key| (key, row))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, row)| row.clone())
}

/// Write the computed values into the body under the ten contract names, and
/// write NOTHING ELSE. An absent value is an absent key, never `null` and never
/// an empty string: the server tells "he did not say" from "he said nothing"
/// by the key not being there.
fn apply_summary_to_body(body: &mut serde_json::Value, summary: &ResponseSummary) {
    let mut put = |name: &str, value: serde_json::Value| {
        debug_assert!(
            RESPONSE_SUMMARY_FIELDS.contains(&name),
            "{name} is not one of the ten the server's schema declares"
        );
        body[name] = value;
    };
    if let Some(v) = summary.first_name.as_deref() {
        put("seafarer_first_name", serde_json::Value::from(v));
    }
    if let Some(v) = summary.surname.as_deref() {
        put("seafarer_surname", serde_json::Value::from(v));
    }
    // The pair travels whole or not at all, on this side as on the server's.
    if let (Some(years), Some(precision)) = (summary.age_years, summary.age_precision) {
        put("seafarer_age_years", serde_json::Value::from(years));
        put("seafarer_age_precision", serde_json::Value::from(precision));
    }
    if let Some(v) = summary.citizenship.as_deref() {
        put("seafarer_citizenship", serde_json::Value::from(v));
    }
    if let Some(v) = summary.citizenship_code.as_deref() {
        put("seafarer_citizenship_code", serde_json::Value::from(v));
    }
    if let (Some(rank), Some(days)) = (summary.experience_rank.as_deref(), summary.experience_days)
    {
        put("rank_experience_rank", serde_json::Value::from(rank));
        put("rank_experience_days", serde_json::Value::from(days));
    }
    if let Some(v) = summary.last_vessel_name.as_deref() {
        put("last_vessel_name", serde_json::Value::from(v));
    }
    if let Some(v) = summary.last_vessel_sign_off.as_deref() {
        put("last_vessel_sign_off", serde_json::Value::from(v));
    }
}

/// The four `work_history` columns this summary reads, and no join.
///
/// A missing table, a failed statement or a row that will not map is an EMPTY
/// LIST and never an error — see the rule at the top of this block.
fn read_summary_work_rows(conn: &rusqlite::Connection) -> Vec<SummaryWorkRow> {
    let mut stmt =
        match conn.prepare("SELECT position, vessel_name, sign_on, sign_off FROM work_history") {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
    let mapped = stmt.query_map([], |row| {
        Ok(SummaryWorkRow {
            position: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            vessel_name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            sign_on: row.get::<_, Option<String>>(2)?,
            sign_off: row.get::<_, Option<String>>(3)?,
        })
    });
    match mapped {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// The ten values, read out of THIS vault connection.
///
/// IT DOES NOT TAKE THE LOCK, and that is deliberate twice over. The caller is
/// already inside the critical section that produced the identity, so the
/// summary and the identity come from ONE vault and cannot be split by a vault
/// swap mid-flight. And `jobs_profile_visibility_harness.mjs` (I18c) counts
/// `state.conn.lock()` inside `submit_profile_response` and requires exactly
/// three; a fourth lock here would break that gate while making the code worse.
///
/// Total on every input, including a vault with no tables at all.
pub(crate) fn read_response_summary(conn: &rusqlite::Connection) -> ResponseSummary {
    let get = |key: &str| crate::db::get_vault_info_value(conn, key);
    let personal = SummaryPersonal {
        first_name: get("personal_first_name"),
        surname: get("personal_surname"),
        dob: get("personal_dob"),
        nationality: get("personal_nationality"),
        nationality_code: get("personal_nationality_code"),
        // The same order `get_seafarer_personal` answers in, because the value
        // it answers with is the one the Jobs screen sent as the server's rank
        // filter — the filter that selected the profile being responded to.
        rank: get("personal_rank").or_else(|| get("rank")),
    };
    let rows = read_summary_work_rows(conn);
    build_response_summary(&personal, &rows, chrono::Utc::now().date_naive())
}

/// Deliver ONE response to ONE published matching profile.
///
/// Success is the SERVER'S acknowledgement and nothing earlier. This function
/// returns `Ok` only when the body it read back says `delivered: true` AND
/// names an `intake_id` — the row an agency will open. A 2xx with any other body
/// is a failure here, because the one thing a client must not do on this surface
/// is tell a seafarer his CV arrived when it did not.
///
/// 201 (first time) and 200 (a replay of the same `response_id`) are BOTH
/// success and neither is distinguished: the acknowledgement is read from the
/// body, so a legitimate retry cannot be shown as a failure.
///
/// `published_version` is NOT sent. The server's `ProfileResponseSubmit` is
/// `extra="forbid"` and has no such field (`app/schemas.py:487-519`): it copies
/// the version out of the frozen snapshot itself, and a client-declared version
/// would be a claim about a row the client cannot see. It comes BACK in the
/// acknowledgement, and that is what the UI shows.
#[tauri::command]
pub fn submit_profile_response(
    state: tauri::State<crate::AppState>,
    profile_id: String,
    response_id: String,
    cv_path: String,
    cv_content_type: Option<String>,
    message: Option<String>,
) -> Result<serde_json::Value, String> {
    let profile_id = profile_id.trim().to_string();
    let response_id = response_id.trim().to_string();
    if profile_id.is_empty() || response_id.is_empty() {
        return Err("profile id and response id are required".to_string());
    }

    // Identity and contact are read from the vault, never accepted from the
    // caller: a response is delivered as the seafarer whose key signs for it.
    // `vault_db` is the file this identity was read OUT OF, captured in the very
    // same critical section as the identity itself — see `same_vault_db` for the
    // swap it exists to refuse.
    let (vault_user_id, public_seafarer_id, contact, vault_db, summary) = {
        let vault = {
            let guard = state
                .vault_path
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            guard.as_ref().cloned().ok_or("No vault open")?
        };
        let signing = crate::identity::vault_signing_key(&vault)?;
        let user_id = crate::identity::user_id_for_pubkey(&signing.verifying_key().to_bytes());
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = lock.as_ref().ok_or("No vault open")?;
        // THE ID OF THE REGISTRY THIS RESPONSE IS BEING DELIVERED TO, and never
        // another registry's: the self-session below is minted from this value on
        // that same host, and an id it never issued is an id it does not know.
        let endpoint = jobs_response_endpoint();
        let public_id =
            crate::db::get_vault_info_value(conn, &identity_vault_key(&endpoint, KEY_PUBLIC_SEAFARER_ID))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or("this vault has no public seafarer id yet")?;
        let contact = crate::db::get_vault_info_value(conn, "personal_email")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or("add an e-mail to your profile before responding")?;
        // Asked of THIS connection, while the lock that produced the identity
        // above is still held. Anything read later would be read of whatever
        // connection is open by then, which is the problem and not the check.
        // THE TEN VALUES OF №623, read from THIS connection inside THIS
        // critical section — the same one that produced the identity above, so
        // the name on the crewing's screen and the key that signs for it can
        // never come from two different vaults. Total: it returns a summary for
        // every vault, including an unreadable one, and cannot fail a delivery.
        let summary = read_response_summary(conn);
        (user_id, public_id, contact, vault_db_file(conn), summary)
    };

    let cv_bytes = std::fs::read(&cv_path).map_err(|e| format!("could not read the CV: {e}"))?;
    if cv_bytes.is_empty() {
        return Err("the generated CV is empty".to_string());
    }
    let cv_base64 = base64::engine::general_purpose::STANDARD.encode(&cv_bytes);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .connect_timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    let bearer = mint_self_session(&state, &client, &vault_user_id, &public_seafarer_id)?;

    let mut body = serde_json::json!({
        "response_id": response_id,
        "contact": contact,
        "cv_content_type": cv_content_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("application/pdf"),
        "cv_base64": cv_base64,
    });
    if let Some(text) = message.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        body["message"] = serde_json::Value::String(text.to_string());
    }
    // The ten of №623, each one written only if the vault could answer it.
    // Nothing here can fail: the summary is already computed and this only
    // copies what is present. A field that is absent is an absent KEY, which is
    // how the crewing tells "he did not fill it in" from a value.
    apply_summary_to_body(&mut body, &summary);

    let answer = send_on_response_bases(
        &client,
        true,
        &format!("/api/published-profiles/{}/responses", urlencoding(&profile_id)),
        Some(&body),
        Some(&bearer),
    )?;

    // The conflicts, and the ONE place the server's own words are read and then
    // dropped: they tell the reasons apart, and not one of them is repeated to
    // a seafarer. See `response_conflict_token` for what those words can and
    // cannot prove.
    if answer.status == 409 {
        let token = response_conflict_token(&answer.body);
        // WRITE SITE 2 — THE ONE 409 WHOSE WORDS MEAN THE RESPONSE IS ON RECORD,
        // and no other refusal of this route.
        //
        // The sentence `INTAKE_CONTENT_CONFLICT` is raised by the server in two
        // places (`candidate_intake_service.py:330` by event and `:417` through
        // the tombstone lookup) and in BOTH of them the response was delivered.
        // `RESPONSE_CONFLICT_UNKNOWN` is "a conflict whose reason this build does
        // not know" — the other three refusals that share this status code — and
        // it writes nothing at all, because a receipt is a statement about a
        // delivery and this build cannot make that statement here. A transport
        // error left through the `?` above and never reaches this branch; a
        // withdrawn profile answers 404 and falls through to the error below.
        //
        // The lock is taken HERE, after the request, and held for these two
        // statements only — never across a request (see `ensure_seafarer_identity`
        // for why that shape matters and what it cost).
        if token == RESPONSE_ALREADY_DELIVERED {
            let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
            // NOT INTO A VAULT THAT IS NO LONGER THE ONE THAT SPOKE. The vault
            // may have been replaced while the request was in flight, and this
            // receipt names the identity of the vault that sent it. A mismatch
            // writes NOTHING — not here and not anywhere else — and says nothing
            // outward: the screen is then today's screen, exactly as it is when
            // the vault cannot be written at all.
            if let Some(conn) = lock
                .as_ref()
                .filter(|conn| same_vault_db(vault_db.as_deref(), vault_db_file(conn).as_deref()))
            {
                let receipt = receipt_already_on_record(
                    &answer,
                    &profile_id,
                    &response_id,
                    &vault_user_id,
                    &public_seafarer_id,
                );
                // A vault that cannot be written is NOT a different refusal: the
                // seafarer reads the same sentence either way, and the receipt
                // simply stays absent — which is today's screen, byte for byte.
                if let Ok(json) = serde_json::to_string(&receipt) {
                    let _ = crate::db::set_vault_info(
                        conn,
                        &response_receipt_key(&answer.base, &profile_id),
                        &json,
                    );
                }
            }
        }
        return Err(token.to_string());
    }
    if !(200..300).contains(&answer.status) {
        return Err(format!("server returned {}: {}", answer.status, answer.body));
    }
    let ack: serde_json::Value = serde_json::from_str(&answer.body)
        .map_err(|e| format!("the server's acknowledgement did not parse: {e}"))?;
    if ack.get("delivered").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("the server did not confirm the response was stored".to_string());
    }
    let intake_id = ack
        .get("intake_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if intake_id.is_none() {
        return Err("the server did not confirm the response was stored".to_string());
    }

    // WRITE SITE 1 — THE SERVER'S CONFIRMATION, AND NOTHING EARLIER.
    //
    // Deliberately BELOW both halves of the check above and above `Ok(ack)`: a
    // 2xx without `delivered` or without an `intake_id` is already a failure on
    // this surface, and a receipt written before those two lines would turn it
    // into a delivery that never happened. Nothing local — the press, a
    // response id, a timeout — reaches this point.
    //
    // The lock is taken here, after the request, for these two statements only.
    {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        // The same refusal as the 409 branch, and for the same reason: a vault
        // swapped during the request must not receive another vault's receipt,
        // and the vault that delivered must not have one written on its behalf
        // into somebody else's file. See `same_vault_db`.
        if let Some(conn) = lock
            .as_ref()
            .filter(|conn| same_vault_db(vault_db.as_deref(), vault_db_file(conn).as_deref()))
        {
            let receipt = receipt_from_acknowledgement(
                &answer,
                &ack,
                &profile_id,
                &response_id,
                &vault_user_id,
                &public_seafarer_id,
            );
            // A vault that cannot be written is NOT a failed delivery. The
            // server has the response, and the one thing this surface must
            // never do is tell a seafarer otherwise — so the write is best
            // effort and the fallback is today's screen, byte for byte.
            if let Ok(json) = serde_json::to_string(&receipt) {
                let _ = crate::db::set_vault_info(
                    conn,
                    &response_receipt_key(&answer.base, &profile_id),
                    &json,
                );
            }
        }
    }
    Ok(ack)
}

/// WHAT THIS DEVICE ALREADY KNOWS ABOUT RESPONSES IT HAS DELIVERED — read from
/// the vault, and from nowhere else. No network, no parameters beyond the ids on
/// the screen, no writes.
///
/// This is the half of №605 that was missing: the response id survived a cold
/// start and so did the server's row, but the screen had no way to learn either,
/// so the card came back with an active irreversible button on a response
/// already delivered.
///
/// FAIL-CLOSED BY CONSTRUCTION. A receipt reaches the WebView only when all five
/// of `accepted_response_receipt`'s conditions hold; a locked vault, an
/// unparsable row, another vault's receipt, another registry's, another
/// profile's or a lost response id all mean the same thing — no receipt, and a
/// screen that behaves exactly as it does today.
///
/// THE ONLY THING TAKEN FROM THE ENDPOINT IS `base`. Not `stand`, not `pilot`,
/// not anything derived from them: BACKLOG №603 is a class of four inline copies
/// of "unknown -> production", and a decision here with a predicate of its own
/// would have moved that class onto a new call site. `identity_vault_key` is
/// called for the identity row because it is THE ONE PLACE that answers "which
/// row holds this registry's answer" — reusing it is the opposite of a second
/// copy of the predicate.
#[tauri::command]
pub fn jobs_response_receipts(
    state: tauri::State<crate::AppState>,
    profile_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, ResponseReceipt>, String> {
    let endpoint = jobs_response_endpoint();
    let base = endpoint.base.clone();
    // The vault's own id, derived from the signing key of the OPEN vault by the
    // same call the delivery path makes. A receipt another vault wrote cannot
    // pass this, and a closed vault produces no answer at all.
    let vault = {
        let guard = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned().ok_or("No vault open")?
    };
    let signing = crate::identity::vault_signing_key(&vault)?;
    let vault_user_id = crate::identity::user_id_for_pubkey(&signing.verifying_key().to_bytes());

    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let subject_id = vault_text(conn, &identity_vault_key(&endpoint, KEY_PUBLIC_SEAFARER_ID));

    let mut out: std::collections::HashMap<String, ResponseReceipt> =
        std::collections::HashMap::new();
    for raw in &profile_ids {
        let profile_id = raw.trim();
        if profile_id.is_empty() {
            continue;
        }
        let stored = match crate::db::get_vault_info_value(
            conn,
            &response_receipt_key(&base, profile_id),
        ) {
            Some(value) => value,
            None => continue,
        };
        let response_id = crate::db::get_vault_info_value(
            conn,
            &format!("{RESPONSE_ID_KEY_PREFIX}{profile_id}"),
        )
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
        if let Some(receipt) = accepted_response_receipt(
            &stored,
            &base,
            &vault_user_id,
            &subject_id,
            profile_id,
            &response_id,
        ) {
            out.insert(profile_id.to_string(), receipt);
        }
    }
    Ok(out)
}

/// Challenge → sign → session, all on ONE host, and the token never leaves Rust.
fn mint_self_session(
    state: &tauri::State<crate::AppState>,
    client: &reqwest::blocking::Client,
    vault_user_id: &str,
    public_seafarer_id: &str,
) -> Result<String, String> {
    let challenge_req = serde_json::json!({
        "vault_user_id": vault_user_id,
        "public_seafarer_id": public_seafarer_id,
        "client": { "app": "seafarer", "surface": "profile_response" },
    });
    let challenge_answer = send_on_response_bases(
        client,
        true,
        "/api/me/session/challenge",
        Some(&challenge_req),
        None,
    )?;
    if !(200..300).contains(&challenge_answer.status) {
        return Err(format!(
            "session challenge returned {}: {}",
            challenge_answer.status, challenge_answer.body
        ));
    }
    let challenge: serde_json::Value = serde_json::from_str(&challenge_answer.body)
        .map_err(|e| format!("bad challenge JSON: {e}"))?;
    let challenge_id = challenge
        .get("challenge_id")
        .and_then(serde_json::Value::as_str)
        .ok_or("the challenge carried no challenge_id")?
        .to_string();
    let payload_to_sign = challenge
        .get("payload_to_sign")
        .cloned()
        .ok_or("the challenge carried no payload_to_sign")?;

    // The same narrow signer the command exposes — one implementation, so the
    // checks that make it not-an-oracle cannot hold on one path and not the other.
    let signature_b64 = sign_self_session_challenge(state.clone(), payload_to_sign)?;

    let session_req = serde_json::json!({
        "challenge_id": challenge_id,
        "vault_user_id": vault_user_id,
        "public_seafarer_id": public_seafarer_id,
        "signature_b64": signature_b64,
    });
    let session_answer =
        send_on_response_bases(client, true, "/api/me/session", Some(&session_req), None)?;
    if !(200..300).contains(&session_answer.status) {
        return Err(format!(
            "self session returned {}: {}",
            session_answer.status, session_answer.body
        ));
    }
    let session: serde_json::Value = serde_json::from_str(&session_answer.body)
        .map_err(|e| format!("bad session JSON: {e}"))?;
    session
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "the session carried no access token".to_string())
}

// ════════════════════════════════════════════════════════════════════════════
// THE SEAFARER'S IDENTITY — OBTAINED WHERE HE NEEDS IT, AND ON ONE HOST (S4d)
//
// Two defects are closed here and both were found by pressing the product.
//
// №562: the only button that claims a Skipi ID lives in the LEGACY vaults tab
// of settings, which opens only through a fail-closed branch of the unified
// settings; the mobile layout draws the same card with `compact=true` and has
// no button at all. The one call site of the identity-key registration is
// `myVesselAccept()`, which refuses to run before a `public_seafarer_id`
// exists. So a seafarer standing in front of the respond button could not get
// the identity that button requires.
//
// №563: `claim_seafarer_identity` and `register_my_identity_pubkey` both go
// through `api::api_bases()`, whose only override is the RUNTIME variable
// `SKIPI_API_BASE` — and an Android process has no way to be given one. On a
// phone that list is EXACTLY [api.skipi.app, api-ru.skipi.app]. A service
// build would therefore have written a synthetic identity claim and, worse, a
// synthetic IDENTITY KEY into the live product — and that key is immutable
// (first-writer-wins, a different key is 409 forever). Everything below speaks
// only through `send_on_response_bases`, i.e. only over `response_bases()`,
// which with a stand compiled in is a list of ONE base with no production host
// in it to fall back to.
//
// NOTHING about authenticity is weakened: the signature is the real one, the
// `vault_user_id` is DERIVED FROM THE KEY (this command takes no parameters,
// so there is nothing for a WebView script to substitute), and the server's
// gate is untouched.
// ════════════════════════════════════════════════════════════════════════════

/// `vault_info` key: when THIS vault's Ed25519 identity key was accepted by the
/// server. Written ONLY after the key registration succeeded.
///
/// It exists because "has a public seafarer id" is NOT the same as "can be
/// spoken for". The self-session the response path mints starts with
/// `db.get(SeafarerIdentityKey, vault_user_id)` and refuses without that row,
/// while `POST /claim` never writes one. So the state "id, no key" is real —
/// a vault restored from a backup is in it, and so is every vault that claimed
/// an id through the legacy settings tab. Gating the entry point on the id
/// alone would make the step disappear exactly where it is still needed and
/// leave the seafarer with a respond button that answers 401.
const IDENTITY_KEY_REGISTERED_AT: &str = "skipi_identity_key_registered_at";

/// Refusals the WebView turns into a sentence of its own. The raw words of a
/// server are never shown to a seafarer, so what crosses the boundary is a
/// marker and not prose.
const IDENTITY_CLAIM_DUPLICATE: &str = "IDENTITY_CLAIM_DUPLICATE";
const IDENTITY_KEY_TAKEN: &str = "IDENTITY_KEY_TAKEN";
const IDENTITY_PROFILE_INCOMPLETE: &str = "IDENTITY_PROFILE_INCOMPLETE";

/// The other seven `vault_info` rows that hold WHAT ONE REGISTRY ANSWERED about
/// this seafarer. They are named here and nowhere else so that every use of them
/// is a use of this list: a bare literal reappearing beside `set_vault_info` is
/// then a visible change, and five of these eight writes are multi-line calls
/// that a one-line grep does not see.
const KEY_PUBLIC_SEAFARER_ID: &str = "skipi_public_seafarer_id";
const KEY_IDENTITY_CLAIM_STATUS: &str = "skipi_identity_claim_status";
const KEY_IDENTITY_DUPLICATE: &str = "skipi_identity_duplicate";
const KEY_IDENTITY_TRUST_LEVEL: &str = "skipi_identity_trust_level";
const KEY_IDENTITY_MESSAGE: &str = "skipi_identity_message";
const KEY_IDENTITY_LAST_CLAIM_AT: &str = "skipi_identity_last_claim_at";
const KEY_IDENTITY_RECOVERY_KEY: &str = "skipi_identity_recovery_key";

/// THE EIGHT ROWS THAT DESCRIBE A REGISTRY'S VIEW OF THIS SEAFARER — and not one
/// of them describes the seafarer himself.
///
/// All eight, not the two that are read to draw the step: `skipi_identity_*` are
/// written in the same block as the id, and leaving them global would mean a
/// claim against one server overwrote another server's answer. The one that makes
/// this a matter of loss rather than tidiness is
/// `skipi_identity_recovery_key`: the server keeps only its HMAC hash
/// (`identity.py:164`) and `POST /recover` wants the key itself (`:215-222`), so
/// there is no second copy of it anywhere and overwriting it cannot be undone.
///
/// WHAT IS NOT IN THIS LIST, deliberately: `identity_fingerprint`,
/// `identity_fingerprint_version` and `identity_trust_status` (`identity.rs`)
/// describe the PERSON — they are derived from the vault's own personal fields
/// and do not depend on which server is being addressed. Binding them would
/// invent a difference that does not exist, and `sync_identity_fingerprint` is
/// called from inside the claim block on every path, this one included.
const SCOPED_IDENTITY_KEYS: [&str; 8] = [
    KEY_PUBLIC_SEAFARER_ID,
    KEY_IDENTITY_CLAIM_STATUS,
    KEY_IDENTITY_DUPLICATE,
    KEY_IDENTITY_TRUST_LEVEL,
    KEY_IDENTITY_MESSAGE,
    KEY_IDENTITY_LAST_CLAIM_AT,
    KEY_IDENTITY_RECOVERY_KEY,
    IDENTITY_KEY_REGISTERED_AT,
];

/// THE ONE PLACE that answers "under which `vault_info` row does the registry
/// this build talks to keep its answer about this seafarer".
///
/// A `public_seafarer_id` is issued BY A REGISTRY and means nothing outside it.
/// One global row therefore made a vault that had been given an identity by one
/// server believe it had one on every server: the entry step was already
/// satisfied, `ensure_seafarer_identity` claimed nothing, and the response path
/// then minted a self-session against a host that had never heard of the id.
/// That is the whole of the dead end this function opens, and it opens it with
/// the step and the gate that already exist.
///
/// NOTHING A SERVER SAID REACHES THIS DECISION. The only inputs are the endpoint
/// this build was compiled for and the name of the row — no status, no body, no
/// claim answer. So a refusal, any refusal including a 403, cannot move the step
/// in either direction, which is the standing rule of DECISIONS (903) held
/// absolutely rather than approximately.
///
/// THE NAME IS CASE-FOLDED, and that is not cosmetic. `jobs_pilot_api_base`
/// validates a PARSED url — and `Url::parse` lower-cases scheme and host — while
/// returning the RAW string, so `https://API.skipi.app:8444` is a legal pilot
/// base. Two row names for one server would read empty, bring the step back and
/// make a SECOND claim in the same registry, which DECISIONS (904) forbids.
///
/// The production build gets EXACTLY today's names, so it cannot tell this
/// function is here.
fn identity_vault_key(endpoint: &JobsResponseEndpoint, name: &str) -> String {
    debug_assert!(
        SCOPED_IDENTITY_KEYS.contains(&name),
        "identity_vault_key is for the eight registry-scoped rows and no others"
    );
    if endpoint.stand || endpoint.pilot {
        // The same normalisation the URL itself is given by both resolvers
        // (`trim`, no trailing slash), plus the case-folding above, so that one
        // server is one row.
        let base = endpoint
            .base
            .trim()
            .trim_end_matches('/')
            .to_ascii_lowercase();
        return format!("{name}:{base}");
    }
    name.to_string()
}

/// Everything a claim answer leaves in the vault, in the ORDER it was left in
/// before this function existed, under the rows of the registry that answered.
///
/// It is a function rather than five lines inside the command for one reason: the
/// claim cannot be replayed in a test — it needs a server — while the property
/// that matters is not the request but WHAT IS WRITTEN. Behind one door, a test
/// opens a vault in memory, runs the whole sequence against a stand and reads all
/// eight production rows back one by one.
///
/// THE REFUSAL STAYS INSIDE, where it was. A 200 with an empty id is
/// `possible_duplicate` and is not a success: the five rows that record what the
/// server said are already written when it leaves, and the id row is not.
fn write_identity_claim_answer(
    conn: &rusqlite::Connection,
    endpoint: &JobsResponseEndpoint,
    claim: &SeafarerIdentityClaimAnswer,
    issued: &str,
) -> Result<(), String> {
    let row = |name: &str| identity_vault_key(endpoint, name);
    // What the server said is recorded either way — it is the only record of a
    // duplicate there is.
    crate::db::set_vault_info(conn, &row(KEY_IDENTITY_CLAIM_STATUS), &claim.status)
        .map_err(|e| e.to_string())?;
    crate::db::set_vault_info(
        conn,
        &row(KEY_IDENTITY_DUPLICATE),
        if claim.duplicate { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())?;
    crate::db::set_vault_info(conn, &row(KEY_IDENTITY_TRUST_LEVEL), &claim.trust_level)
        .map_err(|e| e.to_string())?;
    crate::db::set_vault_info(conn, &row(KEY_IDENTITY_MESSAGE), &claim.message)
        .map_err(|e| e.to_string())?;
    crate::db::set_vault_info(
        conn,
        &row(KEY_IDENTITY_LAST_CLAIM_AT),
        &chrono::Utc::now().to_rfc3339(),
    )
    .map_err(|e| e.to_string())?;

    // A 200 WITH AN EMPTY ID IS NOT A SUCCESS. `possible_duplicate` answers
    // exactly that: another vault already claimed this name and date of birth.
    // Writing the empty string into the id row — the way the profile-side claim
    // does — would leave the screen in a silent forever-loop: press, 200, still
    // no id, press again. There is no recovery flow in this product to send him
    // to, so the honest thing is to stop and say so.
    if issued.is_empty() {
        return Err(IDENTITY_CLAIM_DUPLICATE.to_string());
    }
    crate::db::set_vault_info(conn, &row(KEY_PUBLIC_SEAFARER_ID), issued)
        .map_err(|e| e.to_string())?;
    if let Some(key) = claim
        .identity_recovery_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        crate::db::set_vault_info(conn, &row(KEY_IDENTITY_RECOVERY_KEY), key)
            .map_err(|e| e.to_string())?;
    }
    // GLOBAL ON PURPOSE, on this path too: the fingerprint describes the person,
    // not the registry, and this call is where it always was.
    let _ = crate::identity::sync_identity_fingerprint(conn);
    Ok(())
}

/// The marker that says this vault's identity key is registered — written only
/// once the server has it, and under the row of the server that has it.
fn write_identity_key_marker(
    conn: &rusqlite::Connection,
    endpoint: &JobsResponseEndpoint,
    registered_at: &str,
) -> Result<(), String> {
    crate::db::set_vault_info(
        conn,
        &identity_vault_key(endpoint, IDENTITY_KEY_REGISTERED_AT),
        registered_at,
    )
    .map_err(|e| e.to_string())
}

fn vault_text(conn: &rusqlite::Connection, key: &str) -> String {
    crate::db::get_vault_info_value(conn, key)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn required_vault_text(conn: &rusqlite::Connection, key: &str) -> Result<String, String> {
    let value = vault_text(conn, key);
    if value.is_empty() {
        return Err(IDENTITY_PROFILE_INCOMPLETE.to_string());
    }
    Ok(value)
}

/// The claim answer, read back field by field. `public_seafarer_id` is
/// `Option` because the server answers `possible_duplicate` with a 200 and a
/// NULL id — see `ensure_seafarer_identity` for why that is a refusal.
#[derive(Debug, Clone, Deserialize)]
struct SeafarerIdentityClaimAnswer {
    #[serde(default)]
    status: String,
    #[serde(default)]
    duplicate: bool,
    #[serde(default)]
    public_seafarer_id: Option<String>,
    #[serde(default)]
    trust_level: String,
    #[serde(default)]
    identity_recovery_key: Option<String>,
    #[serde(default)]
    message: String,
}

/// What the Jobs screen needs to decide whether to draw the identity step, and
/// nothing else. Read-only, no network, no parameters.
#[derive(Debug, Clone, Serialize)]
pub struct SeafarerIdentityEntryState {
    pub public_seafarer_id: String,
    pub identity_key_registered_at: String,
}

#[tauri::command]
pub fn seafarer_identity_entry_state(
    state: tauri::State<crate::AppState>,
) -> Result<SeafarerIdentityEntryState, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    // Both halves are read for the base this build talks to. A pair where one
    // half is bound and the other is not is the state that loops: the step
    // disappears with an id the server does not know, or comes back for ever
    // beside a marker that says it is done.
    let endpoint = jobs_response_endpoint();
    Ok(SeafarerIdentityEntryState {
        public_seafarer_id: vault_text(conn, &identity_vault_key(&endpoint, KEY_PUBLIC_SEAFARER_ID)),
        identity_key_registered_at: vault_text(
            conn,
            &identity_vault_key(&endpoint, IDENTITY_KEY_REGISTERED_AT),
        ),
    })
}

/// Claim the public identity and register the vault's identity key — both of
/// them, in that order, and both only over `response_bases()`.
///
/// Idempotent before the network: a vault that already carries a
/// `skipi_public_seafarer_id` does not claim a second one; it goes straight to
/// the key, which is how a vault stuck in the "id, no key" state heals itself.
///
/// THE VAULT MUTEX IS NEVER HELD ACROSS A REQUEST, and the shape below is
/// `submit_profile_response`'s, followed literally rather than invented here.
/// Each request is bounded by the client's 20-second timeout, and
/// `send_on_response_bases` walks EVERY base on a transport error — so one lock
/// around both of them blocked every other vault command for up to 40 s against
/// a stand (one base) and up to 80 s against the two production bases, which a
/// person reads as an application that has frozen. The lock is taken in blocks
/// that touch sqlite and nothing else: read, release, speak, take it to write.
#[tauri::command]
pub fn ensure_seafarer_identity(
    state: tauri::State<crate::AppState>,
) -> Result<serde_json::Value, String> {
    use ed25519_dalek::Signer;

    let vault = {
        let guard = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned().ok_or("No vault open")?
    };

    // WHICH REGISTRY THIS PASS IS ABOUT, read ONCE and used for every row below,
    // so that the row read to decide whether to claim and the row written with
    // the answer cannot be two different rows.
    let endpoint = jobs_response_endpoint();

    // ---- everything this command READS from the vault, and then the lock goes
    let (signing, vault_user_id, mut public_seafarer_id, mut claim_status, mut trust_level, claim_request) = {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = lock.as_ref().ok_or("No vault open")?;
        crate::identity::ensure_vault_identity(conn, &vault)?;
        let signing = crate::identity::vault_signing_key(&vault)?;
        // DERIVED FROM THE KEY. Not read from `vault_info`, not accepted from the
        // caller — the same rule the self-session signer holds itself to.
        let vault_user_id =
            crate::identity::user_id_for_pubkey(&signing.verifying_key().to_bytes());
        let public_seafarer_id = vault_text(conn, &identity_vault_key(&endpoint, KEY_PUBLIC_SEAFARER_ID));
        let claim_status = vault_text(conn, &identity_vault_key(&endpoint, KEY_IDENTITY_CLAIM_STATUS));
        let trust_level = vault_text(conn, &identity_vault_key(&endpoint, KEY_IDENTITY_TRUST_LEVEL));
        // Built HERE because its five fields are vault reads, and built only
        // when a claim is actually needed — so a vault that already carries an
        // id is never asked for fields it may not have, and the refusal of an
        // incomplete profile still leaves from this block.
        let claim_request = if public_seafarer_id.is_empty() {
            // EXACTLY the five fields of `SeafarerIdentityClaimRequest`, which is
            // `extra="forbid"`: a sixth would be 422 on every claim forever.
            let claim_body = serde_json::json!({
                "vault_user_id": vault_user_id,
                "first_name": required_vault_text(conn, "personal_first_name")?,
                "last_name": required_vault_text(conn, "personal_surname")?,
                "date_of_birth": required_vault_text(conn, "personal_dob")?,
                "nationality_code": crate::db::get_vault_info_value(conn, "personal_nationality_code")
                    .map(|s| s.trim().to_ascii_uppercase())
                    .filter(|s| !s.is_empty()),
            });
            Some(claim_body)
        } else {
            None
        };
        (
            signing,
            vault_user_id,
            public_seafarer_id,
            claim_status,
            trust_level,
            claim_request,
        )
    };
    let pub_bytes = signing.verifying_key().to_bytes();

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    if let Some(claim_body) = claim_request.as_ref() {
        let answer = send_on_response_bases(
            &client,
            true,
            "/api/seafarer-identity/claim",
            Some(claim_body),
            None,
        )?;
        if !(200..300).contains(&answer.status) {
            return Err(format!(
                "identity claim returned {}: {}",
                answer.status, answer.body
            ));
        }
        let claim: SeafarerIdentityClaimAnswer = serde_json::from_str(&answer.body)
            .map_err(|e| format!("the identity claim did not parse: {e}"))?;
        let issued = claim
            .public_seafarer_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();

        // ---- the answer, written under the lock again, in the SAME ORDER
        {
            let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
            let conn = lock.as_ref().ok_or("No vault open")?;
            // Every row of the answer, in the order it always was, under the rows
            // of the registry that answered. The `possible_duplicate` refusal
            // still leaves from inside this block, which is where the lock is
            // dropped.
            write_identity_claim_answer(conn, &endpoint, &claim, &issued)?;
        }

        public_seafarer_id = issued;
        claim_status = claim.status;
        trust_level = claim.trust_level;
    }

    // ---- the identity key, and the marker ONLY once the server has it ------
    let b64 = base64::engine::general_purpose::STANDARD;
    let identity_pubkey_b64 = b64.encode(pub_bytes);
    let register_message =
        crate::identity::identity_key_register_message(&vault_user_id, &identity_pubkey_b64);
    let signature = b64.encode(signing.sign(register_message.as_bytes()).to_bytes());
    let key_body = serde_json::json!({
        "vault_user_id": vault_user_id,
        "identity_pubkey_b64": identity_pubkey_b64,
        "signature": signature,
        "public_seafarer_id": public_seafarer_id,
    });
    let key_answer = send_on_response_bases(
        &client,
        true,
        "/api/seafarer-identity/identity-key",
        Some(&key_body),
        None,
    )?;
    // 409 is the immutable binding refusing a DIFFERENT key for this vault. It
    // is not a success and it never becomes one by retrying.
    if key_answer.status == 409 {
        return Err(IDENTITY_KEY_TAKEN.to_string());
    }
    if !(200..300).contains(&key_answer.status) {
        return Err(format!(
            "identity key registration returned {}: {}",
            key_answer.status, key_answer.body
        ));
    }
    let key_status = serde_json::from_str::<serde_json::Value>(&key_answer.body)
        .ok()
        .and_then(|v| {
            v.get("status")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    // `registered` (first time) and `exists` (the same key again) are both
    // success and neither is distinguished. Anything else is not assumed to be.
    if key_status != "registered" && key_status != "exists" {
        return Err(format!(
            "identity key registration answered '{}'",
            key_status
        ));
    }

    // ---- and the marker, under the lock for the third and last time -------
    let registered_at = chrono::Utc::now().to_rfc3339();
    {
        let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = lock.as_ref().ok_or("No vault open")?;
        write_identity_key_marker(conn, &endpoint, &registered_at)?;
    }

    Ok(serde_json::json!({
        "public_seafarer_id": public_seafarer_id,
        "identity_key_registered_at": registered_at,
        "identity_key_status": key_status,
        "claim_status": claim_status,
        "trust_level": trust_level,
    }))
}

// ---------------------------------------------------------------------------
// THE ANSWER OF A LIVE SERVER, not a fixture written by the same hand that
// wrote the parser.
//
// The client half of the neighbouring response contract was finished against
// an invented fixture and the two halves never met until it was too late to be
// cheap. This module exists so that cannot be said of this one: the bytes below
// were captured from a running server and are parsed HERE, by the type the
// product actually uses, in the crate that ships.
//
// PROVENANCE: GET /api/published-profiles?rank=Second Officer&vessel_type=Bulk
// Carrier, ANONYMOUS (the way a seafarer reaches it), status 200, captured
// 2026-09-29T17:02:32Z. Server side: skipi-server PR #32, head 6690fc86.
//
// BOUNDARY, so this is not read as more than it is: the envelope stored the
// body as parsed JSON, so these are the answer's VALUES re-serialised, not its
// wire bytes. Key order and whitespace are therefore not byte-identical to what
// crossed the network; key NAMES, types and values are.
#[cfg(test)]
mod live_published_profiles_contract {
    use super::*;

    const LIVE_BODY: &str = r#"{"items":[{"profile_id":"3f51ec8e-34f9-4375-8120-9d2c56b9c77f","crewing_id":"322dc865-60a1-4ded-a816-20bb3ac9c4d8","crewing_name":"Limassol Marine Manning","crewing_jurisdiction":"CY","crewing_trust_status":"trial","published_version":1,"rank":"Second Officer","vessel_type":"Bulk Carrier","mandatory_certs":[],"extra_requirements":[]},{"profile_id":"81d508ff-23fb-4c85-a14b-8f6151df1e1a","crewing_id":"dcdc1fa4-5187-4801-a365-ade399601ae7","crewing_name":"Aegean Crew Services","crewing_jurisdiction":"GR","crewing_trust_status":"active","published_version":1,"rank":"Second Officer","vessel_type":"Bulk Carrier","mandatory_certs":["stcw_basic","gmdss"],"extra_requirements":[{"id":"x1","label":"Tanker endorsement","weight":5,"category":"endorsement","description":null}]}]}"#;

    /// The same answer as the server RUNNING THE PILOT sends it today: the
    /// three agency keys simply absent.
    const LIVE_BODY_WITHOUT_AGENCY_FIELDS: &str = r#"{"items":[{"profile_id":"3f51ec8e-34f9-4375-8120-9d2c56b9c77f","crewing_id":"322dc865-60a1-4ded-a816-20bb3ac9c4d8","published_version":1,"rank":"Second Officer","vessel_type":"Bulk Carrier","mandatory_certs":[],"extra_requirements":[]},{"profile_id":"81d508ff-23fb-4c85-a14b-8f6151df1e1a","crewing_id":"dcdc1fa4-5187-4801-a365-ade399601ae7","published_version":1,"rank":"Second Officer","vessel_type":"Bulk Carrier","mandatory_certs":["stcw_basic","gmdss"],"extra_requirements":[{"id":"x1","label":"Tanker endorsement","weight":5,"category":"endorsement","description":null}]}]}"#;

    fn parse(s: &str) -> PublishedProfileListResp {
        serde_json::from_str(s).expect("the live answer must parse")
    }

    #[test]
    fn calibration_a_wrong_type_is_still_a_parse_error() {
        // Without this, "it parsed" would be a claim about nothing: a parser
        // that accepted everything would pass every other test in this module.
        let broken = LIVE_BODY.replace(r#""published_version":1"#, r#""published_version":"one""#);
        assert_ne!(broken, LIVE_BODY, "the calibration must actually change the bytes");
        assert!(
            serde_json::from_str::<PublishedProfileListResp>(&broken).is_err(),
            "a string where an integer belongs must fail to parse"
        );
    }

    #[test]
    fn the_live_answer_parses_with_the_type_the_client_uses() {
        let parsed = parse(LIVE_BODY);
        assert_eq!(parsed.items.len(), 2, "the live answer carried two rows");
    }

    #[test]
    fn every_agency_field_arrives_under_the_name_this_client_reads() {
        let parsed = parse(LIVE_BODY);
        let mut seen: Vec<(String, String, String)> = parsed
            .items
            .iter()
            .map(|p| {
                (
                    p.crewing_name.clone().expect("crewing_name present"),
                    p.crewing_jurisdiction.clone().expect("crewing_jurisdiction present"),
                    p.crewing_trust_status.clone().expect("crewing_trust_status present"),
                )
            })
            .collect();
        seen.sort();
        assert_eq!(
            seen,
            vec![
                ("Aegean Crew Services".to_string(), "GR".to_string(), "active".to_string()),
                ("Limassol Marine Manning".to_string(), "CY".to_string(), "trial".to_string()),
            ],
            "the server's key names and values must be the ones this type declares"
        );
    }

    #[test]
    fn both_trust_states_the_screen_distinguishes_are_present() {
        // Not decoration: the green case and the warned case are two different
        // renders, and a capture carrying only one of them would have left the
        // other proven by fixture alone.
        let parsed = parse(LIVE_BODY);
        let mut states: Vec<String> = parsed
            .items
            .iter()
            .filter_map(|p| p.crewing_trust_status.clone())
            .collect();
        states.sort();
        assert_eq!(states, vec!["active".to_string(), "trial".to_string()]);
    }

    #[test]
    fn a_live_row_carries_a_uuid_the_screen_must_never_print() {
        // The fixture this was built on used readable ids. The live surface does
        // not: `crewing_id` is a UUID, and it is exactly what the owner refused
        // to see in place of a name.
        let parsed = parse(LIVE_BODY);
        for p in &parsed.items {
            let id = p.crewing_id.clone().expect("crewing_id present");
            assert_eq!(id.len(), 36, "crewing_id is a UUID on the live surface: {id}");
        }
    }

    #[test]
    fn todays_server_answer_without_the_three_fields_still_parses_whole() {
        // The failure this guards is not "one field is None". It is the WHOLE
        // list failing to parse because one key is absent — which is what
        // `CandidateProfileRankSummary` does, and what would empty the Jobs tab
        // with no explanation on the server running the pilot right now.
        let parsed = parse(LIVE_BODY_WITHOUT_AGENCY_FIELDS);
        assert_eq!(parsed.items.len(), 2, "every row must survive the absence");
        for p in &parsed.items {
            assert!(p.crewing_name.is_none());
            assert!(p.crewing_jurisdiction.is_none());
            assert!(p.crewing_trust_status.is_none());
            // And the row is still renderable: the criteria are untouched.
            assert!(p.rank.is_some() && p.vessel_type.is_some());
        }
    }

    // ---------------------------------------------------------------------------
    // THE IDENTITY BELONGS TO THE REGISTRY THAT ISSUED IT — the half the JS harness
    // cannot reach: what the EIGHT rows of a real vault hold after a claim answer
    // has been recorded against a non-production base.
    //
    // WHY AN IN-MEMORY VAULT AND NOT THE COMMAND ITSELF. `ensure_seafarer_identity`
    // needs a server and a `tauri::State`, and a unit test has neither. What matters
    // here is not the request but WHAT IS WRITTEN, so the writes live behind
    // `write_identity_claim_answer` / `write_identity_key_marker` and these tests run
    // those against `Connection::open_in_memory()` with the same `vault_info` table
    // the product creates (`db.rs`, migration 1). The boundary is therefore: this
    // module proves the ROWS, not the network sequence around them.
    //
    // THE FIVE TESTS ARE THE FIVE THE CARD NAMES, in its order, and the mutation
    // matrix (M1, M3, M4, M10, M11, M15) is what proves they are not vacuous.
    mod registry_scoped_identity {
        // `super` is the module this one is nested in; `super::super` is `jobs`
        // itself. It is NESTED because this home allows one test-module
        // attribute per file: a source contract cuts a file at that attribute,
        // and a second one would hide production code behind the cut.
        use super::super::*;

        /// This file, read as text. Two of the five claims are about SHAPE and not
        /// about values — which arguments the deciding function can even see, and
        /// that the self-session signer was not touched by this card — and a claim
        /// about shape is made over the source or not at all.
        const THIS_FILE: &str = include_str!("jobs.rs");

        fn vault() -> rusqlite::Connection {
            let conn = rusqlite::Connection::open_in_memory().expect("an in-memory vault");
            conn.execute_batch("CREATE TABLE vault_info (key TEXT PRIMARY KEY, value TEXT);")
                .expect("the same two columns db.rs migration 1 creates");
            conn
        }

        fn ep(base: &str, stand: bool, pilot: bool) -> JobsResponseEndpoint {
            JobsResponseEndpoint {
                base: base.to_string(),
                stand,
                pilot,
            }
        }

        fn answer(id: &str, recovery: &str) -> SeafarerIdentityClaimAnswer {
            SeafarerIdentityClaimAnswer {
                status: "created".to_string(),
                duplicate: false,
                public_seafarer_id: Some(id.to_string()),
                trust_level: "identity_claimed".to_string(),
                identity_recovery_key: Some(recovery.to_string()),
                message: "identity created".to_string(),
            }
        }

        fn without_line_comments(src: &str) -> String {
            src.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }

        /// The brace-matched body of one function of this file.
        pub(super) fn body_of(name: &str) -> String {
            let needle = format!("fn {name}(");
            let at = THIS_FILE
                .find(&needle)
                .unwrap_or_else(|| panic!("fn {name} is not in this file"));
            let open = at + THIS_FILE[at..].find('{').expect("a function body");
            let bytes = THIS_FILE.as_bytes();
            let mut depth = 0usize;
            for i in open..bytes.len() {
                match bytes[i] {
                    b'{' => depth += 1,
                    b'}' => {
                        depth -= 1;
                        if depth == 0 {
                            return without_line_comments(&THIS_FILE[open + 1..i]);
                        }
                    }
                    _ => {}
                }
            }
            panic!("unbalanced body for {name}")
        }

        pub(super) fn signature_of(name: &str) -> String {
            let needle = format!("fn {name}(");
            let at = THIS_FILE
                .find(&needle)
                .unwrap_or_else(|| panic!("fn {name} is not in this file"));
            let start = at + needle.len();
            let end = start + THIS_FILE[start..].find(')').expect("a closing paren");
            THIS_FILE[start..end].split_whitespace().collect::<Vec<_>>().join(" ")
        }

        // ---- TEST 1 (card 1): which row name, character by character ------------
        #[test]
        fn test_1_the_row_name_is_scoped_off_production_and_bare_on_it() {
            let stand = ep("http://127.0.0.1:8099", true, false);
            let pilot = ep("https://api.skipi.app:8444", false, true);
            let prod = ep("https://api.skipi.app", false, false);

            // Production: EXACTLY today's two names, spelled out here rather than
            // taken from the constants the same change introduced.
            assert_eq!(
                identity_vault_key(&prod, KEY_PUBLIC_SEAFARER_ID),
                "skipi_public_seafarer_id"
            );
            assert_eq!(
                identity_vault_key(&prod, IDENTITY_KEY_REGISTERED_AT),
                "skipi_identity_key_registered_at"
            );
            // And all eight of them, so "the production path is unchanged" is a
            // statement about the whole set and not about its first member.
            for name in SCOPED_IDENTITY_KEYS {
                assert_eq!(
                    identity_vault_key(&prod, name),
                    name,
                    "production must keep the bare name of {name}"
                );
            }

            // A stand and the pilot each get a name of their own.
            assert_eq!(
                identity_vault_key(&pilot, KEY_PUBLIC_SEAFARER_ID),
                "skipi_public_seafarer_id:https://api.skipi.app:8444"
            );
            assert_eq!(
                identity_vault_key(&stand, KEY_PUBLIC_SEAFARER_ID),
                "skipi_public_seafarer_id:http://127.0.0.1:8099"
            );
            for name in SCOPED_IDENTITY_KEYS {
                assert_eq!(
                    identity_vault_key(&pilot, name),
                    format!("{name}:https://api.skipi.app:8444")
                );
                assert_ne!(
                    identity_vault_key(&pilot, name),
                    identity_vault_key(&stand, name),
                    "two servers are never one row for {name}"
                );
            }

            // ONE SERVER IS ONE NAME (mutations M11 and M15). A trailing slash,
            // surrounding space and an upper-case host all land on the same row:
            // `jobs_pilot_api_base` validates a PARSED url and returns the RAW
            // string, so `https://API.skipi.app:8444` is a legal pilot base — and a
            // second row name for one server would empty the row, bring the step
            // back and make a SECOND claim in the same registry, DECISIONS (904).
            for other in [
                ep("https://api.skipi.app:8444/", false, true),
                ep("  https://api.skipi.app:8444  ", false, true),
                ep("https://API.skipi.app:8444", false, true),
                ep("HTTPS://API.SKIPI.APP:8444/", false, true),
            ] {
                assert_eq!(
                    identity_vault_key(&other, KEY_PUBLIC_SEAFARER_ID),
                    identity_vault_key(&pilot, KEY_PUBLIC_SEAFARER_ID),
                    "'{}' must be the same row as '{}'",
                    other.base,
                    pilot.base
                );
            }
            // CALIBRATION: a genuinely different base IS a different row. Without
            // this the four assertions above would pass on a function that returned
            // one constant.
            let neighbour = ep("https://api.skipi.app:8445", false, true);
            assert_ne!(
                identity_vault_key(&neighbour, KEY_PUBLIC_SEAFARER_ID),
                identity_vault_key(&pilot, KEY_PUBLIC_SEAFARER_ID)
            );
        }

        // ---- TEST 2 (card 2): ALL EIGHT production rows survive a full pass -----
        #[test]
        fn test_2_a_full_pass_on_a_stand_leaves_all_eight_production_rows_untouched() {
            let conn = vault();
            let stand = ep("http://127.0.0.1:8099", true, false);

            // The personality this vault ALREADY has, written where the production
            // build keeps it. `skipi_identity_recovery_key` is in here on purpose:
            // the server keeps only its HMAC hash (`identity.py:164`) and `/recover`
            // wants the key itself (`:215-222`), so overwriting this row is an
            // irreversible loss with no second copy anywhere.
            let mut before: Vec<(&str, String)> = Vec::new();
            for name in SCOPED_IDENTITY_KEYS {
                let value = format!("production-value-of-{name}");
                crate::db::set_vault_info(&conn, name, &value).expect("seed");
                before.push((name, value));
            }

            write_identity_claim_answer(
                &conn,
                &stand,
                &answer("SKP-SF-STAND-0001", "recovery-key-of-the-stand"),
                "SKP-SF-STAND-0001",
            )
            .expect("the claim answer is recorded");
            write_identity_key_marker(&conn, &stand, "2026-09-30T00:00:00Z")
                .expect("the marker is recorded");

            // ONE BY ONE, NAMED, all eight. The test that was green while the
            // recovery key was being destroyed looked at `skipi_public_seafarer_id`
            // alone; that is why every row is asserted separately here.
            for (name, value) in &before {
                assert_eq!(
                    crate::db::get_vault_info_value(&conn, name).as_deref(),
                    Some(value.as_str()),
                    "the production row {name} must not move on a non-production pass"
                );
            }

            // And the stand's own rows exist, under names of their own.
            for name in SCOPED_IDENTITY_KEYS {
                let scoped = identity_vault_key(&stand, name);
                assert_ne!(scoped, name, "{name} must be scoped on a stand");
                assert!(
                    crate::db::get_vault_info_value(&conn, &scoped).is_some(),
                    "the stand's own row {scoped} must have been written"
                );
            }
            assert_eq!(
                crate::db::get_vault_info_value(
                    &conn,
                    &identity_vault_key(&stand, KEY_PUBLIC_SEAFARER_ID)
                )
                .as_deref(),
                Some("SKP-SF-STAND-0001")
            );
            assert_eq!(
                crate::db::get_vault_info_value(
                    &conn,
                    &identity_vault_key(&stand, KEY_IDENTITY_RECOVERY_KEY)
                )
                .as_deref(),
                Some("recovery-key-of-the-stand")
            );

            // CRITERION 3 OF DECISIONS (904), the behavioural half of harness X11: a
            // SECOND pass over the same base finds the row filled, so it builds no
            // claim request at all.
            assert!(
                !vault_text(&conn, &identity_vault_key(&stand, KEY_PUBLIC_SEAFARER_ID)).is_empty(),
                "a second pass must find this registry's id and claim nothing"
            );

            // CALIBRATION, and the norm stated honestly: the fingerprint rows ARE
            // written globally on this path, because they describe the PERSON.
            // `sync_identity_fingerprint` is called from inside the claim block
            // exactly as it was before. The norm is "none of the EIGHT", not
            // "nothing global" — the second would be a lie and a red without cause.
            assert_eq!(
                crate::db::get_vault_info_value(&conn, "identity_fingerprint_version").as_deref(),
                Some("1"),
                "the whole recorded sequence must really have run"
            );
        }

        // ---- TEST 3 (card 3): base A survives a claim against base B -----------
        #[test]
        fn test_3_the_rows_of_one_base_survive_a_claim_against_another() {
            let conn = vault();
            let a = ep("https://api.skipi.app:8444", false, true);
            let b = ep("https://api.skipi.app:8445", false, true);

            write_identity_claim_answer(&conn, &a, &answer("SKP-SF-A-0001", "recovery-a"), "SKP-SF-A-0001")
                .expect("base A");
            write_identity_key_marker(&conn, &a, "2026-09-29T00:00:00Z").expect("base A marker");
            let a_rows: Vec<(String, String)> = SCOPED_IDENTITY_KEYS
                .iter()
                .map(|name| {
                    let key = identity_vault_key(&a, name);
                    let value = crate::db::get_vault_info_value(&conn, &key)
                        .unwrap_or_else(|| panic!("base A wrote {key}"));
                    (key, value)
                })
                .collect();

            write_identity_claim_answer(&conn, &b, &answer("SKP-SF-B-0001", "recovery-b"), "SKP-SF-B-0001")
                .expect("base B");
            write_identity_key_marker(&conn, &b, "2026-09-30T00:00:00Z").expect("base B marker");

            for (key, value) in &a_rows {
                assert_eq!(
                    crate::db::get_vault_info_value(&conn, key).as_deref(),
                    Some(value.as_str()),
                    "connecting base B must not touch {key}"
                );
            }
            assert_eq!(
                crate::db::get_vault_info_value(&conn, &identity_vault_key(&b, KEY_PUBLIC_SEAFARER_ID))
                    .as_deref(),
                Some("SKP-SF-B-0001")
            );
            assert_eq!(
                crate::db::get_vault_info_value(&conn, &identity_vault_key(&a, KEY_PUBLIC_SEAFARER_ID))
                    .as_deref(),
                Some("SKP-SF-A-0001"),
                "and base A keeps the id its own registry issued"
            );
            // CALIBRATION: the two writes really did go to different rows.
            assert_ne!(
                identity_vault_key(&a, KEY_PUBLIC_SEAFARER_ID),
                identity_vault_key(&b, KEY_PUBLIC_SEAFARER_ID)
            );
        }

        // ---- TEST 4 (card 4): the decision cannot see a server's reply ---------
        #[test]
        fn test_4_the_row_name_decision_is_blind_to_every_server_answer() {
            // A claim about SHAPE: the function that decides which row to read takes
            // the endpoint this build was compiled for and a row name, and there is
            // no third door. A 403 — any refusal — therefore cannot move the step in
            // either direction, which is the standing rule of DECISIONS (903).
            assert_eq!(
                signature_of("identity_vault_key"),
                "endpoint: &JobsResponseEndpoint, name: &str",
                "the deciding function takes the endpoint and the row name, nothing else"
            );
            let body = body_of("identity_vault_key");
            // CALIBRATION: the body was really found, so the absences below are
            // absences in code and not in an empty string.
            assert!(
                body.contains("endpoint.stand") && body.contains("endpoint.pilot"),
                "the body must be the one that branches on the pair of flags"
            );
            for word in [
                "status",
                "body",
                "answer",
                "claim",
                "serde_json",
                "send_on_response_bases",
                "reqwest",
                "HttpAnswer",
            ] {
                assert!(
                    !body.contains(word),
                    "nothing derived from a server's reply may reach this decision, found '{word}'"
                );
            }
        }

        // ---- TEST 5 (card 5): the self-session signer was not touched ----------
        #[test]
        fn test_5_the_self_session_signer_still_binds_only_this_vault() {
            // BOUNDARY, stated rather than implied: this is a SOURCE regression, not
            // a live signature run. Running one needs an open vault and a
            // `tauri::State`, and the card forbids touching the signer at all — so
            // the honest assertion is that its refusals are still written there and
            // that nothing of the registry binding was added to it.
            let body = body_of("sign_self_session_challenge");
            assert!(
                body.contains("challenge belongs to a different vault identity"),
                "the refusal of a payload that names another vault must still be here"
            );
            assert!(
                body.contains("field(\"vault_user_id\") != own_user_id"),
                "and it must still be decided by comparing with the id derived from the key"
            );
            assert!(
                body.contains("not a self-session challenge payload"),
                "as must the refusal of anything that is not a self-session payload"
            );
            assert!(
                body.contains("user_id_for_pubkey"),
                "the id it compares against is still derived from the vault's own key"
            );
            for absent in [
                "identity_vault_key",
                "skipi_public_seafarer_id",
                "jobs_response_endpoint",
                "SCOPED_IDENTITY_KEYS",
            ] {
                assert!(
                    !body.contains(absent),
                    "this card put nothing of the registry binding into the signer, found '{absent}'"
                );
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // THE DELIVERY RECEIPT — the half of №605 that a JS harness cannot reach.
    //
    // WHY THESE ARE HERE AND NOT IN THE HARNESS. The harness reads jobs.rs as
    // TEXT (`rustFnBody`), so every claim it makes about this mechanism is a
    // claim about the ORDER OF LINES. Three of the properties this card rests
    // on are not properties of an order — what the key is character for
    // character, what the five conditions actually accept and refuse, and
    // which host a receipt names when the walk had to try a second one. Those
    // are executed here, against the real functions.
    //
    // THE BOUNDARY: this module proves the PURE HALF — key, value, decision.
    // It opens no vault of the product, makes no request and does not prove the
    // Tauri command's plumbing; that is the harness's and the device's part.
    mod response_receipt {
        use super::super::*;

        const BASE: &str = "https://api.skipi.app:8444";
        const PROFILE: &str = "81d508ff-23fb-4c85-a14b-8f6151df1e1a";
        const RESPONSE: &str = "11111111-2222-4333-8444-000000000001";
        const VAULT_USER: &str = "vault-user-aaaa";
        const SUBJECT: &str = "SKP-SF-YXHF-K5GX";

        /// The acknowledgement the PILOT SERVER really sends, key for key
        /// (`app/routers/profile_responses.py:203-212` on `ed6627e3`).
        const ACK_BODY: &str = r#"{"delivered":true,"response_id":"11111111-2222-4333-8444-000000000001","profile_id":"81d508ff-23fb-4c85-a14b-8f6151df1e1a","crewing_id":"dcdc1fa4-5187-4801-a365-ade399601ae7","published_version":2,"intake_id":"intake-0001","content_sha256":"9f2c","created_at":"2026-09-29T17:02:32.512Z"}"#;

        fn ack() -> serde_json::Value {
            serde_json::from_str(ACK_BODY).expect("the live acknowledgement must parse")
        }

        fn answer_from(base: &str) -> HttpAnswer {
            HttpAnswer {
                status: 201,
                body: ACK_BODY.to_string(),
                base: base.to_string(),
            }
        }

        fn stored(receipt: &ResponseReceipt) -> String {
            serde_json::to_string(receipt).expect("a receipt must serialise")
        }

        fn accept(json: &str) -> Option<ResponseReceipt> {
            accepted_response_receipt(json, BASE, VAULT_USER, SUBJECT, PROFILE, RESPONSE)
        }

        // ---- the row name -------------------------------------------------
        #[test]
        fn the_row_name_carries_the_base_on_every_build_including_production() {
            // The one deliberate difference from `identity_vault_key`, which
            // keeps a bare name on production because it has rows that predate
            // the scoping. This row has no legacy, so there is no exception and
            // "the same server" is a property OF THE NAME.
            assert_eq!(
                response_receipt_key("https://api.skipi.app", PROFILE),
                format!("profile_response_receipt:https://api.skipi.app:{PROFILE}")
            );
            assert_eq!(
                response_receipt_key(BASE, PROFILE),
                format!("profile_response_receipt:https://api.skipi.app:8444:{PROFILE}")
            );
            // Two servers are two rows, and that is the whole point.
            assert_ne!(
                response_receipt_key("https://api.skipi.app", PROFILE),
                response_receipt_key(BASE, PROFILE)
            );
        }

        #[test]
        fn the_base_is_normalised_the_same_three_ways_the_identity_rows_are() {
            // `jobs_pilot_api_base` validates a PARSED url — `Url::parse`
            // lower-cases scheme and host — while returning the RAW string, so
            // `https://API.skipi.app:8444` is a legal base. Two names for one
            // server would hide a receipt from the vault that wrote it.
            let canonical = response_receipt_key(BASE, PROFILE);
            for spelling in [
                "  https://api.skipi.app:8444  ",
                "https://api.skipi.app:8444/",
                "https://API.skipi.app:8444",
                "https://Api.Skipi.App:8444/",
            ] {
                assert_eq!(
                    response_receipt_key(spelling, PROFILE),
                    canonical,
                    "'{spelling}' must name the same row"
                );
            }
            // And the profile id is trimmed too, so a padded argument cannot
            // orphan a row.
            assert_eq!(response_receipt_key(BASE, "  81d508ff-23fb-4c85-a14b-8f6151df1e1a\n"), canonical);
        }

        // ---- the value ----------------------------------------------------
        #[test]
        fn the_receipt_carries_what_the_server_said_and_nothing_invented() {
            let r = receipt_from_acknowledgement(
                &answer_from(BASE), &ack(), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            assert_eq!(r.source, "acknowledgement");
            assert_eq!(r.response_id, RESPONSE);
            assert_eq!(r.profile_id, PROFILE);
            assert_eq!(r.base, BASE);
            assert_eq!(r.vault_user_id, VAULT_USER);
            assert_eq!(r.subject_id, SUBJECT);
            assert_eq!(r.intake_id.as_deref(), Some("intake-0001"));
            assert_eq!(r.published_version, Some(2));
            assert_eq!(r.crewing_id.as_deref(), Some("dcdc1fa4-5187-4801-a365-ade399601ae7"));
            assert_eq!(r.content_sha256.as_deref(), Some("9f2c"));
            // THE ONLY TIME IN THE RECEIPT IS THE SERVER'S. A device clock here
            // would let a phone with the wrong date read as a delivery date on
            // the screen the owner accepts from.
            assert_eq!(r.server_created_at.as_deref(), Some("2026-09-29T17:02:32.512Z"));
        }

        #[test]
        fn an_absent_field_stays_absent_and_is_never_substituted() {
            let thin: serde_json::Value =
                serde_json::from_str(r#"{"delivered":true,"intake_id":"intake-0002"}"#).unwrap();
            let r = receipt_from_acknowledgement(
                &answer_from(BASE), &thin, PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            assert_eq!(r.intake_id.as_deref(), Some("intake-0002"));
            assert!(r.published_version.is_none(), "no version is not version zero");
            assert!(r.crewing_id.is_none());
            assert!(r.content_sha256.is_none());
            assert!(r.server_created_at.is_none(), "no server time is not 'now'");
            // A whitespace-only string is an absence too, not a value.
            let blank: serde_json::Value =
                serde_json::from_str(r#"{"intake_id":"   ","created_at":""}"#).unwrap();
            let rb = receipt_from_acknowledgement(
                &answer_from(BASE), &blank, PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            assert!(rb.intake_id.is_none() && rb.server_created_at.is_none());
        }

        #[test]
        fn the_409_receipt_claims_only_what_a_409_can_say() {
            let r = receipt_already_on_record(
                &answer_from(BASE), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            assert_eq!(r.source, "already_on_record");
            assert_eq!(r.base, BASE);
            // A conflict body carries no intake id, no version and no
            // timestamp. Every one of them is absent rather than guessed.
            assert!(r.intake_id.is_none());
            assert!(r.published_version.is_none());
            assert!(r.crewing_id.is_none());
            assert!(r.content_sha256.is_none());
            assert!(r.server_created_at.is_none());
        }

        // ---- D16: WHICH HOST ANSWERED, and why no screen test can see it ---
        #[test]
        fn d16_the_receipt_names_the_host_that_answered_not_the_first_one_tried() {
            // Production is TWO bases and `send_on_response_bases` walks them
            // on a transport error. A receipt naming the first would say
            // "delivered" about a host that has no such row — and on a stand
            // and on the pilot the list is ONE base, so the equality holds
            // identically there and no test on those surfaces could ever tell
            // the difference. This is that test.
            // THE TWO VALUES ARE CHOSEN SO THAT THIS TEST IS THE ONE THAT
            // CATCHES THE MUTATION. `tried_first` is deliberately the base
            // `jobs_response_endpoint()` returns in a unit build — no
            // `option_env!` is set, so it answers the production host. A
            // builder that reached for the endpoint instead of the answer
            // would therefore produce exactly `tried_first`, and this
            // assertion is what sees it. Measured: with the mutation applied
            // the first version of this test stayed GREEN because both values
            // were production spellings, and three sibling tests caught it
            // instead.
            let tried_first = "https://api.skipi.app";
            let second = "https://api.skipi.app:8444";
            let answered = answer_from(second);
            let r = receipt_from_acknowledgement(
                &answered, &ack(), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            assert_eq!(
                r.base, second,
                "the receipt must name the base that answered, not the base that was tried first"
            );
            let json = stored(&r);
            assert!(
                accepted_response_receipt(&json, tried_first, VAULT_USER, SUBJECT, PROFILE, RESPONSE)
                    .is_none(),
                "and a reader pointed at the base that was TRIED must refuse it"
            );
            assert!(
                accepted_response_receipt(&json, second, VAULT_USER, SUBJECT, PROFILE, RESPONSE)
                    .is_some(),
                "while the same receipt is accepted for the base that answered"
            );
        }

        // ---- the five conditions ------------------------------------------
        #[test]
        fn calibration_the_receipt_this_vault_wrote_is_accepted() {
            // Without this, the twelve refusals below would be green over a
            // decision that accepts nothing at all.
            let r = receipt_from_acknowledgement(
                &answer_from(BASE), &ack(), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            let accepted = accept(&stored(&r)).expect("this vault's own receipt must be accepted");
            assert_eq!(accepted, r, "and it comes back unchanged");
            // Accepted through every legal spelling of the same base, too.
            let padded = ResponseReceipt { base: "  https://API.skipi.app:8444/  ".to_string(), ..r.clone() };
            assert!(accept(&stored(&padded)).is_some(), "one server is one server");
        }

        #[test]
        fn d4_to_d8_each_of_the_five_conditions_refuses_on_its_own() {
            let good = receipt_from_acknowledgement(
                &answer_from(BASE), &ack(), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            // D4 — another server's receipt.
            let other_base = ResponseReceipt { base: "https://api.skipi.app".to_string(), ..good.clone() };
            assert!(accept(&stored(&other_base)).is_none(), "D4 another registry's receipt is not this one's");
            // D5 — another vault's receipt (a restored copy, a shared phone).
            let other_vault = ResponseReceipt { vault_user_id: "vault-user-bbbb".to_string(), ..good.clone() };
            assert!(accept(&stored(&other_vault)).is_none(), "D5 another vault's receipt is not this vault's");
            // D6 — another identity on the same server.
            let other_subject = ResponseReceipt { subject_id: "SKP-SF-OTHER-0001".to_string(), ..good.clone() };
            assert!(accept(&stored(&other_subject)).is_none(), "D6 another seafarer's receipt is not his");
            // D8 — another profile's receipt on this card.
            let other_profile = ResponseReceipt { profile_id: "3f51ec8e-34f9-4375-8120-9d2c56b9c77f".to_string(), ..good.clone() };
            assert!(accept(&stored(&other_profile)).is_none(), "D8 another profile's receipt is not this card's");
            // D7 — the response this vault would send is not the one recorded.
            let other_response = ResponseReceipt { response_id: "99999999-2222-4333-8444-000000000009".to_string(), ..good.clone() };
            assert!(accept(&stored(&other_response)).is_none(), "D7 a receipt without THIS response id is refused");
        }

        #[test]
        fn an_empty_expectation_is_a_refusal_and_not_a_wildcard() {
            // TWO ABSENCES MUST NOT READ AS AGREEMENT. A vault with no public
            // seafarer id for this base, or one whose response id row is gone,
            // would otherwise match a receipt whose field is equally empty.
            let blanked = ResponseReceipt {
                source: "acknowledgement".to_string(),
                response_id: String::new(),
                profile_id: PROFILE.to_string(),
                base: BASE.to_string(),
                vault_user_id: String::new(),
                subject_id: String::new(),
                intake_id: None,
                published_version: None,
                crewing_id: None,
                content_sha256: None,
                server_created_at: None,
            };
            let json = stored(&blanked);
            assert!(
                accepted_response_receipt(&json, BASE, "", "", PROFILE, "").is_none(),
                "empty against empty is not a match"
            );
            assert!(
                accepted_response_receipt(&json, BASE, "   ", "   ", PROFILE, "   ").is_none(),
                "and whitespace against whitespace is not either"
            );
            // Nor may an empty BASE match anything.
            let good = receipt_from_acknowledgement(
                &answer_from(BASE), &ack(), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            assert!(
                accepted_response_receipt(&stored(&good), "  ", VAULT_USER, SUBJECT, PROFILE, RESPONSE)
                    .is_none(),
                "a build that cannot name its base holds no receipt"
            );
        }

        #[test]
        fn a_row_that_is_not_a_receipt_this_build_wrote_is_refused() {
            for junk in [
                "",
                "   ",
                "not json at all",
                "{}",
                "[]",
                r#""acknowledgement""#,
                // A source this build never writes.
                r#"{"source":"assumed","response_id":"11111111-2222-4333-8444-000000000001","profile_id":"81d508ff-23fb-4c85-a14b-8f6151df1e1a","base":"https://api.skipi.app:8444","vault_user_id":"vault-user-aaaa","subject_id":"SKP-SF-YXHF-K5GX"}"#,
                // A source that LOOKS right.
                r#"{"source":"acknowledged","response_id":"11111111-2222-4333-8444-000000000001","profile_id":"81d508ff-23fb-4c85-a14b-8f6151df1e1a","base":"https://api.skipi.app:8444","vault_user_id":"vault-user-aaaa","subject_id":"SKP-SF-YXHF-K5GX"}"#,
                // A partial row: the shape without the fields that bind it.
                r#"{"source":"acknowledgement"}"#,
            ] {
                assert!(
                    accept(junk).is_none(),
                    "'{junk}' must not read as a delivery"
                );
            }
        }

        // ---- the row and the reader agree, through real sqlite -------------
        #[test]
        fn the_row_written_is_the_row_read_back() {
            // The key and the value are produced by two different functions,
            // and a disagreement between them would be a receipt that exists
            // and can never be found. Same `vault_info` table the product
            // creates (db.rs, migration 1).
            let conn = rusqlite::Connection::open_in_memory().expect("an in-memory vault");
            conn.execute_batch("CREATE TABLE vault_info (key TEXT PRIMARY KEY, value TEXT);")
                .expect("the same two columns db.rs migration 1 creates");
            let r = receipt_from_acknowledgement(
                &answer_from(BASE), &ack(), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            crate::db::set_vault_info(&conn, &response_receipt_key(&r.base, &r.profile_id), &stored(&r))
                .expect("the write must succeed");
            // Read back the way the command reads it: key built from the
            // ENDPOINT's base spelled differently, which must still find it.
            let found = crate::db::get_vault_info_value(
                &conn,
                &response_receipt_key("https://API.skipi.app:8444/", PROFILE),
            )
            .expect("the row must be findable through any legal spelling of the base");
            assert_eq!(accept(&found), Some(r));
            // And a DIFFERENT server's key finds nothing at all.
            assert!(crate::db::get_vault_info_value(
                &conn,
                &response_receipt_key("https://api.skipi.app", PROFILE),
            )
            .is_none());
        }

        // ---- D14: the sentence the whole of write site 2 hangs on -----------
        #[test]
        fn d14_the_servers_exact_words_are_pinned_and_only_they_classify() {
            // READ_FROM_AUTHORITY: `candidate_intake_service.py:105` at
            // `ed6627e3`. BOUNDARY, said out loud: this pins the CLIENT's copy.
            // It cannot see the server change its wording — if that happens
            // write site 2 stops firing rather than starting to lie.
            assert_eq!(
                INTAKE_CONTENT_CONFLICT,
                "event already accepted with different content"
            );
            assert_eq!(
                response_conflict_token(r#"{"detail":"event already accepted with different content"}"#),
                RESPONSE_ALREADY_DELIVERED
            );
            // THE THREE OTHER REFUSALS THAT SHARE THIS STATUS CODE. Not one of
            // them is a delivery, and not one of them writes a receipt. The
            // first two are the server's own other sentences, measured in its
            // source; they are DIFFERENT sentences and they go to UNKNOWN.
            for other in [
                r#"{"detail":"response already accepted with different content"}"#,
                r#"{"detail":"response_id already used for another profile"}"#,
                r#"{"detail":"conflict"}"#,
                "",
            ] {
                assert_eq!(
                    response_conflict_token(other),
                    RESPONSE_CONFLICT_UNKNOWN,
                    "'{other}' is a conflict whose reason this build does not know"
                );
            }
        }


        // ---- the vault may be swapped WHILE the request is in flight --------
        //
        // BOUNDARY, declared rather than implied. `submit_profile_response`
        // needs a `tauri::State` and a server, which a unit test has not got,
        // so what runs here is the DECISION and a write guarded by it —
        // `guarded_write` below is a model of the product's two write blocks,
        // three lines long and written out so it can be compared with them by
        // eye. That the product's two blocks really are guarded by this same
        // decision is asserted over the source (harness RS24/RS25) and by the
        // D18/D19 drills, because that half is a claim about shape.

        fn file_vault(path: &std::path::Path) -> rusqlite::Connection {
            let conn = rusqlite::Connection::open(path).expect("a file vault");
            conn.execute_batch("CREATE TABLE IF NOT EXISTS vault_info (key TEXT PRIMARY KEY, value TEXT);")
                .expect("the same two columns db.rs migration 1 creates");
            conn
        }

        /// A unique directory of this test's own, so two tests running in
        /// parallel cannot meet in the same file.
        fn temp_dir(tag: &str) -> std::path::PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "skipi-v16-receipt-{}-{}-{:?}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&dir).expect("a temp dir");
            dir
        }

        /// THE MODEL OF BOTH PRODUCT WRITE BLOCKS, in the shape they have.
        fn guarded_write(
            conn: &rusqlite::Connection,
            captured: Option<&str>,
            receipt: &ResponseReceipt,
        ) -> bool {
            if same_vault_db(captured, vault_db_file(conn).as_deref()) {
                if let Ok(json) = serde_json::to_string(receipt) {
                    let _ = crate::db::set_vault_info(
                        conn,
                        &response_receipt_key(&receipt.base, &receipt.profile_id),
                        &json,
                    );
                }
                return true;
            }
            false
        }

        fn receipt_row(conn: &rusqlite::Connection) -> Option<String> {
            crate::db::get_vault_info_value(conn, &response_receipt_key(BASE, PROFILE))
        }

        #[test]
        fn calibration_what_sqlite_answers_about_its_own_file() {
            // MEASURED, not remembered, because the whole rule rests on it: a
            // file database names an absolute path, and an IN-MEMORY one answers
            // with an EMPTY STRING rather than with nothing. If that ever became
            // `None`, `vault_db_file` would still fold it to `None` — but the
            // reason the fold is there would have stopped being visible.
            let dir = temp_dir("calib");
            let path = dir.join("vault.db");
            let disk = file_vault(&path);
            let named = vault_db_file(&disk).expect("a file vault names its file");
            assert!(
                named.ends_with("vault.db") && named.starts_with('/'),
                "sqlite names the file absolutely, got {named}"
            );
            let memory = rusqlite::Connection::open_in_memory().expect("an in-memory vault");
            assert_eq!(
                memory.path().map(str::trim),
                Some(""),
                "an in-memory database answers with the empty string"
            );
            assert!(
                vault_db_file(&memory).is_none(),
                "and `vault_db_file` folds that into unknown"
            );
            // Two different in-memory handles must therefore NEVER read as the
            // same vault, which is exactly what the fold buys.
            let memory2 = rusqlite::Connection::open_in_memory().unwrap();
            assert!(!same_vault_db(
                vault_db_file(&memory).as_deref(),
                vault_db_file(&memory2).as_deref()
            ));
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn the_receipt_is_written_when_the_vault_is_still_the_one_that_spoke() {
            // THE POSITIVE HALF FIRST. Without it the refusal below would be
            // green over a guard that refuses everything, and the card would
            // have shipped a receipt that is never written at all.
            let dir = temp_dir("same");
            let path = dir.join("vault-a.db");
            let conn = file_vault(&path);
            let captured = vault_db_file(&conn);
            let receipt = receipt_from_acknowledgement(
                &answer_from(BASE), &ack(), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            assert!(
                guarded_write(&conn, captured.as_deref(), &receipt),
                "the same open vault must accept its own receipt"
            );
            let row = receipt_row(&conn).expect("the row must be there");
            assert_eq!(accept(&row), Some(receipt), "and it must read back whole");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn d18_d19_a_vault_swapped_during_the_request_receives_nothing() {
            // THE HAZARD, run rather than described: the identity was read out
            // of vault A, the request took up to 45 seconds with the lock
            // released, and by the time the receipt is written the open vault is
            // B. Vault A delivered; vault B has never heard of this response.
            let dir = temp_dir("swap");
            let path_a = dir.join("vault-a.db");
            let path_b = dir.join("vault-b.db");
            let conn_a = file_vault(&path_a);
            let conn_b = file_vault(&path_b);
            let captured_a = vault_db_file(&conn_a);
            assert_ne!(
                captured_a, vault_db_file(&conn_b),
                "the two vaults must really be two files, or this test proves nothing"
            );
            let receipt = receipt_from_acknowledgement(
                &answer_from(BASE), &ack(), PROFILE, RESPONSE, VAULT_USER, SUBJECT,
            );
            assert!(
                !guarded_write(&conn_b, captured_a.as_deref(), &receipt),
                "a receipt captured against vault A must be refused by vault B"
            );
            // NOT ONE RECORD ANYWHERE — read out of BOTH databases, because
            // "it did not panic" is not the same claim.
            assert!(
                receipt_row(&conn_b).is_none(),
                "the stranger's vault must hold no row"
            );
            assert!(
                receipt_row(&conn_a).is_none(),
                "and nothing must have leaked sideways into vault A either"
            );
            // The honest remainder, pinned so it is not mistaken for a fix:
            // vault A, which really did deliver, is left WITHOUT a receipt. The
            // screen is then today's screen and the button is live again; the
            // server still refuses that response id, so a press says "already
            // delivered". That is a refusal to lie, not a repaired state.
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn an_unknown_file_on_either_side_is_a_refusal() {
            assert!(!same_vault_db(None, Some("/vaults/a.db")), "nothing captured is a refusal");
            assert!(!same_vault_db(Some("/vaults/a.db"), None), "nothing open now is a refusal");
            assert!(!same_vault_db(None, None), "two unknowns are not a match");
            assert!(!same_vault_db(Some(""), Some("")), "two empties are not a match");
            assert!(!same_vault_db(Some("/vaults/a.db"), Some("/vaults/b.db")));
            // And the only accepting case, so the four refusals are not vacuous.
            assert!(same_vault_db(Some("/vaults/a.db"), Some("/vaults/a.db")));
        }

        // ---- D13: the decision cannot see a non-production predicate --------
        #[test]
        fn d13_the_decision_is_made_from_strings_and_from_nothing_else() {
            // BACKLOG №603 is four inline copies of "unknown -> production". A
            // new call site with a predicate of its own would widen that class
            // instead of closing it, so the deciding function takes strings —
            // which is a claim about its SHAPE, and a claim about shape is made
            // over the source.
            // The two source readers of the sibling module, reused rather than
            // copied: one `body_of` in this file means one answer to "what does
            // this function's body say", and a second copy would be a second
            // answer that can drift from it.
            use super::registry_scoped_identity::{body_of, signature_of};
            let signature = signature_of("accepted_response_receipt");
            for forbidden in ["JobsResponseEndpoint", "endpoint", "stand", "pilot", "Connection"] {
                assert!(
                    !signature.contains(forbidden),
                    "the decision must not be able to see '{forbidden}' (signature: {signature})"
                );
            }
            let body = body_of("accepted_response_receipt");
            for forbidden in [
                "jobs_response_endpoint",
                "jobs_non_production_base",
                "jobs_test_api_base",
                "jobs_pilot_api_base",
                ".stand",
                ".pilot",
            ] {
                assert!(
                    !body.contains(forbidden),
                    "and it must not reach for '{forbidden}' either"
                );
            }
            // The READER may take the base — and only the base.
            let reader = body_of("jobs_response_receipts");
            assert!(reader.contains("endpoint.base"), "the reader takes the base");
            for forbidden in [".stand", ".pilot", "jobs_non_production_base"] {
                assert!(
                    !reader.contains(forbidden),
                    "the reader must not read '{forbidden}'"
                );
            }
        }
    }

// ════════════════════════════════════════════════════════════════════════════
// №623 S2 — the ten values a response carries, and the five ways they must not
// behave. Every test here is about a property the card names; none of them
// reaches a network, a vault file or a clock it did not set itself.
// ════════════════════════════════════════════════════════════════════════════
// NESTED, AND NOT A SECOND TEST MODULE OF ITS OWN. Every `.rs` in this tree
// carries at most one cfg-test marker, because the harness cuts each file at
// that marker to tell production code from test code, and a second one would
// leave production code below the cut unread
// (`bundled_plugin_isolation_harness.mjs`). So these tests live inside the
// module that already holds this file's one marker. The harness matches the
// marker's literal text, so it is not spelled out anywhere in this comment.
mod response_summary {
    use super::super::*;
    use chrono::NaiveDate;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("the test's own date must parse")
    }

    fn today() -> NaiveDate {
        d("2026-09-30")
    }

    fn row(position: &str, vessel: &str, on: Option<&str>, off: Option<&str>) -> SummaryWorkRow {
        SummaryWorkRow {
            position: position.to_string(),
            vessel_name: vessel.to_string(),
            sign_on: on.map(|s| s.to_string()),
            sign_off: off.map(|s| s.to_string()),
        }
    }

    fn master() -> SummaryPersonal {
        SummaryPersonal {
            first_name: Some("Adrian".into()),
            surname: Some("Seaborne".into()),
            dob: Some("1992-07-15".into()),
            nationality: Some("Ukrainian".into()),
            nationality_code: Some("UKR".into()),
            rank: Some("Master".into()),
        }
    }

    fn built(rows: &[SummaryWorkRow]) -> ResponseSummary {
        build_response_summary(&master(), rows, today())
    }

    // ── overlaps merge, they do not add up ──────────────────────────────────

    #[test]
    fn calibration_one_period_is_worth_exactly_its_own_days() {
        // Without this, "merging works" would be satisfied by a function that
        // returns zero for everything — which is precisely the stub this test
        // was written against.
        let days = merged_interval_days(&[(d("2020-01-01"), d("2020-07-01"))]);
        assert_eq!(days, 182, "1 Jan to 1 Jul 2020 is 182 days");
    }

    #[test]
    fn two_overlapping_periods_merge_into_one_stretch() {
        // 1 Jan–1 Jul and 1 Apr–1 Oct. Summed that is 182 + 183 = 365; merged
        // it is 1 Jan–1 Oct, which is what the man actually served.
        let days = merged_interval_days(&[
            (d("2020-01-01"), d("2020-07-01")),
            (d("2020-04-01"), d("2020-10-01")),
        ]);
        assert_eq!(days, 274, "merged, not summed (summing would give 365)");
    }

    #[test]
    fn a_period_wholly_inside_another_adds_nothing() {
        let days = merged_interval_days(&[
            (d("2020-01-01"), d("2021-01-01")),
            (d("2020-03-01"), d("2020-04-01")),
        ]);
        assert_eq!(days, 366, "2020 is a leap year; the inner period is already inside");
    }

    #[test]
    fn disjoint_periods_do_add_up() {
        let days = merged_interval_days(&[
            (d("2020-01-01"), d("2020-02-01")),
            (d("2021-01-01"), d("2021-02-01")),
        ]);
        assert_eq!(days, 62, "31 + 31, nothing overlaps");
    }

    #[test]
    fn periods_that_merely_touch_never_count_the_boundary_twice() {
        let days = merged_interval_days(&[
            (d("2020-01-01"), d("2020-02-01")),
            (d("2020-02-01"), d("2020-03-01")),
        ]);
        assert_eq!(days, 60, "31 + 29 with the shared day counted once");
    }

    #[test]
    fn the_order_the_rows_arrive_in_changes_nothing() {
        let forward = merged_interval_days(&[
            (d("2020-01-01"), d("2020-07-01")),
            (d("2020-04-01"), d("2020-10-01")),
        ]);
        let backward = merged_interval_days(&[
            (d("2020-04-01"), d("2020-10-01")),
            (d("2020-01-01"), d("2020-07-01")),
        ]);
        assert_eq!(forward, backward, "merging must not depend on table order");
    }

    // ── "no data" and "zero" are different answers ──────────────────────────

    #[test]
    fn no_rows_in_the_rank_at_all_sends_no_experience_pair() {
        let s = built(&[row("Chief Officer", "MV Alpha", Some("2020-01-01"), Some("2020-07-01"))]);
        assert_eq!(s.experience_days, None, "nothing measurable in this rank");
        assert_eq!(s.experience_rank, None, "and the rank goes with it — half a pair is never sent");
    }

    #[test]
    fn rows_in_the_rank_with_no_usable_dates_send_no_experience_pair() {
        let s = built(&[
            row("Master", "MV Alpha", None, None),
            row("Master", "MV Beta", Some("not-a-date"), Some("also-not")),
        ]);
        assert_eq!(s.experience_days, None, "unparsable is not zero, it is unknown");
        assert_eq!(s.experience_rank, None);
    }

    #[test]
    fn a_contract_that_began_and_ended_on_one_day_is_data_and_it_is_zero() {
        // THE DISTINCTION THE CARD IS ABOUT. `cv::work_entry_days` returns 0
        // here and 0 for a missing date, and cannot tell the two apart.
        let s = built(&[row("Master", "MV Alpha", Some("2020-05-05"), Some("2020-05-05"))]);
        assert_eq!(s.experience_days, Some(0), "zero days, and it IS sent");
        assert_eq!(s.experience_rank.as_deref(), Some("Master"));
    }

    #[test]
    fn a_sign_off_before_its_sign_on_is_not_measurable() {
        let s = built(&[row("Master", "MV Alpha", Some("2020-07-01"), Some("2020-01-01"))]);
        assert_eq!(s.experience_days, None, "backwards dates are not a zero-day contract");
    }

    #[test]
    fn one_unusable_row_does_not_poison_the_usable_ones() {
        let s = built(&[
            row("Master", "MV Alpha", Some("2020-01-01"), Some("2020-02-01")),
            row("Master", "MV Beta", None, Some("2021-01-01")),
        ]);
        assert_eq!(s.experience_days, Some(31), "the measurable row still counts");
    }

    // ── the rank decides which rows count, and nothing is normalised ────────

    #[test]
    fn only_rows_of_the_responded_rank_count() {
        let s = built(&[
            row("Master", "MV Alpha", Some("2020-01-01"), Some("2020-02-01")),
            row("Chief Officer", "MV Beta", Some("2021-01-01"), Some("2021-12-01")),
        ]);
        assert_eq!(s.experience_days, Some(31), "the Chief Officer contract is not Master time");
    }

    #[test]
    fn a_different_spelling_is_a_different_rank_because_622_is_not_open() {
        // The server compares this string to the frozen snapshot byte for byte
        // and answers `other_rank`. Normalising here would decide №622 in
        // passing, on the client, where nobody agreed to decide it.
        let s = built(&[row("MASTER", "MV Alpha", Some("2020-01-01"), Some("2020-02-01"))]);
        assert_eq!(s.experience_days, None, "MASTER is not Master");
    }

    #[test]
    fn surrounding_whitespace_in_the_stored_position_still_matches() {
        // The same key `cv::experience_by_position` already groups by
        // (`w.position.trim()`), so this is the product's existing grouping and
        // not a new normalisation of rank names.
        let s = built(&[row("  Master  ", "MV Alpha", Some("2020-01-01"), Some("2020-02-01"))]);
        assert_eq!(s.experience_days, Some(31));
    }

    #[test]
    fn with_no_rank_in_the_vault_neither_half_of_the_pair_is_sent() {
        let mut p = master();
        p.rank = None;
        let s = build_response_summary(
            &p,
            &[row("Master", "MV Alpha", Some("2020-01-01"), Some("2020-02-01"))],
            today(),
        );
        assert_eq!(s.experience_rank, None);
        assert_eq!(s.experience_days, None, "days without a rank they are days OF is meaningless");
    }

    #[test]
    fn the_experience_pair_is_all_or_nothing_on_every_input() {
        let cases: Vec<Vec<SummaryWorkRow>> = vec![
            vec![],
            vec![row("Master", "A", Some("2020-01-01"), Some("2020-02-01"))],
            vec![row("Master", "A", None, None)],
            vec![row("Bosun", "A", Some("2020-01-01"), Some("2020-02-01"))],
            vec![row("Master", "A", Some("2020-05-05"), Some("2020-05-05"))],
        ];
        for rows in cases {
            let s = built(&rows);
            assert_eq!(
                s.experience_rank.is_some(),
                s.experience_days.is_some(),
                "a half pair was produced for {rows:?}"
            );
        }
    }

    // ── age: a number and its honesty, never a date of birth ────────────────

    #[test]
    fn a_full_date_of_birth_gives_an_exact_age() {
        let s = built(&[]);
        assert_eq!(s.age_years, Some(34), "born 1992-07-15, measured on 2026-09-30");
        assert_eq!(s.age_precision, Some("exact"));
    }

    #[test]
    fn the_day_before_a_birthday_is_still_the_younger_age() {
        let mut p = master();
        p.dob = Some("1992-10-01".into());
        let s = build_response_summary(&p, &[], today());
        assert_eq!(s.age_years, Some(33), "the birthday has not happened yet in 2026");
    }

    #[test]
    fn a_year_only_date_of_birth_says_so_instead_of_inventing_a_day() {
        let mut p = master();
        p.dob = Some("1992".into());
        let s = build_response_summary(&p, &[], today());
        assert_eq!(s.age_years, Some(34));
        assert_eq!(s.age_precision, Some("year"), "not 'exact' — the day is not known");
    }

    #[test]
    fn an_unreadable_date_of_birth_sends_no_age_at_all() {
        for bad in ["", "   ", "15/07/1992", "nineteen ninety two", "1992-13-45"] {
            let mut p = master();
            p.dob = Some(bad.into());
            let s = build_response_summary(&p, &[], today());
            assert_eq!(s.age_years, None, "{bad:?} must not produce an age");
            assert_eq!(s.age_precision, None, "{bad:?} must not produce a precision");
        }
    }

    #[test]
    fn a_date_of_birth_in_the_future_sends_no_age() {
        let mut p = master();
        p.dob = Some("2030-01-01".into());
        let s = build_response_summary(&p, &[], today());
        assert_eq!(s.age_years, None);
        assert_eq!(s.age_precision, None);
    }

    #[test]
    fn a_year_only_date_of_birth_in_the_future_sends_no_age_either() {
        // The exact branch is refused by `years_since` itself; the year branch
        // has to refuse on its own, and a negative age would otherwise be sent
        // as a number with a straight face.
        for dob in ["2030", "9999"] {
            let mut p = master();
            p.dob = Some(dob.into());
            let s = build_response_summary(&p, &[], today());
            assert_eq!(s.age_years, None, "{dob:?} is not an age");
            assert_eq!(s.age_precision, None);
        }
    }

    #[test]
    fn the_age_pair_is_all_or_nothing_on_every_input() {
        for dob in ["1992-07-15", "1992", "", "rubbish", "2030-01-01", "1800-01-01"] {
            let mut p = master();
            p.dob = Some(dob.into());
            let s = build_response_summary(&p, &[], today());
            assert_eq!(
                s.age_years.is_some(),
                s.age_precision.is_some(),
                "a half pair was produced for {dob:?}"
            );
        }
    }

    #[test]
    fn the_age_is_completed_years_exactly_as_the_other_copy_counts_them() {
        // `profile::compute_age_bucket` counts the same way and cannot be
        // called from here — see `age_years_on` for why the copy exists. What
        // is pinned here is the ANSWER: completed years, leap day included,
        // measured on a stated day and never on the clock.
        for (dob, expected) in [
            ("1992-07-15", 34),
            ("1970-01-01", 56),
            ("2008-02-29", 18),
            ("2026-09-30", 0),
        ] {
            let mut p = master();
            p.dob = Some(dob.into());
            assert_eq!(
                build_response_summary(&p, &[], today()).age_years,
                Some(expected),
                "{dob} on 2026-09-30"
            );
        }
    }

    // ── last vessel: the latest one, not a random one ───────────────────────

    #[test]
    fn the_last_vessel_is_the_latest_in_time_not_the_last_in_the_table() {
        let s = built(&[
            row("Master", "MV Newest", Some("2024-01-01"), Some("2024-06-01")),
            row("Master", "MV Oldest", Some("2019-01-01"), Some("2019-06-01")),
        ]);
        assert_eq!(s.last_vessel_name.as_deref(), Some("MV Newest"));
        assert_eq!(s.last_vessel_sign_off.as_deref(), Some("2024-06-01"));
    }

    #[test]
    fn the_last_vessel_is_not_filtered_by_the_responded_rank() {
        // The contract field is `last_vessel_name`, not "last vessel in rank":
        // the crewing is being told which ship he came off, and he came off
        // that one whatever he was rated as on it.
        let s = built(&[
            row("Master", "MV Older", Some("2019-01-01"), Some("2019-06-01")),
            row("Deck Cadet", "MV Newest", Some("2024-01-01"), Some("2024-06-01")),
        ]);
        assert_eq!(s.last_vessel_name.as_deref(), Some("MV Newest"));
    }

    #[test]
    fn a_vessel_still_being_served_on_is_the_last_one_and_has_no_sign_off() {
        let s = built(&[
            row("Master", "MV Ashore", Some("2023-01-01"), Some("2023-06-01")),
            row("Master", "MV Aboard", Some("2025-02-01"), None),
        ]);
        assert_eq!(s.last_vessel_name.as_deref(), Some("MV Aboard"));
        assert_eq!(s.last_vessel_sign_off, None, "he has not signed off — say nothing, not ''");
    }

    #[test]
    fn with_no_datable_row_there_is_no_last_vessel() {
        let s = built(&[row("Master", "MV Nowhere", None, None)]);
        assert_eq!(s.last_vessel_name, None, "nothing can be called the LATEST here");
        assert_eq!(s.last_vessel_sign_off, None);
    }

    #[test]
    fn a_row_with_no_vessel_name_sends_no_vessel_name() {
        let s = built(&[row("Master", "   ", Some("2024-01-01"), Some("2024-06-01"))]);
        assert_eq!(s.last_vessel_name, None, "blank is absent, never an empty string");
    }

    #[test]
    fn the_sign_off_is_the_text_the_seafarer_wrote() {
        let s = built(&[row("Master", "MV Alpha", Some("2024-01-01"), Some("2024-06-01"))]);
        assert_eq!(
            s.last_vessel_sign_off.as_deref(),
            Some("2024-06-01"),
            "not reformatted, not re-rendered in some other calendar"
        );
    }

    // ── identity and citizenship come out of the vault as they are ──────────

    #[test]
    fn the_identity_and_citizenship_values_are_carried() {
        let s = built(&[]);
        assert_eq!(s.first_name.as_deref(), Some("Adrian"));
        assert_eq!(s.surname.as_deref(), Some("Seaborne"));
        assert_eq!(s.citizenship.as_deref(), Some("Ukrainian"));
        assert_eq!(s.citizenship_code.as_deref(), Some("UKR"));
    }

    #[test]
    fn blank_and_missing_vault_values_are_absent_and_never_empty_strings() {
        let p = SummaryPersonal {
            first_name: Some("   ".into()),
            surname: None,
            dob: None,
            nationality: Some(String::new()),
            nationality_code: None,
            rank: None,
        };
        let s = build_response_summary(&p, &[], today());
        assert_eq!(s.first_name, None);
        assert_eq!(s.surname, None);
        assert_eq!(s.citizenship, None);
        assert_eq!(s.citizenship_code, None);
    }

    #[test]
    fn an_empty_vault_produces_not_one_of_the_ten() {
        let s = build_response_summary(&SummaryPersonal::default(), &[], today());
        assert_eq!(s, ResponseSummary::default(), "nothing known, nothing claimed");
    }

    // ── the body: exactly the ten names, and never a date of birth ──────────

    fn body_keys(summary: &ResponseSummary) -> Vec<String> {
        let mut body = serde_json::json!({});
        apply_summary_to_body(&mut body, summary);
        let mut keys: Vec<String> = body
            .as_object()
            .expect("the body stays an object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn the_list_of_names_is_the_ten_the_server_declared() {
        let mut declared = RESPONSE_SUMMARY_FIELDS.to_vec();
        declared.sort();
        assert_eq!(
            declared,
            vec![
                "last_vessel_name",
                "last_vessel_sign_off",
                "rank_experience_days",
                "rank_experience_rank",
                "seafarer_age_precision",
                "seafarer_age_years",
                "seafarer_citizenship",
                "seafarer_citizenship_code",
                "seafarer_first_name",
                "seafarer_surname",
            ]
        );
    }

    #[test]
    fn a_full_summary_writes_all_ten_and_nothing_else() {
        let s = built(&[row("Master", "MV Alpha", Some("2020-01-01"), Some("2020-02-01"))]);
        let keys = body_keys(&s);
        assert_eq!(keys.len(), 10, "got {keys:?}");
        for k in &keys {
            assert!(
                RESPONSE_SUMMARY_FIELDS.contains(&k.as_str()),
                "{k} is not one of the ten the server's extra=\"forbid\" schema knows"
            );
        }
    }

    #[test]
    fn an_empty_summary_writes_no_keys_at_all() {
        // Not nulls, not empty strings: the key is simply not there, which is
        // how "he did not fill this in" reaches the crewing's screen.
        assert_eq!(body_keys(&ResponseSummary::default()), Vec::<String>::new());
    }

    #[test]
    fn the_existing_five_fields_are_left_exactly_as_they_were() {
        let mut body = serde_json::json!({
            "response_id": "r-1",
            "contact": "a@b.test",
            "cv_content_type": "application/pdf",
            "cv_base64": "AAAA",
            "message": "hello",
        });
        let before = body.clone();
        apply_summary_to_body(&mut body, &built(&[]));
        for key in ["response_id", "contact", "cv_content_type", "cv_base64", "message"] {
            assert_eq!(body[key], before[key], "{key} must not be touched");
        }
    }

    #[test]
    fn a_half_pair_that_reaches_the_body_layer_is_still_not_written() {
        // FOUND BY A SURVIVING MUTATION. Splitting the two pairs in
        // `apply_summary_to_body` into four independent writes left every test
        // green, because `build_response_summary` never produces a half pair —
        // so the body layer's own half of the rule was asserted nowhere, and a
        // later change that produced one would have sent a number of days that
        // says nothing about which rank they are days of. Both layers are
        // drilled now, and the summaries here are hand-made on purpose.
        let halves = [
            ResponseSummary { age_years: Some(30), ..Default::default() },
            ResponseSummary { age_precision: Some("exact"), ..Default::default() },
            ResponseSummary { experience_days: Some(31), ..Default::default() },
            ResponseSummary { experience_rank: Some("Master".into()), ..Default::default() },
        ];
        for half in halves {
            assert_eq!(
                body_keys(&half),
                Vec::<String>::new(),
                "half a pair reached the body: {half:?}"
            );
        }
    }

    #[test]
    fn a_whole_pair_that_reaches_the_body_layer_is_written_whole() {
        // The calibration for the test above: without it, an
        // `apply_summary_to_body` that wrote nothing at all would pass it.
        let age = ResponseSummary {
            age_years: Some(30),
            age_precision: Some("exact"),
            ..Default::default()
        };
        assert_eq!(
            body_keys(&age),
            vec!["seafarer_age_precision".to_string(), "seafarer_age_years".to_string()]
        );
        let exp = ResponseSummary {
            experience_days: Some(31),
            experience_rank: Some("Master".into()),
            ..Default::default()
        };
        assert_eq!(
            body_keys(&exp),
            vec!["rank_experience_days".to_string(), "rank_experience_rank".to_string()]
        );
    }

    #[test]
    fn the_date_of_birth_never_reaches_the_body_under_any_name() {
        let s = built(&[row("Master", "MV Alpha", Some("2020-01-01"), Some("2020-02-01"))]);
        let mut body = serde_json::json!({});
        apply_summary_to_body(&mut body, &s);
        let text = serde_json::to_string(&body).expect("a JSON object serialises");
        assert!(!text.contains("1992-07-15"), "the date of birth itself leaked: {text}");
        for key in body.as_object().expect("object").keys() {
            assert!(!key.contains("dob"), "{key} names a date of birth");
            assert!(!key.contains("birth"), "{key} names a date of birth");
        }
    }

    #[test]
    fn the_numbers_are_sent_as_numbers_and_the_precision_as_a_closed_word() {
        let s = built(&[row("Master", "MV Alpha", Some("2020-01-01"), Some("2020-02-01"))]);
        let mut body = serde_json::json!({});
        apply_summary_to_body(&mut body, &s);
        assert!(body["seafarer_age_years"].is_i64(), "age is a number, not a string");
        assert!(body["rank_experience_days"].is_i64(), "days are a number, not a string");
        let precision = body["seafarer_age_precision"].as_str().unwrap_or_default();
        assert!(
            precision == "exact" || precision == "year",
            "the server's closed set is exact|year, got {precision:?}"
        );
    }

    // ── nothing here may ever cost a delivery ───────────────────────────────

    #[test]
    fn no_input_a_vault_can_hold_makes_this_panic() {
        let nasty = [
            "",
            "   ",
            "\u{0}",
            "0000-00-00",
            "9999-12-31",
            "-0001-01-01",
            "Master\u{0}",
            &"x".repeat(5000),
        ];
        for value in nasty {
            let p = SummaryPersonal {
                first_name: Some(value.to_string()),
                surname: Some(value.to_string()),
                dob: Some(value.to_string()),
                nationality: Some(value.to_string()),
                nationality_code: Some(value.to_string()),
                rank: Some(value.to_string()),
            };
            let rows = vec![
                row(value, value, Some(value), Some(value)),
                row(value, value, None, Some(value)),
            ];
            let s = build_response_summary(&p, &rows, today());
            let mut body = serde_json::json!({});
            apply_summary_to_body(&mut body, &s);
            assert!(body.is_object(), "the body survived {value:?}");
        }
    }

    #[test]
    fn a_thousand_periods_still_answer_and_answer_correctly() {
        // Ten years of back-to-back month-long contracts, every one of them
        // overlapping its neighbour, in reverse order.
        let mut periods = Vec::new();
        let start = d("2010-01-01");
        for i in (0..120).rev() {
            let on = start + chrono::Duration::days(i * 30);
            let off = on + chrono::Duration::days(45);
            periods.push((on, off));
        }
        let days = merged_interval_days(&periods);
        assert_eq!(days, 119 * 30 + 45, "one continuous stretch, merged once");
    }

    // ── read out of a real vault, not out of a parameter ────────────────────

    fn vault() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory vault");
        conn.execute_batch(
            "CREATE TABLE vault_info (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE work_history (
                id TEXT PRIMARY KEY, vessel_name TEXT NOT NULL, vessel_type TEXT, imo TEXT,
                flag TEXT, company TEXT, position TEXT, sign_on TEXT, sign_off TEXT,
                notes TEXT, created_at TEXT NOT NULL);",
        )
        .expect("the test's own schema");
        conn
    }

    fn put(conn: &rusqlite::Connection, key: &str, value: &str) {
        crate::db::set_vault_info(conn, key, value).expect("the test's own write");
    }

    fn add_row(conn: &rusqlite::Connection, id: &str, pos: &str, vessel: &str, on: &str, off: &str) {
        conn.execute(
            "INSERT INTO work_history (id, vessel_name, position, sign_on, sign_off, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, '2020-01-01')",
            rusqlite::params![id, vessel, pos, on, off],
        )
        .expect("the test's own row");
    }

    #[test]
    fn every_value_comes_out_of_the_vault_this_connection_holds() {
        let conn = vault();
        put(&conn, "personal_first_name", "Adrian");
        put(&conn, "personal_surname", "Seaborne");
        put(&conn, "personal_dob", "1992-07-15");
        put(&conn, "personal_nationality", "Ukrainian");
        put(&conn, "personal_nationality_code", "UKR");
        put(&conn, "personal_rank", "Master");
        add_row(&conn, "w1", "Master", "MV Alpha", "2020-01-01", "2020-07-01");
        add_row(&conn, "w2", "Master", "MV Beta", "2020-04-01", "2020-10-01");

        let s = read_response_summary(&conn);
        assert_eq!(s.first_name.as_deref(), Some("Adrian"));
        assert_eq!(s.surname.as_deref(), Some("Seaborne"));
        assert_eq!(s.citizenship.as_deref(), Some("Ukrainian"));
        assert_eq!(s.citizenship_code.as_deref(), Some("UKR"));
        assert_eq!(s.experience_rank.as_deref(), Some("Master"));
        assert_eq!(s.experience_days, Some(274), "merged, not 365");
        assert_eq!(s.last_vessel_name.as_deref(), Some("MV Beta"));
        assert_eq!(s.age_precision, Some("exact"));
        assert!(s.age_years.is_some());
    }

    #[test]
    fn the_rank_falls_back_the_same_way_the_jobs_screen_reads_it() {
        // `get_seafarer_personal` answers `personal_rank` or `rank`, and the
        // Jobs screen sends THAT to the server as the filter. Reading it any
        // other way here would send a rank the response was not matched on.
        let conn = vault();
        put(&conn, "rank", "Bosun");
        add_row(&conn, "w1", "Bosun", "MV Alpha", "2020-01-01", "2020-02-01");
        assert_eq!(read_response_summary(&conn).experience_rank.as_deref(), Some("Bosun"));

        put(&conn, "personal_rank", "Master");
        add_row(&conn, "w2", "Master", "MV Beta", "2021-01-01", "2021-02-01");
        let s = read_response_summary(&conn);
        assert_eq!(s.experience_rank.as_deref(), Some("Master"), "personal_rank wins");
        assert_eq!(s.experience_days, Some(31), "and the Bosun time is not Master time");
    }

    #[test]
    fn a_vault_with_nothing_in_it_yields_nothing_and_does_not_fail() {
        let conn = vault();
        assert_eq!(read_response_summary(&conn), ResponseSummary::default());
    }

    #[test]
    fn a_vault_whose_tables_are_missing_yields_nothing_and_does_not_fail() {
        // THE DELIVERY RULE, at the lowest level it can be tested: a broken
        // vault makes the summary empty, never an error, because an error here
        // would travel up and cost a seafarer his response.
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
        assert_eq!(read_response_summary(&conn), ResponseSummary::default());
    }

    #[test]
    fn a_row_whose_position_is_null_does_not_stop_the_others_being_read() {
        let conn = vault();
        put(&conn, "personal_rank", "Master");
        conn.execute(
            "INSERT INTO work_history (id, vessel_name, position, sign_on, sign_off, created_at)
             VALUES ('w0', 'MV Null', NULL, '2019-01-01', '2019-02-01', '2019-01-01')",
            [],
        )
        .expect("the test's own row");
        add_row(&conn, "w1", "Master", "MV Alpha", "2020-01-01", "2020-02-01");
        let s = read_response_summary(&conn);
        assert_eq!(s.experience_days, Some(31));
        assert_eq!(s.last_vessel_name.as_deref(), Some("MV Alpha"));
    }
}
}
