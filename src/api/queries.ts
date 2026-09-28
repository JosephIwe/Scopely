// Read side of the frontend contract (types in ./types.ts, described in docs/API_CONTRACT.md).
//
// Every query is scoped to the request's workspace twice: by an explicit
// `workspace_id = scopely.current_workspace_id()` predicate, and by row-level security when the
// application connects as a non-owner role. With no workspace set, every query returns nothing.
import type { Db } from '../tenancy/index.js';
import type {
  BusinessDetail, Confidence, EvidenceItem, MapPoint, MapQuery, OpportunityFeedFilters, OpportunityFeedItem,
  RunBusinessRow, SearchPerformance, SearchRunSummary, StageFunnelRow,
} from './types.js';

const WS = 'workspace_id = scopely.current_workspace_id()';
const n = (v: unknown) => Number(v);
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export async function getSearchRunSummary(db: Db, searchRunId: string): Promise<SearchRunSummary | null> {
  const r = (await db.query(`SELECT * FROM scopely.v_search_run_summary WHERE search_run_id = $1 AND ${WS}`, [searchRunId])).rows[0];
  if (!r) return null;
  return {
    searchRunId: String(r.search_run_id), searchId: String(r.search_id), searchName: r.search_name, status: r.status,
    startedAt: iso(r.started_at)!, completedAt: iso(r.completed_at),
    counts: {
      discovered: n(r.discovered), qualified: n(r.qualified), rejected: n(r.rejected), needsReview: n(r.needs_review),
      selected: n(r.selected), analysisQueued: n(r.analysis_queued), analyzed: n(r.analyzed),
      businessesWithOpportunity: n(r.businesses_with_opportunity), businessesWithoutOpportunity: n(r.businesses_without_opportunity),
      opportunities: n(r.opportunities), websiteOpportunities: n(r.website_opportunities), fixOpportunities: n(r.fix_opportunities),
      pitched: n(r.pitched), wins: n(r.wins),
    },
    limits: { maxBusinessesToAnalyze: r.max_businesses_to_analyze, budgetCredits: s(r.budget_credits) },
    credits: { consumed: s(r.credits_consumed), estimatedPending: s(r.estimated_credits_pending), remaining: s(r.remaining_credits) },
    analysisCost: { amount: s(r.analysis_cost), currency: r.analysis_cost_currency },
    revenue: s(r.revenue), revenuePer100Discovered: s(r.revenue_per_100_discovered), revenuePer100Analyzed: s(r.revenue_per_100_analyzed),
  };
}

export async function getSearchRunStageFunnel(db: Db, searchRunId: string): Promise<StageFunnelRow[]> {
  const r = await db.query(`SELECT * FROM scopely.v_search_run_stage_funnel WHERE search_run_id = $1 AND ${WS} ORDER BY stage_order`,
    [searchRunId]);
  return r.rows.map((x) => ({ stageOrder: x.stage_order, stage: x.stage, evaluated: n(x.evaluated), rejectedAtStage: n(x.rejected_at_stage),
    needsReviewAtStage: n(x.needs_review_at_stage), remainingAfterStage: n(x.remaining_after_stage) }));
}

export async function listRunBusinesses(db: Db, searchRunId: string,
  opts: { states?: string[]; limit?: number; offset?: number } = {}): Promise<RunBusinessRow[]> {
  const r = await db.query(
    `SELECT rb.*, b.name, b.city, b.country_code, src.provider, src.kind, src.ref
       FROM scopely.search_run_businesses rb
       JOIN scopely.businesses b ON b.id = rb.business_id
       LEFT JOIN scopely.sources src ON src.id = rb.source_id
      WHERE rb.search_run_id = $1 AND rb.${WS} AND ($2::text[] IS NULL OR rb.state = ANY ($2))
      ORDER BY rb.id LIMIT $3 OFFSET $4`,
    [searchRunId, opts.states ?? null, Math.min(opts.limit ?? 100, 500), opts.offset ?? 0]);
  return r.rows.map((x) => ({
    businessId: String(x.business_id), name: x.name, city: x.city, countryCode: x.country_code, state: x.state,
    failedStage: x.failed_stage, unknownStages: x.unknown_stages, qualification: x.qualification, estimatedCredits: s(x.estimated_credits),
    source: x.kind ? { provider: x.provider, sourceType: x.kind, reference: x.ref } : null,
  }));
}

function feedItem(x: Record<string, any>): OpportunityFeedItem {
  return {
    opportunityId: String(x.opportunity_id), kind: x.opportunity_kind, path: x.opportunity_path, opportunityType: x.opportunity_type,
    status: x.status, searchRunId: s(x.search_run_id), searchId: s(x.search_id),
    business: {
      businessId: String(x.business_id), name: x.business_name, domain: x.domain, vertical: x.vertical, subvertical: x.subvertical,
      specialty: x.specialty, countryCode: x.country_code, region: x.region, city: x.city, latitude: s(x.latitude), longitude: s(x.longitude),
      employees: { count: x.employee_count, min: x.employee_count_min, max: x.employee_count_max, basis: x.employees_basis },
      revenue: { amount: s(x.revenue_amount), min: s(x.revenue_min), max: s(x.revenue_max), currency: x.revenue_currency, basis: x.revenue_basis },
      independence: x.independence, websiteStatus: x.website_status,
    },
    service: { mappingStatus: x.mapping_status, catalogKey: x.catalog_key, name: x.service, price: s(x.service_price), currency: x.currency },
    evidence: { count: n(x.evidence_count), issueCodes: x.issue_codes ?? [], claimStates: x.claim_states ?? [], topConfidence: x.top_confidence },
    buildState: x.build_state, sellState: x.sell_state, deliveryState: x.delivery_state, dealValue: s(x.deal_value),
    createdAt: iso(x.created_at)!,
  };
}

const CONFIDENCE_RANK: Record<Confidence, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/** The unified feed: WEBSITE and FIX opportunities in one list, filtered on any combination. */
export async function listOpportunities(db: Db, f: OpportunityFeedFilters = {}): Promise<OpportunityFeedItem[]> {
  const where = [WS];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.kinds?.length) where.push(`opportunity_kind = ANY (${p(f.kinds)})`);
  if (f.paths?.length) where.push(`opportunity_path = ANY (${p(f.paths)})`);
  if (f.verticals?.length) where.push(`vertical = ANY (${p(f.verticals)})`);
  if (f.subverticals?.length) where.push(`subvertical = ANY (${p(f.subverticals)})`);
  if (f.countryCode) where.push(`country_code = ${p(f.countryCode)}`);
  if (f.region) where.push(`lower(region) = lower(${p(f.region)})`);
  if (f.city) where.push(`lower(city) = lower(${p(f.city)})`);
  // A size or revenue filter keeps only businesses whose known figure lies wholly inside the range.
  if (f.employeeMin !== undefined || f.employeeMax !== undefined) {
    const lo = 'coalesce(employee_count, employee_count_min)', hi = 'coalesce(employee_count, employee_count_max)';
    const inside = [f.employeeMin !== undefined ? `${lo} >= ${p(f.employeeMin)}` : null,
                    f.employeeMax !== undefined ? `${hi} <= ${p(f.employeeMax)}` : null].filter(Boolean).join(' AND ');
    where.push(f.includeUnknownSize ? `((${inside}) OR (${lo} IS NULL AND ${hi} IS NULL))` : `(${inside})`);
  }
  if (f.revenueMin !== undefined || f.revenueMax !== undefined) {
    if (!f.revenueCurrency) throw new Error('a revenue filter needs revenueCurrency');
    const lo = 'coalesce(revenue_amount, revenue_min)', hi = 'coalesce(revenue_amount, revenue_max)';
    const inside = [`revenue_currency = ${p(f.revenueCurrency)}`,
                    f.revenueMin !== undefined ? `${lo} >= ${p(f.revenueMin)}` : null,
                    f.revenueMax !== undefined ? `${hi} <= ${p(f.revenueMax)}` : null].filter(Boolean).join(' AND ');
    where.push(f.includeUnknownRevenue ? `((${inside}) OR revenue_currency IS NULL)` : `(${inside})`);
  }
  if (f.catalogKeys?.length) where.push(`catalog_key = ANY (${p(f.catalogKeys)})`);
  if (f.minConfidence) {
    where.push(`CASE top_confidence WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 END >= ${p(CONFIDENCE_RANK[f.minConfidence])}`);
  }
  if (f.statuses?.length) where.push(`status = ANY (${p(f.statuses)})`);
  if (f.buildStates?.length) where.push(`build_state = ANY (${p(f.buildStates)})`);
  if (f.sellStates?.length) where.push(`sell_state = ANY (${p(f.sellStates)})`);
  if (f.searchId) where.push(`search_id = ${p(f.searchId)}`);
  if (f.searchRunId) where.push(`search_run_id = ${p(f.searchRunId)}`);
  const limit = p(Math.min(f.limit ?? 100, 500)), offset = p(f.offset ?? 0);
  const r = await db.query(`SELECT * FROM scopely.v_opportunity_feed WHERE ${where.join(' AND ')}
                             ORDER BY created_at DESC, opportunity_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  return r.rows.map(feedItem);
}

export async function getBusinessDetail(db: Db, businessId: string): Promise<BusinessDetail | null> {
  const b = (await db.query(`SELECT * FROM scopely.businesses WHERE id = $1 AND ${WS}`, [businessId])).rows[0];
  if (!b) return null;
  const [sources, runs, evidence, opps] = await Promise.all([
    db.query(`SELECT provider, kind, ref, search_run_id, found_at FROM scopely.sources WHERE business_id = $1 AND ${WS} ORDER BY id`, [businessId]),
    db.query(`SELECT rb.search_run_id, r.search_id, rb.state FROM scopely.search_run_businesses rb
                JOIN scopely.search_runs r ON r.id = rb.search_run_id WHERE rb.business_id = $1 AND rb.${WS} ORDER BY rb.id`, [businessId]),
    db.query(`SELECT e.*, o.snapshot_id, rv.rule_key, rv.version FROM scopely.evidence e
                JOIN scopely.observations o ON o.id = e.observation_id
                JOIN scopely.rule_versions rv ON rv.id = e.rule_version_id
               WHERE e.business_id = $1 AND e.${WS} ORDER BY e.id`, [businessId]),
    db.query(`SELECT * FROM scopely.v_opportunity_feed WHERE business_id = $1 AND ${WS} ORDER BY opportunity_id`, [businessId]),
  ]);
  return {
    businessId: String(b.id), name: b.name, domain: b.domain, websiteUrl: b.website_url,
    vertical: b.vertical, subvertical: b.subvertical, specialty: b.specialty,
    location: { addressLine: b.address_line, city: b.city, region: b.region, postalCode: b.postal_code, countryCode: b.country_code,
                latitude: s(b.latitude), longitude: s(b.longitude), geoSource: b.geo_source },
    website: { status: b.website_status, basis: b.website_status_basis, source: b.website_status_source, checkedAt: iso(b.website_status_checked_at) },
    company: { register: b.company_register, number: b.company_number, type: b.company_type, status: b.company_status },
    firmographics: {
      employees: { count: b.employee_count, min: b.employee_count_min, max: b.employee_count_max, basis: b.employees_basis,
                   source: b.employees_source, asOf: iso(b.employees_as_of) },
      revenue: { amount: s(b.revenue_amount), min: s(b.revenue_min), max: s(b.revenue_max), currency: b.revenue_currency,
                 basis: b.revenue_basis, source: b.revenue_source, asOf: iso(b.revenue_as_of) },
      reviews: { count: b.review_count, rating: s(b.rating), source: b.reviews_source, asOf: iso(b.reviews_as_of) },
      independence: b.independence,
      incorporatedOn: b.incorporated_on ? new Date(b.incorporated_on).toISOString().slice(0, 10) : null,
    },
    sources: sources.rows.map((x) => ({ provider: x.provider, sourceType: x.kind, reference: x.ref, searchRunId: s(x.search_run_id),
                                        foundAt: iso(x.found_at)! })),
    searchRuns: runs.rows.map((x) => ({ searchRunId: String(x.search_run_id), searchId: String(x.search_id), state: x.state })),
    evidence: evidence.rows.map((e): EvidenceItem => ({
      evidenceId: String(e.id), issueCode: e.issue_code, plainIssue: e.plain_issue, url: e.url, quote: e.quote, claimState: e.claim_state,
      confidence: e.confidence, observedAt: iso(e.observed_at)!, snapshotId: String(e.snapshot_id), observationId: String(e.observation_id),
      rule: { key: e.rule_key, version: e.version },
      recheck: e.recheck_result ? { result: e.recheck_result, at: iso(e.rechecked_at)! } : null,
    })),
    opportunities: opps.rows.map(feedItem),
  };
}

/** Map points by bounding box, radius, city or region. Coordinates only when a source gave them. */
export async function listMapBusinesses(db: Db, q: MapQuery = {}): Promise<MapPoint[]> {
  const where = [WS];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.bounds) {
    where.push(`latitude BETWEEN ${p(q.bounds.south)} AND ${p(q.bounds.north)}`);
    // A box that crosses the antimeridian has west > east.
    where.push(q.bounds.west <= q.bounds.east
      ? `longitude BETWEEN ${p(q.bounds.west)} AND ${p(q.bounds.east)}`
      : `(longitude >= ${p(q.bounds.west)} OR longitude <= ${p(q.bounds.east)})`);
  }
  if (q.near) {
    const lat = p(q.near.latitude), lon = p(q.near.longitude), km = p(q.near.radiusKm);
    where.push(`2 * 6371.0088 * asin(sqrt(power(sin(radians(latitude - ${lat}) / 2), 2)
                + cos(radians(${lat})) * cos(radians(latitude)) * power(sin(radians(longitude - ${lon}) / 2), 2))) <= ${km}`);
  }
  if (q.city) where.push(`lower(city) = lower(${p(q.city)})`);
  if (q.region) where.push(`lower(region) = lower(${p(q.region)})`);
  if (q.countryCode) where.push(`country_code = ${p(q.countryCode)}`);
  const r = await db.query(`SELECT * FROM scopely.v_business_map WHERE ${where.join(' AND ')} ORDER BY business_id LIMIT ${p(Math.min(q.limit ?? 1000, 5000))}`, params);
  return r.rows.map((x) => ({
    businessId: String(x.business_id), name: x.name, latitude: String(x.latitude), longitude: String(x.longitude),
    addressLine: x.address_line, city: x.city, region: x.region, countryCode: x.country_code, websiteStatus: x.website_status,
    opportunities: n(x.opportunities), opportunityPaths: x.opportunity_paths ?? [], opportunityKinds: x.opportunity_kinds ?? [],
  }));
}

export async function getSearchPerformance(db: Db, searchId?: string): Promise<SearchPerformance[]> {
  const r = await db.query(`SELECT * FROM scopely.v_search_performance WHERE ${WS} AND ($1::bigint IS NULL OR search_id = $1) ORDER BY search_id`,
    [searchId ?? null]);
  return r.rows.map((x) => ({
    searchId: String(x.search_id), name: x.name, runs: n(x.runs), discovered: n(x.discovered), qualified: n(x.qualified),
    analyzed: n(x.analyzed), opportunities: n(x.opportunities), websiteOpportunities: n(x.website_opportunities),
    fixOpportunities: n(x.fix_opportunities), pitched: n(x.pitched), wins: n(x.wins), revenue: s(x.revenue),
    creditsConsumed: s(x.credits_consumed), revenuePer100Discovered: s(x.revenue_per_100_discovered),
  }));
}
