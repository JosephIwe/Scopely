# Release 1: tracker, runbook and rollback

This is the one place that tracks the first release. The statuses mean:

- **VERIFIED**: built, and checked by the checks named in the row.
- **IMPLEMENTED**: the code exists, but full verification is still pending.
- **BLOCKED**: a named dependency stops it.
- **DEFERRED**: left out of the first release on purpose.
- **NOT STARTED**: nothing is built yet.

A screen or a route existing does not make a row VERIFIED.

Evidence kinds:
- *unit/integration*: vitest against a throwaway Postgres.
- *local e2e*: the production-mode server (`SCOPELY_ENV=production`, application role) driven over HTTP on a local database.
- *browser*: Chromium at 1440, 1180×820, 820×1180 and 390.
- *demo seed*: `.example` businesses answered from fixtures.
- *recorded*: replayed Clay responses.
- *production*: the deployed service.

## Release checklist

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | PR #13 merged into the Slice 12 branch | VERIFIED | merge 25a835d. CI run 37998239669 green. Full diff reviewed |
| 2 | PR #12 merged into main | VERIFIED | merge c552222. CI run 38249971162 green. The earlier red was a postgres:16 image pull timeout, and no test ran in it |
| 3 | Release work merged into main | see the PR | `release-1` → main |
| 4 | Typecheck and full suite | VERIFIED | `pnpm check`: 30 files, 570 tests |
| 5 | Fresh migration path, and the production order (018 before 017 and 019) | VERIFIED | migrate twice (test setup). A database migrated to 018 first takes 017 and 019 cleanly |
| 6 | Production refuses an unsafe start | VERIFIED | tests/auth.test.ts spawns `serve.ts`. It refuses the preview in production and off loopback, a missing app role, a missing signing key, and an unreachable database or pending migrations |
| 7 | Hosting created | VERIFIED | Railway project `scopely-production` (founder's approval, 2026-10-12): service `scopely`, its own Postgres, volume `/data` |
| 8 | Deployed and healthy | see the final report | Railway health check `/healthz` gates every deploy |
| 9 | Production smoke tests | see the final report | `scripts/smoke.mjs`, run from GitHub Actions (`smoke` workflow), read-only and signed out |
| 10 | Rollback documented | VERIFIED | below |

## Product areas

| Area | Status | Evidence | Known limits / next action | Release-critical |
|---|---|---|---|---|
| Landing page at `/` | VERIFIED | earlier slices' browser checks at 4 sizes. Unchanged in this release | Still `noindex` (L3), and it still marks Deliver and Verify as PLANNED. Lifting both is a founder call on launch copy | yes |
| Sign-in, sessions, sign-out (A40) | VERIFIED | 22 tests in tests/auth.test.ts. local e2e. browser (sign-in, join, Account menu, sign-out) | No password reset or email delivery yet: a lost password needs a new invite from an owner, or the CLI | yes |
| Workspace onboarding (invites) | VERIFIED | tests. local e2e. `pnpm auth:invite` | The first owner's link comes from the CLI, run against production by the operator | yes |
| Workspace isolation and RLS | VERIFIED | tests: another workspace's rows read as 404, switching into a non-member workspace is refused, and losing a membership ends access. Requests run as the application role, under RLS. The app role cannot read credentials, sessions or invites | | yes |
| Development preview mode | VERIFIED | tests: refused in production and off loopback. It labels itself "Development preview" | | yes |
| Discovery (Clay company search) | IMPLEMENTED | recorded and unit tests (Slices 10–11) | Production is live-only (`serve.ts`). A workspace needs its own Clay key: `pnpm record provider-connection` plus `SCOPELY_SECRET_WS<id>_CLAY` on the service. Not verified live from Scopely's servers | yes |
| Clay people search | BLOCKED | refused unsent by design | B23: run `pnpm clay:reference` where the workspace key works (the founder's Codespace). Live people search stays refused until then | no |
| Paid enrichment | DEFERRED | | B22. Not built | no |
| Website analysis (SSRF-safe) | VERIFIED | unit tests. demo seed | A live homepage analysis was never run from this sandbox (its DNS fails). Production runs on Railway's network | yes |
| Case File (evidence, readiness, buyer, drafts, deliver) | VERIFIED | tests. local e2e. browser | | yes |
| Build website / Fix builder | VERIFIED | Slice 5–7 tests. demo seed | Version files live on the `/data` volume (B18 settled as a volume-backed folder, no new store) | yes |
| Buyer intelligence provenance | VERIFIED | Slice 12 tests (UNVERIFIED, never a decision maker) | | yes |
| Offer: service and price | VERIFIED | catalog guards | Website / Landing Page Build stays "Price not set" (A8, B5) | yes |
| Outreach drafts (A41–A43) | VERIFIED | 22 tests. local e2e: a draft is created with lint pass, there is no send route (404), and approval with no sender is refused (409) | No UI to register a sender mailbox (CLI `pnpm record mailbox`). B4 (Article 14 wording) is still open | yes |
| Deliver (A44) | VERIFIED | 15 tests. local e2e: delivery before a win is refused, then pitched, won and delivered work | | yes |
| Verify (A45) | VERIFIED | tests. local e2e: PASSED on the Quayside demo after-state | Only automated v2 findings can be re-verified. Hand-validated v1 findings say so (422) | yes |
| Suppression and opt-out | VERIFIED | Slice 9 tests. Drafts lint suppressed contacts. Approval goes through `message_gate` | | yes |
| No sending, no paid calls on page view | VERIFIED | tests: read routes call no provider. There is no send route | | yes |
| Demo data labelling | VERIFIED | `.example` hosts show "DEMO DATA". Production has no demo seed | | yes |
| Map | DEFERRED | | U3 | no |
| Automated sending | DEFERRED | | A1, B8 | no |
| Password reset / email | DEFERRED | | Needs an email provider and a sending domain | no |

## Production configuration (Railway)

- **Project:** `scopely-production` (`cf11495d-ad25-4f37-986a-e01829c93f80`), environment `production`, in the founder's personal workspace. It shares nothing with Huntly.
- **Service `scopely`:**
  - Builds from this repository's Dockerfile.
  - Pre-deploy runs `pnpm release` (`railway.json`): backup when configured, then `migrate`, which also creates and grants `scopely_app`.
  - Health check is `/healthz`, restart on failure, limits 1 vCPU and 0.5 GB.
  - Volume `scopely-storage` is mounted at `/data`.
  - URL: `https://scopely-production.up.railway.app`.
- **Service `Postgres`:** the Railway Postgres template. It is reachable only on the private network: no public TCP proxy was created.
- **Variables:** names only. Values are never printed.
  - `DATABASE_URL` (reference to Postgres)
  - `SCOPELY_ENV=production`
  - `SCOPELY_DB_APP_ROLE=scopely_app`
  - `PREVIEW_SIGNING_KEY` (generated by Railway)
  - `SCOPELY_STORAGE_DIR=/data/storage`
  - `SCOPELY_TRUST_PROXY=1`
  - `HOST`, `PORT=8080`
  - `SCOPELY_PUBLIC_URL`
- **Not set on purpose:**
  - `SCOPELY_WORKSPACE_ID`, which production refuses.
  - `SCOPELY_SIGNUP`, so sign-up stays invite-only.
  - Any `SCOPELY_SECRET_*`: no provider key is configured.
  - `SCOPELY_AI_PROVIDER` / `SCOPELY_AI_API_KEY`, so AI rewording (A49) is off.
- **Cost:** usage-billed on the existing plan. Two small always-on containers plus a 0.5 GB volume should cost a few dollars a month. That figure is inferred from Railway's published rates ($10/GB-month RAM, $20/vCPU-month, $0.15/GB-month volume), not measured.

## Runbook

**First owner** (once): the owner bootstrap (A50, `docs/OPERATIONS.md`, "Operator path"). Nobody runs a command in a container.

1. The operator makes a random token where nobody else sees it (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) and its sha256 (`printf %s "$TOKEN" | sha256sum`).
2. On the `scopely` service, set `SCOPELY_BOOTSTRAP_INVITE_SHA256` (the hash, never the token), `SCOPELY_BOOTSTRAP_EMAIL` (the owner's email) and `SCOPELY_BOOTSTRAP_EXPIRES_AT` (an ISO time no more than 72 hours ahead), then redeploy.
3. The deploy log shows `release: owner bootstrap invite <id> issued, valid until ...`. The owner opens `https://<host>/app/#/join/<token>`, chooses a password and names the workspace, the same sign-up every invite uses. The link works once, only for that email, until the expiry, and only while no owner exists.
4. Remove the three variables. A later deploy that still has them prints `not issued (owner_exists)` and does nothing.

The CLI (`pnpm auth:invite --setup`) still works wherever the database is reachable, for example in local development.

**Turn on AI rewording of drafts (A49, optional):** set `SCOPELY_AI_PROVIDER=anthropic` and `SCOPELY_AI_API_KEY` on the `scopely` service. `SCOPELY_AI_MODEL` defaults to `claude-haiku-5-5`, the low-cost model. Each call is billed by Anthropic to that key and recorded in `cost_events` (tokens; the amount stays unknown). The model sees only a draft's wording with the contact's name and address masked. Remove the two variables to turn it off.

**Connect a workspace's Clay key:**

1. Set `SCOPELY_SECRET_WS<id>_CLAY` on the `scopely` service.
2. Run `echo '{"provider":"clay","scopes":["discovery","prospects"],"credentialRef":"secretref:ws/<id>/clay"}' | SCOPELY_WORKSPACE_ID=<id> pnpm record provider-connection -`

**Deploy.** Merge to `main`. Railway builds the Dockerfile (`railway.json`), runs `pnpm release` (the backup when it is configured, then `migrate`, then the owner bootstrap when it is set), and switches traffic only after `/healthz` answers 200. If the release step fails, the running version keeps serving.

**Rollback:**
1. Code: in Railway, use Deployments, then Rollback on the last good deployment (Hobby keeps images for 72 hours), or redeploy that commit. Migrations are forward-only and additive in this release (017–019 add tables, columns and triggers only), so older code keeps working against the newer schema.
2. Data: restore the latest manual encrypted dump (`scripts/backup-db.sh`, procedure in `docs/OPERATIONS.md` → Backups). Take one before merging any migration. Never edit an applied migration; fix forward with a new one.
3. Sign everyone out: `UPDATE scopely.user_sessions SET revoked_at = now() WHERE revoked_at IS NULL`.
