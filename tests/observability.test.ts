// P2: the minimum production observability. An unexpected error is logged as one actionable line
// and, when SCOPELY_ERROR_DSN is set, reported; neither ever carries a value a request, a page or a
// row supplied (Rule 11). Stable ids (request, workspace, user) stand in for sensitive values.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { createHandler } from '../src/server/app.js';
import { EnvelopeReporter, describeError, errorLine, parseDsn, reporterFromEnv, routeOf, type ErrorReport, type ErrorReporter } from '../src/server/observe.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher } from './fix-helpers.js';
import { one, useDb } from './helpers.js';
import { SIGNING_KEY } from './site-helpers.js';

const { db } = useDb();
const PII = ['owner@harbourclinic.co.uk', 'harbourclinic.co.uk', '07700 900461'];

function poolOver(client: pg.Client, rewrite: (sql: string) => string = (s) => s): pg.Pool {
  const map: Record<string, string> = { BEGIN: 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv' };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? rewrite(sql), params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

class Collect implements ErrorReporter {
  readonly name = 'collect';
  reports: ErrorReport[] = [];
  report(e: ErrorReport) { this.reports.push(e); }
}

async function start(rewrite?: (sql: string) => string) {
  const ws = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
  const logged: string[] = [];
  const reporter = new Collect();
  const handler = createHandler({ pool: poolOver(db(), rewrite), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY, reporter,
    fetcher: new StubFetcher(), editLinkTtlSeconds: 900, showLinkTtlSeconds: DEFAULT_SHOW_LINK_TTL_SECONDS, log: (l: string) => { logged.push(l); } });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, rid: r.headers.get('x-request-id'), body: await r.json() as Record<string, unknown> }; };
  return { get, logged, reporter, ws };
}

describe('error payloads carry no PII', () => {
  it('drops the message, detail and parameters of a Postgres error, keeping its code and schema names', () => {
    const err = Object.assign(new Error(`duplicate key value violates unique constraint "businesses_domain_key"`), {
      name: 'DatabaseError', code: '23505', constraint: 'businesses_domain_key', table: 'businesses',
      detail: `Key (domain)=(${PII[1]}) already exists.`, hint: PII[0], parameters: PII,
    });
    const shape = describeError(err);
    expect(shape).toMatchObject({ name: 'DatabaseError', code: '23505', constraint: 'businesses_domain_key', table: 'businesses' });
    expect(shape.frames[0]).toMatch(/^.*tests\/observability\.test\.ts:\d+$/);
    for (const v of [...PII, 'duplicate key']) expect(JSON.stringify(shape)).not.toContain(v);
  });

  it('refuses a code, constraint or table that looks like a value', () => {
    const shape = describeError(Object.assign(new Error('x'), { code: PII[0], constraint: 'Key (a)=(b)', table: 'Robert"); DROP' }));
    expect(shape).toMatchObject({ code: null, constraint: null, table: null });
  });

  it('routes replace ids and tokens; the query string never reaches a log', () => {
    expect(routeOf('/api/opportunities/123/outcomes')).toBe('/api/opportunities/:id/outcomes');
    expect(routeOf('/p/abcdefghijklmnopqrstuvwxyz0123')).toBe('/p/:token');
    expect(routeOf('/api/opportunities')).toBe('/api/opportunities');
  });

  it('a failed request logs one actionable line and reports it, with ids instead of values', async () => {
    // The feed query fails with a Postgres error whose message quotes a contact detail.
    const s = await start((sql) => (sql.includes('v_opportunity_feed') ? `SELECT ('${PII[0]}')::int` : sql));
    const r = await s.get('/api/opportunities?q=owner@harbourclinic.co.uk');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Something went wrong. Nothing was changed.', requestId: r.rid });
    const line = s.logged.find((l) => l.startsWith('error '))!;
    expect(line).toMatch(new RegExp(`^error GET /api/opportunities 22P02 rid=${r.rid} ws=${s.ws} status=500 err=\\w+ at=\\S+:\\d+$`));
    expect(s.reporter.reports).toHaveLength(1);
    expect(s.reporter.reports[0]).toMatchObject({ requestId: r.rid, route: '/api/opportunities', status: 500, workspaceId: s.ws, source: 'request',
      error: { code: '22P02' } });
    const everything = JSON.stringify([s.logged, s.reporter.reports, new EnvelopeReporter('https://k@errors.example/1').envelope(s.reporter.reports[0]!)]);
    for (const v of PII) expect(everything).not.toContain(v);
    expect(everything).not.toContain('invalid input syntax');
  });

  it('a refused request (4xx) is not reported, and every response carries a request id', async () => {
    const s = await start();
    const r = await s.get('/api/opportunities/999999999');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.rid).toMatch(/^[0-9a-f]{12}$/);
    expect(s.reporter.reports).toHaveLength(0);
    expect(s.logged.some((l) => l.endsWith(`rid=${r.rid}`) && l.includes('/api/opportunities/:id'))).toBe(true);
  });
});

describe('error reporting is behind an environment variable', () => {
  it('is off when SCOPELY_ERROR_DSN is unset or blank', () => {
    expect(reporterFromEnv({})).toBeNull();
    expect(reporterFromEnv({ SCOPELY_ERROR_DSN: '  ' })).toBeNull();
    expect(reporterFromEnv({ SCOPELY_ERROR_DSN: 'https://abc@o1.ingest.example/42' })?.name).toBe('envelope');
  });

  it('refuses a DSN that is not https://<key>@<host>/<project>, instead of silently dropping errors', () => {
    for (const bad of ['nope', 'http://k@h/1', 'https://h/1', 'https://k@h/']) expect(() => parseDsn(bad)).toThrow(/SCOPELY_ERROR_DSN/);
    expect(parseDsn('https://abc@o1.ingest.example/42')).toEqual({ endpoint: 'https://o1.ingest.example/api/42/envelope/', key: 'abc' });
  });

  it('posts an envelope, never throws when the tracker is down, and caps events per minute', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    let t = 1_000_000;
    const rep = new EnvelopeReporter('https://abc@o1.ingest.example/42', { environment: 'production', release: 'abc123', perMinute: 2, now: () => t,
      fetch: async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); throw new Error('down'); } });
    const r: ErrorReport = { requestId: 'r1', route: '/api/x/:id', method: 'GET', status: 500, workspaceId: '7', userId: '9', source: 'request',
      error: { name: 'TypeError', code: null, constraint: null, table: null, frames: ['handle src/server/app.ts:10'] } };
    rep.report(r); rep.report(r); rep.report(r);
    await new Promise((s) => setTimeout(s, 10));
    expect(calls).toHaveLength(2);
    expect(rep.dropped).toBe(1);
    expect(calls[0]!.url).toBe('https://o1.ingest.example/api/42/envelope/');
    expect(calls[0]!.headers['x-sentry-auth']).toContain('sentry_key=abc');
    const event = JSON.parse(calls[0]!.body.trim().split('\n')[2]!);
    expect(event).toMatchObject({ level: 'error', environment: 'production', release: 'abc123', user: { id: '9' },
      tags: { request_id: 'r1', route: '/api/x/:id', workspace_id: '7', status: '500' } });
    expect(event.exception.values[0].stacktrace.frames[0]).toEqual({ filename: 'src/server/app.ts', lineno: 10, function: 'handle' });
    expect(event).not.toHaveProperty('request');
    t += 60_000;
    rep.report(r);
    expect(calls).toHaveLength(3);
  });

  it('a process-level failure is a line with no route values', () => {
    const line = errorLine({ requestId: null, route: 'unhandledRejection', method: null, status: null, workspaceId: null, userId: null, source: 'process',
      error: describeError(new Error(PII[0])) });
    expect(line).toMatch(/^error process - err=Error at=\S+$/);
  });

  it('the server wires the reporter and process handlers from the environment', () => {
    const serve = readFileSync('scripts/serve.ts', 'utf8');
    expect(serve).toContain('reporterFromEnv()');
    expect(serve).toMatch(/process\.on\('unhandledRejection'/);
    expect(serve).toMatch(/process\.on\('uncaughtException'/);
  });
});

describe('uptime monitoring', () => {
  it('a scheduled workflow checks /healthz in production and fails loudly', () => {
    const wf = readFileSync('.github/workflows/uptime.yml', 'utf8');
    expect(wf).toMatch(/schedule:\s*\n\s*- cron: '\*\/15 \* \* \* \*'/);
    expect(wf).toContain('/healthz');
    expect(wf).not.toMatch(/secrets\./);
  });
});
