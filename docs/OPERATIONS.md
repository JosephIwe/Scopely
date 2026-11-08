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

## Operator path: no shell in production (A50)

Two operator actions used to need someone at a terminal running `railway ssh`: creating the first
owner and taking a backup. Both now run in Railway's **pre-deploy** step, `pnpm release`
(`scripts/release.ts`, set in `railway.json`). That step runs in its own container with the service's
variables, before the new version starts. It serves no request, and no route reaches it. If it fails,
the deploy stops and the running version keeps serving. It prints ids, counts and hashes, and never
a connection string, key, token, email or row.

Every action is recorded in `operator_events` (migration 023). The table is append-only and
row-level security hides it from the application role.

What the operator needs: someone who can set the service's variables and redeploy, through the
Railway dashboard or the Railway API/connector. That is the same trust that already controls
`DATABASE_URL`. No CLI login, SSH key or Codespace is needed.

### Owner bootstrap

Set `SCOPELY_BOOTSTRAP_INVITE_SHA256`, `SCOPELY_BOOTSTRAP_EMAIL` and `SCOPELY_BOOTSTRAP_EXPIRES_AT`
and redeploy. Steps are in `docs/RELEASE.md`, "First owner". The release step turns them into an
ordinary setup invite (`src/ops/bootstrap.ts`), only while no workspace owner with a password exists.
The owner then signs up through the normal invite flow (`acceptInvite`). Guarantees, all tested in
`tests/operator-path.test.ts`:

- The server holds only the token's sha256, so reading the variables does not let anyone sign up.
- Single use, bound to that email, and expiring no more than 72 hours after it was issued.
- Refused both when issued and when accepted once an owner can sign in. A hash already used,
  expired or issued is never issued again, so a redeploy cannot revive it.
- Rows: `bootstrap_invite_issued`, `bootstrap_invite_refused` (reason), `bootstrap_completed`
  (invite, user and workspace ids) and `bootstrap_accept_refused`.

### Pre-deploy backup

When the backup variables are set, **every deploy and every redeploy** takes a backup before
`migrate` runs (`src/ops/backup.ts`):

1. `pg_dump` (Postgres 18 client, installed in the Dockerfile from the PostgreSQL apt repository)
   writes a custom-format dump to a private temporary folder. The connection details reach `pg_dump`
   only as `PG*` values of the child process, and its messages are discarded.
2. `pg_restore --list` must read the archive.
3. The dump is encrypted with a fresh AES-256-GCM key, and that key is wrapped with the operator's
   **RSA public key** (RSA-OAEP-SHA256). The server holds only the public key. Neither it, nor anyone
   who reads its variables, nor anyone who reads the bucket, can decrypt a backup.
4. The file is uploaded to S3-compatible object storage as `scopely-backups/<UTC stamp>-<random>.dump.enc`.
   Nothing is overwritten, and Scopely has no delete call.
5. The object is read back and must match the uploaded file's sha256 and the dump's recorded checksum.
6. The temporary folder is deleted. Then `migrate` runs. A `backup_completed` row records the key,
   size, both sha256s, the archive entry count and the `pg_dump` version.

Any failed step stops the deploy (`backup_failed` with a reason code). To take a backup on demand,
redeploy the service. A database with no schema yet (the first deploy ever) is skipped.

Variables (all five or none; a partial set stops the deploy):

| Variable | Value |
|---|---|
| `SCOPELY_BACKUP_S3_ENDPOINT` | `https://t3.storageapi.dev` for a Railway bucket (https only) |
| `SCOPELY_BACKUP_S3_BUCKET` | the bucket name |
| `SCOPELY_BACKUP_S3_ACCESS_KEY_ID` / `SCOPELY_BACKUP_S3_SECRET_ACCESS_KEY` | the bucket's credentials (Railway variable references) |
| `SCOPELY_BACKUP_PUBLIC_KEY` | the RSA public key, PEM (3072+ bits; a private key is refused) |
| `SCOPELY_BACKUP_S3_REGION`, `SCOPELY_BACKUP_S3_URL_STYLE` | optional: `auto`, `virtual` |

The key pair comes from `pnpm backup:keygen <private.pem>`, run where the private key will be kept.
The private key never goes to Railway. Whoever holds it is the only person who can restore.

**Where the backup lives.** A Railway Storage Bucket in the same project. It is billed by usage,
needs no plan change, and is separate from the Postgres volume, so a lost volume, a failed deploy or
a deleted service does not touch it. Deleting the whole project or account would remove it. Bucket
credentials can delete objects (there is no write-only key), so anyone with project access could
remove backups, just as they could reach the database itself. For a copy outside Railway, download
an object now and then (any S3 client with the bucket credentials) and keep it with the private key.

**Restore from a pre-deploy backup.** Download the object, then
`SCOPELY_BACKUP_PRIVATE_KEY_FILE=<private.pem> pnpm backup:decrypt <file.dump.enc> scopely.dump`.
This checks the GCM tag and the dump's sha256. Then continue from step 2 of "Restore" below.
`tests/operator-path.test.ts` covers the whole round trip: a real `pg_dump`, an upload, a read-back,
decryption, `pg_restore` into an empty database, and `migrate` applying nothing.

## Backups: manual encrypted dumps (fallback)

What was read on 2026-11-07 and re-checked on 2026-11-08, through the Railway API (read-only):

- Postgres service `Postgres`, image `ghcr.io/railwayapp-templates/postgres-ssl:18`, one volume
  `postgres-volume` (5,000 MB, region ams) at `/var/lib/postgresql/data`, no public TCP proxy.
- The workspace plan is **Hobby**: max backups = 0, no schedule, no PITR. Railway Pro is not
  available to the founder for now (2026-11-08), so Railway-native backups are **not** the plan.

The pre-deploy backup above is the backup during validation. This manual dump, taken with
`scripts/backup-db.sh` from a machine with the Railway CLI, is kept only as a fallback. Nothing is added to Railway: no service, no TCP proxy, no variable,
and `DATABASE_URL` is neither read nor changed. The dump runs inside the Postgres service with the
`PG*` variables that already exist there, is streamed back over `railway ssh`, checksum-verified,
and encrypted on the founder's machine. A Railway deploy, volume or project failure cannot destroy
it, because no copy is kept in Railway.

It is only as good as how often it is run. A dump holds prospect data: keep it only encrypted, and
never in the repository, a shared project folder, a chat or an issue.

### When to take one

- **Before every deploy that adds a migration** (look for a new `migrations/NNN_*.sql` on `main`).
  The deploy runs `pnpm migrate` automatically, so take the dump *before* merging.
- At least **weekly** while real prospect data is being entered, and after any big import.

### Take a backup

Prerequisites, once: the Railway CLI logged in (`railway login`), an SSH key registered with Railway
(the CLI prompts the first time you run `railway ssh`), `openssl`, and a folder linked to the project
(`railway link`, choose `scopely-production` → `production`).

```
scripts/backup-db.sh ~/scopely-backups
```

It asks for a passphrase. Keep the passphrase in a password manager: without it the backup cannot
be restored. A good run prints:

```
Transfer verified: remote-sha256 <64 hex> entries <N> pg_dump 18.x
Backup written: ~/scopely-backups/scopely-<UTC stamp>.dump.enc
```

`entries` comes from `pg_restore --list` run on the dump inside Railway, so the archive was readable
before it left. The local copy is accepted only if its sha256 matches the one computed in Railway.
Then copy the `.enc` file and its `.sha256` file to a **second** place you control that is not
Railway (an encrypted USB drive, or a private cloud folder). Record the run in the log below.

The script prints no URL, password or row. If the remote side fails it prints only the error lines,
with any line mentioning a password or a connection URL removed.

### Restore

Use `pg_restore` **18 or newer** (production is Postgres 18; an older `pg_restore` refuses the
archive). With Docker, `docker run --rm -it -v ~/scopely-backups:/b postgres:18 bash` gives one.

1. Decrypt, and check the checksum:
   ```
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in scopely-<stamp>.dump.enc -out scopely.dump
   sha256sum scopely.dump          # must equal the first field of scopely-<stamp>.dump.enc.sha256
   ```
2. Restore into an **empty** database (never into the live one while the app is running):
   ```
   psql "$TARGET_ADMIN_URL" -c "CREATE ROLE scopely_app NOLOGIN"     # skip if it exists
   psql "$TARGET_ADMIN_URL" -c "CREATE DATABASE scopely_restore"
   pg_restore --no-owner --exit-on-error -d "<url of scopely_restore>" scopely.dump
   ```
   `--no-owner` lets a different admin user own the restored objects; the `scopely_app` role must
   exist because the dump grants it privileges. The tables live in schema `scopely` (the app sets
   `search_path` itself).
3. Check it: `DATABASE_URL=<url of scopely_restore> pnpm migrate` must print
   `applied: none; already applied: <N>`, where N is the number of files in `migrations/`. The
   runner also refuses a migration whose sha256 differs, so this proves the schema is the release's.
4. To put it into production after a real loss: stop the `scopely` service, restore into the
   production Postgres (or a new empty database on it), point nothing else at it, redeploy, and
   check `/healthz` shows `pendingMigrations: 0`. This is a founder decision at the time; do not
   do it as a test.
5. Delete the decrypted `scopely.dump` when done.

### Tested

- 2026-11-08: the whole procedure was run against a local stand-in (the dev database at migration
  022, 57 tables) using the script's test hook in place of `railway ssh`: dump, transfer checksum,
  encrypt, decrypt, checksum, `pg_restore` into a fresh Postgres instance, `pnpm migrate` reported
  `applied: none; already applied: 22`, and the row count of every table matched the source. The
  failure path (database unreachable) exits non-zero and keeps no file. Production was not touched.

### Backup log (date, who, file stamp, entries, where the second copy is)

- [ ] First production backup: not yet taken.

The app's own volume (`/data`, preview captures) is not backed up: it holds build artefacts that
can be regenerated, not the system of record.
