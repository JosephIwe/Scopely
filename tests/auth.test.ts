// A40: sign-in, sessions, invites and workspace membership. Every /api request in sign-in mode is
// a signed-in person acting in a workspace they belong to; nothing the browser says about its
// workspace is taken as proof.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type pg from 'pg';
import { afterEach, describe, expect, inject, it } from 'vitest';
import {
  AttemptLimiter, createInvite, hashPassword, passwordProblem, readCookie, resolveSession, tokenHash, verifyPassword,
} from '../src/auth/index.js';
import { createHandler, type ServerConfig } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { enterNewWorkspace, failure, one, useDb, useWorkspace } from './helpers.js';
import { SIGNING_KEY, seedWebsiteOpportunity } from './site-helpers.js';

const { db } = useDb();

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = {
    BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv',
  };
  // SET LOCAL ROLE outlives a released savepoint, so each borrowed connection starts as the owner again.
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => { await client.query('RESET ROLE'); return conn; } } as unknown as pg.Pool;
}

let server: http.Server | null = null;
afterEach(async () => { server?.close(); server = null; await db().query('RESET ROLE').catch(() => undefined); });

async function start(over: Partial<ServerConfig> = {}) {
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), signingKey: SIGNING_KEY, editLinkTtlSeconds: 900, showLinkTtlSeconds: 3600,
    log: () => undefined, auth: { secureCookies: false }, ...over } as ServerConfig);
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** A browser: keeps its cookie between calls. */
  const browser = () => {
    let jar = '';
    const call = async (method: string, p: string, body?: unknown) => {
      const r = await fetch(base + p, { method, headers: { 'x-scopely-request': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(jar ? { cookie: jar } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const set = r.headers.get('set-cookie');
      if (set) jar = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
      const text = await r.text();
      await db().query('RESET ROLE');
      return { status: r.status, headers: r.headers, json: () => JSON.parse(text) as any };
    };
    return { call, cookie: () => jar, setCookie: (c: string) => { jar = c; } };
  };
  return { base, browser };
}

const PW = 'correct horse battery staple';

async function invite(workspaceId: string | null, role: 'owner' | 'admin' | 'member' = 'member', email: string | null = null) {
  return (await createInvite(db(), { workspaceId, role: workspaceId ? role : 'owner', email, createdBy: 'test' })).token;
}

describe('passwords', () => {
  it('hashes with scrypt, salts each hash and verifies in constant time', async () => {
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PW, a)).toBe(true);
    expect(await verifyPassword(`${PW}!`, a)).toBe(false);
    expect(await verifyPassword(PW, 'plain')).toBe(false);
    expect(passwordProblem('short')).toMatch(/12/);
    expect(passwordProblem(PW)).toBeNull();
  });

  it('the database refuses a credential that is not an encoded hash', async () => {
    const u = await one<{ id: string }>(db(), `INSERT INTO users (email) VALUES ('a@x.test') RETURNING id`);
    expect(await failure(db(), `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, 'hunter2hunter2')`, [u.id])).toMatch(/check/i);
    expect(await failure(db(), `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [u.id, await hashPassword(PW)])).toBeNull();
  });
});

describe('sessions and invites in the database', () => {
  it('a session acts only in a workspace its user belongs to, and a revoked one stays revoked', async () => {
    const ws = await enterNewWorkspace(db(), 'a');
    const other = await enterNewWorkspace(db(), 'b');
    const u = await one<{ id: string }>(db(), `INSERT INTO users (email) VALUES ('s@x.test') RETURNING id`);
    await db().query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [ws, u.id]);
    const ins = `INSERT INTO user_sessions (user_id, token_sha256, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id`;
    expect(await failure(db(), ins, [u.id, tokenHash('x'), other])).toMatch(/not a member/);
    const s = await one<{ id: string }>(db(), ins, [u.id, tokenHash('y'), ws]);
    expect(await failure(db(), 'UPDATE user_sessions SET workspace_id = $2 WHERE id = $1', [s.id, other])).toMatch(/not a member/);
    expect(await failure(db(), `UPDATE user_sessions SET token_sha256 = $2 WHERE id = $1`, [s.id, tokenHash('z')])).toMatch(/never change/);
    await db().query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [s.id]);
    expect(await failure(db(), 'UPDATE user_sessions SET revoked_at = NULL WHERE id = $1', [s.id])).toMatch(/cannot be revived/);
  });

  it('an invite is used once and its terms never change; a setup invite always makes an owner', async () => {
    const ws = await enterNewWorkspace(db(), 'a');
    await createInvite(db(), { workspaceId: ws, role: 'member', createdBy: 'test' });
    const i = await one<{ id: string }>(db(), 'SELECT id FROM workspace_invites ORDER BY id DESC LIMIT 1');
    expect(await failure(db(), `UPDATE workspace_invites SET role = 'owner' WHERE id = $1`, [i.id])).toMatch(/terms never change/);
    await db().query('UPDATE workspace_invites SET used_at = now() WHERE id = $1', [i.id]);
    expect(await failure(db(), 'UPDATE workspace_invites SET used_at = NULL WHERE id = $1', [i.id])).toMatch(/already used/);
    expect(await failure(db(), `INSERT INTO workspace_invites (workspace_id, role, token_sha256, created_by, expires_at)
      VALUES (NULL, 'member', $1, 'x', now() + interval '1 day')`, [tokenHash('q')])).toMatch(/check/i);
  });

  it('the application role reads no credential, session or invite', async () => {
    const ws = await enterNewWorkspace(db(), 'a');
    await createInvite(db(), { workspaceId: ws, role: 'member', createdBy: 'test' });
    await db().query(`SET LOCAL ROLE ${inject('appRole')}`);
    try {
      for (const t of ['user_credentials', 'user_sessions', 'workspace_invites']) {
        expect((await db().query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
      }
    } finally { await db().query('RESET ROLE'); }
  });
});

describe('sign-in over HTTP', () => {
  it('signed out, every workspace route is refused and nothing is read', async () => {
    const { browser } = await start();
    const b = browser();
    for (const p of ['/api/opportunities', '/api/workspace', '/api/discovery', '/api/searches', '/api/opportunities/1']) {
      const r = await b.call('GET', p);
      expect(r.status, p).toBe(401);
      expect(r.json().reason).toBe('signed_out');
    }
    expect((await b.call('POST', '/api/searches', { name: 'x' })).status).toBe(401);
    const s = (await b.call('GET', '/api/session')).json();
    expect(s).toEqual({ mode: 'session', signedIn: false, openSignup: false });
    // A cookie that is not a session is the same as none.
    b.setCookie(`scopely_session=${'A'.repeat(43)}`);
    expect((await b.call('GET', '/api/opportunities')).status).toBe(401);
  });

  it('a setup invite creates an account, an owned workspace and a session; sign-out ends it', async () => {
    const { browser } = await start();
    const b = browser();
    const token = await invite(null);
    expect((await b.call('POST', '/api/invites/check', { token })).json()).toEqual({ kind: 'setup', workspaceName: null, role: 'owner', emailRequired: false });
    expect((await b.call('POST', '/api/signup', { invite: token, email: 'Owner@Seller.test', password: 'short', workspaceName: 'Seller Co' })).status).toBe(400);
    const r = await b.call('POST', '/api/signup', { invite: token, email: 'Owner@Seller.test', password: PW, name: 'Olu', workspaceName: 'Seller Co' });
    expect(r.status).toBe(200);
    const set = r.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    const s = (await b.call('GET', '/api/session')).json();
    expect(s.signedIn).toBe(true);
    expect(s.user).toEqual({ name: 'Olu', email: 'owner@seller.test' });
    expect(s.workspace).toMatchObject({ name: 'Seller Co', role: 'owner' });
    expect((await b.call('GET', '/api/workspace')).json()).toMatchObject({ name: 'Seller Co', authenticated: true, role: 'owner' });
    expect((await b.call('GET', '/api/opportunities')).status).toBe(200);
    // The invite is spent.
    expect((await browser().call('POST', '/api/signup', { invite: token, email: 'x@y.test', password: PW, workspaceName: 'Again' })).status).toBe(404);
    // Only the token's hash is stored.
    expect((await db().query('SELECT count(*)::int AS n FROM user_sessions WHERE token_sha256 = $1', [b.cookie().split('=')[1]])).rows[0].n).toBe(0);
    const old = b.cookie();
    expect((await b.call('DELETE', '/api/session')).status).toBe(200);
    expect(b.cookie()).toBe('');
    b.setCookie(old);
    expect((await b.call('GET', '/api/opportunities')).status).toBe(401);
  });

  it('wrong email and wrong password get the same answer; repeated failures are slowed', async () => {
    const { browser } = await start();
    const owner = browser();
    await owner.call('POST', '/api/signup', { invite: await invite(null), email: 'o@seller.test', password: PW, workspaceName: 'W' });
    const b = browser();
    const bad = await b.call('POST', '/api/session', { email: 'o@seller.test', password: 'wrong password here' });
    const none = await b.call('POST', '/api/session', { email: 'nobody@seller.test', password: 'wrong password here' });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(bad.json().error).toBe(none.json().error);
    const ok = await b.call('POST', '/api/session', { email: 'O@seller.test', password: PW });
    expect(ok.status).toBe(200);
    expect((await b.call('GET', '/api/opportunities')).status).toBe(200);
  });

  it('limits attempts per key', () => {
    const l = new AttemptLimiter(3, 1000);
    l.hit('k', 0); l.hit('k', 1); expect(l.blocked('k', 2)).toBe(false);
    l.hit('k', 3); expect(l.blocked('k', 4)).toBe(true);
    expect(l.blocked('k', 1004)).toBe(false);
  });

  it('a person sees and changes only their own workspace, and cannot switch into another', async () => {
    const wsA = await enterNewWorkspace(db(), 'alpha');
    const seed = await seedWebsiteOpportunity(db(), { reviews: true });
    const wsB = await enterNewWorkspace(db(), 'beta');
    const { browser } = await start();
    const a = browser();
    const bb = browser();
    await a.call('POST', '/api/signup', { invite: await invite(wsA), email: 'a@alpha.test', password: PW });
    await bb.call('POST', '/api/signup', { invite: await invite(wsB), email: 'b@beta.test', password: PW });
    const feedA = (await a.call('GET', '/api/opportunities')).json();
    expect(feedA.map((o: any) => o.opportunityId)).toContain(seed.opportunityId);
    expect((await a.call('GET', `/api/opportunities/${seed.opportunityId}`)).status).toBe(200);
    // B: not in the feed, not found by id, cannot write to it, cannot switch into A.
    expect((await bb.call('GET', '/api/opportunities')).json().map((o: any) => o.opportunityId)).not.toContain(seed.opportunityId);
    expect((await bb.call('GET', `/api/opportunities/${seed.opportunityId}`)).status).toBe(404);
    expect((await bb.call('POST', `/api/opportunities/${seed.opportunityId}/outcomes`, { kind: 'pitched', occurredOn: '2026-10-01', recordedBy: 'x', channel: 'email' })).status).toBe(404);
    expect((await bb.call('POST', '/api/session/workspace', { workspaceId: wsA })).status).toBe(404);
    expect((await bb.call('GET', `/api/opportunities/${seed.opportunityId}`)).status).toBe(404);
  });

  it('records the signed-in person as the actor, whatever the browser sends', async () => {
    const ws = await enterNewWorkspace(db(), 'alpha');
    const seed = await seedWebsiteOpportunity(db(), { reviews: true });
    const { browser } = await start();
    const a = browser();
    await a.call('POST', '/api/signup', { invite: await invite(ws), email: 'a@alpha.test', password: PW, name: 'Ada Seller' });
    const r = await a.call('POST', `/api/opportunities/${seed.opportunityId}/outcomes`, { kind: 'pitched', occurredOn: '2026-10-01', recordedBy: 'Someone Else', channel: 'email' });
    expect(r.status).toBe(200);
    await useWorkspace(db(), ws);
    expect((await one<{ by: string }>(db(), `SELECT recorded_by AS by FROM outcomes WHERE opportunity_id = $1`, [seed.opportunityId])).by).toBe('Ada Seller');
  });

  it('losing a membership ends access at once', async () => {
    const ws = await enterNewWorkspace(db(), 'alpha');
    const { browser } = await start();
    const a = browser();
    await a.call('POST', '/api/signup', { invite: await invite(ws), email: 'a@alpha.test', password: PW });
    expect((await a.call('GET', '/api/opportunities')).status).toBe(200);
    await db().query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [ws]);
    const r = await a.call('GET', '/api/opportunities');
    expect(r.status).toBe(403);
    expect(r.json().reason).toBe('no_workspace');
  });

  it('an expired session is signed out', async () => {
    const ws = await enterNewWorkspace(db(), 'alpha');
    const { browser } = await start();
    const a = browser();
    await a.call('POST', '/api/signup', { invite: await invite(ws), email: 'a@alpha.test', password: PW });
    const token = readCookie(a.cookie(), 'scopely_session');
    const s = await resolveSession(db(), token);
    expect(s).not.toBeNull();
    const ttl = Date.parse(s!.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(13.9 * 86_400_000);
    expect(ttl).toBeLessThanOrEqual(14 * 86_400_000);
    expect(await resolveSession(db(), token, new Date(Date.now() + 14 * 86_400_000 + 1000))).toBeNull();
  });

  it('only owners and admins invite; admins cannot mint owners; members see no emails', async () => {
    const ws = await enterNewWorkspace(db(), 'alpha');
    const { browser } = await start();
    const owner = browser();
    await owner.call('POST', '/api/signup', { invite: await invite(ws, 'owner'), email: 'o@alpha.test', password: PW });
    const r = await owner.call('POST', '/api/workspace/invites', { role: 'admin', email: 'ad@alpha.test' });
    expect(r.status).toBe(200);
    const link = r.json().url as string;
    expect(link).toMatch(/^\/app\/#\/join\/[A-Za-z0-9_-]{43}$/);
    const admin = browser();
    // Bound to its email.
    expect((await admin.call('POST', '/api/signup', { invite: link.split('/').pop(), email: 'other@alpha.test', password: PW })).status).toBe(403);
    expect((await admin.call('POST', '/api/signup', { invite: link.split('/').pop(), email: 'ad@alpha.test', password: PW })).status).toBe(200);
    expect((await admin.call('POST', '/api/workspace/invites', { role: 'owner' })).status).toBe(403);
    const m = (await admin.call('POST', '/api/workspace/invites', { role: 'member' })).json().url.split('/').pop();
    const member = browser();
    await member.call('POST', '/api/signup', { invite: m, email: 'm@alpha.test', password: PW });
    expect((await member.call('POST', '/api/workspace/invites', { role: 'member' })).status).toBe(403);
    const members = (await member.call('GET', '/api/workspace/members')).json().members;
    expect(members).toHaveLength(3);
    expect(members.filter((x: any) => x.email).map((x: any) => x.email)).toEqual(['m@alpha.test']);
  });

  it('is invite-only unless open sign-up is on; an existing account cannot be claimed by an open invite', async () => {
    const ws = await enterNewWorkspace(db(), 'alpha');
    // A person provisioned before sign-in existed: a member with no password.
    const u = await one<{ id: string }>(db(), `INSERT INTO users (email) VALUES ('first@alpha.test') RETURNING id`);
    await db().query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [ws, u.id]);
    const closed = await start();
    expect((await closed.browser().call('POST', '/api/signup', { email: 'n@x.test', password: PW, workspaceName: 'New' })).status).toBe(403);
    server?.close();
    const open = await start({ auth: { secureCookies: false, openSignup: true } });
    const b = open.browser();
    expect((await b.call('POST', '/api/signup', { email: 'first@alpha.test', password: PW, workspaceName: 'Grab' })).status).toBe(409);
    expect((await b.call('POST', '/api/signup', { invite: await invite(null), email: 'first@alpha.test', password: PW, workspaceName: 'Grab' })).status).toBe(409);
    // Addressed to that email, it may set the first password.
    const c = open.browser();
    expect((await c.call('POST', '/api/signup', { invite: await invite(ws, 'member', 'first@alpha.test'), email: 'first@alpha.test', password: PW })).status).toBe(200);
    expect((await c.call('GET', '/api/session')).json().workspace).toMatchObject({ workspaceId: ws, role: 'owner' });
    expect((await open.browser().call('POST', '/api/signup', { email: 'new@x.test', password: PW, workspaceName: 'Fresh' })).status).toBe(200);
  });

  it('runs every workspace request as the application role, under row-level security', async () => {
    const ws = await enterNewWorkspace(db(), 'alpha');
    const seed = await seedWebsiteOpportunity(db(), { reviews: true });
    const { browser } = await start({ dbRole: inject('appRole') });
    const a = browser();
    await a.call('POST', '/api/signup', { invite: await invite(ws), email: 'a@alpha.test', password: PW });
    expect((await a.call('GET', '/api/opportunities')).json().map((o: any) => o.opportunityId)).toContain(seed.opportunityId);
    expect((await a.call('GET', `/api/opportunities/${seed.opportunityId}`)).status).toBe(200);
    expect((await a.call('GET', '/api/discovery')).status).toBe(200);
    expect((await a.call('POST', `/api/opportunities/${seed.opportunityId}/outcomes`, { kind: 'pitched', occurredOn: '2026-10-01', channel: 'email' })).status).toBe(200);
  });

  it('cookies are Secure, __Host- and HSTS is sent when secure cookies are on', async () => {
    const { browser } = await start({ auth: { secureCookies: true } });
    const r = await browser().call('POST', '/api/signup', { invite: await invite(null), email: 'o@s.test', password: PW, workspaceName: 'S' });
    expect(r.headers.get('set-cookie')).toMatch(/^__Host-scopely_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect(r.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
  });

  it('the development preview names itself and offers no sign-in routes', async () => {
    const ws = await enterNewWorkspace(db(), 'alpha');
    const { browser } = await start({ auth: undefined, workspaceId: ws });
    const b = browser();
    expect((await b.call('GET', '/api/session')).json()).toEqual({ mode: 'preview', signedIn: false, workspace: { name: 'alpha' } });
    expect((await b.call('POST', '/api/session', { email: 'a@b.test', password: PW })).status).toBe(404);
    expect((await b.call('GET', '/api/workspace')).json()).toMatchObject({ authenticated: false, preview: true });
  });

  it('health says whether the database is up and current, and nothing else', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, database: 'up', pendingMigrations: 0, auth: 'session' });
  });

  it('a handler needs exactly one of sign-in or a preview workspace', () => {
    expect(() => createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), signingKey: SIGNING_KEY, editLinkTtlSeconds: 1, showLinkTtlSeconds: 1 } as ServerConfig)).toThrow(/exactly one/);
    expect(() => createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), signingKey: SIGNING_KEY, editLinkTtlSeconds: 1, showLinkTtlSeconds: 1,
      workspaceId: '1', auth: { secureCookies: true } })).toThrow(/exactly one/);
  });
});

describe('the server refuses an unsafe production start', () => {
  const serve = (env: Record<string, string>) => {
    const root = path.resolve(import.meta.dirname, '..');
    const r = spawnSync(path.join(root, 'node_modules/.bin/tsx'), ['scripts/serve.ts'], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, err: r.stderr };
  };
  it('no development preview in production, or off localhost', () => {
    const prod = serve({ SCOPELY_ENV: 'production', SCOPELY_WORKSPACE_ID: '1', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x' });
    expect(prod.code).toBe(1);
    expect(prod.err).toMatch(/refused in production/);
    const open = serve({ SCOPELY_WORKSPACE_ID: '1', HOST: '0.0.0.0', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x' });
    expect(open.code).toBe(1);
    expect(open.err).toMatch(/loopback/);
  });
  it('no production start without the application role or a signing key', () => {
    expect(serve({ SCOPELY_ENV: 'production', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x', PREVIEW_SIGNING_KEY: 'k'.repeat(40) }).err).toMatch(/SCOPELY_DB_APP_ROLE/);
    expect(serve({ SCOPELY_ENV: 'production', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x', SCOPELY_DB_APP_ROLE: 'scopely_app' }).err).toMatch(/PREVIEW_SIGNING_KEY/);
    const down = serve({ SCOPELY_ENV: 'production', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x', SCOPELY_DB_APP_ROLE: 'scopely_app', PREVIEW_SIGNING_KEY: 'k'.repeat(40) });
    expect(down.code).toBe(1);
    expect(down.err).toMatch(/Could not reach the database/);
  });
});
