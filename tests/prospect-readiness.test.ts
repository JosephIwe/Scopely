// Slice 9: Prospect Readiness. From the Case File a seller records a re-check of a cited finding, a
// contact, the company register facts and suppression, through the existing tables and guards; an
// explicit opt-out reply suppresses the business by itself (013); and the Case File reports, from the
// database's own gates, what is missing before the prospect is READY.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { recordOutcome, recordSuppression } from '../src/record/index.js';
import { createHandler } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher, addEvidence, seedFixOpportunity } from './fix-helpers.js';
import { asApp, enterNewWorkspace, failure, one, refused, seedChain, seedOpportunity, useDb, useWorkspace } from './helpers.js';
import { SIGNING_KEY, seedWebsiteOpportunity } from './site-helpers.js';

const { db } = useDb();

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = {
    BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv',
  };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

const currentWs = async () => (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;

async function start(workspaceId?: string) {
  const ws = workspaceId ?? await currentWs();
  const logged: string[] = [];
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY,
    fetcher: new StubFetcher(), editLinkTtlSeconds: 900, showLinkTtlSeconds: DEFAULT_SHOW_LINK_TTL_SECONDS, log: (l: string) => { logged.push(l); } });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-scopely-request': '1' }) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  return { call, logged, workspaceId: ws };
}

const today = () => new Date().toISOString().slice(0, 10);
// Slice 12: a decision maker carries what shows it (016).
const LAWFUL = { fullName: 'Sam Alder', role: 'Director', isDecisionMaker: true, decisionMakerBasis: 'Listed as a director at Companies House', email: 'sam@example-clinic.test', emailKind: 'personal',
  source: 'company_register', label: 'PUBLICLY_FOUND', outreachBasis: 'corporate_subscriber' };

/** A GB website opportunity on one HIGH finding that has not been re-checked, and a server over it. */
async function prospect() {
  const seed = await seedWebsiteOpportunity(db());
  const srv = await start();
  const o = `/api/opportunities/${seed.opportunityId}`;
  const cf = async () => (await srv.call('GET', o)).json();
  const recheck = (body: Record<string, unknown>, evidenceId = seed.evidenceId) => srv.call('POST', `${o}/evidence/${evidenceId}/recheck`, { recordedBy: 'Sam', ...body });
  const contact = (body: Record<string, unknown>, contactId?: string) => srv.call('POST', `${o}/contacts${contactId ? `/${contactId}` : ''}`, body);
  const company = (body: Record<string, unknown>) => srv.call('POST', `${o}/company`, body);
  const suppress = (body: Record<string, unknown>) => srv.call('POST', `${o}/suppressions`, body);
  const outcome = (body: Record<string, unknown>) => srv.call('POST', `${o}/outcomes`, { occurredOn: today(), recordedBy: 'Sam', ...body });
  return { ...srv, seed, o, cf, recheck, contact, company, suppress, outcome };
}

const check = (cf: { readiness: { checks: { key: string; state: string }[] } }, key: string) => cf.readiness.checks.find((c) => c.key === key)?.state;
const suppressionRows = async (businessId: string) =>
  (await db().query('SELECT email, domain, business_id, reason FROM suppression WHERE workspace_id = scopely.current_workspace_id() AND (business_id = $1 OR business_id IS NULL)', [businessId])).rows;

// ---------------------------------------------------------------- 1-3 evidence re-check

describe('re-checking evidence from the Case File', () => {
  it('records a person’s visit to the evidence’s own page on a new snapshot, with the same check and rule', async () => {
    const p = await prospect();
    expect((await p.cf()).outreach.recheckNeeded).toHaveLength(1);
    // The URL in the request is ignored: the visit is always to the evidence's own page.
    const r = await p.recheck({ result: 'confirmed', url: 'https://elsewhere.test/' });
    expect(r.status).toBe(200);
    const row = await one<Record<string, string>>(db(), `SELECT r.result, r.recorded_by, s.url, s.fetch_method, s.business_id, o.check_code, o.rule_version_id, o.state, o.result AS obs
      FROM evidence_rechecks r JOIN snapshots s ON s.id = r.snapshot_id JOIN observations o ON o.id = r.observation_id WHERE r.evidence_id = $1`, [p.seed.evidenceId]);
    expect(row).toMatchObject({ result: 'confirmed', recorded_by: 'Sam', url: 'https://example-clinic.test/', fetch_method: 'manual', business_id: p.seed.businessId,
      check_code: 'contact_links.whatsapp', rule_version_id: p.seed.ruleId, state: 'OBSERVED', obs: 'defect' });
    const cf = await p.cf();
    expect(cf.evidence[0].recheck).toMatchObject({ result: 'confirmed' });
    expect(cf.outreach.recheckNeeded).toEqual([]);
    expect(check(cf, 'evidence')).toBe('done');
    // The log names ids and the result, never the page.
    expect(p.logged.join('\n')).not.toContain('example-clinic.test');
  });

  it('records gone as an OBSERVED ok, and changed only with a note and no observation; either drops the finding', async () => {
    const p = await prospect();
    expect((await p.recheck({ result: 'changed' })).status).toBe(400);
    expect((await p.recheck({ result: 'maybe' })).status).toBe(400);
    expect((await p.recheck({ result: 'confirmed', recordedBy: ' ' })).status).toBe(400);
    expect((await p.recheck({ result: 'changed', notes: 'The link now opens a different number' })).status).toBe(200);
    const r = await one<{ observation_id: string | null; notes: string }>(db(), 'SELECT observation_id, notes FROM evidence_rechecks WHERE evidence_id = $1', [p.seed.evidenceId]);
    expect(r.observation_id).toBeNull();
    const cf = await p.cf();
    expect(cf.outreach.noLongerHolds).toEqual([expect.objectContaining({ result: 'changed' })]);
    expect(check(cf, 'evidence')).toBe('blocked');
    // One re-check per moment: a second in the same request time is refused plainly, and nothing is written.
    const again = await p.recheck({ result: 'confirmed' });
    expect(again.status).toBe(409);
    expect(again.json().error).toMatch(/later re-check is already recorded/);

    const g = await prospect();
    expect((await g.recheck({ result: 'gone' })).status).toBe(200);
    expect(await one(db(), `SELECT o.state, o.result FROM evidence_rechecks r JOIN observations o ON o.id = r.observation_id WHERE r.evidence_id = $1`, [g.seed.evidenceId]))
      .toEqual({ state: 'OBSERVED', result: 'ok' });
  });

  it('refuses a re-check from another workspace, and writes nothing', async () => {
    const seed = await seedWebsiteOpportunity(db());
    const home = await currentWs();
    const other = await enterNewWorkspace(db(), 'other');
    const { call } = await start(other);
    const r = await call('POST', `/api/opportunities/${seed.opportunityId}/evidence/${seed.evidenceId}/recheck`, { result: 'confirmed', recordedBy: 'Sam' });
    expect(r.status).toBe(404);
    // Even through its own opportunity, workspace B cannot name A's evidence.
    const mine = await seedWebsiteOpportunity(db());
    expect((await call('POST', `/api/opportunities/${mine.opportunityId}/evidence/${seed.evidenceId}/recheck`, { result: 'confirmed', recordedBy: 'Sam' })).status).toBe(404);
    await useWorkspace(db(), home);
    expect((await one<{ n: number }>(db(), 'SELECT count(*)::int AS n FROM evidence_rechecks WHERE evidence_id = $1', [seed.evidenceId])).n).toBe(0);
    expect((await one<{ n: number }>(db(), `SELECT count(*)::int AS n FROM snapshots WHERE business_id = $1 AND fetch_method = 'manual'`, [seed.businessId])).n).toBe(0);
  });

  it('refuses evidence the opportunity does not cite, and an inferred finding a visit cannot confirm', async () => {
    const p = await prospect();
    // Evidence of another opportunity in the same workspace.
    const unrelated = await seedChain(db());
    await seedOpportunity(db(), unrelated);
    expect((await p.recheck({ result: 'confirmed' }, unrelated.evidenceId)).status).toBe(404);
    expect((await p.recheck({ result: 'confirmed' }, 'abc')).status).toBe(404);
    expect((await one<{ n: number }>(db(), 'SELECT count(*)::int AS n FROM evidence_rechecks WHERE evidence_id = $1', [unrelated.evidenceId])).n).toBe(0);
    // An inferred finding cited by this opportunity: a visit can say it changed, never that it is still there.
    const inferred = await addEvidence(db(), p.seed, p.seed.opportunityId, { code: 'E-TEL-BROKEN', claim: 'INFERRED' });
    expect((await p.recheck({ result: 'confirmed' }, inferred)).status).toBe(409);
    expect((await p.recheck({ result: 'changed', notes: 'Different page now' }, inferred)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- 4-7 contact and company register

describe('recording a contact', () => {
  it('adds a contact with its source and lawful basis, and corrects it later, without verifying anything', async () => {
    const p = await prospect();
    const add = await p.contact({ ...LAWFUL, outreachBasis: 'unknown' });
    expect(add.status).toBe(200);
    const id = add.json().contactId;
    const row = await one<Record<string, unknown>>(db(), 'SELECT * FROM contacts WHERE id = $1', [id]);
    expect(row).toMatchObject({ business_id: p.seed.businessId, full_name: 'Sam Alder', email: 'sam@example-clinic.test', source: 'company_register',
      label: 'PUBLICLY_FOUND', outreach_basis: 'unknown', is_decision_maker: true, mx_ok: null });
    let cf = await p.cf();
    expect(cf.buyer.contacts[0].emailBlocker).toMatch(/outreach basis is unknown/);
    expect(check(cf, 'lawful_basis')).toBe('missing');
    expect((await p.contact({ ...LAWFUL, outreachBasis: 'consent' }, id)).status).toBe(200);
    expect((await one<{ outreach_basis: string }>(db(), 'SELECT outreach_basis FROM contacts WHERE id = $1', [id])).outreach_basis).toBe('consent');
    cf = await p.cf();
    expect(cf.buyer.contacts).toHaveLength(1);
    expect(check(cf, 'lawful_basis')).toBe('done');
    expect(p.logged.join('\n')).not.toContain('sam@');
  });

  it('refuses a contact the schema would not hold, and a contact of another business', async () => {
    const p = await prospect();
    expect((await p.contact({ ...LAWFUL, source: '' })).status).toBe(400);
    expect((await p.contact({ ...LAWFUL, label: 'CONFIRMED' })).status).toBe(400);
    expect((await p.contact({ ...LAWFUL, outreachBasis: 'legitimate_interest' })).status).toBe(400);
    expect((await p.contact({ ...LAWFUL, outreachBasis: null })).status).toBe(400);
    expect((await p.contact({ ...LAWFUL, fullName: '', email: '' })).status).toBe(400);
    expect((await p.contact({ ...LAWFUL, email: 'not-an-address' })).status).toBe(400);
    expect((await p.contact({ ...LAWFUL, email: '', emailKind: 'role' })).status).toBe(400);
    expect((await p.contact({ ...LAWFUL, sourceUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await one<{ n: number }>(db(), 'SELECT count(*)::int AS n FROM contacts WHERE business_id = $1', [p.seed.businessId])).n).toBe(0);
    // A contact of another business (same workspace) cannot be edited through this opportunity.
    const other = await seedChain(db());
    const foreign = (await one<{ id: string }>(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis) VALUES ($1, 'Kit', 'manual', 'UNVERIFIED', 'unknown') RETURNING id`, [other.businessId])).id;
    expect((await p.contact(LAWFUL, foreign)).status).toBe(404);
    expect((await one<{ full_name: string }>(db(), 'SELECT full_name FROM contacts WHERE id = $1', [foreign])).full_name).toBe('Kit');
  });
});

describe('recording the company register status', () => {
  it('writes the supplied type and status to the business, and the GB gate reads them', async () => {
    const p = await prospect();
    const id = (await p.contact(LAWFUL)).json().contactId;
    expect((await p.cf()).buyer.contacts[0].emailBlocker).toMatch(/active Ltd or LLP, got NULL \/ NULL/);
    expect(check(await p.cf(), 'company')).toBe('missing');
    expect((await p.company({ register: 'uk_companies_house', number: '0123 4567', type: 'plc', status: 'active' })).status).toBe(200);
    expect(await one(db(), 'SELECT company_register, company_number, company_type, company_status FROM businesses WHERE id = $1', [p.seed.businessId]))
      .toEqual({ company_register: 'uk_companies_house', company_number: '01234567', company_type: 'plc', company_status: 'active' });
    // B3 stays open: a PLC is not eligible under the GB rule.
    expect(check(await p.cf(), 'company')).toBe('blocked');
    expect((await p.company({ register: 'uk_companies_house', number: '01234567', type: 'ltd', status: 'active' })).status).toBe(200);
    const cf = await p.cf();
    expect(check(cf, 'company')).toBe('done');
    expect(cf.buyer.contacts.find((c: { contactId: string }) => c.contactId === id).emailBlocker).toBeNull();
  });

  it('refuses a type or status outside the register vocabulary, and a number another business has', async () => {
    const p = await prospect();
    expect((await p.company({ type: 'limited', status: 'active' })).status).toBe(400);
    expect((await p.company({ type: 'ltd' })).status).toBe(400);
    expect((await p.company({ type: 'ltd', status: 'trading' })).status).toBe(400);
    expect((await p.company({ type: 'sole_trader', status: 'active' })).status).toBe(400);
    expect((await p.company({ type: 'ltd', status: 'active', number: '0123-45' , register: 'uk_companies_house' })).status).toBe(400);
    expect((await p.company({ type: 'ltd', status: 'active', number: '01234567' })).status).toBe(400);
    expect((await p.company({ type: 'sole_trader' })).status).toBe(200);
    const other = await seedChain(db());
    await db().query(`UPDATE businesses SET company_register = 'uk_companies_house', company_number = '07654321' WHERE id = $1`, [other.businessId]);
    const dup = await p.company({ register: 'uk_companies_house', number: '07654321', type: 'ltd', status: 'active' });
    expect(dup.status).toBe(409);
    expect(dup.json().error).toMatch(/already has that company number/);
  });
});

describe('workspace isolation of the new writers', () => {
  it('writes no contact, company fact or suppression into another workspace', async () => {
    const seed = await seedWebsiteOpportunity(db());
    const home = await currentWs();
    const other = await enterNewWorkspace(db(), 'other');
    const { call } = await start(other);
    const o = `/api/opportunities/${seed.opportunityId}`;
    expect((await call('POST', `${o}/contacts`, LAWFUL)).status).toBe(404);
    expect((await call('POST', `${o}/company`, { type: 'ltd', status: 'active' })).status).toBe(404);
    expect((await call('POST', `${o}/suppressions`, { target: 'business', reason: 'dnc' })).status).toBe(404);
    expect((await call('POST', `${o}/outcomes`, { kind: 'pitched', occurredOn: today(), recordedBy: 'Sam', channel: 'email' })).status).toBe(404);
    await useWorkspace(db(), home);
    expect((await one<{ n: number }>(db(), 'SELECT count(*)::int AS n FROM contacts WHERE business_id = $1', [seed.businessId])).n).toBe(0);
    expect((await one<{ t: string | null }>(db(), 'SELECT company_type AS t FROM businesses WHERE id = $1', [seed.businessId])).t).toBeNull();
    expect((await one<{ n: number }>(db(), 'SELECT count(*)::int AS n FROM suppression')).n).toBe(0);
  });

  it('keeps the database guards on: the application role cannot touch another workspace’s rows', async () => {
    const seed = await seedWebsiteOpportunity(db());
    const other = await enterNewWorkspace(db(), 'other');
    await asApp(db(), other, async () => {
      const up = await db().query(`UPDATE businesses SET company_type = 'ltd', company_status = 'active' WHERE id = $1`, [seed.businessId]);
      expect(up.rowCount).toBe(0);
      expect(await refused(db(), () => recordSuppression(db(), { businessId: seed.businessId, reason: 'dnc' }))).toBeTruthy();
      expect(await failure(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis) VALUES ($1, 'X', 'manual', 'UNVERIFIED', 'unknown')`, [seed.businessId])).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------- 8-11 suppression

describe('suppression from the Case File', () => {
  it('suppresses a contact’s address, the domain or the business, once each, in this workspace only', async () => {
    const p = await prospect();
    const id = (await p.contact({ ...LAWFUL, outreachBasis: 'consent' })).json().contactId;
    expect((await p.cf()).buyer.contacts[0].emailBlocker).toBeNull();
    expect((await p.suppress({ target: 'email', contactId: id, reason: 'complaint' })).status).toBe(200);
    expect((await p.cf()).buyer.contacts[0].emailBlocker).toBe('contact or business is suppressed');
    // Adding it again changes nothing.
    const again = await p.suppress({ target: 'email', contactId: id, reason: 'complaint' });
    expect(again.status).toBe(200);
    expect((await p.suppress({ target: 'domain', reason: 'dnc' })).status).toBe(200);
    expect((await p.suppress({ target: 'business', reason: 'dnc' })).status).toBe(200);
    expect((await p.suppress({ target: 'business', reason: 'because' })).status).toBe(400);
    expect((await p.suppress({ target: 'email', email: 'anyone@else.test', reason: 'dnc' })).status).toBe(404);
    expect((await p.suppress({ target: 'everyone', reason: 'dnc' })).status).toBe(400);
    const rows = await db().query('SELECT email, domain, business_id, reason FROM suppression WHERE workspace_id = scopely.current_workspace_id() ORDER BY id');
    expect(rows.rows).toEqual([
      { email: 'sam@example-clinic.test', domain: null, business_id: null, reason: 'complaint' },
      { email: null, domain: expect.stringMatching(/^example-.+\.test$/), business_id: null, reason: 'dnc' },
      { email: null, domain: null, business_id: p.seed.businessId, reason: 'dnc' },
    ]);
    const cf = await p.cf();
    expect(cf.buyer.suppressions.map((x: { target: string }) => x.target)).toEqual(['email', 'domain', 'business']);
    expect(cf.readiness.status).toBe('SUPPRESSED');
    // Another workspace's list is untouched and its own contact of the same address is not blocked.
    await enterNewWorkspace(db(), 'other');
    const mine = await seedChain(db());
    const c = (await one<{ id: string }>(db(), `INSERT INTO contacts (business_id, email, source, label, outreach_basis) VALUES ($1, 'sam@example-clinic.test', 'manual', 'UNVERIFIED', 'consent') RETURNING id`, [mine.businessId])).id;
    expect((await one<{ b: string | null }>(db(), 'SELECT scopely.contact_outreach_blocker($1, $2) AS b', [c, mine.businessId])).b).toBeNull();
  });

  it('suppresses the business when an explicit opt-out reply is recorded, with no second step', async () => {
    const p = await prospect();
    await p.contact({ ...LAWFUL, outreachBasis: 'consent' });
    expect((await p.outcome({ kind: 'pitched', channel: 'email' })).status).toBe(200);
    expect(await suppressionRows(p.seed.businessId)).toEqual([]);
    expect((await p.outcome({ kind: 'replied', channel: 'email', replyClass: 'opt_out' })).status).toBe(200);
    expect(await suppressionRows(p.seed.businessId)).toEqual([{ email: null, domain: null, business_id: p.seed.businessId, reason: 'opt_out' }]);
    const cf = await p.cf();
    expect(cf.buyer.contacts[0].emailBlocker).toBe('contact or business is suppressed');
    expect(cf.readiness).toMatchObject({ status: 'SUPPRESSED', readyContactIds: [] });
    expect(check(cf, 'suppression')).toBe('blocked');
    // A second opt-out on another opportunity of the same business keeps the one entry.
    const opp2 = await seedOpportunity(db(), { ...p.seed, evidenceId: p.seed.evidenceId });
    await recordOutcome(db(), { opportunityId: opp2, kind: 'pitched', occurredAt: new Date().toISOString(), recordedBy: 'Sam', channel: 'email' });
    await recordOutcome(db(), { opportunityId: opp2, kind: 'replied', occurredAt: new Date().toISOString(), recordedBy: 'Sam', replyClass: 'opt_out' });
    expect(await suppressionRows(p.seed.businessId)).toHaveLength(1);
  });

  it('suppresses on an opt-out recorded by any writer, including the application role under row-level security', async () => {
    const chain = await seedChain(db());
    const opp = await seedOpportunity(db(), chain);
    const ws = await currentWs();
    await asApp(db(), ws, async () => {
      await recordOutcome(db(), { opportunityId: opp, kind: 'pitched', occurredAt: '2026-10-01T09:00:00Z', recordedBy: 'cli', channel: 'email' });
      await recordOutcome(db(), { opportunityId: opp, kind: 'replied', occurredAt: '2026-10-01T10:00:00Z', recordedBy: 'cli', replyClass: 'opt_out' });
      expect((await db().query('SELECT reason FROM suppression WHERE business_id = $1', [chain.businessId])).rows).toEqual([{ reason: 'opt_out' }]);
    });
  });

  it('does not suppress on any other outcome', async () => {
    for (const replyClass of ['positive', 'question', 'pricing', 'not_now', 'not_interested', 'wrong_person']) {
      const p = await prospect();
      expect((await p.outcome({ kind: 'pitched', channel: 'email' })).status).toBe(200);
      expect((await p.outcome({ kind: 'replied', replyClass })).status).toBe(200);
      expect((await p.outcome({ kind: 'call', channel: 'phone' })).status).toBe(200);
      expect((await p.outcome({ kind: 'lost', notes: 'No budget' })).status).toBe(200);
      expect(await suppressionRows(p.seed.businessId), replyClass).toEqual([]);
      expect(check(await p.cf(), 'suppression')).toBe('done');
    }
  });

  it('keeps a suppressed prospect out of the existing message approval and send gates', async () => {
    const p = await prospect();
    await p.recheck({ result: 'confirmed' });
    await p.company({ type: 'ltd', status: 'active' });
    const contactId = (await p.contact(LAWFUL)).json().contactId;
    const msg = (await one<{ id: string }>(db(), `INSERT INTO messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator)
      VALUES ($1, $2, 0, 's', 'b', $3, 'operator') RETURNING id`, [p.seed.opportunityId, contactId, [p.seed.evidenceId]])).id;
    await p.outcome({ kind: 'pitched', channel: 'phone' });
    await p.outcome({ kind: 'replied', channel: 'phone', replyClass: 'opt_out' });
    expect(await failure(db(), `UPDATE messages SET approval_status = 'approved', approved_by = 'Sam', approved_at = now() WHERE id = $1`, [msg]))
      .toMatch(/cannot approve: contact or business is suppressed/);
  });
});

// ---------------------------------------------------------------- 12-13 readiness

describe('prospect readiness', () => {
  it('never says evidence was re-checked when it was not, even when the gate lets it through', async () => {
    const p = await prospect();
    // A MEDIUM finding needs no re-check to pass the gate, and none is recorded.
    await db().query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [p.seed.evidenceId]);
    let ev = (await p.cf()).readiness.checks.find((c: { key: string }) => c.key === 'evidence');
    expect(ev).toEqual({ key: 'evidence', state: 'done', label: 'Evidence clear to use',
      detail: '1 finding has not been re-checked. Only a high-confidence finding must be.' });
    await p.recheck({ result: 'confirmed' });
    ev = (await p.cf()).readiness.checks.find((c: { key: string }) => c.key === 'evidence');
    expect(ev).toMatchObject({ state: 'done', label: 'Evidence re-checked and holds', detail: null });
  });

  it('reports each missing requirement from the gates, and becomes READY when all are met', async () => {
    const p = await prospect();
    let cf = await p.cf();
    expect(cf.readiness.status).toBe('NOT_READY');
    expect(Object.fromEntries(cf.readiness.checks.map((c: { key: string; state: string }) => [c.key, c.state])))
      .toEqual({ evidence: 'missing', contact: 'missing', lawful_basis: 'missing', company: 'missing', suppression: 'done' });
    expect(cf.readiness.checks.find((c: { key: string }) => c.key === 'evidence')).toMatchObject({ label: 'Evidence needs re-check' });
    expect(cf.readiness.evidenceBlocker).toMatch(/HIGH evidence .* has no confirmed re-check/);

    await p.recheck({ result: 'confirmed' });
    const id = (await p.contact(LAWFUL)).json().contactId;
    cf = await p.cf();
    expect(cf.readiness.status).toBe('NOT_READY');
    expect(check(cf, 'evidence')).toBe('done');
    expect(check(cf, 'company')).toBe('missing');

    await p.company({ register: 'uk_companies_house', number: '01234567', type: 'ltd', status: 'active' });
    cf = await p.cf();
    expect(cf.readiness).toMatchObject({ status: 'READY', readyContactIds: [id], evidenceBlocker: null });
    expect(cf.readiness.checks.every((c: { state: string }) => c.state === 'done')).toBe(true);
  });

  it('is READY for a consent contact outside a country rule, with no company check', async () => {
    const p = await prospect();
    await db().query(`UPDATE businesses SET country_code = 'CA' WHERE id = $1`, [p.seed.businessId]);
    await p.recheck({ result: 'confirmed' });
    await p.contact({ ...LAWFUL, outreachBasis: 'consent' });
    const cf = await p.cf();
    expect(cf.readiness.status).toBe('READY');
    expect(cf.readiness.checks.map((c: { key: string }) => c.key)).not.toContain('company');
  });

  it('never calls a prospect ready on a finding that no longer holds or a contact that is not permitted', async () => {
    const p = await prospect();
    await p.company({ type: 'ltd', status: 'active' });
    await p.contact({ ...LAWFUL, outreachBasis: 'not_permitted' });
    let cf = await p.cf();
    expect(check(cf, 'lawful_basis')).toBe('blocked');
    await p.contact({ ...LAWFUL, email: 'kit@example-clinic.test' });
    await p.recheck({ result: 'gone' });
    cf = await p.cf();
    expect(check(cf, 'evidence')).toBe('blocked');
    expect(cf.readiness).toMatchObject({ status: 'NOT_READY', readyContactIds: [] });
    // The contact itself passes its gate; the evidence is what stops it.
    expect(cf.buyer.contacts.some((c: { emailBlocker: string | null }) => c.emailBlocker === null)).toBe(true);
  });

  it('drops a changed finding and judges the rest, as the send gate requires', async () => {
    const fix = await seedFixOpportunity(db());
    const second = await addEvidence(db(), fix, fix.opportunityId, { code: 'E-TEL-BROKEN' });
    const { call } = await start();
    const o = `/api/opportunities/${fix.opportunityId}`;
    await call('POST', `${o}/evidence/${second}/recheck`, { result: 'changed', notes: 'Now a different number', recordedBy: 'Sam' });
    let cf = (await call('GET', o)).json();
    expect(check(cf, 'evidence')).toBe('missing');
    await call('POST', `${o}/evidence/${fix.evidenceId}/recheck`, { result: 'confirmed', recordedBy: 'Sam' });
    cf = (await call('GET', o)).json();
    expect(check(cf, 'evidence')).toBe('done');
  });
});

// ---------------------------------------------------------------- 14-16 Website, Fix and Sell still work

describe('existing flows with readiness in place', () => {
  it('Website: a HIGH finding re-checked from the Case File clears the show gate', async () => {
    const p = await prospect();
    const { projectId } = (await p.call('POST', `${p.o}/website`)).json();
    const run = (await p.call('POST', `/api/projects/${projectId}/generate`, { templateKey: 'meridian' })).json();
    expect(run.status).toBe('SUCCEEDED');
    const v2 = String((await p.call('POST', `/api/projects/${projectId}/save`, { baseBuildId: run.buildId,
      operations: [{ op: 'update_cta', action: { kind: 'whatsapp', value: '447700900123' } }] })).json().buildId);
    expect((await p.call('POST', `/api/projects/${projectId}/versions/${v2}/approve`, { approvedBy: 'Operator' })).status).toBe(200);
    expect((await p.call('POST', `/api/projects/${projectId}/versions/${v2}/show`)).json().error).toMatch(/re-?check/i);
    expect((await p.recheck({ result: 'confirmed' })).status).toBe(200);
    const shown = await p.call('POST', `/api/projects/${projectId}/versions/${v2}/show`);
    expect(shown.status).toBe(200);
    expect((await p.cf()).build.showLink).toMatchObject({ versionNo: 2 });
  });

  it('Fix: a fix is confirmed and shown after a Case File re-check', async () => {
    const fix = await seedFixOpportunity(db());
    const { call } = await start();
    const { projectId } = (await call('POST', `/api/opportunities/${fix.opportunityId}/fix`)).json();
    expect((await call('POST', `/api/fix/${projectId}/capture`, { evidenceId: fix.evidenceId })).status).toBe(200);
    expect((await call('POST', `/api/fix/${projectId}/corrections`, { evidenceId: fix.evidenceId, channel: 'whatsapp', value: '+44 7700 900123' })).status).toBe(200);
    const run = (await call('POST', `/api/fix/${projectId}/generate`)).json();
    expect(run.status).toBe('SUCCEEDED');
    expect((await call('POST', `/api/fix/${projectId}/versions/${run.buildId}/confirm`, { confirmedBy: 'Sam', confirmed: true })).status).toBe(200);
    expect((await call('POST', `/api/fix/${projectId}/versions/${run.buildId}/show`)).json().error).toMatch(/re-?check/i);
    expect((await call('POST', `/api/opportunities/${fix.opportunityId}/evidence/${fix.evidenceId}/recheck`, { result: 'confirmed', recordedBy: 'Sam' })).status).toBe(200);
    expect((await call('POST', `/api/fix/${projectId}/versions/${run.buildId}/show`)).status).toBe(200);
  });

  it('Sell: an ordinary pitch, reply, win and correction work as before and suppress nothing', async () => {
    const p = await prospect();
    expect((await p.outcome({ kind: 'pitched', channel: 'email' })).status).toBe(200);
    expect((await p.outcome({ kind: 'replied', replyClass: 'positive' })).status).toBe(200);
    const won = (await p.outcome({ kind: 'won', amount: 900, currency: 'GBP' })).json().outcomeId;
    expect((await p.outcome({ kind: 'voided', correctsOutcomeId: won, notes: 'Wrong business' })).status).toBe(200);
    expect((await p.outcome({ kind: 'won', amount: 950, currency: 'GBP' })).status).toBe(200);
    const cf = await p.cf();
    expect(cf.sell).toMatchObject({ sellState: 'WON', agreedAmount: '950.00' });
    expect(cf.buyer.suppressions).toEqual([]);
    expect(await suppressionRows(p.seed.businessId)).toEqual([]);
  });
});
