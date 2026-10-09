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
                               ├─ OPPORTUNITIES ─ build projects ─ versions, runs, requirements, assets
                               │                ─ messages, outcomes, verifications
                               ├─ PROVIDER CONNECTIONS
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
| ANALYZE | Fetch, render and check the selected businesses. Only queued businesses can have analysis cost metered against them | `ANALYSIS_QUEUED` → `ANALYZED`, `business_analyses`, `snapshots`, `observations`, `cost_events`, `src/analysis` | Built. Automated static-HTML analysis since Slice 11 (A34); rendering a page in a browser is Deferred |
| Evidence | A defect or gap stated with URL, verbatim quote, capture time, confidence and rule version | `evidence`, `issue_codes` | Built |
| Re-check | The same check on a later snapshot before the finding reaches a prospect | `evidence_rechecks` (append-only) | Built, Manual. Recorded from the Case File since Slice 9 (`recordCaseRecheck`) |
| OPPORTUNITY | A sellable problem resting on at least one evidence row. A business can hold several | `opportunities`, `opportunity_evidence`, `OPPORTUNITY_FOUND` / `NO_OPPORTUNITY` | Built |
| Service | The catalog item the opportunity maps to, or `UNMAPPED` with a reason | `catalog_items`, `opportunity_price_guard` | Built |
| BUILD/FIX | A `DEMO` before the pitch, or the `DELIVERY` after a win | `build_kinds`, `builds`, `build_evidence`, `src/build` | Built for two kinds: `website` (Slice 5/6, `src/build/site`) and `website_fix` for broken contact links (Slice 7, `src/build/fix`). Other kinds are Boundary |
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
- **Only a "no such host" answer is an observed DNS failure.** `ENOTFOUND`/`ENODATA` is
  `dns_not_found` (unreachable, OBSERVED). A lookup that failed (`EAI_AGAIN`, a timed-out or refused
  resolver) is `other`, so the status is unreachable on a `NOT_OBSERVABLE` basis. An environment
  whose resolver answers `ENOTFOUND` for every name (some sandboxes do) still looks like a real
  "not found"; run analyses where public DNS works.
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

### Automated analysis (Slice 11)

From the Find screen a seller analyses the businesses they selected. `analyzeRunBusiness`
(`src/analysis/service.ts`) works on one business of one run at a time:

1. It locks the run's row for that business, in the server's workspace. Only `SELECTED` (or already
   `ANALYSIS_QUEUED`) businesses are analysed, in an open run. A run with a credit budget is
   refused because analysis has no credit rate yet. A concluded business returns its existing
   result, so analysing twice requests nothing.
2. With no known address it records `NO_ADDRESS` and requests nothing. An address that is not a
   public web address is `REFUSED` before any request.
3. Otherwise one GET of the homepage through `SafeProbe` (DNS pinned, private ranges refused,
   every redirect re-checked, 10 s timeout, 2 MB cap). The page is hashed, never stored or logged.
4. Checks read only the served HTML (`src/analysis/checks.ts`, analyser `scopely.static/1`):

| Rule | OBSERVED | NOT_OBSERVABLE |
|---|---|---|
| `check.website_presence` v1 | The answer, redirects, HTTPS, or the network error | |
| `check.page_signals` v1 | Title, description, viewport, a form (never submitted), contact page, parked page | No form in the HTML (one can be added by script) |
| `check.contact_links` v2 | Each tel:, WhatsApp and mailto: link: dialable, or a defect (E-TEL-BROKEN, E-WA-BROKEN, E-EMAIL-INVALID, E-LINK-TARGET-MISMATCH) with the anchor quoted verbatim | No contact links in the HTML; whether a mailbox accepts mail |
| `check.booking_cta_trace` v2 | A Book link whose destination answers 404/410 or has no such host (E-CTA-DEAD-END, MEDIUM), or one that answers | `#` / `javascript:` links, 401/403/429/5xx, timeouts |
| `check.booking_platform_fingerprint` v2 | A known booking platform in links, scripts or frames | None found (a widget can be added by script) |

5. A working website is INFERRED from the answer, title and text, never OBSERVED.
6. OBSERVED defects become `evidence` (URL, verbatim quote, observed time, confidence, rule
   version). Opportunities open only through the catalog (A35); a finding no service covers, or
   that an open opportunity already holds, is shown with that note and opens nothing.
7. The business concludes `OPPORTUNITY_FOUND` or `NO_OPPORTUNITY`. The opportunity's Case File
   applies the existing gates unchanged: HIGH findings need a re-check before Sell, and a
   `website_fix` opportunity can start the Fix Builder.

## BUILD/FIX

BUILD is an optional layer. Every stage before and after it works without it. Slice 4 adds the
Build Workspace foundation: data, guards, interfaces and read contracts. **No agent, model
provider or secret store is implemented, nothing calls a model, and nothing generates, hosts or
deploys a website.**

```
OPPORTUNITY ─ BUILD PROJECT ─ BUILD VERSION (builds) ─ BUILD RUN ─ BUILD AGENT ─ MODEL PROVIDER
 (mapped)      one effort      numbered 1..n, human     one agent   how the     which model API,
               for one kind    lifecycle and gates      attempt     work runs   via a connection
```

The six concepts stay separate: a project is not a version, a version is not a run, a run is not
an agent, and an agent is not a model provider.

- **Build project** (`build_projects`, Built). One build effort for one `MAPPED` opportunity, of
  the build kind its catalog item names. An opportunity may have several projects (a second
  effort). The opportunity and kind never change. Requirements (`build_requirements`) and assets
  (`build_assets`) belong to the project; they are withdrawn, never edited.
- **Build version** (`builds`, Built). Every build has a `project_id` and a `version_no`, unique
  per project and assigned by the database. A version recorded without a project opens one.
  A version `supersedes_build_id` at most one earlier version of the same project and purpose,
  and a version has at most one successor. Superseding marks the parent `SUPERSEDED`
  automatically (even after it was shown: the shown record stays), and a superseded version is
  final. Project, number, purpose and what a version supersedes or continues never change.
  Migration 009 turned each existing supersede chain into one project numbered 1..n and refuses
  to upgrade a chain that branches.
- **A `DEMO` is never delivery and never revenue.** A `DELIVERY` build needs a won opportunity. It
  may name the demo it continues (`delivery_of_build_id`, a `DEMO` of the same opportunity and
  project); the demo stays as the record of what was pitched. A `DELIVERY` never supersedes a
  `DEMO`, and a `DELIVERY` is delivered, not shown as a pitch. A demo is shown only after approval,
  and only if its evidence passes the same re-check gate as a sent message. Content, preview and
  manifest are frozen once approved or shown.
- **Build run** (`build_runs`, Boundary). One attempt by a build agent to produce a version, or a
  modification of `base_build_id`. Status `QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED`
  (`QUEUED → CANCELLED` too); a finished run is frozen. It records the agent key and version, the
  provider connection it used (nullable), times, an error code (never the error text, which may
  quote model output), the version it produced and safe metadata. **Run state is never a
  version's state.** The feed shows both, apart: `buildState` (human lifecycle) and
  `buildRunState` (latest run).
- **A run can never pass a human gate.** A run has no approval, show or delivery columns. The
  version it produces must be a `DRAFT` with no approval, in the same project and purpose, and must
  supersede the run's base. While the executor records it, the request acts as a build agent
  (`scopely.actor_kind = 'build_agent'`) and the database refuses approving, showing or discarding
  a build and writing any outcome (won, delivered), verification, evidence re-check or message.
  Approval and showing stay with `approveBuild` / `markBuildShown`, called for a person, and the
  show still waits for the evidence re-check.

### Three roles

| Role | Answers | Keyed by | Today |
|---|---|---|---|
| `FixBuilder` | WHAT to build: turns a BuildContext into structured instructions (`instruct`) and owns the kind's rules | build kind | Interface; registry empty |
| `BuildAgent` | HOW the work is executed: a Scopely-managed agent, Claude Code, Codex, another coding agent or an external build tool | agent key, chosen per run | Interface; registry empty |
| `ModelProvider` | WHICH model API powers a call: Scopely-managed, Anthropic, OpenAI, Google or another | provider, opened from a provider connection | Interface; registry empty |

A build kind never implies an agent, and an agent never implies a provider. An agent declares its
model use: `NONE`, `OWN_MODEL` (it brings its own model and billing, so Scopely records no provider
cost for it) or `PROVIDER_CONNECTION` (it is handed a model opened from the run's connection). An
agent receives the BuildContext, the instructions and a project storage handle, never a database
handle. `executeBuildRun` is the only code that turns an agent's result into a row.

### BuildContext

`loadBuildContext(db, projectId, { purpose, baseBuildId })` is what an agent may see: the business
identity (name, domain and website as recorded, with the sources that found them), sourced facts (employees, revenue,
reviews, website status, coordinates) each with `basis` (`VERIFIED` / `REPORTED` / `ESTIMATED`),
source and date, the opportunity, only the evidence that still holds (a HIGH finding carries its
latest re-check), the catalog item, the build kind and path, active requirements and assets, and
`NOT_OBSERVABLE` observations as structured items that stay `NOT_OBSERVABLE`. An estimate stays
labelled `ESTIMATED`. Attributes with no recorded basis or source (address, city, region, country, phone,
company register fields, structure, industry, niche, specialty) are listed as withheld, not
passed as fact; that is how B12 reaches the build layer. No page HTML, no contact
details, no credentials; the context is checked for secret-shaped values before an agent gets it.

### Project storage

Each project has a key prefix `workspaces/<workspace>/projects/<project>/`: versions under
`versions/`, assets under `assets/`. A version's `manifest_ref` (and an asset's `storage_ref`) must
be a key under its own project's prefix; another project, another workspace, `..`, a URL or a
scheme is refused. No files are stored in Postgres. Since Slice 5 an `ObjectStore`
(`src/storage`) holds the files: write-once, read back only against the sha256 the version
recorded, in memory for tests or a local folder for `pnpm serve` (B18). An agent gets a handle that
reads the project's prefix and writes only inside its run's own `versions/run-<id>/` prefix.

### Provider connections

`provider_connections` (Boundary): a workspace's link to a model provider, with `mode`
`SCOPELY_MANAGED` (Scopely's key; no `credential_ref`) or `CUSTOMER_KEY` (the workspace's own key),
`state` `PENDING` / `ACTIVE` / `REVOKED` / `ERROR`, `scopes` (`build`, `analysis`) and a
`credential_ref`. The ref names a future secret, `secretref:ws/<workspace>/<name>`, inside the
owning workspace's namespace; anything that looks like a key is refused. No raw secret column
exists on any table (a schema test enforces it) and run, build, cost and requirement metadata is
checked for secret-shaped values. A run may use only an `ACTIVE`, `build`-scoped connection of
its workspace. Ownership is the workspace; whether a user may own one too is open decision B14.

**Build-time credentials are not runtime website secrets.** A provider connection's key powers
Scopely's build agents while a version is made. It is never put in a BuildContext, instructions,
an agent result, a manifest or a generated project, and it never shares a namespace with the
secrets a delivered website needs at runtime (its own API keys, form endpoints, analytics ids),
which are the client's and are out of scope until a slice covers deployment.

### Who pays for build AI

`cost_events.billed_to` is `SCOPELY` or `WORKSPACE`, or NULL when no payer was recorded. A cost
through a `CUSTOMER_KEY` connection is billed to the `WORKSPACE` and carries no Scopely credits
(credits 0 or NULL); a `SCOPELY_MANAGED` connection is billed to `SCOPELY`. The connection decides
it: a contradicting payer or provider is refused, and a provider cost with no payer is refused.
Payer, connection and run never change on a recorded cost. No price is assumed: an unknown amount
stays NULL. How Scopely-managed build AI is charged to a workspace is open decision B15.

### Template-first website builds (Slice 5)

One build kind, `website`, and one template, **Meridian**. Nothing in the template names a
business, place, seller or price. Version 1 (Slice 5: hero, services, about, reviews, gallery,
contact, footer; five colour schemes, three type pairs, three hero layouts) is frozen. Version 2
(Slice 6, the design handoff's "Modern Clinic" direction) adds a call-to-action band, four
palettes (Stone, Sage, Blush, Noir), three type pairings with embedded OFL faces (Editorial,
Modern, Classic), split and centred heroes, and page-wide button, spacing, image and background
styles (`change_style`). A version keeps the template version it was made with, so its artifact
always re-renders to the same bytes; a new version is made with the current template
(`upgradeDocument` maps a version 1 document to the nearest version 2 choices and adds the band).

- **The site is a document, not HTML.** A `SiteDocument` (`scopely.site/1`, or `/2` for Meridian 2) holds the template
  key and version, brand, theme, the main button (label and destination), the sections with their
  content, the review fact, per-field provenance (`template`, `business`, `fact`, `person`, `ai`)
  and the **basis**: the evidence it answers (the BEFORE), what each change does about it (the
  AFTER), the facts used and what was left out on purpose. The renderer turns a document into one
  static HTML file with inline CSS, no script, escaped text and images as data URIs.
- **Generation states only what it can back.** The business name and a sourced review rating are
  used. Services, about text, photos and the button's destination could not be observed, so they
  are left for a person, and the editor lists them as readiness items. An address, phone, hours,
  prices or services are never written from nothing. `NOT_OBSERVABLE` checks and withheld facts
  appear under "left out on purpose".
- **Every edit is a validated operation.** `update_text`, `update_items`, `replace_image`,
  `set_images`, `update_cta`, `change_color`, `change_font`, `change_layout`, `change_style`, `show_section`,
  `hide_section` and `move_section` are parsed strictly against the template (slots, lengths,
  variants, palettes, image ids, contact formats). One bad operation refuses the whole batch. The
  browser sends operations and receives rendered HTML; it never sends HTML.
- **AI edits propose; they do not apply.** An `EditInterpreter` turns a request into operations,
  which go through the same validator with origin `ai`. Since A16 an AI edit may rewrite copy
  (headline, supporting text, section text, service descriptions, button labels), but every word
  passes the claim check: no numbers or statistics, prices, reviews, awards, credentials or
  expertise, history or years of experience, guarantees, memberships, locations, "we offer …"
  service claims, "now you can book online", contact details, markup or code. It may reword a
  service's description but not add or rename a service (or a contact detail such as hours), and
  it may not supply a phone, WhatsApp number, email or link the person did not write in the
  request; when one is needed it asks. A sourced fact such as the review rating is rendered from
  the fact, never written as copy. A refused edit makes no version. The interpreter in this slice
  is deterministic (`modelUse = NONE`): it places the copy a request quotes into the slot the
  request names. A model-backed interpreter would draft copy instead, through the same checks,
  receiving a `ModelProvider` from the run's provider connection; it never sees a key.
- **Versions.** Generation and AI edits are build runs (Slice 4's `executeBuildRun`), so they
  produce a DRAFT or nothing. The executor checks that the agent's files are inside its own run
  prefix and match their hashes, and removes them if the run fails. A person's saved edits and a
  restore make a new version directly (generator `editor:meridian@<template version>`), carrying the
  same cited evidence. Undo is a restore of the version the current one replaced, made as a new
  version (A18); nothing is deleted. An AI edit records what it changed (`lastEdit.changes`) so the
  workspace can show each change and offer Undo. Edits apply only to the newest version; approved and shown versions never change, and
  migration 010 refuses a stored artifact outside the project's `versions/` prefix or without a
  hash.
- **Approve and show are Slice 4's gates,** plus one for websites (A14): a version whose main
  button has no destination can be approved but not shown, and the artifact never renders a
  button that goes nowhere. A person approves; an agent cannot. Showing needs the approval and,
  for HIGH evidence, a confirmed re-check.
- **Preview links** are HMAC-signed tokens naming workspace, project, version, kind and expiry.
  An `edit` link (the Build Workspace's own, 15 minutes) is stateless. A `show` link, for a
  prospect, also names a `preview_links` row (A15): it lasts 72 hours by default, and the seller
  can revoke it, which stops it on the next request. Its state is ACTIVE, EXPIRED or REVOKED;
  revoking never changes the version. Opening a link re-reads the version (and the link row)
  inside the token's workspace and checks the artifact's hash. The artifact is served with a
  sandboxing content security policy; a `show` link opens a page that says it is a design
  preview, not a live website.

### Fix Builder: broken contact links (Slice 7)

The first Fix kind is the Website Fix Sprint, limited to the contact-link findings Scopely has
already proven (A21): the VALIDATED codes of `check.contact_links` (`E-TEL-BROKEN`,
`E-WA-BROKEN`, `E-LINK-TARGET-MISMATCH`, `E-EMAIL-INVALID`). It is separate from the website path:
its own project (`build_kind = website_fix`), its own screen (`#/f/:projectId`), and the Slice 4
projects, runs, versions, approval, show and preview links underneath.

PROBLEM → EVIDENCE → CAPTURE → PROPOSED FIX → GENERATE → BEFORE / AFTER → CONFIRMATION → PREVIEW → SHOW

- **Problem and evidence.** `openFixProject` needs an opportunity mapped to a `website_fix` service
  with at least one supported, OBSERVED finding that still holds. The evidence row (URL, quote,
  observed time, confidence, rule version, workspace and opportunity) stays the source of truth.
- **Capture (A23, F3).** Opening the screen captures the page once: an SSRF-safe fetch (http/https
  only, default ports, no credentials, every resolved address checked against private and
  reserved ranges, pinned DNS, at most 3 re-checked redirects, 10 s, 2 MB, `text/html` only) written
  write-once to the project's `captures/` prefix and recorded in `fix_captures` with the requested
  and final URL, status, content type, hash, size, the observed destination and how many links on
  the page still carry it. A capture never changes, an agent cannot make one, and a finding a
  re-check found changed or gone cannot be captured. One `cost_events` row (`fetch`) meters it.
  Reserved `.example` hosts are served from `fixtures/demo-pages/` by `pnpm serve` for the demo.
- **Proposed fix (A24, F4).** A person types the corrected destination in `fix_corrections`: a
  phone (`tel:+E164`, the country code is required and never guessed), a WhatsApp number
  (`https://wa.me/<digits>`) or an email (`mailto:`), only of a kind that repairs the finding's
  code, never the broken value itself. It starts unconfirmed, never changes (a new value withdraws
  the old one), and an agent cannot supply or confirm one.
- **Generate.** `generateFix` queues a run of `ScopelyFixAgent` (deterministic, no model). The
  agent reads the capture by hash from its own project (A22, F2), replaces the href of only the
  links whose destination is the observed broken one, keeps every other byte, and writes the
  corrected copy, `fix.json` and the prospect's preview as a DRAFT version. `build_fix_corrections`
  records which corrected values the version applies.
- **Before / after.** The seller sees the link before and after, and can compare both whole page
  copies through the version's edit link (`/p/:token?view=before|after`, sandboxed, no scripts).
- **Confirmation.** `confirmFix` needs the person to tick that the destination is correct and give
  their name; it confirms the version's corrected values and approves it in one step. The
  database refuses to approve or show a fix version made from a capture unless every corrected
  value it applies is confirmed and none is withdrawn (`fix_build_blocker`, the `build_fix_gate`
  trigger, and both gate functions). Slice 2's operator `website_fix` builds, which have no
  capture, are unchanged.
- **Preview and show.** Showing keeps every Slice 4 gate (approval, cited evidence, a confirmed
  re-check for HIGH evidence). The prospect's page states what was observed, shows the link
  before and after, and says that nothing on the live website has been changed. Links are signed,
  last 72 hours and can be revoked (A15).

## Selling from the seller's own mailbox

- **A mailbox is a workspace connection** (`mailbox_connections`: Google Workspace or Microsoft
  365, state `MANUAL` / `PENDING` / `CONNECTED` / `DISCONNECTED` / `REVOKED` / `ERROR`,
  `credential_ref` only, never a token). There is no global sender.
- A message records its recipient at approval and its mailbox and sender at send; the mailbox must
  belong to the same workspace and be `MANUAL` or `CONNECTED`. Sent messages are frozen.
- **Lawful basis is data.** `outreach_basis_rules` holds the per-country rule; GB corporate-subscriber
  outreach needs an active Ltd or LLP (PLC is open decision B3).
- **Suppression is per workspace** and can target an email, a domain or a business. One seller's
  opt-out list never reaches another's. An explicit `opt_out` reply suppresses its business in the
  same write (A29, migration 013); `not_interested`, `wrong_person` and every other outcome do not.

### Prospect Readiness (Slice 9)

The Case File turns an opportunity into a prospect the seller may act on, with writers for what the
gates already read, all scoped to the opportunity they are made from (`src/sell/prospect.ts`):

- **Re-check.** A person visits the evidence's own URL (never one the request names) and records
  still there, no longer there, or changed (with a note). It is a new `snapshots` row
  (`fetch_method = 'manual'`, the request's time), an `OBSERVED` observation of the same check and
  rule version (the original gap/defect result, or `ok`), and an `evidence_rechecks` row, so
  `evidence_recheck_guard` judges it. An `INFERRED` finding can only be recorded as changed.
- **Contact.** Name and/or email, role, decision maker, email kind, `source` (required), source
  link, `label` and `outreach_basis` (`unknown` allowed), as the seller typed them. `mx_ok` stays
  unknown; nothing is looked up. A contact can be corrected in place.
- **Company register.** `company_type` and `company_status` (Companies House vocabulary, which the
  GB rule reads), with the register and number when known. Nothing is looked up; there is no
  source or as-of column for these facts.
- **Suppression.** A contact's address, the business's domain or the business, with a reason from
  the existing vocabulary.
- **Readiness** (A30). Checks: evidence, contact, lawful basis, company status (only where the
  country has a rule for the basis), suppression. Each is done, missing or blocked. READY needs
  `evidence_send_blocker` to pass now for the findings that still hold and one contact to pass
  `contact_outreach_blocker`; SUPPRESSED when the business, its domain or every contact's address is
  suppressed. The Case File offers "Write in your email app" only for a contact of a READY prospect.
- No Gmail or Microsoft API is built. Sending is manual and recorded.

### Prospect intelligence (Slice 12)

OPPORTUNITY → PROSPECT INTELLIGENCE → DECISION MAKER → PUBLIC/VERIFIED CONTACT → OUTREACH-READY,
inside the Case File (07 Buyer · prospect, 08 Outreach preparation). Nothing is sent.

- **Who.** People stay in `contacts`. A provider's person carries `provider_operation_id`,
  `provider_person_ref`, `observed_at`, the source's own `confidence` and its `provider_record`
  (listed fields only, secret-scanned). It is stored UNVERIFIED, not a decision maker, with no
  relationship and outreach basis `unknown` (A37).
- **How to reach them.** Every channel is a `contact_facts` row of a person or of the business:
  title, email, phone, WhatsApp, LinkedIn, Instagram, X or contact page, with its source, source URL,
  time, label and exactly one origin (a provider call or the person who recorded it). Facts are
  never edited or deleted; a second source saying something different is a second row, shown as a
  conflict. The business's own channels are read from the analysis (OBSERVED contact links and the
  contact page), with a broken link marked broken.
- **Why them, how sure.** `assessBuyer` reads what is on file and labels each reason OBSERVED,
  RECORDED, REPORTED or INFERRED. A decision maker needs a recorded basis; a senior title only
  makes a likely buyer, and the screen says it is inferred (A39). `suggestBuyer` picks who to contact
  first; the seller decides.
- **Lookups** go through the gateway (`prospect_intelligence`) on the workspace's own key with the
  `prospects` scope, or replay recordings; a suppressed business is never looked up; a failure or an
  empty answer stores no one and is never evidence that no one exists (A38). The Clay adapter
  searches people by company domain or company profile and returns names, titles and LinkedIn
  only. Paid enrichment is not built (B22).
- **Ready?** Unchanged (A30): the evidence and contact gates decide, and suppression wins.

## Budgets and metering

- A search sets `max_businesses_to_analyze`, `analysis_budget_credits` and
  `max_discovered_per_run`; a run copies them at start.
- Selection past the analysis cap, queueing past the credit budget, queueing with an unknown
  estimate under a budget, and metered cost past the budget are all refused in the database.
- `cost_events` attributes cost (money and credits) to a workspace, search run, business,
  opportunity, build or build run, and says who pays (`billed_to`, see BUILD/FIX). An unknown amount stays NULL, and `estimateRunAnalysis` reports unknown
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
with filters, map points, business detail, run summary and stage funnel, search performance and
saved searches, and the Build Workspace (projects, versions with server-computed gates, runs).
Money and credits are decimal strings with their currency. NULL means "not known" and must never
read as 0.
