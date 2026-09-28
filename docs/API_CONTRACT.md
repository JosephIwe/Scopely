# API contract for the frontend

What the backend gives a screen today. The shapes are TypeScript types in `src/api/types.ts`; the
functions that produce them are in `src/api/queries.ts` (read side) and in `src/discovery`,
`src/record`, `src/sell/mailbox.ts` and `src/tenancy` (write side). There is no HTTP layer yet: a
route is a thin wrapper that authenticates, checks membership and calls one of these inside
`withWorkspace`.

## Conventions

- **Every call acts inside one workspace.** The caller sets it with `withWorkspace(db, id, fn)`
  inside a transaction, after checking `isMember`. With no workspace set, reads return nothing and
  writes fail. Another workspace's ids behave as if they do not exist.
- **Ids are strings** (Postgres bigint). **Counts are numbers.**
- **Money and credits are decimal strings** (`"350.00"`) with their currency beside them. Never
  parse them to floats for arithmetic; never sum across currencies.
- **`null` means not known.** Show it as unknown, never as 0 or "none". Examples: unknown revenue,
  unknown employee count, an unknown analysis estimate, a revenue-per-100 with no discovered
  businesses.
- **Estimates are labelled.** Every firmographic group carries `basis` (`VERIFIED`, `REPORTED`,
  `ESTIMATED`), `source` and `asOf`. Show `ESTIMATED` as an estimate.

## Read

| Function | Returns | Screen |
|---|---|---|
| `listOpportunities(db, filters)` | `OpportunityFeedItem[]` | The unified feed: WEBSITE and FIX opportunities together |
| `getBusinessDetail(db, businessId)` | `BusinessDetail \| null` | Business page: location, website status, firmographics, sources, runs, evidence, opportunities |
| `listMapBusinesses(db, query)` | `MapPoint[]` | Map. Only businesses with source-given coordinates |
| `getSearchRunSummary(db, runId)` | `SearchRunSummary \| null` | Run header: counts, limits, credits, cost, revenue |
| `getSearchRunStageFunnel(db, runId)` | `StageFunnelRow[]` | Pre-qualification funnel, one row per stage |
| `listRunBusinesses(db, runId, { states, limit, offset })` | `RunBusinessRow[]` | Run table with each decision and why |
| `getSearchPerformance(db, searchId?)` | `SearchPerformance[]` | Which searches make money |
| `estimateRunAnalysis(db, runId)` | `AnalysisEstimate` | Before queueing: known credits, unknown count, budget left |
| `listMailboxes(db)` | `Mailbox[]` | Sender picker |

### Feed filters (`OpportunityFeedFilters`)

`kinds` (build kind keys), `paths` (`WEBSITE` / `FIX`), `verticals`, `subverticals`,
`countryCode`, `region`, `city`, `employeeMin` / `employeeMax` (+ `includeUnknownSize`),
`revenueMin` / `revenueMax` with a required `revenueCurrency` (+ `includeUnknownRevenue`),
`catalogKeys`, `minConfidence`, `statuses`, `buildStates`, `sellStates`, `searchId`,
`searchRunId`, `limit` (≤ 500), `offset`.

- A size or revenue filter keeps a business only when its known figure (exact, or the whole
  range) lies inside the filter. Unknown figures are excluded unless the `includeUnknown…` flag is
  set. Revenue in another currency is never converted and never matches.
- Order is newest first.

### Feed item states

- `buildState`: `NONE`, or `DEMO_` / `DELIVERY_` + `DRAFT` / `APPROVED` / `SHOWN`.
- `sellState`: `NOT_STARTED`, `DRAFTED`, `APPROVED`, `SENT`, `PITCHED`, `REPLIED`, `WON`, `LOST`.
- `deliveryState`: `NONE`, `AWAITING_DELIVERY`, `DELIVERED`, or `VERIFIED_` + `PASSED` /
  `FAILED` / `NOT_OBSERVABLE` / `CLIENT_REQUIRED_UNCONFIRMED`.
- A shown `DEMO` never changes `sellState` to `WON` or `dealValue`. Only a `won` outcome does.

### Map query (`MapQuery`)

Any of `bounds` (`north`, `south`, `east`, `west`; west > east crosses the antimeridian),
`near` (`latitude`, `longitude`, `radiusKm`), `city`, `region`, `countryCode`, `limit` (≤ 5000).
Each point carries its website status and the paths and kinds of its opportunities, for pin
styling.

## Write

| Function | Does | Refused when |
|---|---|---|
| `createWorkspace(db, { slug, name, owner? })` | Provisions a workspace (service role) | slug taken |
| `registerManualMailbox(db, { provider, email })` | Adds a sender to this workspace | same email twice in the workspace |
| `createSearch(db, SearchInput)` | Saves an ICP | inverted ranges, revenue without currency, unknown opportunity kind |
| `startSearchRun(db, searchId)` | Starts a run with frozen criteria and limits | search archived or in another workspace |
| `runDiscovery(db, registry, runId, provider)` / `recordDiscoveredBusiness(db, runId, business)` | Adds candidates, deduplicated per workspace | past `max_discovered_per_run` |
| `prequalifyRun(db, runId, asOf)` | Qualifies, rejects or flags every `DISCOVERED` business | — |
| `resolveReview(db, runId, businessId, { state, reviewedBy, note })` | Settles a `NEEDS_REVIEW` | no reviewer or note |
| `selectForAnalysis(db, runId, picks, by, at)` | Selects qualified businesses | not qualified; past the analysis cap |
| `queueForAnalysis(db, runId, ids, at)` | Queues selected businesses | past the credit budget; unknown estimate under a budget |
| `markAnalyzed` / `concludeAnalysis` | Closes analysis; concludes `OPPORTUNITY_FOUND` or `NO_OPPORTUNITY` | out of order |
| `recordWebsiteStatus(db, businessId, …)` | Sets website status with basis and source | "not observed" with a known address; unsupported basis |
| `recordOpportunity`, `recordMessage`, `approveMessage`, `markMessageSent(…, mailboxConnectionId)`, `recordOutcome`, `recordCost`, `recordBuild` | The existing manual loop, now per workspace | the Truth Rule guards, lawful basis, suppression, re-check, budget |

Every refusal is a database error whose message names the rule. Show it; do not retry.

## Justified indexes

Each backs a filter above: businesses by workspace + geography, + industry, + website status,
+ size range, + revenue currency and range, + coordinates, + domain; opportunities by workspace +
kind + status and by run; run businesses by run + state and by business; cost by run and by
opportunity; searches by workspace; runs by search.
