// A database that is behind the code (a migration not applied) must say so, by name at startup and
// in the app, instead of a generic "Something went wrong" on Discover. Nothing is migrated for it.
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { MIGRATIONS_DIR, pendingMigrations } from '../src/db/migrate.js';
import { SCHEMA_BEHIND_MESSAGE, createHandler } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher } from './fix-helpers.js';
import { one, useDb } from './helpers.js';
import { SIGNING_KEY } from './site-helpers.js';

const { db } = useDb();

/** The test transaction as the server's pool; `rewrite` stands in for a database without some objects. */
function poolOver(client: pg.Client, rewrite: (sql: string) => string = (s) => s): pg.Pool {
  const map: Record<string, string> = { BEGIN: 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv' };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? rewrite(sql), params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function start(rewrite?: (sql: string) => string) {
  const ws = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
  const logged: string[] = [];
  const handler = createHandler({ pool: poolOver(db(), rewrite), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY,
    fetcher: new StubFetcher(), editLinkTtlSeconds: 900, showLinkTtlSeconds: DEFAULT_SHOW_LINK_TTL_SECONDS, log: (l: string) => { logged.push(l); } });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
  return { get, logged };
}

describe('a database behind the code', () => {
  it('Discover reports a missing migration (a database before 012 has no fix_captures), not a generic failure', async () => {
    const { get, logged } = await start((sql) => sql.replace(/scopely\.fix_captures\b/g, 'scopely.fix_captures_not_migrated'));
    const feed = await get('/api/opportunities');
    expect(feed.status).toBe(503);
    expect(feed.body).toEqual({ error: SCHEMA_BEHIND_MESSAGE, reason: 'schema_behind' });
    expect(String(feed.body.error)).toContain('pnpm migrate');
    expect(logged).toContain('error GET /api/opportunities 42P01');
    // The header's workspace still loads, as it did on the iPad.
    expect((await get('/api/workspace')).status).toBe(200);
  });

  it('a missing column or function says the same; any other database error stays a plain 500', async () => {
    let s = await start((sql) => sql.replace('e.plain_issue,', 'e.plain_issue_not_migrated,'));
    expect((await s.get('/api/opportunities')).status).toBe(503);
    server?.close();
    // A view that the feed reads is present but the request fails some other way: no migration hint.
    s = await start((sql) => (sql.includes('v_opportunity_feed') ? 'SELECT 1/0' : sql));
    const r = await s.get('/api/opportunities');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Something went wrong. Nothing was changed.' });
  });

  it('the feed works on a fully migrated database', async () => {
    const { get } = await start();
    const feed = await get('/api/opportunities');
    expect(feed.status).toBe(200);
    expect(Array.isArray(feed.body)).toBe(true);
  });
});

describe('pendingMigrations', () => {
  it('is empty when every migration is applied, and names the ones that are not, without applying them', async () => {
    expect(await pendingMigrations(db())).toEqual([]);
    const dir = mkdtempSync(path.join(tmpdir(), 'scopely-mig-'));
    for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql')) writeFileSync(path.join(dir, f), '');
    writeFileSync(path.join(dir, '998_later.sql'), 'SELECT 1;');
    writeFileSync(path.join(dir, '999_latest.sql'), 'SELECT 1;');
    const before = (await one<{ n: string }>(db(), 'SELECT count(*)::text AS n FROM scopely.schema_migrations')).n;
    expect(await pendingMigrations(db(), dir)).toEqual(['998_later', '999_latest']);
    expect((await one<{ n: string }>(db(), 'SELECT count(*)::text AS n FROM scopely.schema_migrations')).n).toBe(before);
  });

  it('treats a database with no migration ledger as having applied nothing', async () => {
    const fake = { query: async (sql: string) => ({ rows: sql.includes('to_regclass') ? [{ t: null }] : [] }) } as unknown as pg.Client;
    const all = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort().map((f) => f.replace(/\.sql$/, ''));
    expect(await pendingMigrations(fake)).toEqual(all);
  });
});
