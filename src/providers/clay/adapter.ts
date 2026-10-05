// ClayBusinessDiscoveryAdapter: the BusinessDiscoveryProvider capability, backed by Clay's company
// search. Clay concepts (its DSL, task ids, size buckets, record fields) stop here.
import type { SearchCriteria } from '../../discovery/index.js';
import type { BusinessDiscoveryProvider, DiscoveryPage } from '../discovery.js';
import type { CallCredential } from '../gateway.js';
import { normalizeClayCompany } from './normalize.js';
import { clayCompanyQuery } from './query.js';
import { type ClayTransport, asClayPage } from './transport.js';

export class ClayBusinessDiscoveryAdapter implements BusinessDiscoveryProvider {
  readonly provider = 'clay';
  readonly label = 'Clay';
  readonly transport: 'live' | 'recorded';

  constructor(private readonly t: ClayTransport, private readonly now: () => Date = () => new Date()) {
    this.transport = t.kind;
  }

  plan(criteria: SearchCriteria): { request: Record<string, unknown> } | { refused: string } {
    const q = clayCompanyQuery(criteria);
    if ('refused' in q) return q;
    return { request: { dsl: q.dsl, pushedDown: q.pushedDown } };
  }

  async page(request: Record<string, unknown>, cursor: string | null, credential: CallCredential | null): Promise<DiscoveryPage> {
    const dsl = String(request.dsl);
    const call = (secret: string | null) => (cursor ? this.t.loadMore(cursor, secret) : this.t.searchCompanies(dsl, secret));
    const raw = credential ? await credential.withSecret((s) => call(s)) : await call(null);
    const page = asClayPage(raw);
    // When Clay answered, from its own clock where it gives one.
    const observedAt = (typeof page.timestampMs === 'number' && Number.isFinite(page.timestampMs) ? new Date(page.timestampMs) : this.now()).toISOString();
    const rows = Object.values(page.companies)
      .sort((a, b) => Number((a as { order?: number }).order ?? 0) - Number((b as { order?: number }).order ?? 0));
    const businesses = rows.map((r) => normalizeClayCompany(r, observedAt)).filter((b): b is NonNullable<typeof b> => b !== null);
    // Clay reports no credit cost for a company search, so the cost stays NOT_REPORTED.
    return { businesses, next: page.hasMore ? page.taskId : null, ref: page.taskId, cost: null };
  }
}
