// Migration 007: the workspace boundary. Each workspace sees only its own commercial rows, rows can
// never point across workspaces, suppression and mailboxes belong to a workspace, and nothing in
// the schema names a default tenant or sender.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { listOpportunities } from '../src/api/queries.js';
import { createSearch, startSearchRun } from '../src/discovery/index.js';
import {
  asApp, catalogId, enterNewWorkspace, failure, manualMailbox, one, seedChain, seedOpportunity, useDb, useWorkspace,
} from './helpers.js';

const { db } = useDb();

const current = async (d: pg.Client) =>
  (await one<{ ws: string }>(d, 'SELECT scopely.current_workspace_id() AS ws')).ws;

/** An opportunity with a lawful contact, a sent message, a mailbox, a search and a cost in the current workspace. */
async function populate(d: pg.Client, label: string) {
  const c = await seedChain(d);
  const opp = await seedOpportunity(d, c);
  await d.query(`UPDATE businesses SET company_type = 'ltd', company_status = 'active' WHERE id = $1`, [c.businessId]);
  const contact = (await one<{ id: string }>(d, `INSERT INTO contacts (business_id, full_name, email, source, label, outreach_basis)
    VALUES ($1, 'Owner', $2, 'website', 'PUBLICLY_FOUND', 'corporate_subscriber') RETURNING id`, [c.businessId, `owner@${label}.test`])).id;
  const mailbox = await manualMailbox(d, `sales@${label}-seller.test`);
  const s = await one<{ id: string }>(d, `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'https://x.test/', '2026-10-01T09:00:00Z', 'manual') RETURNING id`, [c.businessId]);
  const o = await one<{ id: string }>(d, `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'defect') RETURNING id`, [s.id, c.ruleId]);
  await d.query(`INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1, $2, $3, 'confirmed', 'operator')`, [c.evidenceId, s.id, o.id]);
  const msg = (await one<{ id: string }>(d, `INSERT INTO messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator, mailbox_connection_id,
      approval_status, approved_by, approved_at, sent_at)
    VALUES ($1, $2, 0, 's', 'b', $3, 'operator', $4, 'approved', 'operator', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z') RETURNING id`,
    [opp, contact, [c.evidenceId], mailbox])).id;
  const searchId = await createSearch(d, { name: `${label} search` });
  const runId = await startSearchRun(d, searchId);
  await d.query(`INSERT INTO cost_events (business_id, kind, units, amount, currency) VALUES ($1, 'enrichment', 1, 0.10, 'GBP')`, [c.businessId]);
  await d.query(`INSERT INTO suppression (domain, reason) VALUES ($1, 'opt_out')`, [`${label}-optout.test`]);
  return { ...c, opp, contact, mailbox, msg, searchId, runId };
}

const OWNED = ['businesses', 'sources', 'snapshots', 'observations', 'evidence', 'evidence_rechecks', 'contacts', 'suppression',
  'opportunities', 'opportunity_evidence', 'outcomes', 'verifications', 'messages', 'cost_events', 'builds', 'build_evidence',
  'mailbox_connections', 'searches', 'search_runs', 'search_run_businesses'];

describe('row-level security isolates workspaces for the application role', () => {
  it('shows each workspace only its own businesses, searches, contacts, opportunities, messages, costs and mailboxes', async () => {
    const a = await current(db());
    const A = await populate(db(), 'alpha');
    const b = await enterNewWorkspace(db(), 'beta');
    const B = await populate(db(), 'beta');

    for (const [ws, mine, theirs] of [[a, A, B], [b, B, A]] as const) {
      await asApp(db(), ws, async () => {
        for (const t of OWNED) {
          const other = await one<{ n: string }>(db(), `SELECT count(*) AS n FROM ${t} WHERE workspace_id <> $1`, [ws]);
          expect(other.n, `${t} leaks another workspace's rows`).toBe('0');
        }
        const ids = async (sql: string) => (await db().query(sql)).rows.map((r) => String(r.id));
        expect(await ids('SELECT id FROM businesses')).toEqual([String(mine.businessId)]);
        expect(await ids('SELECT id FROM opportunities')).toEqual([String(mine.opp)]);
        expect(await ids('SELECT id FROM contacts')).toEqual([String(mine.contact)]);
        expect(await ids('SELECT id FROM messages')).toEqual([String(mine.msg)]);
        expect(await ids('SELECT id FROM mailbox_connections')).toEqual([String(mine.mailbox)]);
        expect(await ids('SELECT id FROM searches')).toEqual([String(mine.searchId)]);
        expect(await ids('SELECT id FROM businesses WHERE id = ' + Number(theirs.businessId))).toEqual([]);
        // Views run with the caller's rights, so they are isolated too.
        expect(await ids('SELECT opportunity_id AS id FROM v_opportunity_feed')).toEqual([String(mine.opp)]);
        expect(await ids('SELECT opportunity_id AS id FROM v_opportunity_ledger')).toEqual([String(mine.opp)]);
        expect(await ids('SELECT search_run_id AS id FROM v_search_run_summary')).toEqual([String(mine.runId)]);
        const funnel = await db().query('SELECT workspace_id, messages_sent FROM v_market_funnel');
        expect(funnel.rows.map((r) => String(r.workspace_id))).toEqual([ws]);
        expect(funnel.rows[0].messages_sent).toBe('1');
        // Shared starter rows stay visible to every workspace.
        expect(Number((await one<{ n: string }>(db(), 'SELECT count(*) AS n FROM catalog_items WHERE workspace_id IS NULL')).n)).toBeGreaterThan(0);
      });
    }
  });

  it('refuses to write a row into another workspace', async () => {
    const a = await current(db());
    const b = await enterNewWorkspace(db(), 'beta');
    await asApp(db(), b, async () => {
      expect(await failure(db(), `INSERT INTO businesses (workspace_id, name) VALUES ($1, 'Planted')`, [a])).toMatch(/row-level security/);
      expect(await failure(db(), `INSERT INTO catalog_items (workspace_id, key, service, description) VALUES (NULL, 'shared_x', 'X', 'x')`))
        .toMatch(/row-level security|not-null|violates/);
      expect(await failure(db(), `INSERT INTO businesses (name) VALUES ('Mine')`)).toBeNull();
    });
  });

  it('shows nothing but shared rows when no workspace is set', async () => {
    await populate(db(), 'alpha');
    await asApp(db(), null, async () => {
      expect((await db().query('SELECT id FROM businesses')).rows).toEqual([]);
      expect((await db().query('SELECT id FROM searches')).rows).toEqual([]);
      expect((await db().query('SELECT id FROM mailbox_connections')).rows).toEqual([]);
      expect(await listOpportunities(db())).toEqual([]);
    });
  });

  it('every view runs with the caller\'s rights', async () => {
    const r = await db().query(`SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'scopely' AND c.relkind = 'v' ORDER BY c.relname`);
    expect(r.rows.length).toBeGreaterThanOrEqual(8);
    for (const v of r.rows) expect(v.reloptions ?? [], v.relname).toContain('security_invoker=true');
  });

  it('every commercial table has row-level security on', async () => {
    const r = await db().query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'scopely' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY c.relname`);
    const open = r.rows.map((x) => x.relname);
    for (const t of [...OWNED, 'markets', 'catalog_items', 'workspaces', 'users', 'workspace_memberships']) expect(open).not.toContain(t);
    // What stays open is shared vocabulary and the migration ledger, which hold no customer data.
    expect(open.sort()).toEqual(['build_kinds', 'issue_codes', 'niche_playbooks', 'outreach_basis_rules', 'rule_versions', 'schema_migrations']);
  });
});

describe('rows never point across workspaces', () => {
  it('refuses a contact, opportunity, message, build, cost or run that references another workspace', async () => {
    const A = await populate(db(), 'alpha');
    await enterNewWorkspace(db(), 'beta');
    const B = await seedChain(db());
    const bOpp = await seedOpportunity(db(), B);
    const cross = /WORKSPACE: .* belongs to workspace/;
    expect(await failure(db(), `INSERT INTO contacts (business_id, email, source, label) VALUES ($1, 'x@x.test', 'web', 'UNVERIFIED')`, [A.businessId])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'u', now(), 'manual')`, [A.businessId])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2)`, [bOpp, A.evidenceId])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO messages (opportunity_id, step, subject, body, evidence_ids, generator, mailbox_connection_id)
      VALUES ($1, 0, 's', 'b', $2, 'operator', $3)`, [bOpp, [B.evidenceId], A.mailbox])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO cost_events (opportunity_id, kind) VALUES ($1, 'fetch')`, [A.opp])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO search_runs (search_id, criteria) VALUES ($1, '{}')`, [A.searchId])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO suppression (business_id, reason) VALUES ($1, 'dnc')`, [A.businessId])).toMatch(cross);
  });

  it('refuses a catalog item of another workspace, and allows a shared starter item', async () => {
    const own = (await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, price_low, price_high, currency, price_source)
      VALUES ('alpha_only', 'Alpha', 'a', 100, 100, 'GBP', 'alpha price list') RETURNING id`)).id;
    await enterNewWorkspace(db(), 'beta');
    const B = await seedChain(db());
    const insertOpp = `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id) VALUES ($1, 't', 'MAPPED', $2) RETURNING id`;
    expect(await failure(db(), insertOpp, [B.businessId, own])).toMatch(/WORKSPACE: catalog_items .* belongs to workspace/);
    expect(await failure(db(), `WITH o AS (${insertOpp}) INSERT INTO opportunity_evidence (opportunity_id, evidence_id) SELECT id, $3 FROM o`,
      [B.businessId, await catalogId(db(), 'website_fix_sprint'), B.evidenceId])).toBeNull();
  });

  it('lets two workspaces define the same catalog key', async () => {
    const sql = `INSERT INTO catalog_items (key, service, description) VALUES ('website_build', 'Website Build', 'd')`;
    expect(await failure(db(), sql)).toBeNull();
    expect(await failure(db(), sql)).toMatch(/duplicate key/);
    await enterNewWorkspace(db(), 'beta');
    expect(await failure(db(), sql)).toBeNull();
  });

  it('inherits the workspace from the parent row and refuses to move a row', async () => {
    const c = await seedChain(db());
    const ws = await current(db());
    await db().query(`SELECT set_config('scopely.workspace_id', '', true)`);
    const s = await one<{ workspace_id: string }>(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method)
      VALUES ($1, 'u', now(), 'manual') RETURNING workspace_id`, [c.businessId]);
    expect(s.workspace_id).toBe(ws);
    // With no workspace and no parent to inherit from, nothing is written.
    expect(await failure(db(), `INSERT INTO businesses (name) VALUES ('Orphan')`)).toMatch(/null value in column "workspace_id"/);
    expect(await failure(db(), `INSERT INTO searches (name) VALUES ('Orphan')`)).toMatch(/null value in column "workspace_id"/);
    const other = await enterNewWorkspace(db(), 'beta');
    await useWorkspace(db(), ws);
    expect(await failure(db(), `UPDATE businesses SET workspace_id = $2 WHERE id = $1`, [c.businessId, other])).toMatch(/cannot move/);
  });
});

describe('every owned table keeps its references and rows inside one workspace', () => {
  it('refuses a child row in one workspace that points at a parent in another, for every owned table', async () => {
    const A = await populate(db(), 'alpha');
    const later = await one<{ id: string }>(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'u', '2026-10-02T09:00:00Z', 'manual') RETURNING id`, [A.businessId]);
    const ok = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'ok') RETURNING id`, [later.id, A.ruleId]);
    const build = await one<{ id: string }>(db(), `INSERT INTO builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, generator)
      VALUES ($1, $2, 'website_fix', 'DEMO', 't', 's', 'operator') RETURNING id`, [A.opp, await catalogId(db(), 'website_fix_sprint')]);
    await db().query('INSERT INTO build_evidence (build_id, evidence_id) VALUES ($1, $2)', [build.id, A.evidenceId]);
    const aRunBusiness = await one<{ id: string }>(db(), `INSERT INTO search_run_businesses (search_run_id, business_id) VALUES ($1, $2) RETURNING id`, [A.runId, A.businessId]);
    void aRunBusiness;
    await enterNewWorkspace(db(), 'beta');
    const B = await seedChain(db());
    const cross = /WORKSPACE: .* belongs to workspace/;
    const attempts: [string, string, unknown[]][] = [
      ['sources', `INSERT INTO sources (business_id, kind, ref) VALUES ($1, 'csv', 'r')`, [A.businessId]],
      ['observations', `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'c', $2, 'OBSERVED', 'ok')`, [later.id, A.ruleId]],
      ['evidence', `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, confidence)
         VALUES ($1, $2, 'E-LINK-TARGET-MISMATCH', $3, 'OBSERVED', 'i', 'u', 'q', 'LOW')`, [A.businessId, A.observationId, A.ruleId]],
      ['evidence_rechecks', `INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1, $2, $3, 'gone', 'op')`,
         [A.evidenceId, later.id, ok.id]],
      ['outcomes', `INSERT INTO outcomes (opportunity_id, kind, occurred_at, recorded_by) VALUES ($1, 'call', now(), 'op')`, [A.opp]],
      ['verifications', `INSERT INTO verifications (opportunity_id, baseline_evidence_id, snapshot_id, observation_id, rule_version_id, status)
         VALUES ($1, $2, $3, $4, $5, 'PASSED')`, [A.opp, A.evidenceId, later.id, ok.id, A.ruleId]],
      ['builds', `INSERT INTO builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, generator)
         VALUES ($1, $2, 'website_fix', 'DEMO', 't', 's', 'operator')`, [A.opp, await catalogId(db(), 'website_fix_sprint')]],
      ['build_evidence', `INSERT INTO build_evidence (build_id, evidence_id) VALUES ($1, $2)`, [build.id, A.evidenceId]],
      ['search_run_businesses', `INSERT INTO search_run_businesses (search_run_id, business_id) VALUES ($1, $2)`, [A.runId, B.businessId]],
      ['businesses', `INSERT INTO businesses (market_id, name) VALUES ((SELECT id FROM markets WHERE workspace_id = $1 LIMIT 1), 'x')`, [null]],
    ];
    for (const [table, sql, params] of attempts.slice(0, -1)) expect(await failure(db(), sql, params), table).toMatch(cross);
  });

  it('refuses to move any owned row, including markets, catalog items, mailboxes and searches, to another workspace', async () => {
    const a = await current(db());
    const A = await populate(db(), 'alpha');
    const market = (await one<{ id: string }>(db(), `INSERT INTO markets (name, playbook_id, vertical, country_code, currency, purpose)
      SELECT 'Own market', id, 'home_services', 'GB', 'GBP', 'production' FROM niche_playbooks LIMIT 1 RETURNING id`)).id;
    const item = (await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description) VALUES ('own', 'Own', 'o') RETURNING id`)).id;
    const b = await enterNewWorkspace(db(), 'beta');
    await useWorkspace(db(), a);
    const rb = (await one<{ id: string }>(db(), 'SELECT id FROM search_run_businesses LIMIT 1').catch(() => ({ id: null }))).id;
    const moves: [string, string | null][] = [['markets', market], ['catalog_items', item], ['mailbox_connections', A.mailbox], ['searches', A.searchId],
      ['search_runs', A.runId], ['sources', null], ['observations', String(A.observationId)], ['evidence', String(A.evidenceId)],
      ['evidence_rechecks', null], ['outcomes', null], ['search_run_businesses', rb]];
    for (const [t, id] of moves) {
      const target = id ?? (await one<{ id: string }>(db(), `SELECT min(id) AS id FROM ${t} WHERE workspace_id = $1`, [a])).id;
      if (target === null) continue;
      expect(await failure(db(), `UPDATE ${t} SET workspace_id = $2 WHERE id = $1`, [target, b]), t).toMatch(/cannot move/);
    }
    const oe = await failure(db(), 'UPDATE opportunity_evidence SET workspace_id = $2 WHERE opportunity_id = $1', [A.opp, b]);
    expect(oe).toMatch(/cannot move/);
  });

  it('refuses a bundle price that names another workspace\'s catalog item', async () => {
    const theirs = (await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, price_low, price_high, currency, price_source)
      VALUES ('addon', 'Add-on', 'a', 50, 50, 'GBP', 'list') RETURNING id`)).id;
    await enterNewWorkspace(db(), 'beta');
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    expect(await failure(db(), `UPDATE opportunities SET service_price = 170, price_override_kind = 'BUNDLE', price_override_reason = 'bundle',
      price_override_approved_by = 'op', price_override_approved_at = now(), price_override_catalog_item_ids = ARRAY[$2::bigint] WHERE id = $1`, [opp, theirs]))
      .toMatch(/bundle names a catalog item of another workspace/);
  });
});

describe('builds and their costs stay inside one workspace', () => {
  const insertBuild = `INSERT INTO builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, generator, supersedes_build_id)
    VALUES ($1, $2, 'website_fix', 'DEMO', 't', 's', 'operator', $3) RETURNING id`;
  const cross = /WORKSPACE: .* belongs to workspace/;

  it('refuses a build, revision, citation or cost in one workspace that points at another workspace\'s build, item, evidence or run', async () => {
    const A = await populate(db(), 'alpha');
    const aBuild = (await one<{ id: string }>(db(), insertBuild, [A.opp, await catalogId(db(), 'website_fix_sprint'), null])).id;
    const aItem = (await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, build_kind) VALUES ('own_fix', 'Own fix', 'o', 'website_fix') RETURNING id`)).id;
    await enterNewWorkspace(db(), 'beta');
    const B = await seedChain(db());
    const bOpp = await seedOpportunity(db(), B);
    const bBuild = (await one<{ id: string }>(db(), insertBuild, [bOpp, await catalogId(db(), 'website_fix_sprint'), null])).id;

    // A revision (the supersedes chain that carries versions) cannot continue another workspace's build.
    expect(await failure(db(), insertBuild, [bOpp, await catalogId(db(), 'website_fix_sprint'), aBuild])).toMatch(cross);
    // A build cannot use another workspace's own catalog item, even on its own opportunity.
    expect(await failure(db(), insertBuild, [bOpp, aItem, null])).toMatch(cross);
    // A build cannot cite another workspace's evidence.
    expect(await failure(db(), 'INSERT INTO build_evidence (build_id, evidence_id) VALUES ($1, $2)', [bBuild, A.evidenceId])).toMatch(cross);
    // Cost cannot be attributed to another workspace's build or search run.
    expect(await failure(db(), `INSERT INTO cost_events (business_id, opportunity_id, build_id, kind) VALUES ($1, $2, $3, 'llm_call')`, [B.businessId, bOpp, aBuild])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO cost_events (business_id, search_run_id, kind, credits) VALUES ($1, $2, 'enrichment', 1)`, [B.businessId, A.runId]))
      .toMatch(cross);
    // Nor can an existing build or cost be pointed across, or moved.
    expect(await failure(db(), 'UPDATE builds SET supersedes_build_id = $2 WHERE id = $1', [bBuild, aBuild])).toMatch(cross);
    const bCost = (await one<{ id: string }>(db(), `INSERT INTO cost_events (business_id, opportunity_id, build_id, kind) VALUES ($1, $2, $3, 'llm_call') RETURNING id`,
      [B.businessId, bOpp, bBuild])).id;
    expect(await failure(db(), 'UPDATE cost_events SET build_id = $2 WHERE id = $1', [bCost, aBuild])).toMatch(cross);
    await useWorkspace(db(), await one<{ ws: string }>(db(), 'SELECT workspace_id::text AS ws FROM builds WHERE id = $1', [aBuild]).then((r) => r.ws));
    const b = (await one<{ ws: string }>(db(), 'SELECT workspace_id::text AS ws FROM builds WHERE id = $1', [bBuild])).ws;
    expect(await failure(db(), 'UPDATE builds SET workspace_id = $2 WHERE id = $1', [aBuild, b])).toMatch(/cannot move/);
    expect(await failure(db(), 'UPDATE cost_events SET workspace_id = $2 WHERE build_id IS NULL AND business_id = $1', [A.businessId, b])).toMatch(/cannot move/);
  });
});

describe('suppression respects workspace boundaries', () => {
  async function lawful(d: pg.Client, domain: string) {
    const c = await seedChain(d);
    await d.query(`UPDATE businesses SET company_type = 'ltd', company_status = 'active', domain = $2 WHERE id = $1`, [c.businessId, domain]);
    const opp = await seedOpportunity(d, c);
    const contact = (await one<{ id: string }>(d, `INSERT INTO contacts (business_id, full_name, email, source, label, outreach_basis)
      VALUES ($1, 'Owner', $2, 'website', 'PUBLICLY_FOUND', 'corporate_subscriber') RETURNING id`, [c.businessId, `owner@${domain}`])).id;
    const msg = (await one<{ id: string }>(d, `INSERT INTO messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator)
      VALUES ($1, $2, 0, 's', 'b', $3, 'operator') RETURNING id`, [opp, contact, [c.evidenceId]])).id;
    return { ...c, msg };
  }
  const approve = `UPDATE messages SET approval_status = 'approved', approved_by = 'operator', approved_at = now() WHERE id = $1`;

  it('one workspace\'s opt-out does not suppress another workspace\'s outreach', async () => {
    await db().query(`INSERT INTO suppression (domain, reason) VALUES ('shared-prospect.test', 'opt_out')`);
    const a = await lawful(db(), 'shared-prospect.test');
    expect(await failure(db(), approve, [a.msg])).toMatch(/suppressed/);
    await enterNewWorkspace(db(), 'beta');
    const b = await lawful(db(), 'shared-prospect.test');
    expect(await failure(db(), approve, [b.msg])).toBeNull();
  });

  it('suppresses by business as well as by email and domain', async () => {
    const a = await lawful(db(), 'by-business.test');
    await db().query(`INSERT INTO suppression (business_id, reason) VALUES ($1, 'dnc')`, [a.businessId]);
    expect(await failure(db(), approve, [a.msg])).toMatch(/suppressed/);
    expect(await failure(db(), `INSERT INTO suppression (reason) VALUES ('nothing')`)).toMatch(/suppression_target_check/);
  });
});

describe('mailboxes belong to a workspace; there is no global sender', () => {
  async function approved(d: pg.Client) {
    const c = await seedChain(d);
    await d.query(`UPDATE businesses SET company_type = 'ltd', company_status = 'active' WHERE id = $1`, [c.businessId]);
    await d.query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [c.evidenceId]);
    const opp = await seedOpportunity(d, c);
    const contact = (await one<{ id: string }>(d, `INSERT INTO contacts (business_id, full_name, email, source, label, outreach_basis)
      VALUES ($1, 'Owner', 'owner@prospect.test', 'website', 'PUBLICLY_FOUND', 'corporate_subscriber') RETURNING id`, [c.businessId])).id;
    return (await one<{ id: string; recipient_email: string }>(d, `INSERT INTO messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator,
      approval_status, approved_by, approved_at) VALUES ($1, $2, 0, 's', 'b', $3, 'operator', 'approved', 'operator', '2026-10-01T10:00:00Z')
      RETURNING id, recipient_email`, [opp, contact, [c.evidenceId]]));
  }

  it('marks a message sent only from a mailbox of its workspace, capturing sender and recipient', async () => {
    const m = await approved(db());
    expect(m.recipient_email).toBe('owner@prospect.test');
    expect(await failure(db(), `UPDATE messages SET sent_at = '2026-10-01T11:00:00Z' WHERE id = $1`, [m.id])).toMatch(/without the workspace mailbox/);
    const mine = await manualMailbox(db(), 'hello@seller-a.test');
    expect(await failure(db(), `UPDATE messages SET sent_at = '2026-10-01T11:00:00Z', mailbox_connection_id = $2, sender_email = 'someone@else.test' WHERE id = $1`,
      [m.id, mine])).toMatch(/sender_email must be the mailbox/);
    expect(await failure(db(), `UPDATE messages SET sent_at = '2026-10-01T11:00:00Z', mailbox_connection_id = $2 WHERE id = $1`, [m.id, mine])).toBeNull();
    const sent = await one<{ sender_email: string }>(db(), 'SELECT sender_email FROM messages WHERE id = $1', [m.id]);
    expect(sent.sender_email).toBe('hello@seller-a.test');
    const other = await manualMailbox(db(), 'other@seller-a.test');
    expect(await failure(db(), `UPDATE messages SET mailbox_connection_id = $2 WHERE id = $1`, [m.id, other])).toMatch(/sent message cannot change/);
  });

  it('refuses a disconnected mailbox and another workspace\'s mailbox', async () => {
    const m = await approved(db());
    const off = (await one<{ id: string }>(db(), `INSERT INTO mailbox_connections (provider, email, state, disconnected_at)
      VALUES ('microsoft_365', 'old@seller-a.test', 'DISCONNECTED', now()) RETURNING id`)).id;
    expect(await failure(db(), `UPDATE messages SET sent_at = '2026-10-01T11:00:00Z', mailbox_connection_id = $2 WHERE id = $1`, [m.id, off])).toMatch(/cannot send/);
    const ws = await current(db());
    await enterNewWorkspace(db(), 'beta');
    const theirs = await manualMailbox(db(), 'founder@seller-b.test');
    await useWorkspace(db(), ws);
    expect(await failure(db(), `UPDATE messages SET sent_at = '2026-10-01T11:00:00Z', mailbox_connection_id = $2 WHERE id = $1`, [m.id, theirs]))
      .toMatch(/belongs to workspace/);
  });

  it('holds no sender or tenant default anywhere in the schema', async () => {
    const defaults = await db().query(`SELECT table_name, column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'scopely' AND column_default IS NOT NULL
        AND (column_default ~ '@' OR (column_name = 'workspace_id' AND column_default NOT LIKE '%current_workspace_id()%'))`);
    expect(defaults.rows).toEqual([]);
    expect((await db().query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'scopely'
      AND table_name ~ '(setting|config|sender)'`)).rows).toEqual([]);
    expect((await db().query('SELECT 1 FROM workspaces WHERE slug NOT LIKE $1', ['test-%'])).rows).toEqual([]);
  });

  it('names no operator, mailbox or company in application code or the multi-user migrations', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p); else files.push(p);
      }
    };
    walk(path.join(root, 'src/tenancy')); walk(path.join(root, 'src/discovery')); walk(path.join(root, 'src/sell'));
    walk(path.join(root, 'src/api')); walk(path.join(root, 'src/record')); walk(path.join(root, 'src/build'));
    walk(path.join(root, 'scripts'));
    files.push(...readdirSync(path.join(root, 'migrations')).filter((f) => f >= '007').map((f) => path.join(root, 'migrations', f)));
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/joseph|josephiwe|hello@/i);
  });
});
