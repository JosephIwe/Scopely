// The release step: Railway's pre-deploy command (railway.json → `pnpm release`). It runs in its
// own container with the service's variables, before the new version starts, and never serves a
// request. A non-zero exit stops the deploy; the running version keeps serving.
//
//   1. Backup (src/ops/backup.ts), when the SCOPELY_BACKUP_* variables are set: an encrypted
//      pg_dump, uploaded and read back. It runs before any migration, so every deploy (and every
//      redeploy, which is how an on-demand backup is taken) leaves a verified copy first.
//      Half-set variables, or any failed step, stop the deploy.
//   2. Migrate, exactly as `pnpm migrate` (and the application role, when SCOPELY_DB_APP_ROLE is set).
//   3. Owner bootstrap (src/ops/bootstrap.ts), when the SCOPELY_BOOTSTRAP_* variables are set:
//      issues the one-time setup invite while no owner exists. A refusal is printed, not fatal.
//
// It prints ids, counts and hashes only: never DATABASE_URL, a key, a token, an email or a row.
import { connect, databaseUrl } from '../src/db/client.js';
import { ensureAppRole, migrate } from '../src/db/migrate.js';
import { BackupFailed, backupConfigFromEnv, recordBackup, runBackup, type BackupResult } from '../src/ops/backup.js';
import { bootstrapConfigFromEnv, issueBootstrapInvite } from '../src/ops/bootstrap.js';

const fail = (msg: string): never => { console.error(`release: ${msg}`); process.exit(1); };

let backupCfg: ReturnType<typeof backupConfigFromEnv> = null;
let bootstrapCfg: ReturnType<typeof bootstrapConfigFromEnv> = null;
try { backupCfg = backupConfigFromEnv(process.env); } catch (err) { fail((err as Error).message); }
try { bootstrapCfg = bootstrapConfigFromEnv(process.env); } catch (err) { console.error(`release: ${(err as Error).message} The bootstrap is skipped.`); }

const client = await connect();
try {
  // 1. Backup, before anything changes.
  let outcome: BackupResult | BackupFailed | null = null;
  // A database with no schema yet (the very first deploy) has nothing to protect.
  const empty = !(await client.query(`SELECT to_regclass('scopely.schema_migrations') AS t`)).rows[0]?.t;
  if (backupCfg && empty) {
    console.log('release: backup skipped: the database is empty (first deploy)');
  } else if (backupCfg) {
    console.log(`release: backup to bucket ${backupCfg.s3.bucket}, public key ${backupCfg.keyFingerprint.slice(0, 16)}...`);
    try {
      outcome = await runBackup({ databaseUrl: databaseUrl(), cfg: backupCfg });
      console.log(`release: backup verified: ${outcome.objectKey} ${outcome.sizeBytes} bytes, ${outcome.entries} archive entries, pg_dump ${outcome.pgDumpVersion}, `
        + `sha256 ${outcome.ciphertextSha256} (encrypted) / ${outcome.dumpSha256} (dump)`);
    } catch (err) {
      outcome = err instanceof BackupFailed ? err : new BackupFailed('pg_dump_failed', 'unexpected');
      await recordBackup(client, outcome).catch(() => undefined);
      fail(`${outcome.message}. Nothing was migrated; the running version keeps serving.`);
    }
  } else {
    console.log('release: backup not configured (SCOPELY_BACKUP_* unset; docs/OPERATIONS.md)');
  }
  const recorded = outcome ? await recordBackup(client, outcome) : true;

  // 2. Migrate.
  const r = await migrate(client);
  console.log(`release: migrations applied: ${r.applied.join(', ') || 'none'}; already applied: ${r.skipped.length}`);
  const role = process.env.SCOPELY_DB_APP_ROLE;
  if (role) { await ensureAppRole(client, role); console.log(`release: application role ${role}: ready`); }
  // The first deploy of 023 creates operator_events after the backup ran: record it now.
  if (outcome && !recorded) await recordBackup(client, outcome);

  // 3. Owner bootstrap.
  if (bootstrapCfg) {
    await client.query('BEGIN');
    try {
      const b = await issueBootstrapInvite(client, bootstrapCfg);
      await client.query('COMMIT');
      if (b.status === 'issued') console.log(`release: owner bootstrap invite ${b.inviteId} issued, valid until ${b.expiresAt}`);
      else console.log(`release: owner bootstrap not issued (${b.reason})${b.reason === 'owner_exists' ? '; remove the SCOPELY_BOOTSTRAP_* variables' : ''}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`release: owner bootstrap failed (${(err as { code?: string }).code ?? 'no code'})`);
    }
  }
} finally {
  await client.end();
}
