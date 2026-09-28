import { connect } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';

const client = await connect();
try {
  const r = await migrate(client);
  console.log(`applied: ${r.applied.join(', ') || 'none'}; already applied: ${r.skipped.length}`);
} finally {
  await client.end();
}
