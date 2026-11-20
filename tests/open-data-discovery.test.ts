// A54 / A55: discovery without a provider account, and both opportunity paths from it.
//
//   search (industry + place + distance) → OpenStreetMap through the gateway → dedupe, qualify, rank
//   → select → analyse → Fix opportunity (site checked) or Website opportunity (own listing checked
//   by a person) → Discover feed with the source's position → Case File with the evidence.
//
// The Overpass answer here is a fixture shaped like the real API's; nothing in it reaches the network.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createHandler } from '../src/server/app.js';
import { listingProblem } from '../src/analysis/service.js';
import { type PostcodeGeocoder, postcodesIoGeocoder } from '../src/geo/postcodes.js';
import {
  DiscoveryProviderRegistry, OsmBusinessDiscoveryAdapter, OverpassTransport, ProviderError, listedWebsite, osmTagsFor, overpassQuery,
  type OverpassElement as OverpassElementLike,
} from '../src/providers/index.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher } from './fix-helpers.js';
import { CLINIC, TableProbe } from './analysis-helpers.js';
import { enterNewWorkspace, one, useDb } from './helpers.js';
import { SIGNING_KEY } from './site-helpers.js';

const { db } = useDb();

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = { BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv' };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

const CENTRE = { latitude: 51.737047, longitude: 0.473606 };
const geocoder: PostcodeGeocoder = {
  name: 'test',
  lookup: async () => new Map(),
  place: async (q) => (q.toLowerCase() === 'chelmsford' ? { ...CENTRE, label: 'Chelmsford, Essex', source: 'city Chelmsford, Essex · OS Open Names via postcodes.io' } : null),
};

/** Elements as Overpass returns them: a node with a website, a way with none, one listing only social media, one unnamed. */
const ELEMENTS: OverpassElementLike[] = [
  { type: 'node', id: 101, lat: 51.7361, lon: 0.4702, tags: { amenity: 'dentist', name: 'Harbour Dental', website: 'https://harbourclinic.test/', 'addr:postcode': 'cm1 1aa', 'addr:city': 'Chelmsford', phone: '+44 1245 000000' } },
  { type: 'way', id: 202, center: { lat: 51.7402, lon: 0.4811 }, tags: { amenity: 'dentist', name: 'Moulsham Smiles', 'addr:street': 'Moulsham Street', 'addr:housenumber': '12' } },
  { type: 'node', id: 303, lat: 51.731, lon: 0.462, tags: { healthcare: 'dentist', name: 'Springfield Dental', website: 'https://www.facebook.com/springfielddental' } },
  { type: 'node', id: 404, lat: 51.73, lon: 0.46, tags: { amenity: 'dentist' } },
];

class FakeOverpass {
  queries: string[] = [];
  constructor(private readonly elements: OverpassElementLike[] = ELEMENTS) {}
  async query(q: string) { this.queries.push(q); return { elements: this.elements as never, timestamp: '2026-11-20T09:00:00Z' }; }
}

async function start(opts: { overpass?: FakeOverpass; probe?: TableProbe; workspaceId?: string } = {}) {
  const ws = opts.workspaceId ?? (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
  const overpass = opts.overpass ?? new FakeOverpass();
  const probe = opts.probe ?? new TableProbe({ 'https://harbourclinic.test/': { html: CLINIC } });
  const logged: string[] = [];
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY,
    fetcher: new StubFetcher(), probe, geocoder, editLinkTtlSeconds: 900, showLinkTtlSeconds: 3600, log: (l: string) => { logged.push(l); },
    discovery: { providers: new DiscoveryProviderRegistry().register(new OsmBusinessDiscoveryAdapter(overpass)) } });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { 'x-scopely-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  return { call, logged, overpass, probe, ws };
}

const SEARCH = { name: 'Dentists near Chelmsford', verticals: 'Dentists', near: 'Chelmsford', radiusKm: '5', maxDiscoveredPerRun: '20' };

describe('A54: finding real businesses from open data', () => {
  it('centres a search on a place, finds named businesses with their mapped position, and records the call with no key or bill', async () => {
    const srv = await start();
    const s = await srv.call('POST', '/api/searches', SEARCH);
    expect(s.status).toBe(200);
    const def = (await srv.call('GET', `/api/searches/${s.json().searchId}`)).json();
    expect(def.geography).toMatchObject({ center: { latitude: '51.737047', longitude: '0.473606' }, radiusKm: '5.00', centerLabel: 'Chelmsford, Essex' });
    expect((await srv.call('GET', '/api/discovery')).json().providers).toEqual([{ key: 'openstreetmap', label: 'OpenStreetMap', transport: 'live', keyless: true, ready: true, categories: expect.arrayContaining(['dentist', 'plumber']) }]);

    const r = await srv.call('POST', `/api/searches/${s.json().searchId}/runs`, { provider: 'openstreetmap' });
    expect(r.status).toBe(200);
    expect(r.json().result).toMatchObject({ provider: 'openstreetmap', transport: 'live', operations: 1, discovered: 3, error: null });
    expect(srv.overpass.queries[0]).toMatch(/nwr\["amenity"="dentist"\]\["name"\]\(around:5000,51\.737047,0\.473606\)/);
    const op = await one<Record<string, unknown>>(db(), `SELECT * FROM provider_operations WHERE search_run_id = $1`, [r.json().searchRunId]);
    expect(op).toMatchObject({ provider: 'openstreetmap', transport: 'live', provider_connection_id: null, billed_to: null, cost_basis: 'NOT_REPORTED', status: 'SUCCEEDED', result_count: 3 });

    const biz = (await db().query(`SELECT name, domain, website_url, website_status, vertical, postal_code, country_code, latitude::float, longitude::float, geo_source
      FROM businesses WHERE workspace_id = $1 ORDER BY name`, [srv.ws])).rows;
    expect(biz.map((b) => b.name)).toEqual(['Harbour Dental', 'Moulsham Smiles', 'Springfield Dental']);
    // A listed website is not an observation: status stays UNKNOWN. Social media is not a website.
    expect(biz[0]).toMatchObject({ domain: 'harbourclinic.test', website_status: 'UNKNOWN', vertical: 'dentists', postal_code: 'CM1 1AA', country_code: 'GB',
      latitude: 51.7361, longitude: 0.4702 });
    expect(biz[0].geo_source).toMatch(/^OpenStreetMap node\/101 \(mapped point\) · © OpenStreetMap contributors/);
    expect(biz[1]).toMatchObject({ domain: null, website_status: 'UNKNOWN', country_code: null, latitude: 51.7402 });
    expect(biz[1].geo_source).toMatch(/way\/202 \(centre of mapped outline\)/);
    expect(biz[2]).toMatchObject({ domain: null, website_url: null });
    // Qualified against the seller's own words and distance; nothing is fabricated to pass a check.
    const view = (await srv.call('GET', `/api/runs/${r.json().searchRunId}`)).json();
    expect(view.businesses.map((b: any) => b.state)).toEqual(['QUALIFIED', 'QUALIFIED', 'QUALIFIED']);

    // A second run finds the same businesses again: known, not duplicated.
    const again = await srv.call('POST', `/api/searches/${s.json().searchId}/runs`, { provider: 'openstreetmap' });
    expect(again.json().result).toMatchObject({ discovered: 3, newBusinesses: 0, knownBusinesses: 3 });
    expect((await one<{ n: number }>(db(), `SELECT count(*)::int AS n FROM businesses WHERE workspace_id = $1`, [srv.ws])).n).toBe(3);
  });

  it('refuses a search it cannot run, in the seller’s words, before calling anything', async () => {
    const srv = await start();
    expect((await srv.call('POST', '/api/searches', { ...SEARCH, near: 'Atlantis' })).json().error).toMatch(/not a UK postcode, postcode district or town/);
    expect((await srv.call('POST', '/api/searches', { ...SEARCH, radiusKm: '' })).json().error).toMatch(/how far around/);
    expect((await srv.call('POST', '/api/searches', { ...SEARCH, radiusKm: '40' })).json().error).toMatch(/at most 25 km/);
    const odd = await srv.call('POST', '/api/searches', { ...SEARCH, verticals: 'quantum consultancies' });
    const run = await srv.call('POST', `/api/searches/${odd.json().searchId}/runs`, { provider: 'openstreetmap' });
    expect(run.status).toBe(422);
    expect(run.json().error).toMatch(/no category for "quantum consultancies"/);
    const nowhere = await srv.call('POST', '/api/searches', { name: 'x', verticals: 'dentist', maxDiscoveredPerRun: '5' });
    expect((await srv.call('POST', `/api/searches/${nowhere.json().searchId}/runs`, { provider: 'openstreetmap' })).json().error).toMatch(/searches around a place/);
    expect(srv.overpass.queries).toHaveLength(0);
  });
});

describe('A54 / A55: from a found business to an opportunity on the map and its Case File', () => {
  async function foundRun() {
    const srv = await start();
    const s = await srv.call('POST', '/api/searches', SEARCH);
    const r = await srv.call('POST', `/api/searches/${s.json().searchId}/runs`, { provider: 'openstreetmap' });
    const runId: string = r.json().searchRunId;
    const view = (await srv.call('GET', `/api/runs/${runId}`)).json();
    const id = (name: string) => view.businesses.find((b: any) => b.name === name).businessId as string;
    const sel = await srv.call('POST', `/api/runs/${runId}/select`, { businessIds: view.businesses.map((b: any) => b.businessId), selectedBy: 'Seller' });
    expect(sel.status).toBe(200);
    return { ...srv, runId, id };
  }

  it('Path 2: a listed website is fetched, checked and opens a Fix opportunity, placed where the source mapped it', async () => {
    const srv = await foundRun();
    const a = await srv.call('POST', `/api/runs/${srv.runId}/businesses/${srv.id('Harbour Dental')}/analyze`, { requestedBy: 'Seller' });
    expect(a.json()).toMatchObject({ state: 'OPPORTUNITY_FOUND', analysis: { outcome: 'CHECKED' } });
    expect(srv.probe.calls[0]!.url).toBe('https://harbourclinic.test/');
    const oppId = a.json().opportunityIds[0];
    const feed = (await srv.call('GET', '/api/opportunities')).json();
    const item = (Array.isArray(feed) ? feed : feed.items).find((o: any) => o.opportunityId === oppId);
    expect(item.location).toMatchObject({ latitude: 51.7361, longitude: 0.4702 });
    expect(item.location.source).toMatch(/OpenStreetMap node\/101/);
    const cf = (await srv.call('GET', `/api/opportunities/${oppId}`)).json();
    expect(cf.path).toBe('FIX');
    expect(JSON.stringify(cf)).toMatch(/E-TEL-BROKEN|E-WA-BROKEN|E-EMAIL-INVALID/);
    expect((await one<{ website_status: string; website_status_basis: string }>(db(), 'SELECT website_status, website_status_basis FROM businesses WHERE id = $1',
      [srv.id('Harbour Dental')]))).toMatchObject({ website_status: 'WEBSITE_PRESENT', website_status_basis: 'OBSERVED' });
  });

  it('Path 1: no website listed is not evidence; a person’s check of the own listing is, and opens a Website opportunity', async () => {
    const srv = await foundRun();
    // Analysed with no listing check: nothing requested, nothing claimed, status still unknown (A36).
    const plain = await srv.call('POST', `/api/runs/${srv.runId}/businesses/${srv.id('Moulsham Smiles')}/analyze`, { requestedBy: 'Seller' });
    expect(plain.json()).toMatchObject({ state: 'NO_OPPORTUNITY', opportunityIds: [], analysis: { outcome: 'NO_ADDRESS' } });
    expect((await one<{ s: string }>(db(), 'SELECT website_status AS s FROM businesses WHERE id = $1', [srv.id('Moulsham Smiles')])).s).toBe('UNKNOWN');
    expect((await db().query(`SELECT 1 FROM evidence WHERE issue_code = 'E-NO-WEBSITE'`)).rowCount).toBe(0);

    // The source's own record is not the business's listing.
    const wrong = await srv.call('POST', `/api/runs/${srv.runId}/businesses/${srv.id('Springfield Dental')}/analyze`,
      { requestedBy: 'Seller', listing: { url: 'https://www.openstreetmap.org/node/303' } });
    expect(wrong.status).toBe(422);
    expect(wrong.json().error).toMatch(/not its own listing/);

    const listing = 'https://www.google.com/maps/place/Springfield+Dental';
    const checked = await srv.call('POST', `/api/runs/${srv.runId}/businesses/${srv.id('Springfield Dental')}/analyze`, { requestedBy: 'Seller', listing: { url: listing } });
    expect(checked.status).toBe(200);
    expect(checked.json()).toMatchObject({ state: 'OPPORTUNITY_FOUND', analysis: { outcome: 'NO_ADDRESS' } });
    expect(srv.probe.calls).toHaveLength(0);
    const ev = await one<Record<string, unknown>>(db(), `SELECT e.claim_state, e.url, e.quote, o.state, o.check_code, s.fetch_method
      FROM evidence e JOIN observations o ON o.id = e.observation_id JOIN snapshots s ON s.id = o.snapshot_id WHERE e.issue_code = 'E-NO-WEBSITE'`);
    expect(ev).toMatchObject({ claim_state: 'OBSERVED', url: listing, state: 'OBSERVED', check_code: 'website_presence.listing', fetch_method: 'manual' });
    expect(String(ev.quote)).toMatch(/Checked by Seller/);
    const biz = await one<Record<string, unknown>>(db(), 'SELECT website_status, website_status_basis, website_status_source FROM businesses WHERE id = $1', [srv.id('Springfield Dental')]);
    expect(biz).toMatchObject({ website_status: 'WEBSITE_NOT_OBSERVED', website_status_basis: 'OBSERVED' });
    expect(String(biz.website_status_source)).toMatch(/^person:Seller · own listing/);
    const cf = (await srv.call('GET', `/api/opportunities/${checked.json().opportunityIds[0]}`)).json();
    expect(cf).toMatchObject({ path: 'WEBSITE', service: { catalogKey: 'website_build', price: null } });

    // A business with a website address on file is checked on its site, never by a listing.
    const site = await srv.call('POST', `/api/runs/${srv.runId}/businesses/${srv.id('Harbour Dental')}/analyze`, { requestedBy: 'Seller', listing: { url: listing } });
    expect(site.status).toBe(422);
  });

  it('keeps each workspace’s discovery to itself', async () => {
    const srv = await foundRun();
    const other = await enterNewWorkspace(db(), 'other');
    server?.close();
    const theirs = await start({ workspaceId: other });
    expect((await theirs.call('GET', `/api/runs/${srv.runId}`)).status).toBe(404);
    expect((await theirs.call('POST', `/api/runs/${srv.runId}/businesses/${srv.id('Harbour Dental')}/analyze`, { requestedBy: 'X' })).status).toBe(404);
    expect((await theirs.call('GET', '/api/opportunities')).text).not.toMatch(/Harbour Dental/);
  });
});

describe('A54: only a named open-data source may call live with no connection', () => {
  it('the ledger refuses a keyless live call from any other provider, or one that names a payer or a cost', async () => {
    const { failure } = await import('./helpers.js');
    const row = (provider: string, extra = '') => `INSERT INTO provider_operations (provider, capability, operation, transport, request_sha256, status, attempts,
      started_at, completed_at, latency_ms, result_count, cost_basis${extra ? ', billed_to' : ''})
      VALUES ('${provider}', 'business_discovery', 'search', 'live', repeat('a', 64), 'SUCCEEDED', 1, now(), now(), 1, 0, 'NOT_REPORTED'${extra})`;
    expect(await failure(db(), row('openstreetmap'))).toBeNull();
    expect(await failure(db(), row('clay'))).toMatch(/provider_operation_live_payer/);
    expect(await failure(db(), row('openstreetmap', ", 'SCOPELY'"))).toMatch(/provider_operation_live_payer/);
  });
});

describe('A54: the OpenStreetMap adapter on its own', () => {
  it('maps the seller’s industry words, or an exact tag, and nothing else', () => {
    expect(osmTagsFor(['Dentists', 'physio', 'osm:shop=florist', 'Beauty salons'])).toEqual({
      terms: [
        { word: 'Dentists', tags: [['amenity', 'dentist'], ['healthcare', 'dentist']] },
        { word: 'physio', tags: [['healthcare', 'physiotherapist']] },
        { word: 'osm:shop=florist', tags: [['shop', 'florist']] },
        { word: 'Beauty salons', tags: [['shop', 'beauty']] },
      ], unknown: [] });
    expect(osmTagsFor(['widgets']).unknown).toEqual(['widgets']);
    expect(osmTagsFor(['osm:shop=x"];out;']).unknown).toHaveLength(1);
    expect(overpassQuery([['amenity', 'dentist'], ['amenity', 'dentist']], 51.5, -0.1, 2.5, 60)).toBe(
      '[out:json][timeout:25];(nwr["amenity"="dentist"]["name"](around:2500,51.500000,-0.100000););out center tags 60;');
  });

  it('keeps only a real website address, never a social profile or a non-web link', () => {
    expect(listedWebsite({ website: 'www.oakdental.co.uk' })).toEqual({ url: 'https://www.oakdental.co.uk/', domain: 'oakdental.co.uk' });
    expect(listedWebsite({ 'contact:website': 'http://a.test/x; http://b.test' })).toMatchObject({ domain: 'a.test' });
    for (const w of ['https://facebook.com/x', 'https://www.instagram.com/x', 'https://wa.me/447700900000', 'mailto:a@b.test', 'javascript:alert(1)', 'nope']) {
      expect(listedWebsite({ website: w }), w).toBeNull();
    }
  });

  it('turns Overpass failures into the gateway’s errors, and refuses a half-finished answer', async () => {
    const t = (status: number, body: unknown = {}) => new OverpassTransport(async () => ({ ok: status < 400, status, json: async () => body }));
    await expect(t(429).query('q')).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(t(504).query('q')).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(t(400).query('q')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t(200, { nope: 1 }).query('q')).rejects.toMatchObject({ code: 'malformed_response' });
    await expect(t(200, { elements: [], remark: 'runtime error: Query timed out' }).query('q')).rejects.toBeInstanceOf(ProviderError);
    await expect(new OverpassTransport(async () => { throw new Error('reset'); }).query('q')).rejects.toMatchObject({ code: 'network' });
  });

  it('refuses a listing link that is not one', () => {
    expect(listingProblem('')).toMatch(/Paste the link/);
    expect(listingProblem('google maps')).toMatch(/not a link/);
    expect(listingProblem('ftp://x.test/')).toMatch(/starting https/);
    expect(listingProblem('https://openstreetmap.org/way/1')).toMatch(/not its own listing/);
    expect(listingProblem('https://www.facebook.com/someclinic')).toBeNull();
  });
});

describe('A54: centring a search on a place', () => {
  it('resolves a postcode, a district or a named town, and nothing it cannot place in the UK', async () => {
    const urls: string[] = [];
    const answers: Record<string, unknown> = {
      '/postcodes/CM11JE': { latitude: 51.736812, longitude: 0.465435 },
      '/outcodes/CM1': { latitude: 51.747, longitude: 0.458 },
      '/places?q=Chelmsford&limit=10': [{ name_1: 'Chelmsford', local_type: 'City', county_unitary: 'Essex', latitude: 51.73704745, longitude: 0.47360617 }],
      '/places?q=Paris&limit=10': [{ name_1: 'Paris', local_type: 'Town', latitude: 48.85, longitude: 2.35 }],
    };
    const g = postcodesIoGeocoder(async (url) => {
      const path = url.replace('https://api.postcodes.io', '');
      urls.push(path);
      return path in answers ? { ok: true, status: 200, json: async () => ({ result: answers[path] }) } : { ok: false, status: 404, json: async () => ({}) };
    });
    expect(await g.place!('cm1 1je')).toMatchObject({ label: 'CM1 1JE', latitude: 51.736812, source: expect.stringMatching(/^postcode CM1 1JE/) });
    expect(await g.place!('cm1')).toMatchObject({ label: 'CM1', source: expect.stringMatching(/^postcode district CM1/) });
    expect(await g.place!('Chelmsford')).toMatchObject({ label: 'Chelmsford, Essex', latitude: 51.737047, source: expect.stringMatching(/^city Chelmsford, Essex · OS Open Names/) });
    expect(await g.place!('Paris')).toBeNull();
    expect(await g.place!('ZZ99 9ZZ')).toBeNull();
    const down = postcodesIoGeocoder(async () => { throw new Error('reset'); });
    await expect(down.place!('Chelmsford')).rejects.toThrow(/unreachable/);
  });
});
