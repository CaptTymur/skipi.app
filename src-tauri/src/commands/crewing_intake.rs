//! Crew Flow commands of the crewing role, carried over from the pilot client
//! (skipi-crewing `src-tauri/src/crewing_intake.rs` at 4b82cd8) — owner
//! 25.11.2026: the modules must be the pilot's, not a rewrite (tasks/018).
//!
//! One difference from the pilot: the connection. The pilot read server, token
//! and workspace from its settings file; here they come from the one Skipi
//! sign-in (`crewing::live_connection`), and the screen's expected context is
//! checked against that live connection.

use crate::commands::crewing::{self, LiveConnection};
use crate::commands::crewing_contact::{checked_recipient, open_with_default_app};
use crate::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::blocking::{Client, RequestBuilder};
use reqwest::{redirect::Policy, Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const REQUEST_TIMEOUT_SECS: u64 = 20;
const PILOT_MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct PilotExpectedContext {
    server_url: String,
    connection_context: String,
    crewing_id: String,
}

#[derive(Debug, Clone)]
struct PilotContext {
    server_url: String,
    bearer_token: String,
    crewing_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct PilotBridgeError {
    pub kind: String,
    pub status: Option<u16>,
    pub detail: Option<String>,
    pub ambiguous: bool,
}

impl PilotBridgeError {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            status: None,
            detail: None,
            ambiguous: false,
        }
    }

    fn invalid_context(detail: &str) -> Self {
        let mut err = Self::new("invalid_context");
        err.detail = Some(detail.to_string());
        err
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct IntakeAliasPublic {
    pub id: String,
    pub crewing_id: String,
    pub primary_profile_id: Option<String>,
    pub label: Option<String>,
    pub state: String,
    pub generation: i64,
    pub created_at: String,
    pub updated_at: String,
    pub rotated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct IntakeAliasIssued {
    #[serde(flatten)]
    pub public: IntakeAliasPublic,
    pub alias: String,
}

// No.720 unit C. The reveal answer needs a struct of its OWN, and reusing
// `IntakeAliasIssued` would have been wrong in a way no test would have seen: serde
// silently DROPS fields a struct does not declare, so `address` and `reason` would have
// vanished between a truthful
// server and a client that then honestly rendered «no address issued». Green server,
// green bridge, green suite, and the user still sees nothing.
//
// All three values are `Option` on purpose, and not for tidiness:
//   `address` is null on the never-stored outcome, by the card's own table;
//   `reason` is absent on the success outcome;
//   `alias` the card does NOT specify for the never-stored outcome — the column is empty
//   there, so there is no local part either, and `Option` survives BOTH «null» and
//   «field omitted». I am naming that this ABSORBS a gap rather than closing it: the
//   card still owes the line, and unit A should not have to guess.
//
// The serde attribute that REFUSES unknown fields is deliberately not set here, and its
// name is deliberately not written in this file either. Two separate reasons:
//   its radius is every bridge struct in this file, which is No.723 and wider than this
//   card, so switching it on in one place would imply the class is handled;
//   and a neighbouring harness (No.623 in crewing_c3b2_candidate_harness) tests for that
//   name as a WORD in this source rather than as an attribute, so merely NAMING it here —
//   even to explain its absence — turns that assert red. That unit error is filed as
//   No.727 and is not fixed from here, so the name stays out of this file entirely.
// This struct therefore declares exactly what the server sends — alias, address, reason —
// and any field the server adds later is dropped in silence (No.723). What guards the
// declaration is the drill in crewing_c3b1_pilot_harness.mjs: remove a field and the
// assertion must redden.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct IntakeAliasRevealed {
    #[serde(flatten)]
    pub public: IntakeAliasPublic,
    pub alias: Option<String>,
    pub address: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct IntakeAliasListResponse {
    pub items: Vec<IntakeAliasPublic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateIntakeObject {
    pub id: String,
    pub content_type: String,
}

/// Distinguishes "the field was not sent" from "the field was sent as null".
/// With `#[serde(default)]` the absent field yields the outer `None`, while an
/// explicit `null` deserializes into `Some(None)` — the only way a three-state
/// answer survives a two-state type.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

/// R2 (OWNER 2026-09-29): one stored evaluation, reduced to what a queue row can
/// state — counts, never text and never a score. The server holds no locales, so
/// every word on the row is produced client-side from these numbers.
///
/// `total` is not symmetry with the other three. The candidate card keeps an
/// `unknown` bucket (dist/index.html:6816) precisely so an outcome CODE this build
/// does not recognise is never silently counted as met. A row carries numbers
/// rather than codes, so `total` is the only thing that can carry that refusal
/// across: when `met + missing + unconfirmed` differs from `total`, the row says
/// the outcomes are not fully recognised instead of under-counting in silence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateProfileRankSummary {
    pub profile_id: String,
    pub profile_version: i64,
    pub met: i64,
    pub missing: i64,
    /// Both `unconfirmed_requirement` and `unconfirmed_fact`, grouped exactly as
    /// the card groups them. Never folded into `met`.
    pub unconfirmed: i64,
    pub total: i64,
    pub stale: bool,
    /// No.622/No.637-S6: the professional-applicability verdict of THIS row, as
    /// the queue's own producer computes it (`schemas.CandidateIntakeSummaryRank`).
    /// One of `crewing_rank.VERDICTS`.
    ///
    /// `Option` with `#[serde(default)]` and NOT a plain `String`, although the
    /// server declares it required: a pilot server from before No.622 sends no
    /// such key, and a required field there would fail the parse of the WHOLE
    /// queue row — the operator would lose the candidate rather than lose a
    /// verdict. Absent is therefore `None`, and `cardApplicability` reads that
    /// as `stated:false`: not a sixth verdict, not `same`, not
    /// `not_applicable`; the row renders exactly as it did before No.622.
    #[serde(default)]
    pub applicability: Option<String>,
    /// Only ever set beside an `unknown` verdict, one of `crewing_rank.REASONS`.
    /// "He has no rank fact", "nobody could place the one he has" and "nobody
    /// could place the PROFILE's wording" are three different next actions.
    #[serde(default)]
    pub applicability_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateIntakeSummary {
    pub state: String,
    pub facts: i64,
    pub ranks: i64,
    pub ranks_stale: i64,
    /// No.622/No.637-S6: active profiles this candidate was deliberately NOT
    /// evaluated against. The row has to be able to say how many it is not
    /// showing instead of implying it shows all (docs/CANON-ui-v1.md, principle
    /// 1). `#[serde(default)]` for the same reason `written` carries it: an
    /// older server sends no key and nothing was withheld as far as it knows.
    #[serde(default)]
    pub ranks_withheld: i64,
    pub active_confirmations: i64,
    pub needs_review_reason: Option<String>,
    /// R2: who the candidate is, rendered by the server from the SAME recorded
    /// fact the card loads, so the queue row can say whom to open without a card.
    ///
    /// Three states, deliberately, and `Option<Option<String>>` is what keeps them
    /// apart: the outer `None` means this server build does not carry the field
    /// and nothing can be claimed; `Some(None)` means the server answered that the
    /// recorded facts hold no name; `Some(Some(s))` is the name. A plain
    /// `Option<String>` collapses the first two, and the row would then announce
    /// "no name recorded" about a server that was never asked. `skip_serializing_if`
    /// carries the same three states across to the webview: absent stays absent
    /// there instead of arriving as `null`.
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub candidate_name: Option<Option<String>>,
    /// R2: the stored per-profile outcome, riding along with the list so the queue
    /// row is filled the moment Crew Flow opens — no card opened and no request
    /// per row.
    ///
    /// Deliberately `Option`, not a defaulted `Vec`: `None` means this server build
    /// does not carry the field and the question is UNANSWERED (the row says "not
    /// loaded"); `Some([])` means the server answered that there are no stored
    /// evaluations (the row says "no comparison"). Collapsing the two into `[]`
    /// would make an unanswered question look like an answer on the operator's
    /// screen. A missing field never fails the parse.
    #[serde(default)]
    pub profile_ranks: Option<Vec<CandidateProfileRankSummary>>,
}

/// No.623 (OWNER (943)/(944)): WHO responded, on the queue row.
///
/// Four values and no more. The card shape must not ride the list: the server
/// deliberately answers the queue with this narrow object, and the client type
/// mirrors that narrowness so a later hand cannot widen the row by accident.
///
/// `rank_state` exists ALONGSIDE `rank` on purpose, and is not derived from
/// `rank.is_none()`: "the profile did not name a post", "the version you
/// responded to was overwritten by a republish" and "there is no readable
/// snapshot at all" are three different sentences, and only the server knows
/// which one is true. The screen holds the wording; the server holds the code.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateResponseHeadline {
    #[serde(default)]
    pub rank: Option<String>,
    #[serde(default)]
    pub rank_state: Option<String>,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub surname: Option<String>,
}

/// No.623: the six elements of the compact summary, as the CARD route answers
/// them. Thirteen names, frozen by the card: a fourteenth would be a field about
/// a person that nobody agreed to.
///
/// Every field is `Option` with `#[serde(default)]`, for the reason already
/// written on `profile_ranks` above: a pilot server that does not carry a key
/// must not fail the parse of the whole card. A value that is absent is not a
/// zero and not an empty string -- the screen says "not given", and
/// `experience_state` is what keeps "no data" apart from "no sea time".
///
/// `age_years` is a NUMBER and there is deliberately no date of birth here: the
/// server neither accepts nor stores one, and `age_precision` is what stops the
/// screen from claiming a to-the-day age it was never given.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateResponseSummary {
    #[serde(default)]
    pub rank: Option<String>,
    #[serde(default)]
    pub rank_state: Option<String>,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub surname: Option<String>,
    #[serde(default)]
    pub age_years: Option<i64>,
    #[serde(default)]
    pub age_precision: Option<String>,
    #[serde(default)]
    pub citizenship: Option<String>,
    #[serde(default)]
    pub citizenship_code: Option<String>,
    #[serde(default)]
    pub experience_rank: Option<String>,
    #[serde(default)]
    pub experience_days: Option<i64>,
    #[serde(default)]
    pub experience_state: Option<String>,
    /// No.632/S5: the career as `{rank: days}`, exactly as the seafarer's own
    /// client merged it (never summed) and the server stored it.
    ///
    /// The letter of THIS slice is written for a profile the candidate may never
    /// have responded to, and then the pair above is about a DIFFERENT post. So
    /// the map is the only thing the letter may read, and it is read by EQUALITY:
    /// a post the map does not name is "not stated", and a post it names with `0`
    /// is a MEASURED zero. `days || "not stated"` turns the second into the first
    /// and is the bug the drills of this card forbid.
    #[serde(default)]
    pub experience_days_by_rank: Option<std::collections::BTreeMap<String, i64>>,
    /// The server's own answer for the post of the response's OWN profile, and
    /// the state word that goes with it. Declared because the card shows them;
    /// the letter of another profile reads the map above instead.
    #[serde(default)]
    pub experience_days_for_rank: Option<i64>,
    #[serde(default)]
    pub experience_days_for_rank_state: Option<String>,
    #[serde(default)]
    pub last_vessel_name: Option<String>,
    #[serde(default)]
    pub last_vessel_sign_off: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateIntakeReceipt {
    pub intake_id: String,
    pub receipt_id: String,
    pub crewing_id: String,
    pub source: String,
    pub source_id: String,
    pub event_id: String,
    pub primary_profile_id: Option<String>,
    pub content_sha256: String,
    pub content_bytes: u64,
    pub content_type: String,
    pub state: String,
    pub source_trust: String,
    pub version: i64,
    pub created_at: String,
    pub issued_at: String,
    #[serde(default)]
    pub objects: Vec<CandidateIntakeObject>,
    /// S3 (2026-09-26): the attachment METADATA rows of this intake. The field is
    /// declared BEFORE the two byte commands exist on purpose — a typed Tauri
    /// command deserializes into this struct, so a missing field would drop the
    /// list on the way to the webview and the card would honestly render
    /// "no attachments" while the server had them.
    #[serde(default)]
    pub attachments: Vec<CandidateIntakeAttachment>,
    pub summary: Option<CandidateIntakeSummary>,
    /// No.623: WHO responded. Declared on this struct because `send` decodes
    /// BOTH the card and the rows of the queue into it -- and serde drops a key
    /// no field declares, silently and without failing the parse. Undeclared,
    /// the six elements would never leave Rust, the webview would render exactly
    /// what it renders today, and every renderer test would stay green over it.
    ///
    /// The routes stay narrow on the wire: the queue answers `response_headline`
    /// only, the card answers `response_summary` only. Each is therefore `None`
    /// on the other route, which is the same `None` an older pilot server
    /// produces -- and both mean the same thing to the screen ("no response
    /// fields here"), so one `Option` carries the distinction without the
    /// `Option<Option<_>>` that `candidate_name` needs. There the three states
    /// differ ON SCREEN; here they do not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_headline: Option<CandidateResponseHeadline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_summary: Option<CandidateResponseSummary>,
    /// No.664/S2: the stable key of the PERSON who responded, for THIS crewing
    /// only (`PR-` + 16 hex — an HMAC the server derives from the seafarer's
    /// identity; the public `SKP-SF` id itself is not disclosed and cannot be
    /// recovered from it). The card is the only route that carries it; it is
    /// `None` for a letter without a response and on every other route.
    /// Declared for the same reason as the two above: serde drops an undeclared
    /// key silently, and the seafarer database would go on being keyed by the
    /// LETTER (`intake:<id>`) while every renderer test stayed green. The
    /// webview validates the shape before it keys anything by it.
    #[serde(default)]
    pub person_ref: Option<String>,
}

/// One attachment row exactly as `candidate_intake_service.public_attachments_for`
/// serializes it (card S3 OUTCOME (1)): metadata only, никаких storage-путей.
/// `eligible` says the verdict admits a download; the byte route stays the
/// authority and may still answer 404.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateIntakeAttachment {
    pub ordinal: i64,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub declared_type: Option<String>,
    #[serde(default)]
    pub measured_type: Option<String>,
    #[serde(default)]
    pub byte_size: Option<i64>,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub eligible: bool,
}

/// What a byte route gives the screen: where the copy landed, how big it is, its
/// digest, and — for the original letter only — the header part of the .eml so the
/// card can show From/Date/Subject without ever parsing the body.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct CandidateIntakeDownload {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub head_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateIntakeListResponse {
    pub items: Vec<CandidateIntakeReceipt>,
    pub limit: u32,
    pub offset: u32,
    pub total: u64,
}

/// No.621 (OWNER (938)): the contact a seafarer chose to expose when he RESPONDED
/// to a published profile, and the two verdicts the SERVER made about it.
///
/// A shape of its own for a route of its own, and it is not a field on
/// `CandidateIntakeReceipt` on purpose: that struct parses BOTH the card and the
/// rows of the queue (`CandidateIntakeListResponse`), so a field there would have
/// put an address on every row of the queue rather than on the card that was
/// opened.
///
/// All three fields are `Option` with `#[serde(default)]`, for the reason written
/// on `profile_ranks` above: a server that does not carry a key must not fail the
/// parse. `value` absent is not "no contact" - the ROUTE says that, with a 404 -
/// it is "this build was told nothing", and the screen keeps those apart.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateResponseContact {
    #[serde(default)]
    pub value: Option<String>,
    /// Is this string, on its own, one e-mail address? The grammar is the
    /// server's (`crewing_contacts.email_is_plausible`); the webview is given no
    /// address grammar of its own, because two graders are two answers.
    #[serde(default)]
    pub is_email: Option<bool>,
    /// May a letter be PREPARED to it? False for the agency's own confirmed
    /// address and for anything at our own inbound domain: one click of "Write
    /// email" there would post the offer into our own queue as a new document,
    /// scanned, parsed and paid for.
    #[serde(default)]
    pub offer_email: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CandidateIntakeSubmit {
    pub alias: Option<String>,
    pub source_id: Option<String>,
    pub event_id: String,
    pub content_type: String,
    pub content_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateSubmitResult {
    pub created: bool,
    pub receipt: CandidateIntakeReceipt,
}

// ---------------- C3b-2: facts, stored comparisons, shortlist decisions ----------------

const FACT_MAX_FIELD_CHARS: usize = 120;
const FACT_MAX_VALUE_CHARS: usize = 4096;
const FACT_MAX_SOURCE_OBJECT_CHARS: usize = 120;
const FACT_MAX_SPAN_CHARS: usize = 64;
const PROFILE_ID_MAX_CHARS: usize = 36;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateFact {
    pub field: String,
    pub value: String,
    pub version: i64,
    pub source_object: String,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub span: Option<String>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub uncertainty: Option<String>,
    #[serde(default)]
    pub corrected_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateFactVersions {
    pub field: String,
    pub versions: Vec<CandidateFact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateFactListResponse {
    pub items: Vec<CandidateFactVersions>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CandidateFactSubmit {
    pub field: String,
    pub value: String,
    pub source_object: String,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub span: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateRankResponse {
    pub ranked: i64,
    #[serde(default)]
    pub written: i64,
    /// No.622/No.637-S6: how many of the `ranked` profiles got NO evaluation
    /// because the rank does not apply. Undeclared, the pair "3/1" read as two
    /// silent failures — the attempt line could not say what it skipped.
    /// Validated on the wire by `response_model=CandidateRankResponse`
    /// (`routers/candidate_intake.py:1022`).
    #[serde(default)]
    pub withheld: i64,
    pub reason: String,
    #[serde(default)]
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateRankReason {
    pub requirement: String,
    pub outcome: String,
    #[serde(default)]
    pub wanted: Option<Value>,
    #[serde(default)]
    pub found: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateProfileRank {
    pub profile_id: String,
    pub profile_version: i64,
    pub primary: bool,
    pub met: Vec<String>,
    pub missing: Vec<String>,
    pub unconfirmed: Vec<String>,
    pub reasons: Vec<CandidateRankReason>,
    pub decided: bool,
    pub stale: bool,
    #[serde(default)]
    pub stale_reason: Option<String>,
    /// No.622/No.637-S6: the FRESH applicability verdict, computed at the read
    /// and stored nowhere. One of `crewing_rank.VERDICTS`.
    ///
    /// It is NOT an entry of `reasons` — an extra outcome there would move the
    /// card's `total` and make every ordinary percentage read as "оценка
    /// распознана не полностью" — and it is NOT derivable on this side: the
    /// server owns the rule.
    ///
    /// `Option` with `#[serde(default)]`, for the reason written in full on
    /// `CandidateProfileRankSummary::applicability`: the server declares it
    /// required, but a build from before No.622 does not send it, and a
    /// required field here would fail the parse of the whole rank list and
    /// empty the card of every evaluation it used to show.
    #[serde(default)]
    pub applicability: Option<String>,
    /// Only beside an `unknown`, one of `crewing_rank.REASONS`.
    #[serde(default)]
    pub applicability_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct UnrankedProfile {
    pub profile_id: String,
    pub name: String,
}

/// No.622/No.637-S6: an ACTIVE profile deliberately NOT evaluated, and why.
///
/// A sibling of `UnrankedProfile` and deliberately not the same type: that one
/// is a GAP somebody can still close, this one is a profile the rank will never
/// apply to. A count alone could not go on a screen honestly — "2 hidden, the
/// rank does not apply" and "2 hidden, nobody could read his rank" are
/// different sentences and different next actions — so the disclosure carries
/// the NAME of each profile, which is what `cardWithheldHtml` renders.
///
/// Mirrors `schemas.WithheldProfilePublic`. `applicability` is `Option` here
/// too, although the server declares it required: this list only exists on a
/// No.622 server, so the absence would be a server defect — but answering a
/// server defect by failing the parse of the whole rank list costs the operator
/// the card, and the renderer already degrades an absent verdict to "nothing
/// stated".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct WithheldProfile {
    pub profile_id: String,
    pub name: String,
    #[serde(default)]
    pub applicability: Option<String>,
    #[serde(default)]
    pub applicability_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ShortlistConfirmation {
    pub profile_id: String,
    pub profile_version: i64,
    pub confirmed_by: String,
    pub confirmed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ShortlistHistory {
    pub id: String,
    pub profile_id: String,
    pub profile_version: i64,
    pub confirmed_by: String,
    pub confirmed_at: String,
    #[serde(default)]
    pub withdrawn_by: Option<String>,
    #[serde(default)]
    pub withdrawn_at: Option<String>,
}

/// No.632: ONE shortlist decision carrying its THIRD state.
///
/// `on_hold` is not derived from `held_at.is_some()` on this side: the server
/// computes it from the live row and the two can only disagree if one of them
/// is wrong, so the client reads the answer rather than recomputing it.
///
/// Every field is declared. That sentence is the whole point of this struct and
/// it is written again because No.623 paid for it twice: `serde` DROPS a key no
/// field declares, silently and without failing the parse — the webview would
/// then render exactly what it renders today and every renderer test would stay
/// green over the hole.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ShortlistHold {
    pub id: String,
    pub intake_id: String,
    pub profile_id: String,
    pub profile_version: i64,
    pub confirmed_by: String,
    pub confirmed_at: String,
    pub on_hold: bool,
    #[serde(default)]
    pub held_by: Option<String>,
    #[serde(default)]
    pub held_at: Option<String>,
    #[serde(default)]
    pub withdrawn_by: Option<String>,
    #[serde(default)]
    pub withdrawn_at: Option<String>,
}

/// No.632: one shortlisted candidate as the PROFILE's own list shows him.
///
/// It carries `intake_id` and NOT the person: the reverse list is a list of
/// DECISIONS, and who those decisions are about is read from the candidate
/// surface that already owns that data. A name on this row would be a second
/// place where a candidate's identity lives.
///
/// `in_selection` and `needs_recompare` are both computed by the server and
/// both arrive here rather than being re-derived: `in_selection` is the single
/// predicate that decides who goes to the customer, and a second copy of that
/// rule on the screen is how a screen comes to say three while an envelope
/// carries four.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ProfileShortlistItem {
    pub id: String,
    pub intake_id: String,
    /// The version the DECISION was taken against — not the profile's current
    /// one. Every move of this decision must quote this number back.
    pub profile_version: i64,
    pub confirmed_by: String,
    pub confirmed_at: String,
    pub on_hold: bool,
    #[serde(default)]
    pub held_by: Option<String>,
    #[serde(default)]
    pub held_at: Option<String>,
    pub in_selection: bool,
    pub needs_recompare: bool,
}

/// Three numbers from one read, and the server's own invariant between them:
/// `selected == in_selection + on_hold`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ProfileShortlistCounts {
    pub selected: i64,
    pub in_selection: i64,
    pub on_hold: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ProfileShortlistResponse {
    pub profile_id: String,
    /// The version the profile is on NOW, beside the version each decision was
    /// taken against, so the screen can say "decided on v1, the vacancy is v3".
    pub profile_version: i64,
    pub profile_state: String,
    pub items: Vec<ProfileShortlistItem>,
    pub counts: ProfileShortlistCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CandidateRanksResponse {
    pub items: Vec<CandidateProfileRank>,
    #[serde(default)]
    pub unranked_active_profiles: Vec<UnrankedProfile>,
    /// No.622/No.637-S6: the THIRD half of this body, and the one the bridge
    /// used to drop on the floor. Without it the card cannot tell "compared
    /// against everything" from "compared against what applies", and the
    /// sentence it prints today — «сравниваются все активные профили» — is
    /// simply false. `#[serde(default)]`, like its two neighbours: an older
    /// server withholds nothing it can name, which is an empty disclosure.
    #[serde(default)]
    pub withheld_profiles: Vec<WithheldProfile>,
    #[serde(default)]
    pub confirmations: Vec<ShortlistHistory>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ShortlistPair {
    pub profile_id: String,
    pub profile_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct MatchingProfileMetadata {
    pub id: String,
    pub crewing_id: String,
    pub name: String,
    pub version: i64,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct MatchingProfileListResponse {
    pub items: Vec<MatchingProfileMetadata>,
}

/// What the publication route hands back (P2/S1).
///
/// A separate type from `MatchingProfileMetadata` on purpose: that one is the
/// thin row the candidate card needs in order to name a profile, and widening
/// it would put the frozen snapshot into every rank read. Unknown fields are
/// ignored by serde, so the server may carry more than this without breaking
/// the client.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct MatchingProfilePublication {
    pub id: String,
    pub crewing_id: String,
    pub name: String,
    #[serde(default)]
    pub rank: Option<String>,
    #[serde(default)]
    pub vessel_type: Option<String>,
    pub version: i64,
    pub state: String,
    pub publication_state: String,
    #[serde(default)]
    pub published_snapshot: Option<Value>,
}

fn snapshot_context(
    live: &LiveConnection,
    expected: &PilotExpectedContext,
) -> Result<PilotContext, PilotBridgeError> {
    if live.server_url.is_empty() || live.bearer_token.is_empty() || live.workspace_id.is_empty() {
        return Err(PilotBridgeError::invalid_context("pilot_not_configured"));
    }
    if live.server_url != expected.server_url.trim()
        || live.context() != expected.connection_context
        || live.workspace_id != expected.crewing_id.trim()
    {
        return Err(PilotBridgeError::invalid_context("settings_changed"));
    }
    Ok(PilotContext {
        server_url: live.server_url.clone(),
        bearer_token: live.bearer_token.clone(),
        crewing_id: live.workspace_id.clone(),
    })
}

/// The live workspace connection of the signed-in account, checked against what
/// the screen expects. A refused sign-in keeps its word in `detail`
/// (`login_required`, `trial_expired`, `no_workspace`, `not_crewing`, …).
async fn context_from_state(
    state: &tauri::State<'_, AppState>,
    expected: &PilotExpectedContext,
) -> Result<PilotContext, PilotBridgeError> {
    let live = crewing::live_connection(state).await.map_err(|e| {
        if e.code == "network" {
            PilotBridgeError::new("network")
        } else {
            PilotBridgeError::invalid_context(e.code)
        }
    })?;
    snapshot_context(&live, expected)
}

fn client() -> Result<Client, PilotBridgeError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(Policy::none())
        .build()
        .map_err(|_| PilotBridgeError::new("client_unavailable"))
}

fn base_url(context: &PilotContext) -> Result<Url, PilotBridgeError> {
    let mut url = Url::parse(context.server_url.trim())
        .map_err(|_| PilotBridgeError::invalid_context("invalid_server_url"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(PilotBridgeError::invalid_context("invalid_server_url"));
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn fixed_url(context: &PilotContext, segments: &[&str]) -> Result<Url, PilotBridgeError> {
    let mut url = base_url(context)?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| PilotBridgeError::invalid_context("invalid_server_url"))?;
        path.pop_if_empty();
        path.extend(["api", "crewings", context.crewing_id.as_str()]);
        path.extend(segments.iter().copied());
    }
    Ok(url)
}

fn safe_detail(value: &Value) -> Option<String> {
    let detail = value.get("detail")?.as_str()?;
    const SAFE: &[&str] = &[
        "Not Found",
        "not authorised for this crewing",
        "token does not belong to this crewing",
        "intake alias not found",
        "candidate intake not found",
        "body must be a JSON object",
        "request body exceeds the configured ceiling",
        "raw object exceeds the configured ceiling",
        "content_base64 is not valid base64",
        "content_base64 decodes to no bytes",
        "either alias or source_id is required",
        "alias and source_id are mutually exclusive",
        "event already accepted with different content",
        "matching profile not found",
        "limit_above_ceiling",
        "limit_not_a_number",
        "intake is not in a state this build can serve",
        "token missing",
        "token invalid",
        "token revoked",
        "token inactive",
        "token expired",
        "token scope denied",
        "crewing not found",
        // C3b-2 domain codes (contract §5): facts
        "fact_no_source_object",
        "fact_no_uncertainty",
        "fact_no_actor",
        "fact_unknown_key",
        "fact_shape",
        // C3b-2 domain codes (contract §5): shortlist
        "rank_not_found",
        "profile_not_active",
        "profile_version_stale",
        "already_confirmed",
        "confirmation_no_actor",
        "not_confirmed",
        "already_withdrawn",
        "withdraw_not_permitted",
        // No.632 domain codes: the third state. `hold_not_permitted` carries a
        // word of its own while standing behind the WITHDRAWAL's own check —
        // a colleague refused the undo who could set the candidate aside
        // instead would reach the identical outcome through an unguarded door.
        "already_on_hold",
        "not_on_hold",
        "hold_not_permitted",
        // P2/S1 publication. Two refusals that share a 422 and differ only by
        // their words, so the card can tell the operator WHICH field is
        // missing instead of "something is wrong".
        "publication needs a rank on the profile",
        "publication needs a vessel type on the profile",
    ];
    SAFE.contains(&detail).then(|| detail.to_string())
}

fn perform(
    context: &PilotContext,
    method: Method,
    url: Url,
    body: Option<Value>,
    ambiguous_on_network: bool,
) -> Result<(StatusCode, Vec<u8>), PilotBridgeError> {
    let client = client()?;
    let mut request: RequestBuilder = client
        .request(method, url)
        .bearer_auth(&context.bearer_token)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().map_err(|_| {
        let mut err = PilotBridgeError::new("network");
        err.ambiguous = ambiguous_on_network;
        err
    })?;
    let status = response.status();
    let bytes = response.bytes().map(|body| body.to_vec()).map_err(|_| {
        let mut err = PilotBridgeError::new("network");
        err.ambiguous = ambiguous_on_network;
        err
    })?;
    if !status.is_success() {
        let parsed = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        let mut err = PilotBridgeError::new(if status.is_redirection() {
            "redirect_refused"
        } else {
            "server"
        });
        err.status = Some(status.as_u16());
        err.detail = safe_detail(&parsed);
        return Err(err);
    }
    Ok((status, bytes))
}

fn send<T: DeserializeOwned>(
    context: &PilotContext,
    method: Method,
    url: Url,
    body: Option<Value>,
    ambiguous_on_network: bool,
) -> Result<(StatusCode, T), PilotBridgeError> {
    let (status, bytes) = perform(context, method, url, body, ambiguous_on_network)?;
    serde_json::from_slice(&bytes)
        .map(|value| (status, value))
        .map_err(|_| {
            let mut err = PilotBridgeError::new("malformed_response");
            err.status = Some(status.as_u16());
            err.ambiguous = ambiguous_on_network;
            err
        })
}

/// Typed no-content write (C3b-2). The ONLY success is an exact `204` with an
/// empty body: that is the documented shape of shortlist withdraw. Any other
/// successful status, or a 204 that carries bytes, is not the documented
/// acknowledgement and stays ambiguous (`unexpected_success`) so the screen
/// keeps the outcome UNKNOWN instead of inventing a success. Refusals and
/// network failures follow the same policy as `send`.
fn send_no_content(
    context: &PilotContext,
    method: Method,
    url: Url,
) -> Result<(), PilotBridgeError> {
    let (status, bytes) = perform(context, method, url, None, true)?;
    if status == StatusCode::NO_CONTENT && bytes.is_empty() {
        return Ok(());
    }
    let mut err = PilotBridgeError::new("unexpected_success");
    err.status = Some(status.as_u16());
    err.ambiguous = true;
    Err(err)
}

fn alias_url(context: &PilotContext, tail: &[&str]) -> Result<Url, PilotBridgeError> {
    let mut segments = vec!["intake-aliases"];
    segments.extend_from_slice(tail);
    fixed_url(context, &segments)
}

fn candidate_url(context: &PilotContext) -> Result<Url, PilotBridgeError> {
    fixed_url(context, &["candidate-intake"])
}

fn alias_transition(
    context: &PilotContext,
    alias_id: &str,
    action: &str,
) -> Result<IntakeAliasPublic, PilotBridgeError> {
    if alias_id.trim().is_empty() {
        return Err(PilotBridgeError::invalid_context("alias_id_required"));
    }
    let url = alias_url(context, &[alias_id.trim(), action])?;
    let (_, response) = send(context, Method::POST, url, Some(json!({})), true)?;
    Ok(response)
}

async fn without_blocking_ui<T, F>(operation: F) -> Result<T, PilotBridgeError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, PilotBridgeError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| PilotBridgeError::new("request_task_failed"))?
}

#[tauri::command]
pub(crate) async fn crewing_intake_alias_list(
    expected_context: PilotExpectedContext,
    state: tauri::State<'_, AppState>,
) -> Result<IntakeAliasListResponse, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let (_, response) = send(
            &context,
            Method::GET,
            alias_url(&context, &[])?,
            None,
            false,
        )?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_alias_create(
    expected_context: PilotExpectedContext,
    label: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<IntakeAliasIssued, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let label = label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    without_blocking_ui(move || {
        let (_, response) = send(
            &context,
            Method::POST,
            alias_url(&context, &[])?,
            Some(json!({ "label": label })),
            true,
        )?;
        Ok(response)
    })
    .await
}

// No.720 unit C: reveal is a READ of a value the server composes, under the same
// team-admin check as the other alias writes. The handle writes an audit row per call,
// which is why the client calls it once per session and not per render.
#[tauri::command]
pub(crate) async fn crewing_intake_alias_reveal(
    expected_context: PilotExpectedContext,
    alias_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<IntakeAliasRevealed, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    if alias_id.trim().is_empty() {
        return Err(PilotBridgeError::invalid_context("alias_id_required"));
    }
    without_blocking_ui(move || {
        let url = alias_url(&context, &[alias_id.trim(), "reveal"])?;
        let (_, response) = send(&context, Method::POST, url, Some(json!({})), true)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_alias_rotate(
    expected_context: PilotExpectedContext,
    alias_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<IntakeAliasIssued, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    if alias_id.trim().is_empty() {
        return Err(PilotBridgeError::invalid_context("alias_id_required"));
    }
    without_blocking_ui(move || {
        let url = alias_url(&context, &[alias_id.trim(), "rotate"])?;
        let (_, response) = send(&context, Method::POST, url, Some(json!({})), true)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_alias_pause(
    expected_context: PilotExpectedContext,
    alias_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<IntakeAliasPublic, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || alias_transition(&context, &alias_id, "pause")).await
}

#[tauri::command]
pub(crate) async fn crewing_intake_alias_resume(
    expected_context: PilotExpectedContext,
    alias_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<IntakeAliasPublic, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || alias_transition(&context, &alias_id, "resume")).await
}

#[tauri::command]
pub(crate) async fn crewing_intake_alias_revoke(
    expected_context: PilotExpectedContext,
    alias_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<IntakeAliasPublic, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || alias_transition(&context, &alias_id, "revoke")).await
}

#[tauri::command]
pub(crate) async fn crewing_intake_candidate_submit(
    expected_context: PilotExpectedContext,
    request: CandidateIntakeSubmit,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateSubmitResult, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let alias = request
        .alias
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let source_id = request
        .source_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if alias.is_some() == source_id.is_some()
        || request.event_id.trim().is_empty()
        || request.content_type.trim().is_empty()
        || request.content_base64.is_empty()
    {
        return Err(PilotBridgeError::invalid_context("invalid_upload_shape"));
    }
    let decoded = BASE64_STANDARD
        .decode(request.content_base64.as_bytes())
        .map_err(|_| PilotBridgeError::invalid_context("invalid_upload_shape"))?;
    if decoded.is_empty() || decoded.len() > PILOT_MAX_FILE_BYTES {
        return Err(PilotBridgeError::invalid_context("invalid_upload_shape"));
    }
    without_blocking_ui(move || {
        let body = json!({
            "alias": alias,
            "source_id": source_id,
            "event_id": request.event_id,
            "content_type": request.content_type,
            "content_base64": request.content_base64,
        });
        let (status, receipt) = send(
            &context,
            Method::POST,
            candidate_url(&context)?,
            Some(body),
            true,
        )?;
        Ok(CandidateSubmitResult {
            created: status == StatusCode::CREATED,
            receipt,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_candidate_list(
    expected_context: PilotExpectedContext,
    limit: u32,
    offset: u32,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateIntakeListResponse, PilotBridgeError> {
    if limit == 0 || limit > 200 {
        return Err(PilotBridgeError::invalid_context("limit_above_ceiling"));
    }
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let mut url = candidate_url(&context)?;
        url.query_pairs_mut()
            .append_pair("limit", &limit.to_string())
            .append_pair("offset", &offset.to_string());
        let (_, response) = send(&context, Method::GET, url, None, false)?;
        Ok(response)
    })
    .await
}

// ---------------- C3b-2 typed operations (nine fixed commands) ----------------

fn intake_url(
    context: &PilotContext,
    intake_id: &str,
    tail: &[&str],
) -> Result<Url, PilotBridgeError> {
    let intake_id = intake_id.trim();
    if intake_id.is_empty() {
        return Err(PilotBridgeError::invalid_context("intake_id_required"));
    }
    let mut segments = vec!["candidate-intake", intake_id];
    segments.extend_from_slice(tail);
    fixed_url(context, &segments)
}

fn invalid_request(detail: &str) -> PilotBridgeError {
    let mut err = PilotBridgeError::new("invalid_request");
    err.detail = Some(detail.to_string());
    err
}

fn checked_fact(fact: CandidateFactSubmit) -> Result<Value, PilotBridgeError> {
    let field = fact.field.trim().to_string();
    if field.is_empty()
        || field.chars().count() > FACT_MAX_FIELD_CHARS
        || field
            .chars()
            .any(|c| matches!(c, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(invalid_request("invalid_fact_field"));
    }
    if fact.value.chars().count() > FACT_MAX_VALUE_CHARS || fact.value.contains('\0') {
        return Err(invalid_request("invalid_fact_value"));
    }
    let source_object = fact.source_object.trim().to_string();
    if source_object.is_empty() || source_object.chars().count() > FACT_MAX_SOURCE_OBJECT_CHARS {
        return Err(invalid_request("invalid_fact_source_object"));
    }
    if matches!(fact.page, Some(page) if page < 0) {
        return Err(invalid_request("invalid_fact_page"));
    }
    if matches!(&fact.span, Some(span) if span.chars().count() > FACT_MAX_SPAN_CHARS) {
        return Err(invalid_request("invalid_fact_span"));
    }
    // No confidence / uncertainty / actor: the operator route sets them itself.
    Ok(json!({
        "field": field,
        "value": fact.value,
        "source_object": source_object,
        "page": fact.page,
        "span": fact.span,
    }))
}

fn checked_pair(pair: &ShortlistPair) -> Result<(String, String), PilotBridgeError> {
    let profile_id = pair.profile_id.trim().to_string();
    if profile_id.is_empty() || profile_id.chars().count() > PROFILE_ID_MAX_CHARS {
        return Err(invalid_request("invalid_profile_id"));
    }
    if pair.profile_version < 1 {
        return Err(invalid_request("invalid_profile_version"));
    }
    Ok((profile_id, pair.profile_version.to_string()))
}

#[tauri::command]
pub(crate) async fn crewing_intake_candidate_get(
    expected_context: PilotExpectedContext,
    intake_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateIntakeReceipt, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let url = intake_url(&context, &intake_id, &[])?;
        let (_, response) = send(&context, Method::GET, url, None, false)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_fact_list(
    expected_context: PilotExpectedContext,
    intake_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateFactListResponse, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let url = intake_url(&context, &intake_id, &["facts"])?;
        let (_, response) = send(&context, Method::GET, url, None, false)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_fact_record(
    expected_context: PilotExpectedContext,
    intake_id: String,
    fact: CandidateFactSubmit,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateFact, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let body = checked_fact(fact)?;
    without_blocking_ui(move || {
        let url = intake_url(&context, &intake_id, &["facts"])?;
        let (_, response) = send(&context, Method::POST, url, Some(body), true)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_fact_correct(
    expected_context: PilotExpectedContext,
    intake_id: String,
    field: String,
    fact: CandidateFactSubmit,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateFact, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let field = field.trim().to_string();
    if field.is_empty() || field != fact.field.trim() {
        return Err(invalid_request("correction_field_mismatch"));
    }
    let body = checked_fact(fact)?;
    without_blocking_ui(move || {
        let url = intake_url(&context, &intake_id, &["facts", field.as_str(), "correct"])?;
        let (_, response) = send(&context, Method::POST, url, Some(body), true)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_candidate_rank(
    expected_context: PilotExpectedContext,
    intake_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateRankResponse, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let url = intake_url(&context, &intake_id, &["rank"])?;
        let (_, response) = send(&context, Method::POST, url, Some(json!({})), true)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_rank_list(
    expected_context: PilotExpectedContext,
    intake_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateRanksResponse, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let url = intake_url(&context, &intake_id, &["ranks"])?;
        let (_, response) = send(&context, Method::GET, url, None, false)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_response_contact(
    expected_context: PilotExpectedContext,
    intake_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateResponseContact, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let url = intake_url(&context, &intake_id, &["response-contact"])?;
        // `ambiguous_on_network: false` - a GET that failed changed nothing, so
        // the screen may say plainly that it could not read the contact instead of
        // holding the outcome UNKNOWN. What it may NOT do is call that an absence,
        // and that is the screen's half (N14).
        let (_, response) = send(&context, Method::GET, url, None, false)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_shortlist_confirm(
    expected_context: PilotExpectedContext,
    intake_id: String,
    pair: ShortlistPair,
    state: tauri::State<'_, AppState>,
) -> Result<ShortlistConfirmation, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let (profile_id, _version) = checked_pair(&pair)?;
    let body = json!({ "profile_id": profile_id, "profile_version": pair.profile_version });
    without_blocking_ui(move || {
        let url = intake_url(&context, &intake_id, &["shortlist"])?;
        let (_, response) = send(&context, Method::POST, url, Some(body), true)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_shortlist_withdraw(
    expected_context: PilotExpectedContext,
    intake_id: String,
    pair: ShortlistPair,
    state: tauri::State<'_, AppState>,
) -> Result<(), PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let (profile_id, version) = checked_pair(&pair)?;
    without_blocking_ui(move || {
        let url = intake_url(
            &context,
            &intake_id,
            &["shortlist", profile_id.as_str(), version.as_str()],
        )?;
        send_no_content(&context, Method::DELETE, url)
    })
    .await
}

/// No.632: set this candidate aside WITHOUT taking the decision back.
///
/// He stays in the profile, he can be brought back, and he is out of the
/// selection that goes to the customer by default. The server owns all three of
/// those sentences; this is a typed pipe to them.
///
/// `ambiguous_on_network = true`, like every other write in this file: a request
/// that died on the wire may or may not have been applied, and the screen has to
/// say UNKNOWN rather than pick an answer for the operator.
#[tauri::command]
pub(crate) async fn crewing_intake_shortlist_hold(
    expected_context: PilotExpectedContext,
    intake_id: String,
    pair: ShortlistPair,
    state: tauri::State<'_, AppState>,
) -> Result<ShortlistHold, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let (profile_id, version) = checked_pair(&pair)?;
    without_blocking_ui(move || {
        let url = intake_url(
            &context,
            &intake_id,
            &["shortlist", profile_id.as_str(), version.as_str(), "hold"],
        )?;
        let (_, response) = send(&context, Method::POST, url, None, true)?;
        Ok(response)
    })
    .await
}

/// No.632: bring a candidate who was set aside back into the selection.
///
/// A 204 with an empty body is the ONLY success, through `send_no_content` — the
/// same policy the withdrawal already follows, and for the same reason: an
/// undocumented 200 is not an acknowledgement and must leave the outcome
/// UNKNOWN rather than be reported as a release that may not have happened.
#[tauri::command]
pub(crate) async fn crewing_intake_shortlist_release(
    expected_context: PilotExpectedContext,
    intake_id: String,
    pair: ShortlistPair,
    state: tauri::State<'_, AppState>,
) -> Result<(), PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let (profile_id, version) = checked_pair(&pair)?;
    without_blocking_ui(move || {
        let url = intake_url(
            &context,
            &intake_id,
            &["shortlist", profile_id.as_str(), version.as_str(), "hold"],
        )?;
        send_no_content(&context, Method::DELETE, url)
    })
    .await
}

/// No.632: who is shortlisted FOR THIS PROFILE — the list read from the other
/// end.
///
/// The first read of this subsystem that does not start from a candidate, so it
/// is the first whose isolation does not rest on a candidate predicate. The
/// server says so in its own docstring and carries the tenant on both tables;
/// nothing on this side may compensate for that and nothing here tries to.
///
/// `ambiguous_on_network = false`: a GET that failed changed nothing, so the
/// screen may say plainly that it could not read the list. What it may NOT do is
/// call that an empty shortlist — and that half belongs to the screen.
#[tauri::command]
pub(crate) async fn crewing_intake_profile_shortlist(
    expected_context: PilotExpectedContext,
    profile_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProfileShortlistResponse, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let profile_id = profile_id.trim().to_string();
    if profile_id.is_empty() || profile_id.chars().count() > PROFILE_ID_MAX_CHARS {
        return Err(invalid_request("invalid_profile_id"));
    }
    without_blocking_ui(move || {
        let url = fixed_url(
            &context,
            &["matching-profiles", profile_id.as_str(), "shortlist"],
        )?;
        let (_, response) = send(&context, Method::GET, url, None, false)?;
        Ok(response)
    })
    .await
}

#[tauri::command]
pub(crate) async fn crewing_intake_matching_profile_list(
    expected_context: PilotExpectedContext,
    state: tauri::State<'_, AppState>,
) -> Result<MatchingProfileListResponse, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let mut url = fixed_url(&context, &["matching-profiles"])?;
        url.query_pairs_mut()
            .append_pair("include_archived", "true");
        let (_, response) = send(&context, Method::GET, url, None, false)?;
        Ok(response)
    })
    .await
}

/// P2/S1: publish the profile, or take it off publication. ONE button.
///
/// `published` is the whole payload: the server owns the two words and the
/// frozen snapshot, and a client that posted a state string would be a second
/// place where the vocabulary lives.
///
/// `ambiguous_on_network = true` for the same reason every other write here
/// sets it: a request that died on the wire may or may not have been applied,
/// and the card has to say UNKNOWN rather than pick an answer.
#[tauri::command]
pub(crate) async fn crewing_intake_matching_profile_publication(
    expected_context: PilotExpectedContext,
    profile_id: String,
    published: bool,
    state: tauri::State<'_, AppState>,
) -> Result<MatchingProfilePublication, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    let profile_id = profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Err(invalid_request("profile_id_missing"));
    }
    let body = json!({ "published": published });
    without_blocking_ui(move || {
        let url = fixed_url(
            &context,
            &["matching-profiles", profile_id.as_str(), "publication"],
        )?;
        let (_, response) = send(&context, Method::POST, url, Some(body), true)?;
        Ok(response)
    })
    .await
}

// ---------------- K2.1 audited byte routes (OWNER (739) п.2) ----------------
// The original letter and its attachments are reachable FROM THE CARD. They are
// never part of the card read: one press, one audited request on the server, one
// copy written under Downloads/Skipi/Crewing/<intake8>/. The copies have no
// retention and no auto-cleanup, and an .eml carries personal data of people
// other than the candidate (RISKS №491) — that is said to the owner, not hidden.

/// Hard ceiling regardless of what the card claims; 32 MiB is far above any CV
/// and far below anything that could exhaust the machine.
const DOWNLOAD_CEILING_BYTES: u64 = 32 * 1024 * 1024;
/// Only the header part of an .eml is ever handed to the screen.
const LETTER_HEAD_MAX_BYTES: usize = 32 * 1024;

fn saved_root() -> Result<std::path::PathBuf, PilotBridgeError> {
    let base = dirs::download_dir().ok_or_else(|| invalid_request("no_downloads_dir"))?;
    Ok(base.join("Skipi").join("Crewing"))
}

/// The server chooses the filename; the client still treats it as hostile input.
/// Path separators, `..`, control characters and non-ASCII become `_`, so a
/// `Content-Disposition` can never write outside the intake folder.
fn safe_download_name(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        let ok = ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-');
        out.push(if ok { ch } else { '_' });
    }
    let trimmed = out.trim_matches('_').trim_matches('.').to_string();
    if trimmed.is_empty() || trimmed.contains("..") || trimmed.len() > 120 {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn filename_from_disposition(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let at = lower.find("filename=")?;
    let tail = value[at + "filename=".len()..].trim();
    let name = if let Some(stripped) = tail.strip_prefix('"') {
        stripped.split('"').next().unwrap_or("")
    } else {
        tail.split(';').next().unwrap_or("").trim()
    };
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Byte fetch for the two audited routes. A sibling of `perform`, not a reuse of
/// it: the JSON path insists on `Accept: application/json` and throws the
/// response headers away, while here the server-chosen filename lives in
/// `Content-Disposition` and the body is not JSON at all.
fn fetch_bytes(
    context: &PilotContext,
    url: Url,
    ceiling: u64,
) -> Result<(Vec<u8>, Option<String>), PilotBridgeError> {
    let client = client()?;
    let response = client
        .request(Method::GET, url)
        .bearer_auth(&context.bearer_token)
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .map_err(|_| PilotBridgeError::new("network"))?;
    let status = response.status();
    let disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    if !status.is_success() {
        let mut err = PilotBridgeError::new(if status.is_redirection() {
            "redirect_refused"
        } else {
            "server"
        });
        err.status = Some(status.as_u16());
        return Err(err);
    }
    let bytes = response
        .bytes()
        .map_err(|_| PilotBridgeError::new("network"))?
        .to_vec();
    if bytes.len() as u64 > ceiling {
        return Err(invalid_request("payload_above_ceiling"));
    }
    Ok((
        bytes,
        disposition.as_deref().and_then(filename_from_disposition),
    ))
}

/// The card's own `content_bytes` may lower the ceiling, never raise it.
fn download_ceiling(expected_bytes: Option<u64>) -> u64 {
    match expected_bytes {
        Some(bytes) if bytes > 0 => bytes.min(DOWNLOAD_CEILING_BYTES),
        _ => DOWNLOAD_CEILING_BYTES,
    }
}

fn write_saved_copy(
    intake_id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<CandidateIntakeDownload, PilotBridgeError> {
    use sha2::{Digest, Sha256};
    let folder = saved_root()?.join(safe_download_name(
        intake_id.get(..8).unwrap_or(intake_id),
        "intake",
    ));
    std::fs::create_dir_all(&folder).map_err(|_| invalid_request("cannot_create_folder"))?;
    let target = folder.join(name);
    std::fs::write(&target, bytes).map_err(|_| invalid_request("cannot_write_file"))?;
    let digest = Sha256::digest(bytes);
    Ok(CandidateIntakeDownload {
        path: target.to_string_lossy().to_string(),
        bytes: bytes.len() as u64,
        sha256: digest.iter().map(|b| format!("{:02x}", b)).collect(),
        head_text: None,
    })
}

/// The header part of an .eml: everything before the first empty line, capped at
/// 32 KB. A header-looking line in the BODY is therefore never read as a header.
fn letter_head_text(bytes: &[u8]) -> String {
    let window = &bytes[..bytes.len().min(LETTER_HEAD_MAX_BYTES)];
    let mut cut = window.len();
    for index in 0..window.len() {
        if window[index..].starts_with(b"\r\n\r\n") || window[index..].starts_with(b"\n\n") {
            cut = index;
            break;
        }
    }
    String::from_utf8_lossy(&window[..cut]).to_string()
}

/// Both sides are canonicalized, so a symlink pointing out of the folder resolves
/// to its target and is refused. A path that does not exist is an error, never a
/// silently created file (the sqlite-on-prod lesson, 2026-09-18).
fn resolved_saved_path(
    root: &std::path::Path,
    input: &str,
) -> Result<std::path::PathBuf, PilotBridgeError> {
    if input.trim().is_empty() {
        return Err(invalid_request("path_required"));
    }
    let root = std::fs::canonicalize(root).map_err(|_| invalid_request("downloads_root_missing"))?;
    let candidate = std::fs::canonicalize(std::path::Path::new(input))
        .map_err(|_| invalid_request("path_not_found"))?;
    if candidate == root || !candidate.starts_with(&root) {
        return Err(invalid_request("path_outside_downloads"));
    }
    if !candidate.is_file() {
        return Err(invalid_request("path_not_a_file"));
    }
    Ok(candidate)
}

#[tauri::command]
pub(crate) async fn crewing_intake_object_download(
    expected_context: PilotExpectedContext,
    intake_id: String,
    object_id: String,
    expected_bytes: Option<u64>,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateIntakeDownload, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        let object = object_id.trim();
        if object.is_empty() {
            return Err(invalid_request("object_id_required"));
        }
        let url = intake_url(&context, &intake_id, &["objects", object])?;
        let (bytes, disposition) = fetch_bytes(&context, url, download_ceiling(expected_bytes))?;
        let name = safe_download_name(
            disposition.as_deref().unwrap_or("letter.eml"),
            "letter.eml",
        );
        let mut saved = write_saved_copy(&intake_id, &name, &bytes)?;
        saved.head_text = Some(letter_head_text(&bytes));
        Ok(saved)
    })
    .await
}

/// The attachment ordinal as the server counts it: FROM ZERO. Server
/// `_ordinal_or_404`: "the floor is 0, not 1 - attachments are counted from
/// zero"; `docs/crewing-baseline/c3a-api-contract.md` §attachments (rows
/// "ordered by `ordinal`", the receipt of a one-attachment letter carries
/// `ordinal: 0`). The bound is a pure function so a unit test can hold it
/// against that contract without a Tauri runtime: K2.1 shipped with a floor
/// of 1, and the first — often the only — attachment of every letter was
/// refused as `ordinal_out_of_range` while `GET /attachments/0` answered 200
/// with the bytes (BACKLOG №504, 2026-09-27).
fn checked_attachment_ordinal(ordinal: i64) -> Result<i64, PilotBridgeError> {
    if ordinal < 0 || ordinal > 9999 {
        return Err(invalid_request("ordinal_out_of_range"));
    }
    Ok(ordinal)
}

/// The whole attachment download as ONE sync function, so a unit test can drive
/// it against a real request line (`TcpListener`) without a Tauri runtime — the
/// same separation as `open_saved_with`. Before №504-b the body lived inside the
/// command's closure, and the only oracles were the pure bound above plus a regex
/// over the source: a `+ 1` slipped in after the check, or the old `< 1` guard
/// put back after the checked call, survived both (skipi-ops BACKLOG №504-b,
/// 2026-09-27). The command below is a pass-through and adds nothing of its own.
fn download_attachment(
    context: &PilotContext,
    intake_id: &str,
    ordinal: i64,
    expected_bytes: Option<u64>,
) -> Result<CandidateIntakeDownload, PilotBridgeError> {
    let ordinal = checked_attachment_ordinal(ordinal)?;
    let url = intake_url(context, intake_id, &["attachments", &ordinal.to_string()])?;
    let (bytes, disposition) = fetch_bytes(context, url, download_ceiling(expected_bytes))?;
    let fallback = format!("attachment-{}.bin", ordinal);
    let name = safe_download_name(disposition.as_deref().unwrap_or(&fallback), &fallback);
    write_saved_copy(intake_id, &name, &bytes)
}

#[tauri::command]
pub(crate) async fn crewing_intake_attachment_download(
    expected_context: PilotExpectedContext,
    intake_id: String,
    ordinal: i64,
    expected_bytes: Option<u64>,
    state: tauri::State<'_, AppState>,
) -> Result<CandidateIntakeDownload, PilotBridgeError> {
    let context = context_from_state(&state, &expected_context).await?;
    without_blocking_ui(move || {
        download_attachment(&context, &intake_id, ordinal, expected_bytes)
    })
    .await
}

/// The guard and the opener are separated on purpose: the guard can then be
/// measured with the side effect STUBBED, so a drill that removes the check fails
/// a test instead of opening a file on the machine running the drill (skipi-ops
/// AGENTS, «Субагенты» п.6). The home already knows how to hand a file to the
/// desktop (`lib.rs open_with_default_app`: xdg-open / open / cmd start); K2.1
/// adds the guard in front of it, not a second opener.
fn open_saved_with<F>(
    root: &std::path::Path,
    path: &str,
    opener: F,
) -> Result<(), PilotBridgeError>
where
    F: Fn(&str) -> Result<(), String>,
{
    let resolved = resolved_saved_path(root, path)?;
    opener(&resolved.to_string_lossy()).map_err(|_| invalid_request("cannot_open_file"))
}

/// Opens a copy this app wrote, and nothing else: the path must resolve INSIDE
/// `Downloads/Skipi/Crewing`. Without that check the screen would be a generic
/// "open any file on this machine" command for whoever can reach the bridge.
#[tauri::command]
pub(crate) async fn crewing_intake_open_saved(path: String) -> Result<(), PilotBridgeError> {
    without_blocking_ui(move || {
        let root = saved_root()?;
        open_saved_with(&root, &path, open_with_default_app)
    })
    .await
}

// ---------- No.632/S5: the letter to the customer (OWNER 2026-10-01) --------
//
// The operator presses one button; this writes a complete `.eml` next to the
// copies it already writes, and hands it to the mail client he already uses. He
// reads it there and HE presses send.
//
// Crewing sends nothing, and that is not a preference. OWNER (739) п.5: "check
// and REUSE the existing mechanism of the Seafarer home. DO NOT build your own
// mail client"; and the owner's word of 2026-10-01: "use the existing mechanism
// for preparing a letter with attachments, WITHOUT server-side sending". The
// contract harness of this home holds that door shut by exact equality over the
// call sites, and this code does not go near it.
//
// Why an `.eml` and not `mailto:` — measured, not preferred: `contact.rs` opens
// a `mailto:` draft and says in its own header that nothing can be attached,
// because `mailto:` cannot carry a file. The resumes ARE the point here.
//
// The shape is the Seafarer original (`skipi-public
// src-tauri/src/commands/mail_intent.rs:169-200`): multipart MIME, base64 parts,
// handed to the OS opener. Two deliberate differences:
//
//   * the Seafarer original discards the result of the opener (`let _ =
//     spawn()`), so a client that never came up is indistinguishable from one
//     that did. Here the outcome is carried back to the screen in `opened`, and
//     the guard is separated from the opener so a drill can measure it with the
//     side effect stubbed.
//   * no `From:` and no "Sent via Skipi" footer. The sender is the AGENCY, from
//     its own client and its own address; a Skipi line in the agency's letter to
//     its customer would make us the sender of it.

/// Where the drafts go, inside the folder this module already owns.
const LETTER_FOLDER: &str = "Letters";
/// A mail client has to open this file. The ceiling is the same one the byte
/// routes use for a single download, applied here to the WHOLE letter.
const LETTER_CEILING_BYTES: u64 = DOWNLOAD_CEILING_BYTES;

/// One resume, as the screen hands it over: a file THIS APP wrote (the path the
/// audited byte route returned) and the name the customer is to see.
///
/// The name is a separate field because the byte route deliberately names every
/// download `attachment-<ordinal>.<ext>` — the letter's own filename never
/// reaches a header, which is right for a download and wrong for an envelope
/// carrying six of them: the customer would receive `attachment-0.pdf` six
/// times. The screen names each one for its candidate; this side sanitises it
/// again, because a name that came out of a stranger's letter is hostile input
/// even after a screen has shown it.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CustomerLetterAttachment {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CustomerLetterIntent {
    pub to: String,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<CustomerLetterAttachment>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CustomerLetterDraft {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    /// Whether the operator's mail client actually came up. `Ok` with
    /// `opened: false` is a real and common answer (a machine with no handler for
    /// `message/rfc822`), and it is NOT a failure of the letter: the file is
    /// written and named, so the screen can tell him where it is instead of
    /// claiming a draft he never saw.
    pub opened: bool,
    pub open_error: Option<String>,
}

/// RFC 2047 encoded-word for a header that is not pure ASCII. Cyrillic subjects
/// are the normal case here, not the exception.
fn letter_header_value(value: &str) -> String {
    let clean: String = value
        .chars()
        .filter(|c| *c != '\r' && *c != '\n' && *c != '\0')
        .collect();
    if clean.is_ascii() {
        return clean;
    }
    format!("=?UTF-8?B?{}?=", BASE64_STANDARD.encode(clean.as_bytes()))
}

fn letter_html_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// The type is read off the extension of the file WE wrote, which the byte route
/// chose from its own closed set. Unknown stays `application/octet-stream`: the
/// attachment still opens, it just carries no preview hint.
fn letter_attachment_mime(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".pdf") {
        "application/pdf"
    } else if lower.ends_with(".docx") {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    } else if lower.ends_with(".eml") {
        "message/rfc822"
    } else if lower.ends_with(".txt") {
        "text/plain"
    } else {
        "application/octet-stream"
    }
}

/// The body is carried TWICE and both copies are the same characters: once as
/// `text/plain`, once as `text/html` inside a `<pre>`.
///
/// That is the whole reason there is an HTML part at all. The comparison table
/// is a table of columns, and a proportional font turns it into a paragraph; a
/// `<pre>` keeps it aligned in a client that prefers HTML. Deriving the HTML
/// from the SAME text rather than rendering a second table from the data is the
/// point: two renderers of one table is how a screen comes to show one thing and
/// an envelope to carry another.
fn build_letter_eml(
    intent: &CustomerLetterIntent,
    recipient: &str,
    parts: &[(String, Vec<u8>)],
    stamp: &str,
    boundary_seed: u128,
) -> Result<String, PilotBridgeError> {
    let outer = format!("=_skipi_crewing_{:x}", boundary_seed);
    let inner = format!("=_skipi_crewing_alt_{:x}", boundary_seed);
    // A boundary that occurs in the body ends the part early and the letter
    // arrives truncated. It cannot happen with the seed above, and it is still
    // refused rather than assumed away.
    if intent.body.contains(&outer) || intent.body.contains(&inner) {
        return Err(invalid_request("letter_boundary_collision"));
    }
    let body_crlf = intent.body.replace("\r\n", "\n").replace('\n', "\r\n");

    let mut out = String::new();
    // No `From:`. The operator's client fills in its own identity, which is the
    // agency's — exactly the point of handing the draft over instead of sending.
    out.push_str(&format!("To: {}\r\n", recipient));
    out.push_str(&format!(
        "Subject: {}\r\n",
        letter_header_value(&intent.subject)
    ));
    out.push_str(&format!("Date: {}\r\n", stamp));
    out.push_str("MIME-Version: 1.0\r\n");
    out.push_str(&format!(
        "Content-Type: multipart/mixed; boundary=\"{}\"\r\n\r\n",
        outer
    ));
    out.push_str("This is a multi-part message in MIME format.\r\n");

    out.push_str(&format!("--{}\r\n", outer));
    out.push_str(&format!(
        "Content-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n",
        inner
    ));

    out.push_str(&format!("--{}\r\n", inner));
    out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    out.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
    out.push_str(&body_crlf);
    out.push_str("\r\n");

    out.push_str(&format!("--{}\r\n", inner));
    out.push_str("Content-Type: text/html; charset=utf-8\r\n");
    out.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
    out.push_str("<html><body><pre style=\"font-family:monospace;font-size:13px\">\r\n");
    out.push_str(&letter_html_escape(&body_crlf));
    out.push_str("\r\n</pre></body></html>\r\n");
    out.push_str(&format!("--{}--\r\n", inner));

    for (name, bytes) in parts {
        let mime = letter_attachment_mime(name);
        let encoded = BASE64_STANDARD.encode(bytes);
        out.push_str(&format!("--{}\r\n", outer));
        out.push_str(&format!("Content-Type: {}; name=\"{}\"\r\n", mime, name));
        out.push_str("Content-Transfer-Encoding: base64\r\n");
        out.push_str(&format!(
            "Content-Disposition: attachment; filename=\"{}\"\r\n\r\n",
            name
        ));
        for chunk in encoded.as_bytes().chunks(76) {
            out.push_str(&String::from_utf8_lossy(chunk));
            out.push_str("\r\n");
        }
    }
    out.push_str(&format!("--{}--\r\n", outer));
    Ok(out)
}

/// The whole operation as ONE sync function with the opener passed IN, for the
/// same reason `open_saved_with` is shaped that way: the guard can then be
/// measured with the side effect STUBBED, so a drill that removes a check fails
/// a test instead of opening a mail client on the machine running the drill
/// (skipi-ops AGENTS, «Субагенты» п.6).
fn prepare_letter_with<F>(
    root: &std::path::Path,
    intent: &CustomerLetterIntent,
    stamp: &str,
    boundary_seed: u128,
    opener: F,
) -> Result<CustomerLetterDraft, PilotBridgeError>
where
    F: Fn(&str) -> Result<(), String>,
{
    use sha2::{Digest, Sha256};
    // The recipient is a stranger's address typed by hand, and it is about to be
    // written into a header. The strict ASCII addr-spec check of `contact.rs` is
    // reused rather than restated — a second grammar for one address is how two
    // screens come to accept two different things.
    let recipient = checked_recipient(&intent.to)
        .map_err(|_| invalid_request("letter_recipient_shape"))?;

    // Every attachment must be a file THIS APP wrote, under
    // Downloads/Skipi/Crewing. Without this the command would be "attach any
    // file on this machine and mail it", reachable by whoever reaches the
    // bridge — and the one thing this letter does is leave the building.
    let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total: u64 = 0;
    for (index, attachment) in intent.attachments.iter().enumerate() {
        let resolved = resolved_saved_path(root, &attachment.path)?;
        let bytes = std::fs::read(&resolved).map_err(|_| invalid_request("letter_attachment_unreadable"))?;
        total = total.saturating_add(bytes.len() as u64);
        if total > LETTER_CEILING_BYTES {
            return Err(invalid_request("letter_too_large"));
        }
        let fallback = format!("resume-{}.pdf", index + 1);
        let name = safe_download_name(&attachment.name, &fallback);
        parts.push((name, bytes));
    }

    let eml = build_letter_eml(intent, &recipient, &parts, stamp, boundary_seed)?;
    let folder = root.join(LETTER_FOLDER);
    std::fs::create_dir_all(&folder).map_err(|_| invalid_request("cannot_create_folder"))?;
    let target = folder.join(format!("Skipi_Crewing_{:x}.eml", boundary_seed));
    std::fs::write(&target, eml.as_bytes()).map_err(|_| invalid_request("cannot_write_letter"))?;
    let digest = Sha256::digest(eml.as_bytes());

    // The opener is the LAST thing, and its answer is kept. A client that did not
    // come up leaves a letter that exists and a screen that says so.
    let (opened, open_error) = match opener(&target.to_string_lossy()) {
        Ok(()) => (true, None),
        Err(_) => (false, Some("cannot_open_file".to_string())),
    };
    Ok(CustomerLetterDraft {
        path: target.to_string_lossy().to_string(),
        bytes: eml.as_bytes().len() as u64,
        sha256: digest.iter().map(|b| format!("{:02x}", b)).collect(),
        opened,
        open_error,
    })
}

/// Writes the draft and hands it to the operator's own mail client. It does not
/// send, it cannot send, and it talks to no server at all: there is no context
/// argument because there is no request.
#[tauri::command]
pub(crate) async fn crewing_customer_letter_prepare(
    intent: CustomerLetterIntent,
) -> Result<CustomerLetterDraft, PilotBridgeError> {
    without_blocking_ui(move || {
        let root = saved_root()?;
        let stamp = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S +0000")
            .to_string();
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        prepare_letter_with(&root, &intent, &stamp, seed, open_with_default_app)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// N10: a server build that does not carry the keys must not fail the parse.
    /// The attribute alone is a claim; this is the measurement, and it is
    /// calibrated - the full body parses into the values, so a green here is not a
    /// green over a struct that ignores its input.
    #[test]
    fn a_response_contact_body_without_the_keys_still_parses() {
        let empty: CandidateResponseContact = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.value, None);
        assert_eq!(empty.is_email, None);
        assert_eq!(empty.offer_email, None);

        let partial: CandidateResponseContact =
            serde_json::from_str(r#"{"value":"a@b.test"}"#).unwrap();
        assert_eq!(partial.value.as_deref(), Some("a@b.test"));
        assert_eq!(partial.offer_email, None);

        let full: CandidateResponseContact = serde_json::from_str(
            r#"{"value":"a@b.test","is_email":true,"offer_email":false}"#,
        )
        .unwrap();
        assert_eq!(full.is_email, Some(true));
        assert_eq!(full.offer_email, Some(false));
    }


    /// No.623: THE SILENT-DROP DRILL, in the language the defect lives in.
    ///
    /// `send` decodes into `CandidateIntakeReceipt` and serde ignores a key no
    /// field declares -- no error, no warning, and the value simply never reaches
    /// the webview. That is precisely the No.622 class the owner paid for: the
    /// loader dropped `withheld_profiles` while 88 green checks watched, because
    /// the fixtures put the field straight into the renderer and never crossed
    /// this boundary.
    ///
    /// So the measurement is a ROUND TRIP, not a field-by-field read: decode the
    /// frozen server body, serialise it back, and require every one of the
    /// thirteen names to still be there. Delete a field from the struct and this
    /// goes red; the feature does not quietly become a no-op.
    fn card_body_with_summary() -> String {
        r#"{"intake_id":"intake-A","receipt_id":"receipt-A","crewing_id":"crew-1",
            "source":"skipi_response","source_id":"msg-1","event_id":"e-1",
            "primary_profile_id":null,"content_sha256":"abc","content_bytes":12,
            "content_type":"text/plain","state":"ranked","source_trust":"inbound_alias",
            "version":1,"created_at":"2026-09-30T01:00:00","issued_at":"2026-09-30T01:00:00",
            "objects":[],"attachments":[],
            "summary":{"state":"ranked","facts":3,"ranks":1,"ranks_stale":0,
                       "active_confirmations":0,"needs_review_reason":null},
            "response_summary":{"rank":"Master","rank_state":"from_snapshot",
                "first_name":"Ivan","surname":"Petrov","age_years":41,
                "age_precision":"exact","citizenship":"Ukraine","citizenship_code":"UA",
                "experience_rank":"Master","experience_days":1170,
                "experience_state":"matches_response_rank",
                "experience_days_by_rank":{"Master":1170,"Bosun":300},
                "experience_days_for_rank":1170,
                "experience_days_for_rank_state":"from_map",
                "last_vessel_name":"MV Southern Cross","last_vessel_sign_off":"2026-03-14"}}"#
            .to_string()
    }

    /// No.632: THE SAME SILENT-DROP DRILL, for the two bodies this card adds.
    ///
    /// The measurement is a ROUND TRIP for the same reason it was in No.623: a
    /// field-by-field read of a struct proves the struct, while the defect lives
    /// at the boundary — what the webview is actually handed. Delete any field
    /// from `ProfileShortlistItem` and this goes red instead of the feature
    /// quietly becoming a no-op on a screen whose renderer tests stay green.
    fn profile_shortlist_body() -> String {
        r#"{"profile_id":"prof-A","profile_version":3,"profile_state":"active",
            "items":[{"id":"dec-1","intake_id":"intake-1","profile_version":1,
                      "confirmed_by":"user-op-1","confirmed_at":"2026-10-01T05:00:00",
                      "on_hold":true,"held_by":"user-op-2","held_at":"2026-10-01T06:00:00",
                      "in_selection":false,"needs_recompare":true}],
            "counts":{"selected":3,"in_selection":2,"on_hold":1}}"#
            .to_string()
    }

    #[test]
    fn the_profile_shortlist_keeps_every_field_across_the_bridge() {
        let list: ProfileShortlistResponse =
            serde_json::from_str(&profile_shortlist_body()).unwrap();

        // the values, so a struct that parses but discards is not green
        assert_eq!(list.profile_id, "prof-A");
        assert_eq!(list.profile_version, 3);
        assert_eq!(list.profile_state, "active");
        assert_eq!(list.counts.selected, 3);
        assert_eq!(list.counts.in_selection, 2);
        assert_eq!(list.counts.on_hold, 1);
        let item = &list.items[0];
        assert_eq!(item.id, "dec-1");
        assert_eq!(item.intake_id, "intake-1");
        // The version of the DECISION, not of the profile. If these two were
        // ever confused, every move of this row would quote the wrong number and
        // the server would answer 409 — or worse, succeed against a pair the
        // operator never looked at.
        assert_eq!(item.profile_version, 1);
        assert_ne!(item.profile_version, list.profile_version);
        assert_eq!(item.confirmed_by, "user-op-1");
        assert_eq!(item.confirmed_at, "2026-10-01T05:00:00");
        assert!(item.on_hold);
        assert_eq!(item.held_by.as_deref(), Some("user-op-2"));
        assert_eq!(item.held_at.as_deref(), Some("2026-10-01T06:00:00"));
        assert!(!item.in_selection);
        assert!(item.needs_recompare);

        // and the round trip: what the webview is handed still carries them all
        let back = serde_json::to_string(&list).unwrap();
        for key in [
            "profile_id",
            "profile_version",
            "profile_state",
            "items",
            "counts",
            "id",
            "intake_id",
            "confirmed_by",
            "confirmed_at",
            "on_hold",
            "held_by",
            "held_at",
            "in_selection",
            "needs_recompare",
            "selected",
        ] {
            assert!(
                back.contains(&format!("\"{key}\"")),
                "the bridge dropped {key} on the way to the webview"
            );
        }
    }

    /// A server that carries MORE than this build knows must not fail the parse,
    /// and a server that carries the optional holder fields as null must not be
    /// read as "somebody held him". Calibrated: the full body above parses into
    /// real values, so a green here is not a green over a struct ignoring input.
    #[test]
    fn a_shortlist_row_without_the_holder_fields_still_parses() {
        let row: ProfileShortlistItem = serde_json::from_str(
            r#"{"id":"dec-9","intake_id":"intake-9","profile_version":2,
                "confirmed_by":"u1","confirmed_at":"2026-10-01T00:00:00",
                "on_hold":false,"in_selection":true,"needs_recompare":false,
                "a_field_this_build_has_never_heard_of":42}"#,
        )
        .unwrap();
        assert_eq!(row.held_by, None);
        assert_eq!(row.held_at, None);
        assert!(!row.on_hold);
        assert!(row.in_selection);
    }

    /// The hold answers ONE decision with its third state, and the screen reads
    /// `on_hold` rather than inferring it from `held_at`: the two can only
    /// disagree if one of them is wrong, and the server owns the answer.
    #[test]
    fn the_hold_reply_keeps_every_field_across_the_bridge() {
        let hold: ShortlistHold = serde_json::from_str(
            r#"{"id":"dec-1","intake_id":"intake-1","profile_id":"prof-A","profile_version":2,
                "confirmed_by":"u1","confirmed_at":"2026-10-01T05:00:00","on_hold":true,
                "held_by":"u2","held_at":"2026-10-01T06:00:00",
                "withdrawn_by":null,"withdrawn_at":null}"#,
        )
        .unwrap();
        assert!(hold.on_hold);
        assert_eq!(hold.profile_id, "prof-A");
        assert_eq!(hold.profile_version, 2);
        assert_eq!(hold.held_by.as_deref(), Some("u2"));
        assert_eq!(hold.withdrawn_at, None);
        let back = serde_json::to_string(&hold).unwrap();
        for key in [
            "id", "intake_id", "profile_id", "profile_version", "confirmed_by",
            "confirmed_at", "on_hold", "held_by", "held_at", "withdrawn_by", "withdrawn_at",
        ] {
            assert!(
                back.contains(&format!("\"{key}\"")),
                "the bridge dropped {key} on the way to the webview"
            );
        }
    }

    /// The three new refusal words reach the screen. A code that is not on the
    /// allowlist arrives as a bare status, and the screen cannot then say WHICH
    /// door was shut — which is the whole reason `hold_not_permitted` exists as a
    /// word of its own while standing behind the withdrawal's own check.
    #[test]
    fn the_three_hold_refusals_survive_the_safe_detail_filter() {
        for code in ["already_on_hold", "not_on_hold", "hold_not_permitted"] {
            let body = serde_json::json!({ "detail": code });
            assert_eq!(safe_detail(&body).as_deref(), Some(code));
        }
        // calibration: a word NOT on the allowlist is still dropped, so the test
        // above measures the allowlist and not a filter that passes everything.
        let invented = serde_json::json!({ "detail": "hold_not_permitted_by_accident" });
        assert_eq!(safe_detail(&invented), None);
    }

    #[test]
    fn the_card_keeps_every_element_of_the_response_summary_across_the_bridge() {
        let card: CandidateIntakeReceipt = serde_json::from_str(&card_body_with_summary()).unwrap();
        let summary = card
            .response_summary
            .as_ref()
            .expect("the card carries a response summary");

        // the values themselves, so a struct that parses but discards is not green
        assert_eq!(summary.rank.as_deref(), Some("Master"));
        assert_eq!(summary.rank_state.as_deref(), Some("from_snapshot"));
        assert_eq!(summary.first_name.as_deref(), Some("Ivan"));
        assert_eq!(summary.surname.as_deref(), Some("Petrov"));
        assert_eq!(summary.age_years, Some(41));
        assert_eq!(summary.age_precision.as_deref(), Some("exact"));
        assert_eq!(summary.citizenship.as_deref(), Some("Ukraine"));
        assert_eq!(summary.citizenship_code.as_deref(), Some("UA"));
        assert_eq!(summary.experience_rank.as_deref(), Some("Master"));
        assert_eq!(summary.experience_days, Some(1170));
        assert_eq!(
            summary.experience_state.as_deref(),
            Some("matches_response_rank")
        );
        assert_eq!(summary.last_vessel_name.as_deref(), Some("MV Southern Cross"));
        assert_eq!(summary.last_vessel_sign_off.as_deref(), Some("2026-03-14"));

        // and the round trip: what the webview is handed still has all sixteen.
        //
        // No.632/S5 added the last three. They are asserted HERE, through the
        // round trip, and not only by reading the struct: the letter needs the
        // career map, and a key this struct does not declare is dropped by serde
        // on the way to the webview without an error, without a warning, and
        // with every renderer test still green over it (the No.622 class).
        let back = serde_json::to_string(&card).unwrap();
        for key in [
            "rank",
            "rank_state",
            "first_name",
            "surname",
            "age_years",
            "age_precision",
            "citizenship",
            "citizenship_code",
            "experience_rank",
            "experience_days",
            "experience_state",
            "experience_days_by_rank",
            "experience_days_for_rank",
            "experience_days_for_rank_state",
            "last_vessel_name",
            "last_vessel_sign_off",
        ] {
            assert!(
                back.contains(&format!("\"{key}\"")),
                "the bridge dropped {key} on the way to the webview"
            );
        }
    }

    /// CALIBRATION for the drill above: a body WITHOUT the key must still parse,
    /// or "an old pilot server breaks every card" ships as a green feature.
    #[test]
    fn a_card_from_a_server_without_the_response_keys_still_parses() {
        let body = card_body_with_summary()
            .split(",\n            \"response_summary\"")
            .next()
            .unwrap()
            .to_string()
            + "}";
        let card: CandidateIntakeReceipt = serde_json::from_str(&body).unwrap();
        assert!(card.response_summary.is_none());
        assert!(card.response_headline.is_none());
        // calibrated: the rest of the card really did arrive
        assert_eq!(card.intake_id, "intake-A");
        assert_eq!(card.summary.as_ref().unwrap().facts, 3);
    }

    /// No.623: the queue row carries the NARROW shape, and the card shape must
    /// not ride the list. Four values reach a row; the nine card-only elements
    /// are not on it even when the server would offer them.
    #[test]
    fn a_queue_row_carries_the_headline_and_never_the_card_shape() {
        let row: CandidateIntakeReceipt = serde_json::from_str(
            r#"{"intake_id":"i-1","receipt_id":"r-1","crewing_id":"crew-1",
                "source":"skipi_response","source_id":"m-1","event_id":"e-1",
                "primary_profile_id":null,"content_sha256":"abc","content_bytes":1,
                "content_type":"text/plain","state":"ranked","source_trust":"inbound_alias",
                "version":1,"created_at":"2026-09-30T01:00:00","issued_at":"2026-09-30T01:00:00",
                "objects":[],"attachments":[],"summary":null,
                "response_headline":{"rank":"Master","rank_state":"from_snapshot",
                    "first_name":"Ivan","surname":"Petrov"}}"#,
        )
        .unwrap();
        let head = row.response_headline.as_ref().expect("a headline");
        assert_eq!(head.rank.as_deref(), Some("Master"));
        assert_eq!(head.first_name.as_deref(), Some("Ivan"));
        assert_eq!(head.surname.as_deref(), Some("Petrov"));
        assert!(row.response_summary.is_none());

        // serialised back, a row offers the four and nothing wider
        let back = serde_json::to_string(&row).unwrap();
        for absent in ["age_years", "citizenship", "experience_days", "last_vessel_name"] {
            assert!(
                !back.contains(absent),
                "a queue row must not carry the card element {absent}"
            );
        }
    }

    /// No.623: the state code lives ALONGSIDE the value, never derived from it.
    /// "the profile named no post" and "the version you answered was overwritten"
    /// are both `rank: null` and they are not the same sentence -- and No.622 is
    /// not open, so `experience_state` is the only thing that keeps "no data"
    /// apart from "no sea time".
    #[test]
    fn a_state_code_survives_even_when_its_value_is_null() {
        let s: CandidateResponseSummary = serde_json::from_str(
            r#"{"rank":null,"rank_state":"snapshot_superseded",
                "experience_rank":null,"experience_days":null,
                "experience_state":"response_rank_unknown"}"#,
        )
        .unwrap();
        assert_eq!(s.rank, None);
        assert_eq!(s.rank_state.as_deref(), Some("snapshot_superseded"));
        assert_eq!(s.experience_days, None);
        assert_eq!(
            s.experience_state.as_deref(),
            Some("response_rank_unknown")
        );
        // zero sea time is a DIFFERENT answer from no sea-time data
        let zero: CandidateResponseSummary = serde_json::from_str(
            r#"{"experience_rank":"Master","experience_days":0,"experience_state":"matches_response_rank"}"#,
        )
        .unwrap();
        assert_eq!(zero.experience_days, Some(0));
        assert_ne!(zero.experience_days, s.experience_days);
    }

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    // The live connection of the one Skipi sign-in stands where the pilot's
    // settings file stood.
    fn settings(server_url: &str) -> LiveConnection {
        LiveConnection {
            server_url: server_url.to_string(),
            workspace_id: "crew-test".to_string(),
            bearer_token: "synthetic-token".to_string(),
        }
    }

    fn expected(server_url: &str) -> PilotExpectedContext {
        PilotExpectedContext {
            server_url: server_url.to_string(),
            connection_context: settings(server_url).context(),
            crewing_id: "crew-test".to_string(),
        }
    }

    #[test]
    fn expected_context_must_match_all_three_settings() {
        let current = settings("http://127.0.0.1:9");
        assert!(snapshot_context(&current, &expected("http://127.0.0.1:9")).is_ok());
        // The sign-in now works in another workspace: a request built for the
        // previous one is refused.
        let mut changed_settings = current.clone();
        changed_settings.workspace_id = "other-crew".to_string();
        assert_eq!(
            snapshot_context(&changed_settings, &expected("http://127.0.0.1:9")).unwrap_err().detail,
            Some("settings_changed".to_string())
        );
        let current = settings("http://127.0.0.1:9");
        let mut changed = expected("http://127.0.0.1:10");
        changed.server_url = "http://127.0.0.1:10".to_string();
        assert_eq!(
            snapshot_context(&current, &changed).unwrap_err().detail,
            Some("settings_changed".to_string())
        );
        let current = settings("http://127.0.0.1:9");
        let mut changed = expected("http://127.0.0.1:9");
        changed.crewing_id = "other-crew".to_string();
        assert_eq!(
            snapshot_context(&current, &changed).unwrap_err().detail,
            Some("settings_changed".to_string())
        );
    }

    #[test]
    fn missing_settings_refuse_before_client_creation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let mut current = settings(&base);
        current.bearer_token.clear();
        assert_eq!(
            snapshot_context(&current, &expected(&base))
                .unwrap_err()
                .detail,
            Some("pilot_not_configured".to_string())
        );
        thread::sleep(Duration::from_millis(50));
        assert!(
            listener.accept().is_err(),
            "missing config must refuse with zero network dispatches"
        );
    }

    #[test]
    fn fixed_paths_percent_encode_ids() {
        let context = snapshot_context(
            &settings("http://127.0.0.1:9"),
            &expected("http://127.0.0.1:9"),
        )
        .unwrap();
        let url = alias_url(&context, &["id/with space", "rotate"]).unwrap();
        assert_eq!(
            url.path(),
            "/api/crewings/crew-test/intake-aliases/id%2Fwith%20space/rotate"
        );
    }

    #[test]
    fn redirects_are_refused_without_contacting_target() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let target_addr = target.local_addr().unwrap();

        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_addr = source.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: http://{target_addr}/captured\r\nContent-Length: 0\r\n\r\n"
            )
            .unwrap();
        });

        let base = format!("http://{source_addr}");
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let result: Result<(StatusCode, Value), PilotBridgeError> = send(
            &context,
            Method::GET,
            alias_url(&context, &[]).unwrap(),
            None,
            false,
        );
        server.join().unwrap();
        let err = result.unwrap_err();
        assert_eq!(err.kind, "redirect_refused");
        assert_eq!(err.status, Some(302));
        thread::sleep(Duration::from_millis(50));
        assert!(
            target.accept().is_err(),
            "redirect target must not be contacted"
        );
    }

    #[test]
    fn malformed_success_for_write_is_ambiguous() {
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_addr = source.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9\r\n\r\n{{not-json"
            )
            .unwrap();
        });

        let base = format!("http://{source_addr}");
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let result: Result<(StatusCode, Value), PilotBridgeError> = send(
            &context,
            Method::POST,
            alias_url(&context, &[]).unwrap(),
            Some(json!({"label":"synthetic"})),
            true,
        );
        server.join().unwrap();
        let err = result.unwrap_err();
        assert_eq!(err.kind, "malformed_response");
        assert_eq!(err.status, Some(200));
        assert!(err.ambiguous, "a malformed 2xx write outcome is ambiguous");
    }

    // ---------------- C3b-2 native unit tests ----------------

    fn one_shot_server(reply: String) -> (String, thread::JoinHandle<Vec<u8>>) {
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_addr = source.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).unwrap_or(0);
            write!(stream, "{reply}").unwrap();
            request[..read].to_vec()
        });
        (format!("http://{source_addr}"), server)
    }

    fn json_reply(status_line: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    fn pair(version: i64) -> ShortlistPair {
        ShortlistPair {
            profile_id: "profile-a".to_string(),
            profile_version: version,
        }
    }

    // ---- R2 (OWNER 2026-09-29): the queue row reads the stored outcome from the
    // list response, so CandidateIntakeSummary must carry it — and must keep
    // "the server did not send the field" distinguishable from "the server says
    // there are none". Collapsing those two makes an unanswered question look
    // like an answer on the operator's screen.
    // R2 (OWNER 2026-09-29): the row title. Three states must survive BOTH the
    // parse and the hand-off to the webview, because they are three different
    // things to show an operator:
    //   field absent      -> this server build does not carry it: we cannot say
    //   field present null-> the server says the recorded facts hold no name
    //   field present str -> the name
    // A plain Option<String> collapses the first two into None, and then a row
    // would announce "no name recorded" on a server that was never asked.
    #[test]
    fn candidate_name_absent_present_null_and_present_value_stay_three_states() {
        let base = r#"{"state":"ranked","facts":3,"ranks":0,"ranks_stale":0,
            "active_confirmations":0,"needs_review_reason":null"#;
        let absent: CandidateIntakeSummary = serde_json::from_str(&format!("{base}}}")).unwrap();
        let null: CandidateIntakeSummary =
            serde_json::from_str(&format!("{base},\"candidate_name\":null}}")).unwrap();
        let named: CandidateIntakeSummary =
            serde_json::from_str(&format!("{base},\"candidate_name\":\"Oleksandr K.\"}}")).unwrap();
        assert_eq!(absent.candidate_name, None, "absent field: unanswered");
        assert_eq!(null.candidate_name, Some(None), "explicit null: answered, no name");
        assert_eq!(
            named.candidate_name,
            Some(Some("Oleksandr K.".to_string())),
            "a value is the name itself"
        );
    }

    // The webview is where the distinction is actually consumed, so it has to
    // survive serialization too: absent must not arrive looking like null.
    #[test]
    fn candidate_name_three_states_survive_the_hand_off_to_the_webview() {
        let base = r#"{"state":"ranked","facts":3,"ranks":0,"ranks_stale":0,
            "active_confirmations":0,"needs_review_reason":null"#;
        let absent: CandidateIntakeSummary = serde_json::from_str(&format!("{base}}}")).unwrap();
        let null: CandidateIntakeSummary =
            serde_json::from_str(&format!("{base},\"candidate_name\":null}}")).unwrap();
        let named: CandidateIntakeSummary =
            serde_json::from_str(&format!("{base},\"candidate_name\":\"Ivan M.\"}}")).unwrap();
        let out = |v: &CandidateIntakeSummary| serde_json::to_string(v).unwrap();
        assert!(
            !out(&absent).contains("candidate_name"),
            "an absent field is omitted, so the screen sees no key at all: {}",
            out(&absent)
        );
        assert!(
            out(&null).contains("\"candidate_name\":null"),
            "an explicit null keeps its key: {}",
            out(&null)
        );
        assert!(
            out(&named).contains("\"candidate_name\":\"Ivan M.\""),
            "a name travels as itself: {}",
            out(&named)
        );
    }

    #[test]
    fn summary_without_profile_ranks_parses_and_stays_unanswered() {
        let json = r#"{"state":"ranked","facts":3,"ranks":1,"ranks_stale":0,
            "active_confirmations":0,"needs_review_reason":null}"#;
        let summary: CandidateIntakeSummary =
            serde_json::from_str(json).expect("a server build without the field must still parse");
        assert!(
            summary.profile_ranks.is_none(),
            "a missing field is None (unanswered), never an empty list (answered)"
        );
    }

    #[test]
    fn summary_with_empty_profile_ranks_is_an_answer() {
        let json = r#"{"state":"ranked","facts":3,"ranks":0,"ranks_stale":0,
            "active_confirmations":0,"needs_review_reason":null,"profile_ranks":[]}"#;
        let summary: CandidateIntakeSummary = serde_json::from_str(json).unwrap();
        assert_eq!(
            summary.profile_ranks,
            Some(Vec::new()),
            "an empty list is the server saying there are no stored evaluations"
        );
    }

    #[test]
    fn summary_profile_rank_row_carries_the_frozen_contract() {
        let json = r#"{"state":"ranked","facts":3,"ranks":1,"ranks_stale":0,
            "active_confirmations":0,"needs_review_reason":null,
            "profile_ranks":[{"profile_id":"p-main","profile_version":2,"met":2,
              "missing":1,"unconfirmed":3,"total":6,"stale":true}]}"#;
        let summary: CandidateIntakeSummary = serde_json::from_str(json).unwrap();
        let rows = summary.profile_ranks.expect("present");
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.profile_id, "p-main");
        assert_eq!(row.profile_version, 2);
        assert_eq!((row.met, row.missing, row.unconfirmed, row.total), (2, 1, 3, 6));
        assert!(row.stale, "stale travels as a bool, exactly as the contract says");
    }

    // `total` is not symmetry. The card keeps an `unknown` bucket so an outcome
    // code this build does not know is never silently counted as met; the row
    // carries numbers, not codes, so `total` is the only thing that can carry
    // that protection across. A row where the three counts do not add up to
    // `total` must survive parsing intact so the UI can say so out loud.
    #[test]
    fn summary_profile_rank_row_keeps_an_unrecognised_remainder_visible() {
        let json = r#"{"state":"ranked","facts":3,"ranks":1,"ranks_stale":0,
            "active_confirmations":0,"needs_review_reason":null,
            "profile_ranks":[{"profile_id":"p-main","profile_version":1,"met":2,
              "missing":0,"unconfirmed":0,"total":5,"stale":false}]}"#;
        let summary: CandidateIntakeSummary = serde_json::from_str(json).unwrap();
        let row = &summary.profile_ranks.expect("present")[0];
        assert_eq!(row.met + row.missing + row.unconfirmed, 2);
        assert_eq!(row.total, 5, "the remainder stays measurable: 3 outcomes are unaccounted for");
    }

    #[test]
    fn withdraw_expected_empty_204_is_ack() {
        let (base, server) =
            one_shot_server("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n".to_string());
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let (profile_id, version) = checked_pair(&pair(1)).unwrap();
        let url = intake_url(&context, "intake-1", &["shortlist", &profile_id, &version]).unwrap();
        let result = send_no_content(&context, Method::DELETE, url);
        let request = String::from_utf8_lossy(&server.join().unwrap()).to_string();
        assert!(
            result.is_ok(),
            "an exact empty 204 is the documented withdraw ACK"
        );
        assert!(
            request.starts_with(
                "DELETE /api/crewings/crew-test/candidate-intake/intake-1/shortlist/profile-a/1 "
            ),
            "withdraw uses the fixed DELETE path: {request}"
        );
        assert!(
            !request.contains("Content-Type: application/json"),
            "withdraw sends no JSON request body"
        );
    }

    #[test]
    fn withdraw_unexpected_empty_200_stays_ambiguous() {
        let (base, server) =
            one_shot_server("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_string());
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let url = intake_url(&context, "intake-1", &["shortlist", "profile-a", "1"]).unwrap();
        let err = send_no_content(&context, Method::DELETE, url).unwrap_err();
        server.join().unwrap();
        assert_eq!(err.kind, "unexpected_success");
        assert_eq!(err.status, Some(200));
        assert!(
            err.ambiguous,
            "a success that is not the documented 204 is UNKNOWN, not ACK"
        );
    }

    #[test]
    fn withdraw_200_with_json_body_stays_ambiguous() {
        // reqwest discards any body of a 204 by specification, so "204 with
        // bytes" is not observable through this client; the observable
        // neighbour is a 2xx that is not 204 and carries a body.
        let (base, server) = one_shot_server(json_reply("200 OK", "{}"));
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let url = intake_url(&context, "intake-1", &["shortlist", "profile-a", "1"]).unwrap();
        let err = send_no_content(&context, Method::DELETE, url).unwrap_err();
        server.join().unwrap();
        assert_eq!(err.kind, "unexpected_success");
        assert!(err.ambiguous);
    }

    #[test]
    fn withdraw_documented_403_keeps_refusal_code() {
        let (base, server) = one_shot_server(json_reply(
            "403 Forbidden",
            "{\"detail\":\"withdraw_not_permitted\"}",
        ));
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let url = intake_url(&context, "intake-1", &["shortlist", "profile-a", "1"]).unwrap();
        let err = send_no_content(&context, Method::DELETE, url).unwrap_err();
        server.join().unwrap();
        assert_eq!(err.kind, "server");
        assert_eq!(err.status, Some(403));
        assert_eq!(err.detail, Some("withdraw_not_permitted".to_string()));
        assert!(
            !err.ambiguous,
            "a documented refusal is a refusal, never UNKNOWN"
        );
    }

    #[test]
    fn typed_reads_still_refuse_an_empty_204() {
        let (base, server) =
            one_shot_server("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n".to_string());
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let url = intake_url(&context, "intake-1", &["ranks"]).unwrap();
        let result: Result<(StatusCode, CandidateRanksResponse), PilotBridgeError> =
            send(&context, Method::GET, url, None, false);
        server.join().unwrap();
        let err = result.unwrap_err();
        assert_eq!(
            err.kind, "malformed_response",
            "the JSON decoder of typed commands is not loosened"
        );
        assert!(
            !err.ambiguous,
            "an empty read is a read failure, not a write ambiguity"
        );
    }

    #[test]
    fn rank_posts_an_empty_json_object() {
        let (base, server) = one_shot_server(json_reply(
            "200 OK",
            "{\"ranked\":0,\"written\":0,\"reason\":\"no_active_profiles\",\"profiles\":[]}",
        ));
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let url = intake_url(&context, "intake-1", &["rank"]).unwrap();
        let result: Result<(StatusCode, CandidateRankResponse), PilotBridgeError> =
            send(&context, Method::POST, url, Some(json!({})), true);
        let request = String::from_utf8_lossy(&server.join().unwrap()).to_string();
        let (_, parsed) = result.unwrap();
        assert!(
            request.starts_with("POST /api/crewings/crew-test/candidate-intake/intake-1/rank "),
            "{request}"
        );
        assert!(
            request.ends_with("\r\n\r\n{}"),
            "rank body is exactly {{}}: {request}"
        );
        assert_eq!(parsed.reason, "no_active_profiles");
        assert_eq!(parsed.ranked, 0);
    }

    #[test]
    fn correction_path_encodes_every_segment() {
        let context = snapshot_context(
            &settings("http://127.0.0.1:9"),
            &expected("http://127.0.0.1:9"),
        )
        .unwrap();
        let url = intake_url(
            &context,
            "in/take",
            &["facts", "certificate:coc master", "correct"],
        )
        .unwrap();
        assert_eq!(
            url.path(),
            "/api/crewings/crew-test/candidate-intake/in%2Ftake/facts/certificate:coc%20master/correct"
        );
        let url = fixed_url(&context, &["matching-profiles"]).unwrap();
        assert_eq!(url.path(), "/api/crewings/crew-test/matching-profiles");
    }

    #[test]
    fn shortlist_pair_and_fact_shape_are_refused_before_any_dispatch() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let _context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        assert_eq!(
            checked_pair(&pair(0)).unwrap_err().detail,
            Some("invalid_profile_version".to_string())
        );
        assert_eq!(
            checked_pair(&pair(-7)).unwrap_err().detail,
            Some("invalid_profile_version".to_string())
        );
        let mut blank = pair(1);
        blank.profile_id = "   ".to_string();
        assert_eq!(
            checked_pair(&blank).unwrap_err().detail,
            Some("invalid_profile_id".to_string())
        );
        let submit =
            |field: &str, value: &str, source: &str, page: Option<i64>, span: Option<&str>| {
                CandidateFactSubmit {
                    field: field.to_string(),
                    value: value.to_string(),
                    source_object: source.to_string(),
                    page,
                    span: span.map(|s| s.to_string()),
                }
            };
        assert_eq!(
            checked_fact(submit("", "x", "obj", None, None))
                .unwrap_err()
                .detail,
            Some("invalid_fact_field".to_string())
        );
        assert_eq!(
            checked_fact(submit("rank", "x", " ", None, None))
                .unwrap_err()
                .detail,
            Some("invalid_fact_source_object".to_string())
        );
        assert_eq!(
            checked_fact(submit("rank", "x", "obj", Some(-1), None))
                .unwrap_err()
                .detail,
            Some("invalid_fact_page".to_string())
        );
        assert_eq!(
            checked_fact(submit("rank", "x", "obj", None, Some(&"s".repeat(65))))
                .unwrap_err()
                .detail,
            Some("invalid_fact_span".to_string())
        );
        let body = checked_fact(submit("rank", "", "obj", Some(0), None)).unwrap();
        assert_eq!(
            body["value"],
            json!(""),
            "an empty value is a value, not an absence"
        );
        assert_eq!(
            body["page"],
            json!(0),
            "page 0 is a measured page, not null"
        );
        assert!(
            body.get("confidence").is_none()
                && body.get("uncertainty").is_none()
                && body.get("corrected_by").is_none()
        );
        thread::sleep(Duration::from_millis(50));
        assert!(
            listener.accept().is_err(),
            "shape refusals dispatch nothing"
        );
    }

    #[test]
    fn fact_confidence_null_and_zero_stay_distinct_in_the_dto() {
        let null_confidence: CandidateFact = serde_json::from_str(
            "{\"field\":\"rank\",\"value\":\"Master\",\"version\":1,\"source_object\":\"o\",\"page\":null,\"span\":null,\"confidence\":null,\"uncertainty\":\"operator_entered\",\"corrected_by\":\"user-1\",\"created_at\":\"2026-09-23T00:00:00\"}",
        )
        .unwrap();
        let zero_confidence: CandidateFact = serde_json::from_str(
            "{\"field\":\"rank\",\"value\":\"\",\"version\":2,\"source_object\":\"o\",\"page\":0,\"confidence\":0.0,\"created_at\":\"2026-09-23T00:00:00\"}",
        )
        .unwrap();
        assert_eq!(null_confidence.confidence, None);
        assert_eq!(zero_confidence.confidence, Some(0.0));
        assert_eq!(zero_confidence.page, Some(0));
        assert_eq!(zero_confidence.value, "");
        let out = serde_json::to_value(&zero_confidence).unwrap();
        assert_eq!(out["confidence"], json!(0.0));
        assert_eq!(
            serde_json::to_value(&null_confidence).unwrap()["confidence"],
            Value::Null
        );
    }

    #[test]
    fn saved_path_guard_refuses_everything_outside_the_downloads_folder() {
        // The guard is the only thing between "open the copy I just wrote" and
        // "open any file on this machine", so it is measured on real paths,
        // including a symlink that points out of the folder.
        let base = std::env::temp_dir().join(format!(
            "skipi-crewing-k21-{}-{}",
            std::process::id(),
            "guard"
        ));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("intake12")).unwrap();
        let inside = root.join("intake12").join("letter.eml");
        std::fs::write(&inside, b"x").unwrap();
        let outside = base.join("outside.eml");
        std::fs::write(&outside, b"x").unwrap();

        assert_eq!(
            resolved_saved_path(&root, inside.to_str().unwrap()).unwrap(),
            std::fs::canonicalize(&inside).unwrap()
        );
        assert!(resolved_saved_path(&root, outside.to_str().unwrap()).is_err());
        assert!(resolved_saved_path(&root, root.to_str().unwrap()).is_err());
        assert!(resolved_saved_path(&root, "").is_err());
        assert!(resolved_saved_path(
            &root,
            root.join("intake12").join("nope.eml").to_str().unwrap()
        )
        .is_err());
        assert!(resolved_saved_path(
            &root,
            root.join("intake12")
                .join("..")
                .join("..")
                .join("outside.eml")
                .to_str()
                .unwrap()
        )
        .is_err());
        #[cfg(unix)]
        {
            let link = root.join("intake12").join("escape.eml");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(
                resolved_saved_path(&root, link.to_str().unwrap()).is_err(),
                "a symlink out of the folder must resolve and be refused"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn open_saved_refuses_before_it_opens_anything() {
        // The opener is a stub that records: the point of the test is that a path
        // outside the folder never REACHES it, which a check "returns Err" alone
        // would not prove.
        let base = std::env::temp_dir().join(format!("skipi-crewing-k21-{}-open", std::process::id()));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("intake12")).unwrap();
        let inside = root.join("intake12").join("letter.eml");
        std::fs::write(&inside, b"x").unwrap();
        let outside = base.join("outside.eml");
        std::fs::write(&outside, b"x").unwrap();

        let opened = std::cell::RefCell::new(Vec::new());
        let record = |p: &str| {
            opened.borrow_mut().push(p.to_string());
            Ok(())
        };
        assert!(open_saved_with(&root, inside.to_str().unwrap(), record).is_ok());
        assert_eq!(opened.borrow().len(), 1);
        assert!(opened.borrow()[0].ends_with("letter.eml"));

        assert!(open_saved_with(&root, outside.to_str().unwrap(), record).is_err());
        assert_eq!(
            opened.borrow().len(),
            1,
            "a path outside the downloads folder must never reach the opener"
        );
        assert!(open_saved_with(&root, "/etc/passwd", record).is_err());
        assert_eq!(opened.borrow().len(), 1, "and neither must a system path");
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---------- No.632/S5: the letter to the customer ----------------------

    /// A temp stand for the letter tests: a downloads root with two saved
    /// resumes in it, plus one file OUTSIDE it. Nothing here touches the real
    /// `Downloads/Skipi/Crewing`.
    fn letter_stand(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "skipi-crewing-632-letter-{}-{}",
            std::process::id(),
            tag
        ));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("intake-1")).unwrap();
        std::fs::create_dir_all(root.join("intake-2")).unwrap();
        std::fs::write(root.join("intake-1").join("attachment-0.pdf"), b"%PDF-1.4 one").unwrap();
        std::fs::write(root.join("intake-2").join("attachment-0.pdf"), b"%PDF-1.4 two").unwrap();
        std::fs::write(base.join("outside.pdf"), b"%PDF-1.4 outside").unwrap();
        (base, root)
    }

    fn letter_intent(root: &std::path::Path, to: &str) -> CustomerLetterIntent {
        CustomerLetterIntent {
            to: to.to_string(),
            subject: "Кандидаты по вашему заказу: Master, Crude Oil Tanker".to_string(),
            body: "Здравствуйте, уважаемый заказчик!\n\nКандидат  | Возраст\nIvan P.   | 43\n\nС уважением,\nMarlow Crewing Ltd".to_string(),
            attachments: vec![
                CustomerLetterAttachment {
                    path: root.join("intake-1").join("attachment-0.pdf").to_string_lossy().to_string(),
                    name: "Ivan_Petrenko_CV.pdf".to_string(),
                },
                CustomerLetterAttachment {
                    path: root.join("intake-2").join("attachment-0.pdf").to_string_lossy().to_string(),
                    name: "Petro_Shevchuk_CV.pdf".to_string(),
                },
            ],
        }
    }

    #[test]
    fn the_letter_carries_the_table_in_its_body_and_the_resumes_attached() {
        let (base, root) = letter_stand("shape");
        let intent = letter_intent(&root, "crewing@oceanic.example.com");
        let opened = std::cell::RefCell::new(Vec::new());
        let record = |p: &str| {
            opened.borrow_mut().push(p.to_string());
            Ok(())
        };
        let draft = prepare_letter_with(
            &root,
            &intent,
            "Thu, 01 Oct 2026 20:00:00 +0000",
            0x1234,
            record,
        )
        .expect("the letter is written");

        // the file exists, inside the folder this app owns, and the opener was
        // handed exactly it
        assert!(draft.path.contains("Letters"), "{}", draft.path);
        assert!(std::path::Path::new(&draft.path).is_file());
        assert_eq!(opened.borrow().len(), 1);
        assert_eq!(opened.borrow()[0], draft.path);
        assert!(draft.opened);
        assert_eq!(draft.open_error, None);

        let eml = std::fs::read_to_string(&draft.path).unwrap();
        assert_eq!(draft.bytes, eml.as_bytes().len() as u64);
        // the envelope
        assert!(eml.starts_with("To: crewing@oceanic.example.com\r\n"));
        assert!(eml.contains("MIME-Version: 1.0\r\n"));
        assert!(eml.contains("Content-Type: multipart/mixed; boundary=\"=_skipi_crewing_1234\""));
        assert!(eml.contains("Content-Type: multipart/alternative; boundary=\"=_skipi_crewing_alt_1234\""));
        // NO `From:` — the agency's own client fills that in, and that is what
        // makes the AGENCY the sender rather than us
        assert!(!eml.contains("\r\nFrom:"), "the letter must not name a sender");
        assert!(!eml.contains("Skipi (https://skipi.app)"), "no Skipi footer in the agency's letter");
        // the Cyrillic subject survives as an encoded word, not as raw bytes in a
        // header
        assert!(eml.contains("Subject: =?UTF-8?B?"));
        // the table is IN THE BODY, twice, and both copies are the same text
        assert!(eml.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(eml.contains("Content-Type: text/html; charset=utf-8"));
        assert!(eml.contains("Кандидат  | Возраст\r\nIvan P.   | 43"));
        assert!(eml.contains("<pre style=\"font-family:monospace"));
        assert_eq!(
            eml.matches("Marlow Crewing Ltd").count(),
            2,
            "the body is carried as plain text AND as the same text inside <pre>"
        );
        // the resumes, base64, under the names the customer will read
        assert!(eml.contains("Content-Disposition: attachment; filename=\"Ivan_Petrenko_CV.pdf\""));
        assert!(eml.contains("Content-Disposition: attachment; filename=\"Petro_Shevchuk_CV.pdf\""));
        assert_eq!(eml.matches("Content-Transfer-Encoding: base64").count(), 2);
        assert!(eml.contains(&BASE64_STANDARD.encode(b"%PDF-1.4 one")));
        assert!(eml.contains(&BASE64_STANDARD.encode(b"%PDF-1.4 two")));
        assert!(eml.contains("Content-Type: application/pdf; name=\"Ivan_Petrenko_CV.pdf\""));
        assert!(eml.ends_with("--=_skipi_crewing_1234--\r\n"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_resume_outside_the_downloads_folder_never_reaches_the_letter() {
        // The one thing this command does is leave the building. Without this
        // guard it is "attach any file on this machine and mail it", reachable by
        // whoever reaches the bridge.
        let (base, root) = letter_stand("guard");
        let opened = std::cell::RefCell::new(0_usize);
        let record = |_: &str| {
            *opened.borrow_mut() += 1;
            Ok(())
        };
        for hostile in [
            base.join("outside.pdf").to_string_lossy().to_string(),
            "/etc/passwd".to_string(),
            root.join("intake-1").join("..").join("..").join("outside.pdf").to_string_lossy().to_string(),
            String::new(),
        ] {
            let mut intent = letter_intent(&root, "crewing@oceanic.example.com");
            intent.attachments = vec![CustomerLetterAttachment {
                path: hostile.clone(),
                name: "x.pdf".to_string(),
            }];
            let err = prepare_letter_with(&root, &intent, "d", 1, record)
                .expect_err(&format!("{hostile} must be refused"));
            assert_eq!(err.kind, "invalid_request");
        }
        #[cfg(unix)]
        {
            let link = root.join("intake-1").join("escape.pdf");
            std::os::unix::fs::symlink(base.join("outside.pdf"), &link).unwrap();
            let mut intent = letter_intent(&root, "crewing@oceanic.example.com");
            intent.attachments = vec![CustomerLetterAttachment {
                path: link.to_string_lossy().to_string(),
                name: "x.pdf".to_string(),
            }];
            assert!(
                prepare_letter_with(&root, &intent, "d", 1, record).is_err(),
                "a symlink pointing out of the folder must resolve and be refused"
            );
        }
        assert_eq!(
            *opened.borrow(),
            0,
            "no letter was written, so nothing must have been opened"
        );
        // CALIBRATION: the same stand DOES produce a letter for a file inside the
        // folder, so the refusals above are the guard and not a broken stand.
        let intent = letter_intent(&root, "crewing@oceanic.example.com");
        assert!(prepare_letter_with(&root, &intent, "d", 2, record).is_ok());
        assert_eq!(*opened.borrow(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_address_the_mail_client_would_refuse_is_refused_here_first() {
        // Reuses the addr-spec check of `contact.rs` rather than restating it: a
        // smuggled `attachment=` would otherwise become a SECOND compose field on
        // the operator's draft, and a CR would become a second header.
        let (base, root) = letter_stand("to");
        let opened = std::cell::RefCell::new(0_usize);
        let record = |_: &str| {
            *opened.borrow_mut() += 1;
            Ok(())
        };
        for hostile in [
            "a@b.test%2Cattachment=%27/etc/passwd%27",
            "-flag@b.test",
            "a@b.test\r\nBcc: someone@else.test",
            "two@addresses.test, other@addresses.test",
            "no-at-sign",
            "кирилица@почта.рф",
            "",
        ] {
            let intent = letter_intent(&root, hostile);
            let err = prepare_letter_with(&root, &intent, "d", 3, record)
                .expect_err(&format!("{hostile:?} must be refused"));
            assert_eq!(err.detail.as_deref(), Some("letter_recipient_shape"));
        }
        assert_eq!(*opened.borrow(), 0, "nothing was prepared, nothing was opened");
        // CALIBRATION: a plain address passes through the same path
        assert!(prepare_letter_with(
            &root,
            &letter_intent(&root, "crewing@oceanic.example.com"),
            "d",
            4,
            record
        )
        .is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_mail_client_that_did_not_open_is_reported_and_the_letter_is_kept() {
        // The one honest defect of the Seafarer original (`let _ = spawn()`): a
        // client that never came up reads exactly like one that did. Here the
        // answer comes back, and the written file is still named — the operator
        // can open it himself instead of being told about a draft he never saw.
        let (base, root) = letter_stand("opener");
        let refuse = |_: &str| Err("no handler for message/rfc822".to_string());
        let draft = prepare_letter_with(
            &root,
            &letter_intent(&root, "crewing@oceanic.example.com"),
            "d",
            5,
            refuse,
        )
        .expect("a client that will not open is not a failure of the letter");
        assert!(!draft.opened);
        assert_eq!(draft.open_error.as_deref(), Some("cannot_open_file"));
        assert!(std::path::Path::new(&draft.path).is_file());
        assert!(draft.bytes > 0 && draft.sha256.len() == 64);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_hostile_attachment_name_cannot_forge_a_header() {
        // The name is chosen on the screen out of a stranger's letter. A quote
        // would end the `filename="..."` value and a CR would start a new header.
        let (base, root) = letter_stand("name");
        let mut intent = letter_intent(&root, "crewing@oceanic.example.com");
        intent.attachments = vec![CustomerLetterAttachment {
            path: root.join("intake-1").join("attachment-0.pdf").to_string_lossy().to_string(),
            name: "ev\"il\r\nContent-Type: text/html; name=\"x.pdf".to_string(),
        }];
        let draft = prepare_letter_with(&root, &intent, "d", 6, |_| Ok(())).unwrap();
        let eml = std::fs::read_to_string(&draft.path).unwrap();
        assert!(!eml.contains("Content-Type: text/html; name=\"x.pdf"));
        assert_eq!(
            eml.matches("Content-Disposition: attachment;").count(),
            1,
            "one attachment stays one attachment"
        );
        assert!(!eml.contains("ev\"il"), "the quote never reaches the header");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_html_copy_of_the_body_escapes_what_a_name_may_contain() {
        // The HTML part exists so the comparison table stays aligned, and it is
        // derived from the SAME text as the plain part. A candidate named with an
        // angle bracket must not become markup in it.
        let (base, root) = letter_stand("html");
        let mut intent = letter_intent(&root, "crewing@oceanic.example.com");
        intent.body = "Кандидат <b>A & B</b> | 43".to_string();
        let draft = prepare_letter_with(&root, &intent, "d", 7, |_| Ok(())).unwrap();
        let eml = std::fs::read_to_string(&draft.path).unwrap();
        assert!(eml.contains("Кандидат <b>A & B</b> | 43"), "the plain part is the text itself");
        assert!(eml.contains("Кандидат &lt;b&gt;A &amp; B&lt;/b&gt; | 43"), "the html part escapes it");
        assert!(!eml.contains("<pre style=\"font-family:monospace;font-size:13px\">\r\nКандидат <b>"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_letter_too_heavy_for_a_mail_client_is_refused_by_name() {
        let (base, root) = letter_stand("size");
        let fat = root.join("intake-1").join("fat.pdf");
        std::fs::write(&fat, vec![0_u8; (LETTER_CEILING_BYTES + 1) as usize]).unwrap();
        let mut intent = letter_intent(&root, "crewing@oceanic.example.com");
        intent.attachments = vec![CustomerLetterAttachment {
            path: fat.to_string_lossy().to_string(),
            name: "fat.pdf".to_string(),
        }];
        let err = prepare_letter_with(&root, &intent, "d", 8, |_| Ok(())).expect_err("too large");
        assert_eq!(err.detail.as_deref(), Some("letter_too_large"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_the_header_part_of_an_eml_reaches_the_screen() {
        let raw = b"From: a@b.test\r\nSubject: one\r\n\r\nSubject: forged\r\nbody\r\n";
        let head = letter_head_text(raw);
        assert!(head.contains("Subject: one"));
        assert!(!head.contains("forged"), "{head}");
        let lf = b"From: a@b.test\nSubject: two\n\nbody\n";
        assert!(!letter_head_text(lf).contains("body"));
        assert!(letter_head_text(b"no headers at all").contains("no headers"));
        let long = vec![b'A'; LETTER_HEAD_MAX_BYTES * 2];
        assert_eq!(letter_head_text(&long).len(), LETTER_HEAD_MAX_BYTES);
    }

    #[test]
    fn a_server_filename_can_never_walk_out_of_the_folder() {
        assert_eq!(safe_download_name("letter-3a8bcae3.eml", "f"), "letter-3a8bcae3.eml");
        assert_eq!(safe_download_name("../../etc/passwd", "f"), "f");
        assert_eq!(safe_download_name("/etc/passwd", "f"), "etc_passwd");
        assert_eq!(safe_download_name("", "f"), "f");
        assert_eq!(safe_download_name("..", "f"), "f");
        assert_eq!(safe_download_name("a\0b.pdf", "f"), "a_b.pdf");
        assert_eq!(safe_download_name("резюме.pdf", "f"), "pdf");
        assert_eq!(
            filename_from_disposition("attachment; filename=\"letter-3a8bcae3.eml\""),
            Some("letter-3a8bcae3.eml".to_string())
        );
        assert_eq!(
            filename_from_disposition("attachment; filename=attachment-1.pdf"),
            Some("attachment-1.pdf".to_string())
        );
        assert_eq!(filename_from_disposition("attachment"), None);
    }

    #[test]
    fn the_card_may_lower_the_download_ceiling_never_raise_it() {
        assert_eq!(download_ceiling(None), DOWNLOAD_CEILING_BYTES);
        assert_eq!(download_ceiling(Some(0)), DOWNLOAD_CEILING_BYTES);
        assert_eq!(download_ceiling(Some(512)), 512);
        assert_eq!(
            download_ceiling(Some(DOWNLOAD_CEILING_BYTES * 4)),
            DOWNLOAD_CEILING_BYTES
        );
    }

    #[test]
    fn the_attachment_row_survives_a_receipt_without_the_field() {
        // Old servers (before S3) answer without `attachments`; the screen must
        // read that as "no rows", not as a broken card.
        let receipt: CandidateIntakeReceipt = serde_json::from_str(
            "{\"intake_id\":\"i\",\"receipt_id\":\"r\",\"crewing_id\":\"c\",\"source\":\"desktop\",\"source_id\":\"s\",\"event_id\":\"e\",\"primary_profile_id\":null,\"content_sha256\":\"x\",\"content_bytes\":1,\"content_type\":\"message/rfc822\",\"state\":\"quarantined\",\"source_trust\":\"unverified\",\"version\":1,\"created_at\":\"t\",\"issued_at\":\"t\",\"summary\":null}",
        )
        .unwrap();
        assert!(receipt.attachments.is_empty());
        let with_rows: CandidateIntakeReceipt = serde_json::from_str(
            "{\"intake_id\":\"i\",\"receipt_id\":\"r\",\"crewing_id\":\"c\",\"source\":\"desktop\",\"source_id\":\"s\",\"event_id\":\"e\",\"primary_profile_id\":null,\"content_sha256\":\"x\",\"content_bytes\":1,\"content_type\":\"message/rfc822\",\"state\":\"quarantined\",\"source_trust\":\"unverified\",\"version\":1,\"created_at\":\"t\",\"issued_at\":\"t\",\"attachments\":[{\"ordinal\":2,\"filename\":null,\"declared_type\":\"application/pdf\",\"measured_type\":null,\"byte_size\":11,\"verdict\":\"needs_review\",\"reason\":\"scanner_unavailable\",\"eligible\":true}],\"summary\":null}",
        )
        .unwrap();
        assert_eq!(with_rows.attachments.len(), 1);
        assert_eq!(with_rows.attachments[0].ordinal, 2);
        assert!(with_rows.attachments[0].eligible);
        assert_eq!(with_rows.attachments[0].filename, None);
        let back = serde_json::to_value(&with_rows).unwrap();
        assert_eq!(back["attachments"][0]["reason"], json!("scanner_unavailable"));
    }

    #[test]
    fn pydantic_list_detail_is_not_a_code() {
        let parsed: Value = serde_json::from_str(
            "{\"detail\":[{\"type\":\"missing\",\"loc\":[\"body\",\"field\"],\"msg\":\"x\"}]}",
        )
        .unwrap();
        assert_eq!(safe_detail(&parsed), None);
        let parsed: Value = serde_json::from_str("{\"detail\":\"rank_not_found\"}").unwrap();
        assert_eq!(safe_detail(&parsed), Some("rank_not_found".to_string()));
        let parsed: Value = serde_json::from_str("{\"detail\":\"some_future_code\"}").unwrap();
        assert_eq!(
            safe_detail(&parsed),
            None,
            "unknown detail never leaves the safe allowlist"
        );
    }

    #[test]
    fn the_first_attachment_is_ordinal_zero() {
        // Server contract: attachments are counted from zero (`_ordinal_or_404`,
        // c3a-api-contract.md). Live 2026-09-27: GET /attachments/0 answered 200
        // with 898 bytes while this client refused ordinal 0 as out of range
        // (BACKLOG №504) — so every single-attachment letter had nothing to
        // download.
        assert_eq!(
            checked_attachment_ordinal(0),
            Ok(0),
            "ordinal 0 is the FIRST attachment and must pass the bound"
        );
        assert_eq!(checked_attachment_ordinal(1), Ok(1));
        assert_eq!(checked_attachment_ordinal(9999), Ok(9999));
        let refused = |ordinal: i64| {
            checked_attachment_ordinal(ordinal)
                .expect_err("an out-of-range ordinal must be refused")
                .detail
        };
        assert_eq!(refused(-1), Some("ordinal_out_of_range".to_string()));
        assert_eq!(refused(10000), Some("ordinal_out_of_range".to_string()));
    }

    /// Like `one_shot_server`, but the server gives up after `patience` when no
    /// request arrives: a guard that refuses BEFORE dispatch must show up as
    /// `None`, not hang the test on `accept`.
    fn one_shot_server_or_silence(
        reply: String,
        patience: Duration,
    ) -> (String, thread::JoinHandle<Option<Vec<u8>>>) {
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        source.set_nonblocking(true).unwrap();
        let source_addr = source.local_addr().unwrap();
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + patience;
            loop {
                match source.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let mut request = [0_u8; 4096];
                        let read = stream.read(&mut request).unwrap_or(0);
                        write!(stream, "{reply}").unwrap();
                        return Some(request[..read].to_vec());
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return None;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return None,
                }
            }
        });
        (format!("http://{source_addr}"), server)
    }

    /// The request line the server sees for one `download_attachment` call, or
    /// `None` when the client refused before dispatching. The stand answers 404 so
    /// nothing is ever written under `Downloads/Skipi/Crewing` by a test.
    fn attachment_request_line(ordinal: i64) -> (Option<String>, PilotBridgeError) {
        let (base, server) = one_shot_server_or_silence(
            json_reply("404 Not Found", "{\"detail\":\"Not Found\"}"),
            Duration::from_millis(1500),
        );
        let context = snapshot_context(&settings(&base), &expected(&base)).unwrap();
        let result = download_attachment(&context, "intake-1", ordinal, None);
        let request = server
            .join()
            .unwrap()
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .map(|text| text.lines().next().unwrap_or("").to_string());
        let err = result.expect_err("the stand answers 404, so the download must not succeed");
        (request, err)
    }

    #[test]
    fn attachment_download_asks_the_server_for_the_ordinal_it_issued() {
        // Measured on the REAL request line, not on source tokens: the ordinal the
        // screen passes is the ordinal in the path, unshifted, and the first
        // attachment (0) is dispatched, not refused (№504: the K2.1 client turned
        // every single-attachment letter into `ordinal_out_of_range`).
        for ordinal in [0_i64, 7] {
            let (request, err) = attachment_request_line(ordinal);
            assert_eq!(
                request.as_deref(),
                Some(
                    format!(
                        "GET /api/crewings/crew-test/candidate-intake/intake-1/attachments/{ordinal} HTTP/1.1"
                    )
                    .as_str()
                ),
                "ordinal {ordinal} must reach the server as /attachments/{ordinal}: \
                 attachments are counted from zero and the client adds nothing \
                 (client answer was kind={} detail={:?})",
                err.kind,
                err.detail
            );
            assert_eq!(err.kind, "server", "the server's own answer comes back");
            assert_eq!(err.status, Some(404));
        }
    }

    #[test]
    fn out_of_range_ordinals_are_refused_before_any_dispatch() {
        // The same function, the same stand: -1 and 10000 never open a connection.
        for ordinal in [-1_i64, 10000] {
            let (request, err) = attachment_request_line(ordinal);
            assert_eq!(
                request, None,
                "ordinal {ordinal} is out of range and must not be dispatched"
            );
            assert_eq!(err.kind, "invalid_request");
            assert_eq!(err.detail, Some("ordinal_out_of_range".to_string()));
        }
    }

    // ================= No.637/S6: THE SEAM, ON SERVER BYTES =================
    //
    // Eight green checks watched `applicability`, `applicability_reason` and
    // `withheld_profiles` never reach the screen. They stayed green because they
    // hand their own fixtures straight to the renderer and never cross THIS
    // boundary, where `serde` drops a key no field declares - silently, without
    // failing the parse.
    //
    // So the fixtures below are not written here. They are the VERBATIM response
    // bodies of the running pilot server, captured on 2026-10-02 from the S5
    // stand (`GET /api/crewings/{crewing}/candidate-intake/{intake}/ranks` and
    // the queue row of `GET .../candidate-intake`), pasted in by machine. A
    // fixture typed by the hand that writes the struct is missing exactly the
    // field that hand forgot; a fixture taken off the wire is not.
    //
    // And the assertion is a WALK, not a list of names, for the same reason: a
    // list of names is written by that same hand. Every key the server put on
    // the wire must still be there after the value has crossed the bridge, so a
    // field added to the server tomorrow and forgotten here goes RED instead of
    // silently becoming a no-op on a screen whose renderer tests stay green.

    /// Rizal Santos: two evaluated profiles (`same` and `not_applicable`) and
    /// THREE profiles withheld by rank. Verbatim server bytes.
    const LIVE_RANKS_MIXED: &str = r#"{"items":[{"profile_id":"a5fb41a9-4399-4341-9f7a-d7eb3d20f825","profile_version":1,"primary":true,"met":[],"missing":["rank"],"unconfirmed":["certificate:Advanced Oil Tanker Operations","certificate:Bridge Resource Management","certificate:STCW II/2 Master"],"reasons":[{"requirement":"rank","outcome":"missing","wanted":"Master","found":"Able Seaman"},{"requirement":"certificate:STCW II/2 Master","outcome":"unconfirmed_fact","wanted":"held","found":null},{"requirement":"certificate:Advanced Oil Tanker Operations","outcome":"unconfirmed_fact","wanted":"held","found":null},{"requirement":"certificate:Bridge Resource Management","outcome":"unconfirmed_fact","wanted":"held","found":null}],"decided":false,"stale":false,"stale_reason":null,"applicability":"not_applicable","applicability_reason":null},{"profile_id":"55a34bab-c7f4-4c2c-a6b7-d3b4e6ba6c40","profile_version":1,"primary":false,"met":[],"missing":["rank"],"unconfirmed":["certificate:Basic Safety Training","certificate:STCW II/5","certificate:Tanker Familiarisation (Oil)"],"reasons":[{"requirement":"rank","outcome":"missing","wanted":"Able Seaman (AB)","found":"Able Seaman"},{"requirement":"certificate:STCW II/5","outcome":"unconfirmed_fact","wanted":"held","found":null},{"requirement":"certificate:Basic Safety Training","outcome":"unconfirmed_fact","wanted":"held","found":null},{"requirement":"certificate:Tanker Familiarisation (Oil)","outcome":"unconfirmed_fact","wanted":"held","found":null}],"decided":false,"stale":true,"stale_reason":"facts_changed","applicability":"same","applicability_reason":null}],"unranked_active_profiles":[],"withheld_profiles":[{"profile_id":"cd8ffb2f-24ec-46ea-b309-c13009068f41","name":"Chief Officer — Bulk Carrier (Panamax)","applicability":"not_applicable","applicability_reason":null},{"profile_id":"54e0d056-cffb-4cfa-87cf-e87e2bce6fc0","name":"2nd Engineer — Container 4500 TEU","applicability":"not_applicable","applicability_reason":null},{"profile_id":"9435cccb-1cb0-4673-ad5d-c5c582c2746c","name":"Bosun — Chemical Tanker","applicability":"not_applicable","applicability_reason":null}],"confirmations":[{"profile_id":"a5fb41a9-4399-4341-9f7a-d7eb3d20f825","profile_version":1,"confirmed_by":"stand637-operator","confirmed_at":"2026-10-02T11:15:24.218120","id":"6ee4211c-4cf0-4fe1-9fd1-bcda2a5ca7a6","withdrawn_by":"stand637-operator","withdrawn_at":"2026-10-02T11:22:28.318520"},{"profile_id":"a5fb41a9-4399-4341-9f7a-d7eb3d20f825","profile_version":1,"confirmed_by":"stand637-operator","confirmed_at":"2026-10-02T11:22:54.157699","id":"cad862d4-912c-4679-91f6-f02decd4d805","withdrawn_by":null,"withdrawn_at":null}]}"#;

    /// Oleh Ivanenko: five rows whose rank nobody could read -- `unknown` with
    /// `applicability_reason: "rank_absent"`, the case No.642 folds into one
    /// block. Verbatim server bytes.
    const LIVE_RANKS_UNREAD: &str = r#"{"items":[{"profile_id":"55a34bab-c7f4-4c2c-a6b7-d3b4e6ba6c40","profile_version":1,"primary":false,"met":[],"missing":[],"unconfirmed":[],"reasons":[],"decided":false,"stale":false,"stale_reason":null,"applicability":"unknown","applicability_reason":"rank_absent"},{"profile_id":"54e0d056-cffb-4cfa-87cf-e87e2bce6fc0","profile_version":1,"primary":false,"met":[],"missing":[],"unconfirmed":[],"reasons":[],"decided":false,"stale":false,"stale_reason":null,"applicability":"unknown","applicability_reason":"rank_absent"},{"profile_id":"a5fb41a9-4399-4341-9f7a-d7eb3d20f825","profile_version":1,"primary":false,"met":[],"missing":[],"unconfirmed":[],"reasons":[],"decided":false,"stale":false,"stale_reason":null,"applicability":"unknown","applicability_reason":"rank_absent"},{"profile_id":"cd8ffb2f-24ec-46ea-b309-c13009068f41","profile_version":1,"primary":false,"met":[],"missing":[],"unconfirmed":[],"reasons":[],"decided":false,"stale":false,"stale_reason":null,"applicability":"unknown","applicability_reason":"rank_absent"},{"profile_id":"9435cccb-1cb0-4673-ad5d-c5c582c2746c","profile_version":1,"primary":false,"met":[],"missing":[],"unconfirmed":[],"reasons":[],"decided":false,"stale":false,"stale_reason":null,"applicability":"unknown","applicability_reason":"rank_absent"}],"unranked_active_profiles":[],"withheld_profiles":[],"confirmations":[]}"#;

    /// The QUEUE row of the same two candidates, as the list route emits it:
    /// `summary.ranks_withheld` and `summary.profile_ranks[].applicability` are
    /// the second surface of the same answer. Verbatim server bytes.
    const LIVE_QUEUE_ROW_MIXED: &str = r#"{"intake_id":"bd58673d-ff38-4cce-b194-585d9f8d0bd3","receipt_id":"1f00cb62-db2c-46cd-b3be-d788c30e3862","crewing_id":"cd3e5f75-5a4b-4a43-8f97-137b6fee50c6","source":"skipi_response","source_id":"a5fb41a9-4399-4341-9f7a-d7eb3d20f825","event_id":"11ba6eb6-8b00-4797-ae8b-dfb13b0f3aec","primary_profile_id":"a5fb41a9-4399-4341-9f7a-d7eb3d20f825","content_sha256":"03d040b19259b380c5c78a33c3849036d48060ed9e3422fcbe259f8e76d3e874","content_bytes":3962,"content_type":"message/rfc822","state":"ranked","source_trust":"unverified","version":1,"created_at":"2026-10-02T11:02:12.203588","issued_at":"2026-10-02T11:02:12.203588","objects":[{"id":"98ec6bda-3b0d-47e3-beca-2a36afc124fc","content_type":"message/rfc822"}],"attachments":[],"summary":{"state":"ranked","facts":4,"ranks":2,"ranks_stale":1,"ranks_withheld":3,"active_confirmations":1,"needs_review_reason":null,"profile_ranks":[{"profile_id":"a5fb41a9-4399-4341-9f7a-d7eb3d20f825","profile_version":1,"met":0,"missing":1,"unconfirmed":3,"total":4,"stale":false,"applicability":"not_applicable","applicability_reason":null},{"profile_id":"55a34bab-c7f4-4c2c-a6b7-d3b4e6ba6c40","profile_version":1,"met":0,"missing":1,"unconfirmed":3,"total":4,"stale":true,"applicability":"same","applicability_reason":null}],"candidate_name":"Rizal Santos"},"response_headline":{"rank":"Master","rank_state":"from_snapshot","first_name":"Rizal","surname":"Santos"}}"#;
    const LIVE_QUEUE_ROW_UNREAD: &str = r#"{"intake_id":"b80e281a-a3da-4690-93a8-74c047631f63","receipt_id":"2b60ea21-bacf-42a6-9988-357ddba7a569","crewing_id":"cd3e5f75-5a4b-4a43-8f97-137b6fee50c6","source":"synthetic","source_id":"stand637-ivanenko","event_id":"8c214142-c963-4291-9bd4-6949bdbd6fb8","primary_profile_id":null,"content_sha256":"b1b2d5838b4e2bdceb20827bf7168931d93da66b8b28234be8ec77309646d465","content_bytes":2276,"content_type":"application/pdf","state":"ranked","source_trust":"unverified","version":1,"created_at":"2026-10-02T11:01:20.818383","issued_at":"2026-10-02T11:01:20.818383","objects":[{"id":"b3c0d65d-4bc4-4458-a92a-38c9582153c0","content_type":"application/pdf"}],"attachments":[],"summary":{"state":"ranked","facts":6,"ranks":5,"ranks_stale":0,"ranks_withheld":0,"active_confirmations":0,"needs_review_reason":null,"profile_ranks":[{"profile_id":"55a34bab-c7f4-4c2c-a6b7-d3b4e6ba6c40","profile_version":1,"met":0,"missing":0,"unconfirmed":0,"total":0,"stale":false,"applicability":"unknown","applicability_reason":"rank_absent"},{"profile_id":"54e0d056-cffb-4cfa-87cf-e87e2bce6fc0","profile_version":1,"met":0,"missing":0,"unconfirmed":0,"total":0,"stale":false,"applicability":"unknown","applicability_reason":"rank_absent"},{"profile_id":"a5fb41a9-4399-4341-9f7a-d7eb3d20f825","profile_version":1,"met":0,"missing":0,"unconfirmed":0,"total":0,"stale":false,"applicability":"unknown","applicability_reason":"rank_absent"},{"profile_id":"cd8ffb2f-24ec-46ea-b309-c13009068f41","profile_version":1,"met":0,"missing":0,"unconfirmed":0,"total":0,"stale":false,"applicability":"unknown","applicability_reason":"rank_absent"},{"profile_id":"9435cccb-1cb0-4673-ad5d-c5c582c2746c","profile_version":1,"met":0,"missing":0,"unconfirmed":0,"total":0,"stale":false,"applicability":"unknown","applicability_reason":"rank_absent"}],"candidate_name":"Oleh Ivanenko"},"response_headline":null}"#;

    /// The ONLY keys allowed to leave the bridge absent, and ONLY when the
    /// server sent them as `null`. Each one IS declared and carries
    /// `skip_serializing_if = "Option::is_none"` deliberately, documented on its
    /// struct: to a webview `undefined` and `null` are the same answer, and
    /// `candidate_name` needs an absence to stay an absence.
    ///
    /// This is an EXEMPTION list, never a list of required names, and the
    /// direction is the whole point: forget a name here and the test goes RED.
    /// The old shape of this check - a hand-written list of names that must be
    /// present - went green on everything its author forgot, which is how
    /// `applicability` reached no screen while eight checks watched.
    const NULL_MAY_VANISH: &[&str] = &["response_headline", "response_summary", "candidate_name"];

    /// Every key of `sent` must be present in `arrived`, recursively, and the
    /// scalar leaves must be EQUAL. Objects are compared by key; arrays element
    /// by element. `arrived` may carry more (a client-side default is not a
    /// defect); it may never carry less, and it may never carry a different
    /// value under the same name.
    fn assert_wire_survives(sent: &Value, arrived: &Value, path: &str) {
        match sent {
            Value::Object(keys) => {
                let got = arrived.as_object().unwrap_or_else(|| {
                    panic!("{path}: the server sent an object, the bridge produced {arrived}")
                });
                for (key, value) in keys {
                    let next = format!("{path}.{key}");
                    let seen = match got.get(key) {
                        Some(seen) => seen,
                        // a declared field that serialises its own `null` away
                        None if value.is_null() && NULL_MAY_VANISH.contains(&key.as_str()) => {
                            continue
                        }
                        None => panic!(
                            "{next}: the server sent this key and the bridge DROPPED it. \
                             Declare the field on the struct - serde discards what no field names."
                        ),
                    };
                    assert_wire_survives(value, seen, &next);
                }
            }
            Value::Array(items) => {
                let got = arrived.as_array().unwrap_or_else(|| {
                    panic!("{path}: the server sent an array, the bridge produced {arrived}")
                });
                assert_eq!(items.len(), got.len(), "{path}: the array changed length");
                for (i, value) in items.iter().enumerate() {
                    assert_wire_survives(value, &got[i], &format!("{path}[{i}]"));
                }
            }
            leaf => assert_eq!(leaf, arrived, "{path}: the value changed across the bridge"),
        }
    }

    #[test]
    fn the_rank_list_carries_every_key_the_live_server_sent() {
        for (label, body) in [("mixed", LIVE_RANKS_MIXED), ("unread", LIVE_RANKS_UNREAD)] {
            let sent: Value = serde_json::from_str(body).unwrap();
            let typed: CandidateRanksResponse = serde_json::from_str(body)
                .unwrap_or_else(|e| panic!("{label}: the live body must parse: {e}"));
            let arrived = serde_json::to_value(&typed).unwrap();
            assert_wire_survives(&sent, &arrived, &format!("${label}"));
        }
    }

    #[test]
    fn the_three_fixes_read_their_values_off_the_live_body_not_a_fixture() {
        // (a) No.642 / the unread fold: five rows, every one of them `unknown`
        // WITH its reason. `cardApplicabilityRowSplit` folds on exactly this.
        let unread: CandidateRanksResponse = serde_json::from_str(LIVE_RANKS_UNREAD).unwrap();
        assert_eq!(unread.items.len(), 5);
        for row in &unread.items {
            assert_eq!(row.applicability.as_deref(), Some("unknown"), "{row:?}");
            assert_eq!(row.applicability_reason.as_deref(), Some("rank_absent"));
        }

        // (b) No.644 / the honest sentence: a verdict that is NOT unknown reaches
        // the screen as itself, and `not_applicable` is what hides a row.
        let mixed: CandidateRanksResponse = serde_json::from_str(LIVE_RANKS_MIXED).unwrap();
        let verdicts: Vec<&str> = mixed
            .items
            .iter()
            .map(|row| row.applicability.as_deref().unwrap_or("<dropped>"))
            .collect();
        assert!(verdicts.contains(&"same"), "{verdicts:?}");
        assert!(verdicts.contains(&"not_applicable"), "{verdicts:?}");

        // (c) the withheld disclosure: NAMED profiles, not a count.
        assert_eq!(mixed.withheld_profiles.len(), 3);
        for withheld in &mixed.withheld_profiles {
            assert!(!withheld.profile_id.is_empty());
            assert!(!withheld.name.is_empty(), "the disclosure names the profile");
            assert_eq!(withheld.applicability.as_deref(), Some("not_applicable"));
        }
        assert_eq!(unread.withheld_profiles.len(), 0, "nothing withheld for an unread rank");
    }

    #[test]
    fn the_queue_row_carries_every_key_the_live_server_sent() {
        for (label, body) in [
            ("mixed", LIVE_QUEUE_ROW_MIXED),
            ("unread", LIVE_QUEUE_ROW_UNREAD),
        ] {
            let sent: Value = serde_json::from_str(body).unwrap();
            let typed: CandidateIntakeReceipt = serde_json::from_str(body)
                .unwrap_or_else(|e| panic!("{label}: the live queue row must parse: {e}"));
            let arrived = serde_json::to_value(&typed).unwrap();
            assert_wire_survives(&sent, &arrived, &format!("${label}"));

            // and the values the row itself renders
            let summary = typed.summary.as_ref().expect("the queue row carries a summary");
            for rank in summary.profile_ranks.as_ref().expect("stored evaluations ride along") {
                assert!(
                    rank.applicability.is_some(),
                    "{label}: the row's own verdict was dropped on the way to the webview"
                );
            }
        }
        let mixed: CandidateIntakeReceipt = serde_json::from_str(LIVE_QUEUE_ROW_MIXED).unwrap();
        assert_eq!(mixed.summary.unwrap().ranks_withheld, 3);
        let unread: CandidateIntakeReceipt = serde_json::from_str(LIVE_QUEUE_ROW_UNREAD).unwrap();
        assert_eq!(unread.summary.unwrap().ranks_withheld, 0);
    }

    /// The press of "Compare" answers with its own count of what it did NOT
    /// evaluate. There is no GET for this body, so it is not captured from the
    /// stand: it is the shape the route is VALIDATED against
    /// (`response_model=CandidateRankResponse`, `routers/candidate_intake.py:1022`)
    /// and asserted on a live HTTP response by the server's own suite
    /// (`tests/test_crewing_p2_622_rank_applicability.py:1192`). Provenance is
    /// named here rather than left to look like a capture.
    #[test]
    fn the_compare_press_keeps_the_count_of_what_it_withheld() {
        let body = r#"{"ranked":2,"written":0,"withheld":2,"reason":"ranked","profiles":["p-1","p-2"]}"#;
        let sent: Value = serde_json::from_str(body).unwrap();
        let typed: CandidateRankResponse = serde_json::from_str(body).unwrap();
        assert_eq!(typed.withheld, 2, "the screen says `2/0` and nothing about the two it skipped");
        assert_wire_survives(&sent, &serde_json::to_value(&typed).unwrap(), "$rank");
    }

    /// THE COMPATIBILITY NEGATIVE. A pilot server from before No.622 sends none
    /// of these keys. The parse must SUCCEED and every new field must come back
    /// absent - not a default verdict, not a zero that reads as an answer.
    /// `cardApplicability` turns that absence into `stated:false`, which renders
    /// exactly as the card rendered before any of this existed.
    #[test]
    fn an_older_server_without_the_new_keys_still_parses() {
        let old_ranks = r#"{"items":[{"profile_id":"p-1","profile_version":1,"primary":true,
            "met":["rank"],"missing":[],"unconfirmed":[],
            "reasons":[{"requirement":"rank","outcome":"met"}],
            "decided":true,"stale":false}],
            "unranked_active_profiles":[],"confirmations":[]}"#;
        let ranks: CandidateRanksResponse = serde_json::from_str(old_ranks)
            .expect("an older server must not fail the parse of the whole card");
        assert_eq!(ranks.items[0].applicability, None, "absent is not a verdict");
        assert_eq!(ranks.items[0].applicability_reason, None);
        assert!(ranks.withheld_profiles.is_empty(), "absent is an empty disclosure");

        let old_rank_press = r#"{"ranked":1,"written":1,"reason":"ranked","profiles":["p-1"]}"#;
        let press: CandidateRankResponse = serde_json::from_str(old_rank_press).unwrap();
        assert_eq!(press.withheld, 0, "absent is nothing withheld, and the screen prints no note");

        let old_row = r#"{"intake_id":"i-1","receipt_id":"r-1","crewing_id":"c-1",
            "source":"inbound","source_id":"m-1","event_id":"e-1","primary_profile_id":null,
            "content_sha256":"abc","content_bytes":9,"content_type":"text/plain",
            "state":"ranked","source_trust":"inbound_alias","version":1,
            "created_at":"2026-10-02T00:00:00","issued_at":"2026-10-02T00:00:00",
            "summary":{"state":"ranked","facts":1,"ranks":1,"ranks_stale":0,
                "active_confirmations":0,"needs_review_reason":null,
                "profile_ranks":[{"profile_id":"p-1","profile_version":1,"met":1,
                    "missing":0,"unconfirmed":0,"total":1,"stale":false}]}}"#;
        let row: CandidateIntakeReceipt = serde_json::from_str(old_row)
            .expect("an older server must not fail the parse of a queue row");
        let summary = row.summary.unwrap();
        assert_eq!(summary.ranks_withheld, 0);
        assert_eq!(summary.profile_ranks.unwrap()[0].applicability, None);
    }
    // =============== No.637/S6: THE SEAM, ON SERVER BYTES END ===============
}
