// Slice 10: the Find screen's routes. A seller saves a search, runs it against a discovery provider
// (recorded Clay responses, or a fake live endpoint), reads the run and selects businesses. The
// routes refuse bad input in the seller's words, never return or log a provider key, and never
// reach another workspace's runs.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createHandler } from '../src/server/app.js';
import {
  ClayBusinessDiscoveryAdapter, ClayMcpTransport, DiscoveryProviderRegistry, EnvSecretResolver, secretEnvName,
} from '../src/providers/index.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher } from './fix-helpers.js';
import { recordedClay } from './clay-recordings.js';
import { enterNewWorkspace, one, useDb } from './helpers.js';
import { SIGNING_KEY } from './site-helpers.js';

const { db } = useDb();

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = {
    BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv',
  };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

const recorded = () => ({ providers: new DiscoveryProviderRegistry().register(new ClayBusinessDiscoveryAdapter(recordedClay())) });
const currentWs = async () => (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;

type Discovery = Parameters<typeof createHandler>[0]['discovery'];

async function start(discovery: Discovery = recorded(), workspaceId?: string) {
  const ws = workspaceId ?? await currentWs();
  const logged: string[] = [];
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY,
    fetcher: new StubFetcher(), editLinkTtlSeconds: 900, showLinkTtlSeconds: 3600, log: (l: string) => { logged.push(l); },
    discovery });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = { 'x-scopely-request': '1' }) => {
    const r = await fetch(base + p, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  return { call, logged, workspaceId: ws };
}

const ICP = { name: 'Small clinics in one city', verticals: 'Medical Practices', countryCode: 'gb', city: 'Leeds',
  employeeMin: '2', employeeMax: '50', maxDiscoveredPerRun: '40', maxBusinessesToAnalyze: '3' };

async function recordedRun() {
  const srv = await start();
  const s = await srv.call('POST', '/api/searches', ICP);
  expect(s.status).toBe(200);
  const { searchId } = s.json();
  const r = await srv.call('POST', `/api/searches/${searchId}/runs`, { provider: 'clay' });
  expect(r.status).toBe(200);
  const runId: string = r.json().searchRunId;
  const view = (await srv.call('GET', `/api/runs/${runId}`)).json();
  return { ...srv, searchId, runId, run: r.json(), view };
}

describe('saving a search', () => {
  it('saves the seller’s ICP as given, and refuses what it cannot run in the seller’s words', async () => {
    const srv = await start();
    const bad = async (body: Record<string, unknown>) => {
      const r = await srv.call('POST', '/api/searches', { ...ICP, ...body });
      expect(r.status).toBe(422);
      return r.json().error as string;
    };
    expect(await bad({ name: '' })).toBe('Give the search a name.');
    expect(await bad({ maxDiscoveredPerRun: '' })).toMatch(/how many businesses a run may find/);
    expect(await bad({ maxDiscoveredPerRun: '101' })).toMatch(/from 1 to 100/);
    expect(await bad({ employeeMin: '50', employeeMax: '10' })).toMatch(/Fewest employees cannot be more/);
    expect(await bad({ countryCode: 'GBR' })).toMatch(/short line|two-letter/);
    expect(await bad({ websitePresence: 'maybe' })).toMatch(/any, required or absent/);
    expect(await bad({ city: 'Leeds\nYork' })).toMatch(/short line of text/);
    expect(await db().query('SELECT 1 FROM searches WHERE workspace_id = $1', [srv.workspaceId])).toHaveProperty('rowCount', 0);

    const ok = await srv.call('POST', '/api/searches', ICP);
    expect(ok.status).toBe(200);
    const row = await one<Record<string, unknown>>(db(), `SELECT name, verticals, country_code, city, employee_min, employee_max,
      max_discovered_per_run, max_businesses_to_analyze FROM searches WHERE id = $1`, [ok.json().searchId]);
    expect(row).toEqual({ name: ICP.name, verticals: ['Medical Practices'], country_code: 'GB', city: 'Leeds', employee_min: 2, employee_max: 50,
      max_discovered_per_run: 40, max_businesses_to_analyze: 3 });
  });

  it('saves a revenue threshold in the currency the seller names, and refuses a range it cannot hold', async () => {
    const srv = await start();
    const bad = async (body: Record<string, unknown>) => {
      const r = await srv.call('POST', '/api/searches', { ...ICP, ...body });
      expect(r.status).toBe(422);
      return r.json().error as string;
    };
    expect(await bad({ revenueMin: '5000000', revenueMax: '1000000', revenueCurrency: 'USD' })).toBe('Lowest revenue cannot be more than highest revenue.');
    expect(await bad({ revenueMin: '1000000' })).toBe('Say which currency the revenue is in.');
    expect(await bad({ revenueMin: '1,000,000', revenueCurrency: 'USD' })).toMatch(/Lowest revenue must be a whole number/);
    expect(await bad({ revenueMax: '-5', revenueCurrency: 'USD' })).toMatch(/Highest revenue must be a whole number/);
    expect(await bad({ revenueMin: '1000000', revenueCurrency: 'US$' })).toMatch(/three-letter code/);
    expect(await db().query('SELECT 1 FROM searches WHERE workspace_id = $1', [srv.workspaceId])).toHaveProperty('rowCount', 0);

    const usd = await srv.call('POST', '/api/searches', { ...ICP, revenueMin: '1000000', revenueMax: '5000000', revenueCurrency: 'usd' });
    expect(usd.status).toBe(200);
    const gbp = await srv.call('POST', '/api/searches', { ...ICP, name: 'In pounds', revenueMin: '800000', revenueCurrency: 'GBP' });
    const rows = (await db().query('SELECT id::text, revenue_min, revenue_max, revenue_currency FROM searches WHERE id = ANY ($1) ORDER BY id',
      [[usd.json().searchId, gbp.json().searchId]])).rows;
    expect(rows).toEqual([
      { id: usd.json().searchId, revenue_min: '1000000.00', revenue_max: '5000000.00', revenue_currency: 'USD' },
      { id: gbp.json().searchId, revenue_min: '800000.00', revenue_max: null, revenue_currency: 'GBP' }]);
    // A currency with no amount is not a threshold, and is not saved as one.
    const none = await srv.call('POST', '/api/searches', { ...ICP, name: 'No revenue', revenueCurrency: 'USD' });
    expect(await one(db(), 'SELECT revenue_currency FROM searches WHERE id = $1', [none.json().searchId])).toEqual({ revenue_currency: null });
  });

  it('refuses a write without the request header', async () => {
    const srv = await start();
    const r = await srv.call('POST', '/api/searches', ICP, {});
    expect(r.status).toBe(403);
    expect(await db().query('SELECT 1 FROM searches WHERE workspace_id = $1', [srv.workspaceId])).toHaveProperty('rowCount', 0);
  });
});

describe('running a search from the Find screen (recorded Clay responses)', () => {
  it('finds, pre-qualifies and ranks the businesses, and says the cost was not reported', async () => {
    const r = await recordedRun();
    expect(r.run.result).toMatchObject({ transport: 'recorded', operations: 2, discovered: 40, stoppedBy: 'limit' });
    expect(r.view.economics).toMatchObject({ costBasis: 'NOT_REPORTED' });
    expect(r.view.businesses).toHaveLength(40);
    expect(r.view.businesses[0]).toMatchObject({ state: 'QUALIFIED', provenance: { provider: 'clay', basis: 'PROVIDER_REPORTED' } });
    const list = (await r.call('GET', '/api/discovery')).json();
    expect(list.providers).toEqual([{ key: 'clay', label: expect.any(String), transport: 'recorded', ready: true }]);
    expect(list.runs[0]).toMatchObject({ searchRunId: r.runId, discovered: 40 });
    // The log names ids and counts, never a business.
    expect(r.logged.join('\n')).toMatch(new RegExp(`run ${r.runId} search ${r.searchId} clay recorded ops=2 found=40`));
    expect(r.logged.join('\n')).not.toMatch(/Leeds|clinic|\.co\.uk/i);
  });

  it('selects qualified businesses, and refuses rejected ones, too many, or one from elsewhere', async () => {
    const r = await recordedRun();
    const ids = (state: string) => r.view.businesses.filter((b: { state: string }) => b.state === state).map((b: { businessId: string }) => b.businessId);
    const select = (businessIds: string[], selectedBy = 'Sam') => r.call('POST', `/api/runs/${r.runId}/select`, { businessIds, selectedBy });
    expect((await select(ids('REJECTED').slice(0, 1))).json().error).toBe('Only qualified businesses can be selected. Review the others first.');
    expect((await select(ids('QUALIFIED').slice(0, 4))).json().error).toBe('That is more businesses than this search may analyse.');
    expect((await select(ids('QUALIFIED').slice(0, 2), '')).status).toBe(422);
    expect((await select([])).status).toBe(422);
    expect((await select(['999999999'])).status).toBe(404);
    const ok = await select(ids('QUALIFIED').slice(0, 2));
    expect(ok.status).toBe(200);
    const after = (await r.call('GET', `/api/runs/${r.runId}`)).json();
    expect(after.businesses.filter((b: { state: string }) => b.state === 'SELECTED')).toHaveLength(2);
  });

  it('refuses an unknown provider, leaving no run behind', async () => {
    const srv = await start();
    const { searchId } = (await srv.call('POST', '/api/searches', ICP)).json();
    const r = await srv.call('POST', `/api/searches/${searchId}/runs`, { provider: 'nobody' });
    expect(r.status).toBe(422);
    expect(r.json()).toMatchObject({ reason: 'no_provider' });
    expect(await db().query('SELECT 1 FROM search_runs WHERE search_id = $1', [searchId])).toHaveProperty('rowCount', 0);
  });

  it('does not show or select from another workspace’s run or search', async () => {
    const r = await recordedRun();
    server?.close();
    const other = await enterNewWorkspace(db(), 'other');
    const srv = await start(recorded(), other);
    expect((await srv.call('GET', `/api/runs/${r.runId}`)).status).toBe(404);
    expect((await srv.call('GET', `/api/searches/${r.searchId}`)).status).toBe(404);
    expect((await srv.call('POST', `/api/searches/${r.searchId}/runs`, { provider: 'clay' })).status).toBe(404);
    const qualified = r.view.businesses.find((b: { state: string }) => b.state === 'QUALIFIED').businessId;
    expect((await srv.call('POST', `/api/runs/${r.runId}/select`, { businessIds: [qualified], selectedBy: 'Sam' })).status).toBe(404);
    expect((await srv.call('GET', '/api/discovery')).json()).toMatchObject({ searches: [], runs: [] });
  });
});

describe('a live provider behind the Find screen (fake Clay endpoint)', () => {
  const SECRET = 'clay-live-access-fedcba9876543210';

  it('says whether the workspace is connected, and never returns or logs the key', async () => {
    const ws = await currentWs();
    const fake = (async (_url: string, init: RequestInit) => {
      const msg = JSON.parse(String(init.body));
      if (msg.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const page = { taskId: 't1', hasMore: false, timestampMs: Date.parse('2026-10-05T16:00:00Z'),
        companies: { 9: { entityId: '9', name: 'Clinic Nine', size: '2-10', country: 'United Kingdom', industry: 'Medical Practices', locality: 'Leeds', domain: 'nine.test' } } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(page) }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const ref = `secretref:ws/${ws}/clay`;
    const discovery = {
      providers: new DiscoveryProviderRegistry().register(new ClayBusinessDiscoveryAdapter(new ClayMcpTransport({ fetch: fake }))),
      secrets: new EnvSecretResolver({ [secretEnvName(ref)]: SECRET }),
    };
    const srv = await start(discovery);
    expect((await srv.call('GET', '/api/discovery')).json().providers).toEqual([{ key: 'clay', label: expect.any(String), transport: 'live', ready: false }]);
    const { searchId } = (await srv.call('POST', '/api/searches', ICP)).json();
    const refusedRun = await srv.call('POST', `/api/searches/${searchId}/runs`, { provider: 'clay' });
    expect(refusedRun.json()).toMatchObject({ reason: 'not_connected' });

    await db().query(`INSERT INTO provider_connections (provider, mode, scopes, credential_ref, state, activated_at)
      VALUES ('clay', 'CUSTOMER_KEY', '{discovery}', $1, 'ACTIVE', now())`, [ref]);
    const list = await srv.call('GET', '/api/discovery');
    expect(list.json().providers[0]).toMatchObject({ transport: 'live', ready: true });
    const run = await srv.call('POST', `/api/searches/${searchId}/runs`, { provider: 'clay' });
    expect(run.json().result).toMatchObject({ transport: 'live', discovered: 1, stoppedBy: 'exhausted' });
    const view = await srv.call('GET', `/api/runs/${run.json().searchRunId}`);
    for (const text of [list.text, run.text, view.text, srv.logged.join('\n')]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('secretref:');
    }
  });
});
