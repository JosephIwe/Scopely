// Runs the Build Workspace locally for one workspace. Authentication is open decision B10, so the
// server acts in the workspace it is started with and listens on localhost only by default.
//
//   DATABASE_URL=... SCOPELY_WORKSPACE_ID=<id> pnpm serve
//
// Optional: PORT (4310), HOST (127.0.0.1), SCOPELY_STORAGE_DIR (.scopely/storage),
// PREVIEW_SIGNING_KEY (at least 32 characters; without it a random key is used and preview links
// stop working when the server restarts), SHOW_LINK_TTL_HOURS (72).
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { databaseUrl } from '../src/db/client.js';
import { DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { createHandler } from '../src/server/app.js';
import { FileObjectStore } from '../src/storage/index.js';

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
const handler = createHandler({
  pool, workspaceId, signingKey,
  store: new FileObjectStore(process.env.SCOPELY_STORAGE_DIR ?? '.scopely/storage'),
  editLinkTtlSeconds: 15 * 60,
  showLinkTtlSeconds: Math.round(showHours * 3600),
});
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? '127.0.0.1';
createServer((req, res) => { void handler(req, res); }).listen(port, host, () => {
  console.log(`Build Workspace on http://${host}:${port} (workspace ${workspaceId})`);
});
