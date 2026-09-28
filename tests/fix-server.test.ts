// Slice 7: the Fix Builder over HTTP. The same write rules as the website path, a screen with no
// storage keys or hashes, the seller's before/after copies only through an edit link, and the
// prospect's page only once a person confirmed the corrected destination.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_HEADERS, DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { createHandler } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { PAGE, StubFetcher, seedFixOpportunity } from './fix-helpers.js';
import { enterNewWorkspace, one, useDb, useWorkspace } from './helpers.js';
import { SIGNING_KEY, confirmRecheck } from './site-helpers.js';

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

async function start(workspaceId: string, fetcher = new StubFetcher()) {
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId, signingKey: SIGNING_KEY, fetcher,
    editLinkTtlSeconds: 900, showLinkTtlSeconds: DEFAULT_SHOW_LINK_TTL_SECONDS, log: () => undefined });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-scopely-request': '1' }) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) };
  };
  return { call, fetcher };
}

/** Opened, captured, a corrected value typed and the fix built, all over HTTP. */
async function built() {
  const seed = await seedFixOpportunity(db());
  const workspaceId = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
  const srv = await start(workspaceId);
  const opps = (await srv.call('GET', '/api/opportunities')).json();
  expect(opps.find((o: { opportunityId: string }) => o.opportunityId === seed.opportunityId)).toMatchObject({ fixable: true, fixProjectId: null, buildable: false });
  const { projectId } = (await srv.call('POST', `/api/opportunities/${seed.opportunityId}/fix`)).json();
  expect((await srv.call('POST', `/api/fix/${projectId}/capture`, { evidenceId: seed.evidenceId })).status).toBe(200);
  expect((await srv.call('POST', `/api/fix/${projectId}/corrections`, { evidenceId: seed.evidenceId, channel: 'whatsapp', value: '+44 7700 900123' })).status).toBe(200);
  const run = (await srv.call('POST', `/api/fix/${projectId}/generate`)).json();
  expect(run.status).toBe('SUCCEEDED');
  return { ...srv, seed, projectId, buildId: String(run.buildId), workspaceId };
}

describe('Fix Builder server', () => {
  it('refuses writes without the app header or from another origin', async () => {
    const { projectId, seed, call } = await built();
    const path = `/api/fix/${projectId}/corrections`;
    const body = { evidenceId: seed.evidenceId, channel: 'whatsapp', value: '+447700900999' };
    expect((await call('POST', path, body, {})).status).toBe(403);
    expect((await call('POST', path, body, { 'x-scopely-request': '1', origin: 'https://evil.test' })).status).toBe(403);
  });

  it('answers the screen without storage keys or hashes, and opens nothing in another workspace', async () => {
    const { projectId, workspaceId, call } = await built();
    const view = await call('GET', `/api/fix/${projectId}`);
    expect(view.status).toBe(200);
    expect(view.text).not.toMatch(/workspaces\//);
    expect(view.text).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(view.json().current).toMatchObject({ status: 'DRAFT', confirmed: false });
    expect(view.json().steps).toMatchObject({ confirm: 'current', show: 'todo' });
    const other = await enterNewWorkspace(db(), 'other');
    const srv2 = await start(other);
    expect((await srv2.call('GET', `/api/fix/${projectId}`)).status).toBe(404);
    expect((await srv2.call('POST', `/api/fix/${projectId}/generate`)).status).toBe(404);
    await useWorkspace(db(), workspaceId);
  });

  it('serves the before and after copies only through an edit link, under the artifact policy', async () => {
    const { projectId, buildId, call } = await built();
    const edit = (await call('POST', `/api/fix/${projectId}/versions/${buildId}/link`, { kind: 'edit' })).json();
    const before = await call('GET', edit.before);
    const after = await call('GET', edit.after);
    expect(before.status).toBe(200);
    expect(before.headers.get('content-security-policy')).toBe(ARTIFACT_HEADERS['content-security-policy']);
    expect(before.text).toBe(PAGE);
    expect(after.text).toBe(PAGE.replace('class="wa" href="tel:WhatsApp:0800"', 'class="wa" href="https://wa.me/447700900123"')
      .replace("<a href='tel:WhatsApp:0800'>Chat", "<a href='https://wa.me/447700900123'>Chat"));
    // A draft has no share link, and the share path never serves the copies.
    expect((await call('POST', `/api/fix/${projectId}/versions/${buildId}/link`, { kind: 'show' })).status).toBeGreaterThanOrEqual(400);
    expect((await call('GET', edit.before.replace('/p/', '/s/'))).status).toBe(404);
  });

  it('shows the prospect a fix only after a person confirms it, and revokes the link at once', async () => {
    const { seed, projectId, buildId, call } = await built();
    expect((await call('POST', `/api/fix/${projectId}/versions/${buildId}/show`)).status).toBe(409);
    const unticked = await call('POST', `/api/fix/${projectId}/versions/${buildId}/confirm`, { confirmedBy: 'Sam', confirmed: false });
    expect(unticked.status).toBe(400);
    expect((await call('POST', `/api/fix/${projectId}/versions/${buildId}/confirm`, { confirmedBy: 'Sam', confirmed: true })).status).toBe(200);
    // Confirmed and approved, but the HIGH finding still needs its re-check before a prospect sees it.
    expect((await call('POST', `/api/fix/${projectId}/versions/${buildId}/show`)).json().error).toMatch(/re-?check/i);
    await confirmRecheck(db(), seed, new Date(Date.now() - 60_000).toISOString());
    const shown = await call('POST', `/api/fix/${projectId}/versions/${buildId}/show`);
    expect(shown.status).toBe(200);
    const share = await call('GET', shown.json().url);
    expect(share.text).toContain('Proposed fix');
    expect(share.text).toContain('Nothing on your live website has been changed.');
    expect(share.text).not.toMatch(/allow-scripts|allow-same-origin/);
    const art = await call('GET', shown.json().url.replace('/s/', '/p/'));
    expect(art.text).toContain('href="https://wa.me/447700900123"');
    expect(art.text).toContain('<s>tel:WhatsApp:0800</s>');
    const [link] = (await call('GET', `/api/fix/${projectId}`)).json().links;
    expect((await call('POST', `/api/fix/${projectId}/links/${link.linkId}/revoke`, { revokedBy: 'Sam' })).status).toBe(200);
    expect((await call('GET', shown.json().url)).status).toBe(404);
    expect((await call('GET', `/api/fix/${projectId}`)).json().current).toMatchObject({ status: 'SHOWN' });
  });

  it('says plainly when a page cannot be captured, and records nothing', async () => {
    const seed = await seedFixOpportunity(db());
    const workspaceId = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
    const { call } = await start(workspaceId, new StubFetcher(null));
    const { projectId } = (await call('POST', `/api/opportunities/${seed.opportunityId}/fix`)).json();
    const r = await call('POST', `/api/fix/${projectId}/capture`, { evidenceId: seed.evidenceId });
    expect(r.status).toBe(409);
    expect(r.json().error).toMatch(/could not capture the page/);
    expect((await one<{ n: number }>(db(), 'SELECT count(*)::int AS n FROM fix_captures WHERE project_id = $1', [projectId])).n).toBe(0);
  });
});
