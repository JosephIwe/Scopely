# Scopely

Scopely is a multi-user opportunity-to-revenue platform for sellers of digital services. Each
seller works in their own workspace. It is not an auditor. It finds a business the seller is
looking for, observes a real, fixable problem on the business's own site,
attaches the evidence, maps that problem to a service the seller can sell at a known price, can build
the fix before the pitch, records what happened commercially, and later verifies the fix against a
fresh snapshot.

```
DISCOVER → PRE-QUALIFY → ANALYZE → evidence → opportunity → service → BUILD/FIX → SELL → DELIVER → VERIFY → GET PAID
```

The metric that matters is **revenue and gross profit per 100 prospects**. It is not the number
of findings or of audits. `docs/PRODUCT_MODEL.md` maps every stage to the tables that hold it and
says which stages are built, manual, a boundary only, or deferred.

## Status

- **Slice 1 (foundation):** schema, reference data, golden benchmark and the Truth Rule tests.
  See `docs/SLICE1_PLAN.md`.
- **Slice 2 (manual validation + BUILD boundary):** evidence re-check ledger, approval and send
  gates (lawful recipient, suppression, re-checked evidence), pitch traceability, the per-
  opportunity ledger view, a `pnpm record` operator CLI, and the BUILD/FIX data model and builder
  interface with no builder implemented. See `docs/MANUAL_VALIDATION.md` and `docs/DECISIONS.md`.
- **Slice 3 (multi-user discovery):** workspaces, users and memberships; workspace ownership,
  guards and row-level security on every commercial row; per-workspace mailboxes and suppression;
  searches (ICP with employee and revenue ranges in their own currency), search runs,
  pre-qualification, analysis caps and credit budgets; website status; Website and Fix
  opportunities in one feed; and the read contract for the frontend. No discovery provider is
  implemented. See `docs/PRODUCT_MODEL.md` and `docs/API_CONTRACT.md`.
- **Slice 5 (template-first Build Workspace):** one build kind (`website`) and one reusable
  template (Meridian). An opportunity becomes a generated site through Slice 4's projects, runs and
  versions; a person edits it with validated operations (text, lists, images, button, colours,
  type, layout, sections) and a live preview; an AI edit turns a request into the same operations
  and makes a new version; approved and shown versions are immutable, hash-checked, write-once
  files; a version is shown only once its button has a destination; and a prospect sees a shown
  version through a signed link that lasts 72 hours unless the seller revokes it. `pnpm serve` runs
  the Build Workspace locally. See `docs/PRODUCT_MODEL.md` (Template-first website builds) and
  `docs/API_CONTRACT.md`.
- **Slice 6 (Build Workspace design):** the workspace rebuilt to the design handoff in plain JS
  (template select, generating, a workspace with AI / Sections / Design / Settings, a section
  inspector, version history, approve and show dialogs, preview mode, a Before → After drawer,
  and a bottom sheet below 1000px). Meridian is restyled as version 2 ("Modern Clinic": four
  palettes, three embedded type pairings, a call-to-action band, and button, spacing, image and
  background styles). Saving makes a new version; Undo restores the previous version as a new
  version. Versions built with Meridian 1 keep rendering to their stored bytes; their next
  version is made with Meridian 2.
- **Slice 7 (Fix Builder):** the first Fix kind, the Website Fix Sprint for proven broken contact
  links. Scopely captures a copy of the page (SSRF-safe, one page, proof material), a person types
  the corrected phone, WhatsApp or email destination, a deterministic agent corrects only those
  links on a copy, and the seller compares before and after, confirms the value, and shows the
  prospect a signed, expiring, revocable preview. Nothing can be approved or shown before a person
  confirms the corrected value. See `docs/PRODUCT_MODEL.md` (Fix Builder).

There is **no crawler, no model call, no sending and no cloud resource**. The only outbound request is the Fix Builder's one-page capture (A23). The AI edit in Slice 5 is
a deterministic interpreter behind the same seam a model-backed one will use. Nothing here contacts a business:
`messages.sent_at` records a send made by hand.

## The Truth Rule

Scopely never states a number it did not measure. Revenue, traffic, conversion and "leads lost"
are never estimated. Unknown values are stored as `NULL`, and the funnel view reports `NULL`,
not zero. The database enforces this, not the application:

| Rule | Where it is enforced |
|---|---|
| Evidence rests on an observation made on a stored snapshot | `evidence_guard`, FK + NOT NULL |
| Evidence has a URL, verbatim quote, `observed_at` and confidence | column CHECKs |
| Evidence `observed_at` is its snapshot's capture time (derived; a different value is refused) | `evidence_guard`, `snapshot_time_guard` |
| `NOT_OBSERVABLE` never becomes evidence or a defect | `observations` CHECKs, `evidence_guard` |
| An `INFERRED` observation cannot back an `OBSERVED` claim | `evidence_guard` |
| An opportunity has at least one evidence record | deferred `opportunity_has_evidence` |
| An opportunity is mapped to a catalog service or explicitly `UNMAPPED` with a reason | CHECK |
| A price sits inside the catalog band, or is a structured override: an approved DISCOUNT below the band, or a BUNDLE inside the summed bands of named catalog items | `opportunity_price_guard` + CHECK |
| Every finding cites a rule version, the same one from observation to evidence to verification | NOT NULL FK, `evidence_guard`, `verification_guard` |
| Deal value, reply and win dates exist only through an outcome record | `opportunity_projection_guard` + `outcome_project` |
| Outcomes are append-only | `outcomes_append_only` |
| At most one effective won or lost outcome; a mistake is corrected by a `voided` outcome naming it, never after a delivery | `outcome_guard` |
| CLIENT_REQUIRED work is never recorded as delivered by us | `outcome_guard` |
| A verification uses a snapshot taken after the evidence | `verification_guard` |
| A re-check uses a later snapshot and re-runs the same check and rule version; re-checks are append-only | `evidence_recheck_guard`, `evidence_rechecks_append_only` |
| A message is approved only for a contact of the same business with a lawful basis (UK: active Ltd/LLP), not suppressed by that workspace's email, domain or business suppression | `message_gate`, `contact_outreach_blocker`, `outreach_basis_rules` |
| A message is sent from a mailbox of its own workspace; there is no global sender | `a10_message_addresses`, `messages_sender_check` |
| Every commercial row belongs to one workspace and never references another's | `a00_workspace_guard`, row-level security |
| Unknown employee count and revenue stay NULL; an estimate carries its basis, source and date | `businesses_employees_check`, `businesses_revenue_check` |
| A failed fetch is never "no website"; a no-website finding needs `WEBSITE_NOT_OBSERVED` | `businesses_website_*` checks, `evidence_website_status_guard` |
| A rejected or unselected business is never analysed; a run never passes its analysis cap or credit budget | `search_run_business_guard`, `cost_event_run_guard` |
| A message is marked sent only after approval, with HIGH evidence re-checked and confirmed and no evidence changed or gone | `message_gate`, `evidence_send_blocker` |
| Approved message or build content cannot change without a new approval; sent or shown content cannot change | `message_gate`, `build_guard` |
| A build fixes cited evidence of its own mapped opportunity; a DELIVERY build needs a win; a demo is shown only when approved and re-checked | `build_guard`, `build_evidence_guard`, `build_has_evidence` |

## VALIDATED vs HYPOTHESIS, and commercial status

These are two separate axes, and both are labels on playbooks, issue codes and rules.

- **`validation_status`** answers whether the detection has been seen working on real sites.
  `VALIDATED` requires a `validation_basis` that cites golden-set case ids. A test fails if an
  issue code is marked VALIDATED without an OBSERVED golden finding, or the other way round.
- **`commercial_status`** answers whether anyone has paid for it. Every catalog item and every
  playbook is `UNPROVEN` today, because no reply, win or delivery has been recorded anywhere.

The London aesthetics playbook is `VALIDATED` / `UNPROVEN`. The UK trades Lead Recovery playbook
is `HYPOTHESIS` / `UNPROVEN`.

## Niche-agnostic model

A **market** is a playbook plus geography: `country_code`, `region`, `city`, `postal_area`,
`timezone`, `currency`, `vertical` and `subvertical`. Its `purpose` is `benchmark`, `experiment`
or `production`. London aesthetics is the benchmark. UK trades is the first experiment. The tests
include a Toronto/CAD market to prove nothing is hard-coded to the UK or to GBP.

## Golden set

`fixtures/golden/` holds 103 cases from two historical OutboundOS prospecting rounds, from
verbatim copies of the source files with their commit SHAs and sha256 hashes. Every finding
cites its source file and line, and the quoted text is re-found there by a test. Ambiguous cases
are `NEEDS_BROWSER_CHECK`, never guessed. Claims the historical work withdrew are
`MUST_NOT_CLAIM`, so Scopely is also tested on what it must not say.

```
pnpm golden:build     # rebuild golden-set.json from sources + annotations.json
```

## Running

Requires Node 22+, pnpm 10 and a local Postgres 16.

```
pnpm install
cp .env.example .env                  # DATABASE_URL for your dev database
pnpm migrate                          # apply migrations/ in order (sha256 ledger)
pnpm test                             # creates a throwaway database, migrates twice, runs, drops it
pnpm check                            # typecheck + test
pnpm record workspace <file.json>     # provision a workspace
SCOPELY_WORKSPACE_ID=<id> pnpm record <command> <file.json|->   # see docs/MANUAL_VALIDATION.md
pnpm demo:seed                        # a sample workspace with one website and one fix opportunity; prints its id
SCOPELY_WORKSPACE_ID=<id> pnpm serve  # the Build Workspace on http://127.0.0.1:4310
```

`pnpm serve` acts in one workspace, named by `SCOPELY_WORKSPACE_ID`, because nothing authenticates a
person yet (B10); it listens on 127.0.0.1 only. It reads `PREVIEW_SIGNING_KEY` (at least 32
characters; a random one is used, with a warning, when unset, so links stop working on restart),
`SCOPELY_STORAGE_DIR` (default `.scopely/storage`) and `SHOW_LINK_TTL_HOURS` (default 72, A15).
No model credential is read or needed.

Tests read `TEST_DATABASE_ADMIN_URL` (default `postgres://scopely:scopely@localhost:5432/postgres`)
and create and drop their own `scopely_test_<random>` database. Every test runs in a transaction
that is rolled back.
