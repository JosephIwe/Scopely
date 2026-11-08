// The one-time owner bootstrap (docs/OPERATIONS.md, "Operator path"). It replaces running
// `pnpm auth:invite --setup` inside the production container.
//
// How it works:
//   1. An operator makes a random invite token where nobody else sees it, and sets three service
//      variables: SCOPELY_BOOTSTRAP_INVITE_SHA256 (the token's sha256, never the token),
//      SCOPELY_BOOTSTRAP_EMAIL (the person who will own the first workspace) and
//      SCOPELY_BOOTSTRAP_EXPIRES_AT (an ISO time at most 72 hours ahead).
//   2. The release step (scripts/release.ts, Railway's pre-deploy command) calls
//      issueBootstrapInvite. While no owner can sign in, it stores an ordinary setup invite with
//      that hash, bound to that email, expiring then. Nothing else is created.
//   3. The person opens /app/#/join/<token> and signs up through acceptInvite, the same code
//      every invite uses: a password of their own, a new workspace, an owner membership.
//
// What keeps it narrow:
//   - The server never learns the token: the variables hold its sha256 only, so reading them
//     cannot be turned into a sign-up.
//   - It is a setup invite like any other: single use, email-bound, expiring (018's guards).
//   - It is issued only while no owner with a password exists, and acceptInvite refuses a
//     bootstrap invite once one does (assertBootstrapOpen). A hash already in the invite table is
//     never issued again, so an expired or used invite cannot be revived by redeploying.
//   - Every issue, refusal and completion is a row in operator_events (023).
//   - There is no route: nothing here is reachable from a request.
import type { Db } from '../tenancy/index.js';
import { AuthRejected, normalEmail } from '../auth/session.js';

export const BOOTSTRAP_CREATED_BY = 'bootstrap';
export const BOOTSTRAP_MAX_TTL_MS = 72 * 3600_000;
/** One advisory lock serialises issuing and accepting a bootstrap invite. */
const BOOTSTRAP_LOCK = 0x5c09e1b0;

export interface BootstrapConfig { inviteSha256: string; email: string; expiresAt: Date }

/**
 * Reads the bootstrap variables. None set: null. Some but not all, or any malformed: an error
 * naming the variable (never its value), so a half-made bootstrap is noticed.
 */
export function bootstrapConfigFromEnv(env: NodeJS.ProcessEnv): BootstrapConfig | null {
  const hash = env.SCOPELY_BOOTSTRAP_INVITE_SHA256?.trim() ?? '';
  const email = env.SCOPELY_BOOTSTRAP_EMAIL?.trim() ?? '';
  const exp = env.SCOPELY_BOOTSTRAP_EXPIRES_AT?.trim() ?? '';
  if (!hash && !email && !exp) return null;
  if (!hash || !email || !exp) throw new Error('Owner bootstrap: set all of SCOPELY_BOOTSTRAP_INVITE_SHA256, SCOPELY_BOOTSTRAP_EMAIL and SCOPELY_BOOTSTRAP_EXPIRES_AT, or none.');
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Owner bootstrap: SCOPELY_BOOTSTRAP_INVITE_SHA256 must be 64 lower-case hex characters (the sha256 of the token, not the token).');
  const e = normalEmail(email);
  if (!e) throw new Error('Owner bootstrap: SCOPELY_BOOTSTRAP_EMAIL is not an email address.');
  const at = new Date(exp);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(exp) || Number.isNaN(at.getTime())) throw new Error('Owner bootstrap: SCOPELY_BOOTSTRAP_EXPIRES_AT must be an ISO time, e.g. 2026-11-09T12:00:00Z.');
  return { inviteSha256: hash, email: e, expiresAt: at };
}

/** True once some workspace owner can sign in: the bootstrap's job is done. */
export async function ownerEstablished(db: Db): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM scopely.workspace_memberships m JOIN scopely.user_credentials c ON c.user_id = m.user_id
    WHERE m.role = 'owner' LIMIT 1`)).rows.length > 0;
}

export type BootstrapOutcome =
  | { status: 'issued'; inviteId: string; expiresAt: string }
  | { status: 'refused'; reason: 'owner_exists' | 'expiry_past' | 'expiry_too_far' | 'already_issued' };

/**
 * Stores the bootstrap setup invite when it is still allowed. Runs in the caller's transaction,
 * as the connection's own role (it writes workspace_invites and operator_events, which the
 * application role cannot see).
 */
export async function issueBootstrapInvite(db: Db, cfg: BootstrapConfig, now = new Date()): Promise<BootstrapOutcome> {
  await db.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);
  const refuse = async (reason: Extract<BootstrapOutcome, { status: 'refused' }>['reason']): Promise<BootstrapOutcome> => {
    // A re-deploy with the same variables is expected after a successful issue; it is not news.
    if (reason !== 'already_issued') {
      await db.query(`INSERT INTO scopely.operator_events (kind, reason, created_at) VALUES ('bootstrap_invite_refused', $1, $2)`, [reason, now]);
    }
    return { status: 'refused', reason };
  };
  if (await ownerEstablished(db)) return refuse('owner_exists');
  if ((await db.query('SELECT 1 FROM scopely.workspace_invites WHERE token_sha256 = $1', [cfg.inviteSha256])).rows.length) return refuse('already_issued');
  if (cfg.expiresAt.getTime() <= now.getTime()) return refuse('expiry_past');
  if (cfg.expiresAt.getTime() - now.getTime() > BOOTSTRAP_MAX_TTL_MS) return refuse('expiry_too_far');
  const r = (await db.query(`INSERT INTO scopely.workspace_invites (workspace_id, role, email, token_sha256, created_by, created_at, expires_at)
    VALUES (NULL, 'owner', $1, $2, $3, $4, $5) RETURNING id, expires_at`, [cfg.email, cfg.inviteSha256, BOOTSTRAP_CREATED_BY, now, cfg.expiresAt])).rows[0];
  await db.query(`INSERT INTO scopely.operator_events (kind, invite_id, expires_at, created_at) VALUES ('bootstrap_invite_issued', $1, $2, $3)`, [r.id, r.expires_at, now]);
  return { status: 'issued', inviteId: String(r.id), expiresAt: new Date(r.expires_at).toISOString() };
}

/**
 * Called by acceptInvite, inside its transaction, before a bootstrap invite is used: refuses it
 * once an owner can sign in, and the invite stays unused. The transaction rolls back, so the
 * server records the refusal afterwards in its own transaction (recordBootstrapRefusal).
 */
export async function assertBootstrapOpen(db: Db): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);
  if (await ownerEstablished(db)) {
    throw new AuthRejected(409, 'This setup link is no longer needed: the workspace owner has already been set up. Ask them for an invite.', 'bootstrap_closed');
  }
}

export async function recordBootstrapRefusal(db: Db, reason: string, now = new Date()): Promise<void> {
  await db.query(`INSERT INTO scopely.operator_events (kind, reason, created_at) VALUES ('bootstrap_accept_refused', $1, $2)`, [reason, now]);
}

export async function recordBootstrapCompleted(db: Db, inviteId: string, userId: string, workspaceId: string, now = new Date()): Promise<void> {
  await db.query(`INSERT INTO scopely.operator_events (kind, invite_id, user_id, workspace_id, created_at) VALUES ('bootstrap_completed', $1, $2, $3, $4)`,
    [inviteId, userId, workspaceId, now]);
}
