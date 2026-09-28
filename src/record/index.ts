// Manual recording for the 20-30 prospect validation test. Each function writes one step of
// FIND -> evidence -> opportunity -> SELL -> outcome through the same tables and guards that
// automated slices will use later, so manual rows and machine rows are indistinguishable.
//
// Functions do not open or commit transactions: the caller owns the transaction (the CLI wraps
// each command in one; tests roll back). The database is the judge of every Truth Rule; these
// helpers only resolve keys to ids and refuse obviously malformed input early.
import type pg from 'pg';

type Db = pg.Client | pg.PoolClient;

async function one<T>(db: Db, sql: string, params: unknown[]): Promise<T> {
  const r = await db.query(sql, params);
  if (r.rows.length !== 1) throw new Error(`expected one row, got ${r.rows.length}`);
  return r.rows[0] as T;
}

export async function ruleVersionId(db: Db, ruleKey: string, version = 1): Promise<string> {
  return (await one<{ id: string }>(db,
    'SELECT id FROM scopely.rule_versions WHERE rule_key = $1 AND version = $2', [ruleKey, version])).id;
}

// ------------------------------------------------------------------ FIND

export interface ProspectInput {
  marketId: string;
  name: string;
  domain?: string;
  websiteUrl?: string;
  vertical?: string;
  subvertical?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  postalCode?: string;
  companyNumber?: string;
  companyRegister?: string;
  companyType?: string;
  companyStatus?: string;
  independence?: 'independent' | 'group' | 'chain' | 'unknown';
  source: { kind: string; ref: string };
}

export async function recordProspect(db: Db, p: ProspectInput): Promise<{ businessId: string; sourceId: string }> {
  const b = await one<{ id: string }>(db,
    `INSERT INTO scopely.businesses (market_id, name, domain, website_url, vertical, subvertical, country_code, region, city,
       postal_code, company_number, company_register, company_type, company_status, independence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [p.marketId, p.name, p.domain?.toLowerCase() ?? null, p.websiteUrl ?? null, p.vertical ?? null, p.subvertical ?? null,
     p.countryCode ?? null, p.region ?? null, p.city ?? null, p.postalCode ?? null, p.companyNumber ?? null,
     p.companyRegister ?? null, p.companyType ?? null, p.companyStatus ?? null, p.independence ?? null]);
  const s = await one<{ id: string }>(db,
    'INSERT INTO scopely.sources (business_id, kind, ref) VALUES ($1,$2,$3) RETURNING id', [b.id, p.source.kind, p.source.ref]);
  return { businessId: b.id, sourceId: s.id };
}

export async function qualifyBusiness(db: Db, businessId: string): Promise<void> {
  await db.query(`UPDATE scopely.businesses SET qualification_status = 'QUALIFIED' WHERE id = $1`, [businessId]);
}

export interface RejectionInput {
  category: string;
  reason: string;
  stage: string;
  ruleKey: string;
  ruleVersion?: number;
  rejectedAt: string;
}

export async function rejectBusiness(db: Db, businessId: string, r: RejectionInput): Promise<void> {
  const rule = await ruleVersionId(db, r.ruleKey, r.ruleVersion);
  await db.query(
    `UPDATE scopely.businesses SET qualification_status = 'REJECTED', rejection_category = $2, rejection_reason = $3,
       rejection_stage = $4, rejection_rule_version_id = $5, rejected_at = $6 WHERE id = $1`,
    [businessId, r.category, r.reason, r.stage, rule, r.rejectedAt]);
}

export interface SnapshotInput {
  businessId: string;
  url: string;
  fetchedAt: string;
  fetchMethod: 'http' | 'render' | 'manual';
  finalUrl?: string;
  httpStatus?: number;
  viewport?: 'desktop' | 'mobile';
  htmlSha256?: string;
  htmlRef?: string;
  screenshotRef?: string;
}

export async function recordSnapshot(db: Db, s: SnapshotInput): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.snapshots (business_id, url, final_url, http_status, fetched_at, fetch_method, viewport,
       html_sha256, html_ref, screenshot_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [s.businessId, s.url, s.finalUrl ?? null, s.httpStatus ?? null, s.fetchedAt, s.fetchMethod, s.viewport ?? null,
     s.htmlSha256 ?? null, s.htmlRef ?? null, s.screenshotRef ?? null])).id;
}

// ------------------------------------------------------------------ observation and evidence

export type ObservationState = 'OBSERVED' | 'INFERRED' | 'NOT_OBSERVABLE';

export interface FindingInput {
  snapshotId: string;
  ruleKey: string;
  ruleVersion?: number;
  checkCode: string;
  state: ObservationState;
  /** Required unless state is NOT_OBSERVABLE, and must be absent when it is. */
  result?: 'ok' | 'gap' | 'defect' | 'n/a';
  selector?: string;
  href?: string;
  visibleText?: string;
  inferredFrom?: string[];
  /** Only for a gap or defect that is OBSERVED or INFERRED. */
  evidence?: {
    issueCode: string;
    claimState: 'OBSERVED' | 'INFERRED';
    plainIssue: string;
    url: string;
    quote: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  };
}

export async function recordFinding(db: Db, f: FindingInput): Promise<{ observationId: string; evidenceId: string | null }> {
  if (f.state === 'NOT_OBSERVABLE' && (f.result !== undefined || f.evidence)) {
    throw new Error('a NOT_OBSERVABLE observation has no result and never becomes evidence');
  }
  const rule = await ruleVersionId(db, f.ruleKey, f.ruleVersion);
  const o = await one<{ id: string; business_id: string }>(db,
    `INSERT INTO scopely.observations (snapshot_id, check_code, rule_version_id, state, result, selector, href, visible_text,
       inferred_from, observed_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9, s.fetched_at FROM scopely.snapshots s WHERE s.id = $1
     RETURNING id, (SELECT business_id FROM scopely.snapshots WHERE id = $1) AS business_id`,
    [f.snapshotId, f.checkCode, rule, f.state, f.result ?? null, f.selector ?? null, f.href ?? null, f.visibleText ?? null,
     f.inferredFrom ?? null]);
  if (!f.evidence) return { observationId: o.id, evidenceId: null };
  const e = f.evidence;
  // observed_at is left NULL so the database derives it from the snapshot.
  const ev = await one<{ id: string }>(db,
    `INSERT INTO scopely.evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [o.business_id, o.id, e.issueCode, rule, e.claimState, e.plainIssue, e.url, e.quote, e.confidence]);
  return { observationId: o.id, evidenceId: ev.id };
}

export interface RecheckInput {
  evidenceId: string;
  snapshotId: string;
  observationId?: string;
  result: 'confirmed' | 'changed' | 'gone';
  recordedBy: string;
  notes?: string;
}

export async function recordRecheck(db: Db, r: RecheckInput): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [r.evidenceId, r.snapshotId, r.observationId ?? null, r.result, r.recordedBy, r.notes ?? null])).id;
}

// ------------------------------------------------------------------ opportunity

export interface OpportunityInput {
  businessId: string;
  marketId?: string;
  opportunityType: string;
  evidenceIds: string[];
  /** A catalog item key, or null with unmappedReason. */
  catalogKey: string | null;
  unmappedReason?: string;
  servicePrice?: number;
  currency?: string;
  whyItMatters?: string;
  notObservableNotes?: string;
  /** The search run whose analysis found it; the business must be analysed in that run. */
  searchRunId?: string;
}

export async function recordOpportunity(db: Db, o: OpportunityInput): Promise<string> {
  if (!Array.isArray(o.evidenceIds) || o.evidenceIds.length === 0) throw new Error('an opportunity needs at least one evidence record');
  const opp = await one<{ id: string }>(db,
    `INSERT INTO scopely.opportunities (business_id, market_id, opportunity_type, mapping_status, catalog_item_id, unmapped_reason,
       service_price, currency, why_it_matters, not_observable_notes, search_run_id)
     VALUES ($1, $2, $3, CASE WHEN $4::text IS NULL THEN 'UNMAPPED' ELSE 'MAPPED' END,
             -- the workspace's own item wins over a shared starter with the same key
             (SELECT id FROM scopely.catalog_items WHERE key = $4::text
                 AND (workspace_id = scopely.current_workspace_id() OR workspace_id IS NULL)
               ORDER BY workspace_id NULLS LAST LIMIT 1), $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [o.businessId, o.marketId ?? null, o.opportunityType, o.catalogKey, o.unmappedReason ?? null,
     o.servicePrice ?? null, o.currency ?? null, o.whyItMatters ?? null, o.notObservableNotes ?? null, o.searchRunId ?? null]);
  for (const e of o.evidenceIds) {
    await db.query('INSERT INTO scopely.opportunity_evidence (opportunity_id, evidence_id) VALUES ($1,$2)', [opp.id, e]);
  }
  return opp.id;
}

// ------------------------------------------------------------------ SELL

export interface ContactInput {
  businessId: string;
  fullName?: string;
  role?: string;
  isDecisionMaker?: boolean;
  email?: string;
  emailKind?: 'role' | 'personal';
  source: string;
  sourceUrl?: string;
  label: 'VERIFIED' | 'PUBLICLY_FOUND' | 'UNVERIFIED';
  mxOk?: boolean;
  outreachBasis: 'corporate_subscriber' | 'consent' | 'not_permitted' | 'unknown';
}

export async function recordContact(db: Db, c: ContactInput): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.contacts (business_id, full_name, role, is_decision_maker, email, email_kind, source, source_url, label,
       mx_ok, outreach_basis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [c.businessId, c.fullName ?? null, c.role ?? null, c.isDecisionMaker ?? false, c.email ?? null, c.emailKind ?? null,
     c.source, c.sourceUrl ?? null, c.label, c.mxOk ?? null, c.outreachBasis])).id;
}

export interface MessageInput {
  opportunityId: string;
  contactId: string;
  step?: number;
  subject: string;
  body: string;
  evidenceIds: string[];
  generator?: string;
  /** The workspace mailbox it will be sent from. Required before it can be marked sent. */
  mailboxConnectionId?: string;
}

export async function recordMessage(db: Db, m: MessageInput): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator, mailbox_connection_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [m.opportunityId, m.contactId, m.step ?? 0, m.subject, m.body, m.evidenceIds, m.generator ?? 'operator',
     m.mailboxConnectionId ?? null])).id;
}

export async function approveMessage(db: Db, messageId: string, approvedBy: string, approvedAt: string): Promise<void> {
  await db.query(
    `UPDATE scopely.messages SET approval_status = 'approved', approved_by = $2, approved_at = $3 WHERE id = $1`,
    [messageId, approvedBy, approvedAt]);
}

/**
 * Records that an approved message was sent by hand from a workspace mailbox. Scopely itself
 * sends nothing. The sender address is captured from the mailbox, never supplied.
 */
export async function markMessageSent(db: Db, messageId: string, sentAt: string, mailboxConnectionId?: string): Promise<void> {
  await db.query('UPDATE scopely.messages SET sent_at = $2, mailbox_connection_id = coalesce($3, mailbox_connection_id) WHERE id = $1',
    [messageId, sentAt, mailboxConnectionId ?? null]);
}

export interface OutcomeInput {
  opportunityId: string;
  kind: 'pitched' | 'replied' | 'call' | 'won' | 'lost' | 'delivered' | 'voided';
  occurredAt: string;
  recordedBy: string;
  channel?: string;
  replyClass?: string;
  amount?: number;
  currency?: string;
  deliveredBy?: 'operator' | 'client';
  clientConfirmed?: boolean;
  messageId?: string;
  correctsOutcomeId?: string;
  notes?: string;
}

export async function recordOutcome(db: Db, o: OutcomeInput): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.outcomes (opportunity_id, kind, occurred_at, channel, reply_class, amount, currency, delivered_by,
       client_confirmed, message_id, corrects_outcome_id, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [o.opportunityId, o.kind, o.occurredAt, o.channel ?? null, o.replyClass ?? null, o.amount ?? null, o.currency ?? null,
     o.deliveredBy ?? null, o.clientConfirmed ?? null, o.messageId ?? null, o.correctsOutcomeId ?? null, o.notes ?? null,
     o.recordedBy])).id;
}

export interface CostInput {
  businessId?: string;
  opportunityId?: string;
  buildId?: string;
  kind: string;
  minutes?: number;
  amount?: number;
  currency?: string;
  occurredAt?: string;
}

/** A cost with an unknown amount is recorded with amount NULL, never 0. */
export async function recordCost(db: Db, c: CostInput): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.cost_events (business_id, opportunity_id, build_id, kind, minutes, amount, currency, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz, now())) RETURNING id`,
    [c.businessId ?? null, c.opportunityId ?? null, c.buildId ?? null, c.kind, c.minutes ?? null, c.amount ?? null,
     c.currency ?? null, c.occurredAt ?? null])).id;
}
