# Architecture Epics: Fast Releases, Production, Trust

Date: 2026-05-19

## Decision

Skipi keeps the current fast beta release loop as the main product-discovery engine. We continue shipping small improvements, fixing real maritime rules as they are found, and validating usage with seafarers and crewing teams.

Future production architecture and trust/verification are separate epics. They should be designed deliberately, but they should not block quick releases unless a beta change would create a privacy, security, or migration problem that is expensive to unwind.

## Current Operating Mode

The current desktop app remains local-first:

- seafarer documents, certificates, passports, contracts, and CV data stay in the local vault by default;
- server features support shared workflows such as vessels, reviews, vacancies, mailing, entitlement checks, and telemetry;
- real-world edge cases are captured as business rules before we convert them into durable product behavior;
- beta implementation may be pragmatic, but it must leave a clear migration path.

The most important guardrail remains unchanged: the server must not become a central vault for seafarer passports, certificates, contracts, or other sensitive document bundles.

## Epic: Production Shared Backend

Goal: move shared product workflows from beta-grade service code to a production API layer that owns authorization, state transitions, abuse controls, and persistence.

Scope:

- API owns shared business logic for vessel reviews, vacancy publishing, crewing requests, document-package mailing, candidate workflows, moderation, and entitlements.
- No direct client assumptions about shared database state. Desktop and crewing clients talk to stable API contracts.
- Production database runs through `DATABASE_URL`, Postgres, Alembic migrations, backup/restore drills, and off-provider backup storage.
- Object storage is external to the VPS for any future large shared assets. The VPS must be replaceable.
- Authorization moves from shared admin tokens to scoped per-organization credentials, object-level ACL checks, and seafarer/application ownership pinning.
- Operational controls include rate limits, WAF or equivalent edge protection, metrics, alerts, moderation tools, and `/api/app-config` kill switches.
- Release infrastructure keeps updater signing secrets, release artifacts, and mirrors outside ad hoc server state.
- Migration plan covers existing beta data and beta users before any wide launch.

Start triggers:

- several external crewing teams actively use the system;
- review/vacancy volume makes manual operations fragile;
- abuse, spam, scraping, or fake-review pressure appears;
- shared workflows start depending on data correctness across organizations;
- a partner asks for contractual reliability, auditability, or data-processing commitments.

Done means:

- shared workflows have API-level tests for authorization and state transitions;
- production database migrations are repeatable and rollback paths are understood;
- backup restore is tested;
- rate limits and kill switches can protect the service during a bad release or traffic spike;
- beta clients can be migrated without losing user value.

## Epic: Trust And Verification

Goal: make Skipi more useful by increasing trust in seafarers, crewing companies, vacancies, and reviews without turning the product into a heavy compliance platform too early.

Seafarer trust:

- verified identity should be optional and should not block the free local document vault;
- a low-cost one-time verification or payment trail can be one trust signal, but it is not full identity assurance by itself;
- verification status should help with anti-bot protection, candidate credibility, review weighting, and marketplace trust;
- Skipi should collect the minimum PII needed for the chosen verification level;
- deletion, export, retention, and provider risk must be handled before broad rollout.

Crewing trust:

- crewing companies start with a free or low-friction demo tier, but visible limits should distinguish unverified usage from verified operational access;
- verified crewing status should require KYB/MLC-style checks before broad vacancy publishing, bulk candidate access, or high-volume mailing;
- vacancy publishing, review replies, and candidate outreach should carry a clear verification label.

Review and marketplace trust:

- reviews can remain pseudonymous to other users while still being tied to internal anti-abuse signals;
- verified seafarer signals can increase review weight without exposing private identity;
- suspicious bulk actions need moderation queues, rate limits, and reputation checks;
- paid verification must never be the only quality signal, because it can exclude real users in lower-income markets.

Done means:

- product UI clearly distinguishes claimed, payment-confirmed, document-verified, and organization-verified states;
- trust labels are understandable without implying stronger guarantees than Skipi actually provides;
- abuse controls exist for reviews, vacancies, mailing, and profile discovery;
- privacy/legal obligations are documented before collecting additional identity data.

## Rule Capture Loop

Every real-world maritime exception found during beta should be captured before or alongside implementation:

- source: user, crewing team, developer feedback, maritime rule, support issue;
- observed behavior: what actually happens in the field;
- product rule: how Skipi should represent it;
- data impact: schema/API/storage change if any;
- UX impact: how the user sees or edits it;
- status: candidate, implemented, validated, deprecated.

Current examples:

- Yellow Fever certificates can be permanent, so certificates need a generic permanent/no-expiry option.
- Some documents and certificates do not have expiry dates, so expiry must be optional where the real document permits it.
- Rank taxonomy needs both common presets and custom roles, because real crewing terminology varies.
- Some vacancy or vessel workflows may start without a clean IMO value, so the product needs a validated rule instead of assuming every workflow starts from IMO.

## Practical Guidance

Fast releases should keep solving immediate user problems. Production architecture and trust/verification should be visible backlog tracks with their own acceptance criteria, not hidden TODOs mixed into unrelated feature work.

When a fast beta change touches data shape, identity, permissions, server-owned state, or user trust, record the future production implication in the rule register or this epic document.
