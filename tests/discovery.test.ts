// Migration 008 and src/discovery: searches, runs, pre-qualification, selection, budgets, firmographics,
// website status and the two opportunity paths. DISCOVERED is not ANALYZED is not an opportunity.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { getBusinessDetail, getSearchRunStageFunnel, getSearchRunSummary, listOpportunities } from '../src/api/queries.js';
import {
  concludeAnalysis, createSearch, estimateRunAnalysis, markAnalyzed, prequalifyRun, queueForAnalysis, recordDiscoveredBusiness,
  resolveReview, selectForAnalysis, startSearchRun, type DiscoveredBusiness,
} from '../src/discovery/index.js';
import { classifyWebsiteFetch, recordWebsiteStatus } from '../src/discovery/website.js';
import { recordOpportunity } from '../src/record/index.js';
import { catalogId, failure, one, refused, ruleId, useDb } from './helpers.js';

const { db } = useDb();
const T0 = '2026-10-01T09:00:00Z';

let seq = 0;
function found(over: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness {
  seq += 1;
  return { source: { provider: 'csv', sourceType: 'csv_import', reference: `list.csv:${seq}`, discoveredAt: T0 },
           name: `Business ${seq}`, domain: `business-${seq}-${Math.random().toString(36).slice(2, 7)}.test`, countryCode: 'GB', ...over };
}

async function state(d: pg.Client, runId: string, businessId: string) {
  return (await one<{ state: string }>(d, 'SELECT state FROM search_run_businesses WHERE search_run_id = $1 AND business_id = $2', [runId, businessId])).state;
}

/** Evidence on a business: a snapshot, an OBSERVED defect and its evidence row. */
async function evidenceFor(d: pg.Client, businessId: string, issue = 'E-24-7-CONTRADICTION', rule = 'check.trades_hours_and_routes',
  url = 'https://business.test/') {
  const s = await one<{ id: string }>(d, `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, $2, $3, 'manual') RETURNING id`,
    [businessId, url, T0]);
  const r = await ruleId(d, rule);
  const o = await one<{ id: string }>(d, `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
    VALUES ($1, 'x', $2, 'OBSERVED', 'gap') RETURNING id`, [s.id, r]);
  return (await one<{ id: string }>(d, `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, confidence)
    VALUES ($1, $2, $3, $4, 'OBSERVED', 'issue', $5, 'quote', 'MEDIUM') RETURNING id`, [businessId, o.id, issue, r, url])).id;
}

describe('searches hold the seller\'s own criteria', () => {
  it('stores different employee and revenue ranges per search, preserving the revenue currency', async () => {
    const london = await createSearch(db(), { name: 'London plumbers', countryCode: 'GB', city: 'London', subverticals: ['plumbing'],
      employeeMin: 5, employeeMax: 30, revenueMin: 250_000, revenueMax: 5_000_000, revenueCurrency: 'GBP',
      opportunityKinds: ['website', 'lead_recovery'], excludeChains: true });
    const toronto = await createSearch(db(), { name: 'Toronto dental', countryCode: 'CA', city: 'Toronto', subverticals: ['dental'],
      employeeMin: 10, employeeMax: 50, revenueMin: 1_000_000, revenueMax: 10_000_000, revenueCurrency: 'CAD', opportunityKinds: ['booking_flow'] });
    const rows = (await db().query('SELECT id, employee_min, employee_max, revenue_min, revenue_max, revenue_currency FROM searches ORDER BY id')).rows;
    expect(rows.map((r) => [String(r.id), r.employee_min, r.employee_max, r.revenue_min, r.revenue_max, r.revenue_currency])).toEqual([
      [london, 5, 30, '250000.00', '5000000.00', 'GBP'],
      [toronto, 10, 50, '1000000.00', '10000000.00', 'CAD'],
    ]);
  });

  it('refuses inverted ranges, revenue without a currency and unknown opportunity kinds', async () => {
    expect(await failure(db(), `INSERT INTO searches (name, employee_min, employee_max) VALUES ('x', 30, 5)`)).toMatch(/check constraint/);
    expect(await failure(db(), `INSERT INTO searches (name, revenue_min) VALUES ('x', 100)`)).toMatch(/check constraint/);
    expect(await failure(db(), `INSERT INTO searches (name, opportunity_kinds) VALUES ('x', ARRAY['mind_reading'])`)).toMatch(/unknown opportunity kind/);
    expect(await failure(db(), `INSERT INTO searches (name, radius_km) VALUES ('x', 10)`)).toMatch(/check constraint/);
  });

  it('freezes the criteria and limits a run started with, whatever later edits the search gets', async () => {
    const id = await createSearch(db(), { name: 'S', employeeMin: 5, employeeMax: 30, maxBusinessesToAnalyze: 50, analysisBudgetCredits: 400 });
    const run = await startSearchRun(db(), id);
    await db().query('UPDATE searches SET employee_max = 300, analysis_budget_credits = 9000 WHERE id = $1', [id]);
    const r = await one<{ criteria: Record<string, unknown>; analysis_budget_credits: string; max_businesses_to_analyze: number }>(db(),
      'SELECT criteria, analysis_budget_credits, max_businesses_to_analyze FROM search_runs WHERE id = $1', [run]);
    expect(r.criteria).toMatchObject({ employee_min: 5, employee_max: 30, name: 'S' });
    expect([r.analysis_budget_credits, r.max_businesses_to_analyze]).toEqual(['400.0000', 50]);
    expect(await failure(db(), `UPDATE search_runs SET analysis_budget_credits = 9000 WHERE id = $1`, [run])).toMatch(/frozen/);
    expect(await failure(db(), `UPDATE search_runs SET criteria = '{}' WHERE id = $1`, [run])).toMatch(/frozen/);
  });
});

describe('discovery keeps one business per workspace across searches', () => {
  it('records the same business found by two searches once, with a source and membership per run', async () => {
    const s1 = await startSearchRun(db(), await createSearch(db(), { name: 'Plumbers' }));
    const s2 = await startSearchRun(db(), await createSearch(db(), { name: 'No website' }));
    const s3 = await startSearchRun(db(), await createSearch(db(), { name: 'Lead recovery' }));
    const first = await recordDiscoveredBusiness(db(), s1, found({ domain: 'Same-Plumber.test', name: 'Same Plumber' }));
    const second = await recordDiscoveredBusiness(db(), s2, found({ domain: 'same-plumber.test', name: 'Same Plumber Ltd' }));
    const third = await recordDiscoveredBusiness(db(), s3, found({ domain: undefined, companyRegister: 'uk_companies_house', companyNumber: '01234567' }));
    const fourth = await recordDiscoveredBusiness(db(), s1, found({ domain: undefined, companyRegister: 'uk_companies_house', companyNumber: '01234567' }));
    expect(first.matchedBy).toBe('new');
    expect(second).toMatchObject({ businessId: first.businessId, matchedBy: 'domain' });
    expect(fourth).toMatchObject({ businessId: third.businessId, matchedBy: 'company_register' });
    const detail = await getBusinessDetail(db(), first.businessId);
    expect(detail!.searchRuns.map((r) => r.searchRunId)).toEqual([s1, s2]);
    expect(detail!.sources.map((s) => s.searchRunId)).toEqual([s1, s2]);
    expect(detail!.name).toBe('Same Plumber');   // a later discovery never overwrites what is known
  });

  it('keeps unknown revenue and employee count NULL, and never lets an estimate pass as verified', async () => {
    const run = await startSearchRun(db(), await createSearch(db(), { name: 'S' }));
    const bare = await recordDiscoveredBusiness(db(), run, found());
    const b = await one<Record<string, unknown>>(db(), 'SELECT * FROM businesses WHERE id = $1', [bare.businessId]);
    for (const col of ['employee_count', 'employee_count_min', 'employee_count_max', 'employees_basis', 'revenue_amount', 'revenue_min',
                       'revenue_max', 'revenue_currency', 'revenue_basis', 'independence', 'latitude', 'rating']) expect(b[col], col).toBeNull();
    expect(b.website_status).toBe('UNKNOWN');
    const est = await recordDiscoveredBusiness(db(), run, found({
      employees: { min: 11, max: 50, basis: 'ESTIMATED', source: 'clay:headcount_range', asOf: T0 },
      revenue: { min: 1_000_000, max: 5_000_000, currency: 'USD', basis: 'ESTIMATED', source: 'clay:revenue_range', asOf: T0 } }));
    const d = await getBusinessDetail(db(), est.businessId);
    expect(d!.firmographics.employees).toMatchObject({ count: null, min: 11, max: 50, basis: 'ESTIMATED', source: 'clay:headcount_range' });
    expect(d!.firmographics.revenue).toMatchObject({ amount: null, min: '1000000.00', max: '5000000.00', currency: 'USD', basis: 'ESTIMATED' });
  });

  it('refuses a size or revenue figure without its source, basis and date, or with an inverted range', async () => {
    const ins = (cols: string, vals: string) => failure(db(), `INSERT INTO businesses (name, ${cols}) VALUES ('X', ${vals})`);
    expect(await ins('employee_count', '12')).toMatch(/businesses_employees_check/);
    expect(await ins('revenue_amount, revenue_basis, revenue_source, revenue_as_of', `500000, 'REPORTED', 'accounts', now()`)).toMatch(/businesses_revenue_check/);
    expect(await ins('employee_count_min, employee_count_max, employees_basis, employees_source, employees_as_of', `50, 10, 'REPORTED', 's', now()`))
      .toMatch(/businesses_employee_range_check/);
    expect(await ins('employee_count, employee_count_min, employee_count_max, employees_basis, employees_source, employees_as_of', `60, 10, 50, 'VERIFIED', 's', now()`))
      .toMatch(/businesses_employee_range_check/);
    expect(await ins('revenue_min, revenue_max, revenue_currency, revenue_basis, revenue_source, revenue_as_of', `500, 100, 'GBP', 'REPORTED', 's', now()`))
      .toMatch(/businesses_revenue_range_check/);
    expect(await ins('revenue_amount, revenue_min, revenue_max, revenue_currency, revenue_basis, revenue_source, revenue_as_of', `900, 100, 500, 'GBP', 'VERIFIED', 's', now()`))
      .toMatch(/businesses_revenue_range_check/);
    expect(await ins('latitude, longitude', '53.4, -2.2')).toMatch(/businesses_geo_check/);
    expect(await ins('rating', '4.5')).toMatch(/businesses_reviews_check/);
  });
});

describe('the run pipeline: discovered is not qualified is not analyzed', () => {
  async function run(opts: Parameters<typeof createSearch>[1] = { name: 'S' }) {
    return startSearchRun(db(), await createSearch(db(), opts));
  }

  it('enters as DISCOVERED and only moves along the allowed transitions', async () => {
    const r = await run({ name: 'S', countryCode: 'GB' });
    const b = await recordDiscoveredBusiness(db(), r, found());
    expect(await state(db(), r, b.businessId)).toBe('DISCOVERED');
    const move = (to: string) => failure(db(), `UPDATE search_run_businesses SET state = $3, selected_at = now(), selected_by = 'op', queued_at = now(),
      analyzed_at = now(), qualification = '[]', qualification_rule_version_id = (SELECT id FROM rule_versions WHERE rule_key = 'qualify.search_criteria'),
      qualified_at = now() WHERE search_run_id = $1 AND business_id = $2`, [r, b.businessId, to]);
    expect(await move('SELECTED')).toMatch(/cannot move from DISCOVERED to SELECTED/);
    expect(await move('ANALYSIS_QUEUED')).toMatch(/cannot move from DISCOVERED to ANALYSIS_QUEUED/);
    expect(await move('ANALYZED')).toMatch(/cannot move from DISCOVERED to ANALYZED/);
    expect(await failure(db(), `INSERT INTO search_run_businesses (search_run_id, business_id, state) VALUES ($1, $2, 'ANALYZED')`,
      [r, (await recordDiscoveredBusiness(db(), await run(), found())).businessId])).toMatch(/cannot move|belongs|enters a run as DISCOVERED/);
    const summary = await getSearchRunSummary(db(), r);
    expect(summary!.counts).toMatchObject({ discovered: 1, qualified: 0, analyzed: 0, opportunities: 0 });
  });

  it('pre-qualifies from the frozen criteria, explains every decision and never analyzes a rejected business', async () => {
    const r = await run({ name: 'Manchester', countryCode: 'GB', city: 'Manchester', employeeMin: 5, employeeMax: 30, excludeChains: true });
    const emp = (count: number) => ({ count, basis: 'REPORTED' as const, source: 'profile', asOf: T0 });
    const fits = await recordDiscoveredBusiness(db(), r, found({ city: 'Manchester', independence: 'independent', employees: emp(12) }));
    const leeds = await recordDiscoveredBusiness(db(), r, found({ city: 'Leeds', independence: 'independent', employees: emp(12) }));
    const big = await recordDiscoveredBusiness(db(), r, found({ city: 'Manchester', independence: 'independent', employees: emp(400) }));
    const chain = await recordDiscoveredBusiness(db(), r, found({ city: 'Manchester', independence: 'chain', employees: emp(12) }));
    const unknown = await recordDiscoveredBusiness(db(), r, found({ city: 'Manchester', independence: 'independent' }));
    expect(await prequalifyRun(db(), r, new Date(T0))).toEqual({ qualified: 1, rejected: 3, needsReview: 1 });
    const rows = (await db().query('SELECT business_id, state, failed_stage, unknown_stages, qualification FROM search_run_businesses WHERE search_run_id = $1 ORDER BY id', [r])).rows;
    expect(rows.map((x) => [String(x.business_id), x.state, x.failed_stage])).toEqual([
      [fits.businessId, 'QUALIFIED', null], [leeds.businessId, 'REJECTED', 'geography'], [big.businessId, 'REJECTED', 'size'],
      [chain.businessId, 'REJECTED', 'structure'], [unknown.businessId, 'NEEDS_REVIEW', null]]);
    expect(rows[4].unknown_stages).toEqual(['size']);
    // REJECTED always names its stage, and only REJECTED does.
    expect(await failure(db(), 'UPDATE search_run_businesses SET failed_stage = NULL WHERE search_run_id = $1 AND business_id = $2', [r, leeds.businessId]))
      .toMatch(/search_run_businesses_check1/);
    expect(await failure(db(), `UPDATE search_run_businesses SET failed_stage = 'size' WHERE search_run_id = $1 AND business_id = $2`, [r, fits.businessId]))
      .toMatch(/search_run_businesses_check1/);
    expect(rows[2].qualification.find((c: { criterion: string }) => c.criterion === 'employees')).toMatchObject({ verdict: 'fail', basis: 'REPORTED' });

    const funnel = await getSearchRunStageFunnel(db(), r);
    expect(funnel.map((f) => [f.stage, f.rejectedAtStage, f.remainingAfterStage, f.needsReviewAtStage]).slice(0, 5)).toEqual([
      ['geography', 1, 4, 0], ['industry', 0, 4, 0], ['size', 1, 3, 1], ['revenue', 0, 3, 0], ['structure', 1, 2, 0]]);

    // A rejected business cannot be selected, queued, or have analysis work metered against it.
    expect(await refused(db(), () => selectForAnalysis(db(), r, [{ businessId: leeds.businessId }], 'op', T0))).toMatch(/cannot move from REJECTED to SELECTED/);
    expect(await failure(db(), `INSERT INTO cost_events (business_id, search_run_id, kind, credits) VALUES ($1, $2, 'fetch', 1)`, [leeds.businessId, r]))
      .toMatch(/only businesses queued for analysis are analyzed/);
    // Nor a qualified one that was never queued.
    expect(await failure(db(), `INSERT INTO cost_events (business_id, search_run_id, kind, credits) VALUES ($1, $2, 'render', 1)`, [fits.businessId, r]))
      .toMatch(/only businesses queued/);
    // Review is resolved by a named person with a note.
    expect(await failure(db(), `UPDATE search_run_businesses SET state = 'QUALIFIED' WHERE search_run_id = $1 AND business_id = $2`, [r, unknown.businessId]))
      .toMatch(/needs reviewed_by and review_note/);
    await resolveReview(db(), r, unknown.businessId, { state: 'QUALIFIED', reviewedBy: 'operator', note: 'Team page lists 9 staff' });
    expect(await state(db(), r, unknown.businessId)).toBe('QUALIFIED');
  });

  it('refuses an opportunity from a run for a business that was not analyzed', async () => {
    const r = await run();
    const b = await recordDiscoveredBusiness(db(), r, found({ subvertical: 'plumbing' }));
    const ev = await evidenceFor(db(), b.businessId);
    const insert = `WITH o AS (INSERT INTO opportunities (business_id, search_run_id, opportunity_type, mapping_status, unmapped_reason)
      VALUES ($1, $2, 't', 'UNMAPPED', 'r') RETURNING id) INSERT INTO opportunity_evidence (opportunity_id, evidence_id) SELECT id, $3 FROM o`;
    expect(await failure(db(), insert, [b.businessId, r, ev])).toMatch(/is DISCOVERED in run .*, not analyzed/);
    await prequalifyRun(db(), r, new Date(T0));
    await selectForAnalysis(db(), r, [{ businessId: b.businessId }], 'op', T0);
    expect(await failure(db(), insert, [b.businessId, r, ev])).toMatch(/is SELECTED in run/);
    await queueForAnalysis(db(), r, [b.businessId], T0);
    await markAnalyzed(db(), r, b.businessId, T0);
    expect(await failure(db(), `UPDATE search_run_businesses SET state = 'OPPORTUNITY_FOUND', concluded_at = now() WHERE search_run_id = $1 AND business_id = $2`,
      [r, b.businessId])).toMatch(/needs an opportunity/);
    expect(await failure(db(), insert, [b.businessId, r, ev])).toBeNull();
    expect(await failure(db(), `UPDATE search_run_businesses SET state = 'NO_OPPORTUNITY', concluded_at = now() WHERE search_run_id = $1 AND business_id = $2`,
      [r, b.businessId])).toMatch(/has 1 opportunities/);
    expect(await concludeAnalysis(db(), r, b.businessId, T0)).toBe('OPPORTUNITY_FOUND');
  });
});

describe('analysis cannot silently exceed the run\'s limits', () => {
  async function qualifiedRun(n: number, limits: { maxBusinessesToAnalyze?: number; analysisBudgetCredits?: number; maxDiscoveredPerRun?: number }) {
    const r = await startSearchRun(db(), await createSearch(db(), { name: 'Budgeted', ...limits }));
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push((await recordDiscoveredBusiness(db(), r, found())).businessId);
    await prequalifyRun(db(), r, new Date(T0));
    return { r, ids };
  }

  it('caps selection at max_businesses_to_analyze', async () => {
    const { r, ids } = await qualifiedRun(3, { maxBusinessesToAnalyze: 2 });
    await selectForAnalysis(db(), r, [{ businessId: ids[0]! }, { businessId: ids[1]! }], 'op', T0);
    expect(await refused(db(), () => selectForAnalysis(db(), r, [{ businessId: ids[2]! }], 'op', T0))).toMatch(/limit of 2 businesses selected/);
    // Deselecting frees a place.
    await db().query(`UPDATE search_run_businesses SET state = 'QUALIFIED' WHERE search_run_id = $1 AND business_id = $2`, [r, ids[0]]);
    await selectForAnalysis(db(), r, [{ businessId: ids[2]! }], 'op', T0);
  });

  it('caps discovery at max_discovered_per_run', async () => {
    const r = await startSearchRun(db(), await createSearch(db(), { name: 'Capped', maxDiscoveredPerRun: 2 }));
    await recordDiscoveredBusiness(db(), r, found());
    await recordDiscoveredBusiness(db(), r, found());
    expect(await refused(db(), () => recordDiscoveredBusiness(db(), r, found()))).toMatch(/limit of 2 discovered/);
  });

  it('refuses to queue past the credit budget, or with an unknown estimate, and reports unknown instead of guessing', async () => {
    const { r, ids } = await qualifiedRun(4, { analysisBudgetCredits: 20 });
    await selectForAnalysis(db(), r, [{ businessId: ids[0]!, estimatedCredits: 8 }, { businessId: ids[1]!, estimatedCredits: 8 },
                                      { businessId: ids[2]!, estimatedCredits: 8 }, { businessId: ids[3]! }], 'op', T0);
    expect(await estimateRunAnalysis(db(), r)).toMatchObject({ selected: 4, estimatedCredits: null, budgetCredits: '20.0000', fitsBudget: null });
    expect(await refused(db(), () => queueForAnalysis(db(), r, [ids[3]!], T0))).toMatch(/needs a known estimate/);
    await queueForAnalysis(db(), r, [ids[0]!, ids[1]!], T0);
    expect(await refused(db(), () => queueForAnalysis(db(), r, [ids[2]!], T0))).toMatch(/queueing needs 8.0000 credits but run .* has 4.0000 of 20.0000 left/);
    await db().query(`UPDATE search_run_businesses SET state = 'QUALIFIED' WHERE search_run_id = $1 AND business_id = $2`, [r, ids[3]]);
    expect(await estimateRunAnalysis(db(), r)).toMatchObject({ selected: 1, estimatedCredits: '8.0000', availableCredits: '4.0000', fitsBudget: false });
  });

  it('refuses metered analysis that would pass the budget, or that does not say its credits', async () => {
    const { r, ids } = await qualifiedRun(1, { analysisBudgetCredits: 10 });
    await selectForAnalysis(db(), r, [{ businessId: ids[0]!, estimatedCredits: 6 }], 'op', T0);
    await queueForAnalysis(db(), r, [ids[0]!], T0);
    const meter = `INSERT INTO cost_events (business_id, search_run_id, kind, credits, amount, currency) VALUES ($1, $2, $3, $4, NULL, NULL)`;
    expect(await failure(db(), meter, [ids[0], r, 'fetch', 6])).toBeNull();
    expect(await failure(db(), meter, [ids[0], r, 'llm_call', null])).toMatch(/must record its credits/);
    expect(await failure(db(), meter, [ids[0], r, 'render', 5])).toMatch(/past its budget \(6.0000 of 10.0000 used\)/);
    expect(await failure(db(), meter, [ids[0], r, 'render', 4])).toBeNull();
    expect(await failure(db(), `UPDATE cost_events SET credits = 0 WHERE search_run_id = $1`, [r])).toMatch(/cannot be edited/);
    const s = await getSearchRunSummary(db(), r);
    expect(s!.credits).toMatchObject({ consumed: '10.0000', remaining: '0.0000' });
    // The money cost of that work was not supplied, so it stays unknown rather than 0.
    expect(s!.analysisCost.amount).toBeNull();
  });
});

describe('website status: a failed fetch is never "no website"', () => {
  it('classifies fetch failures as unreachable or needing review, never as not observed', () => {
    const outcomes = [{ kind: 'response', httpStatus: 200 }, { kind: 'response', httpStatus: 301 }, { kind: 'response', httpStatus: 403 },
      { kind: 'response', httpStatus: 404 }, { kind: 'response', httpStatus: 429 }, { kind: 'response', httpStatus: 503 },
      ...(['dns_not_found', 'timeout', 'tls', 'connection_refused', 'blocked', 'other'] as const).map((error) => ({ kind: 'error', error }))] as const;
    const statuses = outcomes.map((o) => classifyWebsiteFetch(o as Parameters<typeof classifyWebsiteFetch>[0]));
    expect(statuses.map((s) => s.status)).not.toContain('WEBSITE_NOT_OBSERVED');
    expect(classifyWebsiteFetch({ kind: 'response', httpStatus: 403 })).toEqual({ status: 'WEBSITE_UNREACHABLE', basis: 'NOT_OBSERVABLE' });
    expect(classifyWebsiteFetch({ kind: 'error', error: 'timeout' })).toEqual({ status: 'WEBSITE_UNREACHABLE', basis: 'NOT_OBSERVABLE' });
    expect(classifyWebsiteFetch({ kind: 'response', httpStatus: 200 })).toEqual({ status: 'WEBSITE_PRESENT', basis: 'OBSERVED' });
  });

  it('refuses "not observed" while any address is known, and a NOT_OBSERVABLE basis for presence or absence', async () => {
    const run = await startSearchRun(db(), await createSearch(db(), { name: 'S' }));
    const withDomain = await recordDiscoveredBusiness(db(), run, found());
    const set = (id: string, status: string, basis: string) =>
      recordWebsiteStatus(db(), id, { status: status as never, basis: basis as never, source: 'fetch', checkedAt: T0 });
    expect(await refused(db(), () => set(withDomain.businessId, 'WEBSITE_NOT_OBSERVED', 'OBSERVED'))).toMatch(/businesses_website_not_observed_check/);
    expect(await refused(db(), () => set(withDomain.businessId, 'WEBSITE_PRESENT', 'NOT_OBSERVABLE'))).toMatch(/businesses_website_not_observable_check/);
    await set(withDomain.businessId, 'WEBSITE_UNREACHABLE', 'NOT_OBSERVABLE');
    const noDomain = await recordDiscoveredBusiness(db(), run, found({ domain: undefined }));
    expect(await refused(db(), () => set(noDomain.businessId, 'WEBSITE_PRESENT', 'OBSERVED'))).toMatch(/businesses_website_address_check/);
    expect(await refused(db(), () => set(noDomain.businessId, 'WEBSITE_NOT_OBSERVED', 'NOT_OBSERVABLE'))).toMatch(/not_observable_check/);
    expect(await failure(db(), `UPDATE businesses SET website_status = 'WEBSITE_NOT_OBSERVED' WHERE id = $1`, [noDomain.businessId]))
      .toMatch(/businesses_website_basis_required_check/);
    await set(noDomain.businessId, 'WEBSITE_NOT_OBSERVED', 'OBSERVED');
  });

  it('allows a no-website finding only for a business whose website is not observed, and blocks it once that changes', async () => {
    const run = await startSearchRun(db(), await createSearch(db(), { name: 'S' }));
    const unreachable = await recordDiscoveredBusiness(db(), run, found());
    await recordWebsiteStatus(db(), unreachable.businessId, { status: 'WEBSITE_UNREACHABLE', basis: 'NOT_OBSERVABLE', source: 'fetch timeout', checkedAt: T0 });
    expect(await refused(db(), () => evidenceFor(db(), unreachable.businessId, 'E-NO-WEBSITE', 'check.website_presence'))).toMatch(/needs website status WEBSITE_NOT_OBSERVED/);
    const none = await recordDiscoveredBusiness(db(), run, found({ domain: undefined }));
    await recordWebsiteStatus(db(), none.businessId, { status: 'WEBSITE_NOT_OBSERVED', basis: 'OBSERVED', source: 'business profile: no website field', checkedAt: T0 });
    const ev = await evidenceFor(db(), none.businessId, 'E-NO-WEBSITE', 'check.website_presence', 'https://directory.test/listing/1');
    expect(await one(db(), 'SELECT evidence_send_blocker($1, now()) AS r', [[ev]])).toEqual({ r: null });
    await db().query(`UPDATE businesses SET domain = 'found-later.test', website_status = 'WEBSITE_PRESENT', website_status_source = 'owner told us' WHERE id = $1`,
      [none.businessId]);
    expect((await one<{ r: string }>(db(), 'SELECT evidence_send_blocker($1, now()) AS r', [[ev]])).r).toMatch(/needs website status WEBSITE_NOT_OBSERVED but the business is now WEBSITE_PRESENT/);
  });
});

describe('WEBSITE and FIX opportunities live in one system', () => {
  it('lets one business hold both kinds, derives the kind from the service and refuses a contradiction', async () => {
    const run = await startSearchRun(db(), await createSearch(db(), { name: 'S' }));
    const b = await recordDiscoveredBusiness(db(), run, found({ domain: undefined, subvertical: 'plumbing' }));
    await recordWebsiteStatus(db(), b.businessId, { status: 'WEBSITE_NOT_OBSERVED', basis: 'OBSERVED', source: 'profile', checkedAt: T0 });
    const noSite = await evidenceFor(db(), b.businessId, 'E-NO-WEBSITE', 'check.website_presence', 'https://directory.test/l/2');
    const hours = await evidenceFor(db(), b.businessId);
    const site = (await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, build_kind, supported_issue_codes)
      VALUES ('website_build', 'Website Build', 'A new site', 'website', ARRAY['E-NO-WEBSITE']) RETURNING id`)).id;
    const mk = async (catalog: string, evidence: string, kind: string | null = null) => {
      const o = await one<{ id: string; opportunity_kind: string }>(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, opportunity_kind)
        VALUES ($1, 't', 'MAPPED', $2, $3) RETURNING id, opportunity_kind`, [b.businessId, catalog, kind]);
      await db().query('INSERT INTO opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2)', [o.id, evidence]);
      return o;
    };
    const w = await mk(site, noSite);
    const f = await mk(await catalogId(db(), 'lead_recovery_system'), hours);
    expect([w.opportunity_kind, f.opportunity_kind]).toEqual(['website', 'lead_recovery']);
    expect(await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, opportunity_kind)
      VALUES ($1, 't', 'MAPPED', $2, 'seo_improvement')`, [b.businessId, site])).toMatch(/contradicts its service, which builds website/);
    const feed = await listOpportunities(db());
    expect(feed.map((o) => [o.opportunityId, o.path, o.kind]).sort()).toEqual([[String(w.id), 'WEBSITE', 'website'], [String(f.id), 'FIX', 'lead_recovery']].sort());
    expect((await listOpportunities(db(), { paths: ['WEBSITE'] })).map((o) => o.opportunityId)).toEqual([String(w.id)]);
    expect((await listOpportunities(db(), { kinds: ['lead_recovery'] })).map((o) => o.opportunityId)).toEqual([String(f.id)]);
    // A workspace's own catalog item wins over the shared starter with the same key, with its own price band.
    const own = (await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, build_kind, supported_issue_codes, currency, price_low, price_high, price_source)
      VALUES ('lead_recovery_system', 'Lead Recovery (ours)', 'd', 'lead_recovery', ARRAY['E-24-7-CONTRADICTION'], 'GBP', 600, 800, 'seller price list') RETURNING id`)).id;
    const mine = await recordOpportunity(db(), { businessId: b.businessId, opportunityType: 't', evidenceIds: [hours],
      catalogKey: 'lead_recovery_system', servicePrice: 700, currency: 'GBP' });
    expect(await one(db(), 'SELECT catalog_item_id::text AS c FROM opportunities WHERE id = $1', [mine])).toEqual({ c: String(own) });
    // Every opportunity still needs evidence.
    expect(await failure(db(), `INSERT INTO opportunities (business_id, opportunity_type, mapping_status, catalog_item_id) VALUES ($1, 't', 'MAPPED', $2)`,
      [b.businessId, site])).toMatch(/has no evidence/);
  });
});
