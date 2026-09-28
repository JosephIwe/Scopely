// Migrations 007-008 on a database that already holds Slice 1/2 data: nothing is lost, every
// commercial row lands in one migrated workspace, starter reference rows stay shared, and the
// append-only ledgers stay append-only.
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://scopely:scopely@localhost:5432/postgres';
const name = `scopely_legacy_${randomBytes(4).toString('hex')}`;
let admin: pg.Client;
let db: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
});

afterAll(async () => {
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

describe('upgrading a database with existing data', () => {
  it('assigns existing rows to one migrated workspace and loses nothing', async () => {
    const slice2 = mkdtempSync(path.join(tmpdir(), 'scopely-slice2-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '007')) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(slice2, f));
    expect((await migrate(db, slice2)).applied).toHaveLength(6);
    await db.query('SET search_path = scopely');

    // Slice 2 data: a prospect in the seeded market, its evidence, opportunity, pitch outcome and a suppression.
    const [m] = await q(`SELECT id FROM markets WHERE purpose = 'experiment'`);
    const [b] = await q(`INSERT INTO businesses (market_id, name, domain) VALUES ($1, 'Legacy Plumbing', 'legacy.test') RETURNING id`, [m.id]);
    const [s] = await q(`INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'https://legacy.test/', '2026-09-30T09:00:00Z', 'manual') RETURNING id`, [b.id]);
    const [r] = await q(`SELECT id FROM rule_versions WHERE rule_key = 'check.trades_hours_and_routes'`);
    const [o] = await q(`INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'x', $2, 'OBSERVED', 'gap') RETURNING id`, [s.id, r.id]);
    const [e] = await q(`INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, confidence)
      VALUES ($1, $2, 'E-24-7-CONTRADICTION', $3, 'OBSERVED', 'i', 'https://legacy.test/', 'q', 'MEDIUM') RETURNING id`, [b.id, o.id, r.id]);
    await db.query('BEGIN');
    const [opp] = await q(`INSERT INTO opportunities (business_id, opportunity_type, mapping_status, unmapped_reason) VALUES ($1, 't', 'UNMAPPED', 'r') RETURNING id`, [b.id]);
    await q('INSERT INTO opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2)', [opp.id, e.id]);
    await db.query('COMMIT');
    await q(`INSERT INTO outcomes (opportunity_id, kind, occurred_at, recorded_by) VALUES ($1, 'pitched', '2026-09-30T10:00:00Z', 'operator')`, [opp.id]);
    await q(`INSERT INTO suppression (email, reason) VALUES ('gone@legacy.test', 'opt_out')`);
    const before = await q(`SELECT (SELECT count(*) FROM businesses) b, (SELECT count(*) FROM evidence) e, (SELECT count(*) FROM outcomes) o,
      (SELECT count(*) FROM suppression) s, (SELECT count(*) FROM catalog_items) c, (SELECT count(*) FROM markets) m`);

    const applied = (await migrate(db, MIGRATIONS_DIR)).applied;
    expect(applied).toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f >= '007' && f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')));

    const [ws] = await q(`SELECT id, slug FROM workspaces`);
    expect(ws.slug).toBe('migrated');
    expect(await q(`SELECT (SELECT count(*) FROM businesses) b, (SELECT count(*) FROM evidence) e, (SELECT count(*) FROM outcomes) o,
      (SELECT count(*) FROM suppression) s, (SELECT count(*) FROM catalog_items) c, (SELECT count(*) FROM markets) m`)).toEqual(before);
    for (const t of ['businesses', 'snapshots', 'observations', 'evidence', 'opportunities', 'opportunity_evidence', 'outcomes', 'suppression']) {
      const [row] = await q(`SELECT count(*) FILTER (WHERE workspace_id = $1) AS mine, count(*) AS total FROM ${t}`, [ws.id]);
      expect(row.mine, t).toBe(row.total);
    }
    // Starter reference rows stay shared; the ledger stays append-only after the backfill.
    expect(await q('SELECT count(*) AS n FROM catalog_items WHERE workspace_id IS NOT NULL')).toEqual([{ n: '0' }]);
    expect(await q('SELECT count(*) AS n FROM markets WHERE workspace_id IS NOT NULL')).toEqual([{ n: '0' }]);
    await expect(db.query(`UPDATE outcomes SET notes = 'x'`)).rejects.toThrow(/append-only/);
  });
});
