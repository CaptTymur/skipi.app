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
    let (vault_user_id, public_seafarer_id, contact) = {
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
        let public_id = crate::db::get_vault_info_value(conn, "skipi_public_seafarer_id")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or("this vault has no public seafarer id yet")?;
        let contact = crate::db::get_vault_info_value(conn, "personal_email")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or("add an e-mail to your profile before responding")?;
        (user_id, public_id, contact)
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
        return Err(response_conflict_token(&answer.body).to_string());
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
    Ok(ack)
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
    Ok(SeafarerIdentityEntryState {
        public_seafarer_id: vault_text(conn, "skipi_public_seafarer_id"),
        identity_key_registered_at: vault_text(conn, IDENTITY_KEY_REGISTERED_AT),
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
        let public_seafarer_id = vault_text(conn, "skipi_public_seafarer_id");
        let claim_status = vault_text(conn, "skipi_identity_claim_status");
        let trust_level = vault_text(conn, "skipi_identity_trust_level");
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
            // What the server said is recorded either way — it is the only record
            // of a duplicate there is.
            crate::db::set_vault_info(conn, "skipi_identity_claim_status", &claim.status)
                .map_err(|e| e.to_string())?;
            crate::db::set_vault_info(
                conn,
                "skipi_identity_duplicate",
                if claim.duplicate { "true" } else { "false" },
            )
            .map_err(|e| e.to_string())?;
            crate::db::set_vault_info(conn, "skipi_identity_trust_level", &claim.trust_level)
                .map_err(|e| e.to_string())?;
            crate::db::set_vault_info(conn, "skipi_identity_message", &claim.message)
                .map_err(|e| e.to_string())?;
            crate::db::set_vault_info(
                conn,
                "skipi_identity_last_claim_at",
                &chrono::Utc::now().to_rfc3339(),
            )
            .map_err(|e| e.to_string())?;

            // A 200 WITH AN EMPTY ID IS NOT A SUCCESS. `possible_duplicate` answers
            // exactly that: another vault already claimed this name and date of
            // birth. Writing the empty string into `skipi_public_seafarer_id` — the
            // way the profile-side claim does — would leave the screen in a silent
            // forever-loop: press, 200, still no id, press again. There is no
            // recovery flow in this product to send him to, so the honest thing is
            // to stop and say so. The refusal leaves from inside this block, which
            // is where the lock is dropped.
            if issued.is_empty() {
                return Err(IDENTITY_CLAIM_DUPLICATE.to_string());
            }
            crate::db::set_vault_info(conn, "skipi_public_seafarer_id", &issued)
                .map_err(|e| e.to_string())?;
            if let Some(key) = claim
                .identity_recovery_key
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                crate::db::set_vault_info(conn, "skipi_identity_recovery_key", key)
                    .map_err(|e| e.to_string())?;
            }
            let _ = crate::identity::sync_identity_fingerprint(conn);
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
        crate::db::set_vault_info(conn, IDENTITY_KEY_REGISTERED_AT, &registered_at)
            .map_err(|e| e.to_string())?;
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
}
