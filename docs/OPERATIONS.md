# Operations: logs, errors, uptime and backups

The minimum observability required before real prospect data enters production (P2, 2026-11-07).
Nothing here adds a paid service. Where a guarantee depends on the Railway plan, this file says
what was read and what still has to be checked by hand.

## Logs

**Where.** The `scopely` service in Railway project `scopely-production`, environment
`production`: Railway dashboard → service → *Deployments* → a deployment → *Deploy Logs* (or the
*Observability* log explorer). Build logs and HTTP proxy logs are beside them. The Railway CLI
(`railway logs`) and the Railway MCP `get-logs` tool read the same streams.

**What is written.** One process, plain lines, no page HTML, message bodies, contact details or
credentials (CLAUDE.md rule 11):

| Line | Stream | Example |
|---|---|---|
| Startup | stdout | `Scopely on http://0.0.0.0:8080 (sign-in, invite-only, production); Clay: live; error reporting: off (SCOPELY_ERROR_DSN unset)` |
| Every `/api` request | stdout | `GET /api/opportunities/:id 200 14ms rid=3f9c0a1b2c4d` |
| Unexpected error (5xx) | stderr | `error POST /api/opportunities/:id/outcomes 23505 rid=3f9c0a1b2c4d ws=12 user=3 status=500 err=DatabaseError constraint=<name> table=outcomes at=src/sell/outcomes.ts:88` |
| Process failure | stderr | `error process - err=TypeError at=src/analysis/fetch.ts:41` |
| Provider / analysis runs | stdout | ids and counts only (`run 41 search 9 clay live ops=2 found=40`) |

Routes have numeric ids replaced with `:id` and tokens with `:token`; query strings are never
logged. A 500 or 503 response body carries the same `requestId`, and every response has an
`x-request-id` header, so a person can quote it and you can find the line.

**How long.** Railway keeps logs for a period set by the plan: **7 days on Hobby, 30 days on Pro**
([railway.com/pricing](https://railway.com/pricing), [docs.railway.com/reference/logging](https://docs.railway.com/reference/logging)).
On 2026-11-07 Railway's agent reported this workspace is on **Hobby**, so logs are kept 7 days.
The 12 Oct deployment's deploy logs had already aged out when the CTO audit looked. Anything that
must outlive that window belongs in the database (outcomes, evidence, provider operations already
are), not in logs.

## Error reporting

Off unless `SCOPELY_ERROR_DSN` is set on the `scopely` service. It takes a Sentry-format DSN,
`https://<public key>@<host>/<project id>`. Sentry's free Developer plan and a self-hosted GlitchTip
both accept it; Scopely posts the event to the DSN's envelope endpoint itself, with no SDK. A DSN
in any other shape stops the server at startup rather than silently dropping errors.

What an event contains (`src/server/observe.ts`, tested in `tests/observability.test.ts`): the error
class, Postgres SQLSTATE, constraint and table names, up to 8 code locations, the route with ids
replaced, method, status, request id, workspace id and user id (numbers), environment, and the
release (first 12 characters of `RAILWAY_GIT_COMMIT_SHA`). It never contains the error message,
Postgres detail/hint/parameters, a request body, a query string, a cookie, an email or a URL a
person typed. At most 30 events a minute are sent; a tracker that is down never slows or fails a
request. 4xx refusals are expected answers and are not reported.

To turn it on: create a project in the tracker, copy its DSN, set `SCOPELY_ERROR_DSN` on the
service (Railway → *Variables*), and redeploy. The startup line then says `error reporting: on`.
Choosing and signing up for a tracker is a founder action; none is configured today.

## Uptime

- **Deploy-time:** Railway's healthcheck on `/healthz` gates each deploy (200 only when Postgres
  answers and no migration is pending).
- **Continuous:** `.github/workflows/uptime.yml` requests `/healthz` every 15 minutes (3 tries).
  A failed run is the alert: GitHub emails the person who last changed the schedule, if Actions
  notifications are on (GitHub → Settings → Notifications → Actions). History is in the repository's
  *Actions* tab. GitHub can delay scheduled runs by several minutes under load, and pauses a
  schedule after 60 days without a commit; re-enable it from the Actions tab if that happens.
  It only starts once this file is on `main`.
- `scripts/smoke.mjs` (workflow `smoke`) remains the fuller read-only check after a deploy.

## Backups: NOT in place today

What was read on 2026-11-07, through the Railway API (read-only, nothing changed):

- Postgres service `Postgres`, image `ghcr.io/railwayapp-templates/postgres-ssl:18`, one volume
  `postgres-volume` (5,000 MB, region ams) at `/var/lib/postgresql/data`, no public TCP proxy.
- The volume mount has **no backup schedule** configured.
- The workspace plan is **Hobby**, whose limits report **max backups = 0**: Railway volume backups
  are not available on this plan.
- Whether any manual backup or Point-in-Time Recovery exists could **not** be read through the
  tools available. PITR needs a Railway storage bucket for WAL archives; the project has none listed.

So there is **no backup guarantee** for production data today. Before real prospect data goes in,
the founder must choose one of these (both need their hands, the first costs money):

1. **Upgrade the workspace to Railway Pro**, then in the dashboard: Postgres → *Backups* → enable
   a schedule (daily, plus weekly). Afterwards confirm by hand that the *Backups* tab lists a
   backup with today's date, and note the retention it shows here.
2. **Manual logical dumps** on Hobby: from a machine with the Railway CLI (see the first-owner
   runbook in `docs/RELEASE.md` for `railway ssh`), run inside the Postgres service
   `pg_dump -Fc -U "$PGUSER" "$PGDATABASE" > /tmp/scopely.dump`, copy it off, and store it
   encrypted. This is only as good as how often someone does it, and the dump contains prospect
   data, so it must not be kept anywhere shared.

Manual checks to record here once done (date, who, what was seen):

- [ ] Railway *Backups* tab for `postgres-volume` shows a schedule and at least one backup.
- [ ] A test restore was done into a scratch service (Railway *Restore*), and `pnpm migrate`
      reported nothing pending against it.
- [ ] The app's own volume (`/data`, preview captures) — decide whether it needs backing up; it
      holds build artefacts that can be regenerated, not the system of record.
