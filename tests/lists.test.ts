// P3, Analyse a website: a list a person typed or imported from a CSV goes into the existing
// SELECT → ANALYSE → OPPORTUNITY → CASE FILE pipeline with no provider, no enrichment and no
// invented facts. Unknowns go to review; workspace isolation, duplicate handling, suppression and
// SSRF refusals are preserved.
import { describe, expect, it } from 'vitest';
import { COMPANY_REGISTERS, createList, csvEntries, listInputFromBody, normaliseCompanyNumber, normaliseDomain, parseCsv } from '../src/lists/index.js';
import { CLINIC, TableProbe } from './analysis-helpers.js';
import { asApp, enterNewWorkspace, failure, one, useDb, useWorkspace } from './helpers.js';
import { useServer } from './server-helpers.js';

const { db } = useDb();
const start = useServer(db);
const count = async (table: string, where = 'true', params: unknown[] = []) =>
  Number((await one<{ n: string }>(db(), `SELECT count(*) AS n FROM scopely.${table} WHERE ${where}`, params)).n);

describe('domains', () => {
  it('reduces what a person typed to the host Scopely may request', () => {
    expect(normaliseDomain('Clinic.co.uk')).toEqual({ domain: 'clinic.co.uk', websiteUrl: null });
    expect(normaliseDomain('https://www.Clinic.co.uk/')).toEqual({ domain: 'clinic.co.uk', websiteUrl: 'https://www.clinic.co.uk' });
    expect(normaliseDomain('http://clinic.co.uk/aesthetics/')).toEqual({ domain: 'clinic.co.uk', websiteUrl: 'https://clinic.co.uk/aesthetics/' });
    expect(normaliseDomain(' clinic.co.uk. ')).toEqual({ domain: 'clinic.co.uk', websiteUrl: null });
    expect(normaliseDomain('www.co.uk').domain).toBe('co.uk');
    expect(normaliseDomain('bücher.example'.normalize()).domain).toBe('xn--bcher-kva.example');
  });

  it('refuses malformed addresses and anything that is not a public DNS name (SSRF)', () => {
    for (const bad of ['not a domain', 'clinic', 'http://', 'ftp://clinic.co.uk', 'javascript:alert(1)', 'https://user:pw@clinic.co.uk',
      'clinic.co.uk:8443', 'localhost', 'app.localhost', 'printer.local', 'metadata.google.internal', '127.0.0.1', '169.254.169.254',
      'http://[::1]/', '10.0.0.1', 'clinic..co.uk', '-clinic.co.uk', 'clinic.c0m', 'a'.repeat(301), 'clinic.co.uk\u0000']) {
      expect(() => normaliseDomain(bad), bad).toThrow();
    }
  });
});

describe('company numbers', () => {
  it('records a number only with its register, in the register’s format', () => {
    expect(COMPANY_REGISTERS).toEqual(['uk_companies_house']);
    expect(normaliseCompanyNumber('1234567', 'uk_companies_house')).toBe('01234567');
    expect(normaliseCompanyNumber('sc 123456', 'uk_companies_house')).toBe('SC123456');
    for (const bad of ['123456789', 'ABC12345', '12-34', 'S1234567']) expect(() => normaliseCompanyNumber(bad, 'uk_companies_house'), bad).toThrow();
  });
});

describe('CSV', () => {
  it('parses quotes, doubled quotes, embedded commas and newlines, CRLF and a byte-order mark', () => {
    expect(parseCsv('﻿name,domain\r\n"Smith, Jones & Co","a.co.uk"\r\n"Say ""hi""\nClinic",b.co.uk\n\n')).toEqual([
      ['name', 'domain'], ['Smith, Jones & Co', 'a.co.uk'], ['Say "hi"\nClinic', 'b.co.uk']]);
    expect(() => parseCsv('name,domain\n"open,a.co.uk')).toThrow(/never closed/);
  });

  it('reads columns by header in any order, ignores others and says so', () => {
    const r = csvEntries('Domain,Notes,Business Name,Company_Number\nA.co.uk,call back,Alpha,123\n');
    expect(r.rows).toEqual([{ row: 2, name: 'Alpha', domain: 'A.co.uk', companyNumber: '123' }]);
    expect(r.ignoredColumns).toEqual(['Notes']);
    expect(() => csvEntries('business,website\nx,y')).not.toThrow();
    expect(() => csvEntries('name,phone\nx,1')).toThrow(/domain column/);
    expect(() => csvEntries('name,domain\n')).toThrow(/no businesses/);
    expect(() => csvEntries(`name,domain\n${'a,a.co.uk\n'.repeat(201)}`)).toThrow(/up to 200/);
  });

  it('reports every bad row at once and accepts none of them', () => {
    let err: { message: string; rows: unknown[] } | null = null;
    try {
      listInputFromBody({ name: 'L', csv: 'name,domain,company number\n,a.co.uk,\nBeta,localhost,\nGamma,c.co.uk,12345678\n' });
    } catch (e) { err = e as never; }
    expect(err!.message).toMatch(/3 rows need fixing before anything is imported/);
    expect(err!.rows).toEqual([
      { row: 2, field: 'name', problem: 'Business name is missing.' },
      { row: 3, field: 'domain', problem: expect.stringMatching(/^Domain .*public/) },
      { row: 4, field: 'companyNumber', problem: 'Say which register the company numbers are from.' },
    ]);
    expect(() => listInputFromBody({ name: 'L', entries: [] })).toThrow(/at least one/);
    expect(() => listInputFromBody({ name: 'L', entries: [{ name: 'a', domain: 'a.co.uk' }], csv: 'x' })).toThrow(/either/);
    expect(() => listInputFromBody({ name: '', entries: [{ name: 'a' }] })).toThrow(/name/);
    expect(() => listInputFromBody({ name: 'L', companyRegister: 'opencorporates', entries: [{ name: 'a' }] })).toThrow(/Companies House/);
  });
});

describe('POST /api/lists', () => {
  it('a typed entry goes SELECT → ANALYSE → OPPORTUNITY → CASE FILE with no provider call', async () => {
    const probe = new TableProbe({ 'https://harbourclinic.test/': { html: CLINIC } });
    const srv = await start({ probe });
    const opsBefore = await count('provider_operations');
    const r = await srv.call('POST', '/api/lists', { name: 'Clinics', entries: [{ name: 'Harbour Clinic', domain: 'HarbourClinic.test' }] });
    expect(r.status).toBe(200);
    const out = r.json();
    expect(out).toMatchObject({ source: 'manual', counts: { rows: 1, businesses: 1, new: 1, qualified: 1, needsReview: 0 },
      rows: [{ row: 1, outcome: 'new', state: 'QUALIFIED' }] });
    const bid = out.rows[0].businessId;

    // Workspace-owned, from a person, and nothing the person did not type.
    const b = await one<Record<string, unknown>>(db(), 'SELECT * FROM scopely.businesses WHERE id = $1', [bid]);
    expect(b).toMatchObject({ name: 'Harbour Clinic', domain: 'harbourclinic.test', website_url: null, workspace_id: srv.workspaceId, website_status: 'UNKNOWN' });
    for (const k of ['vertical', 'city', 'country_code', 'employee_count', 'revenue_amount', 'independence', 'phone', 'company_number']) expect(b[k], k).toBeNull();
    expect(await one(db(), 'SELECT kind, provider, provider_operation_id FROM scopely.sources WHERE business_id = $1', [bid]))
      .toEqual({ kind: 'manual', provider: 'manual', provider_operation_id: null });
    expect(await count('contacts', 'business_id = $1', [bid])).toBe(0);
    const rb = await one<{ rule_key: string }>(db(), `SELECT rv.rule_key FROM scopely.search_run_businesses rb
      JOIN scopely.rule_versions rv ON rv.id = rb.qualification_rule_version_id WHERE rb.business_id = $1`, [bid]);
    expect(rb.rule_key).toBe('qualify.list_entry');

    // The existing pipeline, unchanged.
    const run = await srv.call('GET', `/api/runs/${out.searchRunId}`);
    expect(run.json()).toMatchObject({ searchName: 'Clinics', operations: [], businesses: [{ businessId: bid, provenance: { provider: 'manual', basis: 'RECORDED_BY_PERSON' } }] });
    expect((await srv.call('POST', `/api/runs/${out.searchRunId}/select`, { businessIds: [bid], selectedBy: 'Seller' })).status).toBe(200);
    const a = await srv.call('POST', `/api/runs/${out.searchRunId}/businesses/${bid}/analyze`, { requestedBy: 'Seller' });
    expect(a.json()).toMatchObject({ state: 'OPPORTUNITY_FOUND', analysis: { outcome: 'CHECKED' } });
    expect(a.json().analysis.findings.every((f: { claimState: string }) => f.claimState === 'OBSERVED')).toBe(true);
    const cf = await srv.call('GET', `/api/opportunities/${a.json().opportunityIds[0]}`);
    expect(cf.status).toBe(200);
    expect(await count('provider_operations')).toBe(opsBefore);
    expect(probe.calls.map((c) => c.url)).toEqual(['https://harbourclinic.test/']);
    // Logs name ids and counts, never the business or its domain.
    expect(srv.logged.join('\n')).toMatch(/^list \d+ run \d+ manual rows=1 new=1 existing=0 repeats=0 review=0$/m);
    expect(srv.logged.join('\n')).not.toMatch(/harbour/i);
  });

  it('a CSV: repeats in the file, businesses already held, unknowns to review, suppression kept', async () => {
    const srv = await start();
    const held = (await srv.call('POST', '/api/lists', { name: 'Earlier', entries: [{ name: 'Old Name Clinic', domain: 'held.test' }] })).json();
    await db().query(`INSERT INTO scopely.suppression (domain, reason) VALUES ('blocked.test', 'opt_out')`);
    const csv = [
      'name,domain,company number',
      'Alpha Aesthetics,alpha.test,1234567',
      'Alpha again,https://www.alpha.test/,',
      'New Name Clinic,HELD.test,',
      'No Site Clinic,,',
      'Blocked Clinic,blocked.test,',
      'Number Twin,beta.test,01234567',
    ].join('\n');
    const r = await srv.call('POST', '/api/lists', { name: 'Validation', csv, companyRegister: 'uk_companies_house' });
    expect(r.status).toBe(200);
    const out = r.json();
    expect(out.source).toBe('csv_import');
    const byRow = Object.fromEntries(out.rows.map((x: { row: number }) => [x.row, x]));
    expect(byRow[2]).toMatchObject({ outcome: 'new', state: 'QUALIFIED' });
    expect(byRow[3]).toMatchObject({ outcome: 'repeat', businessId: byRow[2].businessId, matchedBy: 'domain' });
    expect(byRow[4]).toMatchObject({ outcome: 'existing', businessId: held.rows[0].businessId, matchedBy: 'domain', nameKept: 'Old Name Clinic' });
    expect(byRow[5]).toMatchObject({ outcome: 'new', state: 'NEEDS_REVIEW' });
    expect(byRow[6]).toMatchObject({ outcome: 'new', state: 'REJECTED' });
    // Same company number (zero-padded) is the same business, whatever its domain says.
    expect(byRow[7]).toMatchObject({ outcome: 'repeat', businessId: byRow[2].businessId, matchedBy: 'company_register' });
    expect(out.counts).toMatchObject({ rows: 6, businesses: 4, new: 3, existing: 1, repeats: 2, qualified: 2, needsReview: 1, rejected: 1 });
    // A held business keeps its own name; the row's name is not written over it.
    expect((await one<{ name: string }>(db(), 'SELECT name FROM scopely.businesses WHERE id = $1', [held.rows[0].businessId])).name).toBe('Old Name Clinic');
    expect((await one<{ company_number: string; company_register: string }>(db(), 'SELECT company_number, company_register FROM scopely.businesses WHERE id = $1',
      [byRow[2].businessId]))).toEqual({ company_number: '01234567', company_register: 'uk_companies_house' });
    const view = (await srv.call('GET', `/api/runs/${out.searchRunId}`)).json();
    const noSite = view.businesses.find((b: { businessId: string }) => b.businessId === byRow[5].businessId);
    expect(noSite).toMatchObject({ state: 'NEEDS_REVIEW', unknownStages: ['online_presence'] });
    expect(noSite.qualification).toContainEqual(expect.objectContaining({ criterion: 'website_address', verdict: 'unknown' }));
    const blocked = view.businesses.find((b: { businessId: string }) => b.businessId === byRow[6].businessId);
    expect(blocked).toMatchObject({ state: 'REJECTED', failedStage: 'exclusions' });
    // Only qualified businesses can be selected; review and rejected ones are refused in plain words.
    const sel = await srv.call('POST', `/api/runs/${out.searchRunId}/select`, { businessIds: [byRow[5].businessId], selectedBy: 'Seller' });
    expect(sel.status).toBe(422);
    expect(await count('sources', `kind = 'csv_import'`)).toBe(6);
  });

  it('refuses a malformed list with every row problem and creates nothing', async () => {
    const srv = await start();
    const before = [await count('searches'), await count('businesses'), await count('sources')];
    const r = await srv.call('POST', '/api/lists', { name: 'Bad', csv: 'name,domain\nGood,good.test\nBad,http://10.0.0.1/\nAlso bad,not a domain\n' });
    expect(r.status).toBe(422);
    expect(r.json().rows.map((p: { row: number }) => p.row)).toEqual([3, 4]);
    expect([await count('searches'), await count('businesses'), await count('sources')]).toEqual(before);
    expect((await srv.call('POST', '/api/lists', { name: 'x', csv: 42 })).status).toBe(422);
  });

  it('a list is never run against a provider', async () => {
    const srv = await start();
    const out = (await srv.call('POST', '/api/lists', { name: 'L', entries: [{ name: 'A', domain: 'a.test' }] })).json();
    const r = await srv.call('POST', `/api/searches/${out.listId}/runs`, { provider: 'clay' });
    expect(r.status).toBe(422);
    expect(r.json().error).toMatch(/not run against a provider/);
    const d = (await srv.call('GET', '/api/discovery')).json();
    expect(d.searches.find((s: { searchId: string }) => s.searchId === out.listId)).toMatchObject({ kind: 'list' });
  });

  it('keeps workspaces apart: another workspace cannot read the list, and its own import never reuses this one’s business', async () => {
    const mine = await start();
    const out = (await mine.call('POST', '/api/lists', { name: 'Mine', entries: [{ name: 'Shared Domain Clinic', domain: 'shared.test' }] })).json();
    const ws = mine.workspaceId;
    const other = await enterNewWorkspace(db(), 'other');
    const theirs = await start({ workspaceId: other });
    expect((await theirs.call('GET', `/api/runs/${out.searchRunId}`)).status).toBe(404);
    expect((await theirs.call('POST', `/api/runs/${out.searchRunId}/select`, { businessIds: [out.rows[0].businessId], selectedBy: 'x' })).status).toBe(404);
    expect((await theirs.call('POST', `/api/searches/${out.listId}/runs`, { provider: 'clay' })).status).toBe(404);
    const t = (await theirs.call('POST', '/api/lists', { name: 'Theirs', entries: [{ name: 'Shared Domain Clinic', domain: 'shared.test' }] })).json();
    expect(t.rows[0]).toMatchObject({ outcome: 'new' });
    expect(t.rows[0].businessId).not.toBe(out.rows[0].businessId);
    // Under RLS as the application role, each workspace sees only its own list rows.
    const seen = await asApp(db(), other, async () => (await db().query(`SELECT id FROM scopely.searches WHERE kind = 'list'`)).rows.map((r) => String(r.id)));
    expect(seen).toEqual([t.listId]);
    await useWorkspace(db(), ws);
  });
});

describe('list guards in the database', () => {
  it('a list has one run, no provider operation, only person-made sources, and stays a list', async () => {
    await enterNewWorkspace(db(), 'guards');
    const input = listInputFromBody({ name: 'G', entries: [{ name: 'A', domain: 'a.test' }] });
    const out = await createList(db(), input);
    expect(await failure(db(), `INSERT INTO scopely.search_runs (search_id, criteria) VALUES ($1, '{}')`, [out.listId])).toMatch(/already has its run/);
    expect(await failure(db(), `INSERT INTO scopely.provider_operations (provider, capability, operation, transport, search_run_id, request_sha256, status, result_count, attempts, started_at, completed_at, latency_ms, cost_basis)
      VALUES ('clay', 'business_discovery', 'company_search', 'recorded', $1, repeat('a', 64), 'SUCCEEDED', 0, 1, now(), now(), 1, 'NOT_REPORTED')`, [out.searchRunId])).toMatch(/never calls a provider/);
    expect(await failure(db(), `INSERT INTO scopely.sources (business_id, kind, ref, provider, search_run_id) VALUES ($1, 'clay_search', 'x', 'clay', $2)`,
      [out.rows[0]!.businessId, out.searchRunId])).toMatch(/comes from a person/);
    expect(await failure(db(), `UPDATE scopely.searches SET kind = 'search' WHERE id = $1`, [out.listId])).toMatch(/cannot become a list or stop/);
    const search = await one<{ id: string }>(db(), `INSERT INTO scopely.searches (name) VALUES ('s') RETURNING id`);
    expect(await failure(db(), `UPDATE scopely.searches SET kind = 'list' WHERE id = $1`, [search.id])).toMatch(/cannot become a list/);
  });
});
