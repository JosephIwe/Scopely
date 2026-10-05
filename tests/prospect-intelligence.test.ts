// Slice 12: Prospect Intelligence. For an opportunity, who to contact, why them, how, how sure, and
// on what evidence: people and channels from a prospect provider (through the gateway) or from the
// seller, each with its own provenance and label; truth rules held by the database (016); readiness
// still read from the existing gates (A30); suppression still authoritative.
//
// No test calls Clay: the live transport runs against a fake MCP endpoint, everything else against a
// stub provider or the synthetic demo recording.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { assessBuyer, normalizeFact, runProspectLookup, suggestBuyer } from '../src/prospects/index.js';
import {
  CLAY_PEOPLE_QUERY, ClayMcpTransport, ClayProspectAdapter, EnvSecretResolver, type PeopleResult, type ProspectIntelligenceProvider, ProspectProviderRegistry,
  ProviderError, RecordedClayTransport, normalizeClayPerson, secretEnvName,
} from '../src/providers/index.js';
import { recordOutcome } from '../src/record/index.js';
import { createHandler } from '../src/server/app.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher } from './fix-helpers.js';
import { asApp, enterNewWorkspace, failure, one, useDb, useWorkspace } from './helpers.js';
import { SIGNING_KEY, seedWebsiteOpportunity } from './site-helpers.js';

const { db } = useDb();
const noSleep = async () => undefined;
const OBSERVED_AT = '2026-10-05T15:00:00.000Z';
const ws = async () => (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;

type Person = PeopleResult['people'][number];
const person = (ref: string, fullName: string | null, title: string | null, extra: Partial<Person> = {}): Person => ({
  ref, fullName, title, confidence: null, record: { entityId: ref, full_name: fullName, job_title: title },
  facts: [...(title ? [{ kind: 'title' as const, value: title }] : []), { kind: 'linkedin' as const, value: `https://uk.linkedin.com/in/${ref}/` }], ...extra,
});

/** A provider whose answers a test scripts: a result, or an error to throw, per call. */
class StubProvider implements ProspectIntelligenceProvider {
  readonly provider = 'stubco';
  readonly label = 'Stubco';
  readonly kinds = ['title', 'linkedin', 'email', 'phone'] as const;
  calls = 0;
  requests: Record<string, unknown>[] = [];
  constructor(private readonly answers: (Partial<PeopleResult> | Error)[], readonly transport: 'live' | 'recorded' = 'recorded') {}
  plan(q: { domain: string | null }) {
    return q.domain ? { request: { domain: q.domain } } : { refused: 'Scopely needs the business’s domain to look up its people.' };
  }
  async findPeople(request: Record<string, unknown>): Promise<PeopleResult> {
    this.requests.push(request);
    const a = this.answers[Math.min(this.calls++, this.answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return { people: [], businessFacts: [], observedAt: OBSERVED_AT, ref: `task-${this.calls}`, cost: null, ...a };
  }
}
const deps = (p: ProspectIntelligenceProvider) => ({ providers: new ProspectProviderRegistry().register(p), sleep: noSleep });

/** A prospect_intelligence call for the business, as the gateway records it (status as given). */
async function op(businessId: string, opts: { status?: 'SUCCEEDED' | 'FAILED'; capability?: string; provider?: string } = {}) {
  const failed = opts.status === 'FAILED';
  return (await one<{ id: string }>(db(), `INSERT INTO provider_operations (provider, capability, operation, transport, business_id, request_sha256, status,
      error_code, attempts, started_at, completed_at, latency_ms, result_count, cost_basis)
    VALUES ($1, $2, 'find_people', 'recorded', $3, repeat('a', 64), $4, $5, 1, now(), now(), 1, $6, 'NOT_REPORTED') RETURNING id`,
  [opts.provider ?? 'stubco', opts.capability ?? 'prospect_intelligence', businessId, failed ? 'FAILED' : 'SUCCEEDED', failed ? 'timeout' : null, failed ? null : 1])).id;
}
const providerPerson = (businessId: string, opId: string, cols = '', vals = '') => failure(db(),
  `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis, observed_at, provider_operation_id, provider_person_ref${cols})
   VALUES ($1, 'Morgan Reyes', 'stubco', 'UNVERIFIED', 'unknown', now(), $2, 'person:1'${vals})`, [businessId, opId]);

// ---------------------------------------------------------------- server over the test transaction

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = { BEGIN: 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv' };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}
let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function start(provider: ProspectIntelligenceProvider, workspaceId?: string) {
  const logged: string[] = [];
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId: workspaceId ?? await ws(), signingKey: SIGNING_KEY,
    fetcher: new StubFetcher(), editLinkTtlSeconds: 900, showLinkTtlSeconds: DEFAULT_SHOW_LINK_TTL_SECONDS, log: (l) => { logged.push(l); },
    prospects: { providers: new ProspectProviderRegistry().register(provider) } });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'x-scopely-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  return { call, logged };
}

// ---------------------------------------------------------------- 1. the database's truth rules (016)

describe('truth rules on people and facts (016)', () => {
  it('stores a provider’s person only as UNVERIFIED, not a decision maker, with no relationship, basis unknown and no mailbox check', async () => {
    const s = await seedWebsiteOpportunity(db());
    const o = await op(s.businessId);
    expect(await providerPerson(s.businessId, o)).toBeNull();
    for (const [cols, vals] of [[`, label`, `, 'VERIFIED'`], [', is_decision_maker, decision_maker_basis', `, true, 'the provider said so'`],
      [', relationship, relationship_basis', `, 'owner', 'the provider said so'`], [', outreach_basis', `, 'corporate_subscriber'`], [', mx_ok', ', true']] as const) {
      // Rebuild the insert with the claim in place of the safe value.
      const sql = `INSERT INTO contacts (business_id, full_name, source, observed_at, provider_operation_id, provider_person_ref,
          label, outreach_basis${cols.includes('label') || cols.includes('outreach') ? '' : cols})
        VALUES ($1, 'Kit Moss', 'stubco', now(), $2, $3, ${cols.includes('label') ? `'VERIFIED', 'unknown'` : cols.includes('outreach') ? `'UNVERIFIED', 'corporate_subscriber'` : `'UNVERIFIED', 'unknown'${vals}`})`;
      expect(await failure(db(), sql, [s.businessId, o, `person:${cols}`]), cols).toMatch(/TRUTH_RULE/);
    }
  });

  it('keeps where a provider’s person came from, and lets only a person with a basis raise its label', async () => {
    const s = await seedWebsiteOpportunity(db());
    const o = await op(s.businessId);
    await providerPerson(s.businessId, o);
    const id = (await one<{ id: string }>(db(), `SELECT id FROM contacts WHERE provider_person_ref = 'person:1'`)).id;
    for (const set of [`source = 'seller'`, `provider_person_ref = 'person:2'`, `observed_at = now() - interval '1 day'`, `provider_record = '{"a":1}'`]) {
      expect(await failure(db(), `UPDATE contacts SET ${set} WHERE id = $1`, [id]), set).toMatch(/where a person came from cannot change/);
    }
    expect(await failure(db(), `UPDATE contacts SET label = 'PUBLICLY_FOUND' WHERE id = $1`, [id])).toMatch(/only when a person records who checked it and how/);
    expect(await failure(db(), `UPDATE contacts SET label = 'PUBLICLY_FOUND', verified_by = 'Sam', verification_basis = 'Seen on their team page' WHERE id = $1`, [id])).toBeNull();
    // A seller's own contact cannot be re-attributed to a provider.
    const mine = (await one<{ id: string }>(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis) VALUES ($1, 'Jo', 'manual', 'UNVERIFIED', 'unknown') RETURNING id`, [s.businessId])).id;
    expect(await failure(db(), `UPDATE contacts SET provider_operation_id = $2, provider_person_ref = 'x', observed_at = now() WHERE id = $1`, [mine, o])).toMatch(/cannot be re-attributed/);
  });

  it('accepts a provider’s person only from a SUCCEEDED prospect lookup of the same provider about the same business', async () => {
    const s = await seedWebsiteOpportunity(db());
    const other = await seedWebsiteOpportunity(db());
    // One provider's person is one row per business: the same id twice is refused.
    const same = await op(s.businessId);
    expect(await providerPerson(s.businessId, same)).toBeNull();
    expect(await providerPerson(s.businessId, same)).toMatch(/contacts_provider_person_uq/);
    expect(await providerPerson(s.businessId, await op(s.businessId, { status: 'FAILED' }))).toMatch(/failed; a failed call found no one/);
    expect(await providerPerson(s.businessId, await op(s.businessId, { capability: 'business_discovery' }))).toMatch(/not a prospect lookup/);
    expect(await providerPerson(s.businessId, await op(s.businessId, { provider: 'otherco' }))).toMatch(/is otherco, not stubco/);
    expect(await providerPerson(s.businessId, await op(other.businessId))).toMatch(/looked up another business/);
    // Provenance is required: a provider row without an id for the person or a time is refused.
    expect(await failure(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis, provider_operation_id)
      VALUES ($1, 'X', 'stubco', 'UNVERIFIED', 'unknown', $2)`, [s.businessId, await op(s.businessId)])).toMatch(/provider_provenance/);
  });

  it('needs a basis for a decision maker, a relationship and VERIFIED, whoever records them', async () => {
    const s = await seedWebsiteOpportunity(db());
    const ins = (cols: string, vals: string) => failure(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis${cols})
      VALUES ($1, 'Sam', 'manual', 'UNVERIFIED', 'unknown'${vals})`, [s.businessId]);
    expect(await ins(', is_decision_maker', ', true')).toMatch(/decision_maker_needs_basis/);
    expect(await ins(', is_decision_maker, decision_maker_basis', `, true, '  '`)).toMatch(/decision_maker_needs_basis/);
    expect(await ins(', is_decision_maker, decision_maker_basis', `, true, 'Director at Companies House'`)).toBeNull();
    expect(await ins(', relationship', `, 'owner'`)).toMatch(/relationship_needs_basis/);
    expect(await ins(', relationship, relationship_basis', `, 'owner', 'Named as owner on the About page'`)).toBeNull();
    expect(await failure(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis) VALUES ($1, 'Sam', 'manual', 'VERIFIED', 'unknown')`, [s.businessId]))
      .toMatch(/verified_needs_basis/);
  });

  it('stores a provider’s fact UNVERIFIED, never changes what a fact says, raises it only with who and how, and never deletes one', async () => {
    const s = await seedWebsiteOpportunity(db());
    const other = await seedWebsiteOpportunity(db());
    const o = await op(s.businessId);
    const fact = (label = 'UNVERIFIED', extra = '', vals = '') => failure(db(), `INSERT INTO contact_facts (business_id, kind, value, source, observed_at, label, provider_operation_id${extra})
      VALUES ($1, 'phone', '+442079460000', 'stubco', now(), '${label}', $2${vals})`, [s.businessId, o]);
    expect(await fact('PUBLICLY_FOUND', ', verification_basis, verified_by, verified_at', `, 'x', 'y', now()`)).toMatch(/UNVERIFIED until a person checks it/);
    expect(await fact()).toBeNull();
    const id = (await one<{ id: string }>(db(), `SELECT id FROM contact_facts WHERE business_id = $1`, [s.businessId])).id;
    expect(await failure(db(), `UPDATE contact_facts SET value = '+442079460001' WHERE id = $1`, [id])).toMatch(/a fact is what its source said/);
    expect(await failure(db(), `UPDATE contact_facts SET label = 'VERIFIED' WHERE id = $1`, [id])).toMatch(/contact_facts_check/);
    expect(await failure(db(), `UPDATE contact_facts SET label = 'VERIFIED', verification_basis = 'Rang it; the practice answered', verified_by = 'Sam', verified_at = now() WHERE id = $1`, [id])).toBeNull();
    expect(await failure(db(), `DELETE FROM contact_facts WHERE id = $1`, [id])).toMatch(/never deleted/);
    // A fact needs exactly one origin, a value of its kind, a time that has happened, and a person of the same business.
    const seller = (kind: string, value: string, extra = '', vals = '', params: unknown[] = []) => failure(db(),
      `INSERT INTO contact_facts (business_id, kind, value, source, observed_at, label${extra}) VALUES ($1, '${kind}', '${value}', 'seller', now(), 'UNVERIFIED'${vals})`, [s.businessId, ...params]);
    expect(await seller('phone', '+442079460005')).toMatch(/"contact_facts_check"/);
    expect(await failure(db(), `INSERT INTO contact_facts (business_id, kind, value, source, observed_at, label, provider_operation_id, recorded_by)
      VALUES ($1, 'phone', '+442079460005', 'stubco', now(), 'UNVERIFIED', $2, 'Sam')`, [s.businessId, o])).toMatch(/"contact_facts_check"/);
    expect(await seller('phone', '+4420', ', recorded_by', `, 'Sam'`)).toMatch(/"contact_facts_check5"/);
    expect(await seller('title', 'Owner', ', recorded_by', `, 'Sam'`)).toMatch(/"contact_facts_check2"/);
    expect(await failure(db(), `INSERT INTO contact_facts (business_id, kind, value, source, observed_at, label, recorded_by) VALUES ($1, 'email', 'not-an-address', 'seller', now(), 'UNVERIFIED', 'Sam')`, [s.businessId])).toMatch(/check/);
    expect(await failure(db(), `INSERT INTO contact_facts (business_id, kind, value, source, observed_at, label, recorded_by) VALUES ($1, 'linkedin', 'in/someone', 'seller', now(), 'UNVERIFIED', 'Sam')`, [s.businessId])).toMatch(/check/);
    expect(await failure(db(), `INSERT INTO contact_facts (business_id, kind, value, source, observed_at, label, recorded_by) VALUES ($1, 'phone', '+442079460002', 'seller', now() + interval '1 day', 'UNVERIFIED', 'Sam')`, [s.businessId])).toMatch(/future/);
    const theirs = (await one<{ id: string }>(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis) VALUES ($1, 'Kit', 'manual', 'UNVERIFIED', 'unknown') RETURNING id`, [other.businessId])).id;
    expect(await failure(db(), `INSERT INTO contact_facts (business_id, contact_id, kind, value, source, observed_at, label, recorded_by) VALUES ($1, $2, 'phone', '+442079460003', 'seller', now(), 'UNVERIFIED', 'Sam')`, [s.businessId, theirs]))
      .toMatch(/belongs to another business/);
  });

  it('refuses a credential in a provider record', async () => {
    const s = await seedWebsiteOpportunity(db());
    expect(await providerPerson(s.businessId, await op(s.businessId), ', provider_record', `, '{"token":"sk-live0123456789abcdef0123"}'`)).toMatch(/SECRET/);
  });

  it('runs a live lookup only on a connection with the prospects scope', async () => {
    const s = await seedWebsiteOpportunity(db());
    const wsId = await ws();
    const conn = (scopes: string[]) => one<{ id: string }>(db(), `INSERT INTO provider_connections (provider, mode, scopes, credential_ref, state, activated_at)
      VALUES ('stubco', 'CUSTOMER_KEY', $1, $2, 'ACTIVE', now()) RETURNING id`, [scopes, `secretref:ws/${wsId}/stub${scopes.join('')}`]);
    const live = (connectionId: string) => failure(db(), `INSERT INTO provider_operations (provider, capability, operation, transport, provider_connection_id, billed_to,
        business_id, request_sha256, status, attempts, started_at, completed_at, latency_ms, result_count, cost_basis)
      VALUES ('stubco', 'prospect_intelligence', 'find_people', 'live', $1, 'WORKSPACE', $2, repeat('a', 64), 'SUCCEEDED', 1, now(), now(), 1, 0, 'NOT_REPORTED')`, [connectionId, s.businessId]);
    expect(await live((await conn(['discovery'])).id)).toMatch(/needs an ACTIVE prospects connection/);
    expect(await live((await conn(['prospects'])).id)).toBeNull();
  });
});

// ---------------------------------------------------------------- 2. workspace isolation

describe('workspace isolation', () => {
  it('never lets a workspace read, write or point at another workspace’s people, facts or lookups', async () => {
    const mine = await seedWebsiteOpportunity(db());
    const a = await ws();
    await runProspectLookup(db(), deps(new StubProvider([{ people: [person('p1', 'Morgan Reyes', 'Owner')] }])), mine.opportunityId, 'stubco');
    const contact = (await one<{ id: string }>(db(), `SELECT id FROM contacts WHERE business_id = $1`, [mine.businessId])).id;
    const opA = (await one<{ id: string }>(db(), `SELECT provider_operation_id AS id FROM contacts WHERE id = $1`, [contact])).id;
    const b = await enterNewWorkspace(db(), 'other');
    const theirs = await seedWebsiteOpportunity(db());
    // Another workspace's opportunity reads as missing, so its business is never looked up.
    await expect(runProspectLookup(db(), deps(new StubProvider([{}])), mine.opportunityId, 'stubco')).rejects.toMatchObject({ reason: 'not_found' });
    // Its rows cannot be pointed at from here.
    expect(await failure(db(), `INSERT INTO contact_facts (business_id, contact_id, kind, value, source, observed_at, label, recorded_by)
      VALUES ($1, $2, 'phone', '+442079460000', 'seller', now(), 'UNVERIFIED', 'Kit')`, [mine.businessId, contact])).toMatch(/WORKSPACE/);
    // Nor can its own people cite workspace A's provider call.
    expect(await failure(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis, observed_at, provider_operation_id, provider_person_ref)
      VALUES ($1, 'Morgan Reyes', 'stubco', 'UNVERIFIED', 'unknown', now(), $2, 'person:p1')`, [theirs.businessId, opA])).toMatch(/WORKSPACE: provider_operations/);
    expect(await failure(db(), `INSERT INTO contact_facts (business_id, kind, value, source, observed_at, label, provider_operation_id)
      VALUES ($1, 'phone', '+442079460000', 'stubco', now(), 'UNVERIFIED', $2)`, [theirs.businessId, opA])).toMatch(/WORKSPACE: provider_operations/);
    // Row-level security hides them from the application role.
    const seen = await asApp(db(), b, async () => ({
      contacts: (await db().query('SELECT 1 FROM contacts')).rowCount, facts: (await db().query('SELECT 1 FROM contact_facts')).rowCount,
      ops: (await db().query('SELECT 1 FROM provider_operations')).rowCount,
    }));
    expect(seen).toEqual({ contacts: 0, facts: 0, ops: 0 });
    const own = await asApp(db(), a, async () => (await db().query('SELECT 1 FROM contact_facts')).rowCount);
    expect(own).toBeGreaterThan(0);
  });

  it('refuses another workspace’s opportunity, fact or contact through the server', async () => {
    const mine = await seedWebsiteOpportunity(db());
    const stub = new StubProvider([{ people: [person('p1', 'Morgan Reyes', 'Owner', { facts: [{ kind: 'email', value: 'morgan@example-clinic.test' }] })] }]);
    await runProspectLookup(db(), deps(stub), mine.opportunityId, 'stubco');
    const f = await one<{ id: string; contact_id: string }>(db(), `SELECT id, contact_id FROM contact_facts WHERE kind = 'email'`);
    const b = await enterNewWorkspace(db(), 'other');
    const theirs = await seedWebsiteOpportunity(db());
    const { call } = await start(new StubProvider([{}]), b);
    expect((await call('POST', `/api/opportunities/${mine.opportunityId}/prospects/lookup`, { provider: 'stubco' })).status).toBe(404);
    // Through its own opportunity, workspace B still cannot reach A's fact or contact.
    expect((await call('POST', `/api/opportunities/${theirs.opportunityId}/facts/${f.id}`, { label: 'PUBLICLY_FOUND', basis: 'x', recordedBy: 'Kit' })).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${theirs.opportunityId}/contacts/${f.contact_id}/email`, { factId: f.id })).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${theirs.opportunityId}/facts`, { contactId: f.contact_id, kind: 'phone', value: '+442079460000', sourceUrl: 'https://x.test/', recordedBy: 'Kit' })).status).toBe(404);
    await useWorkspace(db(), (await one<{ ws: string }>(db(), 'SELECT workspace_id::text AS ws FROM contacts WHERE id = $1', [f.contact_id])).ws);
    expect(await one(db(), 'SELECT label FROM contact_facts WHERE id = $1', [f.id])).toEqual({ label: 'UNVERIFIED' });
  });
});

// ---------------------------------------------------------------- 3. the lookup

describe('a prospect lookup', () => {
  it('stores what the provider said as unverified people and facts, with the call that said it', async () => {
    const s = await seedWebsiteOpportunity(db());
    const stub = new StubProvider([{ people: [
      person('p1', 'Morgan Reyes', 'Practice Owner', { facts: [{ kind: 'title', value: 'Practice Owner' }, { kind: 'linkedin', value: 'https://www.linkedin.com/in/morgan/' },
        { kind: 'email', value: 'Morgan@Example-Clinic.test', confidence: 'MEDIUM' }, { kind: 'phone', value: 'call me maybe' }] }),
      person('p2', 'Priya Nand', 'Receptionist')],
    businessFacts: [{ kind: 'contact_page', value: 'https://example-clinic.test/contact#form' }] }]);
    const r = await runProspectLookup(db(), deps(stub), s.opportunityId, 'stubco');
    expect(r).toMatchObject({ provider: 'stubco', transport: 'recorded', returned: 2, added: 2, matched: 0, repeated: 0, factsAdded: 6, factsRejected: 1, error: null });
    expect(stub.requests).toEqual([{ domain: expect.stringMatching(/^example-.*\.test$/) }]);
    const opRow = await one(db(), `SELECT capability, operation, status, business_id::text, opportunity_id::text, result_count, cost_basis FROM provider_operations WHERE id = $1`, [r.operationId]);
    expect(opRow).toEqual({ capability: 'prospect_intelligence', operation: 'find_people', status: 'SUCCEEDED', business_id: s.businessId,
      opportunity_id: s.opportunityId, result_count: 2, cost_basis: 'NOT_REPORTED' });
    const people = (await db().query(`SELECT full_name, role, label, is_decision_maker, relationship, outreach_basis, email, mx_ok, source,
      provider_operation_id::text AS op, observed_at FROM contacts WHERE business_id = $1 ORDER BY id`, [s.businessId])).rows;
    expect(people).toEqual([
      { full_name: 'Morgan Reyes', role: 'Practice Owner', label: 'UNVERIFIED', is_decision_maker: false, relationship: null, outreach_basis: 'unknown', email: null,
        mx_ok: null, source: 'stubco', op: r.operationId, observed_at: new Date(OBSERVED_AT) },
      expect.objectContaining({ full_name: 'Priya Nand', label: 'UNVERIFIED', is_decision_maker: false }),
    ]);
    const facts = (await db().query(`SELECT kind, value, label, confidence, (contact_id IS NULL) AS business FROM contact_facts ORDER BY id`)).rows;
    // Normalized, never repaired: a lower-cased address, one LinkedIn host, the contact page without its fragment; a non-number dropped.
    expect(facts).toEqual(expect.arrayContaining([
      { kind: 'email', value: 'morgan@example-clinic.test', label: 'UNVERIFIED', confidence: 'MEDIUM', business: false },
      { kind: 'linkedin', value: 'https://www.linkedin.com/in/morgan', label: 'UNVERIFIED', confidence: null, business: false },
      { kind: 'contact_page', value: 'https://example-clinic.test/contact', label: 'UNVERIFIED', confidence: null, business: true },
    ]));
    expect(facts.some((f) => f.kind === 'phone')).toBe(false);
  });

  it('recognises a person already on file by provider id, profile or name, and never duplicates a fact', async () => {
    const s = await seedWebsiteOpportunity(db());
    // A seller's own contact with the same name as someone the provider will return.
    await db().query(`INSERT INTO contacts (business_id, full_name, role, source, label, outreach_basis) VALUES ($1, 'Priya  Nand', 'Practice manager', 'manual', 'PUBLICLY_FOUND', 'unknown')`, [s.businessId]);
    const first = [person('p1', 'Morgan Reyes', 'Owner'), person('p1', 'Morgan Reyes', 'Owner'), person('p2', 'priya nand', 'Practice Manager')];
    const again = [person('p1', 'Morgan Reyes', 'Owner'), person('p9', 'M. Reyes', 'Owner', { facts: [{ kind: 'linkedin', value: 'https://www.linkedin.com/in/p1' }, { kind: 'email', value: 'Morgan@Example-Clinic.test' }] })];
    const stub = new StubProvider([{ people: first }, { people: again }]);
    const r1 = await runProspectLookup(db(), deps(stub), s.opportunityId, 'stubco');
    expect(r1).toMatchObject({ returned: 2, added: 1, matched: 1, repeated: 1 });
    const r2 = await runProspectLookup(db(), deps(stub), s.opportunityId, 'stubco');
    expect(r2).toMatchObject({ returned: 2, added: 0, matched: 2, factsAdded: 1 });
    expect((await db().query('SELECT full_name FROM contacts WHERE business_id = $1 ORDER BY id', [s.businessId])).rows.map((x) => x.full_name))
      .toEqual(['Priya  Nand', 'Morgan Reyes']);
    // The seller's contact keeps what the seller recorded; the provider's title sits beside it as its own fact.
    expect(await one(db(), `SELECT role, source, provider_operation_id FROM contacts WHERE full_name = 'Priya  Nand'`)).toEqual({ role: 'Practice manager', source: 'manual', provider_operation_id: null });
    expect((await db().query(`SELECT count(*)::int AS n FROM contact_facts WHERE kind = 'linkedin' AND value = 'https://www.linkedin.com/in/p1'`)).rows[0].n).toBe(1);
  });

  it('keeps conflicting answers side by side and reports them, never overwriting', async () => {
    const s = await seedWebsiteOpportunity(db());
    await db().query(`INSERT INTO contacts (business_id, full_name, role, source, label, outreach_basis) VALUES ($1, 'Sam Alder', 'Practice manager', 'manual', 'PUBLICLY_FOUND', 'unknown')`, [s.businessId]);
    const stub = new StubProvider([{ people: [person('p1', 'Morgan Reyes', 'Owner'), person('p2', 'Sam Alder', 'Clinical Director')] },
      { people: [person('p1', 'Morgan Reyes', 'Associate')] }]);
    const r1 = await runProspectLookup(db(), deps(stub), s.opportunityId, 'stubco');
    expect(r1.conflicts).toEqual([expect.objectContaining({ kind: 'title', values: ['Clinical Director', 'Practice manager'] })]);
    const r2 = await runProspectLookup(db(), deps(stub), s.opportunityId, 'stubco');
    expect(r2.conflicts).toEqual([expect.objectContaining({ kind: 'title', values: ['Associate', 'Owner'] })]);
    // The first answer is still on file, as it was said.
    expect(await one(db(), `SELECT role FROM contacts WHERE full_name = 'Morgan Reyes'`)).toEqual({ role: 'Owner' });
    expect((await db().query(`SELECT value FROM contact_facts WHERE kind = 'title' ORDER BY value`)).rows.map((x) => x.value)).toEqual(['Associate', 'Clinical Director', 'Owner']);
  });

  it('records a lookup that found no one as a successful call with no result, and stores nothing', async () => {
    const s = await seedWebsiteOpportunity(db());
    const r = await runProspectLookup(db(), deps(new StubProvider([{ people: [] }])), s.opportunityId, 'stubco');
    expect(r).toMatchObject({ returned: 0, added: 0, error: null });
    expect(await one(db(), 'SELECT status, result_count FROM provider_operations WHERE id = $1', [r.operationId])).toEqual({ status: 'SUCCEEDED', result_count: 0 });
    expect((await db().query('SELECT 1 FROM contacts WHERE business_id = $1', [s.businessId])).rowCount).toBe(0);
  });

  it('retries an unavailable provider, records a timeout, and stores nothing from a failed call', async () => {
    const s = await seedWebsiteOpportunity(db());
    const flaky = new StubProvider([new ProviderError('provider_unavailable', 'HTTP 503'), { people: [person('p1', 'Morgan Reyes', 'Owner')] }]);
    expect(await runProspectLookup(db(), deps(flaky), s.opportunityId, 'stubco')).toMatchObject({ added: 1, error: null });
    expect(await one(db(), `SELECT status, attempts FROM provider_operations ORDER BY id DESC LIMIT 1`)).toEqual({ status: 'SUCCEEDED', attempts: 2 });

    const t = await seedWebsiteOpportunity(db());
    const abort = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    const slow = new StubProvider([abort]);
    const r = await runProspectLookup(db(), { ...deps(slow), maxAttempts: 2 }, t.opportunityId, 'stubco');
    expect(r.error).toEqual({ code: 'timeout', message: 'The provider took too long to answer.' });
    expect(slow.calls).toBe(2);
    expect(await one(db(), `SELECT status, error_code, attempts, result_count FROM provider_operations WHERE id = $1`, [r.operationId]))
      .toEqual({ status: 'FAILED', error_code: 'timeout', attempts: 2, result_count: null });
    expect((await db().query('SELECT 1 FROM contacts WHERE business_id = $1', [t.businessId])).rowCount).toBe(0);

    const bad = await seedWebsiteOpportunity(db());
    const refused = new StubProvider([new ProviderError('auth', 'Unauthorized: token sk-live0123456789abcdef was rejected')]);
    const r3 = await runProspectLookup(db(), deps(refused), bad.opportunityId, 'stubco');
    expect(r3.error?.code).toBe('auth');
    expect(refused.calls).toBe(1);
    expect(await one(db(), 'SELECT error_detail FROM provider_operations WHERE id = $1', [r3.operationId])).toEqual({ error_detail: '[redacted]' });
  });

  it('does not look up a business it cannot identify, or one on the suppression list, and calls nothing', async () => {
    const s = await seedWebsiteOpportunity(db());
    await db().query('UPDATE businesses SET domain = NULL WHERE id = $1', [s.businessId]);
    const stub = new StubProvider([{}]);
    await expect(runProspectLookup(db(), deps(stub), s.opportunityId, 'stubco')).rejects.toMatchObject({ reason: 'not_searchable' });

    const t = await seedWebsiteOpportunity(db());
    // An explicit opt-out reply suppresses the business (A29); Scopely then does not look up its people.
    await recordOutcome(db(), { opportunityId: t.opportunityId, kind: 'pitched', occurredAt: '2026-10-01T10:00:00Z', recordedBy: 'Sam' });
    await recordOutcome(db(), { opportunityId: t.opportunityId, kind: 'replied', replyClass: 'opt_out', occurredAt: '2026-10-02T10:00:00Z', recordedBy: 'Sam' });
    await expect(runProspectLookup(db(), deps(stub), t.opportunityId, 'stubco')).rejects.toMatchObject({ reason: 'suppressed' });
    const u = await seedWebsiteOpportunity(db());
    const domain = (await one<{ domain: string }>(db(), 'SELECT domain FROM businesses WHERE id = $1', [u.businessId])).domain;
    await db().query(`INSERT INTO suppression (domain, reason) VALUES ($1, 'dnc')`, [domain]);
    await expect(runProspectLookup(db(), deps(stub), u.opportunityId, 'stubco')).rejects.toMatchObject({ reason: 'suppressed' });
    expect(stub.calls).toBe(0);
    expect((await db().query(`SELECT 1 FROM provider_operations WHERE capability = 'prospect_intelligence'`)).rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------- 4. Clay

describe('Clay as a prospect provider', () => {
  const SECRET = 'clay-live-access-0123456789abcdef';
  const page = (people: Record<string, unknown>[]) => ({ taskId: 'mcp-task_people', hasMore: false, timestampMs: Date.parse(OBSERVED_AT),
    people: Object.fromEntries(people.map((p, i) => [String(p.entityId ?? i), p])) });

  function fakeClay(answer: (args: Record<string, unknown>) => Response) {
    const seen: { auth: string | null; body: string }[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      seen.push({ auth: (init.headers as Record<string, string>).authorization ?? null, body });
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }),
          { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
      }
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const res = answer(msg.params);
      if (res.status !== 200) return res;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: await res.json() }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { f, seen };
  }
  const ok = (v: unknown) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(v) }] }), { status: 200 });

  it('reads a Clay person as a name, a reported title and a profile, and nothing more', () => {
    expect(normalizeClayPerson({ entityId: '7', full_name: ' Morgan Reyes ', job_title: 'Owner', url: 'https://www.linkedin.com/in/morgan', bio: 'x' })).toEqual({
      ref: 'person:7', fullName: 'Morgan Reyes', title: 'Owner', confidence: null,
      facts: [{ kind: 'title', value: 'Owner' }, { kind: 'linkedin', value: 'https://www.linkedin.com/in/morgan' }],
      record: { entityId: '7', full_name: ' Morgan Reyes ', job_title: 'Owner', url: 'https://www.linkedin.com/in/morgan' },
    });
    expect(normalizeClayPerson({ full_name: 'No id' })).toBeNull();
    const a = new ClayProspectAdapter(new RecordedClayTransport([]));
    expect(a.plan({ businessName: 'X', domain: null, countryCode: null, providerRecords: [] })).toHaveProperty('refused');
    expect(a.plan({ businessName: 'X', domain: 'x.test', countryCode: null, providerRecords: [{ url: 'https://www.linkedin.com/company/x' }] }))
      .toEqual({ request: { companyIdentifiers: ['x.test', 'https://www.linkedin.com/company/x'], dsl: CLAY_PEOPLE_QUERY } });
  });

  it('calls search-contacts with the workspace’s key, bills the workspace, and never stores the key', async () => {
    const s = await seedWebsiteOpportunity(db());
    const w = await ws();
    const ref = `secretref:ws/${w}/clay`;
    const providers = (fetchImpl: typeof fetch) => new ProspectProviderRegistry().register(new ClayProspectAdapter(new ClayMcpTransport({ fetch: fetchImpl })));
    const secrets = new EnvSecretResolver({ [secretEnvName(ref)]: SECRET });
    const fake = fakeClay(() => ok(page([{ entityId: '7', full_name: 'Morgan Reyes', job_title: 'Owner', url: 'https://www.linkedin.com/in/morgan' }])));
    // No prospects connection: refused before any call.
    await db().query(`INSERT INTO provider_connections (provider, mode, scopes, credential_ref, state, activated_at) VALUES ('clay', 'CUSTOMER_KEY', '{discovery}', $1, 'ACTIVE', now())`, [ref]);
    await expect(runProspectLookup(db(), { providers: providers(fake.f), secrets, sleep: noSleep }, s.opportunityId, 'clay')).rejects.toMatchObject({ reason: 'not_connected' });
    expect(fake.seen).toHaveLength(0);
    const c = await one<{ id: string }>(db(), `INSERT INTO provider_connections (provider, mode, scopes, credential_ref, state, activated_at)
      VALUES ('clay', 'CUSTOMER_KEY', '{prospects}', $1, 'ACTIVE', now()) RETURNING id`, [ref]);
    const r = await runProspectLookup(db(), { providers: providers(fake.f), secrets, sleep: noSleep }, s.opportunityId, 'clay');
    expect(r).toMatchObject({ transport: 'live', added: 1, error: null });
    const call = fake.seen.map((x) => JSON.parse(x.body)).find((m) => m.method === 'tools/call');
    expect(call.params).toEqual({ name: 'search-contacts', arguments: { companyIdentifiers: [expect.stringMatching(/\.test$/)], dslQuery: CLAY_PEOPLE_QUERY } });
    expect(fake.seen.every((x) => x.auth === `Bearer ${SECRET}`)).toBe(true);
    expect(await one(db(), 'SELECT transport, provider_connection_id::text AS c, billed_to, cost_basis, request_ref FROM provider_operations WHERE id = $1', [r.operationId]))
      .toEqual({ transport: 'live', c: c.id, billed_to: 'WORKSPACE', cost_basis: 'NOT_REPORTED', request_ref: 'mcp-task_people' });
    const dump = JSON.stringify([(await db().query('SELECT * FROM provider_operations')).rows, (await db().query('SELECT * FROM contacts')).rows,
      (await db().query('SELECT * FROM contact_facts')).rows]);
    expect(dump).not.toContain(SECRET);
  });

  it('treats a page without people as malformed and stores no one', async () => {
    const s = await seedWebsiteOpportunity(db());
    const t = new RecordedClayTransport([{ query: CLAY_PEOPLE_QUERY, companyIdentifiers: [(await one<{ d: string }>(db(), 'SELECT domain AS d FROM businesses WHERE id = $1', [s.businessId])).d],
      pages: [{ taskId: 'x', companies: {} }] }]);
    const r = await runProspectLookup(db(), { providers: new ProspectProviderRegistry().register(new ClayProspectAdapter(t)), sleep: noSleep }, s.opportunityId, 'clay');
    expect(r.error?.code).toBe('malformed_response');
    expect((await db().query('SELECT 1 FROM contacts')).rowCount).toBe(0);
  });

  it('replays the synthetic demo recording, and says when a business has no recording', async () => {
    const t = RecordedClayTransport.fromFile(new URL('../fixtures/providers/clay/demo-people-search.json', import.meta.url).pathname);
    const s = await seedWebsiteOpportunity(db());
    const p = new ProspectProviderRegistry().register(new ClayProspectAdapter(t));
    expect((await runProspectLookup(db(), { providers: p, sleep: noSleep }, s.opportunityId, 'clay')).error?.code).toBe('not_recorded');
    await db().query(`UPDATE businesses SET domain = 'harbourlane.example' WHERE id = $1`, [s.businessId]);
    expect(await runProspectLookup(db(), { providers: p, sleep: noSleep }, s.opportunityId, 'clay')).toMatchObject({ added: 2, error: null });
  });
});

// ---------------------------------------------------------------- 5. why this person

describe('the buyer reading', () => {
  const base = { name: 'Morgan Reyes', role: null, relationship: null, relationshipBasis: null, isDecisionMaker: false, decisionMakerBasis: null,
    email: null, emailKind: null, provider: null, observedAt: null, reportedTitles: [] };
  const opp = { path: 'WEBSITE' as const, serviceName: 'Website build', businessName: 'Example Clinic' };

  it('confirms a decision maker only on a recorded basis; a title only ever makes a likely buyer, and says it is inferred', () => {
    const owner = assessBuyer({ ...base, provider: 'Stubco', reportedTitles: [{ value: 'Practice Owner', source: 'Stubco' }] }, opp);
    expect(owner.tier).toBe('LIKELY_BUYER');
    expect(owner.reasons.map((r) => r.state)).toEqual(['REPORTED', 'INFERRED']);
    expect(owner.reasons[1]!.text).toMatch(/Inferred from the title, not confirmed/);
    const confirmed = assessBuyer({ ...base, isDecisionMaker: true, decisionMakerBasis: 'Sole director at Companies House' }, opp);
    expect(confirmed).toMatchObject({ tier: 'DECISION_MAKER', reasons: [{ state: 'OBSERVED', text: 'Decision maker: Sole director at Companies House' }] });
    // A tick with no basis (a row from before Slice 12) is not a confirmation.
    expect(assessBuyer({ ...base, isDecisionMaker: true }, opp).tier).toBe('NAMED_CONTACT');
    expect(assessBuyer({ ...base, role: 'Receptionist' }, opp)).toMatchObject({ tier: 'NAMED_CONTACT', reasons: [{ state: 'RECORDED' }, { state: 'INFERRED' }] });
    expect(assessBuyer({ ...base, name: null, email: 'info@x.test' }, opp).tier).toBe('SHARED_ADDRESS');
    expect(assessBuyer({ ...base, relationship: 'owner', relationshipBasis: 'About page names them as owner' }, opp))
      .toMatchObject({ tier: 'LIKELY_BUYER', reasons: [{ state: 'OBSERVED', text: 'Owner of Example Clinic: About page names them as owner' }, { state: 'INFERRED' }] });
  });

  it('suggests the strongest buyer, then one the seller may email now', () => {
    const a = (tier: string) => ({ tier, reasons: [], summary: '' }) as never;
    expect(suggestBuyer([{ contactId: '1', assessment: a('NAMED_CONTACT'), readyToEmail: true }, { contactId: '2', assessment: a('LIKELY_BUYER'), readyToEmail: false }])?.contactId).toBe('2');
    expect(suggestBuyer([{ contactId: '1', assessment: a('LIKELY_BUYER'), readyToEmail: false }, { contactId: '2', assessment: a('LIKELY_BUYER'), readyToEmail: true }])?.contactId).toBe('2');
    expect(suggestBuyer([])).toBeNull();
  });

  it('normalizes a fact without inventing one', () => {
    expect(normalizeFact('phone', '020 7946 0461')).toBe('02079460461');   // no country is guessed
    expect(normalizeFact('phone', 'tel:+44 (0)20 7946 0461')).toBe('+4402079460461');
    expect(normalizeFact('whatsapp', 'https://wa.me/447700900461')).toBe('+447700900461'.slice(1));
    expect(normalizeFact('whatsapp', 'https://api.whatsapp.com/send?phone=07700900461')).toBe('07700900461');
    expect(normalizeFact('x', 'https://twitter.com/clinic/')).toBe('https://x.com/clinic');
    expect(normalizeFact('linkedin', 'https://www.instagram.com/clinic')).toBeNull();
    expect(normalizeFact('linkedin', 'https://www.linkedin.com/')).toBeNull();
    expect(normalizeFact('email', 'mailto:Info@Clinic.test?subject=hi')).toBe('info@clinic.test');
    expect(normalizeFact('email', 'info at clinic')).toBeNull();
    expect(normalizeFact('contact_page', 'javascript:alert(1)')).toBeNull();
    expect(normalizeFact('fax', '123456')).toBeNull();
  });
});

// ---------------------------------------------------------------- 6. the Case File, end to end through the server

describe('the Case File’s buyer and outreach preparation', () => {
  it('shows who, why, how and how sure, and stays NOT READY on provider data alone', async () => {
    const s = await seedWebsiteOpportunity(db());
    const stub = new StubProvider([{ people: [person('p1', 'Morgan Reyes', 'Practice Owner'), person('p2', 'Priya Nand', 'Receptionist')] }]);
    const { call, logged } = await start(stub);
    const o = `/api/opportunities/${s.opportunityId}`;
    const before = (await call('GET', o)).json();
    expect(before.buyer).toMatchObject({ contacts: [], suggestedContactId: null, lookups: [], providers: [{ key: 'stubco', transport: 'recorded', ready: true }] });
    const r = await call('POST', `${o}/prospects/lookup`, { provider: 'stubco' });
    expect(r.json()).toMatchObject({ added: 2, error: null });
    const cf = (await call('GET', o)).json();
    const morgan = cf.buyer.contacts.find((c: { name: string }) => c.name === 'Morgan Reyes');
    expect(cf.buyer.suggestedContactId).toBe(morgan.contactId);
    expect(morgan).toMatchObject({ label: 'UNVERIFIED', isDecisionMaker: false, relationship: null, confidence: null, observedAt: OBSERVED_AT,
      provenance: { provider: 'stubco', transport: 'recorded' }, assessment: { tier: 'LIKELY_BUYER' } });
    expect(morgan.facts.map((f: { kind: string; label: string; fromProvider: boolean }) => [f.kind, f.label, f.fromProvider]))
      .toEqual(expect.arrayContaining([['title', 'UNVERIFIED', true], ['linkedin', 'UNVERIFIED', true]]));
    expect(cf.buyer.lookups).toEqual([expect.objectContaining({ provider: 'stubco', status: 'SUCCEEDED', found: 2, cost: { basis: 'NOT_REPORTED', credits: null, amount: null, currency: null } })]);
    // Provider data never makes a prospect ready: no email of record, no lawful basis.
    expect(cf.readiness.status).toBe('NOT_READY');
    expect(cf.readiness.readyContactIds).toEqual([]);
    // Logs name ids and counts, never the people.
    expect(logged.join('\n')).not.toMatch(/Morgan|Priya|linkedin/i);
  });

  it('turns READY only when a person supplies the email, the basis and the checks the gates need', async () => {
    const s = await seedWebsiteOpportunity(db());
    const stub = new StubProvider([{ people: [person('p1', 'Morgan Reyes', 'Director', { facts: [{ kind: 'email', value: 'morgan@example-clinic.test' }] })] }]);
    const { call } = await start(stub);
    const o = `/api/opportunities/${s.opportunityId}`;
    await call('POST', `${o}/prospects/lookup`, { provider: 'stubco' });
    let cf = (await call('GET', o)).json();
    const m = cf.buyer.contacts[0];
    const email = m.facts.find((f: { kind: string }) => f.kind === 'email');
    // Checking a fact needs a basis and a recorder; withdrawal needs neither.
    expect((await call('POST', `${o}/facts/${email.factId}`, { label: 'VERIFIED', recordedBy: 'Sam' })).status).toBe(400);
    expect((await call('POST', `${o}/facts/${email.factId}`, { label: 'PUBLICLY_FOUND', basis: 'https://example-clinic.test/team', recordedBy: '' })).status).toBe(400);
    expect((await call('POST', `${o}/facts/${email.factId}`, { label: 'PUBLICLY_FOUND', basis: 'https://example-clinic.test/team', recordedBy: 'Sam' })).status).toBe(200);
    // Using it as the email of record keeps the contact no stronger than the fact.
    expect((await call('POST', `${o}/contacts/${m.contactId}/email`, { factId: email.factId })).status).toBe(200);
    expect(await one(db(), 'SELECT email, label FROM contacts WHERE id = $1', [m.contactId])).toEqual({ email: 'morgan@example-clinic.test', label: 'UNVERIFIED' });
    const edit = { fullName: 'Morgan Reyes', role: 'Director', email: 'morgan@example-clinic.test', label: 'UNVERIFIED', outreachBasis: 'corporate_subscriber' };
    // A decision maker needs what shows it; a provider's person is raised only with who checked it and how.
    expect((await call('POST', `${o}/contacts/${m.contactId}`, { ...edit, isDecisionMaker: true })).status).toBe(400);
    expect((await call('POST', `${o}/contacts/${m.contactId}`, { ...edit, label: 'PUBLICLY_FOUND' })).status).toBe(400);
    expect((await call('POST', `${o}/contacts/${m.contactId}`, { ...edit, label: 'PUBLICLY_FOUND', verificationBasis: 'On their team page', recordedBy: 'Sam',
      isDecisionMaker: true, decisionMakerBasis: 'Director at Companies House', relationship: 'director', relationshipBasis: 'Companies House officers list',
      source: 'forged' })).status).toBe(200);
    expect(await one(db(), 'SELECT source, label, verified_by, provider_operation_id IS NOT NULL AS from_provider FROM contacts WHERE id = $1', [m.contactId]))
      .toEqual({ source: 'stubco', label: 'PUBLICLY_FOUND', verified_by: 'Sam', from_provider: true });
    cf = (await call('GET', o)).json();
    expect(cf.buyer.contacts[0].assessment.tier).toBe('DECISION_MAKER');
    expect(cf.readiness.status).toBe('NOT_READY');   // the company register status and the re-check are still missing
    await call('POST', `${o}/company`, { type: 'ltd', status: 'active', register: 'uk_companies_house' });
    await call('POST', `${o}/evidence/${s.evidenceId}/recheck`, { result: 'confirmed', recordedBy: 'Sam' });
    cf = (await call('GET', o)).json();
    expect(cf.readiness).toMatchObject({ status: 'READY', readyContactIds: [m.contactId] });
    // Suppression stays authoritative: the address goes on the list and the prospect is no longer ready.
    await call('POST', `${o}/suppressions`, { target: 'email', contactId: m.contactId, reason: 'opt_out' });
    expect((await call('GET', o)).json().readiness.status).toBe('SUPPRESSED');
    expect((await call('POST', `${o}/prospects/lookup`, { provider: 'stubco' })).status).toBe(200);   // an address, not the business
    await call('POST', `${o}/suppressions`, { target: 'business', reason: 'dnc' });
    const refused = await call('POST', `${o}/prospects/lookup`, { provider: 'stubco' });
    expect(refused.status).toBe(422);
    expect(refused.json().reason).toBe('suppressed');
  });

  it('records a channel the seller found, with its page, and refuses one that is not of its kind', async () => {
    const s = await seedWebsiteOpportunity(db());
    const { call } = await start(new StubProvider([{}]));
    const o = `/api/opportunities/${s.opportunityId}`;
    const add = (body: Record<string, unknown>) => call('POST', `${o}/facts`, { recordedBy: 'Sam', sourceUrl: 'https://example-clinic.test/contact', ...body });
    expect((await add({ kind: 'instagram', value: 'https://www.instagram.com/exampleclinic' })).status).toBe(200);
    expect((await add({ kind: 'instagram', value: 'https://www.instagram.com/exampleclinic/' })).status).toBe(409);
    expect((await add({ kind: 'phone', value: 'ring us' })).status).toBe(400);
    expect((await add({ kind: 'title', value: 'Owner' })).status).toBe(400);
    expect((await add({ kind: 'phone', value: '+44 20 7946 0461', sourceUrl: null })).status).toBe(400);
    expect((await add({ kind: 'email', value: 'x@y.test', label: 'VERIFIED' })).status).toBe(400);
    const cf = (await call('GET', o)).json();
    expect(cf.buyer.businessChannels).toEqual([expect.objectContaining({ kind: 'instagram', value: 'https://www.instagram.com/exampleclinic', origin: 'fact',
      label: 'PUBLICLY_FOUND', source: 'seller', sourceUrl: 'https://example-clinic.test/contact' })]);
  });

  it('lists the channels Scopely saw on the business’s own page, and a broken one only as broken', async () => {
    const s = await seedWebsiteOpportunity(db());
    const rule = (await one<{ id: string }>(db(), `SELECT id FROM rule_versions WHERE rule_key = 'check.contact_links' AND version = 2`)).id;
    const signals = (await one<{ id: string }>(db(), `SELECT id FROM rule_versions WHERE rule_key = 'check.page_signals' AND version = 1`)).id;
    const snap = (await one<{ id: string }>(db(), `INSERT INTO snapshots (business_id, url, http_status, fetched_at, fetch_method) VALUES ($1, 'https://example-clinic.test/', 200, '2026-10-05T09:00:00Z', 'http') RETURNING id`, [s.businessId])).id;
    await db().query(`INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result, href, observed_at) VALUES
      ($1, 'contact_links.phone', $2, 'OBSERVED', 'ok', 'tel:+442079460461', '2026-10-05T09:00:00Z'),
      ($1, 'contact_links.email', $2, 'OBSERVED', 'ok', 'mailto:Info@example-clinic.test', '2026-10-05T09:00:00Z'),
      ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'defect', 'https://api.whatsapp.com/send?phone=07700900461', '2026-10-05T09:00:00Z'),
      ($1, 'page_signals.contact_page', $3, 'OBSERVED', 'ok', '/contact-us', '2026-10-05T09:00:00Z')`, [snap, rule, signals]);
    const { call } = await start(new StubProvider([{}]));
    const ch = (await call('GET', `/api/opportunities/${s.opportunityId}`)).json().buyer.businessChannels;
    expect(ch.map((c: { kind: string; value: string; broken: boolean; origin: string }) => [c.kind, c.value, c.broken, c.origin])).toEqual(expect.arrayContaining([
      ['phone', '+442079460461', false, 'analysis'], ['email', 'info@example-clinic.test', false, 'analysis'],
      ['whatsapp', '07700900461', true, 'analysis'], ['contact_page', 'https://example-clinic.test/contact-us', false, 'analysis']]));
    expect(ch.every((c: { observedAt: string; sourceUrl: string }) => c.observedAt === '2026-10-05T09:00:00.000Z' && c.sourceUrl === 'https://example-clinic.test/')).toBe(true);
  });
});
