// Read model for a provider-backed search run (Slice 10): what each provider call did and cost,
// and the run's businesses in priority order with where each one came from.
//
// Priority is a deterministic rule, not a score anyone tuned: businesses already selected first,
// then QUALIFIED, then NEEDS_REVIEW (fewest unknown criteria first), then REJECTED; within a group,
// more criteria passed, then a known website address (it can be analysed), then name.
import type { Db } from '../tenancy/index.js';
import type { CriterionResult, RunBusinessState } from './types.js';

const WS = 'workspace_id = scopely.current_workspace_id()';

export interface ProviderOperationView {
  operationId: string;
  provider: string;
  operation: string;
  transport: 'live' | 'recorded';
  status: 'SUCCEEDED' | 'FAILED';
  errorCode: string | null;
  attempts: number;
  startedAt: string;
  latencyMs: number;
  resultCount: number | null;
  costBasis: 'REPORTED' | 'NOT_REPORTED';
  providerCredits: string | null;
  providerCost: { amount: string; currency: string } | null;
  billedTo: 'SCOPELY' | 'WORKSPACE' | null;
}

export interface RunDiscoveryBusiness {
  businessId: string;
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  vertical: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  employees: { count: number | null; min: number | null; max: number | null; basis: string | null; source: string | null };
  websiteStatus: string;
  state: RunBusinessState;
  failedStage: string | null;
  unknownStages: string[];
  qualification: CriterionResult[] | null;
  /** 1 is the first business to look at. */
  priority: number;
  /** Where the business came from: the provider, its id for the business, and when it said so. */
  provenance: { provider: string | null; reference: string; observedAt: string; operationId: string | null; transport: string | null; basis: 'PROVIDER_REPORTED' | 'RECORDED_BY_PERSON' } | null;
  /** Whether another of this workspace's runs or records already held the business. */
  knownBefore: boolean;
}

export interface RunDiscoveryView {
  searchRunId: string;
  searchId: string;
  searchName: string;
  status: string;
  maxDiscoveredPerRun: number | null;
  maxBusinessesToAnalyze: number | null;
  operations: ProviderOperationView[];
  economics: {
    operations: number;
    failed: number;
    results: number;
    /** Results Scopely kept as businesses of this run (repeats removed). */
    discovered: number;
    totalLatencyMs: number;
    /** NOT_REPORTED when any call of the run had no reported cost: a partial sum is never shown as a total. */
    costBasis: 'REPORTED' | 'NOT_REPORTED' | 'NONE';
    providerCredits: string | null;
  };
  counts: Record<string, number>;
  businesses: RunDiscoveryBusiness[];
}

const STATE_GROUP: Record<string, number> = {
  SELECTED: 0, ANALYSIS_QUEUED: 0, ANALYZED: 0, OPPORTUNITY_FOUND: 0, NO_OPPORTUNITY: 0,
  QUALIFIED: 1, NEEDS_REVIEW: 2, DISCOVERED: 3, REJECTED: 4,
};

export async function getRunDiscovery(db: Db, runId: string): Promise<RunDiscoveryView | null> {
  const run = (await db.query(`SELECT r.id, r.search_id, s.name, r.status, r.max_discovered_per_run, r.max_businesses_to_analyze
      FROM scopely.search_runs r JOIN scopely.searches s ON s.id = r.search_id WHERE r.id = $1 AND r.${WS}`, [runId])).rows[0];
  if (!run) return null;
  const ops = (await db.query(`SELECT * FROM scopely.provider_operations WHERE search_run_id = $1 AND ${WS} ORDER BY started_at, id`, [runId])).rows;
  const rows = (await db.query(
    `SELECT rb.business_id, rb.state, rb.failed_stage, rb.unknown_stages, rb.qualification,
            b.name, b.domain, b.website_url, b.vertical, b.city, b.region, b.country_code, b.website_status,
            b.employee_count, b.employee_count_min, b.employee_count_max, b.employees_basis, b.employees_source,
            src.provider, src.ref, src.found_at, src.provider_operation_id, op.transport,
            EXISTS (SELECT 1 FROM scopely.sources o WHERE o.business_id = b.id AND o.${WS}
                     AND (o.search_run_id IS DISTINCT FROM rb.search_run_id) AND o.found_at <= src.found_at) AS known_before
       FROM scopely.search_run_businesses rb
       JOIN scopely.businesses b ON b.id = rb.business_id
       LEFT JOIN scopely.sources src ON src.id = rb.source_id
       LEFT JOIN scopely.provider_operations op ON op.id = src.provider_operation_id
      WHERE rb.search_run_id = $1 AND rb.${WS}`, [runId])).rows;

  const passes = (q: CriterionResult[] | null) => (q ?? []).filter((c) => c.verdict === 'pass').length;
  rows.sort((a, b) => (STATE_GROUP[a.state] ?? 9) - (STATE_GROUP[b.state] ?? 9)
    || (a.unknown_stages?.length ?? 0) - (b.unknown_stages?.length ?? 0)
    || passes(b.qualification) - passes(a.qualification)
    || Number(b.domain !== null) - Number(a.domain !== null)
    || String(a.name).localeCompare(String(b.name)));

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const reported = ops.filter((o) => o.cost_basis === 'REPORTED');
  return {
    searchRunId: String(run.id), searchId: String(run.search_id), searchName: run.name, status: run.status,
    maxDiscoveredPerRun: run.max_discovered_per_run, maxBusinessesToAnalyze: run.max_businesses_to_analyze,
    operations: ops.map((o) => ({
      operationId: String(o.id), provider: o.provider, operation: o.operation, transport: o.transport, status: o.status, errorCode: o.error_code,
      attempts: o.attempts, startedAt: new Date(o.started_at).toISOString(), latencyMs: o.latency_ms, resultCount: o.result_count,
      costBasis: o.cost_basis, providerCredits: o.provider_credits === null ? null : String(o.provider_credits),
      providerCost: o.provider_cost_amount === null ? null : { amount: String(o.provider_cost_amount), currency: o.provider_cost_currency },
      billedTo: o.billed_to,
    })),
    economics: {
      operations: ops.length,
      failed: ops.filter((o) => o.status === 'FAILED').length,
      results: ops.reduce((s, o) => s + (o.result_count ?? 0), 0),
      discovered: rows.length,
      totalLatencyMs: ops.reduce((s, o) => s + o.latency_ms, 0),
      costBasis: ops.length === 0 ? 'NONE' : reported.length === ops.length ? 'REPORTED' : 'NOT_REPORTED',
      providerCredits: ops.length > 0 && reported.length === ops.length
        ? String(reported.reduce((s, o) => s + Number(o.provider_credits ?? 0), 0)) : null,
    },
    counts,
    businesses: rows.map((r, i) => ({
      businessId: String(r.business_id), name: r.name, domain: r.domain, websiteUrl: r.website_url, vertical: r.vertical,
      city: r.city, region: r.region, countryCode: r.country_code,
      employees: { count: r.employee_count, min: r.employee_count_min, max: r.employee_count_max, basis: r.employees_basis, source: r.employees_source },
      websiteStatus: r.website_status, state: r.state, failedStage: r.failed_stage, unknownStages: r.unknown_stages ?? [],
      qualification: r.qualification, priority: i + 1,
      provenance: r.ref === null ? null : {
        provider: r.provider, reference: r.ref, observedAt: new Date(r.found_at).toISOString(),
        operationId: r.provider_operation_id === null ? null : String(r.provider_operation_id), transport: r.transport,
        basis: r.provider_operation_id === null ? 'RECORDED_BY_PERSON' : 'PROVIDER_REPORTED',
      },
      knownBefore: r.known_before,
    })),
  };
}

/** Live provider economics for the workspace, per provider and transport. Recorded replays stay separate. */
export async function getProviderEconomics(db: Db): Promise<Record<string, unknown>[]> {
  const r = await db.query(`SELECT * FROM scopely.v_provider_economics WHERE ${WS} ORDER BY provider, capability, transport`);
  return r.rows.map((x) => ({
    provider: x.provider, capability: x.capability, transport: x.transport, operations: Number(x.operations), failed: Number(x.failed),
    results: Number(x.results), avgLatencyMs: x.avg_latency_ms, p50LatencyMs: x.p50_latency_ms, maxLatencyMs: x.max_latency_ms,
    costReportedOperations: Number(x.cost_reported_operations), providerCredits: x.provider_credits === null ? null : String(x.provider_credits),
    firstAt: new Date(x.first_at).toISOString(), lastAt: new Date(x.last_at).toISOString(),
  }));
}
