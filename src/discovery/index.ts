// DISCOVER -> PRE-QUALIFY -> SELECT -> ANALYZE, inside one workspace.
//
// A search run records every business a discovery source returned (DISCOVERED), pre-qualifies
// them from firmographics alone (QUALIFIED / REJECTED / NEEDS_REVIEW), lets the seller select the
// ones worth analysing within the run's limits (SELECTED), and only then queues analysis
// (ANALYSIS_QUEUED) against its credit budget. The database enforces every transition, the
// selection cap and the budget; these functions only prepare the rows.
//
// Discovery providers plug in through DiscoverySource. None is implemented: Clay, business
// directories, public datasets and CSV imports are all future sources behind this one interface,
// and recordDiscoveredBusiness is how any of them (or a person) records what it found.
import type { Db } from '../tenancy/index.js';
import { criteriaFromRow, type SearchCriteria } from './criteria.js';
import { prequalify, type BusinessFacts, type QualificationResult, type WebsiteStatus } from './qualify.js';

export { createSearch, criteriaFromRow, type SearchCriteria, type SearchInput } from './criteria.js';
export { prequalify, rangeVerdict, haversineKm, STAGES, type Stage, type QualificationResult, type BusinessFacts } from './qualify.js';

export type Basis = 'VERIFIED' | 'REPORTED' | 'ESTIMATED';

/** A business as a discovery source reports it. Every field it does not know stays out. */
export interface DiscoveredBusiness {
  source: { provider: string; sourceType: string; reference: string; discoveredAt?: string };
  name: string;
  domain?: string;
  websiteUrl?: string;
  phone?: string;
  vertical?: string;
  subvertical?: string;
  specialty?: string;
  addressLine?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  geo?: { latitude: number; longitude: number; source: string };
  companyRegister?: string;
  companyNumber?: string;
  companyType?: string;
  companyStatus?: string;
  incorporatedOn?: string;
  independence?: 'independent' | 'franchise' | 'group' | 'chain' | 'unknown';
  employees?: { count?: number; min?: number; max?: number; basis: Basis; source: string; asOf: string };
  revenue?: { amount?: number; min?: number; max?: number; currency: string; basis: Basis; source: string; asOf: string };
  reviews?: { count?: number; rating?: number; source: string; asOf: string };
}

export interface DiscoverySource {
  provider: string;
  sourceType: 'api' | 'directory' | 'dataset' | 'csv_import' | 'register' | 'manual';
  discover(criteria: SearchCriteria, limit: number | null): AsyncIterable<DiscoveredBusiness>;
}

export class DiscoveryRegistry {
  private readonly sources = new Map<string, DiscoverySource>();
  register(s: DiscoverySource): void {
    if (this.sources.has(s.provider)) throw new Error(`a discovery source for ${s.provider} is already registered`);
    this.sources.set(s.provider, s);
  }
  get(provider: string): DiscoverySource {
    const s = this.sources.get(provider);
    if (!s) throw new Error(`no discovery source is available for ${provider}`);
    return s;
  }
  providers(): string[] { return [...this.sources.keys()].sort(); }
}

// ------------------------------------------------------------------ runs

export async function startSearchRun(db: Db, searchId: string, startedByUserId?: string): Promise<string> {
  return (await db.query<{ id: string }>(
    'INSERT INTO scopely.search_runs (search_id, criteria, started_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [searchId, '{}', startedByUserId ?? null])).rows[0]!.id;   // criteria is frozen from the search by the database
}

export async function completeSearchRun(db: Db, runId: string, at: string, status: 'COMPLETED' | 'CANCELLED' = 'COMPLETED'): Promise<void> {
  await db.query('UPDATE scopely.search_runs SET status = $2, completed_at = $3 WHERE id = $1', [runId, status, at]);
}

/** Pulls from a registered source into the run, up to the run's discovery limit. */
export async function runDiscovery(db: Db, registry: DiscoveryRegistry, runId: string, provider: string): Promise<number> {
  // Another workspace's run reads as missing, so its criteria never reach this workspace's provider.
  const run = (await db.query(`SELECT criteria, max_discovered_per_run FROM scopely.search_runs
                                WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [runId])).rows[0];
  if (!run) throw new Error(`search run ${runId} does not exist in this workspace`);
  let n = 0;
  for await (const d of registry.get(provider).discover(criteriaFromRow(run.criteria), run.max_discovered_per_run)) {
    await recordDiscoveredBusiness(db, runId, d);
    n += 1;
  }
  return n;
}

export interface DiscoveryRecord {
  businessId: string;
  runBusinessId: string;
  /** How the business was recognised: a new one, or an existing one of this workspace. */
  matchedBy: 'new' | 'company_register' | 'domain' | 'source_reference';
}

/**
 * Records one discovered business in a run. A business is one row per workspace: a business
 * already known to this workspace (same company number, then same domain, then same source
 * reference) is reused and gains a new source and run membership, so it can sit in many searches.
 * Known values are never overwritten by a later discovery; a firmographic group is only filled
 * when the business has none.
 */
export async function recordDiscoveredBusiness(db: Db, runId: string, d: DiscoveredBusiness): Promise<DiscoveryRecord> {
  const domain = d.domain?.trim().toLowerCase() || null;
  let existing: { id: string; matchedBy: DiscoveryRecord['matchedBy'] } | null = null;
  if (d.companyRegister && d.companyNumber) {
    const r = await db.query<{ id: string }>(`SELECT id FROM scopely.businesses WHERE workspace_id = scopely.current_workspace_id()
      AND company_register = $1 AND company_number = $2`, [d.companyRegister, d.companyNumber]);
    if (r.rows[0]) existing = { id: r.rows[0].id, matchedBy: 'company_register' };
  }
  if (!existing && domain) {
    const r = await db.query<{ id: string }>(`SELECT id FROM scopely.businesses WHERE workspace_id = scopely.current_workspace_id()
      AND lower(domain) = $1 ORDER BY id LIMIT 1`, [domain]);
    if (r.rows[0]) existing = { id: r.rows[0].id, matchedBy: 'domain' };
  }
  if (!existing) {
    const r = await db.query<{ id: string }>(`SELECT business_id AS id FROM scopely.sources WHERE workspace_id = scopely.current_workspace_id()
      AND provider = $1 AND ref = $2 ORDER BY id LIMIT 1`, [d.source.provider, d.source.reference]);
    if (r.rows[0]) existing = { id: r.rows[0].id, matchedBy: 'source_reference' };
  }

  const e = d.employees, rv = d.revenue, rw = d.reviews;
  let businessId: string;
  if (existing) {
    businessId = existing.id;
    await db.query(
      `UPDATE scopely.businesses SET
         employee_count     = CASE WHEN employees_basis IS NULL THEN $2::int ELSE employee_count END,
         employee_count_min = CASE WHEN employees_basis IS NULL THEN $3::int ELSE employee_count_min END,
         employee_count_max = CASE WHEN employees_basis IS NULL THEN $4::int ELSE employee_count_max END,
         employees_source   = CASE WHEN employees_basis IS NULL THEN $6 ELSE employees_source END,
         employees_as_of    = CASE WHEN employees_basis IS NULL THEN $7::timestamptz ELSE employees_as_of END,
         employees_basis    = coalesce(employees_basis, $5),
         revenue_amount     = CASE WHEN revenue_basis IS NULL THEN $8::numeric ELSE revenue_amount END,
         revenue_min        = CASE WHEN revenue_basis IS NULL THEN $9::numeric ELSE revenue_min END,
         revenue_max        = CASE WHEN revenue_basis IS NULL THEN $10::numeric ELSE revenue_max END,
         revenue_currency   = CASE WHEN revenue_basis IS NULL THEN $11 ELSE revenue_currency END,
         revenue_source     = CASE WHEN revenue_basis IS NULL THEN $13 ELSE revenue_source END,
         revenue_as_of      = CASE WHEN revenue_basis IS NULL THEN $14::timestamptz ELSE revenue_as_of END,
         revenue_basis      = coalesce(revenue_basis, $12),
         latitude    = coalesce(latitude, $15), longitude = coalesce(longitude, $16),
         geo_source  = CASE WHEN latitude IS NULL THEN $17 ELSE geo_source END
       WHERE id = $1`,
      [businessId, e?.count ?? null, e?.min ?? null, e?.max ?? null, e?.basis ?? null, e?.source ?? null, e?.asOf ?? null,
       rv?.amount ?? null, rv?.min ?? null, rv?.max ?? null, rv?.currency ?? null, rv?.basis ?? null, rv?.source ?? null,
       rv?.asOf ?? null, d.geo?.latitude ?? null, d.geo?.longitude ?? null, d.geo?.source ?? null]);
  } else {
    businessId = (await db.query<{ id: string }>(
      `INSERT INTO scopely.businesses (name, domain, website_url, phone, vertical, subvertical, specialty, address_line, city, region,
         postal_code, country_code, latitude, longitude, geo_source, company_register, company_number, company_type, company_status,
         incorporated_on, independence,
         employee_count, employee_count_min, employee_count_max, employees_basis, employees_source, employees_as_of,
         revenue_amount, revenue_min, revenue_max, revenue_currency, revenue_basis, revenue_source, revenue_as_of,
         review_count, rating, reviews_source, reviews_as_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
               $33,$34,$35,$36,$37,$38) RETURNING id`,
      [d.name, domain, d.websiteUrl ?? null, d.phone ?? null, d.vertical ?? null, d.subvertical ?? null, d.specialty ?? null,
       d.addressLine ?? null, d.city ?? null, d.region ?? null, d.postalCode ?? null, d.countryCode ?? null,
       d.geo?.latitude ?? null, d.geo?.longitude ?? null, d.geo?.source ?? null, d.companyRegister ?? null, d.companyNumber ?? null,
       d.companyType ?? null, d.companyStatus ?? null, d.incorporatedOn ?? null, d.independence ?? null,
       e?.count ?? null, e?.min ?? null, e?.max ?? null, e?.basis ?? null, e?.source ?? null, e?.asOf ?? null,
       rv?.amount ?? null, rv?.min ?? null, rv?.max ?? null, rv?.currency ?? null, rv?.basis ?? null, rv?.source ?? null, rv?.asOf ?? null,
       rw?.count ?? null, rw?.rating ?? null, rw?.source ?? null, rw?.asOf ?? null])).rows[0]!.id;
  }

  const sourceId = (await db.query<{ id: string }>(
    `INSERT INTO scopely.sources (business_id, kind, ref, provider, search_run_id, found_at)
     VALUES ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now())) RETURNING id`,
    [businessId, d.source.sourceType, d.source.reference, d.source.provider, runId, d.source.discoveredAt ?? null])).rows[0]!.id;
  const member = await db.query<{ id: string }>(
    `INSERT INTO scopely.search_run_businesses (search_run_id, business_id, source_id, discovered_at)
     VALUES ($1, $2, $3, coalesce($4::timestamptz, now()))
     ON CONFLICT (search_run_id, business_id) DO NOTHING RETURNING id`,
    [runId, businessId, sourceId, d.source.discoveredAt ?? null]);
  const runBusinessId = member.rows[0]?.id ?? (await db.query<{ id: string }>(
    'SELECT id FROM scopely.search_run_businesses WHERE search_run_id = $1 AND business_id = $2', [runId, businessId])).rows[0]!.id;
  return { businessId, runBusinessId, matchedBy: existing?.matchedBy ?? 'new' };
}

// ------------------------------------------------------------------ pre-qualification

/** Facts for every DISCOVERED business in the run, from this workspace's own records only. */
export async function loadQualificationFacts(db: Db, runId: string): Promise<Map<string, BusinessFacts>> {
  const r = await db.query(
    `SELECT rb.id AS run_business_id, b.*,
            EXISTS (SELECT 1 FROM scopely.contacts c WHERE c.business_id = b.id AND c.email IS NOT NULL
                     AND c.label IN ('VERIFIED','PUBLICLY_FOUND')) AS has_public_email,
            (EXISTS (SELECT 1 FROM scopely.search_run_businesses o WHERE o.business_id = b.id AND o.search_run_id <> rb.search_run_id
                      AND o.state IN ('ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY'))
             OR EXISTS (SELECT 1 FROM scopely.snapshots s WHERE s.business_id = b.id)) AS analyzed_before,
            EXISTS (SELECT 1 FROM scopely.messages m JOIN scopely.opportunities op ON op.id = m.opportunity_id
                     WHERE op.business_id = b.id AND m.sent_at IS NOT NULL) AS contacted,
            EXISTS (SELECT 1 FROM scopely.opportunities op WHERE op.business_id = b.id AND op.delivered_at IS NOT NULL) AS existing_client,
            EXISTS (SELECT 1 FROM scopely.opportunities op WHERE op.business_id = b.id AND op.won_at IS NOT NULL) AS won,
            EXISTS (SELECT 1 FROM scopely.opportunities op WHERE op.business_id = b.id AND op.lost_at IS NOT NULL) AS lost,
            EXISTS (SELECT 1 FROM scopely.suppression s WHERE s.workspace_id = b.workspace_id
                     AND (s.business_id = b.id OR (s.domain IS NOT NULL AND lower(s.domain) = lower(coalesce(b.domain, '')))
                          OR (s.email IS NOT NULL AND EXISTS (SELECT 1 FROM scopely.contacts c WHERE c.business_id = b.id
                                                               AND lower(c.email) = lower(s.email))))) AS suppressed
       FROM scopely.search_run_businesses rb JOIN scopely.businesses b ON b.id = rb.business_id
      WHERE rb.search_run_id = $1 AND rb.state = 'DISCOVERED' AND rb.workspace_id = scopely.current_workspace_id()`, [runId]);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const out = new Map<string, BusinessFacts>();
  for (const b of r.rows) {
    out.set(String(b.run_business_id), {
      countryCode: b.country_code, region: b.region, city: b.city, postalCode: b.postal_code,
      latitude: num(b.latitude), longitude: num(b.longitude),
      vertical: b.vertical, subvertical: b.subvertical, specialty: b.specialty,
      employeeCount: b.employee_count, employeeCountMin: b.employee_count_min, employeeCountMax: b.employee_count_max,
      employeesBasis: b.employees_basis,
      revenueAmount: num(b.revenue_amount), revenueMin: num(b.revenue_min), revenueMax: num(b.revenue_max),
      revenueCurrency: b.revenue_currency, revenueBasis: b.revenue_basis,
      independence: b.independence, websiteStatus: b.website_status as WebsiteStatus,
      reviewCount: b.review_count, rating: num(b.rating),
      incorporatedOn: b.incorporated_on ? new Date(b.incorporated_on).toISOString().slice(0, 10) : null,
      phone: b.phone, domain: b.domain, hasPublicEmail: b.has_public_email,
      history: { analyzedBefore: b.analyzed_before, contacted: b.contacted, existingClient: b.existing_client,
                 won: b.won, lost: b.lost, suppressed: b.suppressed },
    });
  }
  return out;
}

export interface PrequalifyCounts { qualified: number; rejected: number; needsReview: number }

/** Pre-qualifies every DISCOVERED business of a run against the criteria the run froze. */
export async function prequalifyRun(db: Db, runId: string, asOf = new Date()): Promise<PrequalifyCounts> {
  const run = (await db.query('SELECT criteria FROM scopely.search_runs WHERE id = $1 AND workspace_id = scopely.current_workspace_id()',
    [runId])).rows[0];
  if (!run) throw new Error(`search run ${runId} does not exist in this workspace`);
  const criteria = criteriaFromRow(run.criteria);
  const rule = (await db.query<{ id: string }>(
    `SELECT id FROM scopely.rule_versions WHERE rule_key = 'qualify.search_criteria' AND version = 1`)).rows[0]!.id;
  const counts: PrequalifyCounts = { qualified: 0, rejected: 0, needsReview: 0 };
  for (const [runBusinessId, facts] of await loadQualificationFacts(db, runId)) {
    const q: QualificationResult = prequalify(criteria, facts, asOf);
    await db.query(
      `UPDATE scopely.search_run_businesses SET state = $2, qualification = $3, failed_stage = $4, unknown_stages = $5,
         qualification_rule_version_id = $6, qualified_at = $7 WHERE id = $1`,
      [runBusinessId, q.state, JSON.stringify(q.criteria), q.failedStage, q.unknownStages, rule, asOf.toISOString()]);
    if (q.state === 'QUALIFIED') counts.qualified += 1;
    else if (q.state === 'REJECTED') counts.rejected += 1;
    else counts.needsReview += 1;
  }
  return counts;
}

/** A person resolves a NEEDS_REVIEW business (e.g. after checking its size) to QUALIFIED or REJECTED. */
export async function resolveReview(db: Db, runId: string, businessId: string,
  r: { state: 'QUALIFIED' | 'REJECTED'; reviewedBy: string; note: string; failedStage?: string }): Promise<void> {
  await db.query(
    `UPDATE scopely.search_run_businesses SET state = $3, reviewed_by = $4, review_note = $5,
       failed_stage = CASE WHEN $3 = 'REJECTED' THEN coalesce($6, failed_stage, unknown_stages[1]) END
     WHERE search_run_id = $1 AND business_id = $2`,
    [runId, businessId, r.state, r.reviewedBy, r.note, r.failedStage ?? null]);
}

// ------------------------------------------------------------------ selection and budget

/**
 * Selects qualified businesses for analysis, with a per-business credit estimate when one is
 * known. The database refuses a business that is not QUALIFIED and any selection beyond the
 * run's max_businesses_to_analyze.
 */
export async function selectForAnalysis(db: Db, runId: string, picks: { businessId: string; estimatedCredits?: number | null }[],
  selectedBy: string, at: string): Promise<void> {
  for (const p of picks) {
    const r = await db.query(
      `UPDATE scopely.search_run_businesses SET state = 'SELECTED', selected_at = $3, selected_by = $4, estimated_credits = $5
        WHERE search_run_id = $1 AND business_id = $2`,
      [runId, p.businessId, at, selectedBy, p.estimatedCredits ?? null]);
    if (r.rowCount !== 1) throw new Error(`business ${p.businessId} is not in run ${runId}`);
  }
}

export interface AnalysisEstimate {
  selected: number;
  /** Sum of the selected estimates; null if any selected business has no estimate. */
  estimatedCredits: string | null;
  budgetCredits: string | null;
  consumedCredits: string;
  /** Budget left after what is metered and what is queued; null with no budget. */
  availableCredits: string | null;
  /** Whether the selection fits: null when either the estimate or the budget is unknown. */
  fitsBudget: boolean | null;
  maxBusinessesToAnalyze: number | null;
}

/** What analysing the current selection would cost against the run's budget, without inventing a number. */
export async function estimateRunAnalysis(db: Db, runId: string): Promise<AnalysisEstimate> {
  const r = (await db.query(
    `SELECT r.analysis_budget_credits, r.max_businesses_to_analyze,
            (SELECT count(*) FROM scopely.search_run_businesses WHERE search_run_id = r.id AND state = 'SELECTED') AS selected,
            (SELECT CASE WHEN bool_or(estimated_credits IS NULL) THEN NULL ELSE coalesce(sum(estimated_credits), 0) END
               FROM scopely.search_run_businesses WHERE search_run_id = r.id AND state = 'SELECTED') AS estimated,
            (SELECT coalesce(sum(estimated_credits), 0) FROM scopely.search_run_businesses
              WHERE search_run_id = r.id AND state = 'ANALYSIS_QUEUED') AS queued,
            (SELECT coalesce(sum(credits), 0) FROM scopely.cost_events WHERE search_run_id = r.id) AS consumed
       FROM scopely.search_runs r WHERE r.id = $1 AND r.workspace_id = scopely.current_workspace_id()`, [runId])).rows[0];
  if (!r) throw new Error(`search run ${runId} does not exist in this workspace`);
  const available = r.analysis_budget_credits === null ? null
    : (Number(r.analysis_budget_credits) - Number(r.consumed) - Number(r.queued)).toFixed(4);
  return {
    selected: Number(r.selected),
    estimatedCredits: r.estimated,
    budgetCredits: r.analysis_budget_credits,
    consumedCredits: r.consumed,
    availableCredits: available,
    fitsBudget: available === null || r.estimated === null ? null : Number(r.estimated) <= Number(available),
    maxBusinessesToAnalyze: r.max_businesses_to_analyze,
  };
}

/** Queues selected businesses for analysis. The database refuses anything past the credit budget. */
export async function queueForAnalysis(db: Db, runId: string, businessIds: string[], at: string): Promise<void> {
  for (const id of businessIds) {
    const r = await db.query(
      `UPDATE scopely.search_run_businesses SET state = 'ANALYSIS_QUEUED', queued_at = $3 WHERE search_run_id = $1 AND business_id = $2`,
      [runId, id, at]);
    if (r.rowCount !== 1) throw new Error(`business ${id} is not in run ${runId}`);
  }
}

export async function markAnalyzed(db: Db, runId: string, businessId: string, at: string): Promise<void> {
  await db.query(`UPDATE scopely.search_run_businesses SET state = 'ANALYZED', analyzed_at = $3 WHERE search_run_id = $1 AND business_id = $2`,
    [runId, businessId, at]);
}

/** Closes a business's analysis as OPPORTUNITY_FOUND or NO_OPPORTUNITY, from what was recorded. */
export async function concludeAnalysis(db: Db, runId: string, businessId: string, at: string): Promise<'OPPORTUNITY_FOUND' | 'NO_OPPORTUNITY'> {
  const n = Number((await db.query('SELECT count(*) AS n FROM scopely.opportunities WHERE search_run_id = $1 AND business_id = $2',
    [runId, businessId])).rows[0].n);
  const state = n > 0 ? 'OPPORTUNITY_FOUND' : 'NO_OPPORTUNITY';
  await db.query(`UPDATE scopely.search_run_businesses SET state = $3, concluded_at = $4 WHERE search_run_id = $1 AND business_id = $2`,
    [runId, businessId, state, at]);
  return state;
}
