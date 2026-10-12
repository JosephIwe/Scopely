// Sign-in, sessions and invites (A40, migration 018). Everything here runs as the connection's own
// role with no workspace set: the application role cannot read credentials, sessions or invites.
// A request learns who it is from resolveSession, and only then acts in a workspace, through
// withWorkspace, as the application role.
//
// Rules this file keeps:
// - A token is 32 random bytes; the database keeps its sha256 only.
// - A session lasts SESSION_TTL_SECONDS at most and ends at sign-out (revoked_at).
// - A session's workspace is re-checked against workspace_memberships on every request, so a
//   removed member loses access at once. A browser never names its own workspace as proof: a
//   requested workspace is accepted only when the user is a member of it.
// - Wrong email and wrong password get the same answer and take the same time.
// - Nothing here logs an email, password, token or name.
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../tenancy/index.js';
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from './password.js';

export const SESSION_TTL_SECONDS = 14 * 24 * 3600;
export const INVITE_TTL_SECONDS = 7 * 24 * 3600;
export type Role = 'owner' | 'admin' | 'member';

export class AuthRejected extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, message: string, readonly reason = 'refused') { super(message); }
}

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const normalEmail = (v: unknown): string | null => {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
};
const clean = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max) : null;
};

export interface SessionView {
  sessionId: string;
  user: { userId: string; email: string; displayName: string | null };
  /** The workspace this session acts in, when the user is still a member of it. */
  workspace: { workspaceId: string; name: string; role: Role } | null;
  workspaces: { workspaceId: string; name: string; role: Role }[];
  expiresAt: string;
}

/** The person a request comes from, or null for a missing, unknown, expired or revoked token. */
export async function resolveSession(db: Db, token: string | null | undefined, now = new Date()): Promise<SessionView | null> {
  if (!token || !TOKEN_RE.test(token)) return null;
  const s = (await db.query(
    `SELECT s.id, s.user_id, s.workspace_id, s.expires_at, s.last_seen_at, u.email, u.display_name
       FROM scopely.user_sessions s JOIN scopely.users u ON u.id = s.user_id
      WHERE s.token_sha256 = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`, [tokenHash(token), now])).rows[0];
  if (!s) return null;
  const workspaces = (await db.query(
    `SELECT w.id::text AS id, w.name, m.role FROM scopely.workspace_memberships m JOIN scopely.workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 ORDER BY w.name, w.id`, [s.user_id])).rows.map((w) => ({ workspaceId: String(w.id), name: w.name as string, role: w.role as Role }));
  const current = s.workspace_id ? workspaces.find((w) => w.workspaceId === String(s.workspace_id)) ?? null : null;
  // Touch at most every five minutes, so reading does not write on every request.
  if (now.getTime() - new Date(s.last_seen_at).getTime() > 5 * 60_000) {
    await db.query('UPDATE scopely.user_sessions SET last_seen_at = $2 WHERE id = $1', [s.id, now]);
  }
  return {
    sessionId: String(s.id),
    user: { userId: String(s.user_id), email: s.email, displayName: s.display_name },
    workspace: current, workspaces, expiresAt: new Date(s.expires_at).toISOString(),
  };
}

async function startSession(db: Db, userId: string, now = new Date()): Promise<string> {
  const token = newToken();
  // The first workspace the user belongs to, by name; they can switch to any other membership.
  const ws = (await db.query(`SELECT m.workspace_id FROM scopely.workspace_memberships m JOIN scopely.workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = $1 ORDER BY w.name, w.id LIMIT 1`, [userId])).rows[0];
  await db.query(`INSERT INTO scopely.user_sessions (user_id, token_sha256, workspace_id, created_at, last_seen_at, expires_at)
    VALUES ($1, $2, $3, $4, $4, $4::timestamptz + make_interval(secs => $5))`, [userId, tokenHash(token), ws?.workspace_id ?? null, now, SESSION_TTL_SECONDS]);
  return token;
}

/** Signs a person in with their email and password. Returns the new session's token. */
export async function signIn(db: Db, emailIn: unknown, password: unknown, now = new Date()): Promise<string> {
  const email = normalEmail(emailIn);
  const pw = typeof password === 'string' ? password : '';
  const wrong = new AuthRejected(401, 'That email and password do not match an account.', 'bad_credentials');
  const row = email ? (await db.query(`SELECT u.id, c.password_hash FROM scopely.users u JOIN scopely.user_credentials c ON c.user_id = u.id
    WHERE lower(u.email) = $1`, [email])).rows[0] : null;
  if (!row || pw.length === 0 || pw.length > 1024) { await burnPasswordCheck(pw.slice(0, 1024)); throw wrong; }
  if (!(await verifyPassword(pw, row.password_hash))) throw wrong;
  return startSession(db, String(row.id), now);
}

/** Ends a session. Signing out twice is not an error. */
export async function signOut(db: Db, token: string | null | undefined, now = new Date()): Promise<void> {
  if (!token || !TOKEN_RE.test(token)) return;
  await db.query('UPDATE scopely.user_sessions SET revoked_at = $2 WHERE token_sha256 = $1 AND revoked_at IS NULL', [tokenHash(token), now]);
}

/** Moves a session to another of its user's workspaces. A workspace the user is not a member of reads as not found. */
export async function switchWorkspace(db: Db, session: SessionView, workspaceId: unknown): Promise<void> {
  const id = typeof workspaceId === 'string' || typeof workspaceId === 'number' ? String(workspaceId) : '';
  if (!/^\d{1,18}$/.test(id) || !session.workspaces.some((w) => w.workspaceId === id)) throw new AuthRejected(404, 'That workspace does not exist.', 'not_found');
  await db.query('UPDATE scopely.user_sessions SET workspace_id = $2 WHERE id = $1', [session.sessionId, id]);
}

// ---------------------------------------------------------------------------------- invites

export interface InviteInput { workspaceId: string | null; role: Role; email?: string | null; createdBy: string; createdByUserId?: string | null }

/** Creates an invite and returns its one-time token. The caller decides who may (see createMemberInvite). */
export async function createInvite(db: Db, input: InviteInput, now = new Date()): Promise<{ inviteId: string; token: string; expiresAt: string }> {
  if (input.workspaceId === null && input.role !== 'owner') throw new AuthRejected(400, 'A new-workspace invite makes its user the owner.');
  const email = input.email ? normalEmail(input.email) : null;
  if (input.email && !email) throw new AuthRejected(400, 'Enter a valid email address, or leave it empty.');
  const token = newToken();
  const r = (await db.query(`INSERT INTO scopely.workspace_invites (workspace_id, role, email, token_sha256, created_by_user_id, created_by, created_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7::timestamptz + make_interval(secs => $8)) RETURNING id, expires_at`,
    [input.workspaceId, input.role, email, tokenHash(token), input.createdByUserId ?? null, input.createdBy, now, INVITE_TTL_SECONDS])).rows[0];
  return { inviteId: String(r.id), token, expiresAt: new Date(r.expires_at).toISOString() };
}

/** An owner or admin invites someone into the session's own workspace. Admins cannot mint owners. */
export async function createMemberInvite(db: Db, session: SessionView, roleIn: unknown, email: unknown, now = new Date()) {
  const ws = session.workspace;
  if (!ws || (ws.role !== 'owner' && ws.role !== 'admin')) throw new AuthRejected(403, 'Only an owner or admin of this workspace can invite people.', 'forbidden');
  const role = (['admin', 'member', 'owner'] as const).find((r) => r === roleIn) ?? 'member';
  if (role === 'owner' && ws.role !== 'owner') throw new AuthRejected(403, 'Only an owner can invite another owner.', 'forbidden');
  return createInvite(db, { workspaceId: ws.workspaceId, role, email: typeof email === 'string' && email.trim() ? email : null,
    createdBy: session.user.displayName || session.user.email, createdByUserId: session.user.userId }, now);
}

async function openInvite(db: Db, token: unknown, now: Date, lock = false) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return (await db.query(`SELECT i.id, i.workspace_id, i.role, i.email, w.name AS workspace_name FROM scopely.workspace_invites i
    LEFT JOIN scopely.workspaces w ON w.id = i.workspace_id
    WHERE i.token_sha256 = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > $2${lock ? ' FOR UPDATE OF i' : ''}`, [tokenHash(token), now])).rows[0] ?? null;
}

/** What an invite link offers, without using it. Unknown, used and expired invites all read the same. */
export async function describeInvite(db: Db, token: unknown, now = new Date()) {
  const i = await openInvite(db, token, now);
  if (!i) throw new AuthRejected(404, 'This invite link is not valid. It may have been used or expired; ask for a new one.', 'invite_invalid');
  return { kind: i.workspace_id ? 'join' as const : 'setup' as const, workspaceName: i.workspace_name as string | null, role: i.role as Role, emailRequired: Boolean(i.email) };
}

const slugFor = (name: string) => `${name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace'}-${randomBytes(3).toString('hex')}`;

export interface AcceptInput { token?: unknown; email: unknown; password: unknown; displayName?: unknown; workspaceName?: unknown }

/**
 * Uses an invite (or, when open sign-up is on, no invite) to create an account and start a session.
 * A setup invite, or open sign-up, creates a new workspace with this person as owner. An existing
 * account joins with its own password; an invite never resets anyone's password.
 */
export async function acceptInvite(db: Db, input: AcceptInput, opts: { openSignup: boolean }, now = new Date()): Promise<string> {
  const email = normalEmail(input.email);
  if (!email) throw new AuthRejected(400, 'Enter a valid email address.');
  const pw = typeof input.password === 'string' ? input.password : '';
  const invite = input.token ? await openInvite(db, input.token, now, true) : null;
  if (input.token && !invite) throw new AuthRejected(404, 'This invite link is not valid. It may have been used or expired; ask for a new one.', 'invite_invalid');
  if (!invite && !opts.openSignup) throw new AuthRejected(403, 'Scopely is invite-only. Ask a workspace owner for an invite link.', 'invite_required');
  if (invite?.email && invite.email !== email) throw new AuthRejected(403, 'This invite is for a different email address.', 'invite_email');

  const existing = (await db.query(`SELECT u.id, c.password_hash FROM scopely.users u LEFT JOIN scopely.user_credentials c ON c.user_id = u.id
    WHERE lower(u.email) = $1`, [email])).rows[0];
  let userId: string;
  if (existing?.password_hash) {
    if (!(await verifyPassword(pw.slice(0, 1024), existing.password_hash))) throw new AuthRejected(401, 'An account with this email exists. Enter its password to accept.', 'bad_credentials');
    userId = String(existing.id);
  } else {
    // A person recorded before sign-in existed (a provisioned owner, a CLI user) has memberships
    // already. Setting their first password needs an invite addressed to that exact email;
    // otherwise anyone could claim the account and its workspaces.
    if (existing && invite?.email !== email) {
      throw new AuthRejected(409, 'An account with this email already exists. Ask a workspace owner for an invite addressed to it.', 'account_exists');
    }
    const problem = passwordProblem(pw);
    if (problem) throw new AuthRejected(400, problem, 'weak_password');
    userId = existing ? String(existing.id) : String((await db.query(`INSERT INTO scopely.users (email, display_name) VALUES ($1, $2) RETURNING id`,
      [email, clean(input.displayName, 120)])).rows[0].id);
    await db.query(`INSERT INTO scopely.user_credentials (user_id, password_hash, updated_at) VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = EXCLUDED.updated_at`, [userId, await hashPassword(pw), now]);
  }

  let workspaceId: string;
  if (invite?.workspace_id) {
    workspaceId = String(invite.workspace_id);
    await db.query(`INSERT INTO scopely.workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId, invite.role]);
  } else {
    const name = clean(input.workspaceName, 80);
    if (!name) throw new AuthRejected(400, 'Name your workspace.');
    workspaceId = String((await db.query('INSERT INTO scopely.workspaces (slug, name) VALUES ($1, $2) RETURNING id', [slugFor(name), name])).rows[0].id);
    await db.query(`INSERT INTO scopely.workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [workspaceId, userId]);
  }
  if (invite) await db.query('UPDATE scopely.workspace_invites SET used_at = $2, used_by_user_id = $3 WHERE id = $1', [invite.id, now, userId]);

  const token = newToken();
  await db.query(`INSERT INTO scopely.user_sessions (user_id, token_sha256, workspace_id, created_at, last_seen_at, expires_at)
    VALUES ($1, $2, $3, $4, $4, $4::timestamptz + make_interval(secs => $5))`, [userId, tokenHash(token), workspaceId, now, SESSION_TTL_SECONDS]);
  return token;
}

/** The members of the session's workspace (names and roles; emails only to owners and admins). */
export async function listMembers(db: Db, session: SessionView) {
  const ws = session.workspace;
  if (!ws) throw new AuthRejected(403, 'Choose a workspace first.', 'no_workspace');
  const rows = (await db.query(`SELECT u.id, u.email, u.display_name, m.role, m.created_at FROM scopely.workspace_memberships m JOIN scopely.users u ON u.id = m.user_id
    WHERE m.workspace_id = $1 ORDER BY m.created_at, u.id`, [ws.workspaceId])).rows;
  const seeEmail = ws.role === 'owner' || ws.role === 'admin';
  return rows.map((r) => ({ userId: String(r.id), name: r.display_name ?? null, email: seeEmail || String(r.id) === session.user.userId ? r.email : null, role: r.role as Role,
    joinedAt: new Date(r.created_at).toISOString() }));
}
