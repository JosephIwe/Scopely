// Migration 009 on a database that already holds Slice 3 builds: each supersede chain becomes one
// build project with versions numbered 1..n, a parent with a successor becomes SUPERSEDED, nothing
// is lost, and a chain that branches (two successors) stops the upgrade instead of guessing.
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate.js';
import { catalogId, seedChain, seedOpportunity } from './helpers.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://scopely:scopely@localhost:5432/postgres';
let admin: pg.Client;
const open: { name: string; db: pg.Client }[] = [];

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
});

afterAll(async () => {
  for (const o of open) {
    await o.db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${o.name} WITH (FORCE)`);
  }
  await admin.end();
});

/** A fresh database migrated up to (not including) 009, with one workspace as the request context. */
async function slice3Db() {
  const name = `scopely_slice3_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  open.push({ name, db });
  const dir = mkdtempSync(path.join(tmpdir(), 'scopely-slice3-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '009')) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  expect((await migrate(db, dir)).applied).toHaveLength(8);
  await db.query('SET search_path = scopely');
  const [ws] = (await db.query(`INSERT INTO workspaces (slug, name) VALUES ('legacy', 'Legacy') RETURNING id`)).rows;
  return { db, ws: String(ws.id) };
}

const build = `WITH b AS (
    INSERT INTO builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, artifact_ref, generator, supersedes_build_id)
    VALUES ($1, $2, 'website_fix', 'DEMO', $3, 's', 'preview/1', 'operator', $4) RETURNING id)
  INSERT INTO build_evidence (build_id, evidence_id) SELECT id, $5 FROM b RETURNING build_id AS id`;

async function legacyData(db: pg.Client, ws: string, branch: boolean) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('scopely.workspace_id', $1, true)`, [ws]);
  const c = await seedChain(db);
  const opp = await seedOpportunity(db, c);
  const cat = await catalogId(db, 'website_fix_sprint');
  const add = async (title: string, parent: string | null) =>
    String((await db.query(build, [opp, cat, title, parent, c.evidenceId])).rows[0].id);
  const v1 = await add('first', null);
  await db.query(`UPDATE builds SET status = 'APPROVED', approved_by = 'operator', approved_at = '2026-09-01T10:00:00Z' WHERE id = $1`, [v1]);
  const v2 = await add('second', v1);
  const v3 = await add('third', v2);
  const lone = await add('separate effort', null);
  const twin = branch ? await add('second, again', v1) : null;
  await db.query('COMMIT');
  return { opp, cat, evidenceId: c.evidenceId, v1, v2, v3, lone, twin };
}

const counts = async (db: pg.Client) => (await db.query(
  `SELECT (SELECT count(*) FROM builds) b, (SELECT count(*) FROM build_evidence) be, (SELECT count(*) FROM opportunities) o,
          (SELECT count(*) FROM evidence) e`)).rows[0];

describe('upgrading Slice 3 builds to build projects', () => {
  it('turns each supersede chain into one project with numbered versions and loses nothing', async () => {
    const { db, ws } = await slice3Db();
    const d = await legacyData(db, ws, false);
    const before = await counts(db);
    // Slice 3 never marked a parent superseded; the chain existed only as a pointer.
    expect((await db.query('SELECT status FROM builds WHERE id = $1', [d.v1])).rows[0].status).toBe('APPROVED');

    expect((await migrate(db, MIGRATIONS_DIR)).applied[0]).toBe('009_build_workspace');
    expect(await counts(db)).toEqual(before);

    const rows = (await db.query(`SELECT id::text, project_id::text, version_no, status, approved_at FROM builds ORDER BY id`)).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect([by[d.v1].version_no, by[d.v2].version_no, by[d.v3].version_no, by[d.lone].version_no]).toEqual([1, 2, 3, 1]);
    expect(new Set([by[d.v1].project_id, by[d.v2].project_id, by[d.v3].project_id]).size).toBe(1);
    expect(by[d.lone].project_id).not.toBe(by[d.v1].project_id);
    expect([by[d.v1].status, by[d.v2].status, by[d.v3].status, by[d.lone].status]).toEqual(['SUPERSEDED', 'SUPERSEDED', 'DRAFT', 'DRAFT']);
    // The approval record survives the status change.
    expect(by[d.v1].approved_at).not.toBeNull();

    const projects = (await db.query(`SELECT id::text, workspace_id::text, opportunity_id::text, build_kind, title FROM build_projects ORDER BY id`)).rows;
    expect(projects).toEqual([
      { id: by[d.v1].project_id, workspace_id: ws, opportunity_id: String(d.opp), build_kind: 'website_fix', title: 'first' },
      { id: by[d.lone].project_id, workspace_id: ws, opportunity_id: String(d.opp), build_kind: 'website_fix', title: 'separate effort' },
    ]);

    // After the upgrade the chain continues: the next supersede is version 4 and closes version 3.
    await db.query('BEGIN');
    await db.query(`SELECT set_config('scopely.workspace_id', $1, true)`, [ws]);
    const v4 = (await db.query(build, [d.opp, d.cat, 'fourth', d.v3, d.evidenceId])).rows[0].id;
    await db.query('COMMIT');
    expect((await db.query('SELECT project_id::text, version_no FROM builds WHERE id = $1', [v4])).rows[0])
      .toEqual({ project_id: by[d.v1].project_id, version_no: 4 });
    expect((await db.query('SELECT status FROM builds WHERE id = $1', [d.v3])).rows[0].status).toBe('SUPERSEDED');
  });

  it('refuses to upgrade a chain with two successors, and leaves the data as it was', async () => {
    const { db, ws } = await slice3Db();
    const d = await legacyData(db, ws, true);
    const before = (await db.query('SELECT id, status, supersedes_build_id FROM builds ORDER BY id')).rows;
    await expect(migrate(db, MIGRATIONS_DIR)).rejects.toThrow(new RegExp(`MIGRATION 009: build ${d.v1} has more than one successor`));
    expect((await db.query('SELECT id, status, supersedes_build_id FROM builds ORDER BY id')).rows).toEqual(before);
    expect((await db.query(`SELECT to_regclass('scopely.build_projects') AS t`)).rows[0].t).toBeNull();
    expect((await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version LIKE '009%'`)).rows[0].n).toBe(0);
  });
});
