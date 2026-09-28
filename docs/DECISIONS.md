# Decisions

Decided items are enforced or reflected in the code. Open items are not decided by the code; the
place where each one would land is named so it can be added without rework.

## Decided

| # | Decision | Decided | Where it lives |
|---|---|---|---|
| A1 | Manual 20–30 prospect validation comes before any automated sending | Osim Joe, 2026-09-28 | No sending code exists; `messages.sent_at` records a manual send |
| A2 | Approval is mandatory and locked on | Osim Joe, 2026-09-28 | `messages` CHECK + `message_gate`; `builds` CHECK for showing |
| A3 | Sender mailbox is `hello@josephiwe.com` on Google Workspace, never personal Gmail | Osim Joe, 2026-09-28 | Not in code yet (no sending) |
| A4 | UK cold outreach only to active Ltd/LLP corporate subscribers (PECR) | project rule | `contact_outreach_blocker` |
| A5 | High-confidence findings are re-fetched before sending and dropped if changed | Osim Joe, 2026-09-28 | `evidence_rechecks`, `evidence_send_blocker` |
| A6 | Aesthetics is the VALIDATED benchmark; UK trades Lead Recovery is a HYPOTHESIS experiment | Slice 1 | `niche_playbooks` |
| A7 | BUILD/FIX is an optional layer with its own boundary, not a website generator | Osim Joe, 2026-09-28 | `builds`, `build_kinds`, `src/build` |
| A8 | Landing Page Build is a service with no established price | Osim Joe, 2026-09-28 | `catalog_items.landing_page_build` (price NULL) |

## Open

| # | Question | Why it matters | Where it would land |
|---|---|---|---|
| B1 | Does revenue mean the agreed amount at `won`, or money received? | GET PAID. Today revenue is the won amount; unpaid invoices would overstate it | A `paid` outcome kind and a `revenue_received` column on the views |
| B2 | Evidence freshness window before a send (24h / 72h / 7d; 72h was recommended as D7) | A confirmed re-check from weeks ago still passes the gate today | One parameter in `evidence_send_blocker` |
| B3 | Does a UK PLC count alongside Ltd/LLP? | PLCs are corporate subscribers under PECR, but the stated rule is Ltd/LLP | The type list in `contact_outreach_blocker` |
| B4 | Article 14 notice wording vs "no links on Day 0" (D5) | First-message compliance | Message lint rule, when drafting exists |
| B5 | Prices, effort and scope for Landing Page Build | It cannot be priced until a basis is recorded | `catalog_items` price band + `price_source` |
| B6 | Which build kind to implement first, and whether a demo build is offered free | Changes what the seller gives away before a sale | A `FixBuilder` registered for that kind |
| B7 | Who Scopely is for first: the operator only, or other sellers (O2/D4) | Multi-user, auth and billing | `users` table (not created) |
| B8 | Daily cap, spacing and window for automated sending (D8) | Only matters once sending is built | `sending_settings` (not created) |

The operator actions that gate the manual test are not code decisions: SPF, DKIM and DMARC on
josephiwe.com, and a privacy notice on the site.
