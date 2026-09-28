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
