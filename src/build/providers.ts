// Provider connections: which model provider a workspace's build runs may use, and whether the
// workspace brings its own key (CUSTOMER_KEY) or uses Scopely's (SCOPELY_MANAGED). Records only.
// No provider is authenticated to and no secret store exists: `credentialRef` names a future
// secret (secretref:ws/<workspace>/<name>) and the database refuses anything that looks like a key.
//
// Ownership is the workspace today. Whether a user may own a connection too is open decision B14;
// it would land as a nullable owner column, additively.
import type { Db } from '../tenancy/index.js';

export interface ProviderConnectionInput {
  provider: string;
  mode: 'SCOPELY_MANAGED' | 'CUSTOMER_KEY';
  scopes: ('build' | 'analysis')[];
  credentialRef?: string | null;
  displayName?: string | null;
  createdByUserId?: string | null;
}

export async function registerProviderConnection(db: Db, c: ProviderConnectionInput): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO scopely.provider_connections (provider, mode, scopes, credential_ref, display_name, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [c.provider, c.mode, c.scopes, c.credentialRef ?? null, c.displayName ?? null, c.createdByUserId ?? null]);
  return r.rows[0]!.id;
}

export async function activateProviderConnection(db: Db, connectionId: string, at: string): Promise<void> {
  await db.query(`UPDATE scopely.provider_connections SET state = 'ACTIVE', activated_at = $2
                   WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [connectionId, at]);
}

export async function revokeProviderConnection(db: Db, connectionId: string, at: string): Promise<void> {
  await db.query(`UPDATE scopely.provider_connections SET state = 'REVOKED', revoked_at = $2
                   WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [connectionId, at]);
}

export interface ProviderConnection {
  connectionId: string;
  provider: string;
  mode: 'SCOPELY_MANAGED' | 'CUSTOMER_KEY';
  state: 'PENDING' | 'ACTIVE' | 'REVOKED' | 'ERROR';
  scopes: string[];
  displayName: string | null;
  /** Whether a secret reference is recorded. The reference itself is for workers, not screens. */
  hasCredentialRef: boolean;
  /** Who pays for model use through this connection. */
  billedTo: 'SCOPELY' | 'WORKSPACE';
  createdAt: string;
}

export async function listProviderConnections(db: Db): Promise<ProviderConnection[]> {
  const r = await db.query(`SELECT * FROM scopely.provider_connections WHERE workspace_id = scopely.current_workspace_id() ORDER BY id`);
  return r.rows.map((x) => ({
    connectionId: String(x.id), provider: x.provider, mode: x.mode, state: x.state, scopes: x.scopes, displayName: x.display_name,
    hasCredentialRef: x.credential_ref !== null, billedTo: x.mode === 'CUSTOMER_KEY' ? 'WORKSPACE' : 'SCOPELY',
    createdAt: new Date(x.created_at).toISOString(),
  }));
}
