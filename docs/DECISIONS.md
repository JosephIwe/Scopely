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
| A13 | The first build kind is `website`, built from one reusable template (Meridian) and edited as structured operations, never as HTML (the first half of B6) | Osim Joe, 2026-09-28 (Slice 5 brief) | `src/build/site`, `websiteBuilder`, `ScopelySiteAgent` |
| A14 | A version may be approved while its main button has no destination, but it cannot be shown until it has one; a site never renders a button that goes nowhere (was B16) | Osim Joe, 2026-09-28 (Slice 5 final patch) | `showVersion` / `siteShowBlocker` in `src/build/site/service.ts`; the renderer leaves an unset button out of the artifact |
| A15 | A prospect link lasts 72 hours by default and the seller can revoke it early; a link is ACTIVE, EXPIRED or REVOKED, and revoking never changes the version (was B17) | same patch | `preview_links` (migration 011), `DEFAULT_SHOW_LINK_TTL_SECONDS`, `revokeProspectLink` |
| A16 | AI edits may rewrite website copy (headline, supporting text, section text, service descriptions, button labels) as structured edits under the same claim checks as generated copy; they cannot add services or invent facts (was B19) | same patch | `claimBlocker` in `src/build/site/claims.ts`, `applyEdits` with origin `ai` |
| A17 | Saving makes a new immutable version; nothing is autosaved as a draft | Osim Joe, 2026-09-28 (Slice 6 brief) | `saveEdits`; the workspace keeps unsaved edits in the browser until Save |
| A18 | Undo never deletes a version: it restores the previous version as a new version, and only the latest change can be undone this way | same brief | `restoreVersion(..., { undo: true })` |
| A19 | One website template, Meridian, restyled to the "Modern Clinic" direction as template version 2; version 1 stays registered and frozen so earlier versions keep their bytes, and a new version is always made with the current template | same brief | `MERIDIAN` / `MERIDIAN_V1` in `template.ts`, `render-v1.ts`, `upgradeDocument` |
| A20 | The Build Workspace UI stays plain JS with no framework | same brief | `src/server/ui` |
| A21 | The first Fix kind is the Website Fix Sprint, limited to the proven broken-contact-link findings (F1) | Osim Joe, 2026-09-28 (Slice 7 brief) | `fix_supported_issue_code`, `CHANNELS_FOR` in `src/build/fix/destination.ts` |
| A22 | The Fix Builder may read the page captured into its own project, for FIX builds only; the BuildContext still carries no page HTML (F2) | same brief | `ScopelyFixAgent`, CLAUDE.md rule 13 |
| A23 | Local page capture is permitted, as proof material, not the source of truth (F3) | same brief | `captureFixPage`, `SafePageFetcher`, `fix_captures` |
| A24 | Every corrected value is confirmed by a person before anything is approved or shown to a prospect; no model or agent supplies one (F4) | same brief | `fix_corrections`, `fix_build_blocker`, `build_fix_gate`, `confirmFix` |
| A25 | The product shell stays plain JS modules; no React (U1) | Osim Joe, 2026-09-29 (Slice 8 brief) | `src/server/ui/shell.js`, `case-file.js` |
| A26 | The product lives under `/app`; `/` is reserved for the landing page (U2) | same brief | `STATIC` in `src/server/app.ts`, `landing.html` |
| A27 | The map is deferred: no provider, tiles or coordinates, only an insertion point (U3) | same brief | `src/server/ui/map-slot.js` |
| A28 | Pitches and outcomes are recorded by hand in the Case File; Scopely sends nothing (U4) | same brief | `recordManualOutcome`, `POST /api/opportunities/:id/outcomes` |

## Open

| # | Question | Why it matters | Where it would land |
|---|---|---|---|
| B1 | Does revenue mean the agreed amount at `won`, or money received? | GET PAID. Today revenue is the won amount; unpaid invoices would overstate it | A `paid` outcome kind and a `revenue_received` column on the views |
| B2 | Evidence freshness window before a send (24h / 72h / 7d; 72h was recommended as D7) | A confirmed re-check from weeks ago still passes the gate today | One parameter in `evidence_send_blocker` |
| B3 | Does a UK PLC count alongside Ltd/LLP? | PLCs are corporate subscribers under PECR, but the stated rule is Ltd/LLP | The type list in `contact_outreach_blocker` |
| B4 | Article 14 notice wording vs "no links on Day 0" (D5) | First-message compliance | Message lint rule, when drafting exists |
| B5 | Prices, effort and scope for Landing Page Build | It cannot be priced until a basis is recorded | `catalog_items` price band + `price_source` |
| B6 | Whether a demo build is offered free (which kind comes first is now A13) | Changes what the seller gives away before a sale. Today a website build records no cost and no price: the catalog item's price stays NULL | The catalog item's price band, and a `cost_events` row per build run once a model is used |
| B8 | Daily cap, spacing and window for automated sending (D8) | Only matters once sending is built | `sending_settings` (not created), per mailbox |
| B9 | Shared starter catalog, or a copy per workspace? | Today starter items are shared rows a workspace can use as-is or override with its own item of the same key. A copy per workspace would let sellers edit starters but duplicates reference data | `catalog_items.workspace_id` |
| B10 | Authentication and who may act in a workspace | Users and memberships exist, but nothing authenticates a request; `recorded_by`, `approved_by`, `selected_by`, and in Slice 4 `build_requirements.recorded_by` / `build_assets.recorded_by`, are still free text, not user ids. A free-text actor is a label, not an identity: the API returns `approvedByIsAuthenticated: false`. The `*_user_id` columns Slice 4 adds (`created_by_user_id`, `started_by_user_id`) are real user FKs and must be members of the row's workspace | An API layer calling `isMember` then `withWorkspace`; then nullable `*_user_id` FKs beside each free-text actor column, backfilled only where a person is known |
| B11 | A cross-workspace legal suppression layer | A statutory objection (e.g. to the platform itself) would need to reach every workspace; today suppression is strictly per workspace | A platform-level suppression table read by `contact_outreach_blocker` |
| B12 | How structure (independent / chain / franchise) is sourced | It is recorded with the business but not yet tied to a source or basis like size and revenue | `businesses.independence` + basis/source columns |
| B13 | Billing and credit pricing | Credits are metered per workspace and run, but nothing sells or tops them up | Billing is out of scope until decided |
| B14 | Who owns a model provider key: the workspace, a user, or both? | A workspace-owned key survives a member leaving and is shared by every member's runs; a user-owned key follows one person and would need to say which workspaces may use it. Today `provider_connections` belong to the workspace only, and a `credential_ref` must sit in that workspace's namespace (`secretref:ws/<workspace>/…`) | Additive: a nullable `owner_user_id` (member FK) on `provider_connections`, a `secretref:user/<user>/…` namespace, and a rule in `build_run_guard` for which runs may use a user's connection. Nothing existing changes |
| B15 | How Scopely-managed build AI is charged to a workspace | `SCOPELY_MANAGED` model use is recorded as `billed_to = SCOPELY` with its real amount when the provider reports one, but whether it costs the workspace credits, and at what rate, is undecided; `CUSTOMER_KEY` use is `WORKSPACE`-billed with no Scopely credits | A credit rate per provider/model and the `credits` value on `SCOPELY`-billed `cost_events`; depends on B13 |
| B18 | Where version files are stored outside a developer's machine | Files are write-once and hash-checked, but only in memory (tests) or a local folder (`SCOPELY_STORAGE_DIR`). No cloud resource is allowed until a slice authorises one | A third `ObjectStore` implementation in `src/storage` |

The seller actions that gate a manual test are not code decisions: SPF, DKIM and DMARC on the
seller's sending domain, and a privacy notice on their site. For the first operator's campaign they
are listed in `MANUAL_VALIDATION.md`.

`max_discovered_per_run` is how the brief's per-run limit is read: it caps discovery per run, while
`max_businesses_to_analyze` and `analysis_budget_credits` cap analysis.
