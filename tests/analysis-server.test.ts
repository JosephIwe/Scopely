// Slice 11: the Find screen's analysis routes. A seller analyses one selected business at a time,
// reads what Scopely observed, and opens the opportunity's Case File. The routes act only in the
// server's workspace, refuse cross-site writes, and never return the page Scopely read.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createHandler } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { CLINIC, TableProbe, runBusiness, seedRun } from './analysis-helpers.js';
import { StubFetcher } from './fix-helpers.js';
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

async function start(probe: TableProbe, workspaceId?: string) {
  const ws = workspaceId ?? (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
  const logged: string[] = [];
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY,
    fetcher: new StubFetcher(), probe, editLinkTtlSeconds: 900, showLinkTtlSeconds: 3600, log: (l: string) => { logged.push(l); } });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = { 'x-scopely-request': '1' }) => {
    const r = await fetch(base + p, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  return { call, logged };
}

describe('analysing from the Find screen', () => {
  it('analyses a selected business, returns what it observed and the opportunity, and stays idempotent', async () => {
    const { runId } = await seedRun(db());
    const b = await runBusiness(db(), runId, { domain: 'harbourclinic.test' });
    const probe = new TableProbe({ 'https://harbourclinic.test/': { html: CLINIC } });
    const srv = await start(probe);
    const r = await srv.call('POST', `/api/runs/${runId}/businesses/${b}/analyze`, { requestedBy: 'Seller' });
    expect(r.status).toBe(200);
    const out = r.json();
    expect(out).toMatchObject({ analysedNow: true, state: 'OPPORTUNITY_FOUND', analysis: { outcome: 'CHECKED', requestedBy: 'Seller', cost: { basis: 'NOT_REPORTED' } } });
    expect(out.analysis.findings).toHaveLength(4);
    expect(out.analysis.opportunities).toEqual([expect.objectContaining({ opportunityId: out.opportunityIds[0], path: 'FIX', kind: 'website_fix' })]);
    // The page is never sent back, and the log names ids, not addresses or content.
    expect(r.text).not.toContain('<form');
    expect(r.text).not.toContain('Welcome to our clinic');
    expect(srv.logged.join('\n')).not.toMatch(/harbourclinic|WhatsApp/);

    const again = await srv.call('POST', `/api/runs/${runId}/businesses/${b}/analyze`, { requestedBy: 'Seller' });
    expect(again.json()).toMatchObject({ analysedNow: false, analysisId: out.analysisId, opportunityIds: out.opportunityIds });
    expect(probe.calls).toHaveLength(1);

    const view = await srv.call('GET', `/api/runs/${runId}/businesses/${b}/analysis`);
    expect(view.json().analysisId).toBe(out.analysisId);
    const run = await srv.call('GET', `/api/runs/${runId}`);
    expect(run.json().businesses[0].analysis).toMatchObject({ outcome: 'CHECKED', opportunityIds: out.opportunityIds });
    const cf = await srv.call('GET', `/api/opportunities/${out.opportunityIds[0]}`);
    expect(cf.status).toBe(200);
    expect(cf.json()).toMatchObject({ path: 'FIX', build: { builder: 'fix', canStart: true } });
  });

  it('refuses in the seller’s words, refuses cross-site writes, and never reaches another workspace', async () => {
    const { runId } = await seedRun(db());
    const qualified = await runBusiness(db(), runId, { domain: 'q.test' }, 'QUALIFIED');
    const selected = await runBusiness(db(), runId, { domain: 'harbourclinic.test' });
    const probe = new TableProbe({ 'https://harbourclinic.test/': { html: CLINIC } });
    const srv = await start(probe);
    const no = await srv.call('POST', `/api/runs/${runId}/businesses/${qualified}/analyze`, { requestedBy: 'Seller' });
    expect(no).toMatchObject({ status: 422 });
    expect(no.json().error).toBe('Only a business you selected for analysis can be analysed.');
    expect((await srv.call('POST', `/api/runs/${runId}/businesses/${selected}/analyze`, { requestedBy: '' })).json().error).toBe('Say who is asking for this analysis.');
    expect((await srv.call('POST', `/api/runs/${runId}/businesses/${selected}/analyze`, { requestedBy: 'Seller' }, {})).status).toBe(403);
    expect((await srv.call('POST', `/api/runs/${runId}/businesses/${selected}/analyze`, { requestedBy: 'Seller' },
      { 'x-scopely-request': '1', origin: 'https://evil.test' })).status).toBe(403);
    expect((await srv.call('GET', `/api/runs/${runId}/businesses/${selected}/analysis`)).status).toBe(404);
    expect((await srv.call('POST', `/api/runs/abc/businesses/${selected}/analyze`, { requestedBy: 'Seller' })).status).toBe(404);
    expect(probe.calls).toHaveLength(0);
    server!.close();

    // Another workspace's server cannot analyse or read this run.
    const other = await enterNewWorkspace(db(), 'other');
    const srv2 = await start(probe, other);
    expect((await srv2.call('POST', `/api/runs/${runId}/businesses/${selected}/analyze`, { requestedBy: 'Seller' })).status).toBe(404);
    expect((await srv2.call('GET', `/api/runs/${runId}/businesses/${selected}/analysis`)).status).toBe(404);
    expect(probe.calls).toHaveLength(0);
  });
});
