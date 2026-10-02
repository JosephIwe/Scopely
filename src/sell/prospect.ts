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
import { SUPPRESSION_REASONS, recordContact, recordSuppression } from '../record/index.js';
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
}

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
  return {
    fullName: fullName ?? undefined, role: text(c.role, 120) ?? undefined, isDecisionMaker: c.isDecisionMaker === true,
    email: email ?? undefined, emailKind: (emailKind ?? undefined) as 'role' | 'personal' | undefined, source, sourceUrl: sourceUrl ?? undefined,
    label: label as (typeof CONTACT_LABELS)[number], outreachBasis: outreachBasis as (typeof OUTREACH_BASES)[number],
  };
}

/**
 * Adds a contact the seller has to this opportunity's business, or corrects one already recorded.
 * Nothing is looked up or checked against the outside world: mx_ok stays unknown, and the label is
 * the seller's own (Scopely never marks a contact verified).
 */
export async function saveCaseContact(db: Db, opportunityId: string, input: CaseContactInput, contactId?: string): Promise<string> {
  const { businessId } = await caseBusiness(db, opportunityId);
  const f = contactFields(input);
  return guarded(db, async () => {
    if (!contactId) return recordContact(db, { businessId, ...f });
    const r = await db.query(
      `UPDATE scopely.contacts SET full_name = $3, role = $4, is_decision_maker = $5, email = $6, email_kind = $7, source = $8,
              source_url = $9, label = $10, outreach_basis = $11
        WHERE id = $1 AND business_id = $2 AND workspace_id = scopely.current_workspace_id() RETURNING id`,
      [contactId, businessId, f.fullName ?? null, f.role ?? null, f.isDecisionMaker, f.email ?? null, f.emailKind ?? null, f.source,
       f.sourceUrl ?? null, f.label, f.outreachBasis]);
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
