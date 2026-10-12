// Plain-SQL migration runner. Files in migrations/ are applied in lexicographic order, each in
// its own transaction, and recorded by filename stem in scopely.schema_migrations. A recorded
// file is never re-run; editing an applied file is refused (its checksum is stored).
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(client: pg.Client, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await client.query('CREATE SCHEMA IF NOT EXISTS scopely');
  await client.query(`CREATE TABLE IF NOT EXISTS scopely.schema_migrations (
    version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const done = new Map<string, string>(
    (await client.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM scopely.schema_migrations'))
      .rows.map((r) => [r.version, r.sha256]),
  );
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = await readFile(path.join(dir, file), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    const prior = done.get(version);
    if (prior !== undefined) {
      if (prior !== sha) throw new Error(`migration ${version} was edited after it was applied; add a new migration instead`);
      result.skipped.push(version);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO scopely.schema_migrations (version, sha256) VALUES ($1, $2)', [version, sha]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${version} failed: ${(err as Error).message}`);
    }
    result.applied.push(version);
  }
  return result;
}

/**
 * The migrations in `dir` that this database has not applied, by stem, without changing anything.
 * The server checks this at startup so a database that is behind the code says so, instead of
 * failing later with a generic error (pnpm migrate applies them; the server never does).
 */
export async function pendingMigrations(client: Pick<pg.Client, 'query'>, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort().map((f) => f.replace(/\.sql$/, ''));
  const ledger = (await client.query<{ t: string | null }>(`SELECT to_regclass('scopely.schema_migrations')::text AS t`)).rows[0]?.t;
  if (!ledger) return files;
  const done = new Set((await client.query<{ version: string }>('SELECT version FROM scopely.schema_migrations')).rows.map((r) => r.version));
  return files.filter((v) => !done.has(v));
}

/**
 * Creates (if missing) the non-owner role the server's requests switch to, grants it the scopely
 * schema's tables, sequences and functions, and lets the connecting role SET ROLE to it. Run after
 * each migrate, so new tables are granted too. The role cannot log in.
 */
export async function ensureAppRole(client: Pick<pg.Client, 'query'>, role: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('SCOPELY_DB_APP_ROLE must be a plain lower-case role name');
  const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length > 0;
  if (!exists) await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const bypass = (await client.query<{ b: boolean; s: boolean }>('SELECT rolbypassrls AS b, rolsuper AS s FROM pg_roles WHERE rolname = $1', [role])).rows[0]!;
  if (bypass.b || bypass.s) throw new Error(`role ${role} bypasses row-level security; choose a plain role`);
  await client.query(`GRANT USAGE ON SCHEMA scopely TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scopely TO ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA scopely TO ${role}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA scopely TO ${role}`);
  const member = (await client.query(`SELECT pg_has_role(current_user, $1, 'SET') AS ok`, [role])).rows[0];
  if (!member?.ok) await client.query(`GRANT ${role} TO current_user`);
}
