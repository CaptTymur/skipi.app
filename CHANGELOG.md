# Changelog

All notable changes to Skipi (seafarer client) are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer 0.x](https://semver.org/) with patch bumps for
every released slice.

## [Unreleased]

## [0.4.148] — 2026-06-20

### Fixed
- Profile validation now points you at what's missing: failed required fields get
  a red outline, the form scrolls to and focuses the first one, and the outline
  clears as you type — instead of just listing field names in an error bar.
- Added a hint under "Ready to accept job offers" explaining it adds the
  availability fields (phones, airports, available date, salary), so users who
  just want the basics can turn it off and finish faster.

## [0.4.147] — 2026-06-20

### Fixed
- The "Complete your Seafarer Profile" prompt can now be dismissed: a close (×)
  button and a "Skip for now" button let you explore the app without filling it
  (Jobs/Mailings stay gated until it's complete; the prompt returns next time the
  vault opens).
- Added an "Already set up Skipi on your phone or another device?" shortcut in
  that prompt with "Open existing vault" and "Import backup" actions, so a profile
  created on mobile can be brought over instead of re-entered.

## [0.4.146] — 2026-06-19

### Added
- CV (DOCX and PDF) now includes an "Experience by position" section totalling
  time served in each rank in years, months, and days, and appends a per-contract
  duration to each sea-going experience line.
- Added Trainee, Apprentice, Deck Boy, and Welder to the rank taxonomy used by the
  Sea Service position selector and seafarer profile.

## [0.4.139] — 2026-05-24

### Added
- Added a top-bar Salary Index chip next to profile completeness, using the
  public Skipi.info Vacancy Index when a matching profile benchmark exists.
- Added an anonymous Tauri bridge for fetching the public Skipi.info index
  without sending profile, vessel, or vault data to the website.

### Changed
- Reworked the Information module into an embedded Skipi.info view with quick
  access to the public site and methodology.

## [0.4.138] — 2026-05-24

### Changed
- Reworked Mailings from three tabs into a two-step wizard: choose scenario,
  then review recipients and send.
- Show unlocked Skipi database address counts and matching crewing request
  counts before entering the send form.
- Disable the crewing-request scenario when no matching requests with recipient
  addresses are available.

## [0.4.137] — 2026-05-23

### Added
- Added India to the Information country baseline fallback.
- Added quick document-tree filters for required, missing, expiring, uploaded,
  and custom documents.

### Changed
- Renamed `Files & data input` to `Documents`.
- Simplified the Sea Service cards, Country baseline table, Jobs readiness
  strip, and Mailings copy/layout for a denser beta UI.
- Dashboard is no longer shown as a top-level module; the profile-completeness
  chip opens it directly.

## [0.4.136] — 2026-05-23

### Added
- Added the `Рассылки -> База агентств` flow with a bundled seed of 50 public
  crewing/recruitment inboxes across Ukraine, Russia, India, Philippines, and
  Indonesia.
- Added a visible profile-completeness chip in the top bar; agency-database
  mailing unlocks addresses proportionally to profile completeness.
- Added a final confirmation step for agency-database mass mailing showing
  bucket, recipient count, profile completeness, and locked address count.

### Changed
- Reworked `Рассылки` into three explicit tabs: manual recipients, agency
  database, and crewing mailing requests.

## [0.4.135] — 2026-05-21

### Added
- Added a custom document context menu on document-tree sections and a visible
  dashboard action for adding custom certificates.
- Added stronger selected-state styling for the active certificate.
- Added Sea Service edit-form access to already attached supporting files.
- Added hard searchable controls for Sea Service vessel names and flags.
- Added broad fleet grouping in seafarer and vessel setup wizards: Merchant
  Fleet, Passenger / Ro-Pax, and Offshore & Energy.

### Changed
- Disabled the native right-click context menu in the app shell.
- Ready-for-offers now disables offer-specific profile fields when off.

## [0.4.134] — 2026-05-19

### Added
- Added Cadet, Junior Officer, and Junior Engineer to the seafarer rank and
  position catalog.
- Added custom rank and Sea Service position entry paths for real-world roles
  that are not yet in the preset catalog.
- Added architecture epics for future production backend work and
  trust/verification, plus a lightweight business-rules register for beta
  discoveries.

## [0.4.133] — 2026-05-19

### Added
- Added a per-certificate permanent validity option for rare no-expiry
  certificates.
- Yellow Fever Vaccination now defaults to permanent validity while preserving
  any manually entered expiry date if the flag is later disabled.

### Changed
- Certificate status, CV export, job-apply summaries, and document package
  manifests now carry permanent certificate state explicitly.

## [0.4.119] — 2026-05-11

### Added
- Added automatic API fallback from `https://api.skipi.app` to
  `https://api-ru.skipi.app` for users whose networks cannot reach the primary
  Contabo-hosted API.
- Native Tauri commands now use the same fallback path for jobs, public board
  counters, applications, E2E messaging, and encrypted chat attachments.

## [0.4.118] — 2026-05-11

### Added
- Added a local-only Skipi builders group invite gate for real beta users:
  seafarer vaults now show the Telegram invite only after the active profile
  reaches at least 85% completeness and the user has added Sea Service.
- Demo vaults are excluded from the invite gate so casual demo exploration does
  not grant access to the developer feedback group.

## [0.4.113] — 2026-05-08

### Added
- Sea Service entries now support optional DWT and TEU capacity fields.
- Dispatch/package/job-apply messages now include a short last-vessel summary
  in the email/chat body so crewing teams can screen rank, vessel type, IMO,
  capacity, dates, and company before opening attachments.

## [0.4.112] — 2026-05-08

### Fixed
- Document attachments now use a stable per-document filename suffix instead of
  title-only filenames, preventing two same-titled certificate slots from
  overwriting or displaying the same physical file.
- Deleting a non-required document no longer removes the underlying file if
  another document row still references it.
- The document view now warns when the same attached file hash appears under
  another certificate, helping testers catch misfiled uploads immediately.
- Synchronized visible app version fields for the release artifact gate.

### Added
- Added a synthetic certificate upload smoke test that creates a test vault,
  attaches generated files to multiple certificate slots, and verifies every
  slot keeps its own file marker.
- Added `scripts/pre_release_smoke.py`, an automated pre-release smoke runner
  covering version consistency, local-first privacy gates, backup/export
  safeguards, demo vault sanity, config/log secret scans, and vault attachment
  integrity warnings.

## [0.4.108] — 2026-05-06

### Fixed
- macOS tester release now uses the active Intel GitHub runner label
  `macos-15-intel`.
- Windows tester release now disables only the Authenticode config file during
  CI, preserving Tauri updater `.sig` artifact generation.

## [0.4.107] — 2026-05-06

### Fixed
- Windows tester builds now pass `--no-sign`, so the legacy
  `tauri.windows.conf.json` Authenticode hook is not executed while Azure
  Trusted Signing is not configured. Tauri updater signatures are still
  required.

## [0.4.106] — 2026-05-06

### Changed
- Release pipeline now builds Linux, unsigned macOS Intel, and unsigned Windows
  test artifacts for every tester release. All three platform jobs are
  mandatory; `latest.json` refuses to publish if any platform updater artifact
  or signature is missing.

## [0.4.105] — 2026-05-06

### Fixed
- Prevented drag-and-drop replacement from freezing the UI by bounding inline
  document preview size and making upload auto-scan opt-in.
- Moved AI recognition work off the Tauri UI path so long local/cloud OCR calls
  do not block the application window.
- Changing seafarer rank or vessel type now updates the active document
  framework additively, so promotion to Master adds management-level slots such
  as Ship Security Officer without deleting existing documents.
- Known certificates typed through Add document (for example Ship Security
  Officer) are normalized to their regulatory template IDs instead of remaining
  custom rows; custom-only documents can now be deleted from the document view.
- Added Radar Navigation / Radar Plotting / ARPA as a separate deck-training
  requirement for deck officers, and added an explicit requirements-changed
  notice plus Required/Custom/History visual markers in the document tree.
- Added the `STCW Specific` document class for known conditional regulatory
  certificates, including Polar Waters Basic/Advanced (Ice Navigation) training,
  so they are not treated as custom and are not marked mandatory for every ship.
- Added fixed conditional flag-state sections for Flag CoC Endorsement and
  Flag Seaman's Book, with `FLAG` markers and template normalization instead of
  treating them as custom certificates.
- Added the bulk/dangerous-cargo training certificate for dangerous and
  hazardous substances in solid bulk or packaged form as a fixed
  `Bulk Carrier Specific` catalog-only template: it normalizes real uploaded
  certificates but no longer appears as an empty slot for every bulker profile.
- Non-hard-required template rows can now be deleted manually from the document
  view, including historical `Old` rows and conditional STCW/flag-state slots;
  deleted conditional slots stay hidden until the user adds them again or they
  become part of the active required framework.
- Renamed the deck-officer ECDIS requirement to `ECDIS Generic Training` and
  added `ECDIS Specific` as a repeatable user-added category for equipment
  type-specific certificates such as Furuno or JRC.
- Reworked `Dispatch` into `Рассылки`: seafarers can still send CV/documents
  to manual email addresses, and can also load recipient addresses from
  accredited agency CV-mailing requests published on skipi.app.
- Added the `База судов` module for seafarers: vessel cards are derived only
  from Sea Service entries with valid IMO numbers, and adding Sea Service or
  submitting vessel reviews now requires attached files for every document in
  the active minimum document structure.
- Removed pictographic icons from the top module navigation for a cleaner,
  text-only module bar.
- Added the first Minimum Safety Pack item: vault backup export/import from
  Settings > Vaults. Export writes a full ZIP backup with a consistent SQLite
  snapshot and local attachments; import restores into a new folder and opens it
  only after validating the database.

## [0.4.104] — 2026-05-04

### Added
- **Vessel Reviews MVP** — Sea Service now shows public vessel review
  projections by IMO and lets seafarers submit structured contract reviews
  against the live `review_schema v1`.
- Added a separate review identity stored under `_identity/review_sk.bin`,
  kept apart from the crewing-facing vault identity. Review submissions send
  only the review pubkey for server-side HMAC derivation and a local
  experience hash for per-contract deduplication.
- Added schema-driven review form with Quick / Detailed / N/A per section,
  warning flags, local draft autosave, live validation, and submit-to-moderation.

## [0.4.103] — 2026-05-03

### Added
- **Slice F4-lite** — pre-apply gap modal: differentiated banner copy by
  repair kind. Missing-slot creation now offers `Upload now` (file picker)
  alongside `Apply anyway`; expired/no_file repairs keep `Apply now`.
  Successful file attach on a `missing` pending promotes the recheck
  state to `file_attached` so the follow-up banner shows the correct
  copy and primary action.

## [0.4.102] — 2026-05-03

### Added
- **Slice F3-lite** — recheck-after-repair: a targeted repair triggered
  from a vacancy gap modal stamps a 5-minute pending state. When the
  matching file/expiry actually lands, a bottom-right action banner
  offers `Apply now` (re-runs the full gap check via `jobsApply`) or
  `Dismiss`. Random edits in the Documents view never trigger the
  banner.
- Helper plumbing: `_slfPendingRecheck` state, TTL-aware lookup,
  last-wins replace, locally-hidden vacancy auto-unhide on `Apply now`.

## [0.4.101] — 2026-05-03

### Added
- **Slice F2-lite** — gap modal grew per-cert detail rows with deep-link
  CTAs:
  - `Add document →` for missing certs creates a template-backed row via
    the new `add_catalog_doc` Tauri command (so the row contributes to
    server-side compliance assessment, unlike `add_custom_doc`).
  - `Update expiry →` for expired certs deep-links to the existing vault
    row, focuses the expiry input, and pulses the field.
  - `Upload file →` for no-file certs deep-links to the row and pulses
    the file drop zone (no auto-open of the file picker).
- Sticky modal footer with `Review all documents` + `Apply anyway`.
- 2-second pulse highlight reused across all deep-links.

## [0.4.100] — 2026-05-03

### Added
- **Slice F** — pre-apply compliance gap warning. Before sending an
  application the seafarer client mirrors the server's Slice B/D logic
  locally (`_slfRequiredCertIds`, `_slfBestStatus`, `computeApplyGaps`)
  and surfaces a modal listing missing/expired/no-file blockers when
  any are present. Modal offers `Review documents` (no apply, no
  analytics ping) and `Apply anyway`. Compliant applications skip the
  modal entirely.
- `jobsApply` refactored to defer in-flight flag and `job_apply_click`
  analytics until after the gap check — pressing `Review documents` no
  longer leaves the vacancy stuck in an in-flight state.

## [0.4.99 and earlier]

See git history. Notable highlights:
- 0.4.99 — Slice C: schematized application summary with `certs_summary[]`
  for compliance assessment by crewing managers.
- 0.4.78 — last manifest-tagged release (v0.4.96 tag misfire — versions
  did not bump, manifest reported 0.4.78 under the v0.4.96 release).
- 0.4.52 — Jobs module master toggle.
- 0.4.51 — installed mail clients detection on Windows + Dispatch routing.
