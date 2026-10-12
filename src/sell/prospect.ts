// Prospect Readiness (Slice 9): the Case File writers that turn an opportunity into a prospect the
// seller may act on. Each one writes an existing table through the existing guards:
//
//   re-check          snapshots + observations + evidence_rechecks (005), a person's visit to the
//                     evidence's own page, recorded as fetch_method 'manual'. Nothing is fetched.
//   contact           contacts (001), only what the seller typed, with its source and lawful basis
//   company register  businesses.company_register / number / type / status (001), as supplied
//   suppression       suppression (001/007), an email, domain or business of this workspace
//
// Every write is scoped to the opportunity it is made from: the opportunity must be in the current
// workspace, the evidence must be cited by it, the contact must belong to its business. Anything else
// reads as not found. The database's own guards (workspace guard, RLS, re-check guard) stay the judge.
//
// Logs and errors never carry contact details, notes or URLs.
import { type ContactInput, SUPPRESSION_REASONS, recordContact, recordSuppression } from '../record/index.js';
import { FACT_KINDS } from '../providers/prospects.js';
import { normalizeFact } from '../prospects/facts.js';
import type { Db } from '../tenancy/index.js';

export class ProspectRejected extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

const text = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max) : null;
};

/** Runs a write in a savepoint, so a refusal leaves the caller's transaction usable. */
async function guarded<T>(db: Db, fn: () => Promise<T>, plain: (message: string, code: string) => string | null): Promise<T> {
  await db.query('SAVEPOINT prospect_write');
  try {
    const out = await fn();
    await db.query('RELEASE SAVEPOINT prospect_write');
    return out;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT prospect_write');
    const e = err as { code?: string; message?: string };
    if (e.code === '23514' || e.code === '23503' || e.code === '23505' || e.code === '23502') {
      throw new ProspectRejected(409, plain(String(e.message ?? ''), e.code) ?? 'That could not be recorded. Nothing was changed.');
    }
    throw err;
  }
}

/** The opportunity's business in the current workspace, or 404. */
async function caseBusiness(db: Db, opportunityId: string): Promise<{ businessId: string; domain: string | null }> {
  const r = (await db.query(
    `SELECT o.business_id, b.domain FROM scopely.opportunities o JOIN scopely.businesses b ON b.id = o.business_id
      WHERE o.id = $1 AND o.workspace_id = scopely.current_workspace_id() AND b.workspace_id = scopely.current_workspace_id()`,
    [opportunityId])).rows[0];
  if (!r) throw new ProspectRejected(404, 'That opportunity does not exist.');
  return { businessId: String(r.business_id), domain: r.domain };
}

// ------------------------------------------------------------------ 1. evidence re-check

export const RECHECK_RESULTS = ['confirmed', 'gone', 'changed'] as const;

export interface CaseRecheckInput {
  /** What the person saw on the evidence's own page: still there, no longer there, or changed. */
  result: string;
  recordedBy: string;
  /** Required for changed: what changed. */
  notes?: string | null;
}

/**
 * Records a person's re-check of one finding cited by this opportunity. The re-check visits the
 * evidence's own URL (never a URL the request supplies), on a new snapshot taken now, and re-runs the
 * same check and rule version: still there is an OBSERVED result equal to the original (gap or
 * defect), gone is an OBSERVED ok, changed carries the person's note and no observation. The
 * evidence row itself is never written: its re-check projection follows the ledger (005).
 */
export async function recordCaseRecheck(db: Db, opportunityId: string, evidenceId: string, input: CaseRecheckInput): Promise<{ recheckId: string; rechecked: string }> {
  await caseBusiness(db, opportunityId);
  if (!/^\d{1,18}$/.test(evidenceId)) throw new ProspectRejected(404, 'That finding is not part of this opportunity.');
  const ev = (await db.query(
    `SELECT e.id, e.business_id, e.url, e.claim_state, o.check_code, o.rule_version_id, o.result AS original_result
       FROM scopely.opportunity_evidence oe
       JOIN scopely.evidence e ON e.id = oe.evidence_id
       JOIN scopely.observations o ON o.id = e.observation_id
      WHERE oe.opportunity_id = $1 AND oe.evidence_id = $2
        AND oe.workspace_id = scopely.current_workspace_id() AND e.workspace_id = scopely.current_workspace_id()`,
    [opportunityId, evidenceId])).rows[0];
  if (!ev) throw new ProspectRejected(404, 'That finding is not part of this opportunity.');
  const result = String(input.result ?? '') as (typeof RECHECK_RESULTS)[number];
  if (!(RECHECK_RESULTS as readonly string[]).includes(result)) throw new ProspectRejected(400, 'Say what you saw: still there, no longer there, or changed.');
  const recordedBy = text(input.recordedBy, 120);
  if (!recordedBy) throw new ProspectRejected(400, 'Say who is recording this.');
  const notes = text(input.notes, 2000);
  if (result === 'changed' && !notes) throw new ProspectRejected(400, 'Say what changed.');
  // An inferred finding was never seen on the page, so a visit cannot confirm it or see it gone.
  if (result !== 'changed' && ev.claim_state !== 'OBSERVED') {
    throw new ProspectRejected(409, 'This finding was inferred, not seen on the page, so a visit cannot confirm it. Record what changed instead.');
  }

  const recheckId = await guarded(db, async () => {
    // The visit is the request's time, the same clock the show and send gates read.
    const snap = (await db.query(
      `INSERT INTO scopely.snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, $2, now(), 'manual')
       RETURNING id, fetched_at`, [ev.business_id, ev.url])).rows[0];
    let observationId: string | null = null;
    if (result !== 'changed') {
      observationId = String((await db.query(
        `INSERT INTO scopely.observations (snapshot_id, check_code, rule_version_id, state, result, observed_at)
         VALUES ($1, $2, $3, 'OBSERVED', $4, $5) RETURNING id`,
        [snap.id, ev.check_code, ev.rule_version_id, result === 'confirmed' ? ev.original_result : 'ok', snap.fetched_at])).rows[0].id);
    }
    return String((await db.query(
      `INSERT INTO scopely.evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [ev.id, snap.id, observationId, result, recordedBy, notes])).rows[0].id);
  }, (m) => /must be later than the evidence/.test(m) ? 'This finding was recorded after now. Check the clock and try again.'
    : /already has a re-check/.test(m) ? 'A later re-check is already recorded for this finding.' : null);
  const r = (await db.query('SELECT rechecked_at FROM scopely.evidence_rechecks WHERE id = $1', [recheckId])).rows[0];
  return { recheckId, rechecked: new Date(r.rechecked_at).toISOString() };
}

// ------------------------------------------------------------------ 2. contact

export const CONTACT_LABELS = ['VERIFIED', 'PUBLICLY_FOUND', 'UNVERIFIED'] as const;
export const OUTREACH_BASES = ['corporate_subscriber', 'consent', 'not_permitted', 'unknown'] as const;

export interface CaseContactInput {
  fullName?: string | null;
  role?: string | null;
  isDecisionMaker?: boolean | null;
  email?: string | null;
  emailKind?: string | null;
  /** Where the seller got it. Required. */
  source?: string | null;
  sourceUrl?: string | null;
  label?: string | null;
  /** The lawful basis for contacting them. 'unknown' when the seller does not know. */
  outreachBasis?: string | null;
  /** Slice 12: what they are to the business, and what shows it. */
  relationship?: string | null;
  relationshipBasis?: string | null;
  /** Slice 12: required with isDecisionMaker: what was seen that says they decide. */
  decisionMakerBasis?: string | null;
  /** Slice 12: required for VERIFIED (and to raise a provider's person above UNVERIFIED): how it was checked. */
  verificationBasis?: string | null;
  /** Who is recording this; required with a verification. */
  recordedBy?: string | null;
}

export const RELATIONSHIPS = ['owner', 'director', 'partner', 'employee', 'other'] as const;

function contactFields(c: CaseContactInput) {
  const fullName = text(c.fullName, 120);
  const email = text(c.email, 254)?.toLowerCase() ?? null;
  if (!fullName && !email) throw new ProspectRejected(400, 'Enter a name or an email address.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ProspectRejected(400, 'That email address is not valid.');
  const emailKind = text(c.emailKind, 20);
  if (emailKind && !['role', 'personal'].includes(emailKind)) throw new ProspectRejected(400, 'Say whether the address is a role address or a person’s own.');
  if (emailKind && !email) throw new ProspectRejected(400, 'An email kind needs an email address.');
  const source = text(c.source, 120);
  if (!source) throw new ProspectRejected(400, 'Say where you got this contact.');
  const sourceUrl = text(c.sourceUrl, 500);
  if (sourceUrl && !/^https?:\/\/[^\s]+$/i.test(sourceUrl)) throw new ProspectRejected(400, 'The source link must start with http:// or https://.');
  const label = text(c.label, 20);
  if (!label || !(CONTACT_LABELS as readonly string[]).includes(label)) throw new ProspectRejected(400, 'Say how sure you are of this contact.');
  const outreachBasis = text(c.outreachBasis, 30);
  if (!outreachBasis || !(OUTREACH_BASES as readonly string[]).includes(outreachBasis)) {
    throw new ProspectRejected(400, 'Say what lets you contact them, or choose Not known.');
  }
  const relationship = text(c.relationship, 20);
  if (relationship && !(RELATIONSHIPS as readonly string[]).includes(relationship)) throw new ProspectRejected(400, 'Choose their relationship to the business, or Not known.');
  const relationshipBasis = text(c.relationshipBasis, 500);
  if (relationship && !relationshipBasis) throw new ProspectRejected(400, 'Say what shows their relationship to the business.');
  const isDecisionMaker = c.isDecisionMaker === true;
  const decisionMakerBasis = isDecisionMaker ? text(c.decisionMakerBasis, 500) : null;
  if (isDecisionMaker && !decisionMakerBasis) throw new ProspectRejected(400, 'Say what shows they make the decision. Without it, leave Decision maker unticked.');
  const verificationBasis = text(c.verificationBasis, 500);
  const recordedBy = text(c.recordedBy, 120);
  if (label === 'VERIFIED' && !verificationBasis) throw new ProspectRejected(400, 'Say how the business confirmed it. Without it, choose Not verified or Publicly found.');
  if (label === 'VERIFIED' && !recordedBy) throw new ProspectRejected(400, 'Say who is recording this.');
  return {
    fullName: fullName ?? undefined, role: text(c.role, 120) ?? undefined, isDecisionMaker,
    email: email ?? undefined, emailKind: (emailKind ?? undefined) as 'role' | 'personal' | undefined, source, sourceUrl: sourceUrl ?? undefined,
    label: label as (typeof CONTACT_LABELS)[number], outreachBasis: outreachBasis as (typeof OUTREACH_BASES)[number],
    relationship, relationshipBasis: relationship ? relationshipBasis : null, decisionMakerBasis, verificationBasis, recordedBy,
  };
}

/**
 * Adds a contact the seller has to this opportunity's business, or corrects one already recorded.
 * Nothing is looked up or checked against the outside world: mx_ok stays unknown, and the label is
 * the seller's own. Slice 12: a decision maker needs a basis, a relationship needs a basis, VERIFIED
 * says how and by whom. A person a provider returned keeps where it came from (source, provider
 * call): the seller corrects what is on file and can raise its label only by saying how it was checked.
 */
export async function saveCaseContact(db: Db, opportunityId: string, input: CaseContactInput, contactId?: string): Promise<string> {
  const { businessId } = await caseBusiness(db, opportunityId);
  const prior = contactId && /^\d{1,18}$/.test(contactId) ? (await db.query(
    `SELECT label, source, source_url, provider_operation_id, verification_basis, verified_by, verified_at FROM scopely.contacts
      WHERE id = $1 AND business_id = $2 AND workspace_id = scopely.current_workspace_id()`, [contactId, businessId])).rows[0] : undefined;
  if (contactId && !prior) throw new ProspectRejected(404, 'That contact is not on this business.');
  const fromProvider = Boolean(prior?.provider_operation_id);
  const f = contactFields(fromProvider ? { ...input, source: prior.source } : input);
  const raised = f.label !== 'UNVERIFIED' && f.label !== prior?.label;
  if (fromProvider && raised && (!f.verificationBasis || !f.recordedBy)) {
    throw new ProspectRejected(400, 'This person came from a provider. Say who checked them and how before marking them publicly found or verified.');
  }
  // A verification is the recorder's, at the time they record it; an unchanged label keeps the one on file.
  const verification = raised || (f.label === 'VERIFIED' && f.verificationBasis !== prior?.verification_basis)
    ? { basis: f.verificationBasis, by: f.recordedBy, at: new Date().toISOString() }
    : f.label === prior?.label ? { basis: prior?.verification_basis ?? f.verificationBasis, by: prior?.verified_by ?? null, at: prior?.verified_at ?? null }
      : { basis: null, by: null, at: null };
  return guarded(db, async () => {
    if (!contactId) {
      return recordContact(db, { businessId, ...f, relationship: f.relationship as ContactInput['relationship'], verificationBasis: verification.basis,
        verifiedBy: verification.by });
    }
    const r = await db.query(
      `UPDATE scopely.contacts SET full_name = $3, role = $4, is_decision_maker = $5, email = $6, email_kind = $7, source = $8,
              source_url = $9, label = $10, outreach_basis = $11, relationship = $12, relationship_basis = $13, decision_maker_basis = $14,
              verification_basis = $15, verified_by = $16, verified_at = $17
        WHERE id = $1 AND business_id = $2 AND workspace_id = scopely.current_workspace_id() RETURNING id`,
      [contactId, businessId, f.fullName ?? null, f.role ?? null, f.isDecisionMaker, f.email ?? null, f.emailKind ?? null, f.source,
       fromProvider ? prior.source_url : f.sourceUrl ?? null, f.label, f.outreachBasis, f.relationship, f.relationshipBasis, f.decisionMakerBasis,
       verification.basis, verification.by, verification.at]);
    if (!r.rows[0]) throw new ProspectRejected(404, 'That contact is not on this business.');
    return String(r.rows[0].id);
  }, () => null);
}

// ------------------------------------------------------------------ 3. company register facts

/** Companies House vocabulary, which the GB outreach rule (007) reads. 'other' is a type not in this list. */
export const COMPANY_TYPES = ['ltd', 'llp', 'plc', 'private-limited-guarant-nsc', 'private-unlimited', 'sole_trader', 'partnership', 'other'] as const;
export const COMPANY_STATUSES = ['active', 'dissolved', 'liquidation', 'administration', 'receivership', 'voluntary-arrangement',
  'insolvency-proceedings', 'converted-closed'] as const;
export const COMPANY_REGISTERS = ['uk_companies_house', 'other'] as const;
/** Types that are not on a register, so they have no register status or number. */
const UNREGISTERED = ['sole_trader', 'partnership'];

export interface CompanyRegisterInput {
  register?: string | null;
  number?: string | null;
  type?: string | null;
  status?: string | null;
}

/**
 * Records the company register facts the seller looked up, on this opportunity's business. Only what
 * was supplied: nothing is looked up and nothing is inferred. A later entry replaces the earlier one,
 * because a company's status changes.
 */
export async function recordCompanyRegister(db: Db, opportunityId: string, input: CompanyRegisterInput): Promise<void> {
  const { businessId } = await caseBusiness(db, opportunityId);
  const type = text(input.type, 40)?.toLowerCase() ?? null;
  if (!type || !(COMPANY_TYPES as readonly string[]).includes(type)) throw new ProspectRejected(400, 'Choose the company type from the register.');
  const unregistered = UNREGISTERED.includes(type);
  const status = text(input.status, 40)?.toLowerCase() ?? null;
  if (unregistered && status) throw new ProspectRejected(400, 'A sole trader or partnership has no register status.');
  if (!unregistered && (!status || !(COMPANY_STATUSES as readonly string[]).includes(status))) throw new ProspectRejected(400, 'Choose the company status from the register.');
  const register = text(input.register, 40) ?? null;
  if (register && !(COMPANY_REGISTERS as readonly string[]).includes(register)) throw new ProspectRejected(400, 'Choose the register.');
  const number = text(input.number, 20)?.toUpperCase().replace(/\s+/g, '') ?? null;
  if (number && !/^[A-Z0-9]{1,20}$/.test(number)) throw new ProspectRejected(400, 'A company number has letters and digits only.');
  if (number && !register) throw new ProspectRejected(400, 'Say which register the number is from.');
  if (unregistered && (number || register)) throw new ProspectRejected(400, 'A sole trader or partnership has no register number.');
  await guarded(db, () => db.query(
    `UPDATE scopely.businesses SET company_register = $2, company_number = $3, company_type = $4, company_status = $5
      WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [businessId, register, number, type, status]),
  (m, code) => code === '23505' && /register/.test(m) ? 'Another business in your workspace already has that company number.' : null);
}

// ------------------------------------------------------------------ 4. suppression

export interface CaseSuppressionInput {
  /** What to stop contacting: one contact's email address, the business's domain, or the business. */
  target: string;
  /** For target 'email': the contact whose address it is. */
  contactId?: string | null;
  reason: string;
}

/**
 * Adds this opportunity's business, its domain, or one of its contacts' email address to the
 * workspace's suppression list. The target always comes from stored rows of this opportunity; a
 * request cannot name an arbitrary address or another workspace's business.
 */
export async function suppressFromCaseFile(db: Db, opportunityId: string, input: CaseSuppressionInput): Promise<string> {
  const { businessId, domain } = await caseBusiness(db, opportunityId);
  const reason = String(input.reason ?? '');
  if (!(SUPPRESSION_REASONS as readonly string[]).includes(reason)) throw new ProspectRejected(400, 'Say why they should not be contacted.');
  const r = reason as (typeof SUPPRESSION_REASONS)[number];
  if (input.target === 'business') return guarded(db, () => recordSuppression(db, { businessId, reason: r }), () => null);
  if (input.target === 'domain') {
    if (!domain) throw new ProspectRejected(409, 'This business has no domain on record.');
    return guarded(db, () => recordSuppression(db, { domain, reason: r }), () => null);
  }
  if (input.target === 'email') {
    const c = /^\d{1,18}$/.test(String(input.contactId ?? '')) ? (await db.query(
      `SELECT email FROM scopely.contacts WHERE id = $1 AND business_id = $2 AND workspace_id = scopely.current_workspace_id()`,
      [input.contactId, businessId])).rows[0] : undefined;
    if (!c) throw new ProspectRejected(404, 'That contact is not on this business.');
    if (!c.email) throw new ProspectRejected(409, 'That contact has no email address.');
    return guarded(db, () => recordSuppression(db, { email: c.email, reason: r }), () => null);
  }
  throw new ProspectRejected(400, 'Choose what to stop contacting: this email address, the domain, or the whole business.');
}

// ------------------------------------------------------------------ 5. contact facts (Slice 12)

export interface CaseFactInput {
  /** The person it is about, or null for the business's own channel. */
  contactId?: string | null;
  kind: string;
  value: string;
  /** Where the seller saw it. Required: a fact a person records is one they saw somewhere. */
  sourceUrl?: string | null;
  /** How sure: UNVERIFIED, PUBLICLY_FOUND (seen on the source page) or VERIFIED (the business confirmed it). */
  label?: string | null;
  /** For VERIFIED: how the business confirmed it. */
  basis?: string | null;
  recordedBy: string;
}

/**
 * Records a channel the seller found for this business or one of its people: a phone, WhatsApp,
 * email, LinkedIn, Instagram or X profile, or a contact page. The value is normalized (never
 * repaired into something else); the source page is required; PUBLICLY_FOUND means the seller saw it
 * there, VERIFIED needs how the business confirmed it.
 */
export async function recordCaseFact(db: Db, opportunityId: string, input: CaseFactInput): Promise<string> {
  const { businessId } = await caseBusiness(db, opportunityId);
  const kind = String(input.kind ?? '');
  if (!(FACT_KINDS as readonly string[]).includes(kind) || kind === 'title') throw new ProspectRejected(400, 'Choose what kind of channel this is.');
  const value = normalizeFact(kind, input.value);
  if (!value) throw new ProspectRejected(400, kind === 'email' ? 'That email address is not valid.' : kind === 'phone' || kind === 'whatsapp'
    ? 'That is not a phone number. Use digits, with + and the country code if you have it.' : 'That link is not a profile or page of that kind.');
  const sourceUrl = input.sourceUrl ? normalizeFact('contact_page', input.sourceUrl) : null;
  if (!sourceUrl) throw new ProspectRejected(400, 'Add the link to the page where you found it.');
  const recordedBy = text(input.recordedBy, 120);
  if (!recordedBy) throw new ProspectRejected(400, 'Say who is recording this.');
  const label = text(input.label, 20) ?? 'PUBLICLY_FOUND';
  if (!(CONTACT_LABELS as readonly string[]).includes(label)) throw new ProspectRejected(400, 'Say how sure you are of it.');
  const basis = text(input.basis, 500);
  if (label === 'VERIFIED' && !basis) throw new ProspectRejected(400, 'Say how the business confirmed it.');
  let contactId: string | null = null;
  if (input.contactId) {
    const c = /^\d{1,18}$/.test(String(input.contactId)) ? (await db.query(
      `SELECT id FROM scopely.contacts WHERE id = $1 AND business_id = $2 AND workspace_id = scopely.current_workspace_id()`,
      [input.contactId, businessId])).rows[0] : undefined;
    if (!c) throw new ProspectRejected(404, 'That contact is not on this business.');
    contactId = String(c.id);
  }
  const raised = label !== 'UNVERIFIED';
  return guarded(db, async () => {
    const r = await db.query(
      `INSERT INTO scopely.contact_facts (business_id, contact_id, kind, value, source, source_url, observed_at, label, recorded_by,
         verification_basis, verified_by, verified_at)
       VALUES ($1, $2, $3, $4, 'seller', $5, now(), $6, $7, $8, $9, $10)
       ON CONFLICT (workspace_id, business_id, coalesce(contact_id, 0), kind, lower(value), lower(source)) DO NOTHING RETURNING id`,
      [businessId, contactId, kind, value, sourceUrl, label, recordedBy, raised ? basis ?? `Seen on ${sourceUrl}` : null,
       raised ? recordedBy : null, raised ? new Date().toISOString() : null]);
    if (!r.rows[0]) throw new ProspectRejected(409, 'You have already recorded that.');
    return String(r.rows[0].id);
  }, () => null);
}

/**
 * A person's check of a fact on file (a provider's or their own): PUBLICLY_FOUND when they saw it on
 * a public page (the basis names it), VERIFIED when the business confirmed it (the basis says how),
 * UNVERIFIED to withdraw an earlier check. The fact's value and source never change.
 */
export async function checkCaseFact(db: Db, opportunityId: string, factId: string, input: { label: string; basis?: string | null; recordedBy: string }): Promise<void> {
  const { businessId } = await caseBusiness(db, opportunityId);
  if (!/^\d{1,18}$/.test(factId)) throw new ProspectRejected(404, 'That is not on this business.');
  const label = String(input.label ?? '');
  if (!(CONTACT_LABELS as readonly string[]).includes(label)) throw new ProspectRejected(400, 'Say how sure you are of it.');
  const recordedBy = text(input.recordedBy, 120);
  if (!recordedBy) throw new ProspectRejected(400, 'Say who is recording this.');
  const basis = text(input.basis, 500);
  if (label !== 'UNVERIFIED' && !basis) {
    throw new ProspectRejected(400, label === 'VERIFIED' ? 'Say how the business confirmed it.' : 'Add the public page where you saw it.');
  }
  await guarded(db, async () => {
    const r = await db.query(
      `UPDATE scopely.contact_facts SET label = $3, verification_basis = $4, verified_by = $5, verified_at = $6
        WHERE id = $1 AND business_id = $2 AND workspace_id = scopely.current_workspace_id() RETURNING id`,
      [factId, businessId, label, label === 'UNVERIFIED' ? null : basis, label === 'UNVERIFIED' ? null : recordedBy,
       label === 'UNVERIFIED' ? null : new Date().toISOString()]);
    if (!r.rows[0]) throw new ProspectRejected(404, 'That is not on this business.');
  }, () => null);
}

const LABEL_RANK: Record<string, number> = { UNVERIFIED: 0, PUBLICLY_FOUND: 1, VERIFIED: 2 };

/**
 * Makes an email fact the person's email of record: the address the outreach gate checks. The fact
 * must be about this person or the business itself. The contact's label never ends up stronger than
 * the fact's: adopting an unverified address makes the contact unverified.
 */
export async function useFactAsEmail(db: Db, opportunityId: string, contactId: string, factId: string): Promise<void> {
  const { businessId } = await caseBusiness(db, opportunityId);
  if (!/^\d{1,18}$/.test(contactId) || !/^\d{1,18}$/.test(factId)) throw new ProspectRejected(404, 'That is not on this business.');
  const row = (await db.query(
    `SELECT f.value, f.label AS fact_label, c.label AS contact_label, c.email FROM scopely.contact_facts f
       JOIN scopely.contacts c ON c.id = $2 AND c.business_id = f.business_id AND c.workspace_id = scopely.current_workspace_id()
      WHERE f.id = $1 AND f.business_id = $3 AND f.kind = 'email' AND f.workspace_id = scopely.current_workspace_id()
        AND (f.contact_id IS NULL OR f.contact_id = c.id)`, [factId, contactId, businessId])).rows[0];
  if (!row) throw new ProspectRejected(404, 'That address is not on this person or business.');
  const label = LABEL_RANK[row.fact_label]! < LABEL_RANK[row.contact_label]! ? row.fact_label : row.contact_label;
  await guarded(db, () => db.query(
    `UPDATE scopely.contacts SET email = $2, email_kind = CASE WHEN email IS DISTINCT FROM $2 THEN NULL ELSE email_kind END, label = $3,
            verification_basis = CASE WHEN $3 = label THEN verification_basis ELSE NULL END,
            verified_by = CASE WHEN $3 = label THEN verified_by ELSE NULL END, verified_at = CASE WHEN $3 = label THEN verified_at ELSE NULL END
      WHERE id = $1`, [contactId, row.value, label]), () => null);
}
