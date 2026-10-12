// Release 1, outreach drafts (A41–A43): a seller saves, edits and reads drafts in the Case File. A
// draft is a messages row citing the opportunity's own evidence, written from what is on file only,
// linted on every save, never approved by default and never sent. Approval is a named person's act
// through the existing message_gate, and it fails honestly when a gate fails.
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { stageOf } from '../src/api/case-file.js';
import { OPT_OUT_SENTENCE, composeDraft, lintDraft, type LintInput } from '../src/sell/drafts.js';
import { catalogId, enterNewWorkspace, failure, manualMailbox, one, seedChain, seedOpportunity, useDb, useWorkspace } from './helpers.js';
import { useServer } from './server-helpers.js';
import { confirmRecheck } from './site-helpers.js';

const { db } = useDb();
const start = useServer(db);

type Chain = Awaited<ReturnType<typeof seedChain>>;

/** A contact who may be emailed: an active UK Ltd and a corporate-subscriber address. */
async function lawfulContact(d: pg.Client, c: Chain, email = 'owner@example-clinic.test') {
  await d.query(`UPDATE businesses SET company_type = 'ltd', company_status = 'active' WHERE id = $1`, [c.businessId]);
  return (await one<{ id: string }>(d, `INSERT INTO contacts (business_id, full_name, email, source, label, outreach_basis)
    VALUES ($1, 'Pat Owner', $2, 'website', 'PUBLICLY_FOUND', 'corporate_subscriber') RETURNING id`, [c.businessId, email])).id;
}

/** An opportunity whose every gate can pass: priced, HIGH finding re-checked, a lawful contact, a mailbox. */
async function readyCase(d: pg.Client, opts: { mailbox?: boolean; price?: number | null } = {}) {
  const c = await seedChain(d);
  const opp = await seedOpportunity(d, c, 'website_fix_sprint', opts.price === undefined ? 120 : opts.price);
  await confirmRecheck(d, c);
  const contactId = await lawfulContact(d, c);
  const mailboxId = opts.mailbox === false ? null : await manualMailbox(d, 'seller@seller.test');
  return { c, opp, contactId, mailboxId };
}

const row = (d: pg.Client, id: string) => one<Record<string, any>>(d, 'SELECT * FROM messages WHERE id = $1', [id]);

const evidence = (over: Partial<LintInput['evidence'][number]> = {}) => ({
  evidenceId: '1', claimState: 'OBSERVED' as const, plainIssue: 'The "WhatsApp us" button uses a number with no country code',
  url: 'https://clinic.test/contact', quote: '<a href="https://wa.me/07700900461">WhatsApp us</a>', observedAt: '2026-10-05T12:00:00Z', recheckResult: null, ...over,
});

describe('composeDraft: a first draft from what is on file only', () => {
  const facts = {
    businessName: 'Harbour Clinic', contactName: null, senderName: null,
    evidence: [evidence()], service: { name: 'Website Fix Sprint', price: null, currency: null },
  };

  it('says what was observed, where and when, quotes the link as published, and carries the opt-out', () => {
    const d = composeDraft(facts);
    expect(d.subject).toBe('A problem on the Harbour Clinic website');
    expect(d.body).toContain('On 5 October 2026, the page https://clinic.test/contact showed this problem:');
    expect(d.body).toContain('- The "WhatsApp us" button uses a number with no country code.');
    expect(d.body).toContain('As published: <a href="https://wa.me/07700900461">WhatsApp us</a>');
    expect(d.body).toContain('The service I would propose is Website Fix Sprint.');
    expect(d.body).toContain(OPT_OUT_SENTENCE);
    expect(d.body).toMatch(/reply "no thanks" and I won't contact you again/);
    expect(composeDraft(facts)).toEqual(d); // deterministic
  });

  it('writes a price only when the opportunity has one, and never invents a name, a sender, a number or a result', () => {
    const none = composeDraft(facts);
    expect(none.body).not.toMatch(/price|GBP|£|\d+\s?%/i);
    expect(none.body.startsWith('Hello,\n')).toBe(true);
    expect(none.body.trimEnd().endsWith(OPT_OUT_SENTENCE)).toBe(true); // no signature without a recorded name
    expect(none.body).not.toMatch(/\b(increase|more (bookings|leads|patients)|lost|revenue|conversion|we spoke|as discussed|hope you)/i);
    const priced = composeDraft({ ...facts, contactName: 'Pat Owner', senderName: 'Sam Seller', service: { name: 'Website Fix Sprint', price: '120.00', currency: 'GBP' } });
    expect(priced.body).toContain('The price is GBP 120.00.');
    expect(priced.body.startsWith('Hello Pat Owner,\n')).toBe(true);
    expect(priced.body.trimEnd().endsWith('Sam Seller')).toBe(true);
    // An unmapped opportunity proposes no service at all.
    expect(composeDraft({ ...facts, service: { name: null, price: null, currency: null } }).body).not.toMatch(/service I would propose/);
  });

  it('writes an inferred finding only as Scopely’s reading', () => {
    const d = composeDraft({ ...facts, evidence: [evidence({ claimState: 'INFERRED', plainIssue: 'The booking button seems to open an enquiry form' })] });
    expect(d.subject).toBe('A note about the Harbour Clinic website');
    expect(d.body).toContain("Scopely's reading, not something seen directly on the page: The booking button seems to open an enquiry form.");
    expect(d.body).not.toMatch(/showed this problem/);
    expect(lintDraft({ subject: d.subject, body: d.body, evidence: [evidence({ claimState: 'INFERRED', plainIssue: 'The booking button seems to open an enquiry form' })],
      price: null, currency: null, notObservable: null, contactSuppressed: false, businessSuppressed: false }).status).toBe('pass');
  });
});

describe('lintDraft (lint.outreach_draft v1)', () => {
  const base = (): LintInput => {
    const d = composeDraft({ businessName: 'Harbour Clinic', contactName: null, senderName: null, evidence: [evidence()],
      service: { name: 'Website Fix Sprint', price: '120.00', currency: 'GBP' } });
    return { subject: d.subject, body: d.body, evidence: [evidence()], price: '120.00', currency: 'GBP', notObservable: null, contactSuppressed: false, businessSuppressed: false };
  };
  const codes = (x: LintInput) => lintDraft(x).errors.map((e) => e.code);

  it('passes Scopely’s own draft', () => {
    expect(lintDraft(base())).toEqual({ status: 'pass', errors: [] });
  });
  it('fails a draft with no opt-out sentence', () => {
    const x = base();
    expect(codes({ ...x, body: x.body.replace(OPT_OUT_SENTENCE, '') })).toEqual(['opt_out_missing']);
  });
  it('fails a draft that cites a finding re-checked as changed or gone', () => {
    expect(codes({ ...base(), evidence: [evidence({ recheckResult: 'gone' })] })).toContain('evidence_gone');
    expect(codes({ ...base(), evidence: [evidence({ recheckResult: 'changed' })] })).toContain('evidence_changed');
  });
  it('fails an inferred finding written as if it were seen', () => {
    const x = base();
    const inf = evidence({ claimState: 'INFERRED', plainIssue: 'The booking button opens an enquiry form' });
    expect(codes({ ...x, body: `${x.body}\nThe booking button opens an enquiry form.`, evidence: [evidence(), inf] })).toEqual(['inferred_as_observed']);
  });
  it('fails a draft that states what Scopely could not observe', () => {
    const x = base();
    const notObservable = 'Not observable in this analysis: No form is in the served HTML; a form added by script cannot be ruled out.';
    expect(codes({ ...x, notObservable })).toEqual([]);
    expect(codes({ ...x, notObservable, body: `${x.body}\nNo form is in the served HTML; a form added by script cannot be ruled out.` })).toEqual(['not_observable_claim']);
  });
  it('fails an amount that is not the opportunity’s price, any amount when it has none, and any percentage', () => {
    const x = base();
    expect(codes({ ...x, body: x.body.replace('GBP 120.00', 'GBP 150.00') })).toEqual(['unbacked_amount']);
    expect(codes({ ...x, body: x.body.replace('GBP 120.00', '£120') })).toEqual([]);
    expect(codes({ ...x, body: x.body.replace('GBP 120.00', 'USD 120.00') })).toEqual(['unbacked_amount']);
    expect(codes({ ...x, price: null, currency: null })).toEqual(['unbacked_amount']);
    expect(codes({ ...x, body: `${x.body}\nThis loses you 30% of enquiries.` })).toEqual(['unbacked_percentage']);
    // The business's own link and page address are quoted, not claims: digits and %-escapes there are not judged.
    const q = evidence({ quote: '<a href="https://wa.me/44%2007700900461">WhatsApp 50% off</a>' });
    const d = composeDraft({ businessName: 'Harbour Clinic', contactName: null, senderName: null, evidence: [q], service: { name: 'Website Fix Sprint', price: null, currency: null } });
    expect(codes({ ...x, subject: d.subject, body: d.body, evidence: [q], price: null, currency: null })).toEqual([]);
  });
  it('fails an unfilled placeholder and a suppressed contact or business', () => {
    const x = base();
    expect(codes({ ...x, body: `${x.body}\n[Your name]` })).toEqual(['placeholder']);
    expect(codes({ ...x, contactSuppressed: true })).toEqual(['contact_suppressed']);
    expect(codes({ ...x, businessSuppressed: true })).toEqual(['business_suppressed']);
  });
});

describe('saving a draft', () => {
  it('saves Scopely’s first version as a pending messages row linked to the opportunity, its evidence, contact, service and sender', async () => {
    const { c, opp, contactId, mailboxId } = await readyCase(db());
    const { call, logged } = await start();
    const r = await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam Seller', contactId });
    expect(r.status).toBe(200);
    const out = r.json();
    expect(out).toMatchObject({ lint: { status: 'pass', errors: [] }, sender: true });
    const m = await row(db(), out.messageId);
    expect(m).toMatchObject({ opportunity_id: opp, contact_id: contactId, generator: 'scopely:draft/1', drafted_by: 'Sam Seller', lint_status: 'pass',
      approval_status: 'pending', approved_by: null, approved_at: null, sent_at: null, sender_email: null, recipient_email: null,
      mailbox_connection_id: mailboxId, catalog_item_id: await catalogId(db(), 'website_fix_sprint'), step: 0 });
    expect(m.evidence_ids.map(String)).toEqual([c.evidenceId]);
    expect(m.lint_rule_version_id).not.toBeNull();
    expect(m.body).toContain('The price is GBP 120.00.');
    expect(m.body).toContain('Hello Pat Owner,');
    // Logs carry ids only: never the subject, body or an address.
    for (const l of logged) expect(l).not.toMatch(/Hello|owner@|seller@|WhatsApp|problem/);
  });

  it('saves a draft with no mailbox and marks it "no sender set", not ready', async () => {
    const { opp, contactId } = await readyCase(db(), { mailbox: false, price: null });
    const { call } = await start();
    const out = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    expect((await row(db(), out.messageId)).mailbox_connection_id).toBeNull();
    expect(out.sender).toBe(false);
    const list = (await call('GET', `/api/opportunities/${opp}/drafts`)).json();
    const d = list.drafts[0];
    expect(d.sender).toBeNull();
    expect(d.readiness.status).toBe('NOT_READY');
    expect(d.readiness.checks.find((x: { key: string }) => x.key === 'sender')).toMatchObject({ state: 'missing', label: 'No sender set' });
    expect(d.service).toMatchObject({ name: 'Website Fix Sprint', price: null });
    expect(d.body).not.toMatch(/price/i);
    // Approval is refused, honestly, and nothing changed.
    const a = await call('POST', `/api/opportunities/${opp}/drafts/${d.messageId}/approve`, { approvedBy: 'Sam' });
    expect(a.status).toBe(409);
    expect(a.json().error).toMatch(/no sender set/i);
    expect((await row(db(), d.messageId)).approval_status).toBe('pending');
  });

  it('refuses a draft without a named person, for a contact of another business, or when nothing still holds', async () => {
    const { c, opp } = await readyCase(db());
    const other = await seedChain(db());
    const stranger = await lawfulContact(db(), other, 'x@other.test');
    const { call } = await start();
    expect((await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: ' ' })).status).toBe(400);
    expect((await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId: stranger })).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', evidenceIds: [other.evidenceId] })).status).toBe(404);
    await db().query(`INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'https://example-clinic.test/', '2026-10-02T09:00:00Z', 'manual')`, [c.businessId]);
    const s = await one<{ id: string }>(db(), `SELECT id FROM snapshots WHERE business_id = $1 AND fetched_at = '2026-10-02T09:00:00Z'`, [c.businessId]);
    await db().query(`INSERT INTO evidence_rechecks (evidence_id, snapshot_id, result, recorded_by, notes) VALUES ($1, $2, 'changed', 'op', 'moved')`, [c.evidenceId, s.id]);
    const r = await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam' });
    expect(r.status).toBe(409);
    expect(r.json().error).toMatch(/still holds/);
    expect(Number((await one<{ n: string }>(db(), 'SELECT count(*) AS n FROM messages WHERE opportunity_id = $1', [opp])).n)).toBe(0);
  });

  it('edits a pending draft, re-lints it, and keeps approval unset; an approved draft cannot be edited', async () => {
    const { opp, contactId } = await readyCase(db());
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    const m = await row(db(), messageId);
    // Without the opt-out sentence the lint fails and is recorded.
    const e1 = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}`, { subject: 'Your contact page', body: m.body.replace(OPT_OUT_SENTENCE, ''), editedBy: 'Sam' });
    expect(e1.status).toBe(200);
    expect(e1.json().lint).toMatchObject({ status: 'fail', errors: [{ code: 'opt_out_missing' }] });
    let after = await row(db(), messageId);
    expect(after).toMatchObject({ subject: 'Your contact page', lint_status: 'fail', approval_status: 'pending', approved_at: null, edited_by: 'Sam', sent_at: null });
    expect(after.lint_errors).toEqual([expect.objectContaining({ code: 'opt_out_missing' })]);
    // A failed lint blocks approval.
    const blocked = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    expect(blocked.status).toBe(409);
    expect(blocked.json().error).toMatch(/lint failed/i);
    // Put it back: it passes again and can be approved by a named person.
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}`, { subject: 'Your contact page', body: m.body, editedBy: 'Sam' })).json().lint.status).toBe('pass');
    const ok = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam Seller' });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, approvedByIsAuthenticated: false });
    after = await row(db(), messageId);
    expect(after).toMatchObject({ approval_status: 'approved', approved_by: 'Sam Seller', sent_at: null, recipient_email: 'owner@example-clinic.test', sender_email: null });
    expect(after.approved_at).not.toBeNull();
    const late = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}`, { subject: 'x', body: 'y', editedBy: 'Sam' });
    expect(late.status).toBe(409);
    expect(late.json().error).toMatch(/approved/);
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' })).status).toBe(409);
  });

  it('needs a named approver, a chosen contact and evidence that passes the send gate', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const contactId = await lawfulContact(db(), c);
    await manualMailbox(db());
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam' })).json();
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: '' })).status).toBe(400);
    const noContact = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    expect(noContact.status).toBe(409);
    expect(noContact.json().error).toMatch(/no contact chosen/i);
    const m = await row(db(), messageId);
    await call('POST', `/api/opportunities/${opp}/drafts/${messageId}`, { subject: m.subject, body: m.body, editedBy: 'Sam', contactId });
    // The HIGH finding has no confirmed re-check: evidence_send_blocker says so.
    const unchecked = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    expect(unchecked.status).toBe(409);
    expect(unchecked.json().error).toMatch(/re-check/i);
    await confirmRecheck(db(), c);
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' })).status).toBe(200);
  });
});

describe('gates on approval', () => {
  it('suppression blocks approval, in the Case File and in the database', async () => {
    const { c, opp, contactId } = await readyCase(db());
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    await db().query(`INSERT INTO suppression (business_id, reason) VALUES ($1, 'opt_out')`, [c.businessId]);
    const d = (await call('GET', `/api/opportunities/${opp}/drafts`)).json().drafts[0];
    expect(d.readiness.status).toBe('BLOCKED');
    expect(d.readiness.lint.errors.map((e: { code: string }) => e.code)).toContain('business_suppressed');
    const r = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    expect(r.status).toBe(409);
    expect((await row(db(), messageId)).approval_status).toBe('pending');
    // The database refuses it too, whoever writes it (message_gate → contact_outreach_blocker).
    expect(await failure(db(), `UPDATE messages SET approval_status = 'approved', approved_by = 'x', approved_at = now() WHERE id = $1`, [messageId]))
      .toMatch(/cannot approve: contact or business is suppressed/);
  });

  it('applies the UK Ltd/LLP rule of contact_outreach_blocker unchanged', async () => {
    const { c, opp, contactId } = await readyCase(db());
    await db().query(`UPDATE businesses SET company_type = 'sole_trader', company_status = NULL WHERE id = $1`, [c.businessId]);
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    const r = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    expect(r.status).toBe(409);
    expect(r.json().error).toMatch(/Ltd or LLP/);
  });

  it('message_draft_guard: a failed lint cannot be approved, even by a direct write (fails when the guard is dropped)', async () => {
    const { c, opp, contactId, mailboxId } = await readyCase(db());
    const m = await one<{ id: string }>(db(), `INSERT INTO messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator, mailbox_connection_id, lint_status)
      VALUES ($1, $2, 0, 's', 'b', $3, 'operator', $4, 'fail') RETURNING id`, [opp, contactId, [c.evidenceId], mailboxId]);
    const approve = `UPDATE messages SET approval_status = 'approved', approved_by = 'x', approved_at = now() WHERE id = $1`;
    expect(await failure(db(), approve, [m.id])).toMatch(/failed its lint/);
    // Mutation check: without the guard the same write would go through.
    await db().query('SAVEPOINT mut');
    await db().query('DROP TRIGGER message_draft_guard ON messages');
    expect(await failure(db(), approve, [m.id])).toBeNull();
    await db().query('ROLLBACK TO SAVEPOINT mut');
    expect(await failure(db(), approve, [m.id])).toMatch(/failed its lint/);
    // A passing or not-yet-linted message is approved as before.
    await db().query(`UPDATE messages SET lint_status = 'pass' WHERE id = $1`, [m.id]);
    expect(await failure(db(), approve, [m.id])).toBeNull();
  });

  it('message_draft_guard: a message proposes only the opportunity’s own service (fails when the guard is dropped)', async () => {
    const { c, opp } = await readyCase(db());
    const other = await catalogId(db(), 'landing_page_build');
    const insert = `INSERT INTO messages (opportunity_id, step, subject, body, evidence_ids, generator, catalog_item_id) VALUES ($1, 0, 's', 'b', $2, 'operator', $3)`;
    expect(await failure(db(), insert, [opp, [c.evidenceId], other])).toMatch(/proposes the opportunity's own service/);
    expect(await failure(db(), insert, [opp, [c.evidenceId], await catalogId(db(), 'website_fix_sprint')])).toBeNull();
    await db().query('SAVEPOINT mut');
    await db().query('DROP TRIGGER message_draft_guard ON messages');
    expect(await failure(db(), insert, [opp, [c.evidenceId], other])).toBeNull();
    await db().query('ROLLBACK TO SAVEPOINT mut');
  });
});

describe('no sending', () => {
  it('has no send route, and nothing in the app writes sent_at', async () => {
    const { opp, contactId } = await readyCase(db());
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    for (const path of [`/api/opportunities/${opp}/drafts/${messageId}/send`, `/api/opportunities/${opp}/send`, `/api/messages/${messageId}/send`]) {
      expect((await call('POST', path, {})).status, path).toBe(404);
    }
    expect((await row(db(), messageId)).sent_at).toBeNull();
    for (const f of ['src/server/app.ts', 'src/sell/drafts.ts', 'src/api/outreach.ts', 'src/server/ui/case-file.js']) {
      const src = await readFile(f, 'utf8');
      expect(src, f).not.toMatch(/sent_at\s*=|markMessageSent|\/send\b|sendMail|nodemailer|smtp/i);
    }
  });
});

describe('workspace isolation', () => {
  it('another workspace cannot read, edit or approve a draft', async () => {
    const { opp, contactId } = await readyCase(db());
    const a = await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws');
    const own = await start();
    const { messageId } = (await own.call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    const b = await enterNewWorkspace(db(), 'beta');
    await useWorkspace(db(), a.ws);
    const { call } = await start({ workspaceId: b });
    expect((await call('GET', `/api/opportunities/${opp}/drafts`)).status).toBe(404);
    expect((await call('GET', `/api/opportunities/${opp}`)).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Mallory' })).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}`, { subject: 'x', body: 'y', editedBy: 'Mallory' })).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Mallory' })).status).toBe(404);
    await useWorkspace(db(), a.ws);
    expect(await row(db(), messageId)).toMatchObject({ approval_status: 'pending', edited_by: null });
    // A draft in workspace A cannot name workspace B's mailbox.
    await useWorkspace(db(), b);
    const foreign = await manualMailbox(db(), 'b@seller.test');
    await useWorkspace(db(), a.ws);
    const again = await start({ workspaceId: a.ws });
    expect((await again.call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', mailboxId: foreign })).status).toBe(404);
  });
});

describe('the Case File shows drafts (08) and Sell stage', () => {
  it('lists each draft with readiness, lint, cited evidence and approval, and moves the opportunity to Sell', async () => {
    const { c, opp, contactId } = await readyCase(db());
    const { call } = await start();
    const before = ((await call('GET', '/api/opportunities')).json() as Record<string, unknown>[]).find((o) => o.opportunityId === opp)!;
    expect(before.stage).toBe('OPPORTUNITIES');
    await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId });
    const cf = (await call('GET', `/api/opportunities/${opp}`)).json();
    expect(cf.drafts.mailboxes).toHaveLength(1);
    const d = cf.drafts.drafts[0];
    expect(d).toMatchObject({ generator: 'scopely:draft/1', draftedBy: 'Sam', contact: { contactId, name: 'Pat Owner' },
      lint: { status: 'pass', rule: 'lint.outreach_draft v1' }, approval: { status: 'pending', approvedBy: null, approvedAt: null, approvedByIsAuthenticated: false },
      sentAt: null, readiness: { status: 'READY' } });
    expect(d.evidence).toEqual([expect.objectContaining({ evidenceId: c.evidenceId, claimState: 'OBSERVED' })]);
    expect(cf.sell.sellState).toBe('DRAFTED');
    expect(cf.stage).toBe('SELL');
    expect(stageOf({ buildState: 'NONE', sellState: 'DRAFTED', deliveryState: 'NONE' })).toBe('SELL');
    expect(stageOf({ buildState: 'DEMO_DRAFT', sellState: 'DRAFTED', deliveryState: 'NONE' })).toBe('SELL');
    const ui = await readFile('src/server/ui/case-file.js', 'utf8');
    expect(ui).toMatch(/function drafts\(/);
    expect(ui).toContain('No sender set');
  });
});
