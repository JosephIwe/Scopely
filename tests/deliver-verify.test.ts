// Release 1, Deliver and Verify (A44–A46). A delivery is the existing `delivered` outcome, judged by
// outcome_guard; a verification re-reads the baseline finding's own page once with the SSRF-safe
// probe, re-runs the same check and rule version on a new snapshot, and records PASSED, FAILED or
// NOT_OBSERVABLE through verification_guard. A failed fetch is never a pass, and nothing is declared
// verified because a build or a delivery exists.
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { DemoAwareProbe, type Probe, type ProbeResult } from '../src/analysis/index.js';
import { AT, TableProbe } from './analysis-helpers.js';
import { catalogId, enterNewWorkspace, failure, one, seedChain, seedOpportunity, useDb, useWorkspace } from './helpers.js';
import { useServer } from './server-helpers.js';

const { db } = useDb();
const start = useServer(db);

/** Counts what was requested, then answers from `inner`. */
class CountingProbe implements Probe {
  calls: string[] = [];
  constructor(private readonly inner: Probe) {}
  get(url: string, opts?: { body?: boolean }): Promise<ProbeResult> {
    this.calls.push(url);
    return this.inner.get(url, opts);
  }
}

interface Finding { url: string; checkCode: string; href: string; visibleText: string; issueCode: string; plainIssue: string; quote: string;
  ruleKey?: string; observedAt?: string; claimState?: 'OBSERVED' | 'INFERRED'; catalogKey?: string }

/** A business with one finding recorded under an automated rule (v2 by default), mapped to a priced fix opportunity. */
async function seedFinding(d: pg.Client, f: Finding) {
  const observedAt = f.observedAt ?? '2026-09-25T09:30:00Z';
  const host = new URL(f.url).hostname;
  const b = await one<{ id: string }>(d, `INSERT INTO businesses (name, domain, website_url) VALUES ('Quayside Physio', $1, $2) RETURNING id`, [host, `https://${host}/`]);
  const s = await one<{ id: string }>(d, `INSERT INTO snapshots (business_id, url, http_status, fetched_at, fetch_method) VALUES ($1, $2, 200, $3, 'http') RETURNING id`,
    [b.id, f.url, observedAt]);
  const rule = await one<{ id: string }>(d, `SELECT id FROM rule_versions WHERE rule_key = $1 AND version = 2`, [f.ruleKey ?? 'check.contact_links']);
  const o = await one<{ id: string }>(d, `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result, href, visible_text, observed_at)
    VALUES ($1, $2, $3, 'OBSERVED', 'defect', $4, $5, $6) RETURNING id`, [s.id, f.checkCode, rule.id, f.href, f.visibleText, observedAt]);
  const e = await one<{ id: string }>(d, `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, observed_at, confidence)
    VALUES ($1, $2, $3, $4, 'OBSERVED', $5, $6, $7, $8, 'HIGH') RETURNING id`, [b.id, o.id, f.issueCode, rule.id, f.plainIssue, f.url, f.quote, observedAt]);
  const cat = await catalogId(d, f.catalogKey ?? 'website_fix_sprint');
  const opp = await one<{ id: string }>(d, `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price)
    VALUES ($1, 'broken_contact_path', 'MAPPED', $2, 'GBP', 120) RETURNING id`, [b.id, cat]);
  await d.query('INSERT INTO opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2)', [opp.id, e.id]);
  return { businessId: b.id, evidenceId: e.id, opp: opp.id, ruleId: rule.id };
}

/** The demo's broken phone link, whose fixture page (quayside.example__contact.html) shows it corrected. */
const QUAYSIDE: Finding = {
  url: 'https://quayside.example/contact', checkCode: 'contact_links.phone', href: 'tel:+44 (0)20 7946 0999', visibleText: 'Call the clinic', issueCode: 'E-TEL-BROKEN',
  plainIssue: 'The "Call the clinic" phone link keeps the 0 after +44, so the number cannot be dialled', quote: '<a href="tel:+44 (0)20 7946 0999">Call the clinic</a>',
};
/** The Harbour Lane demo page, whose "WhatsApp us" link is still broken. */
const HARBOUR: Finding = {
  url: 'https://harbourlane.example/', checkCode: 'contact_links.whatsapp', href: 'https://api.whatsapp.com/send?phone=07700900461', visibleText: 'WhatsApp us',
  issueCode: 'E-WA-BROKEN', plainIssue: 'The "WhatsApp us" button uses a number with no country code',
  quote: '<a class="wa" href="https://api.whatsapp.com/send?phone=07700900461">WhatsApp us</a>',
};

type Call = Awaited<ReturnType<typeof start>>['call'];
async function pitchAndWin(call: Call, opp: string) {
  expect((await call('POST', `/api/opportunities/${opp}/outcomes`, { kind: 'pitched', occurredOn: '2026-10-01', recordedBy: 'Sam', channel: 'email' })).status).toBe(200);
  expect((await call('POST', `/api/opportunities/${opp}/outcomes`, { kind: 'won', occurredOn: '2026-10-02', recordedBy: 'Sam', amount: '120' })).status).toBe(200);
}
const today = () => new Date().toISOString().slice(0, 10);
async function deliver(call: Call, opp: string, body: Record<string, unknown> = {}) {
  return call('POST', `/api/opportunities/${opp}/delivery`, { occurredOn: today(), deliveredBy: 'operator', notes: 'Corrected the phone link.', recordedBy: 'Sam', ...body });
}
const count = async (d: pg.Client, table: string, where = 'true', params: unknown[] = []) =>
  Number((await one<{ n: string }>(d, `SELECT count(*) AS n FROM ${table} WHERE ${where}`, params)).n);

describe('recording a delivery', () => {
  it('refuses a delivery before a win, then records one on a won opportunity as the delivered outcome', async () => {
    const f = await seedFinding(db(), QUAYSIDE);
    const { call } = await start();
    const early = await deliver(call, f.opp);
    expect(early.status).toBe(409);
    expect(early.json().error).toMatch(/Record the win first/);
    expect(await count(db(), 'outcomes', `opportunity_id = $1 AND kind = 'delivered'`, [f.opp])).toBe(0);
    let cf = (await call('GET', `/api/opportunities/${f.opp}`)).json();
    expect(cf.deliver.can.deliver).toBe(false);
    expect(cf.deliver.ladder.map((s: { key: string; state: string }) => [s.key, s.state])).toEqual(
      [['proposed', 'done'], ['pitched', 'current'], ['won', 'todo'], ['delivered', 'todo'], ['verified', 'todo']]);

    await pitchAndWin(call, f.opp);
    const ok = await deliver(call, f.opp, { clientConfirmed: true });
    expect(ok.status).toBe(200);
    const o = await one<Record<string, any>>(db(), 'SELECT * FROM outcomes WHERE id = $1', [ok.json().outcomeId]);
    expect(o).toMatchObject({ kind: 'delivered', delivered_by: 'operator', client_confirmed: true, notes: 'Corrected the phone link.', recorded_by: 'Sam', amount: null });
    cf = (await call('GET', `/api/opportunities/${f.opp}`)).json();
    expect(cf.sell).toMatchObject({ sellState: 'WON', deliveryState: 'DELIVERED' });
    expect(cf.stage).toBe('DELIVER');
    expect(cf.deliver.deliveries).toEqual([expect.objectContaining({ deliveredBy: 'operator', clientConfirmed: true, recordedBy: 'Sam' })]);
    // Delivered is not verified: nothing is declared verified until a re-observation passes.
    expect(cf.deliver.ladder.map((s: { key: string; state: string }) => [s.key, s.state])).toEqual(
      [['proposed', 'done'], ['pitched', 'done'], ['won', 'done'], ['delivered', 'done'], ['verified', 'current']]);
    expect(cf.deliver.can.verify).toBe(true);
  });

  it('records CLIENT_REQUIRED work only as delivered by the client with confirmation (outcome_guard)', async () => {
    const f = await seedFinding(db(), QUAYSIDE);
    const own = await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, implementation_type, supported_issue_codes)
      VALUES ('client_fix', 'Client fix', 'The business changes its own site.', 'CLIENT_REQUIRED', ARRAY['E-TEL-BROKEN']) RETURNING id`);
    await db().query(`UPDATE opportunities SET catalog_item_id = $2, service_price = NULL WHERE id = $1`, [f.opp, own.id]);
    const { call } = await start();
    await pitchAndWin(call, f.opp);
    const byUs = await deliver(call, f.opp);
    expect(byUs.status).toBe(409);
    expect(byUs.json().error).toMatch(/delivered by the client, with their confirmation/);
    expect((await deliver(call, f.opp, { deliveredBy: 'client', clientConfirmed: false })).status).toBe(409);
    expect((await deliver(call, f.opp, { deliveredBy: 'client', clientConfirmed: true })).status).toBe(200);
    expect((await call('GET', `/api/opportunities/${f.opp}`)).json().deliver.implementationType).toBe('CLIENT_REQUIRED');
  });

  it('needs who did it, who records it and a date that has happened; the outcomes route still never records a delivery', async () => {
    const f = await seedFinding(db(), QUAYSIDE);
    const { call } = await start();
    await pitchAndWin(call, f.opp);
    expect((await deliver(call, f.opp, { deliveredBy: 'robot' })).status).toBe(400);
    expect((await deliver(call, f.opp, { recordedBy: ' ' })).status).toBe(400);
    expect((await deliver(call, f.opp, { occurredOn: '2999-01-01' })).status).toBe(400);
    expect((await call('POST', `/api/opportunities/${f.opp}/outcomes`, { kind: 'delivered', occurredOn: today(), recordedBy: 'Sam' })).status).toBe(400);
    expect(await count(db(), 'outcomes', `opportunity_id = $1 AND kind = 'delivered'`, [f.opp])).toBe(0);
  });

  it('refuses a delivery on a lost opportunity, and after a win is corrected', async () => {
    const f = await seedFinding(db(), QUAYSIDE);
    const { call } = await start();
    await pitchAndWin(call, f.opp);
    const won = await one<{ id: string }>(db(), `SELECT id FROM outcomes WHERE opportunity_id = $1 AND kind = 'won'`, [f.opp]);
    expect((await call('POST', `/api/opportunities/${f.opp}/outcomes`, { kind: 'voided', occurredOn: '2026-10-03', recordedBy: 'Sam', correctsOutcomeId: won.id, notes: 'Typed in error' })).status).toBe(200);
    expect((await deliver(call, f.opp)).status).toBe(409);
    const cf = (await call('GET', `/api/opportunities/${f.opp}`)).json();
    expect(cf.deliver.corrections).toEqual([expect.objectContaining({ correctedKind: 'won', notes: 'Typed in error' })]);
    expect(cf.deliver.ladder.find((s: { key: string }) => s.key === 'won').state).not.toBe('done');
    expect((await call('POST', `/api/opportunities/${f.opp}/outcomes`, { kind: 'lost', occurredOn: '2026-10-04', recordedBy: 'Sam' })).status).toBe(200);
    expect((await deliver(call, f.opp)).status).toBe(409);
    const lost = (await call('GET', `/api/opportunities/${f.opp}`)).json().deliver;
    expect(lost.ladder.find((s: { key: string }) => s.key === 'won')).toMatchObject({ label: 'Lost', state: 'lost' });
    expect(lost.blockers.deliver).toMatch(/lost/);
  });
});

describe('verifying a delivered fix', () => {
  async function delivered(f: Finding, probe: Probe) {
    const s = await seedFinding(db(), f);
    const counting = new CountingProbe(probe);
    const { call } = await start({ probe: counting });
    await pitchAndWin(call, s.opp);
    // Delivered on 4 October: before the fixed time the table probe answers at (AT, 5 October).
    expect((await deliver(call, s.opp, { occurredOn: '2026-10-04' })).status).toBe(200);
    const verify = (body: Record<string, unknown> = { requestedBy: 'Sam' }) => call('POST', `/api/opportunities/${s.opp}/evidence/${s.evidenceId}/verify`, body);
    return { ...s, call, probe: counting, verify };
  }

  it('PASSED when the defect is no longer observed: one request of the evidence’s own page, a new snapshot, the same check and rule version', async () => {
    const v = await delivered(QUAYSIDE, new DemoAwareProbe());
    // The request names no address: anything in the body is ignored.
    const r = await v.verify({ requestedBy: 'Sam', url: 'http://169.254.169.254/' });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ status: 'PASSED', requests: 1 });
    expect(r.json().changed).toMatch(/went from tel:\+44 \(0\)20 7946 0999 to tel:\+442079460999/);
    expect(v.probe.calls).toEqual([QUAYSIDE.url]);
    const row = await one<Record<string, any>>(db(), `SELECT v.*, s.fetch_method, s.fetched_at, s.url AS snap_url, s.http_status, o.check_code, o.state, o.result, o.rule_version_id AS obs_rule
        FROM verifications v JOIN snapshots s ON s.id = v.snapshot_id JOIN observations o ON o.id = v.observation_id WHERE v.id = $1`, [r.json().verificationId]);
    expect(row).toMatchObject({ status: 'PASSED', requested_by: 'Sam', fetch_method: 'http', snap_url: QUAYSIDE.url, http_status: 200,
      check_code: 'contact_links.phone', state: 'OBSERVED', result: 'ok', rule_version_id: v.ruleId, obs_rule: v.ruleId });
    expect(new Date(row.fetched_at).getTime()).toBeGreaterThan(Date.parse('2026-09-25T09:30:00Z'));
    expect(await count(db(), 'cost_events', `opportunity_id = $1 AND kind = 'fetch' AND meta->>'purpose' = 'verification'`, [v.opp])).toBe(1);
    const cf = (await v.call('GET', `/api/opportunities/${v.opp}`)).json();
    expect(cf.sell.deliveryState).toBe('VERIFIED_PASSED');
    expect(cf.status).toBe('VERIFIED');
    expect(cf.stage).toBe('VERIFY');
    expect(cf.deliver.ladder.find((s: { key: string }) => s.key === 'verified').state).toBe('done');
    const e = cf.deliver.evidence[0];
    expect(e.latest).toMatchObject({ status: 'PASSED', requestedBy: 'Sam', source: { url: QUAYSIDE.url, httpStatus: 200, method: 'http' },
      observation: { checkCode: 'contact_links.phone', state: 'OBSERVED', result: 'ok', href: 'tel:+442079460999' } });
    expect(e.latest.unknown).toMatch(/not checked/);
    expect(cf.deliver.evidence[0]).toMatchObject({ plainIssue: QUAYSIDE.plainIssue, url: QUAYSIDE.url, baseline: { href: QUAYSIDE.href, result: 'defect' } });
  });

  it('FAILED when the defect is still on the page', async () => {
    const v = await delivered(HARBOUR, new DemoAwareProbe());
    const r = await v.verify();
    expect(r.json()).toMatchObject({ status: 'FAILED' });
    expect(r.json().changed).toMatch(/still on the page/);
    const cf = (await v.call('GET', `/api/opportunities/${v.opp}`)).json();
    expect(cf.sell.deliveryState).toBe('VERIFIED_FAILED');
    expect(cf.status).toBe('DELIVERED');
    expect(cf.deliver.ladder.find((s: { key: string }) => s.key === 'verified').state).toBe('failed');
  });

  it('NOT_OBSERVABLE when the page cannot be read or judged, never a pass', async () => {
    const answers: [string, ConstructorParameters<typeof TableProbe>[0]][] = [
      ['missing host', {}],
      ['timeout', { [QUAYSIDE.url]: { error: 'timeout' } }],
      ['blocked', { [QUAYSIDE.url]: { error: 'blocked' } }],
      ['server error', { [QUAYSIDE.url]: { status: 503 } }],
      ['not a page', { [QUAYSIDE.url]: { contentType: 'application/pdf' } }],
      ['link gone', { [QUAYSIDE.url]: { html: '<html><body><p>Call us on 020 7946 0999.</p></body></html>' } }],
    ];
    for (const [what, pages] of answers) {
      const v = await delivered({ ...QUAYSIDE, observedAt: '2026-09-25T09:30:00Z' }, new TableProbe(pages));
      const r = await v.verify();
      expect(r.status, what).toBe(200);
      expect(r.json().status, what).toBe('NOT_OBSERVABLE');
      const o = await one<Record<string, any>>(db(), `SELECT o.state, o.result FROM verifications v JOIN observations o ON o.id = v.observation_id WHERE v.id = $1`, [r.json().verificationId]);
      expect(o, what).toEqual({ state: 'NOT_OBSERVABLE', result: null });
      const cf = (await v.call('GET', `/api/opportunities/${v.opp}`)).json();
      expect(cf.sell.deliveryState, what).toBe('VERIFIED_NOT_OBSERVABLE');
      expect(cf.deliver.ladder.find((s: { key: string }) => s.key === 'verified').state, what).not.toBe('done');
    }
    // A real private address is refused by the probe itself, before any connection: blocked, not observable.
    const v = await delivered({ ...QUAYSIDE, url: 'http://127.0.0.1/contact' }, new DemoAwareProbe());
    expect((await v.verify()).json().status).toBe('NOT_OBSERVABLE');
  });

  it('re-traces a booking link once more under its own rule: PASSED when it now answers, FAILED on a 404', async () => {
    const booking: Finding = { url: 'https://lanephysio.test/', checkCode: 'booking_cta_trace.target', href: 'https://book.lanephysio.test/old', visibleText: 'Book an appointment',
      issueCode: 'E-CTA-DEAD-END', plainIssue: 'The "Book an appointment" booking link goes to a page that answered 404', quote: '<a href="https://book.lanephysio.test/old">Book an appointment</a>',
      ruleKey: 'check.booking_cta_trace', observedAt: '2026-09-20T10:00:00Z' };
    const page = '<html><body><a href="https://book.lanephysio.test/new">Book an appointment</a></body></html>';
    const fixed = await delivered(booking, new TableProbe({ [booking.url]: { html: page }, 'https://book.lanephysio.test/new': { status: 200 } }));
    const ok = (await fixed.verify()).json();
    expect(ok).toMatchObject({ status: 'PASSED', requests: 2 });
    expect(fixed.probe.calls).toEqual([booking.url, 'https://book.lanephysio.test/new']);
    expect(await count(db(), 'cost_events', `opportunity_id = $1 AND meta->>'purpose' = 'verification'`, [fixed.opp])).toBe(2);
    const dead = await delivered(booking, new TableProbe({ [booking.url]: { html: page }, 'https://book.lanephysio.test/new': { status: 404 } }));
    expect((await dead.verify()).json().status).toBe('FAILED');
  });

  it('refuses before a delivery, a finding under a person’s (v1) rule, and an inferred finding, writing nothing', async () => {
    const s = await seedFinding(db(), QUAYSIDE);
    const probe = new CountingProbe(new DemoAwareProbe());
    const { call } = await start({ probe });
    const before = await call('POST', `/api/opportunities/${s.opp}/evidence/${s.evidenceId}/verify`, { requestedBy: 'Sam' });
    expect(before.status).toBe(409);
    expect(before.json().error).toMatch(/Record the delivery first/);
    expect((await call('POST', `/api/opportunities/${s.opp}/evidence/${s.evidenceId}/verify`, { requestedBy: '' })).status).toBe(400);
    // seedChain records its finding under check.contact_links v1, a person's check.
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await pitchAndWin(call, opp);
    expect((await deliver(call, opp)).status).toBe(200);
    const v1 = await call('POST', `/api/opportunities/${opp}/evidence/${c.evidenceId}/verify`, { requestedBy: 'Sam' });
    expect(v1.status).toBe(422);
    expect(v1.json().error).toMatch(/check\.contact_links v1/);
    const cf = (await call('GET', `/api/opportunities/${opp}`)).json();
    expect(cf.deliver.evidence[0]).toMatchObject({ verifiable: false });
    expect(cf.deliver.can.verify).toBe(false);
    // Another opportunity's finding is not this one's.
    expect((await call('POST', `/api/opportunities/${opp}/evidence/${s.evidenceId}/verify`, { requestedBy: 'Sam' })).status).toBe(404);
    expect(probe.calls).toEqual([]);
    expect(await count(db(), 'verifications', 'opportunity_id IN ($1, $2)', [s.opp, opp])).toBe(0);
  });

  it('refuses a page read before the recorded delivery, and records nothing', async () => {
    // TableProbe answers at a fixed time (AT, 5 October); this delivery is recorded for today.
    const s = await seedFinding(db(), QUAYSIDE);
    const { call } = await start({ probe: new TableProbe({ [QUAYSIDE.url]: { html: '<a href="tel:+442079460999">Call the clinic</a>' } }) });
    await pitchAndWin(call, s.opp);
    expect((await deliver(call, s.opp)).status).toBe(200);
    expect(AT < new Date().toISOString()).toBe(true);
    const r = await call('POST', `/api/opportunities/${s.opp}/evidence/${s.evidenceId}/verify`, { requestedBy: 'Sam' });
    expect(r.status).toBe(409);
    expect(r.json().error).toMatch(/before the recorded delivery/);
    expect(await count(db(), 'verifications', 'opportunity_id = $1', [s.opp])).toBe(0);
    expect(await count(db(), 'snapshots', `business_id = $1 AND fetched_at = $2`, [s.businessId, AT])).toBe(0);
  });

  it('verification_guard still judges the chain: a snapshot no later than the finding is refused and nothing is recorded', async () => {
    // A finding recorded after the table probe's fixed time (AT), delivered before it.
    const s = await seedFinding(db(), { ...QUAYSIDE, observedAt: '2026-10-05T12:00:00Z' });
    const { call } = await start({ probe: new TableProbe({ [QUAYSIDE.url]: { html: '<a href="tel:+442079460999">Call the clinic</a>' } }) });
    await db().query(`INSERT INTO outcomes (opportunity_id, kind, occurred_at, channel, recorded_by) VALUES ($1, 'pitched', '2026-10-01', 'email', 'Sam')`, [s.opp]);
    await db().query(`INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, recorded_by) VALUES ($1, 'won', '2026-10-02', 120, 'GBP', 'Sam')`, [s.opp]);
    await db().query(`INSERT INTO outcomes (opportunity_id, kind, occurred_at, delivered_by, recorded_by) VALUES ($1, 'delivered', '2026-10-03', 'operator', 'Sam')`, [s.opp]);
    const r = await call('POST', `/api/opportunities/${s.opp}/evidence/${s.evidenceId}/verify`, { requestedBy: 'Sam' });
    expect(r.status).toBe(409);
    expect(r.json().error).toMatch(/before the finding was recorded/);
    expect(await count(db(), 'verifications', 'opportunity_id = $1', [s.opp])).toBe(0);
    expect(await count(db(), 'snapshots', 'business_id = $1', [s.businessId])).toBe(1); // only the finding's own
  });

  it('keeps every verification as append-only history (fails when the guard is dropped)', async () => {
    const v = await delivered(QUAYSIDE, new DemoAwareProbe());
    const first = (await v.verify()).json();
    const second = (await v.verify({ requestedBy: 'Alex' })).json();
    const cf = (await v.call('GET', `/api/opportunities/${v.opp}`)).json();
    expect(cf.deliver.verifications.map((x: { verificationId: string }) => x.verificationId)).toEqual([second.verificationId, first.verificationId]);
    expect(cf.deliver.evidence[0].latest.requestedBy).toBe('Alex');
    const edit = `UPDATE verifications SET status = 'FAILED' WHERE id = $1`;
    expect(await failure(db(), edit, [first.verificationId])).toMatch(/append-only/);
    await db().query('SAVEPOINT mut');
    await db().query('DROP TRIGGER verifications_append_only ON verifications');
    expect(await failure(db(), edit, [first.verificationId])).toBeNull();
    await db().query('ROLLBACK TO SAVEPOINT mut');
    expect((await one<{ status: string }>(db(), 'SELECT status FROM verifications WHERE id = $1', [first.verificationId])).status).toBe('PASSED');
  });
});

describe('workspace isolation', () => {
  it('another workspace cannot read the deliver view, record a delivery or verify', async () => {
    const f = await seedFinding(db(), QUAYSIDE);
    const a = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
    const own = await start();
    await pitchAndWin(own.call, f.opp);
    const b = await enterNewWorkspace(db(), 'beta');
    await useWorkspace(db(), a);
    const probe = new CountingProbe(new DemoAwareProbe());
    const { call } = await start({ workspaceId: b, probe });
    expect((await call('GET', `/api/opportunities/${f.opp}/deliver`)).status).toBe(404);
    expect((await deliver(call, f.opp)).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${f.opp}/evidence/${f.evidenceId}/verify`, { requestedBy: 'Mallory' })).status).toBe(404);
    expect(probe.calls).toEqual([]);
    await useWorkspace(db(), a);
    expect(await count(db(), 'outcomes', `opportunity_id = $1 AND kind = 'delivered'`, [f.opp])).toBe(0);
    expect(await count(db(), 'verifications', 'opportunity_id = $1', [f.opp])).toBe(0);
  });
});

describe('the Case File shows Deliver · verify (10)', () => {
  it('is no longer planned in the app, while the landing page is unchanged', async () => {
    const ui = await readFile('src/server/ui/case-file.js', 'utf8');
    expect(ui).not.toMatch(/sec\('10'[^\n]*planned: true/);
    expect(ui).toMatch(/sec\('10', 'Deliver · verify'/);
    expect(ui).toContain('/delivery');
    expect(ui).toContain('/verify');
    const landing = await readFile('src/server/ui/landing.html', 'utf8');
    expect(landing).toMatch(/Deliver · verify · get paid<\/b> <span class="plan">PLANNED<\/span>/);
  });
});
