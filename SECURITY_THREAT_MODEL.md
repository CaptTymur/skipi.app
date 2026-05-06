# Skipi Security Threat Model

Status: working document
Owner: Tymur Rudov
Last reviewed: 2026-05-05

This document is the security map for the current Skipi architecture:

- Skipi seafarer desktop app: `/home/linux/Developer/skipi-public`
- Skipi public API / jobs board / reviews / relay: `/home/linux/Developer/skipi-server`
- Skipi Crewing desktop app: `/home/linux/Developer/skipi-crewing`

It is not a replacement for `SECURITY.md`. `SECURITY.md` tells outsiders how
to report a vulnerability. This file tells us what can go wrong and what must
be built before wider public release.

## Security Goal

The core goal is simple: a compromise of `api.skipi.app` must not become a
compromise of every seafarer's passports, certificates, medicals, contracts, or
full CV vault.

Skipi must keep this boundary:

- Local vault data belongs to the user's computer.
- The server coordinates public data, jobs, reviews, applications, and message
  relay.
- The server must not become a central cloud document vault by accident.

## Current Security Layer

### 1. Local-first vault boundary

Implemented:

- Seafarer documents, certificate scans, work history, generated CVs, and local
  package workflows live in the user's chosen vault folder.
- `skipi-server` describes itself as a dumb public board and does not store
  full seafarer profiles.
- Apply summaries are deliberately redacted. Server-side code strips
  certificate document numbers from `certs_summary[]` before persisting.

Important limitation:

- Local vault identity files currently live in `_identity/*.bin`.
- `identity.rs` states that the main Ed25519 vault key is unencrypted in
  phase 1 because an attacker with vault folder read access already has the
  documents.
- Review and messaging keys are separate, but also file-backed.

Required next step:

- Add OS keychain storage or optional vault passphrase protection for identity
  secrets without breaking portable vault folders.

### 2. Desktop distribution and updater trust

Implemented:

- Tauri updater verifies minisign signatures using a public key pinned in
  `src-tauri/tauri.conf.json`.
- Release/signing notes exist for SignPath / Windows Authenticode and macOS
  notarization.
- Public client repo has `SECURITY.md`.

Risks:

- The updater/release pipeline is the highest-impact target. If GitHub release
  permissions or updater signing secrets are compromised, an attacker may try to
  ship a malicious desktop build.
- The public client currently has `csp: null`.
- Tauri capabilities allow broad filesystem read/write. This is convenient for
  vault and package workflows but should be narrowed when the UI stabilizes.

Required next steps:

- Enforce hardware/passkey MFA on maintainer GitHub accounts.
- Protect `main` and release tags.
- Keep updater signing secret access limited to release workflows only.
- Add an emergency signing-key rotation and malicious-release recall runbook.
- Add a real CSP and test all inline frontend code against it.
- Narrow Tauri capabilities to the smallest practical vault/download/dialog
  surface.

### 3. Server auth and authorization

Implemented:

- Most server write/admin endpoints are behind bearer auth through
  `_require_admin(...)`.
- Publishing vacancies and mailing requests is MLC-gated and requires a
  verified crewing record.
- Public list endpoints use cursor/limit bounds.
- Applications are scoped to a vacancy; crewing-side application listing is
  admin-gated today.

Risks:

- `ADMIN_TOKEN` is a single shared v0.1 secret. It is not enough for production.
- There is no per-crewing token, scope, role, rotation, or revocation model yet.
- Some public counters (`apply-click`, `hide`, mailing clicks) are unauthenticated
  by design and can be inflated.
- CORS is permissive. Desktop app use makes this acceptable for now, but any
  future browser admin UI needs stricter origins and CSRF-aware design.

Required next steps:

- Replace shared `ADMIN_TOKEN` with per-organization credentials:
  `crewing_id`, token hash, scopes, status, created/revoked timestamps.
- Enforce object-level authorization: a crewing token can only access its own
  vacancies, applications, mailing requests, and threads.
- Add admin-only MFA or put admin endpoints behind Cloudflare Access/VPN.
- Add tests that prove a token for crewing A cannot read/modify crewing B data.

### 4. E2E messaging and attachments

Implemented:

- Messaging uses X25519/XSalsa20-Poly1305 via `crypto_box`.
- Server stores ciphertext and routing metadata only.
- Attachments are encrypted client-side and capped at 10 MB before upload.
- Attachment body fetch requires sender or recipient user_id.

Risks:

- `send_message` currently accepts any registered seafarer pubkey as a sender
  for a thread. The code comments explicitly mark this as a phase-2 MVP
  compromise.
- Attachment listing endpoint returns metadata for a whole thread without a
  user_id gate.
- Server-visible metadata remains sensitive: application ids, from/to user ids,
  timestamps, filenames, mime types, sizes, and crewing linkage.
- `PROD_API` is hardcoded in the seafarer messaging command layer, unlike other
  app areas that use configurable server URL.

Required next steps:

- Pin the seafarer pubkey/user_id at apply time and require that exact user_id
  for all later messages and attachments in that application thread.
- Require user_id authorization on attachment metadata listing.
- Consider hiding or minimizing original filenames in server metadata for
  high-risk document sends.
- Move messaging API base URL into app config/settings.

### 5. Vessel reviews

Implemented:

- Review identity is separate from crewing-facing identity.
- Client sends a review public key; server stores only
  `HMAC_SHA256(REVIEW_HASH_SECRET, review_pubkey)`.
- Raw review public key is not persisted.
- Structured reviews are schema-validated.
- Free text is redacted for email/phone-like patterns before public exposure.
- Reviews land in `pending` and require moderation.
- Public/free vessel lookup must not expose the full ratings dataset. Anonymous
  user ratings feed Skipi indexes, but full aggregates and detailed review
  excerpts require seafarer, verified crewing, paid data-license, or internal
  admin entitlement.

Risks:

- No production rate limiting yet.
- Moderation capacity is manual and can be overwhelmed.
- Text redaction is useful but not a legal/privacy guarantee.
- `REVIEW_HASH_SECRET` fallback is a dev string; production must always set a
  strong secret.
- Paid data-client distribution creates contractual and re-identification risk
  if we expose raw reviews, small samples, stable reviewer handles, or row-level
  exports.

Required next steps:

- Fail production startup if `REVIEW_HASH_SECRET` is missing or still dev-like.
- Rate limit review submit by IP, IMO, reviewer hash, and local experience hash.
- Add moderation queue tooling and abuse flags.
- Add public policy copy explaining that reviews are moderated and personal data
  must not be posted.
- Add entitlement checks for vessel ratings: seafarer member, verified/subscribed
  crewing, paid data-license client, internal admin.
- Legal rule for paid indexes: aggregate/index product only; no raw review rows,
  no reviewer identifiers, no small-sample slices, no re-identification, no
  onward resale without contract.

### 6. Seafarer identity dedup

Design rule:

- Public Skipi seafarer IDs must be random and non-derivable.
- Name + surname + date of birth may be used only to compute a private
  server-side HMAC fingerprint for dedup.
- The raw identity tuple must not be stored in the dedup table.
- A matching fingerprint from another vault must create a recovery/manual-merge
  flow, not a second public identity.
- Review identity remains separate from crewing/job identity.

Current phase:

- `POST /api/seafarer-identity/claim` creates `SKP-SF-...` public ids and
  stores only a server-secret HMAC fingerprint.
- This is `identity_claimed`, not document verification. Later phases need
  vault signatures, document/manual verification, recovery, and rate limiting.

### 7. Vessel DB anti-scraping and dataset extraction

Design rule:

- Skipi should not expose an unauthenticated public "list all vessels" API,
  browse feed, or rich full-text vessel search.
- Public vessel lookup may return basic identity/specification and public review
  availability teaser only. Full review aggregates and Skipi indexes are gated
  data.
- Commercial-manager linkage, operator intelligence, source confidence,
  provenance, email-derived signals, and private contact hints are gated data,
  not public vessel fields.
- Snapshot and delta sync endpoints must be tier-filtered. A free snapshot must
  not contain the rich layer, and an unauthenticated changes endpoint must not
  gradually leak it.

Required next steps:

- Add explicit `visibility`/tier rules for vessel facts:
  `public`, `authenticated`, `broker_match_only`, `broker_engage_only`,
  `internal`.
- Keep the Broker board invisible: no competitor-readable feed; discovery only
  through match queues.
- Add rate limits and anomaly detection for sequential IMO scans, name
  enumeration, high miss-rate lookups, and abnormal delta cadence.
- Audit every reveal of high-value fields: actor, field group, match/listing id,
  reason, timestamp.
- Watermark licensed snapshots with manifest/account ids and optional harmless
  canary variants.

### 8. Infrastructure and operational security

Implemented / documented:

- Contingency and Contabo exit-ready runbooks exist in the Skipi handoff vault.
- The desired production posture already says: Postgres via `DATABASE_URL`,
  off-provider backups, no installers or critical files only on VPS disk,
  object storage for server attachments, and API behind `api.skipi.app`.

Risks:

- Current local server defaults to SQLite.
- No visible production rate limiting, WAF, structured logs, request ids,
  metrics, uptime alerts, or backup restore drill in code yet.
- Startup still performs inline schema changes instead of versioned migrations.

Required next steps:

- Use Postgres for production and Alembic for migrations.
- Put API behind a reverse proxy/CDN/WAF with per-endpoint rate limits.
- Add structured logs with request ids.
- Add uptime and error alerts.
- Run a restore drill before public reviews/jobs launch.
- Add `/api/app-config` kill switches:
  reviews lookup, reviews submit, jobs, apply, messaging, sponsored slots,
  local-only mode.

## Main Attack Scenarios

### A. API denial of service

Impact:

- Jobs, reviews, apply, messaging, and taxonomy sync degrade.
- Local vault must continue working.

Defenses:

- Cloudflare/WAF/rate limiting.
- Read-heavy caching for taxonomy, catalogs, vessel summary, public reviews.
- Kill switches and local-only mode.
- Load test baseline before public launch.

### B. Server database compromise

Impact:

- Attacker may get vacancies, crewings, applications metadata, plaintext apply
  summaries, review records, E2E ciphertext, message metadata, attachment
  metadata, public keys, counters, and admin notes.
- Attacker should not get seafarer vault documents because they should not be
  on the server.

Defenses:

- Data minimization.
- Server never stores full vaults.
- E2E message/file content stays ciphertext.
- Encrypt backups.
- Keep `REVIEW_HASH_SECRET` and token hashes outside DB.
- Have an incident statement that can distinguish "server metadata" from
  "local vault documents".

### C. Malicious update / supply chain compromise

Impact:

- Highest severity. A bad desktop update can read local vaults.

Defenses:

- Protected tags and release workflow.
- Hardware/passkey MFA.
- Minimal GitHub secret access.
- Signed updater artifacts.
- Emergency signing-key rotation.
- Public security advisory path.

### D. Fake crewing / fraud

Impact:

- Seafarers may send documents to fraudulent parties or respond to fake jobs.

Defenses:

- MLC gate.
- Manual KYB verification.
- Clear verified/pending/sponsored labels.
- Report abuse flow.
- Anti-duplicate vacancy rules.
- Per-crewing tokens and audit logs.

### E. Review abuse / retaliation / defamation

Impact:

- Fake reviews, harassment, claims against vessels/managers, legal pressure.

Defenses:

- Pseudonymous review identity.
- One review per local experience.
- Pending moderation.
- Rate limits.
- Manager-epoch model.
- Takedown and evidence policy.

### F. Local machine compromise

Impact:

- Malware on the user's device can read the vault.

Defenses:

- Honest threat model in docs.
- Optional vault encryption/keychain roadmap.
- No silent upload.
- File preview bounds.
- Safe handling of AI/OCR endpoints.

### G. Vessel DB scraping / dataset extraction

Impact:

- Competitors may try to enumerate IMO lookups, download snapshots, scrape
  match results, or abuse exports to clone the vessel intelligence dataset.
- The most valuable loss is not public ship particulars; it is commercial
  manager/operator linkage, confidence/provenance, private relationship hints,
  and live market/match signals.

Defenses:

- No full public vessel listing API.
- Tiered snapshots: public/free, licensed/gated, internal.
- The internal layer is never shipped to desktop clients.
- Rich lookup requires authenticated scoped tokens and per-endpoint limits.
- Sequential IMO/name scan detection.
- Broker reveal-on-engage and match-only visibility.
- Export quotas, audit logs, token revocation, snapshot URL rotation, and
  watermark/canary strategy.

## P0 Security Backlog Before Wide Launch

- [ ] Replace shared `ADMIN_TOKEN` with per-organization scoped tokens.
- [ ] Add object-level authorization tests for crewing A vs crewing B.
- [ ] Pin seafarer user_id to application thread at apply time.
- [ ] Require authorization on attachment metadata listing.
- [ ] Add rate limits for review submit, apply, messaging, vacancy posting,
      mailing clicks, apply clicks, and hide counters.
- [ ] Add `/api/app-config` kill switches and client local-only fallback.
- [ ] Move production server to Postgres and Alembic migrations.
- [ ] Add off-provider encrypted backups and a documented restore drill.
- [ ] Put API behind WAF/reverse proxy with request limits.
- [ ] Add structured request logs, request id, uptime alerts, and error alerts.
- [ ] Harden updater/release process: MFA, protected tags, manual release gates,
      emergency key rotation runbook.
- [ ] Add a real CSP for the Tauri frontend.
- [ ] Narrow Tauri filesystem permissions.
- [ ] Add OS keychain/passphrase roadmap for vault identity secrets.
- [ ] Add moderation tooling and abuse workflow for reviews.
- [ ] Add fake-crewing/report-abuse workflow.
- [ ] Add seafarer identity dedup recovery/merge flow, vault signature proof,
      and rate limits before exposing identity claim broadly.
- [ ] Define Vessel DB field tiers and enforce them in lookup, snapshot, delta,
      match, and export code paths.
- [ ] Block full public vessel listing/search APIs; only expose public projection
      by exact IMO/name lookup unless authenticated scope allows more.
- [ ] Add sequential IMO/name enumeration detection and rate limits.
- [ ] Add reveal audit logs for commercial-manager/contact/provenance fields.
- [ ] Add signed, tiered, watermarked snapshot manifests with revocation path.
- [ ] Add public incident-response templates for DB compromise, updater
      compromise, API outage, fake agency, and review abuse.

## Security Design References

- OWASP API Security Top 10 2023:
  https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- OWASP ASVS:
  https://owasp.org/www-project-application-security-verification-standard/
- OWASP TASVS:
  https://owasp.org/www-project-thick-client-application-security-verification-standard/
- CISA Cyber Essentials:
  https://www.cisa.gov/cyber-essentials
