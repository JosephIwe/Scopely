// The tenant boundary. Every commercial row belongs to one workspace; a request acts inside
// exactly one workspace by setting scopely.workspace_id for its transaction. There is no default
// workspace, user or sender: with no workspace set, writes that need one fail and reads through
// the API return nothing.
//
// Authentication is not built. A later API layer authenticates a user, checks their membership
// (isMember) and then calls withWorkspace for the request.
import type pg from 'pg';

export type Db = pg.Client | pg.PoolClient;

export interface WorkspaceInput {
  slug: string;
  name: string;
  /** The first member, made owner. Optional: a workspace can be created before anyone joins. */
  owner?: { email: string; displayName?: string };
}

/**
 * Creates a workspace (and optionally its owner). This is a provisioning step, run by the
 * service role, not by a request inside some other workspace.
 */
export async function createWorkspace(db: Db, w: WorkspaceInput): Promise<{ workspaceId: string; ownerUserId: string | null }> {
  const ws = (await db.query<{ id: string }>('INSERT INTO scopely.workspaces (slug, name) VALUES ($1, $2) RETURNING id',
    [w.slug, w.name])).rows[0]!;
  if (!w.owner) return { workspaceId: ws.id, ownerUserId: null };
  const userId = await upsertUser(db, w.owner.email, w.owner.displayName);
  await addMember(db, ws.id, userId, 'owner');
  return { workspaceId: ws.id, ownerUserId: userId };
}

export async function upsertUser(db: Db, email: string, displayName?: string): Promise<string> {
  const found = await db.query<{ id: string }>('SELECT id FROM scopely.users WHERE lower(email) = lower($1)', [email]);
  if (found.rows[0]) return found.rows[0].id;
  return (await db.query<{ id: string }>('INSERT INTO scopely.users (email, display_name) VALUES ($1, $2) RETURNING id',
    [email, displayName ?? null])).rows[0]!.id;
}

export async function addMember(db: Db, workspaceId: string, userId: string, role: 'owner' | 'admin' | 'member'): Promise<void> {
  await db.query('INSERT INTO scopely.workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspaceId, userId, role]);
}

export async function isMember(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM scopely.workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  return r.rows.length === 1;
}

/**
 * Sets the request's workspace for the rest of the caller's transaction and runs `fn`. The
 * caller owns the transaction (BEGIN ... COMMIT); outside one the setting would not hold.
 */
export async function withWorkspace<T>(db: Db, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  if (!/^\d+$/.test(workspaceId)) throw new Error('workspaceId must be a numeric id');
  await db.query(`SELECT set_config('scopely.workspace_id', $1, true)`, [workspaceId]);
  return fn();
}

/** The workspace the current transaction acts in, or null. */
export async function currentWorkspaceId(db: Db): Promise<string | null> {
  return (await db.query<{ id: string | null }>('SELECT scopely.current_workspace_id() AS id')).rows[0]!.id;
}

export async function requireWorkspace(db: Db): Promise<string> {
  const id = await currentWorkspaceId(db);
  if (!id) throw new Error('no workspace is set for this request');
  return id;
}
