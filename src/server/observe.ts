// Production observability, the minimum before real prospect data enters Scopely (P2).
//
// Rule 11 holds here too: an error report carries stable ids and code locations, never a value a
// request or a page supplied. An error's message is dropped, because Postgres puts row values in it
// ("Key (domain)=(clinic.co.uk) already exists") and other errors quote input. What a report keeps:
// the error class, the Postgres code / constraint / table names (schema, not data), the stack's code
// locations, the route with ids replaced, the request id, and the workspace and user ids.
//
// Reporting is off unless SCOPELY_ERROR_DSN is set. The DSN is a Sentry-format DSN
// (https://<public key>@<host>/<project id>), which Sentry's free tier and self-hosted
// GlitchTip both accept; events are posted to its envelope endpoint with no SDK dependency.
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ErrorReport {
  requestId: string | null;
  /** The route with numeric ids and tokens replaced: /api/opportunities/:id/outcomes. Never a query string. */
  route: string | null;
  method: string | null;
  status: number | null;
  workspaceId: string | null;
  userId: string | null;
  error: ErrorShape;
  /** 'request' for a failed request, 'process' for an unhandled rejection or exception. */
  source: 'request' | 'process';
}

export interface ErrorShape {
  name: string;
  /** Postgres SQLSTATE or a Node error code, when the error has one. */
  code: string | null;
  constraint: string | null;
  table: string | null;
  /** "function file:line" for up to 8 frames, files relative to the app root. */
  frames: string[];
}

export interface ErrorReporter {
  readonly name: string;
  report(e: ErrorReport): void;
}

/** A short random id for one request, sent back as x-request-id and in a 500 body so a person can quote it. */
export function newRequestId(): string { return randomBytes(6).toString('hex'); }

/** A path with every numeric id and long token replaced, safe to log and to group errors by. */
export function routeOf(pathname: string): string {
  return pathname.split('/').map((s) => (/^\d+$/.test(s) ? ':id' : s.length >= 20 && /^[A-Za-z0-9_.-]+$/.test(s) ? ':token' : s)).join('/');
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CODE = /^[0-9A-Z_]{2,32}$/;
const IDENT = /^[a-z_][a-z0-9_.]{0,80}$/;

/** What may leave the process about an error: never its message, detail, hint or parameters. */
export function describeError(err: unknown): ErrorShape {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; constraint?: unknown; table?: unknown; stack?: unknown; constructor?: { name?: string } };
  const rawName = typeof e.name === 'string' && e.name !== 'Error' ? e.name : e.constructor?.name ?? 'Error';
  const name = /^[A-Za-z_$][\w$]{0,60}$/.test(rawName) ? rawName : 'Error';
  const pick = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
  const frames: string[] = [];
  if (typeof e.stack === 'string') {
    for (const line of e.stack.split('\n').slice(1)) {
      const m = /^\s*at (?:(.+?) \()?(?:file:\/\/)?(.+?):(\d+):\d+\)?$/.exec(line);
      if (!m) continue;
      const file = m[2]!.startsWith(ROOT) ? path.relative(ROOT, m[2]!) : m[2]!.startsWith('node:') ? m[2]! : path.basename(m[2]!);
      const fn = m[1] && /^[\w$.<> \[\]]{1,80}$/.test(m[1]) ? `${m[1]} ` : '';
      frames.push(`${fn}${file}:${m[3]}`);
      if (frames.length === 8) break;
    }
  }
  return { name, code: pick(e.code, CODE), constraint: pick(e.constraint, IDENT), table: pick(e.table, IDENT), frames };
}

/** One actionable log line: what failed, where, and the ids needed to find it. key=value, no free text. */
export function errorLine(r: ErrorReport): string {
  const kv = { rid: r.requestId, ws: r.workspaceId, user: r.userId, status: r.status, err: r.error.name, constraint: r.error.constraint,
    table: r.error.table, at: r.error.frames[0]?.split(' ').pop() ?? null };
  const tail = Object.entries(kv).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${String(v).replace(/\s/g, '_')}`).join(' ');
  const head = r.source === 'process' ? 'error process' : `error ${r.method} ${r.route}`;
  return `${head} ${r.error.code ?? '-'} ${tail}`.trim();
}

interface Dsn { endpoint: string; key: string }

/** Parses a Sentry-format DSN; anything else is refused at startup rather than silently ignored. */
export function parseDsn(dsn: string): Dsn {
  let u: URL;
  try { u = new URL(dsn); } catch { throw new Error('SCOPELY_ERROR_DSN is not a URL. Use the DSN your error tracker shows, https://<key>@<host>/<project id>.'); }
  const project = u.pathname.replace(/^\/+|\/+$/g, '');
  if (u.protocol !== 'https:' || !u.username || !/^[\w-]+$/.test(project.split('/').pop() ?? '')) {
    throw new Error('SCOPELY_ERROR_DSN must look like https://<key>@<host>/<project id>.');
  }
  const prefix = project.includes('/') ? `/${project.slice(0, project.lastIndexOf('/'))}` : '';
  return { endpoint: `https://${u.host}${prefix}/api/${project.split('/').pop()}/envelope/`, key: u.username };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/** Posts each report as a Sentry envelope. Never throws, never blocks a request, at most `perMinute` events. */
export class EnvelopeReporter implements ErrorReporter {
  readonly name = 'envelope';
  private readonly dsn: Dsn;
  private windowStart = 0;
  private sent = 0;
  dropped = 0;

  constructor(dsn: string, private readonly opts: { environment: string; release: string | null; fetch?: FetchLike; perMinute?: number; now?: () => number } = { environment: 'production', release: null }) {
    this.dsn = parseDsn(dsn);
  }

  /** The envelope exactly as sent; exposed so tests can prove what leaves the process. */
  envelope(r: ErrorReport, eventId = randomUUID().replace(/-/g, '')): string {
    const event = {
      event_id: eventId,
      timestamp: (this.opts.now?.() ?? Date.now()) / 1000,
      platform: 'node',
      level: 'error',
      logger: 'scopely',
      environment: this.opts.environment,
      ...(this.opts.release ? { release: this.opts.release } : {}),
      transaction: r.route ? `${r.method} ${r.route}` : r.source,
      tags: Object.fromEntries(Object.entries({ request_id: r.requestId, route: r.route, method: r.method, status: r.status, pg_code: r.error.code,
        constraint: r.error.constraint, table: r.error.table, workspace_id: r.workspaceId, source: r.source }).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)])),
      ...(r.userId ? { user: { id: r.userId } } : {}),
      exception: { values: [{ type: r.error.name, value: `${r.error.name}${r.error.code ? ` ${r.error.code}` : ''}`,
        stacktrace: { frames: r.error.frames.slice().reverse().map((f) => { const [fn, loc] = f.includes(' ') ? [f.slice(0, f.lastIndexOf(' ')), f.slice(f.lastIndexOf(' ') + 1)] : [null, f];
          const i = loc.lastIndexOf(':'); return { filename: loc.slice(0, i), lineno: Number(loc.slice(i + 1)), ...(fn ? { function: fn } : {}) }; }) } }] },
    };
    return `${JSON.stringify({ event_id: eventId, sent_at: new Date(event.timestamp * 1000).toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
  }

  report(r: ErrorReport): void {
    const now = this.opts.now?.() ?? Date.now();
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.sent = 0; }
    if (this.sent >= (this.opts.perMinute ?? 30)) { this.dropped++; return; }
    this.sent++;
    const f = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    void f(this.dsn.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.dsn.key}, sentry_client=scopely/0.1` },
      body: this.envelope(r),
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  }
}

/** The reporter the environment asks for, or null when reporting is off (SCOPELY_ERROR_DSN unset). */
export function reporterFromEnv(env: NodeJS.ProcessEnv = process.env): ErrorReporter | null {
  const dsn = env.SCOPELY_ERROR_DSN?.trim();
  if (!dsn) return null;
  return new EnvelopeReporter(dsn, { environment: env.SCOPELY_ENV === 'production' ? 'production' : 'development', release: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? null });
}
