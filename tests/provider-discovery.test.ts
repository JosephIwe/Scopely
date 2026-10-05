// Slice 10: the provider gateway and the first provider path, Clay business discovery.
//
// The Clay responses replayed here were recorded from Clay on 2026-10-05 (fixtures/providers/clay).
// No test calls Clay: the live transport is exercised against a fake MCP endpoint.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRunDiscovery } from '../src/api/discovery.js';
import { createSearch, startSearchRun, type SearchInput } from '../src/discovery/index.js';
import {
  ClayBusinessDiscoveryAdapter, ClayMcpTransport, DiscoveryProviderRegistry, DiscoveryRefused, EnvSecretResolver, ProviderError,
  callProvider, clayCompanyQuery, clayCountryName, countryCode, normalizeClayCompany, parseLocality, revenueBuckets, runProviderDiscovery, secretEnvName,
} from '../src/providers/index.js';
import { criteriaFromRow } from '../src/discovery/index.js';
import { recordedClay } from './clay-recordings.js';
import { asApp, enterNewWorkspace, failure, one, useDb } from './helpers.js';

const { db } = useDb();

const recorded = () => new DiscoveryProviderRegistry().register(new ClayBusinessDiscoveryAdapter(recordedClay()));
const noSleep = async () => undefined;

/** The ICP the recorded search B was run with: one industry, a city and a 2-50 employee range. */
const ICP: SearchInput = {
  name: 'Small clinics in one city', verticals: ['Medical Practices'], countryCode: 'GB', city: 'Leeds',
  employeeMin: 2, employeeMax: 50, maxDiscoveredPerRun: 40,
};
/** The query the ICP is sent as, with the city and country in one location clause, as recorded from Clay. */
const RECORDED_QUERY = 'select from companies where industry = "Medical Practices" and company_size in ("2-10", "11-50") and locations.any(city = "Leeds" and country_name = "United Kingdom")';

async function runFor(input: Partial<SearchInput> = {}) {
  const searchId = await createSearch(db(), { ...ICP, ...input });
  return startSearchRun(db(), searchId);
}

const AS_OF = new Date('2026-10-05T15:00:00Z');

describe('Clay query plan', () => {
  const criteria = (c: Partial<SearchInput>) => criteriaFromRow({
    verticals: [], subverticals: [], specialties: [], business_types: [], website_statuses: [], opportunity_kinds: [],
    excluded_domains: [], excluded_business_types: [], website_presence: 'any',
    ...Object.fromEntries(Object.entries({ verticals: c.verticals, city: c.city, country_code: c.countryCode, employee_min: c.employeeMin, employee_max: c.employeeMax,
      revenue_min: c.revenueMin, revenue_max: c.revenueMax, revenue_currency: c.revenueCurrency })
      .filter(([, v]) => v !== undefined)),
  });

  it('pushes industry, size, city and country down, exactly as the recorded search was run', () => {
    expect(clayCompanyQuery(criteria(ICP))).toEqual({ dsl: RECORDED_QUERY, pushedDown: ['industry', 'size', 'city', 'country'] });
  });

  it('lists several industries, and leaves size out when every bucket fits', () => {
    const q = clayCompanyQuery(criteria({ verticals: ['Dentists', 'Medical Practices'] }));
    expect(q).toEqual({ dsl: 'select from companies where industry in ("Dentists", "Medical Practices")', pushedDown: ['industry'] });
    expect(clayCompanyQuery(criteria({ city: 'York', employeeMin: 0 }))).toEqual({ dsl: 'select from companies where locations.any(city = "York")', pushedDown: ['city'] });
    expect(clayCompanyQuery(criteria({ city: 'York', employeeMin: 300 }))).toMatchObject({ dsl: expect.stringContaining('company_size in ("201-500", "501-1,000"') });
  });

  it('escapes a seller’s values rather than splicing them into the query', () => {
    const q = clayCompanyQuery(criteria({ city: 'X") or (industry = "Y' }));
    expect(q).toEqual({ dsl: 'select from companies where locations.any(city = "X\\") or (industry = \\"Y")', pushedDown: ['city'] });
    expect(clayCompanyQuery(criteria({ city: 'a\nb' }))).toHaveProperty('refused');
  });

  it('refuses a search with neither an industry nor a city: it would pull an unbounded list', () => {
    expect(clayCompanyQuery(criteria({ employeeMin: 2, employeeMax: 10 }))).toEqual({ refused: expect.stringMatching(/industry or a city/) });
  });
});

describe('Clay query plan: country and revenue (Slice 10 review)', () => {
  const criteria = (c: Partial<SearchInput>) => criteriaFromRow({
    verticals: ['Dentists'], subverticals: [], specialties: [], business_types: [], website_statuses: [], opportunity_kinds: [],
    excluded_domains: [], excluded_business_types: [], website_presence: 'any',
    ...Object.fromEntries(Object.entries({ city: c.city, country_code: c.countryCode, revenue_min: c.revenueMin, revenue_max: c.revenueMax,
      revenue_currency: c.revenueCurrency }).filter(([, v]) => v !== undefined)),
  });

  it('sends the country as the name Clay’s locations carry, with the city in the same location when there is one', () => {
    expect(clayCompanyQuery(criteria({ countryCode: 'GB' }))).toEqual({
      dsl: 'select from companies where industry = "Dentists" and locations.any(country_name = "United Kingdom")', pushedDown: ['industry', 'country'] });
    expect(clayCompanyQuery(criteria({ countryCode: 'US', city: 'Austin' }))).toEqual({
      dsl: 'select from companies where industry = "Dentists" and locations.any(city = "Austin" and country_name = "United States")',
      pushedDown: ['industry', 'city', 'country'] });
    // A country without an industry or a city is still too broad to send.
    expect(clayCompanyQuery({ ...criteria({ countryCode: 'GB' }), verticals: [] })).toHaveProperty('refused');
  });

  it('escapes the location clause, and never sends a country that is not an ISO code', () => {
    expect(clayCountryName('GB')).toBe('United Kingdom');
    expect(clayCountryName('G"')).toBeNull();
    expect(clayCountryName('gb')).toBeNull();
    const q = clayCompanyQuery(criteria({ city: 'X" and country_name = "Y', countryCode: 'GB' }));
    expect(q).toEqual({ dsl: 'select from companies where industry = "Dentists" and locations.any(city = "X\\" and country_name = \\"Y" and country_name = "United Kingdom")',
      pushedDown: ['industry', 'city', 'country'] });
  });

  it('sends a US-dollar revenue range as the Clay revenue buckets it overlaps', () => {
    expect(revenueBuckets(1_000_000, 10_000_000)).toEqual(['500K-1M', '1M-5M', '5M-10M', '10M-25M']);
    expect(revenueBuckets(2_000_000, null)).toEqual(['1M-5M', '5M-10M', '10M-25M', '25M-75M', '75M-200M', '200M-500M', '500M-1B', '1B-10B', '10B-100B', '100B-1T']);
    expect(revenueBuckets(0, null)).toBeNull();
    const q = clayCompanyQuery(criteria({ revenueMin: 2_000_000, revenueMax: 4_000_000, revenueCurrency: 'USD', city: 'Leeds', countryCode: 'GB' }));
    expect(q).toEqual({
      dsl: 'select from companies where industry = "Dentists" and annual_revenue in ("1M-5M") and locations.any(city = "Leeds" and country_name = "United Kingdom")',
      pushedDown: ['industry', 'revenue', 'city', 'country'] });
    expect(clayCompanyQuery(criteria({ revenueMin: 2e12, revenueCurrency: 'USD', city: 'Leeds' }))).toHaveProperty('refused');
  });

  it('never converts: a revenue range in another currency is not sent to Clay, and Scopely alone checks it', () => {
    const q = clayCompanyQuery(criteria({ revenueMin: 2_000_000, revenueCurrency: 'GBP', city: 'Leeds' }));
    expect(q).toEqual({ dsl: 'select from companies where industry = "Dentists" and locations.any(city = "Leeds")', pushedDown: ['industry', 'city'] });
    expect(JSON.stringify(q)).not.toContain('annual_revenue');
  });
});

describe('Clay normalization', () => {
  it('reads country names into ISO codes and splits localities without inventing a city', () => {
    expect(countryCode('United Kingdom')).toBe('GB');
    expect(countryCode('United States')).toBe('US');
    expect(countryCode('Atlantis')).toBeNull();
    expect(parseLocality('Leeds, West Yorkshire', 'United Kingdom')).toEqual({ city: 'Leeds', region: 'West Yorkshire', postalCode: null });
    expect(parseLocality('Leeds LS8 2ET, England', 'United Kingdom')).toEqual({ city: 'Leeds', region: 'England', postalCode: 'LS8 2ET' });
    expect(parseLocality('Chelmsford, CM1 7GU', 'United Kingdom')).toEqual({ city: 'Chelmsford', region: null, postalCode: 'CM1 7GU' });
    expect(parseLocality('Leeds, United Kingdom', 'United Kingdom')).toEqual({ city: 'Leeds', region: null, postalCode: null });
    expect(parseLocality('England', 'United Kingdom')).toEqual({ city: null, region: 'England', postalCode: null });
  });

  it('keeps the stated size bucket as a REPORTED range, and leaves revenue, type and website status unknown', () => {
    const b = normalizeClayCompany({
      entityId: '16073296', name: 'Vision Care', size: '2-10', type: 'Non Profit', domain: 'visioncareforhomelesspeople.org', country: 'United Kingdom',
      website: 'http://www.visioncareforhomelesspeople.org/', industry: 'Medical Practices', locality: 'London', employee_count: 51,
      annual_revenue: '1M-5M', description: 'Free text with a phone number 0113 000 0000', logo_url: 'https://logo.test/x.png',
    }, '2026-10-05T14:25:03.914Z')!;
    expect(b).toMatchObject({
      name: 'Vision Care', domain: 'visioncareforhomelesspeople.org', vertical: 'Medical Practices', city: 'London', countryCode: 'GB',
      employees: { min: 2, max: 10, basis: 'REPORTED', source: 'clay:company_size', asOf: '2026-10-05T14:25:03.914Z' },
      source: { provider: 'clay', sourceType: 'api', reference: 'company:16073296' },
    });
    expect(b.revenue).toBeUndefined();
    expect(b.companyType).toBeUndefined();
    expect(b.independence).toBeUndefined();
    // The provider's own estimate is kept as the provider said it; descriptions and logos are not kept.
    expect(b.source.record).toMatchObject({ employee_count: 51, annual_revenue: '1M-5M', size: '2-10' });
    expect(b.source.record).not.toHaveProperty('description');
    expect(b.source.record).not.toHaveProperty('logo_url');
  });

  it('derives a domain from the website when the record has none, and skips a record without an id or name', () => {
    expect(normalizeClayCompany({ entityId: '1', name: 'A', website: 'http://Www.Example-Clinic.test/x' }, 'now')!.domain).toBe('example-clinic.test');
    expect(normalizeClayCompany({ entityId: '1', name: '  ' }, 'now')).toBeNull();
    expect(normalizeClayCompany({ name: 'No id' }, 'now')).toBeNull();
  });
});

describe('provider discovery through the gateway (recorded Clay responses)', () => {
  it('finds, normalizes, deduplicates and pre-qualifies a run, recording each call with no invented cost', async () => {
    const runId = await runFor();
    const r = await runProviderDiscovery(db(), { providers: recorded(), sleep: noSleep }, runId, 'clay', AS_OF);
    expect(r).toMatchObject({
      provider: 'clay', transport: 'recorded', operations: 2, returned: 40, discovered: 40, newBusinesses: 40, knownBusinesses: 0,
      repeatedInRun: 0, limit: 40, stoppedBy: 'limit', error: null,
    });
    expect(r.qualification.qualified + r.qualification.rejected + r.qualification.needsReview).toBe(40);

    const ops = (await db().query('SELECT * FROM provider_operations WHERE search_run_id = $1 ORDER BY id', [runId])).rows;
    expect(ops.map((o) => [o.operation, o.status, o.result_count, o.request_ref, o.cost_basis, o.provider_credits, o.transport, o.billed_to]))
      .toEqual([
        ['search', 'SUCCEEDED', 20, 'mcp-task_0tmfwg3G7BWtdhSmfhi', 'NOT_REPORTED', null, 'recorded', null],
        ['search_next_page', 'SUCCEEDED', 20, 'mcp-task_0tmfwgacva37AdQRd8y', 'NOT_REPORTED', null, 'recorded', null],
      ]);

    // Provenance: every business points at the call that found it, with the provider's record.
    const src = await one<{ n: string; with_op: string; observed: string }>(db(),
      `SELECT count(*) AS n, count(provider_operation_id) AS with_op, min(found_at)::text AS observed FROM sources WHERE search_run_id = $1`, [runId]);
    expect(src).toEqual({ n: '40', with_op: '40', observed: '2026-10-05 15:02:27.162+00' });

    // The ICP decides, not the provider: a business Clay matched on a branch office elsewhere is rejected on geography,
    // even with the country pushed down (Clay returned the US company because it has an office in the city).
    const v = (await getRunDiscovery(db(), runId))!;
    const byName = new Map(v.businesses.map((b) => [b.name, b]));
    expect(byName.get('Vision Care')).toMatchObject({ state: 'REJECTED', failedStage: 'geography', city: 'London' });
    expect(byName.get('Scaled Insights')).toMatchObject({ state: 'REJECTED', failedStage: 'geography', countryCode: 'US' });
    expect(byName.get('Briggate Dental')).toMatchObject({ state: 'QUALIFIED', city: 'Leeds', countryCode: 'GB',
      employees: { min: 11, max: 50, basis: 'REPORTED' }, websiteStatus: 'UNKNOWN',
      provenance: { provider: 'clay', reference: 'company:37816594', basis: 'PROVIDER_REPORTED', transport: 'recorded' } });
    // Priority: qualified first, rejected last.
    expect(v.businesses[0]!.state).toBe('QUALIFIED');
    expect(v.businesses.at(-1)!.state).toBe('REJECTED');
    expect(v.businesses.map((b) => b.priority)).toEqual(v.businesses.map((_, i) => i + 1));
    expect(v.economics).toMatchObject({ operations: 2, failed: 0, results: 40, discovered: 40, costBasis: 'NOT_REPORTED', providerCredits: null });
  });

  it('recognises businesses the workspace already holds, across runs and searches', async () => {
    await runProviderDiscovery(db(), { providers: recorded(), sleep: noSleep }, await runFor(), 'clay', AS_OF);
    const again = await runProviderDiscovery(db(), { providers: recorded(), sleep: noSleep }, await runFor({ name: 'Second look' }), 'clay', AS_OF);
    expect(again).toMatchObject({ discovered: 40, newBusinesses: 0, knownBusinesses: 40 });
    expect((await one<{ n: string }>(db(), `SELECT count(*) AS n FROM businesses WHERE workspace_id = scopely.current_workspace_id()`)).n).toBe('40');
  });

  it('stops at the search’s own limit, and at the platform ceiling when the search allows more', async () => {
    const small = await runProviderDiscovery(db(), { providers: recorded(), sleep: noSleep }, await runFor({ maxDiscoveredPerRun: 25 }), 'clay', AS_OF);
    expect(small).toMatchObject({ operations: 2, discovered: 25, stoppedBy: 'limit' });

    // A search allowing 500 is held to the ceiling; the third page was never recorded, so the run
    // stops there with a normalized error and keeps the 40 it found.
    const big = await runProviderDiscovery(db(), { providers: recorded(), sleep: noSleep }, await runFor({ name: 'Big', maxDiscoveredPerRun: 500 }), 'clay', AS_OF);
    expect(big).toMatchObject({ limit: 100, discovered: 40, operations: 3, stoppedBy: 'error', error: { code: 'not_recorded' } });
    const failed = await one(db(), `SELECT status, error_code, result_count, attempts FROM provider_operations WHERE status = 'FAILED'`);
    expect(failed).toEqual({ status: 'FAILED', error_code: 'not_recorded', result_count: null, attempts: 1 });
  });

  it('refuses a run without a discovery limit, a search it cannot bound, a closed run and another workspace’s run', async () => {
    const deps = { providers: recorded(), sleep: noSleep };
    await expect(runProviderDiscovery(db(), deps, await runFor({ maxDiscoveredPerRun: undefined }), 'clay')).rejects.toMatchObject({ reason: 'no_limit' });
    await expect(runProviderDiscovery(db(), deps, await runFor({ name: 'Broad', verticals: [], city: undefined }), 'clay')).rejects.toMatchObject({ reason: 'not_searchable' });
    await expect(runProviderDiscovery(db(), deps, await runFor(), 'nobody')).rejects.toBeInstanceOf(DiscoveryRefused);
    const closed = await runFor({ name: 'Closed' });
    await db().query(`UPDATE search_runs SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [closed]);
    await expect(runProviderDiscovery(db(), deps, closed, 'clay')).rejects.toMatchObject({ reason: 'run_closed' });
    const theirs = await runFor({ name: 'Theirs' });
    await enterNewWorkspace(db(), 'other');
    await expect(runProviderDiscovery(db(), deps, theirs, 'clay')).rejects.toThrow(/does not exist in this workspace/);
    expect((await one<{ n: string }>(db(), 'SELECT count(*) AS n FROM provider_operations')).n).toBe('0');
  });

  it('never lets provider output past suppression: a suppressed domain is rejected at exclusions', async () => {
    await db().query(`INSERT INTO suppression (domain, reason) VALUES ('drindra.co.uk', 'opt_out')`);
    const runId = await runFor();
    await runProviderDiscovery(db(), { providers: recorded(), sleep: noSleep }, runId, 'clay', AS_OF);
    const v = (await getRunDiscovery(db(), runId))!;
    expect(v.businesses.find((b) => b.domain === 'drindra.co.uk')).toMatchObject({ state: 'REJECTED', failedStage: 'exclusions' });
  });

  it('keeps provider operations, provenance and results inside their workspace under row-level security', async () => {
    const mine = await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws');
    const runId = await runFor();
    await runProviderDiscovery(db(), { providers: recorded(), sleep: noSleep }, runId, 'clay', AS_OF);
    const other = await enterNewWorkspace(db(), 'other');
    const seen = await asApp(db(), other, async () => ({
      ops: (await db().query('SELECT id FROM provider_operations')).rows.length,
      view: await getRunDiscovery(db(), runId),
    }));
    expect(seen).toEqual({ ops: 0, view: null });
    const own = await asApp(db(), mine.ws, async () => (await db().query('SELECT id FROM provider_operations')).rows.length);
    expect(own).toBe(2);
  });
});

describe('live provider path (fake Clay endpoint, no network)', () => {
  const SECRET = 'clay-live-access-0123456789abcdef';
  const page = (taskId: string, hasMore: boolean, ids: string[]) => ({
    taskId, hasMore, timestampMs: Date.parse('2026-10-05T16:00:00Z'),
    companies: Object.fromEntries(ids.map((id, i) => [id, { entityId: id, name: `Clinic ${id}`, size: '2-10', country: 'United Kingdom',
      industry: 'Medical Practices', locality: 'Leeds, West Yorkshire', domain: `clinic-${id}.test`, order: i }])),
  });

  /** A fake MCP endpoint: answers initialize, then tools/call from `answers` in order. */
  function fakeClay(answers: ((args: Record<string, unknown>) => Response | Promise<Response>)[]) {
    const seen: { auth: string | null; body: string }[] = [];
    let i = 0;
    const f = (async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      seen.push({ auth: (init.headers as Record<string, string>).authorization ?? null, body });
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }),
          { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
      }
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const answer = answers[i++]!;
      const res = await answer(msg.params.arguments);
      if (res.status !== 200) return res;
      const result = await res.json();
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    return { f, seen };
  }
  const ok = (v: unknown) => () => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(v) }] }), { status: 200 });
  const toolError = (text: string) => () => new Response(JSON.stringify({ isError: true, content: [{ type: 'text', text }] }), { status: 200 });

  async function liveSetup(answers: Parameters<typeof fakeClay>[0], connection: { scopes?: string[]; state?: string } = {}) {
    const ws = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
    const ref = `secretref:ws/${ws}/clay`;
    const c = await one<{ id: string }>(db(), `INSERT INTO provider_connections (provider, mode, scopes, credential_ref, state, activated_at)
      VALUES ('clay', 'CUSTOMER_KEY', $1, $2, $3, now()) RETURNING id`, [connection.scopes ?? ['discovery'], ref, connection.state ?? 'ACTIVE']);
    const { f, seen } = fakeClay(answers);
    const providers = new DiscoveryProviderRegistry().register(new ClayBusinessDiscoveryAdapter(new ClayMcpTransport({ fetch: f })));
    const secrets = new EnvSecretResolver({ [secretEnvName(ref)]: SECRET });
    return { providers, secrets, seen, connectionId: c.id, ws };
  }

  it('calls the provider with the workspace’s key, bills the workspace, and never stores or returns the key', async () => {
    const s = await liveSetup([ok(page('t1', true, ['1', '2'])), ok(page('t2', false, ['3']))]);
    const runId = await runFor({ maxDiscoveredPerRun: 10 });
    const r = await runProviderDiscovery(db(), { providers: s.providers, secrets: s.secrets, sleep: noSleep }, runId, 'clay', AS_OF);
    expect(r).toMatchObject({ transport: 'live', operations: 2, discovered: 3, stoppedBy: 'exhausted' });
    const ops = (await db().query('SELECT * FROM provider_operations WHERE search_run_id = $1 ORDER BY id', [runId])).rows;
    expect(ops.map((o) => [o.transport, o.provider_connection_id, o.billed_to, o.request_ref, o.cost_basis])).toEqual([
      ['live', s.connectionId, 'WORKSPACE', 't1', 'NOT_REPORTED'], ['live', s.connectionId, 'WORKSPACE', 't2', 'NOT_REPORTED']]);
    // The key went only into the Authorization header of calls to the provider.
    expect(s.seen.every((x) => x.auth === `Bearer ${SECRET}`)).toBe(true);
    expect(s.seen.some((x) => x.body.includes(SECRET))).toBe(false);
    const dump = JSON.stringify([(await db().query('SELECT * FROM provider_operations')).rows, (await db().query('SELECT * FROM sources')).rows,
      (await db().query('SELECT * FROM businesses')).rows, await getRunDiscovery(db(), runId)]);
    expect(dump).not.toContain(SECRET);
  });

  it('retries a rate limit and records the attempts; does not retry a refused credential or a bad query', async () => {
    const s = await liveSetup([toolError('Too many concurrent requests. Please try again shortly.'), ok(page('t1', false, ['1']))]);
    const r = await runProviderDiscovery(db(), { providers: s.providers, secrets: s.secrets, sleep: noSleep }, await runFor({ maxDiscoveredPerRun: 5 }), 'clay', AS_OF);
    expect(r).toMatchObject({ discovered: 1, error: null });
    expect(await one(db(), 'SELECT status, attempts FROM provider_operations')).toEqual({ status: 'SUCCEEDED', attempts: 2 });

    const bad = await liveSetup([toolError("Unknown field 'location_country' for entity 'companies'"), ok(page('t9', false, ['9']))]);
    const r2 = await runProviderDiscovery(db(), { providers: bad.providers, secrets: bad.secrets, sleep: noSleep }, await runFor({ name: 'Bad', maxDiscoveredPerRun: 5 }), 'clay', AS_OF);
    expect(r2).toMatchObject({ discovered: 0, stoppedBy: 'error', error: { code: 'invalid_request' } });

    const denied = await liveSetup([() => new Response('no', { status: 401 })]);
    const r3 = await runProviderDiscovery(db(), { providers: denied.providers, secrets: denied.secrets, sleep: noSleep }, await runFor({ name: 'Denied', maxDiscoveredPerRun: 5 }), 'clay', AS_OF);
    expect(r3).toMatchObject({ error: { code: 'auth' } });
    const failed = (await db().query(`SELECT error_code, attempts FROM provider_operations WHERE status = 'FAILED' ORDER BY id`)).rows;
    expect(failed).toEqual([{ error_code: 'invalid_request', attempts: 1 }, { error_code: 'auth', attempts: 1 }]);
  });

  it('sends the search’s country and US-dollar revenue to Clay, still decides itself, and records no revenue fact', async () => {
    const usOffice = { ...page('t1', false, ['1', '2']) };
    (usOffice.companies as Record<string, Record<string, unknown>>)['2']!.country = 'United States';
    (usOffice.companies as Record<string, Record<string, unknown>>)['2']!.locality = 'Austin, Texas';
    for (const c of Object.values(usOffice.companies)) (c as Record<string, unknown>).annual_revenue = '1M-5M';
    const s = await liveSetup([ok(usOffice)]);
    const runId = await runFor({ maxDiscoveredPerRun: 10, revenueMin: 1_500_000, revenueMax: 4_000_000, revenueCurrency: 'USD' });
    const r = await runProviderDiscovery(db(), { providers: s.providers, secrets: s.secrets, sleep: noSleep }, runId, 'clay', AS_OF);
    expect(r).toMatchObject({ discovered: 2, error: null });
    const call = s.seen.map((x) => JSON.parse(x.body)).find((m) => m.method === 'tools/call');
    expect(call.params.arguments.dslQuery).toBe('select from companies where industry = "Medical Practices" and company_size in ("2-10", "11-50") '
      + 'and annual_revenue in ("1M-5M") and locations.any(city = "Leeds" and country_name = "United Kingdom")');
    const v = (await getRunDiscovery(db(), runId))!;
    const byName = new Map(v.businesses.map((b) => [b.name, b]));
    // Clay's filter narrowed the list; Scopely's geography check still rejects what it returned outside the country.
    expect(byName.get('Clinic 2')).toMatchObject({ state: 'REJECTED', failedStage: 'geography', countryCode: 'US' });
    // Clay's revenue bucket names no currency, so no revenue fact is recorded and revenue is unknown: review, not a pass.
    expect(byName.get('Clinic 1')).toMatchObject({ state: 'NEEDS_REVIEW' });
    const unknown = await one<{ unknown_stages: string[] }>(db(), `SELECT rb.unknown_stages FROM search_run_businesses rb
      JOIN businesses b ON b.id = rb.business_id WHERE rb.search_run_id = $1 AND b.name = 'Clinic 1'`, [runId]);
    expect(unknown.unknown_stages).toContain('revenue');
    expect((await db().query(`SELECT 1 FROM businesses WHERE workspace_id = $1 AND (revenue_amount IS NOT NULL OR revenue_min IS NOT NULL
      OR revenue_max IS NOT NULL OR revenue_currency IS NOT NULL OR revenue_basis IS NOT NULL)`, [s.ws])).rowCount).toBe(0);
    expect(await one(db(), `SELECT s.provider_record->>'annual_revenue' AS rev FROM sources s JOIN search_run_businesses rb ON rb.source_id = s.id
      JOIN businesses b ON b.id = rb.business_id WHERE rb.search_run_id = $1 AND b.name = 'Clinic 1'`, [runId])).toEqual({ rev: '1M-5M' });
  });

  it('keeps the record of a failed call whose error text looks like a credential, without the text', async () => {
    const s = await liveSetup([toolError('Unauthorized: token sk-live0123456789abcdef was rejected')]);
    const r = await runProviderDiscovery(db(), { providers: s.providers, secrets: s.secrets, sleep: noSleep }, await runFor({ maxDiscoveredPerRun: 5 }), 'clay', AS_OF);
    expect(r).toMatchObject({ discovered: 0, error: { code: 'auth' } });
    expect(await one(db(), 'SELECT status, error_code, error_detail FROM provider_operations')).toEqual({ status: 'FAILED', error_code: 'auth', error_detail: '[redacted]' });
  });

  it('refuses a live search without an ACTIVE discovery connection, or when the server has no key for it', async () => {
    const s = await liveSetup([], { scopes: ['build'] });
    await expect(runProviderDiscovery(db(), { providers: s.providers, secrets: s.secrets }, await runFor(), 'clay')).rejects.toMatchObject({ reason: 'not_connected' });
    await db().query(`INSERT INTO provider_connections (provider, mode, scopes, credential_ref, state, activated_at)
      VALUES ('clay', 'CUSTOMER_KEY', '{discovery}', $1, 'ACTIVE', now())`, [`secretref:ws/${s.ws}/other`]);
    const r = await runProviderDiscovery(db(), { providers: s.providers, secrets: new EnvSecretResolver({}) }, await runFor({ name: 'No key' }), 'clay', AS_OF);
    expect(r).toMatchObject({ discovered: 0, error: { code: 'auth' } });
  });
});

describe('provider_operations guards', () => {
  const base = (over: Record<string, unknown> = {}) => {
    const v: Record<string, unknown> = {
      provider: 'clay', capability: 'business_discovery', operation: 'search', transport: 'recorded', provider_connection_id: null, billed_to: null,
      request_sha256: 'a'.repeat(64), status: 'SUCCEEDED', error_code: null, attempts: 1, started_at: '2026-10-05T10:00:00Z',
      completed_at: '2026-10-05T10:00:01Z', latency_ms: 1000, result_count: 3, cost_basis: 'NOT_REPORTED', provider_credits: null, meta: '{}', ...over,
    };
    const cols = Object.keys(v);
    return [`INSERT INTO provider_operations (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(v)] as const;
  };
  const insert = (over: Record<string, unknown> = {}) => failure(db(), ...base(over));
  async function connection(scopes = ['discovery'], state = 'ACTIVE', mode = 'CUSTOMER_KEY') {
    const ws = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
    return (await one<{ id: string }>(db(), `INSERT INTO provider_connections (provider, mode, scopes, credential_ref, state, activated_at)
      VALUES ('clay', $1, $2, $3, $4, CASE WHEN $4 = 'ACTIVE' THEN now() END) RETURNING id`,
      [mode, scopes, mode === 'CUSTOMER_KEY' ? `secretref:ws/${ws}/clay` : null, state])).id;
  }

  it('accepts a well-formed recorded and live operation', async () => {
    expect(await insert()).toBeNull();
    expect(await insert({ transport: 'live', provider_connection_id: await connection(), billed_to: 'WORKSPACE' })).toBeNull();
  });

  it('is append-only: an operation cannot be edited or deleted', async () => {
    const { id } = await one<{ id: string }>(db(), ...base());
    expect(await failure(db(), 'UPDATE provider_operations SET result_count = 99 WHERE id = $1', [id])).toMatch(/ledger/);
    expect(await failure(db(), 'DELETE FROM provider_operations WHERE id = $1', [id])).toMatch(/never deleted/);
  });

  it('never invents a cost: REPORTED needs a value, a value needs REPORTED, an amount needs a currency', async () => {
    expect(await insert({ cost_basis: 'REPORTED' })).toMatch(/check/);
    expect(await insert({ provider_credits: 2 })).toMatch(/check/);
    const live = { transport: 'live', provider_connection_id: await connection(), billed_to: 'WORKSPACE' };
    expect(await insert({ ...live, cost_basis: 'REPORTED', provider_credits: 2 })).toBeNull();
    expect(await insert({ ...live, cost_basis: 'REPORTED', provider_cost_amount: 1 })).toMatch(/check/);
  });

  it('keeps replays apart from live calls: a recorded call has no connection, payer or cost; a live call has a connection and payer', async () => {
    const c = await connection();
    expect(await insert({ provider_connection_id: c, billed_to: 'WORKSPACE' })).toMatch(/check/);
    expect(await insert({ transport: 'live' })).toMatch(/check/);
    expect(await insert({ transport: 'live', status: 'FAILED', error_code: 'not_recorded', result_count: null, provider_connection_id: c, billed_to: 'WORKSPACE' })).toMatch(/check/);
  });

  it('a live call needs this provider’s ACTIVE discovery connection, billed to whoever holds the key', async () => {
    expect(await insert({ transport: 'live', provider_connection_id: await connection(['build']), billed_to: 'WORKSPACE' })).toMatch(/ACTIVE discovery connection/);
    expect(await insert({ transport: 'live', provider_connection_id: await connection(['discovery'], 'PENDING'), billed_to: 'WORKSPACE' })).toMatch(/ACTIVE discovery connection/);
    expect(await insert({ transport: 'live', provider_connection_id: await connection(), billed_to: 'SCOPELY' })).toMatch(/billed to WORKSPACE/);
    expect(await insert({ provider: 'other', transport: 'live', provider_connection_id: await connection(), billed_to: 'WORKSPACE' })).toMatch(/is clay, not other/);
  });

  it('a failure has a code and no results; a success has a result count', async () => {
    expect(await insert({ status: 'FAILED', result_count: null })).toMatch(/check/);
    expect(await insert({ error_code: 'timeout' })).toMatch(/check/);
    expect(await insert({ result_count: null })).toMatch(/check/);
    expect(await insert({ status: 'FAILED', error_code: 'timeout', result_count: null })).toBeNull();
  });

  it('refuses anything that looks like a credential in its metadata, detail or reference', async () => {
    expect(await insert({ meta: JSON.stringify({ api_key: 'x' }) })).toMatch(/SECRET/);
    expect(await insert({ request_ref: 'Bearer abcdefghijklmnopqrstuvwxyz' })).toMatch(/SECRET/);
    expect(await insert({ status: 'FAILED', error_code: 'auth', result_count: null, error_detail: 'used sk-abcdefghijklmnop' })).toMatch(/SECRET/);
  });

  it('cannot cross workspaces: not through a run, nor a connection, nor a source', async () => {
    const theirRun = await runFor();
    const theirConn = await connection();
    const { id: theirOp } = await one<{ id: string }>(db(), ...base({ search_run_id: theirRun }));
    await enterNewWorkspace(db(), 'other');
    expect(await insert({ search_run_id: theirRun })).toMatch(/WORKSPACE/);
    expect(await insert({ transport: 'live', provider_connection_id: theirConn, billed_to: 'WORKSPACE' })).toMatch(/WORKSPACE/);
    const myBiz = await one<{ id: string }>(db(), `INSERT INTO businesses (name) VALUES ('Mine') RETURNING id`);
    expect(await failure(db(), `INSERT INTO sources (business_id, kind, ref, provider, provider_operation_id) VALUES ($1, 'api', 'x', 'clay', $2)`,
      [myBiz.id, theirOp])).toMatch(/WORKSPACE/);
  });
});

describe('source provenance guards', () => {
  it('a source cites only a successful operation of the same provider and run, and its provenance never changes', async () => {
    const runId = await runFor();
    const otherRun = await runFor({ name: 'Other run' });
    const biz = await one<{ id: string }>(db(), `INSERT INTO businesses (name) VALUES ('Clinic') RETURNING id`);
    const op = (status: string, run: string) => one<{ id: string }>(db(), `INSERT INTO provider_operations (provider, capability, operation, transport,
        request_sha256, status, error_code, attempts, started_at, completed_at, latency_ms, result_count, cost_basis, search_run_id)
      VALUES ('clay', 'business_discovery', 'search', 'recorded', repeat('b', 64), $1, CASE WHEN $1 = 'FAILED' THEN 'timeout' END, 1, now(), now(), 5,
              CASE WHEN $1 = 'SUCCEEDED' THEN 1 END, 'NOT_REPORTED', $2) RETURNING id`, [status, run]);
    const good = (await op('SUCCEEDED', runId)).id;
    const src = (opId: string, provider = 'clay', run = runId) => failure(db(),
      `INSERT INTO sources (business_id, kind, ref, provider, search_run_id, provider_operation_id, provider_record) VALUES ($1, 'api', 'company:1', $2, $3, $4, '{"name":"Clinic"}')`,
      [biz.id, provider, run, opId]);
    expect(await src((await op('FAILED', runId)).id)).toMatch(/failed call found nothing/);
    expect(await src(good, 'other')).toMatch(/is clay, not other/);
    expect(await src(good, 'clay', otherRun)).toMatch(/another run/);
    expect(await src(good)).toBeNull();
    const { id } = await one<{ id: string }>(db(), 'SELECT id FROM sources WHERE provider_operation_id = $1', [good]);
    expect(await failure(db(), `UPDATE sources SET provider_record = '{"name":"Changed"}' WHERE id = $1`, [id])).toMatch(/cannot change/);
    expect(await failure(db(), `INSERT INTO sources (business_id, kind, ref, provider_record) VALUES ($1, 'api', 'x', '{"access_token":"x"}')`, [biz.id])).toMatch(/SECRET/);
  });
});

describe('gateway', () => {
  it('normalizes thrown errors and records latency and attempts for a non-retryable failure once', async () => {
    let calls = 0;
    const out = await callProvider(db(), { provider: 'clay', capability: 'business_discovery', operation: 'search', transport: 'recorded', credential: null, request: { a: 1 } },
      async () => { calls += 1; throw new ProviderError('invalid_request', 'bad'); }, { sleep: noSleep });
    expect(calls).toBe(1);
    expect(out.result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    const timeouts = await callProvider(db(), { provider: 'clay', capability: 'business_discovery', operation: 'search', transport: 'recorded', credential: null, request: { a: 1 } },
      async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, { sleep: noSleep, maxAttempts: 2 });
    expect(timeouts).toMatchObject({ attempts: 2, result: { ok: false, error: { code: 'timeout' } } });
    expect((await db().query('SELECT error_code, attempts FROM provider_operations ORDER BY id')).rows).toEqual([
      { error_code: 'invalid_request', attempts: 1 }, { error_code: 'timeout', attempts: 2 }]);
  });
});


