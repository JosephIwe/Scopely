// src/record: one manual prospect taken end to end, the way the 20-30 prospect test will run,
// and the ledger row it produces. Values here are test fixtures, not business data.
import { describe, expect, it } from 'vitest';
import * as r from '../src/record/index.js';
import { manualMailbox, one, useDb } from './helpers.js';

const { db } = useDb();

async function trades() {
  const m = await one<{ id: string }>(db(), `SELECT id FROM markets WHERE purpose = 'experiment'`);
  return m.id;
}

describe('manual recording', () => {
  it('records FIND to won, delivered and verified, and the ledger reports it without invented values', async () => {
    const marketId = await trades();
    const { businessId } = await r.recordProspect(db(), {
      marketId, name: 'Example Plumbing Ltd', domain: 'Example-Plumbing.test', vertical: 'home_services', subvertical: 'plumbing',
      countryCode: 'GB', city: 'Reading', companyNumber: '00000000', companyRegister: 'uk_companies_house',
      companyType: 'ltd', companyStatus: 'active', independence: 'independent', source: { kind: 'csv_import', ref: 'test.csv:2' },
    });
    await r.qualifyBusiness(db(), businessId);
    const snap = await r.recordSnapshot(db(), { businessId, url: 'https://example-plumbing.test/', fetchedAt: '2026-10-01T09:00:00Z', fetchMethod: 'manual' });

    // What could not be seen is recorded as such and never becomes evidence.
    const blind = await r.recordFinding(db(), { snapshotId: snap, ruleKey: 'check.trades_hours_and_routes', checkCode: 'trades.after_hours_route', state: 'NOT_OBSERVABLE' });
    expect(blind.evidenceId).toBeNull();
    await expect(r.recordFinding(db(), { snapshotId: snap, ruleKey: 'check.trades_hours_and_routes', checkCode: 'x', state: 'NOT_OBSERVABLE', result: 'defect' }))
      .rejects.toThrow(/NOT_OBSERVABLE/);

    const f = await r.recordFinding(db(), {
      snapshotId: snap, ruleKey: 'check.trades_hours_and_routes', checkCode: 'trades.24_7_claim', state: 'OBSERVED', result: 'gap',
      visibleText: '24/7 emergency plumber',
      evidence: { issueCode: 'E-24-7-CONTRADICTION', claimState: 'OBSERVED', plainIssue: 'Claims 24/7 but lists Mon-Fri 8-5 hours',
                  url: 'https://example-plumbing.test/', quote: '24/7 emergency plumber ... Mon-Fri 8am-5pm', confidence: 'MEDIUM' },
    });
    const ev = await one<{ observed_at: Date }>(db(), 'SELECT observed_at FROM evidence WHERE id = $1', [f.evidenceId]);
    expect(ev.observed_at.toISOString()).toBe('2026-10-01T09:00:00.000Z');

    const opp = await r.recordOpportunity(db(), {
      businessId, marketId, opportunityType: 'after_hours_gap', evidenceIds: [f.evidenceId!], catalogKey: 'lead_recovery_system',
      servicePrice: 350, currency: 'GBP', notObservableNotes: 'Whether calls are answered after hours cannot be seen from the site.',
    });
    await r.recordCost(db(), { businessId, opportunityId: opp, kind: 'operator_time', minutes: 25 });

    const contact = await r.recordContact(db(), { businessId, fullName: 'Owner', email: 'owner@example-plumbing.test', emailKind: 'personal',
      source: 'companies_house_officer', label: 'PUBLICLY_FOUND', outreachBasis: 'corporate_subscriber' });
    const mailbox = await manualMailbox(db());
    const msg = await r.recordMessage(db(), { opportunityId: opp, contactId: contact, subject: 's', body: 'b', evidenceIds: [f.evidenceId!], mailboxConnectionId: mailbox });
    await r.approveMessage(db(), msg, 'joseph', '2026-10-01T10:00:00Z');
    await r.markMessageSent(db(), msg, '2026-10-01T10:30:00Z');
    await r.recordOutcome(db(), { opportunityId: opp, kind: 'pitched', occurredAt: '2026-10-01T10:30:00Z', channel: 'email', messageId: msg, recordedBy: 'joseph' });
    await r.recordOutcome(db(), { opportunityId: opp, kind: 'replied', occurredAt: '2026-10-02T08:00:00Z', replyClass: 'pricing', messageId: msg, recordedBy: 'joseph' });

    let l = await one<Record<string, unknown>>(db(), 'SELECT * FROM v_opportunity_ledger WHERE opportunity_id = $1', [opp]);
    expect(l).toMatchObject({ playbook: 'uk_trades_lead_recovery', playbook_validation_status: 'HYPOTHESIS', vertical: 'home_services',
      subvertical: 'plumbing', country_code: 'GB', city: 'Reading', opportunity_type: 'after_hours_gap',
      evidence_types: ['E-24-7-CONTRADICTION'], catalog_item: 'lead_recovery_system', latest_reply_class: 'pricing',
      result: null, deal_value: null, gross_profit: null, analysis_cost: null, verification_status: null });
    expect(String(l.pitch_message_id)).toBe(String(msg));
    expect(Number(l.operator_minutes)).toBe(25);

    await r.recordOutcome(db(), { opportunityId: opp, kind: 'call', occurredAt: '2026-10-03T10:00:00Z', channel: 'phone', recordedBy: 'joseph' });
    await r.recordOutcome(db(), { opportunityId: opp, kind: 'won', occurredAt: '2026-10-04T10:00:00Z', amount: 350, currency: 'GBP', recordedBy: 'joseph' });
    await r.recordOutcome(db(), { opportunityId: opp, kind: 'delivered', occurredAt: '2026-10-08T10:00:00Z', deliveredBy: 'operator', amount: 40, currency: 'GBP', recordedBy: 'joseph' });

    l = await one(db(), 'SELECT * FROM v_opportunity_ledger WHERE opportunity_id = $1', [opp]);
    expect(l).toMatchObject({ result: 'won', deal_value: '350.00', delivery_cost: '40.00', calls: '1' });
    // Analysis cost is unknown (only minutes were recorded), so gross profit stays NULL.
    expect(l.gross_profit).toBeNull();
  });

  it('records a rejection with its rule', async () => {
    const { businessId } = await r.recordProspect(db(), { marketId: await trades(), name: 'Big Group', source: { kind: 'csv_import', ref: 'x' } });
    await r.rejectBusiness(db(), businessId, { category: 'CHAIN_OR_GROUP', reason: 'Part of a national group', stage: 'qualification',
      ruleKey: 'qualify.independence', rejectedAt: '2026-10-01T09:00:00Z' });
    const b = await one<{ qualification_status: string }>(db(), 'SELECT qualification_status FROM businesses WHERE id = $1', [businessId]);
    expect(b.qualification_status).toBe('REJECTED');
  });

  it('refuses an opportunity with no evidence before touching the database', async () => {
    await expect(r.recordOpportunity(db(), { businessId: '1', opportunityType: 't', evidenceIds: [], catalogKey: null, unmappedReason: 'x' }))
      .rejects.toThrow(/at least one evidence/);
  });

  it('records a cost with an unknown amount as NULL, never 0', async () => {
    const { businessId } = await r.recordProspect(db(), { marketId: await trades(), name: 'X', source: { kind: 'csv_import', ref: 'x' } });
    const id = await r.recordCost(db(), { businessId, kind: 'enrichment' });
    const c = await one<{ amount: string | null }>(db(), 'SELECT amount FROM cost_events WHERE id = $1', [id]);
    expect(c.amount).toBeNull();
  });
});
