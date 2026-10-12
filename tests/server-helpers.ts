// The app server over the test's own transaction: each request's BEGIN/COMMIT/ROLLBACK becomes a
// savepoint, so a request sees the test's rows and the test's rollback undoes everything.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach } from 'vitest';
import type { Probe } from '../src/analysis/index.js';
import { DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { createHandler } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher } from './fix-helpers.js';
import { one } from './helpers.js';
import { SIGNING_KEY } from './site-helpers.js';

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = {
    BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv',
  };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}

/** Starts a server per test acting in `workspaceId` (default: the test's current workspace). Closed after each test. */
export function useServer(db: () => pg.Client) {
  let server: http.Server | null = null;
  afterEach(() => { server?.close(); server = null; });
  return async function start(opts: { workspaceId?: string; probe?: Probe } = {}) {
    const ws = opts.workspaceId ?? (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
    const logged: string[] = [];
    const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY,
      fetcher: new StubFetcher(), probe: opts.probe, editLinkTtlSeconds: 900, showLinkTtlSeconds: DEFAULT_SHOW_LINK_TTL_SECONDS,
      log: (l: string) => { logged.push(l); } });
    server?.close();
    server = http.createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, redirect: 'manual',
        headers: { 'x-scopely-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await r.text();
      return { status: r.status, text, json: () => JSON.parse(text) };
    };
    return { call, logged, workspaceId: ws };
  };
}
