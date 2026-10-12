// Migration 005: the gates the manual 20-30 prospect test relies on. Each guard has a refusing
// test and a passing counterpart.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { failure, manualMailbox, one, seedChain, seedOpportunity, useDb } from './helpers.js';

const { db } = useDb();

type Chain = Awaited<ReturnType<typeof seedChain>>;

/** A later snapshot of the same business with a re-run of the evidence's check. */
async function recheckSnapshot(d: pg.Client, c: Chain, result: 'ok' | 'defect' | null, fetchedAt = '2026-10-01T09:00:00Z') {
  const s = await one<{ id: string }>(d, `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method)
    VALUES ($1, 'https://example-clinic.test/', $2, 'manual') RETURNING id`, [c.businessId, fetchedAt]);
  const o = await one<{ id: string }>(d, `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
    VALUES ($1, 'contact_links.whatsapp', $2, $3, $4) RETURNING id`,
    [s.id, c.ruleId, result === null ? 'NOT_OBSERVABLE' : 'OBSERVED', result]);
  return { snapshotId: s.id, observationId: o.id };
}

const recheckSql = `INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by, notes)
  VALUES ($1,$2,$3,$4,'joseph',$5)`;

/** Makes the seeded business an active UK Ltd and adds a corporate-subscriber contact. */
async function sendable(d: pg.Client, c: Chain, email = 'owner@example-clinic.test') {
  await d.query(`UPDATE businesses SET company_type = 'ltd', company_status = 'active' WHERE id = $1`, [c.businessId]);
  return (await one<{ id: string }>(d, `INSERT INTO contacts (business_id, full_name, email, source, label, outreach_basis)
    VALUES ($1, 'Owner', $2, 'website', 'PUBLICLY_FOUND', 'corporate_subscriber') RETURNING id`, [c.businessId, email])).id;
}

/** A draft from the workspace's sending mailbox (created on first use). */
async function draft(d: pg.Client, opp: string, contact: string | null, evidence: string[]) {
  const mailbox = (await d.query('SELECT id FROM mailbox_connections ORDER BY id LIMIT 1')).rows[0]?.id ?? await manualMailbox(d);
  return (await one<{ id: string }>(d, `INSERT INTO messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator, mailbox_connection_id)
    VALUES ($1, $2, 0, 's', 'b', $3, 'operator', $4) RETURNING id`, [opp, contact, evidence, mailbox])).id;
}

const approve = `UPDATE messages SET approval_status = 'approved', approved_by = 'joseph', approved_at = $2 WHERE id = $1`;
const markSent = `UPDATE messages SET sent_at = $2 WHERE id = $1`;

describe('evidence re-checks are a ledger backed by a later snapshot', () => {
  it('records a confirmed re-check and projects it onto the evidence with the snapshot time', async () => {
    const c = await seedChain(db());
    const r = await recheckSnapshot(db(), c, 'defect');
    expect(await failure(db(), recheckSql, [c.evidenceId, r.snapshotId, r.observationId, 'confirmed', null])).toBeNull();
    const e = await one<{ rechecked_at: Date; recheck_result: string }>(db(), 'SELECT rechecked_at, recheck_result FROM evidence WHERE id = $1', [c.evidenceId]);
    expect(e.recheck_result).toBe('confirmed');
    expect(e.rechecked_at.toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });
  it('refuses a re-check on a snapshot that is not later than the evidence', async () => {
    const c = await seedChain(db());
    const r = await recheckSnapshot(db(), c, 'defect', '2026-09-28T10:00:00Z');
    expect(await failure(db(), recheckSql, [c.evidenceId, r.snapshotId, r.observationId, 'confirmed', null])).toMatch(/must be later/);
  });
  it('refuses a re-check snapshot of another business', async () => {
    const c = await seedChain(db());
    const other = await seedChain(db());
    const r = await recheckSnapshot(db(), other, 'defect');
    expect(await failure(db(), recheckSql, [c.evidenceId, r.snapshotId, r.observationId, 'confirmed', null])).toMatch(/different business/);
  });
  it('refuses a supplied rechecked_at that differs from the snapshot', async () => {
    const c = await seedChain(db());
    const r = await recheckSnapshot(db(), c, 'defect');
    expect(await failure(db(), `INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by, rechecked_at)
      VALUES ($1,$2,$3,'confirmed','joseph','2026-10-05T00:00:00Z')`, [c.evidenceId, r.snapshotId, r.observationId])).toMatch(/differs from its snapshot/);
  });
  it('confirmed needs the defect observed again; gone needs an observed ok', async () => {
    const c = await seedChain(db());
    const ok = await recheckSnapshot(db(), c, 'ok');
    expect(await failure(db(), recheckSql, [c.evidenceId, ok.snapshotId, ok.observationId, 'confirmed', null])).toMatch(/confirmed needs an OBSERVED gap or defect/);
    const blind = await recheckSnapshot(db(), c, null, '2026-10-02T09:00:00Z');
    expect(await failure(db(), recheckSql, [c.evidenceId, blind.snapshotId, blind.observationId, 'gone', null])).toMatch(/gone needs an OBSERVED ok/);
    expect(await failure(db(), recheckSql, [c.evidenceId, ok.snapshotId, ok.observationId, 'gone', null])).toBeNull();
  });
  it('NOT_OBSERVABLE on re-check never confirms a finding', async () => {
    const c = await seedChain(db());
    const blind = await recheckSnapshot(db(), c, null);
    expect(await failure(db(), recheckSql, [c.evidenceId, blind.snapshotId, blind.observationId, 'confirmed', null])).toMatch(/confirmed needs/);
  });
  it('must re-run the same check with the same rule version on the re-check snapshot', async () => {
    const c = await seedChain(db());
    const r = await recheckSnapshot(db(), c, 'defect');
    const wrong = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
      VALUES ($1, 'contact_links.tel', $2, 'OBSERVED', 'defect') RETURNING id`, [r.snapshotId, c.ruleId]);
    expect(await failure(db(), recheckSql, [c.evidenceId, r.snapshotId, wrong.id, 'confirmed', null])).toMatch(/must re-run check/);
  });
  it('confirmed and gone need the observation; changed needs a note', async () => {
    const c = await seedChain(db());
    const r = await recheckSnapshot(db(), c, 'defect');
    expect(await failure(db(), recheckSql, [c.evidenceId, r.snapshotId, null, 'confirmed', null])).toMatch(/check constraint/);
    expect(await failure(db(), recheckSql, [c.evidenceId, r.snapshotId, null, 'changed', null])).toMatch(/check constraint/);
    expect(await failure(db(), recheckSql, [c.evidenceId, r.snapshotId, null, 'changed', 'page redesigned; contact block moved'])).toBeNull();
  });
  it('is append-only and in time order', async () => {
    const c = await seedChain(db());
    const later = await recheckSnapshot(db(), c, 'defect', '2026-10-03T09:00:00Z');
    const earlier = await recheckSnapshot(db(), c, 'defect', '2026-10-02T09:00:00Z');
    await db().query(recheckSql, [c.evidenceId, later.snapshotId, later.observationId, 'confirmed', null]);
    expect(await failure(db(), recheckSql, [c.evidenceId, earlier.snapshotId, earlier.observationId, 'confirmed', null])).toMatch(/already has a re-check/);
    expect(await failure(db(), `UPDATE evidence_rechecks SET result = 'gone' WHERE evidence_id = $1`, [c.evidenceId])).toMatch(/append-only/);
  });
  it('refuses writing re-check results directly on the evidence row', async () => {
    const c = await seedChain(db());
    expect(await failure(db(), `UPDATE evidence SET rechecked_at = now(), recheck_result = 'confirmed' WHERE id = $1`, [c.evidenceId]))
      .toMatch(/come from evidence_rechecks/);
  });
});

describe('message approval is gated on a lawful recipient', () => {
  it('approves a message to an active UK Ltd corporate subscriber', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const contact = await sendable(db(), c);
    const m = await draft(db(), opp, contact, [c.evidenceId]);
    expect(await failure(db(), approve, [m, '2026-10-01T10:00:00Z'])).toBeNull();
  });
  it('refuses approval with no contact, or a contact of another business', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, null, [c.evidenceId]);
    expect(await failure(db(), approve, [m, '2026-10-01T10:00:00Z'])).toMatch(/needs a contact/);
    const other = await seedChain(db());
    const stranger = await sendable(db(), other, 'x@other.test');
    const m2 = await draft(db(), opp, stranger, [c.evidenceId]);
    expect(await failure(db(), approve, [m2, '2026-10-01T10:00:00Z'])).toMatch(/different business/);
  });
  it('refuses a contact with no email or no lawful outreach basis', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await sendable(db(), c);
    const noEmail = await one<{ id: string }>(db(), `INSERT INTO contacts (business_id, full_name, source, label, outreach_basis)
      VALUES ($1, 'Owner', 'website', 'PUBLICLY_FOUND', 'corporate_subscriber') RETURNING id`, [c.businessId]);
    expect(await failure(db(), approve, [await draft(db(), opp, noEmail.id, [c.evidenceId]), '2026-10-01T10:00:00Z'])).toMatch(/no email/);
    for (const basis of ['unknown', 'not_permitted', null]) {
      const k = await one<{ id: string }>(db(), `INSERT INTO contacts (business_id, email, source, label, outreach_basis)
        VALUES ($1, 'a@example-clinic.test', 'website', 'PUBLICLY_FOUND', $2) RETURNING id`, [c.businessId, basis]);
      expect(await failure(db(), approve, [await draft(db(), opp, k.id, [c.evidenceId]), '2026-10-01T10:00:00Z'])).toMatch(/outreach basis/);
    }
  });
  it('UK corporate-subscriber outreach is Ltd/LLP and active only (PECR)', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const contact = await sendable(db(), c);
    for (const [type, status] of [['sole_trader', 'active'], ['partnership', 'active'], ['ltd', 'dissolved'], [null, null]]) {
      await db().query('UPDATE businesses SET company_type = $2, company_status = $3 WHERE id = $1', [c.businessId, type, status]);
      expect(await failure(db(), approve, [await draft(db(), opp, contact, [c.evidenceId]), '2026-10-01T10:00:00Z'])).toMatch(/active Ltd or LLP/);
    }
    await db().query(`UPDATE businesses SET company_type = 'LLP', company_status = 'Active' WHERE id = $1`, [c.businessId]);
    expect(await failure(db(), approve, [await draft(db(), opp, contact, [c.evidenceId]), '2026-10-01T10:00:00Z'])).toBeNull();
  });
  it('recorded consent is a lawful basis whatever the company type', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await db().query(`UPDATE businesses SET company_type = 'sole_trader' WHERE id = $1`, [c.businessId]);
    const k = await one<{ id: string }>(db(), `INSERT INTO contacts (business_id, email, source, label, outreach_basis, verification_basis)
      VALUES ($1, 'a@example-clinic.test', 'enquiry', 'VERIFIED', 'consent', 'They wrote to us from this address') RETURNING id`, [c.businessId]);
    expect(await failure(db(), approve, [await draft(db(), opp, k.id, [c.evidenceId]), '2026-10-01T10:00:00Z'])).toBeNull();
  });
  it('refuses a suppressed email, email domain or business domain', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const contact = await sendable(db(), c, 'owner@clinic-mail.test');
    const domain = (await one<{ domain: string }>(db(), 'SELECT domain FROM businesses WHERE id = $1', [c.businessId])).domain;
    for (const [email, dom] of [['OWNER@clinic-mail.test', null], [null, 'clinic-mail.test'], [null, domain.toUpperCase()]]) {
      await db().query('SAVEPOINT s');
      await db().query(`INSERT INTO suppression (email, domain, reason) VALUES ($1, $2, 'opt_out')`, [email, dom]);
      expect(await failure(db(), approve, [await draft(db(), opp, contact, [c.evidenceId]), '2026-10-01T10:00:00Z'])).toMatch(/suppressed/);
      await db().query('ROLLBACK TO SAVEPOINT s');
    }
  });
});

describe('approved and sent messages are frozen', () => {
  it('refuses a content edit that keeps the old approval, and accepts it with a new approval', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    expect(await failure(db(), `UPDATE messages SET body = 'changed' WHERE id = $1`, [m])).toMatch(/needs a new approval/);
    expect(await failure(db(), `UPDATE messages SET body = 'changed', approved_at = '2026-10-01T11:00:00Z' WHERE id = $1`, [m])).toBeNull();
  });
  it('refuses any change to a sent message', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    await db().query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [c.evidenceId]);
    await db().query(markSent, [m, '2026-10-01T12:00:00Z']);
    expect(await failure(db(), `UPDATE messages SET body = 'x', approved_at = '2026-10-01T13:00:00Z' WHERE id = $1`, [m])).toMatch(/sent message cannot change/);
    expect(await failure(db(), `UPDATE messages SET sent_at = '2026-10-02T12:00:00Z' WHERE id = $1`, [m])).toMatch(/sent message cannot change/);
  });
});

describe('a message is marked sent only after approval and a re-check of HIGH evidence', () => {
  it('refuses a send whose HIGH evidence was never re-checked, and accepts it once confirmed', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    expect(await failure(db(), markSent, [m, '2026-10-01T12:00:00Z'])).toMatch(/no confirmed re-check/);
    const r = await recheckSnapshot(db(), c, 'defect', '2026-10-01T11:00:00Z');
    await db().query(recheckSql, [c.evidenceId, r.snapshotId, r.observationId, 'confirmed', null]);
    expect(await failure(db(), markSent, [m, '2026-10-01T12:00:00Z'])).toBeNull();
  });
  it('judges the re-check as of the send time, not a later one', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    const r = await recheckSnapshot(db(), c, 'defect', '2026-10-01T13:00:00Z');
    await db().query(recheckSql, [c.evidenceId, r.snapshotId, r.observationId, 'confirmed', null]);
    expect(await failure(db(), markSent, [m, '2026-10-01T12:00:00Z'])).toMatch(/no confirmed re-check/);
  });
  it('refuses a send citing evidence re-checked as gone or changed, whatever its confidence', async () => {
    const c = await seedChain(db());
    await db().query(`UPDATE evidence SET confidence = 'LOW' WHERE id = $1`, [c.evidenceId]);
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    const r = await recheckSnapshot(db(), c, 'ok', '2026-10-01T11:00:00Z');
    await db().query(recheckSql, [c.evidenceId, r.snapshotId, r.observationId, 'gone', null]);
    expect(await failure(db(), markSent, [m, '2026-10-01T12:00:00Z'])).toMatch(/re-checked as gone and must be dropped/);
  });
  it('lets LOW and MEDIUM evidence go without a re-check', async () => {
    const c = await seedChain(db());
    await db().query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [c.evidenceId]);
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    expect(await failure(db(), markSent, [m, '2026-10-01T12:00:00Z'])).toBeNull();
  });
  it('refuses a send before the approval time', async () => {
    const c = await seedChain(db());
    await db().query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [c.evidenceId]);
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    expect(await failure(db(), markSent, [m, '2026-10-01T09:00:00Z'])).toMatch(/must follow a recorded approval/);
  });
  it('re-checks suppression at send time', async () => {
    const c = await seedChain(db());
    await db().query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [c.evidenceId]);
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c, 'owner@example-clinic.test'), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    await db().query(`INSERT INTO suppression (email, reason) VALUES ('owner@example-clinic.test', 'opt_out')`);
    expect(await failure(db(), markSent, [m, '2026-10-01T12:00:00Z'])).toMatch(/cannot mark sent: contact or business is suppressed/);
  });
});

describe('a pitch outcome can cite the message it came from', () => {
  async function sent(d: pg.Client) {
    const c = await seedChain(d);
    await d.query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [c.evidenceId]);
    const opp = await seedOpportunity(d, c);
    const m = await draft(d, opp, await sendable(d, c), [c.evidenceId]);
    await d.query(approve, [m, '2026-10-01T10:00:00Z']);
    await d.query(markSent, [m, '2026-10-01T12:00:00Z']);
    return { c, opp, m };
  }
  const pitched = `INSERT INTO outcomes (opportunity_id, kind, occurred_at, channel, message_id, recorded_by) VALUES ($1, $2, $3, 'email', $4, 'joseph')`;
  it('accepts a pitched outcome naming its sent message', async () => {
    const { opp, m } = await sent(db());
    expect(await failure(db(), pitched, [opp, 'pitched', '2026-10-01T12:00:00Z', m])).toBeNull();
  });
  it('refuses a message of another opportunity, an unsent message, or a pitch before the send', async () => {
    const a = await sent(db());
    const b = await sent(db());
    expect(await failure(db(), pitched, [a.opp, 'pitched', '2026-10-01T12:00:00Z', b.m])).toMatch(/another opportunity/);
    expect(await failure(db(), pitched, [a.opp, 'pitched', '2026-10-01T11:00:00Z', a.m])).toMatch(/before it was sent/);
    const unsent = await draft(db(), a.opp, null, [a.c.evidenceId]);
    expect(await failure(db(), pitched, [a.opp, 'pitched', '2026-10-01T12:00:00Z', unsent])).toMatch(/before it was sent/);
  });
  it('only pitched and replied outcomes may cite a message', async () => {
    const { opp, m } = await sent(db());
    expect(await failure(db(), pitched, [opp, 'call', '2026-10-02T12:00:00Z', m])).toMatch(/check constraint/);
  });
});

describe('landing page build has no invented price', () => {
  it('exists with a NULL price and cannot be priced', async () => {
    const lp = await one<{ id: string; price_low: string | null; commercial_status: string }>(db(),
      `SELECT id, price_low, commercial_status FROM catalog_items WHERE key = 'landing_page_build'`);
    expect(lp.price_low).toBeNull();
    expect(lp.commercial_status).toBe('UNPROVEN');
    const c = await seedChain(db());
    expect(await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price)
      VALUES ($1, 't', 'MAPPED', $2, 'GBP', 500)`, [c.businessId, lp.id])).toMatch(/no cited price/);
  });
});

describe('market funnel counts sent messages', () => {
  it('reports messages_sent and keeps money NULL without outcomes', async () => {
    const c = await seedChain(db());
    await db().query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [c.evidenceId]);
    const opp = await seedOpportunity(db(), c);
    const m = await draft(db(), opp, await sendable(db(), c), [c.evidenceId]);
    await db().query(approve, [m, '2026-10-01T10:00:00Z']);
    await db().query(markSent, [m, '2026-10-01T12:00:00Z']);
    const f = await one<{ messages_sent: string; revenue: string | null; gross_profit: string | null }>(db(),
      'SELECT messages_sent, revenue, gross_profit FROM v_market_funnel WHERE market_id = $1', [c.marketId]);
    expect(Number(f.messages_sent)).toBe(1);
    expect(f.revenue).toBeNull();
    expect(f.gross_profit).toBeNull();
  });
});
