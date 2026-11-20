// Launch pass (A51): the opportunity map, Discover's summary and placing businesses from a UK
// postcode. A point exists only where a named source gave a position; nothing is invented, and a
// workspace never sees or changes another's businesses.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POSTCODE_GEO_SOURCE, GeocoderUnavailable, locateBusinesses, normalisePostcode, postcodesIoGeocoder, type PostcodeGeocoder } from '../src/geo/postcodes.js';
import { listInputFromBody } from '../src/lists/index.js';
import { createHandler, type ServerConfig } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher } from './fix-helpers.js';
import { enterNewWorkspace, one, useDb, useWorkspace } from './helpers.js';
import { SIGNING_KEY, seedWebsiteOpportunity } from './site-helpers.js';

const { db } = useDb();

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = {
    BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv',
  };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}

/** A directory that knows a fixed set of postcodes, and records what it was asked. */
function stubGeocoder(known: Record<string, [number, number]>): PostcodeGeocoder & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    name: 'stub', asked,
    async lookup(pcs) {
      asked.push(pcs);
      return new Map(pcs.filter((p) => known[p]).map((p) => [p, { latitude: known[p]![0], longitude: known[p]![1] }]));
    },
  };
}

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function start(over: Partial<ServerConfig> = {}) {
  const ws = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY,
    fetcher: new StubFetcher(), editLinkTtlSeconds: 900, showLinkTtlSeconds: 3600, log: () => undefined, ...over } as ServerConfig);
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'x-scopely-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) as any };
  };
}

describe('UK postcodes', () => {
  it('accepts a full UK postcode in any spacing and case, and nothing else', () => {
    expect(normalisePostcode('sw1a1aa')).toBe('SW1A 1AA');
    expect(normalisePostcode('  CM1   7GU ')).toBe('CM1 7GU');
    expect(normalisePostcode('M1 1AE')).toBe('M1 1AE');
    for (const bad of ['SW1A', 'CM1', '12345', 'London', '', 'SW1A 1AA extra', null, 42]) expect(normalisePostcode(bad), String(bad)).toBeNull();
  });

  it('postcodes.io: batches by 100, keeps only answers with a UK position, and fails closed', async () => {
    const calls: string[][] = [];
    const ok = postcodesIoGeocoder(async (_url, init) => {
      const pcs = (JSON.parse(init.body) as { postcodes: string[] }).postcodes;
      calls.push(pcs);
      return { ok: true, status: 200, json: async () => ({ result: pcs.map((q, i) => ({ query: q,
        result: q === 'ZZ9 9ZZ' ? null : q === 'AB1 0AA' ? { latitude: null, longitude: null } : q === 'GY1 1AA' ? { latitude: 10, longitude: 10 }
          : { latitude: 51.5 + i / 1000, longitude: -0.1 } })) }) };
    });
    const pcs = Array.from({ length: 150 }, (_, i) => `E1 ${String(i % 10)}AA`).concat(['ZZ9 9ZZ', 'AB1 0AA', 'GY1 1AA']);
    const got = await ok.lookup(pcs);
    expect(calls.length).toBe(1); // 10 distinct + 3
    expect(got.has('ZZ9 9ZZ')).toBe(false);
    expect(got.has('AB1 0AA')).toBe(false); // no grid reference: never placed
    expect(got.has('GY1 1AA')).toBe(false); // outside the UK box: refused, not misplaced
    expect(got.get('E1 0AA')).toEqual({ latitude: 51.5, longitude: -0.1 });
    const many = Array.from({ length: 250 }, (_, i) => `X${i} 1AA`);
    calls.length = 0;
    await ok.lookup(many);
    expect(calls.map((c) => c.length)).toEqual([100, 100, 50]);
    const down = postcodesIoGeocoder(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(down.lookup(['E1 0AA'])).rejects.toBeInstanceOf(GeocoderUnavailable);
    const net = postcodesIoGeocoder(async () => { throw new TypeError('fetch failed'); });
    await expect(net.lookup(['E1 0AA'])).rejects.toThrow(/unreachable/);
  });
});

describe('placing businesses (locateBusinesses)', () => {
  it('places only unplaced businesses of this workspace that carry a UK postcode, and says where it came from', async () => {
    const a = await seedWebsiteOpportunity(db()); // postal_code ZZ1 1ZZ, no position
    const placed = await one<{ id: string }>(db(), `INSERT INTO businesses (name, postal_code, latitude, longitude, geo_source)
      VALUES ('Already placed', 'E1 6AN', 51.52, -0.07, 'provider: clay') RETURNING id`);
    const abroad = await one<{ id: string }>(db(), `INSERT INTO businesses (name, postal_code, country_code) VALUES ('Abroad', 'E1 6AN', 'IE') RETURNING id`);
    const noPc = await one<{ id: string }>(db(), `INSERT INTO businesses (name) VALUES ('No postcode') RETURNING id`);
    const mine = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
    // Another workspace's business with a postcode the directory knows.
    const other = await enterNewWorkspace(db(), 'other');
    const theirs = await one<{ id: string }>(db(), `INSERT INTO businesses (name, postal_code) VALUES ('Theirs', 'ZZ1 1ZZ') RETURNING id`);
    await useWorkspace(db(), mine);
    const g = stubGeocoder({ 'ZZ1 1ZZ': [51.501234, -0.141234], 'E1 6AN': [51.52, -0.07] });
    const r = await locateBusinesses(db(), g);
    expect(r).toEqual({ checked: 1, located: 1, unknownPostcode: 0, noPostcode: 2 });
    expect(g.asked).toEqual([['ZZ1 1ZZ']]);
    const row = await one<{ latitude: string; longitude: string; geo_source: string }>(db(), 'SELECT latitude, longitude, geo_source FROM businesses WHERE id = $1', [a.businessId]);
    expect(row).toEqual({ latitude: '51.501234', longitude: '-0.141234', geo_source: POSTCODE_GEO_SOURCE });
    expect((await one<{ geo_source: string }>(db(), 'SELECT geo_source FROM businesses WHERE id = $1', [placed.id])).geo_source).toBe('provider: clay');
    for (const id of [abroad.id, noPc.id]) expect((await one<{ latitude: string | null }>(db(), 'SELECT latitude FROM businesses WHERE id = $1', [id])).latitude).toBeNull();
    await useWorkspace(db(), other);
    expect((await one<{ latitude: string | null }>(db(), 'SELECT latitude FROM businesses WHERE id = $1', [theirs.id])).latitude).toBeNull();
  });

  it('a postcode the directory does not know leaves the business off the map', async () => {
    await one(db(), `INSERT INTO businesses (name, postal_code) VALUES ('Unknown pc', 'QQ9 9QQ') RETURNING id`);
    expect(await locateBusinesses(db(), stubGeocoder({}))).toMatchObject({ checked: 1, located: 0, unknownPostcode: 1 });
    expect((await db().query('SELECT count(*)::int AS n FROM businesses WHERE latitude IS NOT NULL')).rows[0].n).toBe(0);
  });
});

describe('lists take a town and a UK postcode, as typed', () => {
  it('records both; refuses a postcode that is not a full UK postcode', () => {
    const ok = listInputFromBody({ name: 'L', entries: [{ name: 'A Clinic', domain: 'a-clinic.test', town: 'Leeds', postcode: 'ls1 4dy' }] });
    expect(ok.entries[0]).toMatchObject({ town: 'Leeds', postcode: 'LS1 4DY' });
    expect(() => listInputFromBody({ name: 'L', entries: [{ name: 'A', domain: 'a.test', postcode: 'Leeds' }] })).toThrow(/fixing/);
    const csv = listInputFromBody({ name: 'C', csv: 'name,domain,town,postcode\nB Clinic,b-clinic.test,York,YO1 7HH\n' });
    expect(csv.entries[0]).toMatchObject({ town: 'York', postcode: 'YO1 7HH' });
    expect(csv.ignoredColumns).toEqual([]);
  });
});

describe('Discover and the map API', () => {
  it('the feed carries a position only with its source; /api/discover counts records; locate places from postcode', async () => {
    const seeded = await seedWebsiteOpportunity(db());
    const call = await start({ geocoder: stubGeocoder({ 'ZZ1 1ZZ': [51.5, -0.12] }) });
    let feed = (await call('GET', '/api/opportunities')).json();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ opportunityId: seeded.opportunityId, businessId: seeded.businessId, postcode: 'ZZ1 1ZZ', location: null });
    let sum = (await call('GET', '/api/discover')).json();
    expect(sum).toMatchObject({ businesses: 1, located: 0, postcodeUnplaced: 1, funnel: { opportunities: 1 } });
    const loc = await call('POST', '/api/map/locate');
    expect(loc.json()).toMatchObject({ located: 1 });
    feed = (await call('GET', '/api/opportunities')).json();
    expect(feed[0].location).toEqual({ latitude: 51.5, longitude: -0.12, source: POSTCODE_GEO_SOURCE });
    sum = (await call('GET', '/api/discover')).json();
    expect(sum).toMatchObject({ located: 1, postcodeUnplaced: 0 });
  });

  it('locate is refused when the server has no geocoder, and a directory outage changes nothing', async () => {
    await seedWebsiteOpportunity(db());
    expect((await (await start())('POST', '/api/map/locate')).status).toBe(409);
    server?.close();
    const down = await start({ geocoder: { name: 'down', lookup: async () => { throw new GeocoderUnavailable('postcode directory unreachable'); } } });
    const r = await down('POST', '/api/map/locate');
    expect(r.status).toBe(503);
    expect(r.json().error).toMatch(/Nothing was changed/);
    expect((await db().query('SELECT count(*)::int AS n FROM businesses WHERE latitude IS NOT NULL')).rows[0].n).toBe(0);
  });

  it('a list with postcodes is placed as it is saved; without a geocoder it is saved unplaced', async () => {
    const call = await start({ geocoder: stubGeocoder({ 'LS1 4DY': [53.797, -1.548] }) });
    const r = await call('POST', '/api/lists', { name: 'Leeds clinics', entries: [{ name: 'Leeds Clinic', domain: 'leeds-clinic.test', town: 'Leeds', postcode: 'LS1 4DY' }] });
    expect(r.status).toBe(200);
    expect(r.json().located).toBe(1);
    const b = await one<{ city: string; postal_code: string; country_code: string; geo_source: string }>(db(),
      `SELECT city, postal_code, country_code, geo_source FROM businesses WHERE domain = 'leeds-clinic.test'`);
    expect(b).toEqual({ city: 'Leeds', postal_code: 'LS1 4DY', country_code: 'GB', geo_source: POSTCODE_GEO_SOURCE });
    const sum = (await call('GET', '/api/discover')).json();
    expect(sum).toMatchObject({ businesses: 1, lists: 1, runs: 1, funnel: { found: 1 } });
    expect(sum.nextRun).toMatchObject({ name: 'Leeds clinics', kind: 'list' });
  });

  it('another workspace sees none of it', async () => {
    await seedWebsiteOpportunity(db());
    await db().query(`UPDATE businesses SET latitude = 51.5, longitude = -0.12, geo_source = 'test' WHERE workspace_id = scopely.current_workspace_id()`);
    await enterNewWorkspace(db(), 'other');
    const call = await start();
    expect((await call('GET', '/api/opportunities')).json()).toEqual([]);
    expect((await call('GET', '/api/discover')).json()).toMatchObject({ businesses: 0, located: 0, funnel: { found: 0, opportunities: 0 }, nextRun: null });
  });
});

describe('the product page and the map library', () => {
  it('serves MapLibre from this server, and lets only /app reach the one tile host', async () => {
    const call = await start();
    const app = await call('GET', '/app');
    const csp = app.headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'self' https://tiles.openfreemap.org");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(app.text).toContain('/discover.css');
    const landing = (await call('GET', '/')).headers.get('content-security-policy')!;
    expect(landing).toContain("connect-src 'self';");
    expect(landing).not.toContain('openfreemap');
    for (const f of ['/vendor/maplibre-gl.mjs', '/vendor/maplibre-gl-worker.mjs']) {
      const r = await call('GET', f);
      expect(r.status, f).toBe(200);
      expect(r.headers.get('content-type'), f).toMatch(/javascript/);
    }
    expect((await call('GET', '/vendor/maplibre-gl.css')).headers.get('content-type')).toMatch(/css/);
    expect((await call('GET', '/vendor/../package.json')).status).toBe(404);
  });
});

describe('the browser modules', () => {
  // The UI modules read document.getElementById at import; a stand-in is enough for their pure parts.
  beforeAll(() => { (globalThis as any).document ??= { getElementById: () => null, createElement: () => ({}) }; });

  it('the map draws only items that carry a source position; it never geocodes or guesses', async () => {
    const { mapPoints } = await import('../src/server/ui/map-slot.js' as string);
    const items = [
      { opportunityId: '1', path: 'FIX', business: 'A', location: { latitude: 51.5, longitude: -0.1, source: POSTCODE_GEO_SOURCE } },
      { opportunityId: '2', path: 'WEBSITE', business: 'B', location: null, city: 'Leeds', postcode: 'LS1 4DY' },
      { opportunityId: '3', path: 'WEBSITE', business: 'C', demo: true, location: { latitude: 51.4, longitude: -0.2, source: 'demo: fictional position for a fictional business' } },
      { opportunityId: '4', path: 'FIX', business: 'D', location: { latitude: 200, longitude: 0, source: 'x' } },
    ];
    const fc = mapPoints(items);
    expect(fc.features.map((f: any) => f.properties.id)).toEqual(['1', '3']);
    expect(fc.features[0].geometry.coordinates).toEqual([-0.1, 51.5]);
    expect(fc.features[0].properties.precision).toBe('postcode');
    expect(fc.features[1].properties).toMatchObject({ demo: true, precision: 'demo' });
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/server/ui/map-slot.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/nominatim|geocod|googleapis|mapbox|api\.postcodes/i);
    expect(src.match(/https:\/\/[a-z.]+/g)).toEqual(['https://tiles.openfreemap.org']);
  });

  it('the join screen reads damaged invite links and the masked email hint', async () => {
    const { readInviteToken, emailFitsHint } = await import('../src/server/ui/auth.js' as string);
    const t = 'T8Qai4lFNnD4122sq12iOVLMApsdW5hxLZNvv6yTrcM';
    expect(readInviteToken('')).toEqual({ problem: 'missing' });
    expect(readInviteToken(null)).toEqual({ problem: 'missing' });
    expect(readInviteToken(t)).toEqual({ token: t });
    expect(readInviteToken(`${t}.`)).toEqual({ token: t });
    expect(readInviteToken(`${t})%20`)).toEqual({ token: t });
    expect(readInviteToken(t.slice(0, 30))).toEqual({ problem: 'short', length: 30 });
    expect(readInviteToken(`${t}abc`)).toEqual({ problem: 'long', length: 46 });
    expect(readInviteToken('abc$def')).toEqual({ problem: 'garbled' });
    expect(emailFitsHint('founder@clinic-sales.test', 'f•••••@c•••.test')).toBe(true);
    expect(emailFitsHint('Founder@Clinic-Sales.test', 'f•••••@c•••.test')).toBe(true);
    expect(emailFitsHint('someone@icloud.com', 'f•••••@c•••.test')).toBe(false);
    expect(emailFitsHint('anything@x.y', null)).toBe(true);
  });

  it('the Case File journey reads only server states and names one next step', async () => {
    const { journeyOf } = await import('../src/server/ui/case-file.js' as string);
    const base = {
      path: 'FIX', business: { demo: false, sources: [{ provider: 'manual', sourceType: 'manual', foundAt: '2026-11-20T00:00:00Z' }] },
      evidence: [{ claimState: 'OBSERVED' }], build: { buildState: 'NONE', canStart: true }, outreach: { recheckNeeded: [] },
      readiness: { status: 'NOT_READY', checks: [{ key: 'contact', state: 'missing', label: 'Contact missing' }] },
      sell: { sellState: 'NOT_STARTED', deliveryState: 'NONE', paymentStatus: 'not_won', quotedAmount: null, agreedAmount: null, paidAmount: null },
    };
    expect(journeyOf(base).next.text).toMatch(/Build the fix/);
    const built = { ...base, build: { buildState: 'DEMO_DRAFT', canStart: false } };
    expect(journeyOf(built).next).toMatchObject({ sec: '07' });
    const won = { ...built, readiness: { status: 'READY', checks: [] }, sell: { ...base.sell, sellState: 'WON', paymentStatus: 'awaiting_payment' } };
    expect(journeyOf(won).next.text).toMatch(/Deliver the work/);
    const verified = { ...won, sell: { ...won.sell, deliveryState: 'VERIFIED_PASSED' } };
    expect(journeyOf(verified).next.text).toMatch(/Only money received counts as revenue/);
    const paid = { ...verified, sell: { ...verified.sell, paymentStatus: 'paid_in_full' } };
    expect(journeyOf(paid).next.text).toMatch(/Complete/);
    expect(journeyOf(paid).steps.every((s: any) => s.state === 'done')).toBe(true);
    expect(journeyOf({ ...base, business: { ...base.business, demo: true } }).next.text).toMatch(/demo data/);
    expect(journeyOf({ ...base, evidence: [{ claimState: 'INFERRED' }] }).steps[1]).toMatchObject({ state: 'cur', note: '1 inferred only' });
  });
});
