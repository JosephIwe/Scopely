// Sending mailboxes are workspace connections, never an application setting. Scopely has no
// global or default sender: a message is marked sent only from a mailbox of its own workspace,
// and the sender address is captured from that mailbox by the database.
//
// Provider OAuth (Google Workspace first, Microsoft 365 later) is not built. A MANUAL mailbox is
// registered so that sends made by hand from it can be recorded.
import type { Db } from '../tenancy/index.js';

export type MailboxProvider = 'google_workspace' | 'microsoft_365';
export type MailboxState = 'MANUAL' | 'PENDING' | 'CONNECTED' | 'DISCONNECTED' | 'REVOKED' | 'ERROR';

export interface MailboxInput {
  provider: MailboxProvider;
  email: string;
  displayName?: string;
  connectedByUserId?: string;
}

/** Registers a mailbox in the current workspace for recording manual sends. */
export async function registerManualMailbox(db: Db, m: MailboxInput): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO scopely.mailbox_connections (provider, email, display_name, state, connected_by_user_id)
     VALUES ($1, $2, $3, 'MANUAL', $4) RETURNING id`,
    [m.provider, m.email, m.displayName ?? null, m.connectedByUserId ?? null])).rows[0]!.id;
}

export async function disconnectMailbox(db: Db, mailboxId: string, at: string): Promise<void> {
  await db.query(`UPDATE scopely.mailbox_connections SET state = 'DISCONNECTED', disconnected_at = $2
                   WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [mailboxId, at]);
}

export interface Mailbox { id: string; provider: MailboxProvider; email: string; displayName: string | null; state: MailboxState }

/** The current workspace's mailboxes. Never another workspace's. */
export async function listMailboxes(db: Db): Promise<Mailbox[]> {
  const r = await db.query(
    `SELECT id, provider, email, display_name, state FROM scopely.mailbox_connections
      WHERE workspace_id = scopely.current_workspace_id() ORDER BY id`);
  return r.rows.map((m) => ({ id: String(m.id), provider: m.provider, email: m.email, displayName: m.display_name, state: m.state }));
}
