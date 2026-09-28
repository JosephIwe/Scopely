// Slice 5: the Build Workspace HTTP surface. Writes need the app's own header and origin, the
// screen never carries storage keys or hashes, and preview links open only the version and kind
// they were signed for.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_HEADERS, DEFAULT_SHOW_LINK_TTL_SECONDS, NO_BUTTON_DESTINATION, signPreview } from '../src/build/site/index.js';
import { createHandler } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { enterNewWorkspace, one, useDb, useWorkspace } from './helpers.js';
import { SIGNING_KEY, confirmRecheck, seedWebsiteOpportunity } from './site-helpers.js';

const { db } = useDb();

/** A pool over the test's own transaction: the server's BEGIN/COMMIT become a savepoint, so the test still rolls everything back. */
function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = {
    BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv',
  };
  const conn = {
    query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params),
    release: () => undefined,
  };
  return { connect: async () => conn } as unknown as pg.Pool;
}

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function start(workspaceId: string, store = new MemoryObjectStore()) {
  const handler = createHandler({ pool: poolOver(db()), store, workspaceId, signingKey: SIGNING_KEY,
    editLinkTtlSeconds: 900, showLinkTtlSeconds: DEFAULT_SHOW_LINK_TTL_SECONDS, log: () => undefined });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-scopely-request': '1' }) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) };
  };
  return { base, call };
}

async function generated() {
  const seed = await seedWebsiteOpportunity(db(), { reviews: true });
  const workspaceId = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
  const srv = await start(workspaceId);
  const { projectId } = (await srv.call('POST', `/api/opportunities/${seed.opportunityId}/website`)).json();
  const run = (await srv.call('POST', `/api/projects/${projectId}/generate`, { templateKey: 'meridian' })).json();
  expect(run.status).toBe('SUCCEEDED');
  return { ...srv, seed, projectId, buildId: String(run.buildId), workspaceId };
}

describe('Build Workspace server', () => {
  it('refuses writes without the app header, from another origin, or from a sandboxed frame', async () => {
    const { projectId, call } = await generated();
    const path = `/api/projects/${projectId}/generate`;
    expect((await call('POST', path, { templateKey: 'meridian' }, {})).status).toBe(403);
    expect((await call('POST', path, { templateKey: 'meridian' }, { 'x-scopely-request': '1', origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('POST', path, { templateKey: 'meridian' }, { 'x-scopely-request': '1', origin: 'null' })).status).toBe(403);
    expect((await call('GET', '/api/opportunities', undefined, {})).status).toBe(200);
  });

  it('serves the app with a strict content policy and a workspace screen with no storage keys or hashes', async () => {
    const { projectId, call } = await generated();
    const page = await call('GET', '/');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const view = await call('GET', `/api/projects/${projectId}/workspace`);
    expect(view.status).toBe(200);
    const text = view.text.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, '');
    expect(text).not.toMatch(/workspaces\//);
    expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(text).not.toMatch(/secretref:|sk-[A-Za-z0-9]/);
    expect(view.json().current.status).toBe('DRAFT');
  });

  it('opens a preview link only for the version, kind and workspace it was signed for', async () => {
    const { projectId, buildId, workspaceId, call } = await generated();
    const edit = (await call('POST', `/api/projects/${projectId}/versions/${buildId}/link`, { kind: 'edit' })).json();
    const art = await call('GET', edit.url);
    expect(art.status).toBe(200);
    expect(art.headers.get('content-security-policy')).toBe(ARTIFACT_HEADERS['content-security-policy']);
    expect(art.text).toContain('<!doctype html>');
    // A draft cannot be shared with a prospect, and an edit link is not a share page.
    expect((await call('POST', `/api/projects/${projectId}/versions/${buildId}/link`, { kind: 'show' })).status).toBeGreaterThanOrEqual(400);
    expect((await call('GET', edit.url.replace('/p/', '/s/'))).status).toBe(404);
    // Tampered, and signed for another workspace.
    const token = edit.url.slice(3);
    expect((await call('GET', `/p/${token.slice(0, -2)}xx`)).status).toBe(404);
    const other = await enterNewWorkspace(db(), 'other');
    await useWorkspace(db(), workspaceId);
    const forged = signPreview(SIGNING_KEY, { w: other, p: projectId, b: buildId, k: 'edit', e: Math.floor(Date.now() / 1000) + 600 });
    expect((await call('GET', `/p/${forged}`)).status).toBe(404);
  });

  it('shows an approved version only once its button has a destination, and hands back a sandboxed share page', async () => {
    const { seed, projectId, buildId, call } = await generated();
    expect((await call('POST', `/api/projects/${projectId}/versions/${buildId}/approve`, { approvedBy: 'Operator' })).status).toBe(200);
    // A14: approved, but the button goes nowhere, so it cannot be shown.
    const noButton = await call('POST', `/api/projects/${projectId}/versions/${buildId}/show`);
    expect(noButton.status).toBe(409);
    expect(noButton.json().error).toBe(NO_BUTTON_DESTINATION);
    const v2 = String((await call('POST', `/api/projects/${projectId}/save`, { baseBuildId: buildId,
      operations: [{ op: 'update_cta', action: { kind: 'whatsapp', value: '447700900123' } }] })).json().buildId);
    expect((await call('POST', `/api/projects/${projectId}/versions/${v2}/approve`, { approvedBy: 'Operator' })).status).toBe(200);
    // PR4's gate still holds over HTTP: HIGH evidence needs a confirmed re-check first.
    const early = await call('POST', `/api/projects/${projectId}/versions/${v2}/show`);
    expect(early.status).toBe(409);
    expect(early.json().error).toMatch(/re-?check/i);
    await confirmRecheck(db(), seed, new Date(Date.now() - 60_000).toISOString());
    const shown = await call('POST', `/api/projects/${projectId}/versions/${v2}/show`);
    expect(shown.status).toBe(200);
    const share = await call('GET', shown.json().url);
    expect(share.status).toBe(200);
    expect(share.text).toContain('not a live website');
    expect(share.text).toMatch(/<iframe[^>]+sandbox="allow-popups allow-popups-to-escape-sandbox"/);
    expect(share.text).not.toMatch(/allow-scripts|allow-same-origin/);
    expect((await call('GET', shown.json().url.replace('/s/', '/p/'))).text).toContain('https://wa.me/447700900123');
  });

  it('revokes a prospect link at once, without touching the version (A15)', async () => {
    const { seed, projectId, buildId, call } = await generated();
    const v2 = String((await call('POST', `/api/projects/${projectId}/save`, { baseBuildId: buildId,
      operations: [{ op: 'update_cta', action: { kind: 'phone', value: '+442079460000' } }] })).json().buildId);
    await call('POST', `/api/projects/${projectId}/versions/${v2}/approve`, { approvedBy: 'Operator' });
    await confirmRecheck(db(), seed, new Date(Date.now() - 60_000).toISOString());
    const shown = (await call('POST', `/api/projects/${projectId}/versions/${v2}/show`)).json();
    expect(Date.parse(shown.expiresAt) - Date.now()).toBeGreaterThan(72 * 3600_000 - 60_000);
    const [link] = (await call('GET', `/api/projects/${projectId}/workspace`)).json().links;
    expect(link).toMatchObject({ state: 'ACTIVE', versionNo: 2, url: shown.url });
    const path = `/api/projects/${projectId}/links/${link.linkId}/revoke`;
    expect((await call('POST', path, { revokedBy: 'Operator' }, { 'x-scopely-request': '1', origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('POST', path, { revokedBy: 'Operator' })).status).toBe(200);
    expect((await call('GET', shown.url)).status).toBe(404);
    expect((await call('GET', shown.url.replace('/s/', '/p/'))).status).toBe(404);
    const view = (await call('GET', `/api/projects/${projectId}/workspace`)).json();
    expect(view.links[0]).toMatchObject({ state: 'REVOKED', url: null, revokedBy: 'Operator' });
    expect(view.current).toMatchObject({ buildId: v2, status: 'SHOWN' });
    // A new link for the same version works; the revoked one stays revoked.
    const fresh = (await call('POST', `/api/projects/${projectId}/versions/${v2}/link`, { kind: 'show' })).json();
    expect((await call('GET', fresh.url)).status).toBe(200);
    expect((await call('GET', shown.url)).status).toBe(404);
  });

  it('answers an unexpected failure without detail', async () => {
    const { call } = await generated();
    const r = await call('POST', '/api/projects/1/save', { baseBuildId: 'x', operations: [] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toMatch(/at \w+ \(|scopely\.|SELECT|relation/);
  });
});
