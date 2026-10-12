// Applies migrations/ in order (src/db/migrate.ts). With SCOPELY_DB_APP_ROLE set, it then makes sure
// that non-owner role exists and may read and write the scopely schema, and that the connecting
// role may switch to it, so the server's requests run under row-level security (A40). Re-running
// is safe: nothing is applied or granted twice.
import { connect } from '../src/db/client.js';
import { ensureAppRole, migrate } from '../src/db/migrate.js';

const client = await connect();
try {
  const r = await migrate(client);
  console.log(`applied: ${r.applied.join(', ') || 'none'}; already applied: ${r.skipped.length}`);
  const role = process.env.SCOPELY_DB_APP_ROLE;
  if (role) {
    await ensureAppRole(client, role);
    console.log(`application role ${role}: ready`);
  }
} finally {
  await client.end();
}
