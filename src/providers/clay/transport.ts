// How the Clay adapter reaches Clay. Two transports, one shape:
//
// - ClayMcpTransport calls Clay's hosted MCP server (https://api.clay.com/v3/mcp), the same
//   search-companies and load-more-search-results tools the Slice 10 validation batch was run
//   through. It sends the workspace's access token as a bearer header and nothing else; the token
//   arrives from the gateway's secret resolver for the length of one call.
// - RecordedClayTransport replays responses recorded from Clay (fixtures/providers/clay). It
//   makes no network call, and the gateway records its operations as transport 'recorded'.
//
// Both return Clay's page object unchanged; the adapter validates and normalizes it.
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

/** Maps a Clay tool error message to a normalized code. */
export function clayToolError(text: string): ProviderError {
  const t = text.slice(0, 300);
  if (/too many (concurrent )?requests|rate limit/i.test(t)) return new ProviderError('rate_limited', t);
  if (/unknown field|invalid|must start with|parse|syntax|not supported/i.test(t)) return new ProviderError('invalid_request', t);
  if (/unauthori[sz]ed|forbidden|permission|credential|sign in|log in/i.test(t)) return new ProviderError('auth', t);
  return new ProviderError('provider_unavailable', t);
}

// ------------------------------------------------------------------ recorded

export interface ClayRecording { query: string; pages: unknown[] }

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
}

// ------------------------------------------------------------------ live (Clay's hosted MCP server)

export const CLAY_MCP_ENDPOINT = 'https://api.clay.com/v3/mcp';
const PROTOCOL_VERSION = '2025-06-18';

export interface ClayMcpOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * A minimal MCP client over streamable HTTP: initialize, then one tools/call, per page. It speaks
 * only to the configured endpoint, sends only the bearer token and JSON-RPC bodies, and reads
 * either a JSON or an event-stream answer.
 */
export class ClayMcpTransport implements ClayTransport {
  readonly kind = 'live' as const;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(opts: ClayMcpOptions = {}) {
    this.endpoint = opts.endpoint ?? CLAY_MCP_ENDPOINT;
    const u = new URL(this.endpoint);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) {
      throw new Error('the Clay endpoint must be https');
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  searchCompanies(dsl: string, secret: string | null): Promise<unknown> {
    return this.callTool('search-companies', { dslQuery: dsl }, secret);
  }

  loadMore(taskId: string, secret: string | null): Promise<unknown> {
    return this.callTool('load-more-search-results', { taskId }, secret);
  }

  private async callTool(name: string, args: Record<string, unknown>, secret: string | null): Promise<unknown> {
    if (!secret) throw new ProviderError('auth', 'no credential for the live provider');
    const init = await this.rpc(secret, null, 'initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'scopely', version: '0.1.0' },
    });
    const session = init.session;
    await this.rpc(secret, session, 'notifications/initialized', undefined, true);
    const res = await this.rpc(secret, session, 'tools/call', { name, arguments: args });
    const result = res.message.result as { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown } | undefined;
    if (!result) throw new ProviderError('malformed_response', 'no result in the tool response');
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (result.isError) throw clayToolError(text || 'the tool reported an error');
    if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
    try { return JSON.parse(text); } catch { throw new ProviderError('malformed_response', 'the tool result is not JSON'); }
  }

  private async rpc(secret: string, session: string | null, method: string, params: unknown, notification = false):
    Promise<{ message: { result?: unknown; error?: { code: number; message: string } }; session: string | null }> {
    const id = notification ? undefined : this.nextId++;
    const headers: Record<string, string> = {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (session) headers['mcp-session-id'] = session;
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
      });
    } catch (err) {
      throw (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError' ? new ProviderError('timeout') : new ProviderError('network');
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `HTTP ${res.status}`);
    if (res.status === 429) throw new ProviderError('rate_limited', 'HTTP 429');
    if (res.status >= 500) throw new ProviderError('provider_unavailable', `HTTP ${res.status}`);
    if (res.status >= 400) throw new ProviderError('invalid_request', `HTTP ${res.status}`);
    const nextSession = res.headers.get('mcp-session-id') ?? session;
    if (notification) return { message: {}, session: nextSession };
    const body = await res.text();
    const messages: unknown[] = [];
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const block of body.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) { try { messages.push(JSON.parse(data)); } catch { /* not a JSON-RPC message */ } }
      }
    } else {
      try { messages.push(JSON.parse(body)); } catch { throw new ProviderError('malformed_response', 'the answer is not JSON'); }
    }
    const message = messages.flat().find((m) => (m as { id?: unknown }).id === id) as { result?: unknown; error?: { code: number; message: string } } | undefined;
    if (!message) throw new ProviderError('malformed_response', `no answer to ${method}`);
    if (message.error) throw clayToolError(String(message.error.message ?? 'error'));
    return { message, session: nextSession };
  }
}
