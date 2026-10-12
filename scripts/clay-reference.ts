// Fetches Clay's query-mode reference (GET /search/query-mode/reference) with a workspace's own
// Clay Public API key, through the same connection and secret resolver a live search uses. It is
// free and read-only: no search is created, nothing is enriched and nothing is written to the
// database. The reference is saved under .scopely/ (git-ignored); only its size and top-level keys
// are printed. The key is never printed.
//
//   DATABASE_URL=... SCOPELY_WORKSPACE_ID=<id> SCOPELY_SECRET_WS<id>_<NAME>=... pnpm clay:reference
//
// The workspace needs an ACTIVE clay CUSTOMER_KEY connection with the 'prospects' (or 'discovery')
// scope whose credential_ref secretref:ws/<id>/<name> names that server variable.
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { databaseUrl } from '../src/db/client.js';
import { ClayPublicApiTransport, EnvSecretResolver, PROVIDER_ERROR_WORDS, asProviderError, connectionCredential } from '../src/providers/index.js';
import { withWorkspace } from '../src/tenancy/index.js';

const workspaceId = process.env.SCOPELY_WORKSPACE_ID;
if (!workspaceId || !/^\d+$/.test(workspaceId)) {
  console.error('Set SCOPELY_WORKSPACE_ID to the workspace whose Clay key to use. There is no default workspace.');
  process.exit(1);
}
const out = process.argv[2] ?? `.scopely/clay-query-reference-ws${workspaceId}.json`;
const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();
try {
  await client.query('BEGIN');
  const reference = await withWorkspace(client, workspaceId, async () => {
    const secrets = new EnvSecretResolver();
    const cred = await connectionCredential(client, 'clay', 'prospects', secrets) ?? await connectionCredential(client, 'clay', 'discovery', secrets);
    if (!cred) throw new Error('This workspace has no ACTIVE clay CUSTOMER_KEY connection with the prospects or discovery scope.');
    return cred.withSecret((key) => new ClayPublicApiTransport().queryReference(key));
  });
  await client.query('ROLLBACK');
  mkdirSync(out.replace(/\/[^/]*$/, '') || '.', { recursive: true });
  const text = typeof reference === 'string' ? reference : JSON.stringify(reference, null, 2);
  writeFileSync(out, text);
  const keys = reference && typeof reference === 'object' && !Array.isArray(reference) ? Object.keys(reference) : [];
  console.log(`Saved Clay's query reference (${text.length} characters) to ${out}. Top-level keys: ${keys.join(', ') || '(none)'}`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  const e = asProviderError(err);
  console.error(err instanceof Error && !('code' in err) ? err.message : `${PROVIDER_ERROR_WORDS[e.code]} (${e.code}${e.detail ? `: ${e.detail}` : ''})`);
  process.exitCode = 1;
} finally {
  await client.end();
}
