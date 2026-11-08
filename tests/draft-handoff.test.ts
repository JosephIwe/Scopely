// P5: the approved-draft handoff. A person reviews the evidence and the message, approves it, copies
// it or opens it in their own email app through a safe mailto: link, sends it themselves, and
// records that they did, which records the pitch. Scopely never sends, follows up or tracks replies.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { OPT_OUT_SENTENCE, composeDraft, lintDraft } from '../src/sell/drafts.js';
import { MAX_MAILTO, handoffOf, isSafeAddress, mailtoHref } from '../src/sell/handoff.js';
import { OUTREACH_WORDING } from '../src/sell/wording.js';
import { enterNewWorkspace, manualMailbox, one, seedChain, seedOpportunity, useDb, useWorkspace } from './helpers.js';
import { useServer } from './server-helpers.js';
import { confirmRecheck } from './site-helpers.js';

const { db } = useDb();
const start = useServer(db);

async function readyCase(d: pg.Client) {
  const c = await seedChain(d);
  const opp = await seedOpportunity(d, c, 'website_fix_sprint', 120);
  await confirmRecheck(d, c);
  await d.query(`UPDATE businesses SET company_type = 'ltd', company_status = 'active' WHERE id = $1`, [c.businessId]);
  const contactId = (await one<{ id: string }>(d, `INSERT INTO contacts (business_id, full_name, email, source, label, outreach_basis)
    VALUES ($1, 'Pat Owner', 'owner@example-clinic.test', 'website', 'PUBLICLY_FOUND', 'corporate_subscriber') RETURNING id`, [c.businessId])).id;
  await manualMailbox(d, 'seller@seller.test');
  return { c, opp, contactId };
}
const msg = (id: string) => one<Record<string, any>>(db(), 'SELECT * FROM messages WHERE id = $1', [id]);
const pitches = (opp: string) => db().query(`SELECT kind, channel, message_id::text, recorded_by FROM outcomes WHERE opportunity_id = $1 ORDER BY id`, [opp]);

const approved = { approvalStatus: 'approved', sentAt: null, lintStatus: 'pass', recipientEmail: 'owner@clinic.test', senderEmail: 'me@seller.test',
  subject: 'Your "Book now" link & contact page', body: 'Hello,\n\nLine two & more?\n\n' + OPT_OUT_SENTENCE };

describe('handoffOf: only an approved, unsent draft that passed its lint is handed off', () => {
  it('is null for a pending, rejected, sent or failed draft, or one with no captured recipient', () => {
    expect(handoffOf({ ...approved, approvalStatus: 'pending' })).toBeNull();
    expect(handoffOf({ ...approved, approvalStatus: 'rejected' })).toBeNull();
    expect(handoffOf({ ...approved, sentAt: '2026-11-07T10:00:00Z' })).toBeNull();
    expect(handoffOf({ ...approved, lintStatus: 'fail' })).toBeNull();
    expect(handoffOf({ ...approved, recipientEmail: null })).toBeNull();
    expect(handoffOf(approved)).toMatchObject({ to: 'owner@clinic.test', from: 'me@seller.test', copyText: `Subject: ${approved.subject}\n\n${approved.body}` });
  });

  it('builds a mailto link of the approved recipient, subject and body only, every part percent-encoded', () => {
    const x = handoffOf(approved)!;
    expect(x.mailto).toBe(mailtoHref(approved.recipientEmail, approved.subject, approved.body));
    const u = new URL(x.mailto!);
    expect(u.protocol).toBe('mailto:');
    expect(decodeURIComponent(u.pathname)).toBe('owner@clinic.test');
    expect([...u.searchParams.keys()]).toEqual(['subject', 'body']);
    expect(u.searchParams.get('subject')).toBe(approved.subject);
    expect(u.searchParams.get('body')).toBe(approved.body.replace(/\n/g, '\r\n'));
    expect(x.mailto).not.toMatch(/[\s"<>]/);
  });

  it('refuses an address that could smuggle a header, a second recipient or a line break into the link', () => {
    for (const bad of ['owner@clinic.test?cc=x@evil.test', 'a@clinic.test,b@evil.test', 'a@clinic.test;b@evil.test', 'a@clinic.test\r\nBcc: b@evil.test',
      'Pat <a@clinic.test>', 'a@clinic.test&bcc=b@evil.test', 'a@localhost', 'javascript:alert(1)//@x.test']) {
      expect(isSafeAddress(bad), bad).toBe(false);
      expect(() => mailtoHref(bad, 's', 'b')).toThrow();
      const x = handoffOf({ ...approved, recipientEmail: bad })!;
      expect(x.mailto, bad).toBeNull();
      expect(x.mailtoUnavailable).toMatch(/Copy the message instead/);
    }
  });

  it('offers copy, not a link, when the message is too long for an email link', () => {
    const x = handoffOf({ ...approved, body: 'x'.repeat(MAX_MAILTO) })!;
    expect(x.mailto).toBeNull();
    expect(x.mailtoUnavailable).toMatch(/too long/);
    expect(x.copyText).toContain('x'.repeat(MAX_MAILTO));
  });
});

describe('the opt-out wording is configuration while B4 is open', () => {
  it('is one sentence in src/sell/wording.ts, used by the draft and accepted by the lint', () => {
    expect(OUTREACH_WORDING).toMatchObject({ decision: 'B4', settled: false });
    expect(OPT_OUT_SENTENCE).toBe(OUTREACH_WORDING.optOutSentence);
    expect(OUTREACH_WORDING.optOutPattern.test(OUTREACH_WORDING.optOutSentence)).toBe(true);
    const ev = { evidenceId: '1', claimState: 'OBSERVED' as const, plainIssue: 'A broken link', url: 'https://clinic.test/contact', quote: '<a href="#">Book</a>',
      observedAt: '2026-10-05T12:00:00Z', recheckResult: null };
    const d = composeDraft({ businessName: 'Clinic', contactName: null, evidence: [ev], service: { name: 'Website Fix Sprint', price: null, currency: null }, senderName: null });
    expect(d.body.endsWith(OUTREACH_WORDING.optOutSentence)).toBe(true);
    expect(d.body).toContain(OUTREACH_WORDING.closingLine);
    // No link of Scopely's own in a first message while B4 is open: the only link is the cited page.
    expect(d.body.match(/https?:\/\/\S+/g)?.every((l) => l.startsWith('https://clinic.test'))).toBe(true);
    expect(lintDraft({ subject: d.subject, body: d.body, evidence: [ev], price: null, currency: null, notObservable: null,
      contactSuppressed: false, businessSuppressed: false }).errors.map((e) => e.code)).not.toContain('opt_out_missing');
  });
});

describe('approving, handing off and recording the send', () => {
  it('approval sends nothing; the approved text is handed off; recording the send records the pitch with that message', async () => {
    const { opp, contactId } = await readyCase(db());
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    let list = (await call('GET', `/api/opportunities/${opp}/drafts`)).json();
    expect(list.drafts[0].handoff).toBeNull();
    expect(list.wording).toEqual({ decision: 'B4', settled: false });
    // Recording a send before approval is refused, and nothing is written.
    const early = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/sent`, { recordedBy: 'Sam' });
    expect(early.status).toBe(409);
    expect(early.json().error).toMatch(/Approve the draft first/);
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' })).json()).toMatchObject({ ok: true });
    // Approval is not sending.
    expect(await msg(messageId)).toMatchObject({ approval_status: 'approved', sent_at: null, sender_email: null, recipient_email: 'owner@example-clinic.test' });
    expect((await pitches(opp)).rows).toEqual([]);
    list = (await call('GET', `/api/opportunities/${opp}/drafts`)).json();
    const d = list.drafts[0];
    expect(d.handoff).toMatchObject({ to: 'owner@example-clinic.test', from: 'seller@seller.test', subject: d.subject, body: d.body });
    expect(d.handoff.mailto).toBe(mailtoHref('owner@example-clinic.test', d.subject, d.body));
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/sent`, { recordedBy: '' })).status).toBe(400);
    const sent = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/sent`, { recordedBy: 'Sam' });
    expect(sent.status).toBe(200);
    expect(sent.json()).toMatchObject({ ok: true, sentByScopely: false });
    const m = await msg(messageId);
    expect(m.sent_at).not.toBeNull();
    expect(m.sender_email).toBe('seller@seller.test');
    expect((await pitches(opp)).rows).toEqual([{ kind: 'pitched', channel: 'email', message_id: messageId, recorded_by: 'Sam' }]);
    expect((await one<{ status: string; pitched_at: Date | null }>(db(), 'SELECT status, pitched_at FROM opportunities WHERE id = $1', [opp])).pitched_at).not.toBeNull();
    // Once sent: no handoff, no second record, no edit.
    list = (await call('GET', `/api/opportunities/${opp}/drafts`)).json();
    expect(list.drafts[0]).toMatchObject({ handoff: null, readiness: { status: 'SENT' } });
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/sent`, { recordedBy: 'Sam' })).json().error).toMatch(/already recorded as sent/);
    expect((await pitches(opp)).rows).toHaveLength(1);
    const cf = (await call('GET', `/api/opportunities/${opp}`)).json();
    expect(cf.sell.outcomes.some((x: { kind: string }) => x.kind === 'pitched')).toBe(true);
  });

  it('a suppression after approval stops the send being recorded, with the reason, and writes nothing', async () => {
    const { c, opp, contactId } = await readyCase(db());
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    await db().query(`INSERT INTO suppression (business_id, reason) VALUES ($1, 'opt_out')`, [c.businessId]);
    const r = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/sent`, { recordedBy: 'Sam' });
    expect(r.status).toBe(409);
    expect(r.json().error).toMatch(/Cannot record it as sent: .*suppress/i);
    expect((await msg(messageId)).sent_at).toBeNull();
    expect((await pitches(opp)).rows).toEqual([]);
  });

  it('another workspace cannot see the handoff or record a send', async () => {
    const { opp, contactId } = await readyCase(db());
    const a = await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws');
    const own = await start();
    const { messageId } = (await own.call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    await own.call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    const b = await enterNewWorkspace(db(), 'beta');
    await useWorkspace(db(), a.ws);
    const other = await start({ workspaceId: b });
    expect((await other.call('GET', `/api/opportunities/${opp}/drafts`)).status).toBe(404);
    expect((await other.call('POST', `/api/opportunities/${opp}/drafts/${messageId}/sent`, { recordedBy: 'Mallory' })).status).toBe(404);
    await useWorkspace(db(), a.ws);
    expect((await msg(messageId)).sent_at).toBeNull();
  });

  it('a draft id from another opportunity is not found', async () => {
    const one1 = await readyCase(db());
    const two = { opp: await seedOpportunity(db(), await seedChain(db())) };
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${one1.opp}/drafts`, { draftedBy: 'Sam', contactId: one1.contactId })).json();
    await call('POST', `/api/opportunities/${one1.opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    expect((await call('POST', `/api/opportunities/${two.opp}/drafts/${messageId}/sent`, { recordedBy: 'Sam' })).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${one1.opp}/drafts/abc/sent`, { recordedBy: 'Sam' })).status).toBe(404);
  });
});

describe('mailtoHref', () => {
  it('keeps the plain address readable and escapes only what a link would misread', () => {
    expect(mailtoHref('pat.o+clinic@clinic.test', 'Hi & bye', 'a\nb')).toBe('mailto:pat.o+clinic@clinic.test?subject=Hi%20%26%20bye&body=a%0D%0Ab');
    expect(mailtoHref('50%off@clinic.test', 's', 'b').startsWith('mailto:50%25off@clinic.test?')).toBe(true);
  });
});
