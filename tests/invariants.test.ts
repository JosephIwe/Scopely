// The twelve data invariants from the Slice 1 brief, each proven against the real schema,
// plus the guards that keep the commercial ledger honest. Every "rejects" test also has a
// passing counterpart, so a guard that refuses everything would fail too.
import { describe, expect, it } from 'vitest';
import { catalogId, failure, one, ruleId, seedChain, seedOpportunity, useDb } from './helpers.js';

const { db } = useDb();

const evidenceSql = `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state,
  plain_issue, url, quote, observed_at, confidence) VALUES ($1,$2,'E-TEL-BROKEN',$3,'OBSERVED',$4,$5,$6,$7,$8)`;

describe('1. evidence requires an observation made on a snapshot', () => {
  it('rejects evidence without an observation', async () => {
    const c = await seedChain(db());
    const err = await failure(db(), evidenceSql,
      [c.businessId, null, c.ruleId, 'x', 'https://e.test/', 'q', '2026-09-28T10:00:00Z', 'HIGH']);
    expect(err).toMatch(/null value in column "observation_id"/);
  });
  it('rejects an observation without a snapshot', async () => {
    const err = await failure(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
      VALUES (NULL, 'c', (SELECT id FROM rule_versions LIMIT 1), 'OBSERVED', 'defect')`);
    expect(err).toMatch(/null value in column "snapshot_id"/);
  });
  it('rejects evidence whose observation belongs to another business', async () => {
    const a = await seedChain(db());
    const other = await one<{ id: string }>(db(), `INSERT INTO businesses (name) VALUES ('Other') RETURNING id`);
    const err = await failure(db(), evidenceSql,
      [other.id, a.observationId, a.ruleId, 'x', 'https://e.test/', 'q', '2026-09-28T10:00:00Z', 'HIGH']);
    expect(err).toMatch(/does not match observation business/);
  });
  it('rejects evidence resting on an observation that found nothing wrong', async () => {
    const c = await seedChain(db());
    const ok = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
      VALUES ($1, 'contact_links.tel', $2, 'OBSERVED', 'ok') RETURNING id`, [c.snapshotId, c.ruleId]);
    const err = await failure(db(), evidenceSql,
      [c.businessId, ok.id, c.ruleId, 'x', 'https://e.test/', 'q', '2026-09-28T10:00:00Z', 'HIGH']);
    expect(err).toMatch(/gap or defect/);
  });
  it('accepts evidence on a defect observation', async () => {
    const c = await seedChain(db());
    expect(c.evidenceId).toBeTruthy();
  });
});

describe('2. evidence requires url, quote, observed_at and confidence', () => {
  it('always carries observed_at: derived from the snapshot when not supplied', async () => {
    const c = await seedChain(db());
    const e = await one<{ observed_at: Date }>(db(), evidenceSql + ' RETURNING observed_at',
      [c.businessId, c.observationId, c.ruleId, 'x', 'https://e.test/', 'q', null, 'HIGH']);
    expect(e.observed_at.toISOString()).toBe('2026-09-28T10:00:00.000Z');
  });
  const cases: [string, number, unknown][] = [
    ['url', 4, null], ['url', 4, '  '], ['quote', 5, null], ['quote', 5, ''],
    ['confidence', 7, null], ['confidence', 7, 'SURE'],
  ];
  for (const [field, idx, value] of cases) {
    it(`rejects ${field} = ${JSON.stringify(value)}`, async () => {
      const c = await seedChain(db());
      const params: unknown[] = [c.businessId, c.observationId, c.ruleId, 'x', 'https://e.test/', 'q', '2026-09-28T10:00:00Z', 'HIGH'];
      params[idx] = value;
      expect(await failure(db(), evidenceSql, params)).not.toBeNull();
    });
  }
});

describe('3. an opportunity requires at least one evidence record', () => {
  it('rejects an opportunity with no evidence at commit', async () => {
    const c = await seedChain(db());
    const err = await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, unmapped_reason)
      VALUES ($1, 'broken_contact_path', 'no catalog item yet')`, [c.businessId]);
    expect(err).toMatch(/has no evidence/);
  });
  it('accepts an opportunity linked to evidence', async () => {
    const c = await seedChain(db());
    await seedOpportunity(db(), c);
    expect(await failure(db(), 'SELECT 1')).toBeNull();
  });
  it('rejects removing the last evidence link', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await db().query('SET CONSTRAINTS ALL IMMEDIATE');
    const err = await failure(db(), 'DELETE FROM opportunity_evidence WHERE opportunity_id = $1', [opp]);
    expect(err).toMatch(/has no evidence/);
  });
  it('rejects linking evidence about a different business', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const other = await seedChain(db());
    const err = await failure(db(), 'INSERT INTO opportunity_evidence VALUES ($1, $2)', [opp, other.evidenceId]);
    expect(err).toMatch(/different business/);
  });
});

describe('4. an opportunity maps to a service or is explicitly UNMAPPED', () => {
  it('rejects MAPPED without a catalog item', async () => {
    const c = await seedChain(db());
    const err = await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status) VALUES ($1, 't', 'MAPPED')`, [c.businessId]);
    expect(err).toMatch(/check constraint/);
  });
  it('rejects UNMAPPED without a reason', async () => {
    const c = await seedChain(db());
    const err = await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type) VALUES ($1, 't')`, [c.businessId]);
    expect(err).toMatch(/check constraint/);
  });
  it('rejects a catalog item naming an unknown issue code', async () => {
    const err = await failure(db(), `INSERT INTO catalog_items (key, service, description, supported_issue_codes)
      VALUES ('x', 'X', 'x', ARRAY['E-MADE-UP'])`);
    expect(err).toMatch(/unknown issue code E-MADE-UP/);
  });
});

describe('5. a service price cannot be fabricated', () => {
  it('rejects a price outside the catalog band', async () => {
    const c = await seedChain(db());
    const err = await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price)
      VALUES ($1, 't', 'MAPPED', $2, 'GBP', 999)`, [c.businessId, await catalogId(db(), 'website_fix_sprint')]);
    expect(err).toMatch(/outside catalog band/);
  });
  it('rejects a price in another currency', async () => {
    const c = await seedChain(db());
    const err = await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price)
      VALUES ($1, 't', 'MAPPED', $2, 'USD', 120)`, [c.businessId, await catalogId(db(), 'website_fix_sprint')]);
    expect(err).toMatch(/not the catalog currency/);
  });
  it('rejects a price with no mapped service', async () => {
    const c = await seedChain(db());
    const err = await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, unmapped_reason, currency, service_price)
      VALUES ($1, 't', 'none', 'GBP', 120)`, [c.businessId]);
    expect(err).toMatch(/needs a mapped catalog item/);
  });
  it('accepts a price inside the Lead Recovery band', async () => {
    const c = await seedChain(db());
    await seedOpportunity(db(), c, 'lead_recovery_system', 425);
    expect(await failure(db(), 'SELECT 1')).toBeNull();
  });
  it('rejects a catalog price without a cited source', async () => {
    const err = await failure(db(), `INSERT INTO catalog_items (key, service, description, price_low, price_high, currency)
      VALUES ('x', 'X', 'x', 100, 100, 'GBP')`);
    expect(err).toMatch(/check constraint/);
  });
  it('rejects a delivery-effort estimate without a basis', async () => {
    const err = await failure(db(), `INSERT INTO catalog_items (key, service, description, estimated_effort_minutes)
      VALUES ('x', 'X', 'x', 90)`);
    expect(err).toMatch(/check constraint/);
  });
});

describe('6. unknown historical values stay NULL', () => {
  it('seeds no effort, implementation type, prerequisites or margin', async () => {
    const rows = (await db().query(`SELECT key, implementation_type, estimated_effort_minutes, prerequisites, commercial_status FROM catalog_items`)).rows;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.implementation_type).toBeNull();
      expect(r.estimated_effort_minutes).toBeNull();
      expect(r.prerequisites).toEqual([]);
      expect(r.commercial_status).toBe('UNPROVEN');
    }
  });
  it('leaves commercial fields NULL on a new opportunity and gross margin NULL until every input is known', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const r = await one(db(), `SELECT opportunity_value, analysis_cost, delivery_cost, deal_value, gross_margin, pitched_at, won_at, verification_status FROM opportunities WHERE id = $1`, [opp]);
    expect(Object.values(r).every((v) => v === null)).toBe(true);
  });
  it('reports NULL money in the funnel, not zero', async () => {
    const c = await seedChain(db());
    await seedOpportunity(db(), c);
    const f = await one(db(), `SELECT revenue, gross_profit, revenue_per_100_prospects, time_saved_minutes, opportunities_found FROM v_market_funnel WHERE market_id = $1`, [c.marketId]);
    expect(f).toMatchObject({ revenue: null, gross_profit: null, revenue_per_100_prospects: null, time_saved_minutes: null, opportunities_found: '1' });
  });
});

describe('7. every rule has a version', () => {
  it('rejects a rule without a positive version', async () => {
    expect(await failure(db(), `INSERT INTO rule_versions (rule_key, version, kind, description, validation_status) VALUES ('r', 0, 'check', 'd', 'HYPOTHESIS')`)).toMatch(/check constraint/);
    expect(await failure(db(), `INSERT INTO rule_versions (rule_key, kind, description, validation_status) VALUES ('r', 'check', 'd', 'HYPOTHESIS')`)).toMatch(/null value/);
  });
  it('rejects a duplicate rule version', async () => {
    expect(await failure(db(), `INSERT INTO rule_versions (rule_key, version, kind, description, validation_status) VALUES ('check.contact_links', 1, 'check', 'd', 'HYPOTHESIS')`)).toMatch(/duplicate key/);
  });
});

describe('8. every finding and rejection is traceable to a rule version', () => {
  it('rejects an observation without a rule version', async () => {
    const c = await seedChain(db());
    expect(await failure(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'c', NULL, 'OBSERVED', 'ok')`, [c.snapshotId])).toMatch(/null value/);
  });
  it('rejects evidence without a rule version', async () => {
    const c = await seedChain(db());
    expect(await failure(db(), evidenceSql,
      [c.businessId, c.observationId, null, 'x', 'https://e.test/', 'q', '2026-09-28T10:00:00Z', 'HIGH'])).toMatch(/null value/);
  });
  it('rejects a rejection without category, reason, stage and rule version', async () => {
    const err = await failure(db(), `INSERT INTO businesses (name, qualification_status, rejection_reason) VALUES ('X', 'REJECTED', 'product brand')`);
    expect(err).toMatch(/check constraint/);
  });
  it('accepts a complete rejection', async () => {
    const rule = await ruleId(db(), 'qualify.business_type');
    expect(await failure(db(), `INSERT INTO businesses (name, qualification_status, rejection_category, rejection_reason, rejection_stage, rejection_rule_version_id, rejected_at)
      VALUES ('X', 'REJECTED', 'WRONG_BUSINESS_TYPE', 'Skincare product brand', 'classification', $1, now())`, [rule])).toBeNull();
  });
});

describe('9. VALIDATED and HYPOTHESIS are distinct', () => {
  it('rejects VALIDATED without a basis', async () => {
    expect(await failure(db(), `INSERT INTO rule_versions (rule_key, version, kind, description, validation_status) VALUES ('r', 1, 'check', 'd', 'VALIDATED')`)).toMatch(/check constraint/);
    expect(await failure(db(), `INSERT INTO issue_codes (code, kind, title, description, default_confidence, validation_status) VALUES ('E-X', 'issue', 't', 'd', 'LOW', 'VALIDATED')`)).toMatch(/check constraint/);
  });
  it('rejects any status other than the two', async () => {
    expect(await failure(db(), `INSERT INTO rule_versions (rule_key, version, kind, description, validation_status) VALUES ('r', 1, 'check', 'd', 'PROBABLY')`)).toMatch(/check constraint/);
  });
  it('keeps the whole trades playbook as HYPOTHESIS', async () => {
    const r = await one<{ n: string }>(db(), `SELECT count(*) n FROM issue_codes i JOIN niche_playbooks p ON p.id = i.playbook_id
      WHERE p.key = 'uk_trades_lead_recovery' AND i.validation_status <> 'HYPOTHESIS'`);
    expect(r.n).toBe('0');
    expect((await one(db(), `SELECT validation_status FROM niche_playbooks WHERE key = 'uk_trades_lead_recovery'`)).validation_status).toBe('HYPOTHESIS');
  });
  it('marks nothing commercially PROVEN and refuses PROVEN without a basis', async () => {
    const r = await one<{ n: string }>(db(), `SELECT (SELECT count(*) FROM niche_playbooks WHERE commercial_status = 'PROVEN')
      + (SELECT count(*) FROM catalog_items WHERE commercial_status = 'PROVEN') AS n`);
    expect(r.n).toBe('0');
    expect(await failure(db(), `UPDATE catalog_items SET commercial_status = 'PROVEN' WHERE key = 'lead_recovery_system'`)).toMatch(/check constraint/);
  });
});

describe('10. NOT_OBSERVABLE never becomes a defect', () => {
  it('rejects a NOT_OBSERVABLE observation that concludes anything', async () => {
    const c = await seedChain(db());
    for (const result of ['defect', 'gap', 'ok']) {
      expect(await failure(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'c', $2, 'NOT_OBSERVABLE', $3)`,
        [c.snapshotId, c.ruleId, result])).toMatch(/check constraint/);
    }
  });
  it('rejects evidence built on a NOT_OBSERVABLE observation', async () => {
    const c = await seedChain(db());
    const no = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state) VALUES ($1, 'booking.widget', $2, 'NOT_OBSERVABLE') RETURNING id`, [c.snapshotId, c.ruleId]);
    expect(await failure(db(), evidenceSql, [c.businessId, no.id, c.ruleId, 'x', 'https://e.test/', 'q', '2026-09-28T10:00:00Z', 'HIGH'])).toMatch(/TRUTH_RULE/);
    // Even when the evidence only claims to be INFERRED, a NOT_OBSERVABLE basis is refused.
    expect(await failure(db(), evidenceSql.replace(",'OBSERVED',", ",'INFERRED',"),
      [c.businessId, no.id, c.ruleId, 'x', 'https://e.test/', 'q', '2026-09-28T10:00:00Z', 'HIGH'])).toMatch(/NOT_OBSERVABLE observation/);
  });
  it('rejects promoting an observation to NOT_OBSERVABLE while keeping its defect', async () => {
    const c = await seedChain(db());
    const free = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
      VALUES ($1, 'c', $2, 'OBSERVED', 'defect') RETURNING id`, [c.snapshotId, c.ruleId]);
    expect(await failure(db(), `UPDATE observations SET state = 'NOT_OBSERVABLE' WHERE id = $1`, [free.id])).toMatch(/check constraint/);
    expect(await failure(db(), `UPDATE observations SET state = 'NOT_OBSERVABLE' WHERE id = $1`, [c.observationId])).not.toBeNull();
  });
  it('rejects evidence that claims OBSERVED on an INFERRED observation', async () => {
    const c = await seedChain(db());
    const inf = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result, inferred_from)
      VALUES ($1, 'c', $2, 'INFERRED', 'gap', ARRAY[$3::bigint]) RETURNING id`, [c.snapshotId, c.ruleId, c.observationId]);
    expect(await failure(db(), evidenceSql, [c.businessId, inf.id, c.ruleId, 'x', 'https://e.test/', 'q', '2026-09-28T10:00:00Z', 'HIGH'])).toMatch(/claims OBSERVED/);
  });
});

describe('11. a verification references a later snapshot', () => {
  async function verifySetup(fetchedAt: string, result: 'ok' | 'defect', state = 'OBSERVED', checkCode = 'contact_links.whatsapp') {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const s = await one<{ id: string }>(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method, viewport)
      VALUES ($1, 'https://example-clinic.test/', $2, 'render', 'mobile') RETURNING id`, [c.businessId, fetchedAt]);
    const o = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [s.id, checkCode, c.ruleId, state, state === 'NOT_OBSERVABLE' ? null : result]);
    return { c, opp, snapshotId: s.id, observationId: o.id };
  }
  const insertVerification = `INSERT INTO verifications (opportunity_id, baseline_evidence_id, snapshot_id, observation_id, rule_version_id, status)
    VALUES ($1, $2, $3, $4, $5, $6)`;

  it('rejects a verification on an earlier snapshot', async () => {
    const v = await verifySetup('2026-09-01T00:00:00Z', 'ok');
    expect(await failure(db(), insertVerification, [v.opp, v.c.evidenceId, v.snapshotId, v.observationId, v.c.ruleId, 'PASSED'])).toMatch(/must be later/);
  });
  it('rejects the baseline snapshot itself', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    expect(await failure(db(), insertVerification, [opp, c.evidenceId, c.snapshotId, null, c.ruleId, 'NOT_OBSERVABLE'])).toMatch(/must be later/);
  });
  it('rejects PASSED without an OBSERVED ok from the same check', async () => {
    const v = await verifySetup('2026-10-05T00:00:00Z', 'defect');
    expect(await failure(db(), insertVerification, [v.opp, v.c.evidenceId, v.snapshotId, v.observationId, v.c.ruleId, 'PASSED'])).toMatch(/OBSERVED ok/);
    const w = await verifySetup('2026-10-05T00:00:00Z', 'ok', 'OBSERVED', 'some.other_check');
    expect(await failure(db(), insertVerification, [w.opp, w.c.evidenceId, w.snapshotId, w.observationId, w.c.ruleId, 'PASSED'])).toMatch(/re-run check/);
  });
  it('accepts PASSED on a later OBSERVED ok and projects it onto the opportunity', async () => {
    const v = await verifySetup('2026-10-05T00:00:00Z', 'ok');
    expect(await failure(db(), insertVerification, [v.opp, v.c.evidenceId, v.snapshotId, v.observationId, v.c.ruleId, 'PASSED'])).toBeNull();
    const o = await one(db(), 'SELECT verification_status, verified_at FROM opportunities WHERE id = $1', [v.opp]);
    expect(o.verification_status).toBe('PASSED');
    expect(o.verified_at).not.toBeNull();
  });
});

describe('12. no revenue before an outcome exists', () => {
  const outcome = `INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, reply_class, delivered_by, client_confirmed, recorded_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'joseph')`;

  it('rejects writing deal_value, won_at or pitched_at directly', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    expect(await failure(db(), `UPDATE opportunities SET won_at = now(), deal_value = 120 WHERE id = $1`, [opp])).toMatch(/come from outcomes/);
    expect(await failure(db(), `UPDATE opportunities SET pitched_at = now() WHERE id = $1`, [opp])).toMatch(/come from outcomes/);
    expect(await failure(db(), `UPDATE opportunities SET status = 'WON' WHERE id = $1`, [opp])).toMatch(/come from outcomes/);
  });
  it('rejects inserting an opportunity that already claims a result', async () => {
    const c = await seedChain(db());
    expect(await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, unmapped_reason, status) VALUES ($1, 't', 'r', 'WON')`, [c.businessId])).toMatch(/come from outcomes/);
  });
  it('rejects a win before a pitch', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    expect(await failure(db(), outcome, [opp, 'won', '2026-10-02', 120, 'GBP', null, null, null])).toMatch(/before a pitched outcome/);
  });
  it('projects pitch -> reply -> win -> delivery onto the opportunity and computes margin only when costs are known', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await db().query(outcome, [opp, 'pitched', '2026-10-01', null, null, null, null, null]);
    await db().query(outcome, [opp, 'replied', '2026-10-02', null, null, 'positive', null, null]);
    await db().query(outcome, [opp, 'won', '2026-10-03', 120, 'GBP', null, null, null]);
    let o = await one(db(), 'SELECT status, deal_value, gross_margin FROM opportunities WHERE id = $1', [opp]);
    expect(o).toMatchObject({ status: 'WON', deal_value: '120.00', gross_margin: null });
    await db().query(outcome, [opp, 'delivered', '2026-10-04', 20, 'GBP', null, 'operator', null]);
    await db().query('UPDATE opportunities SET analysis_cost = 3.50 WHERE id = $1', [opp]);
    o = await one(db(), 'SELECT status, delivery_cost, gross_margin FROM opportunities WHERE id = $1', [opp]);
    expect(o).toMatchObject({ status: 'DELIVERED', delivery_cost: '20.00', gross_margin: '96.50' });
  });
  it('rejects delivery before a win', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await db().query(outcome, [opp, 'pitched', '2026-10-01', null, null, null, null, null]);
    expect(await failure(db(), outcome, [opp, 'delivered', '2026-10-04', null, null, null, 'operator', null])).toMatch(/before a won outcome/);
  });
  it('keeps outcomes append-only', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await db().query(outcome, [opp, 'pitched', '2026-10-01', null, null, null, null, null]);
    expect(await failure(db(), `UPDATE outcomes SET occurred_at = now() WHERE opportunity_id = $1`, [opp])).toMatch(/append-only/);
  });
});

describe('CLIENT_REQUIRED work is never claimed as done by the operator', () => {
  it('refuses an operator delivery and accepts a confirmed client delivery', async () => {
    const c = await seedChain(db());
    const cat = await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, implementation_type, supported_issue_codes)
      VALUES ('dns_change', 'DNS change', 'Client changes their own DNS', 'CLIENT_REQUIRED', ARRAY['E-EMAIL-INVALID']) RETURNING id`);
    const opp = await one<{ id: string }>(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency)
      VALUES ($1, 't', 'MAPPED', $2, 'GBP') RETURNING id`, [c.businessId, cat.id]);
    await db().query('INSERT INTO opportunity_evidence VALUES ($1, $2)', [opp.id, c.evidenceId]);
    const outcome = `INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, delivered_by, client_confirmed, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'joseph')`;
    await db().query(outcome, [opp.id, 'pitched', '2026-10-01', null, null, null, null]);
    await db().query(outcome, [opp.id, 'won', '2026-10-02', 50, 'GBP', null, null]);
    expect(await failure(db(), outcome, [opp.id, 'delivered', '2026-10-03', null, null, 'operator', null])).toMatch(/CLIENT_REQUIRED/);
    expect(await failure(db(), outcome, [opp.id, 'delivered', '2026-10-03', null, null, 'client', false])).toMatch(/CLIENT_REQUIRED/);
    expect(await failure(db(), outcome, [opp.id, 'delivered', '2026-10-03', null, null, 'client', true])).toBeNull();
  });
});

describe('messages cite only their opportunity evidence', () => {
  it('rejects a message citing unrelated evidence and one citing none', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const other = await seedChain(db());
    const sql = `INSERT INTO messages (opportunity_id, step, subject, body, evidence_ids, generator) VALUES ($1, 0, 's', 'b', $2, 'operator')`;
    expect(await failure(db(), sql, [opp, [other.evidenceId]])).toMatch(/not part of opportunity/);
    expect(await failure(db(), sql, [opp, []])).toMatch(/check constraint/);
    expect(await failure(db(), sql, [opp, [c.evidenceId]])).toBeNull();
  });
  it('refuses a sent message that was never approved', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    expect(await failure(db(), `INSERT INTO messages (opportunity_id, step, subject, body, evidence_ids, generator, sent_at)
      VALUES ($1, 0, 's', 'b', $2, 'operator', now())`, [opp, [c.evidenceId]])).toMatch(/check constraint/);
  });
});

describe('geography and niche live in data, not in the schema', () => {
  it('accepts a market in another country, currency and vertical without schema changes', async () => {
    const p = await one<{ id: string }>(db(), `INSERT INTO niche_playbooks (key, name, description, verticals, validation_status)
      VALUES ('dentists', 'Dentists', 'Test playbook', ARRAY['dental'], 'HYPOTHESIS') RETURNING id`);
    expect(await failure(db(), `INSERT INTO markets (name, playbook_id, vertical, country_code, region, city, timezone, currency, purpose)
      VALUES ('Dentists Toronto', $1, 'dental', 'CA', 'Ontario', 'Toronto', 'America/Toronto', 'CAD', 'experiment')`, [p.id])).toBeNull();
  });
  it('rejects a malformed country or currency code', async () => {
    const p = await one<{ id: string }>(db(), `SELECT id FROM niche_playbooks WHERE key = 'aesthetics'`);
    expect(await failure(db(), `INSERT INTO markets (name, playbook_id, vertical, country_code, currency, purpose) VALUES ('x', $1, 'v', 'uk', 'GBP', 'experiment')`, [p.id])).toMatch(/check constraint/);
    expect(await failure(db(), `INSERT INTO markets (name, playbook_id, vertical, country_code, currency, purpose) VALUES ('x', $1, 'v', 'GB', 'pounds', 'experiment')`, [p.id])).not.toBeNull();
  });
});
