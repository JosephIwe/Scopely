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
| `restoreVersion(db, store, projectId, { baseBuildId, fromBuildId, undo? })` | An earlier version's document as a new version, `{ buildId, versionNo }`. With `undo: true`, `fromBuildId` must be the version `baseBuildId` replaced (409 otherwise) |
| `uploadImage(db, store, projectId, { bytes, description, recordedBy })` | PNG, JPEG, WebP or GIF up to 5 MB, checked by content; SVG refused; stored as a project asset |
| `approveVersion(db, projectId, buildId, { approvedBy })` | Slice 4's approve, with its blocker; allowed without a button destination |
| `showVersion(db, store, projectId, buildId)` | Slice 4's show, and refused (`NO_BUTTON_DESTINATION`) while the button has no destination |
| `previewLink(db, projectId, buildId, { kind, signingKey, ttlSeconds? })` | A signed link; `show` only for a shown version, stored as a revocable link (72 hours by default) |
| `listProspectLinks(db, projectId, { signingKey })` | `ProspectLink[]`: version, created, expires, revoked, `state` (`ACTIVE` / `EXPIRED` / `REVOKED`) and the token while active |
| `revokeProspectLink(db, projectId, linkId, { revokedBy })` | Stops a link at once; the version does not change |
| `getSiteWorkspace(db, store, projectId, { selected })` | `SiteWorkspace`: project, current version (document, editor HTML, readiness, blockers), history, template, images |

### Fix builds (Slice 7, `src/build/fix/service.ts`)

| Function | Does |
|---|---|
| `openFixProject(db, opportunityId)` | Opens (or reuses) the fix project of a `website_fix` opportunity with a supported finding that holds |
| `captureFixPage(db, { store, fetcher }, projectId, { evidenceId })` | Captures the finding's page into `captures/` and records it |
| `proposeCorrection(db, projectId, { evidenceId, channel, value })` | Records a person's corrected destination, unconfirmed |
| `generateFix(db, { store }, projectId)` | Runs the fix agent on the capture with the active corrected values → `RunOutcome` |
| `confirmFix(db, projectId, buildId, { confirmedBy, confirmed })` | Confirms and approves; refused without the tick or on a stale version |
| `showFixVersion(db, projectId, buildId)` | Marks the version shown after every gate passes |
| `getFixWorkspace(db, store, projectId)` | The screen's data |
| `readFixPage(db, store, projectId, buildId, 'before' \| 'after')` | The hash-checked page copy |

### Build Workspace HTTP (`pnpm serve`, `src/server/app.ts`)

JSON over HTTP, acting in the one workspace the server was started with (B10). Every non-GET
request must send `x-scopely-request: 1`, and an `Origin` header, when present, must be this
server; anything else is `403`. Each request is one transaction. Errors are `{ error }` with a
readable message; an unexpected failure is `500` with no detail. Responses carry no storage keys
or hashes.

| Route | Body → result |
|---|---|
| `GET /api/opportunities` | Opportunities with their first plain-language issue, `buildable` and `projectId`, and for a Fix opportunity `fixable` and `fixProjectId`. Slice 8 adds `stage` (`OPPORTUNITIES`, `BUILD`, `SELL`, `DELIVER`, `VERIFY`, from `stageOf`), `captured`, `sellState`, `deliveryState`, `vertical`, `city`, `websiteStatus`, `rating`, `reviewCount` and `observed` (the strongest finding's visible text, quote, page, claim state and date) |
| `GET /api/workspace` | `{ name, authenticated: false }` (Slice 8; authentication is B10) |
| `GET /api/opportunities/:id` | `CaseFile` (Slice 8, `src/api/case-file.ts`): situation, the opportunity's own evidence, business, service, build (with `showLink`, the active prospect link, and for a fix its `steps`, capture and correction), buyer contacts with `emailBlocker` from `contact_outreach_blocker`, outreach cautions (`recheckNeeded`, `noLongerHolds`) and sell (states, dates, the seller-entered `agreedAmount`, the append-only ledger and which records `can` be added). `404` in another workspace. Slice 9 adds `buyer.suppressions` (the workspace's entries that reach this business: business, domain or a contact's address) and `readiness` (`status` `READY` / `NOT_READY` / `SUPPRESSED`, `checks` with `key`, `state` `done` / `missing` / `blocked`, `label` and `detail`, `readyContactIds`, `evidenceBlocker`). Slice 12 adds to each contact `relationship`, `relationshipBasis`, `decisionMakerBasis`, `verification` (`by`, `basis`, `at`), `observedAt`, `confidence`, `provenance` (provider, operation, transport, time; null for a seller's contact), `facts` (`ContactFactView`: kind, value, source, source URL, observed time, label, the source's confidence, `fromProvider`, `recordedBy`, verification), `conflicts` (kinds where sources disagree, with their values) and `assessment` (`tier` `DECISION_MAKER` / `LIKELY_BUYER` / `NAMED_CONTACT` / `SHARED_ADDRESS`, `reasons` each `OBSERVED` / `RECORDED` / `REPORTED` / `INFERRED`, `summary`; computed on read, A39); and to `buyer` `suggestedContactId`, `businessChannels` (the business's own phone, WhatsApp, email and contact page, from OBSERVED analysis observations with `broken` when the analysis found a defect, plus business-level facts), `lookups` (the last 20 prospect calls with status, count and cost basis) and `providers` (`key`, `label`, `transport`, `kinds`, `ready`; a live provider is ready only with an ACTIVE `prospects` connection) |
| `POST /api/opportunities/:id/outcomes` | `{ kind: 'pitched' \| 'replied' \| 'call' \| 'won' \| 'lost' \| 'voided', occurredOn: 'YYYY-MM-DD', recordedBy, channel?, replyClass?, amount?, currency?, notes?, correctsOutcomeId? }` → `{ outcomeId }` (Slice 8, `recordManualOutcome`). A pitch needs a channel, a reply its class, a win an amount in the opportunity's currency (typed only when it has none), a correction the record it voids and a reason. `delivered` is never recorded here. The ledger's refusals come back as `409` with a plain message. Nothing is sent. Since Slice 9 a `replied` record of class `opt_out` also puts the business on the workspace's suppression list (A29) |
| `POST /api/opportunities/:id/evidence/:eid/recheck` | `{ result: 'confirmed' \| 'gone' \| 'changed', recordedBy, notes? }` → `{ recheckId, rechecked }` (Slice 9). A person's visit to the evidence's own page, recorded on a new manual snapshot; `changed` needs `notes`. `404` for evidence the opportunity does not cite or another workspace's; `409` for an inferred finding marked still there or gone, or when a later re-check exists |
| `POST /api/opportunities/:id/contacts` and `/contacts/:cid` | `{ fullName?, role?, isDecisionMaker?, decisionMakerBasis?, relationship?, relationshipBasis?, email?, emailKind?, source, sourceUrl?, label, verificationBasis?, outreachBasis, recordedBy? }` → `{ contactId }` (Slice 9; Slice 12 adds the bases: a decision maker, a relationship and `VERIFIED` each need one, and a provider's person keeps its source and needs a basis and `recordedBy` to be raised). Adds a contact to the opportunity's business, or corrects one of its contacts. Name or email required; `label` is `VERIFIED` / `PUBLICLY_FOUND` / `UNVERIFIED`; `outreachBasis` is `corporate_subscriber` / `consent` / `not_permitted` / `unknown` |
| `POST /api/opportunities/:id/prospects/lookup` | `{ provider }` → `ProspectLookupResult` (Slice 12, `runProspectLookup`): `provider`, `transport`, `operationId`, `returned`, `added`, `matched` (already on file by provider id, LinkedIn profile or name), `repeated`, `factsAdded`, `factsRejected`, `conflicts`, `error { code, message }`. A provider failure is a `200` with `error` and stores no person. Everything stored is UNVERIFIED. `404` in another workspace; `422` with `reason` (`no_provider`, `suppressed`, `not_searchable`, `not_connected`) when the lookup cannot start |
| `POST /api/opportunities/:id/facts` | `{ contactId?, kind: 'email' \| 'phone' \| 'whatsapp' \| 'linkedin' \| 'instagram' \| 'x' \| 'contact_page', value, sourceUrl, label?: 'PUBLICLY_FOUND' \| 'VERIFIED' \| 'UNVERIFIED', basis?, recordedBy }` → `{ factId }` (Slice 12). A channel the seller saw for a person or the business; `sourceUrl` is required, the value is normalized for its kind (never repaired) and a duplicate is `409` |
| `POST /api/opportunities/:id/facts/:fid` | `{ label, basis?, recordedBy }` → `{ ok }` (Slice 12). A person's check of a fact on file; `PUBLICLY_FOUND` and `VERIFIED` need `basis`. The value and where it came from never change |
| `POST /api/opportunities/:id/contacts/:cid/email` | `{ factId }` → `{ ok }` (Slice 12). Makes one of the contact's email facts its email of record; the contact's label is never higher than the fact's |
| `POST /api/opportunities/:id/company` | `{ type, status?, register?, number? }` → `{ ok }` (Slice 9). The business's register facts as supplied; `status` is required except for a sole trader or partnership; a number another business of the workspace has is `409` |
| `POST /api/opportunities/:id/suppressions` | `{ target: 'email' \| 'domain' \| 'business', contactId?, reason }` → `{ suppressionId }` (Slice 9). `email` takes the address of one of the business's contacts by `contactId`; adding a target already listed returns the existing entry. `reason` is `opt_out`, `bounce`, `complaint`, `contacted` or `dnc` |
| `POST /api/opportunities/:id/website` | → `{ projectId }` |
| `GET /api/projects/:id/setup` | `BuildSetup`, including `opportunity` (service, price and currency, or null) |
| `GET /api/projects/:id/workspace?selected=` | The workspace screen, with `links` (state and, while active, url), each version's `kind` (`build`, `ai`, `restore`, `manual`) and `current.upgraded` (made with an earlier template version) |
| `POST /api/projects/:id/generate` | `{ templateKey }` → `RunOutcome` |
| `POST /api/projects/:id/render` | `{ baseBuildId, operations, selected }` → `{ html, readiness }` |
| `POST /api/projects/:id/save` | `{ baseBuildId, operations }` → the new version |
| `POST /api/projects/:id/ai-edit` | `{ baseBuildId, request }` (≤ 500 characters) → `RunOutcome` |
| `POST /api/projects/:id/restore` | `{ baseBuildId, fromBuildId, undo? }` → `{ buildId, versionNo }` of the new version |
| `POST /api/projects/:id/images` | raw image bytes, `x-description` (URI-encoded alt text) → the image |
| `POST /api/projects/:id/versions/:bid/approve` | `{ approvedBy }` |
| `POST /api/projects/:id/versions/:bid/show` | → `{ url, expiresAt }`, the prospect's link |
| `POST /api/projects/:id/versions/:bid/link` | `{ kind: 'edit' \| 'show' }` → `{ url, expiresAt }` |
| `POST /api/projects/:id/links/:lid/revoke` | `{ revokedBy }` → `{ ok }` |
| `GET /p/:token` | The artifact, with a sandboxing content security policy |
| `GET /s/:token` | The prospect's page: a "design preview, not a live website" bar around the artifact in a sandboxed frame |
| `POST /api/opportunities/:id/fix` | → `{ projectId }` (Slice 7; reuses the open fix project) |
| `GET /api/fix/:id` | `FixWorkspace`: business, service, evidence, `focus`, `capture`, `correction`, `current` (document, applied corrections, `confirmed`, `stale`, blockers), `versions`, `steps` and `links` |
| `POST /api/fix/:id/capture` | `{ evidenceId }` → `FixCapture`; `409` with a plain message when the page cannot be captured, and nothing is recorded |
| `POST /api/fix/:id/corrections` | `{ evidenceId, channel: 'phone' \| 'whatsapp' \| 'email', value }` → `FixCorrection` (unconfirmed) |
| `POST /api/fix/:id/generate` | → `RunOutcome` |
| `POST /api/fix/:id/versions/:bid/confirm` | `{ confirmedBy, confirmed: true }` → confirms the version's corrected values and approves it |
| `POST /api/fix/:id/versions/:bid/show` | → `{ url, expiresAt }` |
| `POST /api/fix/:id/versions/:bid/link` | `{ kind: 'edit' \| 'show' }` → `{ url, expiresAt }`, and for `edit` also `before` and `after` |
| `POST /api/fix/:id/links/:lid/revoke` | `{ revokedBy }` → `{ ok }` |
| `GET /p/:token?view=before\|after` | A fix version's captured page or corrected copy, edit links only, under the artifact policy |
| `GET /fonts/*.woff2` | The workspace's own typefaces (Geist, Geist Mono, Instrument Serif, Newsreader; OFL) |
| `GET /api/discovery` | `{ providers: [{ key, label, transport: 'live' \| 'recorded', ready }], searches, runs: [{ searchRunId, searchId, startedAt, discovered, qualified }] }` (Slice 10). `ready` is all the screen learns about a provider's credentials: a recorded provider is always ready; a live one only with an ACTIVE `discovery` connection of this workspace and a server-side secret resolver |
| `POST /api/searches` | `{ name, verticals?, countryCode?, city?, employeeMin?, employeeMax?, revenueMin?, revenueMax?, revenueCurrency?, websitePresence?: 'any' \| 'required' \| 'absent', maxDiscoveredPerRun, maxBusinessesToAnalyze? }` → `{ searchId }` (Slice 10). `maxDiscoveredPerRun` is required, 1–100. A revenue range needs a three-letter currency and is never converted. Bad input is `422` in the seller's words |
| `GET /api/searches/:id` | The search as saved, with its runs. `404` in another workspace |
| `POST /api/searches/:id/runs` | `{ provider }` → `{ searchRunId, result }` (Slice 10, `runProviderDiscovery`). Starts a run, pages the provider through the gateway until the run's limit or the provider runs out, records each business with its provider record, then pre-qualifies. `result` has `transport`, `operations`, `returned`, `discovered`, `newBusinesses`, `knownBusinesses`, `stoppedBy` (`limit` / `exhausted` / `error`) and `error { code }`. A provider failure keeps what was found and is a `200` with `error`; a run that cannot start (`no_provider`, `no_limit`, `not_searchable`, `not_connected`) is `422` with `reason`, and no run is left behind |
| `GET /api/runs/:id` | `RunDiscovery` (`src/api/discovery.ts`): the run's counts, every provider call (`operation`, `transport`, `status`, `errorCode`, `attempts`, `latencyMs`, `resultCount`, `cost`), `economics` (`costBasis` `NONE` / `REPORTED` / `NOT_REPORTED`; a cost is never summed from a partial report) and the businesses in priority order with `priority`, `state`, reasons, `provenance` (provider, reference, observed date, basis) and `knownBefore` |
| `POST /api/runs/:id/select` | `{ businessIds, selectedBy }` → `{ selected }` (Slice 10, `selectForAnalysis`). Only qualified businesses, up to the search's `max_businesses_to_analyze`; refusals are `422` in plain words; a business not in the run is `404` |
| `POST /api/runs/:id/businesses/:bid/analyze` | `{ requestedBy }` → `{ analysisId, analysedNow, state, opportunityIds, analysis }` (Slice 11, `analyzeRunBusiness`). Idempotent: a concluded business returns its result with `analysedNow: false` and requests nothing. Refusals (not selected, closed run, credit budget, no requester) are `422` in plain words; a business not in this workspace's run is `404`. The page's HTML is never returned |
| `GET /api/runs/:id/businesses/:bid/analysis` | `AnalysisView` (`src/api/analysis.ts`): `outcome` (`CHECKED` / `NO_ADDRESS` / `REFUSED`), `requestedUrl`, `requestedBy`, `website` status, `page` (final URL, HTTP status, redirects, hash), `requests`, `cost: { basis: 'NOT_REPORTED' }`, every observation with its `state` and `fact`, `findings` (issue code, quote, confidence, rule, `note`: `opened` / `already_held` / `no_service` / `not_a_lead`, `opportunityId`) and the run's `opportunities`. `GET /api/runs/:id` adds `analysis` (outcome, findings, opportunity ids) to each business |

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
