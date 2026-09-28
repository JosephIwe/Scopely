# Decisions

Decided items are enforced or reflected in the code. Open items are not decided by the code; the
place where each one would land is named so it can be added without rework.

## Decided

| # | Decision | Decided | Where it lives |
|---|---|---|---|
| A1 | Manual 20–30 prospect validation comes before any automated sending | Osim Joe, 2026-09-28 | No sending code exists; `messages.sent_at` records a manual send |
| A2 | Approval is mandatory and locked on | Osim Joe, 2026-09-28 | `messages` CHECK + `message_gate`; `builds` CHECK for showing |
| A3 | The first operator validates from their own business mailbox on Google Workspace, never personal Gmail. It is their workspace's mailbox, not a product default | Osim Joe, 2026-09-28 | `mailbox_connections` (per workspace); the address lives only in `MANUAL_VALIDATION.md` |
| A4 | UK cold outreach only to active Ltd/LLP corporate subscribers (PECR) | project rule | `outreach_basis_rules` (GB row), read by `contact_outreach_blocker` |
| A5 | High-confidence findings are re-fetched before sending and dropped if changed | Osim Joe, 2026-09-28 | `evidence_rechecks`, `evidence_send_blocker` |
| A6 | Aesthetics is the VALIDATED benchmark; UK trades Lead Recovery is a HYPOTHESIS experiment | Slice 1 | `niche_playbooks` |
| A7 | BUILD/FIX is an optional layer with its own boundary, not a website generator | Osim Joe, 2026-09-28 | `builds`, `build_kinds`, `src/build` |
| A8 | Landing Page Build is a service with no established price | Osim Joe, 2026-09-28 | `catalog_items.landing_page_build` (price NULL) |
| A9 | Scopely is a multi-user product: every seller has a workspace with their own searches, businesses, opportunities, mailboxes, suppression and costs (was B7) | Osim Joe, 2026-09-28 (multi-user discovery brief) | `workspaces`, `workspace_id` + `a00_workspace_guard` + RLS on every owned table |
| A10 | Website and Fix are two opportunity paths in one system; the path comes from the catalog item's build kind | same brief | `build_kinds.opportunity_path`, `opportunities.opportunity_kind` |
| A11 | Discovery, pre-qualification and analysis are separate stages; unknown data goes to review, never to pass or fail | same brief | `search_run_businesses`, `src/discovery/qualify.ts` |
| A12 | A run's analysis cap and credit budget are never silently exceeded; an unknown cost is reported as unknown | same brief | `search_run_business_guard`, `cost_event_run_guard`, `estimateRunAnalysis` |

## Open

| # | Question | Why it matters | Where it would land |
|---|---|---|---|
| B1 | Does revenue mean the agreed amount at `won`, or money received? | GET PAID. Today revenue is the won amount; unpaid invoices would overstate it | A `paid` outcome kind and a `revenue_received` column on the views |
| B2 | Evidence freshness window before a send (24h / 72h / 7d; 72h was recommended as D7) | A confirmed re-check from weeks ago still passes the gate today | One parameter in `evidence_send_blocker` |
| B3 | Does a UK PLC count alongside Ltd/LLP? | PLCs are corporate subscribers under PECR, but the stated rule is Ltd/LLP | The type list in `contact_outreach_blocker` |
| B4 | Article 14 notice wording vs "no links on Day 0" (D5) | First-message compliance | Message lint rule, when drafting exists |
| B5 | Prices, effort and scope for Landing Page Build | It cannot be priced until a basis is recorded | `catalog_items` price band + `price_source` |
| B6 | Which build kind to implement first, and whether a demo build is offered free | Changes what the seller gives away before a sale | A `FixBuilder` registered for that kind |
| B8 | Daily cap, spacing and window for automated sending (D8) | Only matters once sending is built | `sending_settings` (not created), per mailbox |
| B9 | Shared starter catalog, or a copy per workspace? | Today starter items are shared rows a workspace can use as-is or override with its own item of the same key. A copy per workspace would let sellers edit starters but duplicates reference data | `catalog_items.workspace_id` |
| B10 | Authentication and who may act in a workspace | Users and memberships exist, but nothing authenticates a request; `recorded_by`, `approved_by`, `selected_by` are still free text, not user ids | An API layer calling `isMember` then `withWorkspace`; later a user FK on those columns |
| B11 | A cross-workspace legal suppression layer | A statutory objection (e.g. to the platform itself) would need to reach every workspace; today suppression is strictly per workspace | A platform-level suppression table read by `contact_outreach_blocker` |
| B12 | How structure (independent / chain / franchise) is sourced | It is recorded with the business but not yet tied to a source or basis like size and revenue | `businesses.independence` + basis/source columns |
| B13 | Billing and credit pricing | Credits are metered per workspace and run, but nothing sells or tops them up | Billing is out of scope until decided |

The seller actions that gate a manual test are not code decisions: SPF, DKIM and DMARC on the
seller's sending domain, and a privacy notice on their site. For the first operator's campaign they
are listed in `MANUAL_VALIDATION.md`.

`max_discovered_per_run` is how the brief's per-run limit is read: it caps discovery per run, while
`max_businesses_to_analyze` and `analysis_budget_credits` cap analysis.
