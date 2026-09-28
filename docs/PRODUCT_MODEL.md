# Scopely product model

Scopely is an opportunity-to-revenue platform for sellers of digital services. It finds a business
with a commercially fixable problem, proves the problem with evidence, maps it to a service,
optionally builds the fix before the pitch, sells it, delivers it, verifies it on a later snapshot,
and records whether it made money.

```
FIND → evidence → opportunity → service → BUILD/FIX → SELL → DELIVER → VERIFY → GET PAID
```

It is not a website auditor and not a lead generator. Websites are one kind of fix among several.
This file is the source of truth for what each stage is in the data model today, so product design
can work from the real system. Status labels: **Built** (schema, guards and tests exist),
**Manual** (recorded by hand through `pnpm record`, no automation), **Boundary** (tables and
interfaces exist, no implementation), **Deferred** (not in the repository).

## Stages

| Stage | What it means | Tables / code | Status |
|---|---|---|---|
| FIND | A business in a market (playbook + geography), with where it came from and whether it qualifies | `markets`, `niche_playbooks`, `businesses`, `sources`, rejection fields + `rule_versions` | Built, Manual. Discovery, Companies House and MX lookups are Deferred |
| Observe | A stored capture of a page and what each check saw on it | `snapshots`, `observations` (`OBSERVED` / `INFERRED` / `NOT_OBSERVABLE`) | Built, Manual (`fetch_method = 'manual'`). Fetch/render worker is Deferred |
| Evidence | A defect or gap stated with URL, verbatim quote, capture time, confidence and rule version | `evidence`, `issue_codes` | Built |
| Re-check | The same check re-run on a later snapshot before the finding is put in front of a prospect | `evidence_rechecks` (append-only) | Built, Manual |
| Opportunity | A sellable problem resting on at least one evidence row | `opportunities`, `opportunity_evidence` | Built |
| Service | The catalog item the opportunity maps to, or `UNMAPPED` with a reason; the price must sit in the cited band | `catalog_items`, `opportunity_price_guard` | Built |
| BUILD/FIX | A concrete artifact made for one mapped opportunity: a `DEMO` before the pitch, or the `DELIVERY` implementation after a win | `build_kinds`, `builds`, `build_evidence`, `src/build` (`FixBuilder`, `BuilderRegistry`, `loadBuildInput`) | Boundary. No builder is implemented |
| SELL | A message to a lawful contact, approved by a person, marked sent after the manual send; or a demo build shown | `contacts`, `suppression`, `messages`, `builds.shown_at`, `outcomes` (`pitched`, `replied`, `call`, `won`, `lost`) | Built, Manual. Automated sending is Deferred |
| DELIVER | The work was done, by the operator or (for `CLIENT_REQUIRED` items) confirmed by the client | `outcomes` (`delivered`), `builds` (`DELIVERY`) | Built, Manual |
| VERIFY | The original check passes on a snapshot taken after the evidence | `verifications` | Built, Manual |
| GET PAID | Revenue is the `won` outcome's agreed amount. Payment received, invoices and recurring billing are not modelled | `outcomes.amount` → `opportunities.deal_value` | Deferred (see decision B1 in `DECISIONS.md`) |
| Learn | Funnel and per-opportunity results; unknown values are NULL, never 0 | `v_market_funnel`, `v_opportunity_ledger`, `v_opportunity_type_performance`, `cost_events` | Built |

## BUILD/FIX

BUILD is an optional layer. Every stage before and after it works without it, and an opportunity
can be pitched with evidence alone.

- **What can be built is data.** `build_kinds` holds `website_fix`, `website`, `landing_page`,
  `booking_flow`, `lead_recovery`, `seo_improvement`, `conversion_improvement` and `automation`. A
  new kind is a row, not a schema change. A catalog item names the kind it builds; an item with no
  build kind cannot be built.
- **A build fixes something observed.** It belongs to one `MAPPED` opportunity, uses that
  opportunity's catalog item, and cites at least one of that opportunity's evidence rows.
- **DEMO vs DELIVERY.** A `DEMO` is made before the pitch so the prospect sees the fix. It is never
  delivery and never revenue. A `DELIVERY` build needs a won opportunity. Delivery itself is still
  the `delivered` outcome.
- **Showing is a claim.** A demo is shown only after a recorded approval, and only if its evidence
  passes the same re-check gate as a sent message. Approved content cannot change without a new
  approval; shown content cannot change at all (supersede it instead).
- **Builders see observations, not pages.** `loadBuildInput` gives a builder the cited evidence
  (issue, URL, quote, capture time, confidence, claim state), what could not be observed, and the
  catalog item. It excludes evidence a re-check found changed or gone.
- **Cost is metered.** `cost_events.build_id` attributes build cost to the build and its opportunity.

Example: a plumber claims 24/7 service but lists weekday hours and no out-of-hours route. The
evidence is `E-24-7-CONTRADICTION`, the opportunity maps to Lead Recovery System (`lead_recovery`),
and a future lead-recovery builder would produce a demo the seller can show. Today the operator can
make that demo by hand and record it with `recordBuild(... generator: 'operator')`.

## Evidence integrity

- `OBSERVED`, `INFERRED` and `NOT_OBSERVABLE` describe what was seen. `VALIDATED` and `HYPOTHESIS`
  describe whether a rule has been seen working on real sites. `UNPROVEN` and `PROVEN` describe
  whether anyone has paid. The three axes never substitute for each other.
- "We could not observe X" is stored as `NOT_OBSERVABLE` or in `not_observable_notes`. It never
  becomes evidence, a defect, a message claim or a build input claim.
- A HIGH finding must be re-fetched and confirmed before a message citing it is marked sent or a
  demo citing it is marked shown. A finding re-checked as changed or gone blocks both.

## Playbooks

| Playbook | Detection | Commercial | Role |
|---|---|---|---|
| London aesthetics | VALIDATED (golden set, 103 cases) | UNPROVEN | Benchmark |
| UK trades, Lead Recovery | HYPOTHESIS | UNPROVEN | Experiment |

Nothing in the schema is tied to a niche, country or currency; a Toronto/CAD market is covered by tests.

## Service catalog

| Service | Price | Builds | Source |
|---|---|---|---|
| Website Fix Sprint | £120 | `website_fix` | OutboundOS `final-package-round1.md` |
| Booking & Lead Automation Sprint | £240 | `booking_flow` | same |
| Lead Recovery System | £350–£500 | `lead_recovery` | OutboundOS `docs/02` §7.1 |
| Landing Page Build | not established (NULL; cannot be priced) | `landing_page` | named by the operator, 2026-09-28 |

Effort, implementation type, margin and close rate are NULL on every item. All four are UNPROVEN.

## What a UI can rely on

Every screen can read straight from these tables and views. `v_opportunity_ledger` is the one-row-
per-opportunity view of the whole loop, and `v_market_funnel` is the per-market summary. Any value
a screen shows as unknown is NULL in the database, and should read as "not known", never as 0.
