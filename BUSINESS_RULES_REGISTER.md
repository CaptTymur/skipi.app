# Business Rules Register

This file captures real maritime/product rules discovered during beta. It is intentionally lightweight: the goal is to avoid losing field knowledge while Skipi continues fast releases.

Status values:

- Candidate: observed, needs validation or design.
- Implemented: shipped or ready in code.
- Validated: confirmed by repeated usage or domain review.
- Deferred: useful, but not needed for current beta.

| Date | Source | Observed Rule | Product Rule | Data/API Impact | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-05-19 | Product/domain review | Yellow Fever vaccination certificates can be valid for life. | Certificates need a generic permanent/no-expiry option, not a Yellow-Fever-only special case. | Add and preserve a certificate permanence flag; expiry remains optional when permanence is set. | Implemented |
| 2026-05-19 | Product/domain review | Some certificates and documents legitimately have no expiry date. | Expiry date cannot be required for every document type. | Validation and CV/package rendering must tolerate missing expiry. | Implemented |
| 2026-05-19 | Product/domain review | Real rank names vary and the preset list is incomplete. Cadet, Junior Officer, and Junior Engineer are needed immediately. | Rank selector needs stronger presets plus a custom role path. Repeated custom roles can later graduate into presets. | Profile/rank storage must preserve custom display text. | Implemented |
| 2026-05-19 | Developer feedback | Production trust will matter for seafarers, crewing companies, reviews, vacancies, and marketplace-style workflows. | Verification should be a separate trust epic, not a blocker for the beta document vault. | Future identity, organization, entitlement, moderation, and privacy models. | Candidate |
| 2026-05-19 | Developer feedback | Some shared workflows may not always start from a clean IMO value. | Validate where IMO must be mandatory and where a draft/manual vessel flow is acceptable. | Possible API/model changes for vessel drafts, matching, and review eligibility. | Candidate |
| 2026-05-21 | Product/domain review | Seafarers often think about vessel choice first as broad fleet blocks: merchant cargo fleet, passenger or Ro-Pax work, and offshore/energy support. | Setup wizard should group existing vessel categories by fleet block without changing saved vessel-type IDs. | UI grouping only for now; taxonomy IDs and document framework remain compatible. | Implemented |

## Entry Template

| Date | Source | Observed Rule | Product Rule | Data/API Impact | Status |
| --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD |  |  |  |  | Candidate |
