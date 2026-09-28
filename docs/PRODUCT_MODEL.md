# Scopely product model

Scopely is a multi-user opportunity-to-revenue platform for sellers of digital services. Each
seller works in their own workspace. They describe the businesses they want to find, Scopely
discovers and pre-qualifies them, analyses the ones worth the spend, proves each problem with
evidence, maps it to a service, optionally builds the fix before the pitch, helps them sell it from
their own mailbox, and records whether it was delivered, verified and paid.

```
DISCOVER → PRE-QUALIFY → ANALYZE → evidence → OPPORTUNITY → service → BUILD/FIX → SELL → DELIVER → VERIFY → GET PAID
```

It is not a website auditor and not a lead generator. It is not one operator's prospecting tool
either: nothing in the schema names a seller, mailbox, niche, country, currency or price band. The
first operator's validation campaign is data in their own workspace.

Status labels: **Built** (schema, guards and tests exist), **Manual** (recorded through
`pnpm record`, no automation), **Boundary** (tables and interfaces exist, no implementation),
**Deferred** (not in the repository). The frontend contract is in `API_CONTRACT.md`.

## Ownership

```
USER ─ membership ─ WORKSPACE ─┬─ MAILBOX CONNECTIONS
                               ├─ SEARCHES ─ SEARCH RUNS ─ run businesses
                               ├─ BUSINESSES ─ sources, snapshots, observations, evidence, contacts
                               ├─ OPPORTUNITIES ─ builds, messages, outcomes, verifications
                               ├─ SUPPRESSION
                               ├─ COST EVENTS
                               └─ own MARKETS and CATALOG ITEMS (plus shared starters)
```

- **Every commercial row has a `workspace_id`.** It defaults to the request's workspace
  (`scopely.workspace_id`, read by `current_workspace_id()`). There is no default workspace, user
  or sender: with none set, writes fail.
- **A row cannot reach into another workspace.** The `a00_workspace_guard` trigger on each owned
  table inherits the parent's workspace, refuses a reference to another workspace's row and
  refuses moving a row between workspaces.
- **Reads are isolated by row-level security** (`workspace_isolation` on every owned table, views
  run as the caller). The API also filters by workspace explicitly.
- **Shared starters.** `markets` and `catalog_items` rows with `workspace_id IS NULL` are shared
  reference data every workspace can read and use. A workspace can add its own; its own item wins
  over a shared one with the same key.
- **Users and memberships** exist (`owner`, `admin`, `member`). Authentication is not built.

## Stages

| Stage | What it means | Tables / code | Status |
|---|---|---|---|
| SEARCH | The seller's saved ICP: geography, industry / niche / sub-niche, employee and revenue ranges (with currency), structure, online presence, opportunity kinds wanted, signals, contactability, exclusions and resource limits | `searches`, `src/discovery/criteria.ts` | Built |
| RUN | One execution of a search. Criteria and limits are frozen at start, so later edits never change a past run | `search_runs` | Built |
| DISCOVER | A provider returns candidate businesses. Each is matched to the workspace's canonical business (register number, then domain, then source ref), so one business can appear in many searches and runs | `businesses`, `sources` (`provider`, `search_run_id`), `search_run_businesses` (`DISCOVERED`), `DiscoverySource` / `DiscoveryRegistry` | Built. No provider is implemented (Boundary) |
| PRE-QUALIFY | Cheap checks against the frozen criteria, in stage order: geography, industry, size, revenue, structure, online presence, signals, contactability, exclusions. Unknown data goes to review, never to pass or fail | `src/discovery/qualify.ts`, `search_run_businesses` (`QUALIFIED` / `REJECTED` + `failed_stage` / `NEEDS_REVIEW` + `unknown_stages`), rule `qualify.search_criteria` | Built |
| SELECT | The seller picks which qualified businesses to analyse, inside the run's analysis cap and credit budget | `SELECTED`, `estimated_credits`, `search_run_business_guard` | Built |
| ANALYZE | Fetch, render and check the selected businesses. Only queued businesses can have analysis cost metered against them | `ANALYSIS_QUEUED` → `ANALYZED`, `snapshots`, `observations`, `cost_events` | Built, Manual. Fetch/render worker is Deferred |
| Evidence | A defect or gap stated with URL, verbatim quote, capture time, confidence and rule version | `evidence`, `issue_codes` | Built |
| Re-check | The same check on a later snapshot before the finding reaches a prospect | `evidence_rechecks` (append-only) | Built, Manual |
| OPPORTUNITY | A sellable problem resting on at least one evidence row. A business can hold several | `opportunities`, `opportunity_evidence`, `OPPORTUNITY_FOUND` / `NO_OPPORTUNITY` | Built |
| Service | The catalog item the opportunity maps to, or `UNMAPPED` with a reason | `catalog_items`, `opportunity_price_guard` | Built |
| BUILD/FIX | A `DEMO` before the pitch, or the `DELIVERY` after a win | `build_kinds`, `builds`, `build_evidence`, `src/build` | Boundary. No builder is implemented |
| SELL | An approved message to a lawful contact, sent from one of the workspace's mailboxes | `contacts`, `suppression`, `messages`, `mailbox_connections`, `outcomes` | Built, Manual. Automated sending is Deferred |
| DELIVER | Work done by the seller, or confirmed by the client for `CLIENT_REQUIRED` items | `outcomes` (`delivered`), `builds` (`DELIVERY`) | Built, Manual |
| VERIFY | The original check passes on a snapshot taken after the evidence | `verifications` | Built, Manual |
| GET PAID | Revenue is the `won` outcome's agreed amount | `outcomes.amount` → `opportunities.deal_value` | Deferred (decision B1) |
| Learn | Per search, run, stage, opportunity kind and market; unknown values are NULL, never 0 | `v_search_run_summary`, `v_search_run_stage_funnel`, `v_search_performance`, `v_opportunity_feed`, `v_opportunity_ledger`, `v_market_funnel`, `v_opportunity_type_performance` | Built |

## Discovered is not analysed is not an opportunity

Each business in a run moves through one state machine:

```
DISCOVERED → QUALIFIED ─────→ SELECTED → ANALYSIS_QUEUED → ANALYZED → OPPORTUNITY_FOUND
           → REJECTED (failed_stage)                                 → NO_OPPORTUNITY
           → NEEDS_REVIEW → QUALIFIED | REJECTED (reviewed_by + review_note)
```

The database refuses any other move. A rejected or unselected business cannot be queued, cannot
have `fetch` / `render` / `screenshot` / `llm_call` cost recorded against the run, and cannot
produce a run opportunity. `OPPORTUNITY_FOUND` needs an opportunity; `NO_OPPORTUNITY` needs none.

## Search criteria

Every field is optional and belongs to the seller. Two examples the tests run side by side:

| | Seller A | Seller B |
|---|---|---|
| Geography | GB, Manchester | CA, Toronto |
| Industry | home services / plumbing | health / dental |
| Employees | 5–30 | 10–50 |
| Revenue | £250k–£5m (`GBP`) | C$1m–C$10m (`CAD`) |
| Wants | Fix opportunities | Website and booking opportunities |

- **Revenue keeps its currency.** A revenue range needs a currency, and a business's revenue is
  compared only in the same currency. There is no FX conversion; revenue in another currency is
  unknown for that criterion.
- **Unknown is not a pass.** A business with no employee count or revenue is `NEEDS_REVIEW` for a
  search that filters on them, never qualified or rejected on a guess.

## Firmographics

`businesses` carries employee count (exact or range), revenue (amount or range, currency), reviews,
rating, incorporation date, independence (`independent`, `chain`, `group`, `franchise`), location
and coordinates. Each group is all-NULL or carries its `basis` (`VERIFIED`, `REPORTED`,
`ESTIMATED`), `source` and `as_of`. An estimate is always labelled as one, and an exact figure must
sit inside its own range. Coordinates need a `geo_source`.

## Website status

`website_status` is one of `UNKNOWN`, `WEBSITE_PRESENT`, `WEBSITE_NOT_OBSERVED`,
`WEBSITE_UNREACHABLE`, `WEBSITE_NEEDS_REVIEW`, with a basis (`OBSERVED`, `INFERRED`,
`NOT_OBSERVABLE`), source and time.

- **A failed fetch is never "no website".** Timeouts, DNS errors and 5xx become
  `WEBSITE_UNREACHABLE`; blocked or ambiguous results become `WEBSITE_NEEDS_REVIEW`
  (`classifyWebsiteFetch` never returns `WEBSITE_NOT_OBSERVED`).
- **`WEBSITE_NOT_OBSERVED`** needs an `OBSERVED` or `INFERRED` basis and no known domain or URL.
- **The no-website finding** (`E-NO-WEBSITE`) can only be recorded, and only reach a message, while
  the business is `WEBSITE_NOT_OBSERVED`.

## Website and Fix opportunities

Both are opportunities in one table, one feed and one funnel.

- **The path comes from the catalog.** `build_kinds.opportunity_path` is `WEBSITE` (for `website`)
  or `FIX` (everything else). An opportunity's `opportunity_kind` is derived from its catalog
  item's build kind and cannot contradict it.
- **A business can hold several opportunities**, including one of each path: a Toronto dentist
  with no website (Website path) and a Manchester plumber whose 24/7 claim has no out-of-hours
  route (Fix path, Lead Recovery).
- **The catalog is data with no invented prices.** Starter items are shared; a workspace adds its
  own with its own price band, or with no price until it has a basis.

| Starter service | Price | Builds | Path |
|---|---|---|---|
| Website Fix Sprint | £120 | `website_fix` | FIX |
| Booking & Lead Automation Sprint | £240 | `booking_flow` | FIX |
| Lead Recovery System | £350–£500 | `lead_recovery` | FIX |
| Landing Page Build | not established (NULL) | `landing_page` | FIX |

Effort, margin and close rate are NULL on every item. All are commercially UNPROVEN.

## BUILD/FIX

BUILD is an optional layer. Every stage before and after it works without it.

- A build belongs to one `MAPPED` opportunity, uses its catalog item and cites at least one of its
  evidence rows. An item with no build kind cannot be built.
- **A `DEMO` is never delivery and never revenue.** A `DELIVERY` build needs a won opportunity.
- A demo is shown only after approval, and only if its evidence passes the same re-check gate as a
  sent message.
- Builders get `loadBuildInput` (cited evidence only, never page HTML).

## Selling from the seller's own mailbox

- **A mailbox is a workspace connection** (`mailbox_connections`: Google Workspace or Microsoft
  365, state `MANUAL` / `PENDING` / `CONNECTED` / `DISCONNECTED` / `REVOKED` / `ERROR`,
  `credential_ref` only, never a token). There is no global sender.
- A message records its recipient at approval and its mailbox and sender at send; the mailbox must
  belong to the same workspace and be `MANUAL` or `CONNECTED`. Sent messages are frozen.
- **Lawful basis is data.** `outreach_basis_rules` holds the per-country rule; GB corporate-subscriber
  outreach needs an active Ltd or LLP (PLC is open decision B3).
- **Suppression is per workspace** and can target an email, a domain or a business. One seller's
  opt-out list never reaches another's.
- No Gmail or Microsoft API is built. Sending is manual and recorded.

## Budgets and metering

- A search sets `max_businesses_to_analyze`, `analysis_budget_credits` and
  `max_discovered_per_run`; a run copies them at start.
- Selection past the analysis cap, queueing past the credit budget, queueing with an unknown
  estimate under a budget, and metered cost past the budget are all refused in the database.
- `cost_events` attributes cost (money and credits) to a workspace, search run, business,
  opportunity or build. An unknown amount stays NULL, and `estimateRunAnalysis` reports unknown
  rather than guessing.

## Evidence integrity

- `OBSERVED`, `INFERRED` and `NOT_OBSERVABLE` describe what was seen. `VALIDATED` / `HYPOTHESIS`
  describe whether a rule has worked on real sites. `UNPROVEN` / `PROVEN` describe whether anyone
  has paid. The three never substitute for each other.
- "We could not observe X" never becomes evidence, a defect, a message claim or a build input.
- A HIGH finding is re-checked and confirmed before a message citing it is marked sent or a demo is
  shown. The freshness window for that re-check is open decision B2.

## What a UI can rely on

Screens read through `src/api/queries.ts` (see `API_CONTRACT.md`): the unified opportunity feed
with filters, map points, business detail, run summary and stage funnel, and search performance.
Money and credits are decimal strings with their currency. NULL means "not known" and must never
read as 0.
