// Regression tests for the four integrity issues raised in the PR #1 review (migration 004).
// Each "rejects" test has a passing counterpart, so a guard that refuses everything also fails.
import { describe, expect, it } from 'vitest';
import { catalogId, failure, one, ruleId, seedChain, seedOpportunity, useDb } from './helpers.js';

const { db } = useDb();

const outcome = `INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, reply_class, corrects_outcome_id, notes, recorded_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'joseph') RETURNING id`;
const record = async (opp: string, kind: string, at: string, extra: { amount?: number; replyClass?: string; corrects?: string; notes?: string } = {}) =>
  (await one<{ id: string }>(db(), outcome,
    [opp, kind, at, extra.amount ?? null, extra.amount != null ? 'GBP' : null, extra.replyClass ?? null, extra.corrects ?? null, extra.notes ?? null])).id;
const tryRecord = (opp: string, kind: string, at: string, extra: { amount?: number; corrects?: string | null; notes?: string | null } = {}) =>
  failure(db(), outcome, [opp, kind, at, extra.amount ?? null, extra.amount != null ? 'GBP' : null, null, extra.corrects ?? null, extra.notes ?? null]);

describe('1. at most one terminal outcome per opportunity, corrected only by an explicit void', () => {
  async function pitched() {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await record(opp, 'pitched', '2026-10-01');
    return opp;
  }

  it('rejects a second win', async () => {
    const opp = await pitched();
    await record(opp, 'won', '2026-10-03', { amount: 120 });
    expect(await tryRecord(opp, 'won', '2026-10-04', { amount: 999 })).toMatch(/already has terminal outcome/);
    const o = await one(db(), 'SELECT deal_value, won_at FROM opportunities WHERE id = $1', [opp]);
    expect(o.deal_value).toBe('120.00');
  });
  it('rejects a loss after a win and a win after a loss', async () => {
    const a = await pitched();
    await record(a, 'won', '2026-10-03', { amount: 120 });
    expect(await tryRecord(a, 'lost', '2026-10-04')).toMatch(/already has terminal outcome/);
    const b = await pitched();
    await record(b, 'lost', '2026-10-03');
    expect(await tryRecord(b, 'won', '2026-10-04', { amount: 120 })).toMatch(/already has terminal outcome/);
  });
  it('corrects a mistaken win with a voided outcome, which clears the projection and allows the real win', async () => {
    const opp = await pitched();
    const wrong = await record(opp, 'won', '2026-10-03', { amount: 999 });
    await record(opp, 'voided', '2026-10-04', { corrects: wrong, notes: 'Typed 999 instead of 120' });
    let o = await one(db(), 'SELECT status, won_at, deal_value FROM opportunities WHERE id = $1', [opp]);
    expect(o).toMatchObject({ status: 'PITCHED', won_at: null, deal_value: null });
    await record(opp, 'won', '2026-10-03', { amount: 120 });
    o = await one(db(), 'SELECT status, deal_value FROM opportunities WHERE id = $1', [opp]);
    expect(o).toMatchObject({ status: 'WON', deal_value: '120.00' });
    const f = await one(db(), `SELECT wins, revenue FROM v_market_funnel WHERE market_id = (SELECT market_id FROM opportunities WHERE id = $1)`, [opp]);
    expect(f).toMatchObject({ wins: '1', revenue: '120.00' });
  });
  it('rejects a void without a reason, of a non-terminal outcome, of another opportunity, twice, or backdated', async () => {
    const opp = await pitched();
    const win = await record(opp, 'won', '2026-10-03', { amount: 120 });
    expect(await tryRecord(opp, 'voided', '2026-10-04', { corrects: win, notes: '  ' })).toMatch(/check constraint/);
    expect(await tryRecord(opp, 'voided', '2026-10-04', { corrects: null, notes: 'x' })).toMatch(/check constraint/);
    const pitch = (await one<{ id: string }>(db(), `SELECT id FROM outcomes WHERE opportunity_id = $1 AND kind = 'pitched'`, [opp])).id;
    expect(await tryRecord(opp, 'voided', '2026-10-04', { corrects: pitch, notes: 'x' })).toMatch(/only a won or lost outcome/);
    const other = await pitched();
    expect(await tryRecord(other, 'voided', '2026-10-04', { corrects: win, notes: 'x' })).toMatch(/same opportunity/);
    expect(await tryRecord(opp, 'voided', '2026-10-02', { corrects: win, notes: 'x' })).toMatch(/cannot predate/);
    await record(opp, 'voided', '2026-10-04', { corrects: win, notes: 'Client withdrew before paying' });
    expect(await tryRecord(opp, 'voided', '2026-10-05', { corrects: win, notes: 'again' })).toMatch(/already voided/);
  });
  it('rejects voiding a win once a delivery rests on it', async () => {
    const opp = await pitched();
    const win = await record(opp, 'won', '2026-10-03', { amount: 120 });
    await db().query(`INSERT INTO outcomes (opportunity_id, kind, occurred_at, delivered_by, recorded_by) VALUES ($1, 'delivered', '2026-10-05', 'operator', 'joseph')`, [opp]);
    expect(await tryRecord(opp, 'voided', '2026-10-06', { corrects: win, notes: 'x' })).toMatch(/delivery rests on/);
  });
});

describe('2. evidence observed_at is the snapshot capture time, not a free field', () => {
  const evidenceSql = `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state,
    plain_issue, url, quote, observed_at, confidence) VALUES ($1,$2,'E-TEL-BROKEN',$3,'OBSERVED','x','https://e.test/','q',$4,'HIGH')`;

  it('rejects a dishonest timestamp on insert', async () => {
    const c = await seedChain(db());
    expect(await failure(db(), evidenceSql, [c.businessId, c.observationId, c.ruleId, '2026-01-01T00:00:00Z']))
      .toMatch(/differs from its snapshot fetched_at/);
  });
  it('accepts the snapshot time supplied explicitly', async () => {
    const c = await seedChain(db());
    expect(await failure(db(), evidenceSql, [c.businessId, c.observationId, c.ruleId, '2026-09-28T10:00:00Z'])).toBeNull();
  });
  it('rejects backdating existing evidence', async () => {
    const c = await seedChain(db());
    expect(await failure(db(), `UPDATE evidence SET observed_at = '2026-01-01' WHERE id = $1`, [c.evidenceId]))
      .toMatch(/differs from its snapshot fetched_at/);
  });
  it('rejects moving the snapshot time, or the observation\'s snapshot or result, underneath the evidence', async () => {
    const c = await seedChain(db());
    expect(await failure(db(), `UPDATE snapshots SET fetched_at = '2026-01-01' WHERE id = $1`, [c.snapshotId])).toMatch(/cannot change/);
    const s2 = await one<{ id: string }>(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'https://e.test/', '2026-01-01', 'http') RETURNING id`, [c.businessId]);
    expect(await failure(db(), `UPDATE observations SET snapshot_id = $2 WHERE id = $1`, [c.observationId, s2.id])).toMatch(/backs evidence/);
    expect(await failure(db(), `UPDATE observations SET result = 'ok' WHERE id = $1`, [c.observationId])).toMatch(/backs evidence/);
    expect(await failure(db(), `UPDATE observations SET visible_text = 'edited label' WHERE id = $1`, [c.observationId])).toBeNull();
  });
});

describe('3. the rule version is chained from observation to evidence to verification', () => {
  async function setup(opts: { verifyRule?: 'same' | 'other'; observationRule?: 'same' | 'other' } = {}) {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const other = await ruleId(db(), 'check.placeholder_links');
    const s = await one<{ id: string }>(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method, viewport)
      VALUES ($1, 'https://example-clinic.test/', '2026-10-05', 'render', 'mobile') RETURNING id`, [c.businessId]);
    const o = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
      VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'ok') RETURNING id`, [s.id, opts.observationRule === 'other' ? other : c.ruleId]);
    const sql = `INSERT INTO verifications (opportunity_id, baseline_evidence_id, snapshot_id, observation_id, rule_version_id, status)
      VALUES ($1, $2, $3, $4, $5, 'PASSED')`;
    return failure(db(), sql, [opp, c.evidenceId, s.id, o.id, opts.verifyRule === 'other' ? other : c.ruleId]);
  }

  it('rejects evidence citing a different rule version from its observation', async () => {
    const c = await seedChain(db());
    const other = await ruleId(db(), 'check.placeholder_links');
    expect(await failure(db(), `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, confidence)
      VALUES ($1, $2, 'E-TEL-BROKEN', $3, 'OBSERVED', 'x', 'https://e.test/', 'q', 'HIGH')`, [c.businessId, c.observationId, other]))
      .toMatch(/differs from its observation rule version/);
  });
  it('rejects a verification under a different rule version from the baseline evidence', async () => {
    expect(await setup({ verifyRule: 'other', observationRule: 'other' })).toMatch(/differs from the baseline evidence rule version/);
  });
  it('rejects a verification whose re-check observation used a different rule version', async () => {
    expect(await setup({ observationRule: 'other' })).toMatch(/verification observation used rule version/);
  });
  it('accepts a verification with the same rule version end to end', async () => {
    expect(await setup()).toBeNull();
  });
});

describe('4. price overrides are structured, not free text', () => {
  const insert = `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price,
      price_override_kind, price_override_reason, price_override_approved_by, price_override_approved_at, price_override_catalog_item_ids)
    VALUES ($1, 't', 'MAPPED', $2, 'GBP', $3, $4, $5, $6, $7, $8) RETURNING id`;
  async function tryPrice(price: number, kind: string | null, extra: { reason?: string | null; by?: string | null; at?: string | null; items?: string[] | null; catalog?: string } = {}) {
    const c = await seedChain(db());
    const main = await catalogId(db(), extra.catalog ?? 'website_fix_sprint');
    const params = [c.businessId, main, price, kind,
      extra.reason === undefined ? (kind ? 'Two extra pages agreed on a call' : null) : extra.reason,
      extra.by === undefined ? (kind ? 'joseph' : null) : extra.by,
      extra.at === undefined ? (kind ? '2026-10-01T12:00:00Z' : null) : extra.at,
      extra.items ?? null];
    await db().query('SAVEPOINT p');
    try {
      const opp = await one<{ id: string }>(db(), insert, params);
      await db().query('INSERT INTO opportunity_evidence VALUES ($1, $2)', [opp.id, c.evidenceId]);
      await db().query('SET CONSTRAINTS ALL IMMEDIATE');
      await db().query('RELEASE SAVEPOINT p');
      return null;
    } catch (err) {
      await db().query('ROLLBACK TO SAVEPOINT p');
      return (err as Error).message;
    }
  }

  it('has no free-text override column any more', async () => {
    const r = await db().query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'scopely' AND table_name = 'opportunities' AND column_name = 'price_override_basis'`);
    expect(r.rowCount).toBe(0);
  });
  it('rejects an unknown override kind such as a "manual override"', async () => {
    expect(await tryPrice(999, 'MANUAL', { reason: 'manual override' })).toMatch(/check constraint/);
  });
  it('rejects an override with no reason, approver or approval time', async () => {
    expect(await tryPrice(100, 'DISCOUNT', { reason: ' ' })).toMatch(/check constraint/);
    expect(await tryPrice(100, 'DISCOUNT', { by: null })).toMatch(/check constraint/);
    expect(await tryPrice(100, 'DISCOUNT', { at: null })).toMatch(/check constraint/);
  });
  it('rejects override fields without an override kind', async () => {
    expect(await tryPrice(120, null, { reason: 'manual override' })).toMatch(/check constraint/);
  });
  it('rejects a DISCOUNT that raises the price or sits inside the band', async () => {
    expect(await tryPrice(999, 'DISCOUNT')).toMatch(/DISCOUNT must be below/);
    expect(await tryPrice(120, 'DISCOUNT')).toMatch(/DISCOUNT must be below/);
  });
  it('accepts an approved DISCOUNT below the band', async () => {
    expect(await tryPrice(100, 'DISCOUNT', { reason: 'Second site for an existing client' })).toBeNull();
  });
  it('rejects a BUNDLE with no items, itself, or a price outside the summed bands', async () => {
    const booking = await catalogId(db(), 'booking_lead_automation_sprint');
    const self = await catalogId(db(), 'website_fix_sprint');
    expect(await tryPrice(360, 'BUNDLE', { items: [] })).toMatch(/check constraint/);
    expect(await tryPrice(240, 'BUNDLE', { items: [self] })).toMatch(/other distinct, active catalog items/);
    expect(await tryPrice(999, 'BUNDLE', { items: [booking] })).toMatch(/outside the summed catalog band 360.00-360.00/);
  });
  it('rejects a BUNDLE naming an item with no cited price', async () => {
    const unpriced = await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description) VALUES ('unpriced', 'U', 'u') RETURNING id`);
    expect(await tryPrice(120, 'BUNDLE', { items: [unpriced.id] })).toMatch(/other distinct, active catalog items/);
  });
  it('accepts a BUNDLE priced at the sum of the catalog bands', async () => {
    const booking = await catalogId(db(), 'booking_lead_automation_sprint');
    expect(await tryPrice(360, 'BUNDLE', { items: [booking] })).toBeNull();
  });
  it('never overrides the currency and never prices an item with no cited price', async () => {
    const c = await seedChain(db());
    const unpriced = await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description) VALUES ('unpriced', 'U', 'u') RETURNING id`);
    expect(await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price,
      price_override_kind, price_override_reason, price_override_approved_by, price_override_approved_at)
      VALUES ($1, 't', 'MAPPED', $2, 'GBP', 50, 'DISCOUNT', 'r', 'joseph', now())`, [c.businessId, unpriced.id])).toMatch(/no cited price/);
    expect(await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price,
      price_override_kind, price_override_reason, price_override_approved_by, price_override_approved_at)
      VALUES ($1, 't', 'MAPPED', $2, 'USD', 50, 'DISCOUNT', 'r', 'joseph', now())`, [c.businessId, await catalogId(db(), 'website_fix_sprint')])).toMatch(/not the catalog currency/);
  });
});
