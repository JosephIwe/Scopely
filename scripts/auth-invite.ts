// Issues an invite link (A40). The operator's way in: run against the target database to let the
// first person create their workspace, or to add someone to an existing workspace. Prints the
// link once; only its sha256 is stored. Scopely sends no email.
//
//   pnpm auth:invite --setup [--email person@company.com]                 # a new workspace, as its owner
//   pnpm auth:invite --workspace <id> [--role member|admin|owner] [--email ...]
//
// Optional: SCOPELY_PUBLIC_URL (e.g. https://app.example.com) to print a full link.
import { parseArgs } from 'node:util';
import { connect } from '../src/db/client.js';
import { createInvite } from '../src/auth/index.js';

const { values } = parseArgs({ options: { setup: { type: 'boolean' }, workspace: { type: 'string' }, role: { type: 'string' }, email: { type: 'string' } } });
if (Boolean(values.setup) === Boolean(values.workspace)) {
  console.error('Use --setup (a new workspace) or --workspace <id> (join an existing one).');
  process.exit(1);
}
const role = (values.setup ? 'owner' : values.role ?? 'member') as 'owner' | 'admin' | 'member';
if (!['owner', 'admin', 'member'].includes(role)) { console.error('--role is member, admin or owner.'); process.exit(1); }
if (values.workspace && !/^\d+$/.test(values.workspace)) { console.error('--workspace is a workspace id.'); process.exit(1); }

const db = await connect();
try {
  await db.query('BEGIN');
  if (values.workspace && !(await db.query('SELECT 1 FROM scopely.workspaces WHERE id = $1', [values.workspace])).rows.length) {
    throw new Error(`There is no workspace ${values.workspace}.`);
  }
  const inv = await createInvite(db, { workspaceId: values.workspace ?? null, role, email: values.email ?? null, createdBy: 'cli' });
  await db.query('COMMIT');
  const base = (process.env.SCOPELY_PUBLIC_URL ?? '').replace(/\/+$/, '');
  console.log(`Invite ${inv.inviteId} (${values.setup ? 'new workspace, owner' : `workspace ${values.workspace}, ${role}`}${values.email ? ', email-bound' : ''}), valid until ${inv.expiresAt}:`);
  console.log(`${base}/app/#/join/${inv.token}`);
} catch (err) {
  await db.query('ROLLBACK').catch(() => undefined);
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
