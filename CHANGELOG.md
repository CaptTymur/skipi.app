# Changelog

All notable changes to Skipi (seafarer client) are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer 0.x](https://semver.org/) with patch bumps for
every released slice.

## [Unreleased]

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
