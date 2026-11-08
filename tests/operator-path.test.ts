// The operator path (docs/OPERATIONS.md): the one-time owner bootstrap and the pre-deploy
// encrypted backup, which together replace running commands over `railway ssh`.
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { createInvite, hashPassword, tokenHash } from '../src/auth/index.js';
import { migrate } from '../src/db/migrate.js';
import {
  BackupFailed, backupConfigFromEnv, decryptBackup, encryptBackup, pgEnvFromUrl, readBackupHeader, recordBackup, runBackup, type BackupConfig, type ObjectStore,
} from '../src/ops/backup.js';
import { bootstrapConfigFromEnv, issueBootstrapInvite, ownerEstablished } from '../src/ops/bootstrap.js';
import { S3Client, signV4 } from '../src/ops/s3.js';
import { createHandler, type ServerConfig } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { failure, useDb } from './helpers.js';
import { SIGNING_KEY } from './site-helpers.js';

const { db } = useDb();
const ROOT = path.resolve(import.meta.dirname, '..');
const PW = 'correct horse battery staple';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const HOUR = 3600_000;

// ----------------------------------------------------------------------------- a test server

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = { BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv' };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => { await client.query('RESET ROLE'); return conn; } } as unknown as pg.Pool;
}
let server: http.Server | null = null;
afterEach(async () => { server?.close(); server = null; await db().query('RESET ROLE').catch(() => undefined); });
async function start() {
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), signingKey: SIGNING_KEY, editLinkTtlSeconds: 900, showLinkTtlSeconds: 3600,
    log: () => undefined, auth: { secureCookies: false } } as ServerConfig);
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return () => {
    let jar = '';
    return async (method: string, p: string, body?: unknown) => {
      const r = await fetch(base + p, { method, headers: { 'x-scopely-request': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(jar ? { cookie: jar } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const set = r.headers.get('set-cookie');
      if (set) jar = set.split(';')[0]!;
      const text = await r.text();
      await db().query('RESET ROLE');
      return { status: r.status, json: () => JSON.parse(text) as any };
    };
  };
}

const events = async (kind: string) => (await db().query('SELECT * FROM operator_events WHERE kind = $1 ORDER BY id', [kind])).rows;
const newToken = () => randomBytes(32).toString('base64url');
const cfgFor = (token: string, email = 'founder@seller.test', expiresAt = new Date(Date.now() + 24 * HOUR)) => ({ inviteSha256: tokenHash(token), email, expiresAt });

/** Another workspace owner who can sign in, made the ordinary way (a CLI setup invite would do the same). */
async function makeOwner(email = 'someone@else.test') {
  const u = (await db().query('INSERT INTO users (email) VALUES ($1) RETURNING id', [email])).rows[0].id;
  await db().query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [u, await hashPassword(PW)]);
  const w = (await db().query(`INSERT INTO workspaces (slug, name) VALUES ($1, 'Other') RETURNING id`, [`other-${randomBytes(3).toString('hex')}`])).rows[0].id;
  await db().query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w, u]);
}

// ============================================================================ owner bootstrap

describe('owner bootstrap: configuration', () => {
  it('is off when unset, and a half-set or malformed configuration is an error that never echoes a value', () => {
    expect(bootstrapConfigFromEnv({})).toBeNull();
    const hash = 'a'.repeat(64);
    expect(() => bootstrapConfigFromEnv({ SCOPELY_BOOTSTRAP_INVITE_SHA256: hash })).toThrow(/set all of/);
    expect(() => bootstrapConfigFromEnv({ SCOPELY_BOOTSTRAP_INVITE_SHA256: 'raw-token-here', SCOPELY_BOOTSTRAP_EMAIL: 'a@b.test', SCOPELY_BOOTSTRAP_EXPIRES_AT: '2026-11-09T00:00:00Z' }))
      .toThrow(/^(?!.*raw-token-here).*64 lower-case hex/);
    expect(() => bootstrapConfigFromEnv({ SCOPELY_BOOTSTRAP_INVITE_SHA256: hash, SCOPELY_BOOTSTRAP_EMAIL: 'nope', SCOPELY_BOOTSTRAP_EXPIRES_AT: '2026-11-09T00:00:00Z' })).toThrow(/not an email/);
    expect(() => bootstrapConfigFromEnv({ SCOPELY_BOOTSTRAP_INVITE_SHA256: hash, SCOPELY_BOOTSTRAP_EMAIL: 'a@b.test', SCOPELY_BOOTSTRAP_EXPIRES_AT: 'tomorrow' })).toThrow(/ISO time/);
    expect(bootstrapConfigFromEnv({ SCOPELY_BOOTSTRAP_INVITE_SHA256: hash, SCOPELY_BOOTSTRAP_EMAIL: ' Founder@Seller.test ', SCOPELY_BOOTSTRAP_EXPIRES_AT: '2026-11-09T00:00:00Z' }))
      .toEqual({ inviteSha256: hash, email: 'founder@seller.test', expiresAt: new Date('2026-11-09T00:00:00Z') });
  });
});

describe('owner bootstrap: issuing', () => {
  it('issues one ordinary, email-bound setup invite while no owner exists, and records it', async () => {
    expect(await ownerEstablished(db())).toBe(false);
    const token = newToken();
    const out = await issueBootstrapInvite(db(), cfgFor(token));
    expect(out.status).toBe('issued');
    const inv = (await db().query('SELECT * FROM workspace_invites WHERE token_sha256 = $1', [tokenHash(token)])).rows[0];
    expect(inv).toMatchObject({ workspace_id: null, role: 'owner', email: 'founder@seller.test', created_by: 'bootstrap', used_at: null });
    const [ev] = await events('bootstrap_invite_issued');
    expect(String(ev.invite_id)).toBe(String(inv.id));
    // The record holds no token, hash or email.
    expect(JSON.stringify(ev)).not.toMatch(new RegExp(`${tokenHash(token)}|founder@`));
  });

  it('never issues the same hash twice: a used or expired bootstrap cannot be revived by redeploying', async () => {
    const token = newToken();
    expect((await issueBootstrapInvite(db(), cfgFor(token))).status).toBe('issued');
    expect(await issueBootstrapInvite(db(), cfgFor(token))).toEqual({ status: 'refused', reason: 'already_issued' });
    expect((await db().query('SELECT count(*)::int AS n FROM workspace_invites WHERE token_sha256 = $1', [tokenHash(token)])).rows[0].n).toBe(1);
  });

  it('refuses once an owner can sign in, and records the refusal', async () => {
    await makeOwner();
    const token = newToken();
    expect(await issueBootstrapInvite(db(), cfgFor(token))).toEqual({ status: 'refused', reason: 'owner_exists' });
    expect((await db().query('SELECT 1 FROM workspace_invites WHERE token_sha256 = $1', [tokenHash(token)])).rows).toHaveLength(0);
    expect((await events('bootstrap_invite_refused')).map((e) => e.reason)).toEqual(['owner_exists']);
  });

  it('refuses an expiry in the past or more than 72 hours ahead', async () => {
    expect(await issueBootstrapInvite(db(), cfgFor(newToken(), undefined, new Date(Date.now() - 1000)))).toEqual({ status: 'refused', reason: 'expiry_past' });
    expect(await issueBootstrapInvite(db(), cfgFor(newToken(), undefined, new Date(Date.now() + 73 * HOUR)))).toEqual({ status: 'refused', reason: 'expiry_too_far' });
    expect((await db().query(`SELECT count(*)::int AS n FROM workspace_invites WHERE created_by = 'bootstrap'`)).rows[0].n).toBe(0);
  });
});

describe('owner bootstrap: using the link through the normal sign-up', () => {
  it('unauthorised: a token that was not issued is refused like any invalid invite, and nothing is created', async () => {
    await issueBootstrapInvite(db(), cfgFor(newToken()));
    const call = (await start())();
    const guess = newToken();
    expect((await call('POST', '/api/invites/check', { token: guess })).status).toBe(404);
    expect((await call('POST', '/api/signup', { invite: guess, email: 'founder@seller.test', password: PW, workspaceName: 'Seller' })).status).toBe(404);
    // The hash itself is not a token.
    expect((await call('POST', '/api/signup', { invite: cfgFor(guess).inviteSha256, email: 'founder@seller.test', password: PW, workspaceName: 'Seller' })).status).toBe(404);
    expect((await db().query(`SELECT count(*)::int AS n FROM users WHERE email = 'founder@seller.test'`)).rows[0].n).toBe(0);
    expect(await ownerEstablished(db())).toBe(false);
  });

  it('expired: a link past its expiry is refused', async () => {
    const token = newToken();
    const then = new Date(Date.now() - 3 * HOUR);
    expect((await issueBootstrapInvite(db(), cfgFor(token, undefined, new Date(Date.now() - HOUR)), then)).status).toBe('issued');
    const call = (await start())();
    expect((await call('POST', '/api/invites/check', { token })).status).toBe(404);
    expect((await call('POST', '/api/signup', { invite: token, email: 'founder@seller.test', password: PW, workspaceName: 'Seller' })).status).toBe(404);
    expect(await ownerEstablished(db())).toBe(false);
  });

  it('bound to its email: anyone else holding the link is refused', async () => {
    const token = newToken();
    await issueBootstrapInvite(db(), cfgFor(token));
    const call = (await start())();
    expect((await call('POST', '/api/signup', { invite: token, email: 'attacker@evil.test', password: PW, workspaceName: 'Mine' })).status).toBe(403);
    expect(await ownerEstablished(db())).toBe(false);
  });

  it('successful: creates the owner, the workspace and a session the normal way, records it, and the link is spent (reuse refused)', async () => {
    const token = newToken();
    await issueBootstrapInvite(db(), cfgFor(token));
    const browser = await start();
    const call = browser();
    expect((await call('POST', '/api/invites/check', { token })).json()).toEqual({ kind: 'setup', workspaceName: null, role: 'owner', emailRequired: true });
    const r = await call('POST', '/api/signup', { invite: token, email: 'Founder@Seller.test', password: PW, name: 'F', workspaceName: 'Seller Co' });
    expect(r.status).toBe(200);
    const s = (await call('GET', '/api/session')).json();
    expect(s.workspace).toMatchObject({ name: 'Seller Co', role: 'owner' });
    expect((await call('GET', '/api/opportunities')).status).toBe(200);
    expect(await ownerEstablished(db())).toBe(true);
    const [done] = await events('bootstrap_completed');
    expect(String(done.workspace_id)).toBe(s.workspace.workspaceId);
    const user = (await db().query(`SELECT id FROM users WHERE email = 'founder@seller.test'`)).rows[0];
    expect(String(done.user_id)).toBe(String(user.id));
    // Reused: the same link is dead, for anyone.
    const again = browser();
    expect((await again('POST', '/api/invites/check', { token })).status).toBe(404);
    expect((await again('POST', '/api/signup', { invite: token, email: 'founder@seller.test', password: PW, workspaceName: 'Second' })).status).toBe(404);
    expect((await db().query(`SELECT count(*)::int AS n FROM workspace_memberships WHERE user_id = $1`, [user.id])).rows[0].n).toBe(1);
    // And the release step will not issue another bootstrap now that an owner exists.
    expect(await issueBootstrapInvite(db(), cfgFor(newToken()))).toEqual({ status: 'refused', reason: 'owner_exists' });
  });

  it('unusable after an owner is established some other way: the unused link reads invalid, is refused, and the refusal is recorded', async () => {
    const token = newToken();
    await issueBootstrapInvite(db(), cfgFor(token));
    await makeOwner();
    const call = (await start())();
    expect((await call('POST', '/api/invites/check', { token })).status).toBe(404);
    const r = await call('POST', '/api/signup', { invite: token, email: 'founder@seller.test', password: PW, workspaceName: 'Late' });
    expect(r.status).toBe(409);
    expect(r.json().reason ?? r.json().error).toBeDefined();
    expect((await db().query('SELECT used_at FROM workspace_invites WHERE token_sha256 = $1', [tokenHash(token)])).rows[0].used_at).toBeNull();
    expect((await events('bootstrap_accept_refused')).map((e) => e.reason)).toEqual(['owner_exists']);
    expect((await db().query(`SELECT count(*)::int AS n FROM users WHERE email = 'founder@seller.test'`)).rows[0].n).toBe(0);
  });

  it('ordinary setup and workspace invites are unaffected once an owner exists, even from a person named "bootstrap"', async () => {
    await makeOwner();
    const token = (await createInvite(db(), { workspaceId: null, role: 'owner', createdBy: 'cli' })).token;
    const browser = await start();
    const call = browser();
    expect((await call('POST', '/api/signup', { invite: token, email: 'second@seller.test', password: PW, workspaceName: 'Second' })).status).toBe(200);
    const ws = (await db().query(`SELECT id FROM workspaces WHERE name = 'Second'`)).rows[0].id;
    const member = (await createInvite(db(), { workspaceId: String(ws), role: 'member', createdBy: 'bootstrap' })).token;
    expect((await browser()('POST', '/api/signup', { invite: member, email: 'third@seller.test', password: PW })).status).toBe(200);
  });
});

describe('the operator record', () => {
  it('is append-only and invisible to the application role', async () => {
    await issueBootstrapInvite(db(), cfgFor(newToken()));
    expect(await failure(db(), `UPDATE operator_events SET reason = 'x'`)).toMatch(/append-only/);
    expect(await failure(db(), 'DELETE FROM operator_events')).toMatch(/append-only/);
    expect(await failure(db(), 'TRUNCATE operator_events')).toMatch(/append-only/);
    await db().query(`SET LOCAL ROLE ${inject('appRole')}`);
    expect((await db().query('SELECT count(*)::int AS n FROM operator_events')).rows[0].n).toBe(0);
    await db().query('RESET ROLE');
  });

  it('refuses a key that is not a backup name and a backup row without its checksums', async () => {
    expect(await failure(db(), `INSERT INTO operator_events (kind, object_key, ciphertext_sha256, dump_sha256, archive_entries) VALUES ('backup_completed', 'postgres://x', $1, $1, 3)`, ['a'.repeat(64)])).toMatch(/check constraint/);
    expect(await failure(db(), `INSERT INTO operator_events (kind) VALUES ('backup_completed')`)).toMatch(/check constraint/);
    expect(await failure(db(), `INSERT INTO operator_events (kind) VALUES ('backup_failed')`)).toMatch(/check constraint/);
  });

  it('no request route reaches the operator path', () => {
    const app = readFileSync(path.join(ROOT, 'src/server/app.ts'), 'utf8');
    expect(app).not.toMatch(/ops\/backup|runBackup|issueBootstrapInvite/);
  });
});

// ================================================================================== backups

const { privateKey: PRIV, publicKey: PUB } = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

/** A small S3 stand-in: path-style PUT and GET; checks that each request is signed and its payload hash is honest. */
function fakeS3(opts: { corrupt?: boolean; failPut?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const seen: { method: string; url: string; auth: string }[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = String(req.headers.authorization ?? '');
      seen.push({ method: req.method!, url: req.url!, auth });
      if (!/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(auth)) { res.writeHead(403); res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
      if (req.headers['x-amz-content-sha256'] !== sha(body)) { res.writeHead(400); res.end('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>'); return; }
      if (req.method === 'PUT') {
        if (opts.failPut) { res.writeHead(507); res.end('<Error><Code>InsufficientStorage</Code></Error>'); return; }
        objects.set(req.url!, body); res.writeHead(200); res.end(); return;
      }
      const o = objects.get(req.url!);
      if (!o) { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      const out = Buffer.from(o);
      if (opts.corrupt) out[out.length - 1] = out[out.length - 1]! ^ 1;
      res.writeHead(200); res.end(out);
    });
  });
  return {
    objects, seen,
    listen: () => new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`))),
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const backupEnv = (endpoint: string) => ({
  SCOPELY_BACKUP_S3_ENDPOINT: endpoint, SCOPELY_BACKUP_S3_BUCKET: 'scopely-backups-test', SCOPELY_BACKUP_S3_ACCESS_KEY_ID: 'AKID',
  SCOPELY_BACKUP_S3_SECRET_ACCESS_KEY: 'very-secret-key-value', SCOPELY_BACKUP_S3_URL_STYLE: 'path', SCOPELY_BACKUP_PUBLIC_KEY: PUB,
});

describe('backup: object storage signing', () => {
  it('matches the AWS Signature Version 4 examples for S3', () => {
    const common = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z', host: 'examplebucket.s3.amazonaws.com' };
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(signV4({ ...common, method: 'GET', path: '/test.txt', payloadSha256: empty,
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': common.amzDate } }))
      .toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    const body = sha('Welcome to Amazon S3.');
    expect(signV4({ ...common, method: 'PUT', path: '/test$file.text', payloadSha256: body,
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-content-sha256': body, 'x-amz-date': common.amzDate, 'x-amz-storage-class': 'REDUCED_REDUNDANCY' } }))
      .toMatch(/Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
  });

  it('puts and gets an object, and an error names only the status and S3 code', async () => {
    const s3 = fakeS3();
    const endpoint = await s3.listen();
    try {
      const c = new S3Client({ endpoint, bucket: 'b-test', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'sekret', urlStyle: 'path' });
      await c.put('scopely-backups/x.dump.enc', Buffer.from('hello'));
      expect((await c.get('scopely-backups/x.dump.enc')).toString()).toBe('hello');
      const err = await c.get('scopely-backups/missing').catch((e: Error) => e);
      expect((err as Error).message).toBe('object storage answered 404 NoSuchKey');
      expect(s3.seen.every((r) => !r.auth.includes('sekret'))).toBe(true);
    } finally { await s3.close(); }
  });
});

describe('backup: configuration', () => {
  it('is off when unset; half-set, plain-http or weak-key configurations stop the deploy without echoing a value', () => {
    expect(backupConfigFromEnv({})).toBeNull();
    expect(() => backupConfigFromEnv({ SCOPELY_BACKUP_S3_BUCKET: 'b-test' })).toThrow(/set all of.*Missing: SCOPELY_BACKUP_S3_ENDPOINT/);
    expect(() => backupConfigFromEnv({ ...backupEnv('http://storage.example.com') })).toThrow(/must be https/);
    const { publicKey: weak } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    expect(() => backupConfigFromEnv({ ...backupEnv('https://t3.storageapi.dev'), SCOPELY_BACKUP_PUBLIC_KEY: weak })).toThrow(/at least 3072/);
    expect(() => backupConfigFromEnv({ ...backupEnv('https://t3.storageapi.dev'), SCOPELY_BACKUP_PUBLIC_KEY: PRIV })).toThrow(/must be the public key/);
    const err = (() => { try { backupConfigFromEnv({ ...backupEnv('https://t3.storageapi.dev'), SCOPELY_BACKUP_S3_BUCKET: 'Bad Bucket!' }); } catch (e) { return (e as Error).message; } })();
    expect(err).not.toMatch(/very-secret-key-value|Bad Bucket/);
    // A PEM pasted with literal \n sequences is accepted.
    const cfg = backupConfigFromEnv({ ...backupEnv('https://t3.storageapi.dev'), SCOPELY_BACKUP_S3_URL_STYLE: '', SCOPELY_BACKUP_PUBLIC_KEY: PUB.replace(/\n/g, '\\n') })!;
    expect(cfg.s3).toMatchObject({ endpoint: 'https://t3.storageapi.dev', urlStyle: 'virtual', region: 'auto' });
  });

  it('passes the database to pg_dump as PG* values of the child only', () => {
    expect(pgEnvFromUrl('postgresql://app%40x:p%40ss@db.internal:6543/scopely?sslmode=require'))
      .toEqual({ PGHOST: 'db.internal', PGPORT: '6543', PGUSER: 'app@x', PGPASSWORD: 'p@ss', PGDATABASE: 'scopely', PGSSLMODE: 'require' });
  });
});

describe('backup: the envelope', () => {
  it('only the private key opens it; any change to header or body is detected', () => {
    const dump = randomBytes(5000);
    const cfg = backupConfigFromEnv(backupEnv('https://t3.storageapi.dev'))!;
    const sealed = encryptBackup(dump, cfg.publicKey, { entries: 3, pgDump: '18.1', createdAt: '2026-11-08T00:00:00.000Z' });
    expect(sealed.includes(dump.subarray(0, 64))).toBe(false);
    const { header } = readBackupHeader(sealed);
    expect(header).toMatchObject({ v: 1, dumpSha256: sha(dump), entries: 3, keyFingerprint: cfg.keyFingerprint });
    expect(decryptBackup(sealed, PRIV).dump.equals(dump)).toBe(true);
    const flipBody = Buffer.from(sealed); flipBody[flipBody.length - 40] = flipBody[flipBody.length - 40]! ^ 1;
    expect(() => decryptBackup(flipBody, PRIV)).toThrow();
    const flipHeader = Buffer.from(sealed.toString('latin1').replace('"entries":3', '"entries":4'), 'latin1');
    expect(() => decryptBackup(flipHeader, PRIV)).toThrow();
    const other = generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(() => decryptBackup(sealed, other.privateKey)).toThrow();
  });
});

/** A committed database of its own, for the parts that dump, restore or run the release step. */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://scopely:scopely@localhost:5432/postgres';
const made: string[] = [];
async function freshDb(migrated: boolean): Promise<string> {
  const name = `scopely_op_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  made.push(name);
  const url = new URL(ADMIN_URL); url.pathname = `/${name}`;
  if (migrated) { const c = new pg.Client({ connectionString: url.toString() }); await c.connect(); await migrate(c); await c.end(); }
  return url.toString();
}
afterAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const n of made) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await admin.end();
});
const withDb = async <T>(url: string, fn: (c: pg.Client) => Promise<T>) => {
  const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query('SET search_path = scopely, public');
  try { return await fn(c); } finally { await c.end(); }
};
const runCmd = (cmd: string, args: string[], env: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  const p = spawn(cmd, args, { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env } });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ code, out, err }));
});

describe('backup: a real dump, uploaded, read back, decrypted and restored', () => {
  let source = '';
  beforeAll(async () => {
    source = await freshDb(true);
    await withDb(source, async (c) => {
      await c.query(`INSERT INTO workspaces (slug, name) VALUES ('restore-check', 'Restore check')`);
    });
  });

  it('round-trips: the restored database has the same schema version and rows, and no plain dump is left behind', async () => {
    const s3 = fakeS3();
    const endpoint = await s3.listen();
    try {
      const cfg = backupConfigFromEnv(backupEnv(endpoint)) as BackupConfig;
      const before = readdirSync(tmpdir()).filter((f) => f.startsWith('scopely-backup-')).length;
      const r = await runBackup({ databaseUrl: source, cfg });
      expect(readdirSync(tmpdir()).filter((f) => f.startsWith('scopely-backup-')).length).toBe(before);
      expect(r.objectKey).toMatch(/^scopely-backups\/\d{8}T\d{6}Z-[0-9a-f]{8}\.dump\.enc$/);
      expect(r.entries).toBeGreaterThan(50);
      const stored = s3.objects.get(`/scopely-backups-test/${r.objectKey}`)!;
      expect(sha(stored)).toBe(r.ciphertextSha256);
      expect(stored.includes(Buffer.from('Restore check'))).toBe(false);
      // The record of it.
      await withDb(source, async (c) => {
        expect(await recordBackup(c, r)).toBe(true);
        expect((await c.query(`SELECT object_key, archive_entries FROM operator_events WHERE kind = 'backup_completed'`)).rows).toEqual([{ object_key: r.objectKey, archive_entries: r.entries }]);
      });
      // Offline: decrypt, restore into an empty database, and check.
      const { dump } = decryptBackup(stored, PRIV);
      expect(sha(dump)).toBe(r.dumpSha256);
      const target = await freshDb(false);
      const file = path.join(tmpdir(), `restore-${randomBytes(4).toString('hex')}.dump`);
      (await import('node:fs')).writeFileSync(file, dump, { mode: 0o600 });
      const restore = await runCmd('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '-d', target, file], {});
      (await import('node:fs')).rmSync(file);
      expect(restore.code).toBe(0);
      await withDb(target, async (c) => {
        expect((await c.query(`SELECT name FROM workspaces WHERE slug = 'restore-check'`)).rows).toEqual([{ name: 'Restore check' }]);
        expect((await migrate(c)).applied).toEqual([]);
      });
    } finally { await s3.close(); }
  });

  it('a read-back that does not match, or a refused upload, fails the backup', async () => {
    for (const [opts, reason] of [[{ corrupt: true }, 'readback_mismatch'], [{ failPut: true }, 'upload_failed']] as const) {
      const s3 = fakeS3(opts);
      const endpoint = await s3.listen();
      try {
        const err = await runBackup({ databaseUrl: source, cfg: backupConfigFromEnv(backupEnv(endpoint))! }).catch((e) => e);
        expect(err).toBeInstanceOf(BackupFailed);
        expect((err as BackupFailed).reason).toBe(reason);
      } finally { await s3.close(); }
    }
  });

  it('a database it cannot reach fails without printing the connection details', async () => {
    const store: ObjectStore = { put: async () => undefined, get: async () => Buffer.alloc(0) };
    const err = await runBackup({ databaseUrl: 'postgres://ghost:hunter2-password@127.0.0.1:1/nope', cfg: backupConfigFromEnv(backupEnv('https://t3.storageapi.dev'))!, store }).catch((e) => e);
    expect((err as BackupFailed).reason).toBe('pg_dump_failed');
    expect(String(err.message)).not.toMatch(/hunter2|ghost|127\.0\.0\.1/);
  });
});

describe('the release step (pnpm release)', () => {
  const release = (env: Record<string, string>) => runCmd(path.join(ROOT, 'node_modules/.bin/tsx'), ['scripts/release.ts'], env);

  it('backs up, then migrates, then issues the bootstrap invite; a redeploy backs up again and issues nothing new; nothing secret is printed', async () => {
    const url = await freshDb(false);
    const s3 = fakeS3();
    const endpoint = await s3.listen();
    const token = newToken();
    const env = { DATABASE_URL: url, ...backupEnv(endpoint), SCOPELY_BOOTSTRAP_INVITE_SHA256: tokenHash(token), SCOPELY_BOOTSTRAP_EMAIL: 'founder@seller.test',
      SCOPELY_BOOTSTRAP_EXPIRES_AT: new Date(Date.now() + 24 * HOUR).toISOString() };
    try {
      const first = await release(env);
      expect(first.err).toBe('');
      expect(first.code).toBe(0);
      expect(first.out).toMatch(/backup skipped: the database is empty/);
      expect(first.out).toMatch(/migrations applied: 001_foundation/);
      expect(first.out).toMatch(/owner bootstrap invite \d+ issued/);
      const second = await release(env);
      expect(second.code).toBe(0);
      expect(second.out).toMatch(/backup verified: scopely-backups\//);
      expect(second.out).toMatch(/migrations applied: none/);
      expect(second.out).toMatch(/not issued \(already_issued\)/);
      expect(s3.objects.size).toBe(1);
      for (const text of [first.out + first.err, second.out + second.err]) {
        expect(text).not.toContain(url);
        expect(text).not.toMatch(new RegExp(`very-secret-key-value|${token}|${tokenHash(token)}|founder@seller\\.test|BEGIN PUBLIC KEY`));
      }
      await withDb(url, async (c) => {
        expect((await c.query('SELECT kind FROM operator_events ORDER BY id')).rows.map((r) => r.kind))
          .toEqual(['bootstrap_invite_issued', 'backup_completed']);
      });
    } finally { await s3.close(); }
  });

  it('a half-configured or failing backup stops the deploy before any migration', async () => {
    // A database one migration behind (023 pending), as production is before this release.
    const url = await freshDb(true);
    await withDb(url, async (c) => {
      await c.query('DROP TABLE operator_events; DROP FUNCTION operator_events_append_only();');
      await c.query(`DELETE FROM schema_migrations WHERE version = '023_operator_events'`);
    });
    const half = await release({ DATABASE_URL: url, SCOPELY_BACKUP_S3_BUCKET: 'b-test' });
    expect(half.code).toBe(1);
    expect(half.err).toMatch(/set all of/);
    const s3 = fakeS3({ failPut: true });
    const endpoint = await s3.listen();
    try {
      const failing = await release({ DATABASE_URL: url, ...backupEnv(endpoint) });
      expect(failing.code).toBe(1);
      expect(failing.err).toMatch(/upload_failed.*Nothing was migrated/);
    } finally { await s3.close(); }
    await withDb(url, async (c) => {
      expect((await c.query(`SELECT to_regclass('scopely.operator_events') AS t`)).rows[0].t).toBeNull();
    });
    // Once storage works, the same deploy backs up, migrates and records the backup it took first.
    const ok = fakeS3();
    const okEndpoint = await ok.listen();
    try {
      const r = await release({ DATABASE_URL: url, ...backupEnv(okEndpoint) });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/backup verified[\s\S]*migrations applied: 023_operator_events/);
    } finally { await ok.close(); }
    await withDb(url, async (c) => {
      expect((await c.query('SELECT kind FROM operator_events')).rows.map((x) => x.kind)).toEqual(['backup_completed']);
    });
  });

  it('without backup variables it says so and still migrates', async () => {
    const url = await freshDb(false);
    const r = await release({ DATABASE_URL: url });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/backup not configured/);
    expect(existsSync(path.join(ROOT, 'railway.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(ROOT, 'railway.json'), 'utf8')).deploy.preDeployCommand).toEqual(['pnpm release']);
  });
});
