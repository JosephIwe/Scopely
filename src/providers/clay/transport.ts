// How the Clay adapter reaches Clay. Two transports, one shape:
//
// - ClayPublicApiTransport calls Clay's Public API (https://api.clay.com/public/v0) with the
//   workspace's own Public API key in the `clay-api-key` header, and nothing else: no bearer token,
//   no OAuth, no MCP endpoint and no credential proxy. The key arrives from the gateway's secret
//   resolver for the length of one call and is never logged, stored or put in an error.
// - RecordedClayTransport replays responses recorded from Clay (fixtures/providers/clay). It
//   makes no network call, and the gateway records its operations as transport 'recorded'.
//
// Both return a Clay page (taskId, an entity map, hasMore); the adapter validates and normalizes it.
import { readFileSync } from 'node:fs';
import { ProviderError } from '../gateway.js';

export interface ClayPage {
  taskId: string;
  companies: Record<string, unknown>;
  hasMore: boolean;
  timestampMs?: number;
}

export interface ClayTransport {
  readonly kind: 'live' | 'recorded';
  searchCompanies(dsl: string, secret: string | null): Promise<unknown>;
  loadMore(taskId: string, secret: string | null): Promise<unknown>;
  /** People currently at the given companies (domains or company profile URLs), filtered by a people query. */
  searchPeople(companyIdentifiers: string[], dsl: string, secret: string | null): Promise<unknown>;
}

/** Validates the parts of a Clay page Scopely relies on. */
export function asClayPage(v: unknown): ClayPage {
  const p = v as ClayPage;
  if (!p || typeof p !== 'object' || typeof p.taskId !== 'string' || !p.taskId || typeof p.hasMore !== 'boolean'
      || !p.companies || typeof p.companies !== 'object' || Array.isArray(p.companies)) {
    throw new ProviderError('malformed_response', 'the search result is missing taskId, hasMore or companies');
  }
  return p;
}

// ------------------------------------------------------------------ recorded

export interface ClayRecording { query: string; pages: unknown[]; companyIdentifiers?: string[] }

export class RecordedClayTransport implements ClayTransport {
  readonly kind = 'recorded' as const;
  constructor(private readonly recordings: ClayRecording[]) {}

  /** Loads recordings from a fixture file ({ searches: [{ query, pages }] }). */
  static fromFile(file: string): RecordedClayTransport {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { searches: ClayRecording[] };
    return new RecordedClayTransport(doc.searches);
  }

  async searchCompanies(dsl: string): Promise<unknown> {
    const r = this.recordings.find((x) => x.query === dsl);
    if (!r || !r.pages[0]) throw new ProviderError('not_recorded', 'no recording for this query');
    return structuredClone(r.pages[0]);
  }

  async loadMore(taskId: string): Promise<unknown> {
    for (const r of this.recordings) {
      const i = r.pages.findIndex((p) => (p as ClayPage).taskId === taskId);
      if (i >= 0) {
        if (!r.pages[i + 1]) throw new ProviderError('not_recorded', 'the next page was not recorded');
        return structuredClone(r.pages[i + 1]);
      }
    }
    throw new ProviderError('not_recorded', 'no recording for this page');
  }

  async searchPeople(companyIdentifiers: string[], dsl: string): Promise<unknown> {
    const key = [...companyIdentifiers].sort().join('\u0000');
    const r = this.recordings.find((x) => x.query === dsl && [...(x.companyIdentifiers ?? [])].sort().join('\u0000') === key);
    if (!r || !r.pages[0]) throw new ProviderError('not_recorded', 'no recording for this lookup');
    return structuredClone(r.pages[0]);
  }
}

// ------------------------------------------------------------------ live (Clay's Public API)

export const CLAY_PUBLIC_API_BASE = 'https://api.clay.com/public/v0';
/** Results asked for per page of a search (Clay allows 1 to 500). */
const DEFAULT_PAGE_SIZE = 25;

export interface ClayPublicApiOptions {
  baseUrl?: string;
  timeoutMs?: number;
  pageSize?: number;
  fetch?: typeof fetch;
}

/**
 * Clay's query-mode search over the Public API. A search is created from a Clay query
 * (POST /search/query-mode → search_id) and read page by page (POST /search/query-mode/{id}/run →
 * data, has_more). The search id is the page cursor Scopely keeps.
 *
 * Each run call advances Clay's iterator, so a run that may have reached Clay (a timeout, a lost
 * connection, a 5xx) is not retried: a retry could silently skip a page. A first page is safe to
 * retry because it starts a new search.
 */
export class ClayPublicApiTransport implements ClayTransport {
  readonly kind = 'live' as const;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClayPublicApiOptions = {}) {
    this.base = (opts.baseUrl ?? CLAY_PUBLIC_API_BASE).replace(/\/+$/, '');
    const u = new URL(this.base);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) {
      throw new Error('the Clay endpoint must be https');
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.pageSize = Math.min(Math.max(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1), 500);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async searchCompanies(dsl: string, secret: string | null): Promise<unknown> {
    const searchId = await this.createSearch(dsl, secret);
    return this.runSearch(searchId, secret);
  }

  async loadMore(taskId: string, secret: string | null): Promise<unknown> {
    try {
      return await this.runSearch(taskId, secret);
    } catch (err) {
      if (err instanceof ProviderError && err.code !== 'rate_limited' && err.retryable) throw new ProviderError(err.code, err.detail, false);
      throw err;
    }
  }

  /**
   * Not sent. Clay's Public API has no "people at these companies" call: the company has to be a
   * criterion inside the query itself, and the field that filters people by their current
   * company's exact domain is not confirmed from Clay's query reference yet. Until it is, a people
   * lookup is refused here rather than sent with a guessed filter that could return people at
   * another business.
   */
  async searchPeople(): Promise<unknown> {
    throw new ProviderError('invalid_request', 'people search by exact company is not enabled for the Clay Public API yet; nothing was sent');
  }

  /** GET /search/query-mode/reference: Clay's own description of its query language. Free, read-only. */
  async queryReference(secret: string | null): Promise<unknown> {
    return this.request('GET', '/search/query-mode/reference', undefined, secret);
  }

  private async createSearch(query: string, secret: string | null): Promise<string> {
    const r = await this.request('POST', '/search/query-mode', { query }, secret) as { search_id?: unknown } | null;
    const id = r && typeof r === 'object' ? r.search_id : undefined;
    if (typeof id !== 'string' || !id) throw new ProviderError('malformed_response', 'the search was not given a search_id');
    return id;
  }

  /** One page of a search, as a Clay page: the search id stays the cursor, rows keyed by Clay's entity id. */
  private async runSearch(searchId: string, secret: string | null): Promise<ClayPage> {
    const r = await this.request('POST', `/search/query-mode/${encodeURIComponent(searchId)}/run`, { limit: this.pageSize }, secret) as
      { data?: unknown; has_more?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.data) || typeof r.has_more !== 'boolean') {
      throw new ProviderError('malformed_response', 'the search page is missing data or has_more');
    }
    const rows: Record<string, unknown> = {};
    r.data.forEach((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      const rec = row as Record<string, unknown>;
      // Clay's entity id, under the names Clay's search results have used. A row without one is dropped by the normalizer.
      const raw = rec.entityId ?? rec.entity_id ?? rec.id;
      const entityId = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
      rows[entityId ?? `row-${i}`] = { ...rec, ...(entityId ? { entityId } : {}), order: typeof rec.order === 'number' ? rec.order : i + 1 };
    });
    if (r.data.length && !Object.values(rows).some((x) => (x as { entityId?: string }).entityId)) {
      throw new ProviderError('malformed_response', 'the search rows carry no entity id');
    }
    return { taskId: searchId, companies: rows, hasMore: r.has_more };
  }

  private async request(method: 'GET' | 'POST', path: string, body: unknown, secret: string | null): Promise<unknown> {
    if (!secret) throw new ProviderError('auth', 'no credential for the live provider');
    const headers: Record<string, string> = { accept: 'application/json', 'clay-api-key': secret };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError' ? new ProviderError('timeout') : new ProviderError('network');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw clayHttpError(res.status, text, secret);
    try { return text ? JSON.parse(text) : null; } catch { throw new ProviderError('malformed_response', 'the answer is not JSON'); }
  }
}

/**
 * A Clay Public API failure in Scopely's words. The detail is Clay's own short message, with the
 * key removed if Clay ever echoed it; the gateway also drops any detail that looks like a credential.
 */
export function clayHttpError(status: number, body: string, secret: string | null): ProviderError {
  let message = '';
  try { const j = JSON.parse(body) as { message?: unknown; error?: unknown }; message = String(j.message ?? j.error ?? ''); } catch { /* not JSON */ }
  if (secret) message = message.split(secret).join('[redacted]');
  const detail = `HTTP ${status}${message ? `: ${message.slice(0, 240)}` : ''}`;
  if (status === 401 || status === 403) return new ProviderError('auth', detail);
  if (status === 429) return new ProviderError('rate_limited', detail);
  if (status >= 500) return new ProviderError('provider_unavailable', detail);
  return new ProviderError('invalid_request', detail);
}
