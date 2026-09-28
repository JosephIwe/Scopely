// Each test runs inside a transaction that is rolled back, so tests never see each other's
// rows. Deferred constraint triggers are forced with SET CONSTRAINTS ALL IMMEDIATE.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, inject } from 'vitest';

export function useDb(): { db: () => pg.Client } {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: inject('dbUrl') });
    await client.connect();
    await client.query('SET search_path = scopely, public');
  });
  afterAll(async () => { await client.end(); });
  beforeEach(async () => {
    await client.query('BEGIN');
    await enterNewWorkspace(client, 'test');
  });
  afterEach(async () => { await client.query('ROLLBACK'); });
  return { db: () => client };
}

/** Creates a workspace and makes it the transaction's request context (scopely.workspace_id). */
export async function enterNewWorkspace(db: pg.Client, label: string): Promise<string> {
  const slug = `${label}-${Math.random().toString(36).slice(2, 10)}`;
  const ws = await one<{ id: string }>(db, 'INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id', [slug, label]);
  await useWorkspace(db, ws.id);
  return ws.id;
}

export async function useWorkspace(db: pg.Client, workspaceId: string): Promise<void> {
  await db.query(`SELECT set_config('scopely.workspace_id', $1, true)`, [workspaceId]);
}

/** A mailbox of the current workspace, registered for recording manual sends. */
export async function manualMailbox(db: pg.Client, email = 'seller@seller.test'): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO mailbox_connections (provider, email) VALUES ('google_workspace', $1) RETURNING id`, [email])).id;
}

/** Runs `sql` in a savepoint and returns the error message, or null if it succeeded. */
export async function failure(db: pg.Client, sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query('SAVEPOINT t');
  try {
    await db.query(sql, params);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query('RELEASE SAVEPOINT t');
    return null;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT t');
    return (err as Error).message;
  }
}

export async function one<T = Record<string, unknown>>(db: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query(sql, params);
  if (r.rows.length !== 1) throw new Error(`expected one row, got ${r.rows.length}: ${sql}`);
  return r.rows[0] as T;
}

export const ruleId = async (db: pg.Client, key: string) =>
  (await one<{ id: string }>(db, 'SELECT id FROM rule_versions WHERE rule_key = $1 AND version = 1', [key])).id;

export const catalogId = async (db: pg.Client, key: string) =>
  (await one<{ id: string }>(db, 'SELECT id FROM catalog_items WHERE key = $1', [key])).id;

/** A business with one desktop snapshot, one defect observation and one evidence row. */
export async function seedChain(db: pg.Client, opts: { fetchedAt?: string } = {}) {
  const fetchedAt = opts.fetchedAt ?? '2026-09-28T10:00:00Z';
  const market = await one<{ id: string }>(db, `SELECT id FROM markets WHERE purpose = 'benchmark'`);
  const b = await one<{ id: string }>(db,
    `INSERT INTO businesses (market_id, name, domain, vertical, country_code, city)
     VALUES ($1, 'Example Clinic', $2, 'aesthetics', 'GB', 'London') RETURNING id`,
    [market.id, `example-${Math.random().toString(36).slice(2, 10)}.test`]);
  const s = await one<{ id: string }>(db,
    `INSERT INTO snapshots (business_id, url, http_status, fetched_at, fetch_method, viewport, html_sha256)
     VALUES ($1, 'https://example-clinic.test/', 200, $2, 'render', 'mobile', repeat('a', 64)) RETURNING id`,
    [b.id, fetchedAt]);
  const rule = await ruleId(db, 'check.contact_links');
  const o = await one<{ id: string }>(db,
    `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result, href, visible_text, observed_at)
     VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'defect', 'tel:WhatsApp:0800', 'WhatsApp: 0800', $3) RETURNING id`,
    [s.id, rule, fetchedAt]);
  const e = await one<{ id: string }>(db,
    `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, observed_at, confidence)
     VALUES ($1, $2, 'E-LINK-TARGET-MISMATCH', $3, 'OBSERVED', 'WhatsApp label opens a phone call', 'https://example-clinic.test/',
             'href="tel:WhatsApp:0800"', $4, 'HIGH') RETURNING id`, [b.id, o.id, rule, fetchedAt]);
  return { marketId: market.id, businessId: b.id, snapshotId: s.id, observationId: o.id, evidenceId: e.id, ruleId: rule };
}

/** A mapped, priced opportunity on the seeded chain's evidence. */
export async function seedOpportunity(db: pg.Client, chain: Awaited<ReturnType<typeof seedChain>>, catalogKey = 'website_fix_sprint', price: number | null = 120) {
  const cat = await catalogId(db, catalogKey);
  const opp = await one<{ id: string }>(db,
    `INSERT INTO opportunities (business_id, market_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price)
     VALUES ($1, $2, 'broken_contact_path', 'MAPPED', $3, 'GBP', $4) RETURNING id`,
    [chain.businessId, chain.marketId, cat, price]);
  await db.query('INSERT INTO opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2)', [opp.id, chain.evidenceId]);
  return opp.id;
}

/**
 * Runs `fn` as the application role (not the table owner) acting in `workspaceId`, so row-level
 * security applies exactly as it would to a request. Restores the owner and workspace afterwards.
 */
export async function asApp<T>(db: pg.Client, workspaceId: string | null, fn: () => Promise<T>): Promise<T> {
  const prior = (await db.query<{ ws: string | null }>(`SELECT current_setting('scopely.workspace_id', true) AS ws`)).rows[0]!.ws;
  await db.query(`SET LOCAL ROLE ${inject('appRole')}`);
  await db.query(`SELECT set_config('scopely.workspace_id', $1, true)`, [workspaceId ?? '']);
  try {
    return await fn();
  } finally {
    await db.query('RESET ROLE');
    await db.query(`SELECT set_config('scopely.workspace_id', $1, true)`, [prior ?? '']);
  }
}

/** Runs `fn` in a savepoint and returns its error message, or null if it succeeded. */
export async function refused(db: pg.Client, fn: () => Promise<unknown>): Promise<string | null> {
  await db.query('SAVEPOINT r');
  try {
    await fn();
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query('RELEASE SAVEPOINT r');
    return null;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT r');
    return (err as Error).message;
  }
}
