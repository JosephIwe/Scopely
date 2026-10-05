// The analysis probe: one SSRF-safe GET of a public web address, with every redirect recorded.
//
// It uses the Fix Builder's guard (src/build/fix/fetch.ts, adapted from Huntly's urlguard): http and
// https only on their default ports, no credentials in the URL, every resolved address checked
// against private and reserved ranges, the connection pinned to the checked address, at most three
// redirects each checked again, 10 s and 2 MB. Unlike a capture, a probe never throws for what the
// web did: an error page, a missing host or a timeout is the result, so the analysis can say what
// it saw and what it could not see. Only an HTML body is kept, and only in memory: Scopely stores
// its hash, never the page.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CaptureError, DEMO_PAGE_DIR, type FetchErrorCode, MAX_REDIRECTS, type Resolver, assertCapturableUrl, pinnedAddress, requestPinned,
} from '../build/fix/fetch.js';
import { lookup } from 'node:dns/promises';

export interface ProbeHop {
  url: string;
  status: number;
}

interface ProbeBase {
  requestedUrl: string;
  /** Redirects followed, in order: the address and the status that sent Scopely on. */
  hops: ProbeHop[];
  /** When the request was made (UTC). */
  fetchedAt: string;
}

export type ProbeResult =
  | (ProbeBase & { kind: 'response'; finalUrl: string; status: number; contentType: string; html: string | null })
  | (ProbeBase & { kind: 'error'; lastUrl: string; error: FetchErrorCode });

export interface Probe {
  /** `body: false` asks only where an address leads and what it answers, without reading a page. */
  get(url: string, opts?: { body?: boolean }): Promise<ProbeResult>;
}

const isHtml = (contentType: string) => /^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType);

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Pages are almost always UTF-8; a declared Latin-1 family charset is read as Latin-1. */
export function decodeHtml(bytes: Buffer, contentType: string): string {
  const cs = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().toLowerCase();
  return bytes.toString(cs && /^(iso-8859-1|latin1|windows-1252)$/.test(cs) ? 'latin1' : 'utf8');
}

/** The live probe used by `pnpm serve`. */
export class SafeProbe implements Probe {
  constructor(private readonly resolve: Resolver = systemResolver, private readonly now: () => Date = () => new Date()) {}

  async get(url: string, opts: { body?: boolean } = {}): Promise<ProbeResult> {
    const fetchedAt = this.now().toISOString();
    const hops: ProbeHop[] = [];
    let current: URL;
    try { current = assertCapturableUrl(url); } catch { return { kind: 'error', requestedUrl: url, lastUrl: url, hops, fetchedAt, error: 'blocked' }; }
    for (let hop = 0; ; hop++) {
      try {
        const address = await pinnedAddress(current, this.resolve);
        const r = await requestPinned(current, address, {
          userAgent: 'ScopelyAnalysis/1 (+checks a business website before a seller contacts it)',
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          readBody: (status, type) => opts.body !== false && status >= 200 && status < 300 && isHtml(type),
        });
        if (r.status >= 300 && r.status < 400 && r.location) {
          hops.push({ url: current.toString(), status: r.status });
          if (hop === MAX_REDIRECTS) return { kind: 'error', requestedUrl: url, lastUrl: current.toString(), hops, fetchedAt, error: 'too_many_redirects' };
          let next: URL;
          try { next = assertCapturableUrl(new URL(r.location, current).toString()); } catch {
            return { kind: 'error', requestedUrl: url, lastUrl: current.toString(), hops, fetchedAt, error: 'blocked' };
          }
          current = next;
          continue;
        }
        const html = r.bytes.length > 0 && isHtml(r.contentType) ? decodeHtml(r.bytes, r.contentType) : null;
        return { kind: 'response', requestedUrl: url, finalUrl: current.toString(), status: r.status, contentType: r.contentType, html, hops, fetchedAt };
      } catch (err) {
        return { kind: 'error', requestedUrl: url, lastUrl: current.toString(), hops, fetchedAt, error: err instanceof CaptureError ? err.code : 'other' };
      }
    }
  }
}

/**
 * Sample pages for the local demo, as for the Fix Builder: a reserved `.example` host (RFC 2606)
 * can never be a real business, so it is answered from fixtures/demo-pages/<host>.html (or
 * <host>__<path>.html for a deeper page). A missing file is a host that does not exist. Every
 * other host goes to the live probe.
 */
export class DemoAwareProbe implements Probe {
  constructor(private readonly live: Probe = new SafeProbe(), private readonly dir = DEMO_PAGE_DIR, private readonly now: () => Date = () => new Date()) {}

  async get(url: string, opts: { body?: boolean } = {}): Promise<ProbeResult> {
    let u: URL;
    try { u = new URL(url); } catch { return this.live.get(url, opts); }
    if (!u.hostname.endsWith('.example')) return this.live.get(url, opts);
    const fetchedAt = this.now().toISOString();
    const host = u.hostname.replace(/[^a-z0-9.-]/gi, '');
    const page = u.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9-]/gi, '_');
    const file = path.join(this.dir, page ? `${host}__${page}.html` : `${host}.html`);
    let bytes: Buffer;
    try { bytes = await readFile(file); } catch {
      // The host's own page exists but this path does not: a 404, as a real server would answer.
      const hostExists = page ? await readFile(path.join(this.dir, `${host}.html`)).then(() => true, () => false) : false;
      if (hostExists) return { kind: 'response', requestedUrl: url, finalUrl: u.toString(), status: 404, contentType: 'text/html', html: null, hops: [], fetchedAt };
      return { kind: 'error', requestedUrl: url, lastUrl: u.toString(), hops: [], fetchedAt, error: 'dns_not_found' };
    }
    return { kind: 'response', requestedUrl: url, finalUrl: u.toString(), status: 200, contentType: 'text/html; charset=utf-8',
      html: opts.body === false ? null : bytes.toString('utf8'), hops: [], fetchedAt };
  }
}
