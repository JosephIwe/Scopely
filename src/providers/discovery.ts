// Business discovery through a provider: SEARCH -> PROVIDER DISCOVERY -> NORMALIZE -> DEDUPLICATE
// -> ICP FILTER, inside one search run of one workspace.
//
// The domain depends on BusinessDiscoveryProvider, never on a provider. An adapter plans the
// provider request from the run's frozen criteria, fetches pages and normalizes each result into a
// DiscoveredBusiness; the gateway records every call; recordDiscoveredBusiness deduplicates against
// this workspace's own businesses; prequalifyRun applies the seller's ICP. Nothing is enriched
// here: FIND MANY, QUALIFY, then analyse fewer.
import type { SecretResolver } from '../build/agents.js';
import { criteriaFromRow, prequalifyRun, recordDiscoveredBusiness, type DiscoveredBusiness, type PrequalifyCounts, type SearchCriteria } from '../discovery/index.js';
import type { Db } from '../tenancy/index.js';
import { type CallCredential, type GatewayOptions, PROVIDER_ERROR_WORDS, type ProviderCost, type ProviderErrorCode, type OperationOutcome, callProvider, connectionCredential } from './gateway.js';

/** A business as a provider returned it, normalized, with the provider's own record of it. */
export interface ProviderBusiness extends DiscoveredBusiness {
  source: DiscoveredBusiness['source'] & { record: Record<string, unknown> };
}

export interface DiscoveryPage {
  businesses: ProviderBusiness[];
  /** Opaque cursor for the next page, or null when the provider has no more. */
  next: string | null;
  /** The provider's own reference for this call. */
  ref: string | null;
  cost?: ProviderCost | null;
}

/** The BusinessDiscoveryProvider capability. One adapter per provider implements it. */
export interface BusinessDiscoveryProvider {
  readonly provider: string;
  readonly transport: 'live' | 'recorded';
  /** What a person sees as this provider's name. */
  readonly label: string;
  /**
   * The provider request for a search, or why this search cannot be sent to this provider (for
   * example it sets nothing the provider can filter on, which would pull an unbounded list).
   */
  plan(criteria: SearchCriteria): { request: Record<string, unknown> } | { refused: string };
  page(request: Record<string, unknown>, cursor: string | null, credential: CallCredential | null): Promise<DiscoveryPage>;
}

export class DiscoveryProviderRegistry {
  private readonly providers = new Map<string, BusinessDiscoveryProvider>();
  register(p: BusinessDiscoveryProvider): this {
    if (this.providers.has(p.provider)) throw new Error(`a discovery provider for ${p.provider} is already registered`);
    this.providers.set(p.provider, p);
    return this;
  }
  get(provider: string): BusinessDiscoveryProvider | null { return this.providers.get(provider) ?? null; }
  list(): BusinessDiscoveryProvider[] { return [...this.providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)); }
}

/**
 * Ceiling on businesses one provider run may pull, whatever the search allows. The CTO brief's
 * validation batch is 20 to 100 businesses: no larger pull until the economics are measured.
 */
export const PROVIDER_DISCOVERY_CEILING = 100;

export class DiscoveryRefused extends Error {
  constructor(readonly reason: 'no_provider' | 'no_limit' | 'not_searchable' | 'not_connected' | 'run_closed', message: string) { super(message); }
}

export interface DiscoveryDeps extends GatewayOptions {
  providers: DiscoveryProviderRegistry;
  secrets?: SecretResolver;
  ceiling?: number;
}

export interface ProviderDiscoveryResult {
  provider: string;
  transport: 'live' | 'recorded';
  operations: number;
  /** Rows the provider returned, including repeats. */
  returned: number;
  /** Businesses added to this run. */
  discovered: number;
  /** Of those, businesses this workspace did not know before. */
  newBusinesses: number;
  /** Returned businesses this workspace already held (matched by company number, domain or provider id). */
  knownBusinesses: number;
  /** Rows the provider returned more than once in this run. */
  repeatedInRun: number;
  limit: number;
  stoppedBy: 'limit' | 'exhausted' | 'error';
  error: { code: ProviderErrorCode; message: string } | null;
  qualification: PrequalifyCounts;
}

/**
 * Runs a provider discovery for a search run and pre-qualifies what it found. Every provider call
 * is a provider_operations row; a failure stops the run where it is and keeps what was found.
 */
export async function runProviderDiscovery(db: Db, deps: DiscoveryDeps, runId: string, providerKey: string,
  asOf = new Date()): Promise<ProviderDiscoveryResult> {
  const provider = deps.providers.get(providerKey);
  if (!provider) throw new DiscoveryRefused('no_provider', `No discovery provider ${providerKey} is available.`);
  // Another workspace's run reads as missing, so its criteria never reach this workspace's provider.
  const run = (await db.query(`SELECT criteria, max_discovered_per_run, status,
      (SELECT count(*) FROM scopely.search_run_businesses WHERE search_run_id = r.id) AS held
      FROM scopely.search_runs r WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [runId])).rows[0];
  if (!run) throw new DiscoveryRefused('no_provider', `Search run ${runId} does not exist in this workspace.`);
  if (run.status !== 'OPEN') throw new DiscoveryRefused('run_closed', 'This search run is closed. Start a new run to find more businesses.');
  if (run.max_discovered_per_run === null) {
    throw new DiscoveryRefused('no_limit', 'Set how many businesses a run may find before searching a provider.');
  }
  const ceiling = Math.min(deps.ceiling ?? PROVIDER_DISCOVERY_CEILING, PROVIDER_DISCOVERY_CEILING);
  const limit = Math.max(0, Math.min(Number(run.max_discovered_per_run), ceiling) - Number(run.held));
  const planned = provider.plan(criteriaFromRow(run.criteria));
  if ('refused' in planned) throw new DiscoveryRefused('not_searchable', planned.refused);

  let credential: CallCredential | null = null;
  if (provider.transport === 'live') {
    credential = await connectionCredential(db, provider.provider, 'discovery', deps.secrets);
    if (!credential) throw new DiscoveryRefused('not_connected', `Connect this workspace’s ${provider.label} account before searching it.`);
  }

  const out: ProviderDiscoveryResult = {
    provider: provider.provider, transport: provider.transport, operations: 0, returned: 0, discovered: 0, newBusinesses: 0,
    knownBusinesses: 0, repeatedInRun: 0, limit, stoppedBy: 'exhausted', error: null, qualification: { qualified: 0, rejected: 0, needsReview: 0 },
  };
  let cursor: string | null = null;
  let pageNo = 0;
  while (out.discovered < limit) {
    const request = planned.request;
    const call: OperationOutcome<DiscoveryPage> = await callProvider<DiscoveryPage>(db, {
      provider: provider.provider, capability: 'business_discovery', operation: cursor === null ? 'search' : 'search_next_page',
      transport: provider.transport, credential, request: { request, page: pageNo }, searchRunId: runId,
      meta: { page: pageNo },
    }, async () => {
      const p = await provider.page(request, cursor, credential);
      return { value: p, ref: p.ref, resultCount: p.businesses.length, cost: p.cost ?? null };
    }, deps);
    out.operations += 1;
    if (!call.result.ok) {
      out.stoppedBy = 'error';
      out.error = { code: call.result.error.code, message: PROVIDER_ERROR_WORDS[call.result.error.code] };
      break;
    }
    const page: DiscoveryPage = call.result.value;
    for (const b of page.businesses) {
      if (out.discovered >= limit) { out.stoppedBy = 'limit'; break; }
      out.returned += 1;
      const rec = await recordDiscoveredBusiness(db, runId, { ...b, source: { ...b.source, operationId: call.operationId } });
      if (!rec.newInRun) { out.repeatedInRun += 1; continue; }
      out.discovered += 1;
      if (rec.matchedBy === 'new') out.newBusinesses += 1; else out.knownBusinesses += 1;
    }
    if (out.stoppedBy === 'limit') break;
    if (out.discovered >= limit) { out.stoppedBy = 'limit'; break; }
    if (!page.next) break;
    cursor = page.next;
    pageNo += 1;
  }
  if (limit === 0) out.stoppedBy = 'limit';
  out.qualification = await prequalifyRun(db, runId, asOf);
  return out;
}
