# API contract for the frontend

What the backend gives a screen today. The shapes are TypeScript types in `src/api/types.ts`; the
functions that produce them are in `src/api/queries.ts` (read side) and in `src/discovery`,
`src/record`, `src/sell/mailbox.ts`, `src/build` and `src/tenancy` (write side). There is no HTTP layer yet: a
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
| `listSearches(db, { includeArchived? })` | `SearchListItem[]` | Saved searches |
| `getSearch(db, searchId)` | `SearchDefinition \| null` | A saved search's actual criteria, grouped as the form shows them, and its runs |
| `listBuildProjects(db, { opportunityId? })` | `BuildProjectListItem[]` | Build projects, newest first, with version count, latest version status and run state |
| `getBuildProject(db, projectId, { asOf? })` | `BuildProjectView \| null` | Build Workspace: project, opportunity, build kind, current version, version history, runs, requirements, assets, cost by payer, storage prefix |
| `listBuildVersions(db, { projectId } \| { opportunityId }, { asOf? })` | `BuildVersionView[]` | Version history, oldest first |
| `getBuildRun(db, runId)` | `BuildRunView \| null` | One agent run: agent, connection, state, times, error code, produced version, cost |
| `listProviderConnections(db)` | `ProviderConnection[]` | Provider settings: provider, mode, state, scopes, payer; never the credential reference |

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

- `buildRunState`: the latest agent run of the opportunity's projects (`NONE`, `QUEUED`,
  `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`). It is execution state, never approval: a
  `SUCCEEDED` run's version is still a `DRAFT` until a person approves it. Show it apart from
  `buildState`.

### Build Workspace

- **Version status** (`BuildVersionStatus`: `DRAFT`, `APPROVED`, `SHOWN`, `DISCARDED`,
  `SUPERSEDED`) is the human lifecycle. **Run status** (`BuildRunStatus`) is an agent's
  execution. They are separate fields on separate objects.
- **Each version** carries `projectId`, `versionNo`, `purpose` (`DEMO` / `DELIVERY`),
  `supersedesBuildId`, `successorBuildId`, `deliveryOfBuildId`, `previewRef`, `manifestRef`, the
  cited `evidence` (each with its latest re-check result), `approval`, `shown`, `producedByRun`
  and `cost`.
- **Gates are computed by the server.** `gate.canApprove` / `approveBlocker` and `gate.canShow` /
  `showBlocker` come from the same database functions the write guards use, evaluated at
  `gate.asOf` (default now; pass `asOf` to ask about a planned show time). Whenever `canShow` is
  false, `showBlocker` says why: a DELIVERY is delivered not shown, already shown, superseded by
  build N, discarded, needs a recorded human approval, cannot be shown before it was approved,
  cites no evidence, or the evidence re-check reason. A screen never recomputes a gate.
- **`approval.approvedByIsAuthenticated` is always `false`** today: `approvedBy` is a free-text
  label, not a signed-in user (B10).
- **`currentVersion`** is the newest version that is not `SUPERSEDED` or `DISCARDED`, or `null`.
- **Cost by payer** (`CostByPayer[]`): one row per `SCOPELY`, `WORKSPACE` and `UNATTRIBUTED`
  (payer not recorded) with events, amount and currency (`null` when unknown or when currencies
  are mixed), credits and operator minutes. `WORKSPACE` rows never carry Scopely credits.
- **Refs are storage keys, not URLs.** `previewRef`, `manifestRef` and asset `storageRef` are keys
  under the project's `storagePrefix`. A browser never receives them: the Build Workspace HTTP
  surface below serves a version only through a signed preview link.

### Website builds (Slice 5, `src/build/site/service.ts`)

Functions take the database client (inside `withWorkspace`) and an `ObjectStore`. `SiteError`
carries an HTTP status and a message a person can read; `EditRejected` carries the index of the
refused operation and why.

| Function | Does |
|---|---|
| `openWebsiteProject(db, opportunityId)` | Opens (or reuses) the opportunity's website project; refuses an opportunity not mapped to a website service |
| `getBuildSetup(db, projectId)` | `BuildSetup`: business, the evidence it answers, build type, templates, the planned changes, facts used and left out |
| `generateSite(db, deps, projectId, { templateKey })` | A build run that makes version 1 (or a fresh version); returns `RunOutcome` (`status`, `buildId`, `errorCode`, `message`) |
| `renderDraft(db, store, projectId, { baseBuildId, operations, selected })` | Applies operations in memory and returns editor HTML and readiness; stores nothing |
| `saveEdits(db, store, projectId, { baseBuildId, operations })` | A new version from the person's operations |
| `requestAiEdit(db, deps, projectId, { baseBuildId, request })` | A build run: request → operations → validation → new version; `lastEdit.needsInput` lists what it asks for |
| `restoreVersion(db, store, projectId, { baseBuildId, fromBuildId })` | An earlier version's document as a new version |
| `uploadImage(db, store, projectId, { bytes, description, recordedBy })` | PNG, JPEG, WebP or GIF up to 5 MB, checked by content; SVG refused; stored as a project asset |
| `approveVersion(db, projectId, buildId, { approvedBy })` | Slice 4's approve, with its blocker; allowed without a button destination |
| `showVersion(db, store, projectId, buildId)` | Slice 4's show, and refused (`NO_BUTTON_DESTINATION`) while the button has no destination |
| `previewLink(db, projectId, buildId, { kind, signingKey, ttlSeconds? })` | A signed link; `show` only for a shown version, stored as a revocable link (72 hours by default) |
| `listProspectLinks(db, projectId, { signingKey })` | `ProspectLink[]`: version, created, expires, revoked, `state` (`ACTIVE` / `EXPIRED` / `REVOKED`) and the token while active |
| `revokeProspectLink(db, projectId, linkId, { revokedBy })` | Stops a link at once; the version does not change |
| `getSiteWorkspace(db, store, projectId, { selected })` | `SiteWorkspace`: project, current version (document, editor HTML, readiness, blockers), history, template, images |

### Build Workspace HTTP (`pnpm serve`, `src/server/app.ts`)

JSON over HTTP, acting in the one workspace the server was started with (B10). Every non-GET
request must send `x-scopely-request: 1`, and an `Origin` header, when present, must be this
server; anything else is `403`. Each request is one transaction. Errors are `{ error }` with a
readable message; an unexpected failure is `500` with no detail. Responses carry no storage keys
or hashes.

| Route | Body → result |
|---|---|
| `GET /api/opportunities` | Opportunities with their first plain-language issue, `buildable` and `projectId` |
| `POST /api/opportunities/:id/website` | → `{ projectId }` |
| `GET /api/projects/:id/setup` | `BuildSetup` |
| `GET /api/projects/:id/workspace?selected=` | The workspace screen, with `links` (state and, while active, url) |
| `POST /api/projects/:id/generate` | `{ templateKey }` → `RunOutcome` |
| `POST /api/projects/:id/render` | `{ baseBuildId, operations, selected }` → `{ html, readiness }` |
| `POST /api/projects/:id/save` | `{ baseBuildId, operations }` → the new version |
| `POST /api/projects/:id/ai-edit` | `{ baseBuildId, request }` (≤ 500 characters) → `RunOutcome` |
| `POST /api/projects/:id/restore` | `{ baseBuildId, fromBuildId }` → the new version |
| `POST /api/projects/:id/images` | raw image bytes, `x-description` (URI-encoded alt text) → the image |
| `POST /api/projects/:id/versions/:bid/approve` | `{ approvedBy }` |
| `POST /api/projects/:id/versions/:bid/show` | → `{ url, expiresAt }`, the prospect's link |
| `POST /api/projects/:id/versions/:bid/link` | `{ kind: 'edit' \| 'show' }` → `{ url, expiresAt }` |
| `POST /api/projects/:id/links/:lid/revoke` | `{ revokedBy }` → `{ ok }` |
| `GET /p/:token` | The artifact, with a sandboxing content security policy |
| `GET /s/:token` | The prospect's page: a "design preview, not a live website" bar around the artifact in a sandboxed frame |

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
| `createBuildProject(db, { opportunityId, title, createdByUserId? })` | Opens a build project; the kind comes from the opportunity's service | opportunity unmapped, in another workspace, or its service has no build kind; creator not a member |
| `recordRequirement` / `recordAsset` | Adds a requirement or asset to a project | text that looks like a secret; an asset key outside the project's `assets/` prefix |
| `registerProviderConnection` / `activateProviderConnection` / `revokeProviderConnection` | Records a provider connection; no key is stored or checked | a ref outside `secretref:ws/<this workspace>/…`, a secret-looking ref, a managed connection with a ref, changing provider or mode, reviving a revoked one |
| `queueBuildRun(db, BuildRunInput)` / `cancelBuildRun` | Queues or cancels an agent run | a connection that is not ACTIVE with `build` scope; a base version from another project or purpose |
| `executeBuildRun(db, deps, runId)` | Runs one queued run with a registered agent and records a DRAFT version, or FAILED with an error code | the run is not QUEUED; nothing is registered by default, so today every run fails `AGENT_NOT_AVAILABLE` |
| `recordOpportunity`, `recordMessage`, `approveMessage`, `markMessageSent(…, mailboxConnectionId)`, `recordOutcome`, `recordCost`, `recordBuild` | The existing manual loop, now per workspace | the Truth Rule guards, lawful basis, suppression, re-check, budget |

Every refusal is a database error whose message names the rule. Show it; do not retry.

## Justified indexes

Each backs a filter above: businesses by workspace + geography, + industry, + website status,
+ size range, + revenue currency and range, + coordinates, + domain; opportunities by workspace +
kind + status and by run; run businesses by run + state and by business; cost by run and by
opportunity; searches by workspace; runs by search. Slice 4: build projects by opportunity;
builds by project + version (unique) and one successor per build; build runs by project + queue
time; cost by build run and by build; provider connections by workspace.
