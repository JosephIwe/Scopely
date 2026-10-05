// The provider gateway (Slice 10): the one place a call to an external data provider is made,
// timed, retried when that is safe, normalized when it fails, and recorded in provider_operations.
//
// Scopely's domain never sees a provider's API. An adapter (src/providers/clay) turns a capability
// request into the provider's call and the provider's answer into Scopely's own shapes; this file
// only knows that a call happened, how it went and what the provider said it cost. A cost the
// provider does not report is NOT_REPORTED, never 0, and nothing here invents a price.
//
// Credentials: a live call names a provider connection of the current workspace; the key behind
// its credential_ref is resolved inside the call, in memory, and never returned, logged or stored.
import { createHash } from 'node:crypto';
import type { SecretResolver } from '../build/agents.js';
import type { Db } from '../tenancy/index.js';

export type ProviderErrorCode = 'auth' | 'rate_limited' | 'invalid_request' | 'not_recorded' | 'provider_unavailable'
  | 'timeout' | 'network' | 'malformed_response';

/** Retrying these cannot change what a read-only call does; the others would fail the same way again. */
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['rate_limited', 'provider_unavailable', 'timeout', 'network']);

/** A provider failure in Scopely's words. `detail` is a short provider message, never a credential. */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code);
  }
  get retryable(): boolean { return RETRYABLE.has(this.code); }
}

/** What the person sees when a provider call fails. Never the provider's raw text. */
export const PROVIDER_ERROR_WORDS: Record<ProviderErrorCode, string> = {
  auth: 'The provider refused the workspace’s credential. Reconnect it and try again.',
  rate_limited: 'The provider is limiting requests right now. Try again in a few minutes.',
  invalid_request: 'The provider could not run this search. Check the search’s industries and location.',
  not_recorded: 'This search has no recorded provider response. Recorded mode only replays searches that were recorded.',
  provider_unavailable: 'The provider is unavailable right now. Try again later.',
  timeout: 'The provider took too long to answer.',
  network: 'Scopely could not reach the provider.',
  malformed_response: 'The provider answered in a shape Scopely does not recognise, so nothing was recorded.',
};

/** Who pays for a live call and how its credential is used. Recorded calls have neither. */
export interface CallCredential {
  connectionId: string;
  billedTo: 'SCOPELY' | 'WORKSPACE';
  /** Runs `use` with the secret in memory. The secret never leaves `use`. */
  withSecret<T>(use: (secret: string) => Promise<T>): Promise<T>;
}

export interface ProviderCost { credits?: number | null; amount?: number | null; currency?: string | null }

export interface OperationSpec {
  provider: string;
  capability: 'business_discovery' | 'prospect_intelligence';
  operation: string;
  transport: 'live' | 'recorded';
  credential: CallCredential | null;
  /** What was asked, for the request digest. Never include a credential. */
  request: unknown;
  searchRunId?: string | null;
  businessId?: string | null;
  opportunityId?: string | null;
  meta?: Record<string, unknown>;
}

export interface OperationOutcome<T> {
  /** The value, or the normalized failure. */
  result: { ok: true; value: T } | { ok: false; error: ProviderError };
  operationId: string;
  latencyMs: number;
  attempts: number;
}

export interface GatewayOptions {
  /** Attempts for a retryable failure, including the first (1 to 5). */
  maxAttempts?: number;
  /** Waits between attempts; injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** sha256 of a canonical JSON form (sorted keys), so the same request always digests the same. */
export function requestDigest(request: unknown): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
  return createHash('sha256').update(JSON.stringify(canon(request) ?? null)).digest('hex');
}

/** Turns anything a transport throws into a ProviderError; an unknown failure is a network failure. */
export function asProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return new ProviderError('timeout');
  return new ProviderError('network');
}

/**
 * Runs one provider call through the gateway and records it, success or failure, as one
 * provider_operations row. `fn` returns the value and what the provider reported about the call
 * (its own reference, result count and cost). Retries only retryable failures of read-only calls.
 */
export async function callProvider<T>(db: Db, spec: OperationSpec, fn: () => Promise<{ value: T; ref?: string | null; resultCount: number; cost?: ProviderCost | null }>,
  opts: GatewayOptions = {}): Promise<OperationOutcome<T>> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = Math.min(Math.max(opts.maxAttempts ?? 3, 1), 5);
  const started = now();
  const t0 = performance.now();
  let attempts = 0;
  let out: Awaited<ReturnType<typeof fn>> | null = null;
  let error: ProviderError | null = null;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      out = await fn();
      error = null;
      break;
    } catch (err) {
      error = asProviderError(err);
      if (!error.retryable || attempts >= maxAttempts) break;
      await sleep(500 * 2 ** (attempts - 1));
    }
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - t0));
  const completed = new Date(Math.max(now().getTime(), started.getTime()));
  const cost = out?.cost ?? null;
  const reported = cost !== null && (cost.credits != null || cost.amount != null);
  const r = await db.query<{ id: string }>(
    `INSERT INTO scopely.provider_operations (provider, capability, operation, transport, provider_connection_id, billed_to,
       search_run_id, business_id, opportunity_id, request_ref, request_sha256, status, error_code, error_detail, attempts,
       started_at, completed_at, latency_ms, result_count, cost_basis, provider_credits, provider_cost_amount, provider_cost_currency, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       -- A provider's error text that looks like a credential is dropped, not stored; the guard stays the backstop.
       CASE WHEN scopely.looks_like_secret($14::text) THEN '[redacted]' ELSE $14 END,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
    [spec.provider, spec.capability, spec.operation, spec.transport, spec.credential?.connectionId ?? null, spec.credential?.billedTo ?? null,
     spec.searchRunId ?? null, spec.businessId ?? null, spec.opportunityId ?? null, out?.ref ?? null, requestDigest(spec.request),
     error ? 'FAILED' : 'SUCCEEDED', error?.code ?? null, error?.detail ? error.detail.slice(0, 300) : null, attempts,
     started.toISOString(), completed.toISOString(), latencyMs, error ? null : out!.resultCount,
     reported ? 'REPORTED' : 'NOT_REPORTED', reported ? cost!.credits ?? null : null, reported ? cost!.amount ?? null : null,
     reported && cost!.amount != null ? cost!.currency ?? null : null, JSON.stringify(spec.meta ?? {})]);
  const operationId = r.rows[0]!.id;
  return { result: error ? { ok: false, error } : { ok: true, value: out!.value }, operationId, latencyMs, attempts };
}

/**
 * The workspace's ACTIVE connection for a provider and scope, as a credential the gateway can use.
 * Returns null when there is none. The credential_ref is read here and passed only to the resolver.
 */
export async function connectionCredential(db: Db, provider: string, scope: 'discovery' | 'prospects', secrets: SecretResolver | undefined): Promise<CallCredential | null> {
  const c = (await db.query(
    `SELECT id, mode, credential_ref FROM scopely.provider_connections
      WHERE workspace_id = scopely.current_workspace_id() AND provider = $1 AND state = 'ACTIVE' AND $2 = ANY (scopes)
      ORDER BY activated_at DESC, id DESC LIMIT 1`, [provider, scope])).rows[0];
  if (!c || !secrets) return null;
  // Scopely holds no provider account of its own for discovery or prospect lookups (B20); only the workspace's key is used.
  if (c.mode !== 'CUSTOMER_KEY' || !c.credential_ref) return null;
  const ref: string = c.credential_ref;
  return {
    connectionId: String(c.id),
    billedTo: 'WORKSPACE',
    withSecret: (use) => secrets.withSecret(ref, use),
  };
}
