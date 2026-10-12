// Outreach drafts (release 1, A41–A43): a saved first message for one opportunity, prepared in the
// Case File and never sent by Scopely.
//
// A draft is a `messages` row (002/005/007/017). It cites the opportunity's own evidence, names an
// optional contact of the business, proposes the opportunity's own service, and names the
// workspace's mailbox as its sender when one exists. Scopely writes the first version from what is
// on file only (composeDraft): the finding as observed, its page and the link exactly as published,
// the mapped service, its price only when the opportunity has one, the business's name, the contact's
// name only when recorded, and the sender's display name only when recorded. Nothing is invented:
// no personalisation, relationship, number or result. An INFERRED finding is written only as
// Scopely's reading; NOT_OBSERVABLE is never evidence, so it never reaches a draft.
//
// Every save runs the lint (lint.outreach_draft v1) and records lint_status and lint_errors. Approval
// stays unset on create and on every edit. approveDraft is the only approval path: a named person,
// every readiness check passing, and then the database's own message_gate and message_draft_guard
// judge the UPDATE. There is no send: nothing here writes sent_at, sender_email or recipient_email.
//
// Logs and errors never carry the subject, the body or contact details.
import type { Db } from '../tenancy/index.js';

export class DraftRejected extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export const DRAFT_GENERATOR = 'scopely:draft/1';
export const LINT_RULE = { key: 'lint.outreach_draft', version: 1 } as const;
/** The opt-out sentence every draft carries. Article 14 wording is open decision B4: this is the conservative form. */
export const OPT_OUT_SENTENCE = 'If you would rather not hear from me, reply "no thanks" and I won\'t contact you again.';
export const MAX_SUBJECT = 200;
export const MAX_BODY = 5000;

const WS = 'workspace_id = scopely.current_workspace_id()';
const text = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max) : null;
};
const isId = (v: unknown) => typeof v === 'string' && /^\d{1,18}$/.test(v);

// ------------------------------------------------------------------ composing (pure)

export interface DraftEvidence {
  evidenceId: string;
  claimState: 'OBSERVED' | 'INFERRED';
  plainIssue: string;
  url: string;
  quote: string;
  observedAt: string;
}

export interface DraftFacts {
  businessName: string;
  /** The contact's name exactly as recorded, or null. */
  contactName: string | null;
  evidence: DraftEvidence[];
  service: { name: string | null; price: string | null; currency: string | null };
  /** The sender's display name as recorded on the mailbox, or null. */
  senderName: string | null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A date the same way on every machine: 5 October 2026 (UTC). */
export function dayWords(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** An amount as the draft writes it: the currency code and the stored decimal, never reformatted. */
export const priceWords = (currency: string, price: string) => `${currency} ${price}`;

/**
 * The first version of a draft, deterministic: the same facts always give the same text. It says
 * only what is on file. The caller passes only findings that still hold.
 */
export function composeDraft(f: DraftFacts): { subject: string; body: string } {
  const observed = f.evidence.filter((e) => e.claimState === 'OBSERVED');
  const inferred = f.evidence.filter((e) => e.claimState === 'INFERRED');
  const subject = observed.length ? `A problem on the ${f.businessName} website` : `A note about the ${f.businessName} website`;
  const lines: string[] = [f.contactName ? `Hello ${f.contactName},` : 'Hello,', ''];
  for (const e of observed) {
    lines.push(`On ${dayWords(e.observedAt)}, the page ${e.url} showed this problem:`, `- ${sentence(e.plainIssue)}`, `  As published: ${e.quote}`, '');
  }
  for (const e of inferred) {
    lines.push(`Scopely's reading, not something seen directly on the page: ${sentence(e.plainIssue)}`, '');
  }
  if (f.service.name) {
    lines.push(f.service.price !== null && f.service.currency
      ? `The service I would propose is ${f.service.name}. The price is ${priceWords(f.service.currency, f.service.price)}.`
      : `The service I would propose is ${f.service.name}.`, '');
  }
  lines.push('If you would like the details, reply to this email.', '', OPT_OUT_SENTENCE);
  if (f.senderName) lines.push('', f.senderName);
  return { subject, body: lines.join('\n') };
}

// ------------------------------------------------------------------ lint (lint.outreach_draft v1)

export interface LintError { code: string; message: string }
export interface LintResult { status: 'pass' | 'fail'; errors: LintError[] }

export interface LintInput {
  subject: string;
  body: string;
  /** The cited findings, with their latest re-check result. */
  evidence: (DraftEvidence & { recheckResult: string | null })[];
  /** The opportunity's own price, or null when it has none. */
  price: string | null;
  currency: string | null;
  /** What the analysis could not observe, as stored on the opportunity. */
  notObservable: string | null;
  contactSuppressed: boolean;
  businessSuppressed: boolean;
}

const CURRENCY_CODES = 'GBP|USD|EUR|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|ZAR|INR|JPY|SGD|HKD|AED|IEP';
const AMOUNT = new RegExp(`([£$€])\\s?(\\d[\\d,]*(?:\\.\\d+)?)|\\b(${CURRENCY_CODES})\\s?(\\d[\\d,]*(?:\\.\\d+)?)|(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${CURRENCY_CODES}|pounds?|dollars?|euros?)\\b`, 'gi');
const SYMBOL: Record<string, string> = { '£': 'GBP', '€': 'EUR' };
const PLACEHOLDER = /\[(?:your|name|first|company|business|insert|sender|contact|price|date)[^\]\n]{0,40}\]|\{\{[^}\n]*\}\}|<(?:insert|your)[^>\n]{0,40}>|\bTODO\b|\bXXX+\b/i;
const OPT_OUT = /won['’]t contact you again|will not contact you again|\bunsubscribe\b/i;

const sameAmount = (a: string, b: string) => Number(a.replace(/,/g, '')) === Number(b);

/**
 * The lint, on the text as it would go out. Text quoted from the page (the verbatim quote and the
 * page address) is the business's own and is left out of the number and placeholder checks.
 */
export function lintDraft(x: LintInput): LintResult {
  const errors: LintError[] = [];
  const add = (code: string, message: string) => { if (!errors.some((e) => e.code === code)) errors.push({ code, message }); };
  const whole = `${x.subject}\n${x.body}`;
  let own = whole;
  for (const e of x.evidence) own = own.split(e.quote).join(' ').split(e.url).join(' ');
  own = own.replace(/\bhttps?:\/\/\S+/gi, ' ');

  if (!OPT_OUT.test(x.body)) add('opt_out_missing', 'Add the opt-out sentence: reply "no thanks" and you won\'t contact them again.');
  for (const e of x.evidence) {
    if (e.recheckResult === 'gone') add('evidence_gone', `It cites a finding re-checked as no longer there: "${e.plainIssue}". Drop it.`);
    if (e.recheckResult === 'changed') add('evidence_changed', `It cites a finding re-checked as changed: "${e.plainIssue}". Drop it.`);
    if (e.claimState === 'INFERRED') {
      const issue = e.plainIssue.trim().replace(/\.$/, '');
      const line = x.body.split('\n').find((l) => issue && l.toLowerCase().includes(issue.toLowerCase()));
      if (line && !/\breading\b/i.test(line)) add('inferred_as_observed', `"${e.plainIssue}" was inferred, not seen on the page. Say it is Scopely's reading.`);
    }
  }
  if (x.notObservable) {
    const said = x.notObservable.replace(/^Not observable in this analysis:\s*/i, '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 20);
    if (said.some((s) => whole.toLowerCase().includes(s.toLowerCase()))) {
      add('not_observable_claim', 'It repeats something Scopely could not observe. Leave it out: it is not a finding.');
    }
  }
  for (const m of own.matchAll(AMOUNT)) {
    const value = m[2] ?? m[4] ?? m[5]!;
    const unit = m[1] ? SYMBOL[m[1]] ?? null : (m[3] ?? m[6] ?? '').toUpperCase();
    const code = unit && /^[A-Z]{3}$/.test(unit) ? unit : null;
    if (x.price === null) { add('unbacked_amount', 'It states an amount, but this opportunity has no price set. Remove it or set the price first.'); break; }
    if (!sameAmount(value, x.price) || (code && x.currency && code !== x.currency)) {
      add('unbacked_amount', `It states an amount that is not this opportunity's price (${x.currency ?? ''} ${x.price}).`.replace('( ', '('));
      break;
    }
  }
  if (/\d\s?%/.test(own) || /\bper ?cent\b/i.test(own)) add('unbacked_percentage', 'It states a percentage Scopely has not measured. Remove it.');
  if (PLACEHOLDER.test(own)) add('placeholder', 'It still has a placeholder to fill in.');
  if (x.contactSuppressed) add('contact_suppressed', 'The contact’s address is on your suppression list.');
  if (x.businessSuppressed) add('business_suppressed', 'This business or its domain is on your suppression list.');
  return { status: errors.length ? 'fail' : 'pass', errors };
}

// ------------------------------------------------------------------ database

interface OppRow { id: string; business_id: string; business_name: string; domain: string | null; catalog_item_id: string | null;
  service: string | null; service_price: string | null; currency: string | null; not_observable_notes: string | null }

async function caseOpportunity(db: Db, opportunityId: string): Promise<OppRow> {
  if (!isId(opportunityId)) throw new DraftRejected(404, 'That opportunity does not exist.');
  const r = (await db.query(
    `SELECT o.id, o.business_id, b.name AS business_name, b.domain, o.catalog_item_id, c.service, o.service_price::text AS service_price, o.currency,
            o.not_observable_notes
       FROM scopely.opportunities o JOIN scopely.businesses b ON b.id = o.business_id
       LEFT JOIN scopely.catalog_items c ON c.id = o.catalog_item_id
      WHERE o.id = $1 AND o.${WS} AND b.${WS}`, [opportunityId])).rows[0];
  if (!r) throw new DraftRejected(404, 'That opportunity does not exist.');
  return { ...r, id: String(r.id), business_id: String(r.business_id), catalog_item_id: r.catalog_item_id === null ? null : String(r.catalog_item_id) };
}

/** The opportunity's cited findings, with their latest re-check, strongest first. */
async function opportunityEvidence(db: Db, opportunityId: string): Promise<(DraftEvidence & { recheckResult: string | null; confidence: string })[]> {
  const r = await db.query(
    `SELECT e.id, e.claim_state, e.plain_issue, e.url, e.quote, e.observed_at, e.recheck_result, e.confidence
       FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
      WHERE oe.opportunity_id = $1 AND oe.${WS} AND e.${WS}
      ORDER BY CASE e.confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, e.id`, [opportunityId]);
  return r.rows.map((e) => ({ evidenceId: String(e.id), claimState: e.claim_state, plainIssue: e.plain_issue, url: e.url, quote: e.quote,
    observedAt: new Date(e.observed_at).toISOString(), recheckResult: e.recheck_result, confidence: e.confidence }));
}

/** A contact of the opportunity's business, or 404. */
async function caseContact(db: Db, businessId: string, contactId: unknown): Promise<{ id: string; full_name: string | null } | null> {
  if (contactId === null || contactId === undefined || contactId === '') return null;
  if (!isId(String(contactId))) throw new DraftRejected(404, 'That contact is not one of this business’s contacts.');
  const c = (await db.query(`SELECT id, full_name FROM scopely.contacts WHERE id = $1 AND business_id = $2 AND ${WS}`, [String(contactId), businessId])).rows[0];
  if (!c) throw new DraftRejected(404, 'That contact is not one of this business’s contacts.');
  return { id: String(c.id), full_name: c.full_name };
}

/** The mailbox a draft names as its sender: the one asked for, else the workspace's first usable one, else none. */
async function senderMailbox(db: Db, mailboxId: unknown): Promise<{ id: string; display_name: string | null } | null> {
  if (mailboxId !== null && mailboxId !== undefined && mailboxId !== '') {
    if (!isId(String(mailboxId))) throw new DraftRejected(404, 'That mailbox is not one of this workspace’s mailboxes.');
    const m = (await db.query(`SELECT id, display_name FROM scopely.mailbox_connections WHERE id = $1 AND ${WS}`, [String(mailboxId)])).rows[0];
    if (!m) throw new DraftRejected(404, 'That mailbox is not one of this workspace’s mailboxes.');
    return { id: String(m.id), display_name: m.display_name };
  }
  const m = (await db.query(`SELECT id, display_name FROM scopely.mailbox_connections WHERE ${WS} AND state IN ('MANUAL','CONNECTED') ORDER BY id LIMIT 1`)).rows[0];
  return m ? { id: String(m.id), display_name: m.display_name } : null;
}

/** Whether the workspace's suppression list reaches this contact's address, or the business or its domain. */
async function suppressionFor(db: Db, businessId: string, contactId: string | null): Promise<{ contact: boolean; business: boolean }> {
  const r = (await db.query(
    `SELECT EXISTS (SELECT 1 FROM scopely.suppression s JOIN scopely.businesses b ON b.id = $1
                     WHERE s.${WS} AND (s.business_id = b.id OR (s.domain IS NOT NULL AND lower(s.domain) = lower(coalesce(b.domain, ''))))) AS business,
            EXISTS (SELECT 1 FROM scopely.suppression s JOIN scopely.contacts c ON c.id = $2
                     WHERE s.${WS} AND c.email IS NOT NULL
                       AND ((s.email IS NOT NULL AND lower(s.email) = lower(c.email))
                            OR (s.domain IS NOT NULL AND lower(s.domain) = lower(split_part(c.email, '@', 2))))) AS contact`,
    [businessId, contactId])).rows[0];
  return { contact: Boolean(r.contact), business: Boolean(r.business) };
}

/** The lint of a message's text as it stands now, against what is on file now. */
export async function lintMessage(db: Db, opp: OppRow, m: { subject: string; body: string; evidenceIds: string[]; contactId: string | null }): Promise<LintResult> {
  const all = await opportunityEvidence(db, opp.id);
  const cited = all.filter((e) => m.evidenceIds.includes(e.evidenceId));
  const sup = await suppressionFor(db, opp.business_id, m.contactId);
  return lintDraft({ subject: m.subject, body: m.body, evidence: cited, price: opp.service_price, currency: opp.currency,
    notObservable: opp.not_observable_notes, contactSuppressed: sup.contact, businessSuppressed: sup.business });
}

/** A savepoint around a write, so a refusal leaves the caller's transaction usable; the database's words, said plainly. */
async function guarded<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query('SAVEPOINT draft_write');
  try {
    const out = await fn();
    await db.query('RELEASE SAVEPOINT draft_write');
    return out;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT draft_write');
    const e = err as { code?: string; message?: string };
    if (e.code === '23514' || e.code === '23503') {
      const m = String(e.message ?? '');
      const reason = /cannot approve: (.*)$/.exec(m)?.[1];
      throw new DraftRejected(409, reason ? `Cannot approve: ${reason}.`.replace(/\.\.$/, '.') : 'That could not be saved. Nothing was changed.');
    }
    throw err;
  }
}

const lintRuleId = async (db: Db) => String((await db.query(`SELECT id FROM scopely.rule_versions WHERE rule_key = $1 AND version = $2`,
  [LINT_RULE.key, LINT_RULE.version])).rows[0].id);

export interface CreateDraftInput {
  draftedBy: string;
  contactId?: string | null;
  /** The findings to cite; by default every finding of the opportunity that still holds. */
  evidenceIds?: string[] | null;
  /** The workspace mailbox to send from later; by default its first usable one, or none. */
  mailboxId?: string | null;
}

/** Saves Scopely's first version of a draft. Approval stays unset. Returns the message id and its lint. */
export async function createDraft(db: Db, opportunityId: string, input: CreateDraftInput): Promise<{ messageId: string; lint: LintResult; sender: boolean }> {
  const opp = await caseOpportunity(db, opportunityId);
  const draftedBy = text(input.draftedBy, 120);
  if (!draftedBy) throw new DraftRejected(400, 'Say who is preparing this draft.');
  const contact = await caseContact(db, opp.business_id, input.contactId);
  const mailbox = await senderMailbox(db, input.mailboxId);
  const all = await opportunityEvidence(db, opp.id);
  const holding = all.filter((e) => e.recheckResult !== 'changed' && e.recheckResult !== 'gone');
  let cited = holding;
  if (Array.isArray(input.evidenceIds) && input.evidenceIds.length) {
    const want = input.evidenceIds.map(String);
    if (want.some((id) => !all.some((e) => e.evidenceId === id))) throw new DraftRejected(404, 'That finding is not part of this opportunity.');
    cited = all.filter((e) => want.includes(e.evidenceId));
  }
  if (cited.length === 0) throw new DraftRejected(409, 'No finding on this opportunity still holds, so there is nothing a draft can cite.');
  const { subject, body } = composeDraft({
    businessName: opp.business_name, contactName: contact?.full_name ?? null, evidence: cited,
    service: { name: opp.service, price: opp.service_price, currency: opp.currency }, senderName: mailbox?.display_name ?? null,
  });
  const lint = await lintMessage(db, opp, { subject, body, evidenceIds: cited.map((e) => e.evidenceId), contactId: contact?.id ?? null });
  const rule = await lintRuleId(db);
  const messageId = await guarded(db, async () => String((await db.query(
    `INSERT INTO scopely.messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator, lint_rule_version_id, lint_status, lint_errors,
       mailbox_connection_id, catalog_item_id, drafted_by)
     VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [opp.id, contact?.id ?? null, subject, body, cited.map((e) => e.evidenceId), DRAFT_GENERATOR, rule, lint.status, JSON.stringify(lint.errors),
     mailbox?.id ?? null, opp.catalog_item_id, draftedBy])).rows[0].id));
  return { messageId, lint, sender: mailbox !== null };
}

/** The draft as stored, in this opportunity and workspace, or 404. */
async function caseDraft(db: Db, opportunityId: string, messageId: string) {
  if (!isId(messageId)) throw new DraftRejected(404, 'That draft is not part of this opportunity.');
  const m = (await db.query(`SELECT * FROM scopely.messages WHERE id = $1 AND opportunity_id = $2 AND ${WS} FOR UPDATE`, [messageId, opportunityId])).rows[0];
  if (!m) throw new DraftRejected(404, 'That draft is not part of this opportunity.');
  return m;
}

export interface EditDraftInput {
  subject: string;
  body: string;
  editedBy: string;
  /** Omit to keep the contact; null to clear it. */
  contactId?: string | null;
  /** Omit to keep the sender; null to clear it. */
  mailboxId?: string | null;
}

/** A person's change to a draft's text, contact or sender. Only an unapproved, unsent draft changes; approval stays unset. */
export async function editDraft(db: Db, opportunityId: string, messageId: string, input: EditDraftInput): Promise<{ messageId: string; lint: LintResult }> {
  const opp = await caseOpportunity(db, opportunityId);
  const m = await caseDraft(db, opp.id, messageId);
  if (m.sent_at !== null) throw new DraftRejected(409, 'This message is recorded as sent, so it cannot change.');
  if (m.approval_status !== 'pending') {
    throw new DraftRejected(409, m.approval_status === 'rejected' ? 'This draft was rejected. Start a new draft instead.' : 'This draft is approved, so it cannot change. Start a new draft instead.');
  }
  const editedBy = text(input.editedBy, 120);
  if (!editedBy) throw new DraftRejected(400, 'Say who is editing this draft.');
  const subject = text(input.subject, MAX_SUBJECT + 1);
  const body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : '';
  if (!subject) throw new DraftRejected(400, 'A draft needs a subject.');
  if (subject.length > MAX_SUBJECT) throw new DraftRejected(400, `Keep the subject under ${MAX_SUBJECT} characters.`);
  if (!body) throw new DraftRejected(400, 'A draft needs a message.');
  if (body.length > MAX_BODY) throw new DraftRejected(400, `Keep the message under ${MAX_BODY} characters.`);
  const contact = input.contactId === undefined ? (m.contact_id === null ? null : { id: String(m.contact_id) }) : await caseContact(db, opp.business_id, input.contactId);
  const mailbox = input.mailboxId === undefined ? (m.mailbox_connection_id === null ? null : { id: String(m.mailbox_connection_id) }) : await senderMailbox(db, input.mailboxId ?? '');
  const mailboxId = input.mailboxId === null ? null : mailbox?.id ?? null;
  const evidenceIds = (m.evidence_ids as string[]).map(String);
  const lint = await lintMessage(db, opp, { subject, body, evidenceIds, contactId: contact?.id ?? null });
  const rule = await lintRuleId(db);
  await guarded(db, () => db.query(
    `UPDATE scopely.messages SET subject = $2, body = $3, contact_id = $4, mailbox_connection_id = $5, lint_status = $6, lint_errors = $7,
            lint_rule_version_id = $8, edited_by = $9, edited_at = now()
      WHERE id = $1 AND approval_status = 'pending' AND sent_at IS NULL`,
    [m.id, subject, body, contact?.id ?? null, mailboxId, lint.status, JSON.stringify(lint.errors), rule, editedBy]));
  return { messageId: String(m.id), lint };
}

export type DraftCheckKey = 'lint' | 'sender' | 'contact' | 'evidence';
export interface DraftCheck { key: DraftCheckKey; state: 'done' | 'missing' | 'blocked'; label: string; detail: string | null }
export interface DraftReadiness { status: 'READY' | 'NOT_READY' | 'BLOCKED' | 'APPROVED' | 'REJECTED' | 'SENT'; checks: DraftCheck[]; lint: LintResult }

/**
 * Whether a person may approve this draft now, from what is on file now: the lint re-run, a usable
 * sender, a contact that passes contact_outreach_blocker (lawful basis, the country's rule,
 * suppression) and evidence that passes evidence_send_blocker. Every gate is the database's own.
 */
export async function draftReadiness(db: Db, opp: OppRow, m: Record<string, any>): Promise<DraftReadiness> {
  const evidenceIds = (m.evidence_ids as string[]).map(String);
  const contactId = m.contact_id === null ? null : String(m.contact_id);
  const lint = await lintMessage(db, opp, { subject: m.subject, body: m.body, evidenceIds, contactId });
  const g = (await db.query(
    `SELECT scopely.contact_outreach_blocker($1::bigint, $2::bigint) AS contact_blocker,
            scopely.evidence_send_blocker($3::bigint[], now()) AS evidence_blocker,
            (SELECT state FROM scopely.mailbox_connections WHERE id = $4 AND ${WS}) AS mailbox_state,
            (SELECT count(*)::int FROM scopely.evidence e WHERE e.id = ANY ($3::bigint[]) AND e.recheck_result IN ('changed','gone')) AS dropped`,
    [contactId, opp.business_id, evidenceIds, m.mailbox_connection_id])).rows[0];
  const checks: DraftCheck[] = [];
  checks.push(lint.status === 'pass'
    ? { key: 'lint', state: 'done', label: 'Lint passed', detail: null }
    : { key: 'lint', state: 'blocked', label: 'Lint failed', detail: lint.errors.map((e) => e.message).join(' ') });
  checks.push(m.mailbox_connection_id === null
    ? { key: 'sender', state: 'missing', label: 'No sender set', detail: 'This workspace has no mailbox to send from. Add one (pnpm record mailbox) and pick it here.' }
    : ['MANUAL', 'CONNECTED'].includes(g.mailbox_state)
      ? { key: 'sender', state: 'done', label: 'Sender set', detail: null }
      : { key: 'sender', state: 'blocked', label: 'Sender cannot send', detail: `The mailbox is ${String(g.mailbox_state ?? 'missing').toLowerCase()}.` });
  checks.push(contactId === null
    ? { key: 'contact', state: 'missing', label: 'No contact chosen', detail: 'Choose who this goes to.' }
    : g.contact_blocker === null
      ? { key: 'contact', state: 'done', label: 'Contact may be emailed', detail: null }
      : { key: 'contact', state: /suppressed|not_permitted/.test(g.contact_blocker) ? 'blocked' : 'missing', label: 'Contact may not be emailed', detail: g.contact_blocker });
  checks.push(g.evidence_blocker === null
    ? { key: 'evidence', state: 'done', label: 'Evidence clear to use', detail: null }
    : { key: 'evidence', state: Number(g.dropped) > 0 ? 'blocked' : 'missing', label: Number(g.dropped) > 0 ? 'Cites a finding that no longer holds' : 'Evidence needs re-check',
        detail: g.evidence_blocker });
  const status = m.sent_at !== null ? 'SENT' : m.approval_status === 'rejected' ? 'REJECTED'
    : m.approval_status === 'approved' || m.approval_status === 'edited' ? 'APPROVED'
      : checks.some((c) => c.state === 'blocked') ? 'BLOCKED' : checks.every((c) => c.state === 'done') ? 'READY' : 'NOT_READY';
  return { status, checks, lint };
}

/**
 * A named person approves a draft. Refused, with the reason, unless every readiness check passes now;
 * then the lint result is refreshed and the UPDATE goes through message_gate (lawful recipient,
 * suppression, the country's company rule) and message_draft_guard (no approval over a failed lint).
 * Approval is not sending: nothing is sent and sent_at stays unset.
 */
export async function approveDraft(db: Db, opportunityId: string, messageId: string, input: { approvedBy: string }): Promise<{ approvedAt: string }> {
  const opp = await caseOpportunity(db, opportunityId);
  const m = await caseDraft(db, opp.id, messageId);
  const approvedBy = text(input.approvedBy, 120);
  if (!approvedBy) throw new DraftRejected(400, 'Say who is approving this draft.');
  if (m.sent_at !== null) throw new DraftRejected(409, 'This message is recorded as sent.');
  if (m.approval_status !== 'pending') throw new DraftRejected(409, m.approval_status === 'rejected' ? 'This draft was rejected.' : 'This draft is already approved.');
  const r = await draftReadiness(db, opp, m);
  const first = r.checks.find((c) => c.state !== 'done');
  if (first) throw new DraftRejected(409, `Not ready to approve: ${first.label.toLowerCase()}${first.detail ? `. ${first.detail}` : '.'}`.replace(/\.\.$/, '.'));
  const rule = await lintRuleId(db);
  return guarded(db, async () => {
    const row = (await db.query(
      `UPDATE scopely.messages SET lint_status = $2, lint_errors = $3, lint_rule_version_id = $4, approval_status = 'approved', approved_by = $5, approved_at = now()
        WHERE id = $1 AND approval_status = 'pending' AND sent_at IS NULL RETURNING approved_at`,
      [m.id, r.lint.status, JSON.stringify(r.lint.errors), rule, approvedBy])).rows[0];
    if (!row) throw new DraftRejected(409, 'This draft changed while you were approving it. Reload and try again.');
    return { approvedAt: new Date(row.approved_at).toISOString() };
  });
}

export { caseOpportunity as draftOpportunity };
