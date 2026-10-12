// Runs the Build Workspace locally for one workspace. Authentication is open decision B10, so the
// server acts in the workspace it is started with and listens on localhost only by default.
//
//   DATABASE_URL=... SCOPELY_WORKSPACE_ID=<id> pnpm serve
//
// Optional: PORT (4310), HOST (127.0.0.1), SCOPELY_STORAGE_DIR (.scopely/storage),
// PREVIEW_SIGNING_KEY (at least 32 characters; without it a random key is used and preview links
// stop working when the server restarts), SHOW_LINK_TTL_HOURS (72).
//
// Discovery (Slice 10): Find replays recorded Clay responses (fixtures/providers/clay) unless
// SCOPELY_CLAY_LIVE=1, which calls Clay's Public API with the workspace's own Public API key
// (header clay-api-key). A live search then
// needs an ACTIVE 'discovery' provider connection for clay whose credential_ref
// secretref:ws/<id>/<name> names the server variable SCOPELY_SECRET_WS<id>_<NAME>. Nothing else
// ever reads that variable, and it never reaches a browser.
//
// Prospect intelligence (Slice 12): the Case File's Find people replays recorded Clay people
// lookups (fixtures/providers/clay/demo-people-search.json, synthetic people at the demo's .example
// businesses) unless SCOPELY_CLAY_LIVE=1. A live lookup needs an ACTIVE provider connection for
// clay with the 'prospects' scope and a customer key, exactly like discovery. Over the Public API a live
// people lookup is refused, unsent, until Clay's exact-company filter is confirmed. Nothing paid is called.
//
// Analysis (Slice 11): analysing a selected business requests its own website with the SSRF-safe
// probe (src/analysis/fetch.ts); reserved .example hosts are answered from fixtures/demo-pages.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import pg from 'pg';
import { databaseUrl } from '../src/db/client.js';
import { pendingMigrations } from '../src/db/migrate.js';
import { DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { DemoAwarePageFetcher } from '../src/build/fix/index.js';
import { DemoAwareProbe } from '../src/analysis/index.js';
import { createHandler } from '../src/server/app.js';
import { FileObjectStore } from '../src/storage/index.js';
import {
  ClayBusinessDiscoveryAdapter, ClayPublicApiTransport, ClayProspectAdapter, DiscoveryProviderRegistry, EnvSecretResolver, ProspectProviderRegistry, RecordedClayTransport,
  type ClayRecording,
} from '../src/providers/index.js';

const workspaceId = process.env.SCOPELY_WORKSPACE_ID;
if (!workspaceId || !/^\d+$/.test(workspaceId)) {
  console.error('Set SCOPELY_WORKSPACE_ID to the workspace this server acts in. There is no default workspace.');
  process.exit(1);
}
let signingKey = process.env.PREVIEW_SIGNING_KEY ?? '';
if (signingKey.length < 32) {
  signingKey = randomBytes(32).toString('base64url');
  console.warn('PREVIEW_SIGNING_KEY is not set; using a random key for this process. Preview links end when the server stops.');
}
const showHours = Number(process.env.SHOW_LINK_TTL_HOURS ?? DEFAULT_SHOW_LINK_TTL_SECONDS / 3600);
if (!Number.isFinite(showHours) || showHours <= 0 || showHours > 24 * 30) {
  console.error('SHOW_LINK_TTL_HOURS must be a number of hours between 0 and 720.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: databaseUrl(), max: 8 });
// A database behind the code is reported here, by name; the server never migrates it.
try {
  const pending = await pendingMigrations(pool);
  if (pending.length) console.warn(`The database has not applied ${pending.length} migration(s): ${pending.join(', ')}. Pages that need them will say so. Run pnpm migrate, then restart.`);
} catch (err) {
  console.warn(`Could not check the database's migrations (${(err as { code?: string }).code ?? 'no code'}).`);
}
const live = process.env.SCOPELY_CLAY_LIVE === '1';
const clay = live ? new ClayPublicApiTransport()
  : new RecordedClayTransport(['2026-10-05-company-search.json', '2026-10-05-company-search-country.json', 'demo-people-search.json'].flatMap((f) =>
    (JSON.parse(readFileSync(new URL(`../fixtures/providers/clay/${f}`, import.meta.url), 'utf8')) as { searches: ClayRecording[] }).searches));
const secrets = live ? new EnvSecretResolver() : undefined;
const discovery = { providers: new DiscoveryProviderRegistry().register(new ClayBusinessDiscoveryAdapter(clay)), secrets };
const prospects = { providers: new ProspectProviderRegistry().register(new ClayProspectAdapter(clay)), secrets };
const handler = createHandler({
  pool, workspaceId, signingKey,
  store: new FileObjectStore(process.env.SCOPELY_STORAGE_DIR ?? '.scopely/storage'),
  editLinkTtlSeconds: 15 * 60,
  showLinkTtlSeconds: Math.round(showHours * 3600),
  // The Fix Builder captures pages live, except the demo's reserved .example pages (fixtures/demo-pages).
  fetcher: new DemoAwarePageFetcher(),
  probe: new DemoAwareProbe(),
  discovery,
  prospects,
});
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? '127.0.0.1';
createServer((req, res) => { void handler(req, res); }).listen(port, host, () => {
  console.log(`Build Workspace on http://${host}:${port} (workspace ${workspaceId}); discovery: Clay ${live ? 'live' : 'recorded responses'}`);
});
