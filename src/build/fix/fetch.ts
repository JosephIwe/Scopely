// Page capture for the Fix Builder (F3). One GET of the page an evidence row was observed on, made
// locally, with the SSRF protections of Huntly's urlguard adapted here (not imported):
//
//   * http and https only, on their default ports, with no credentials in the URL;
//   * every name is resolved first and refused if any address is private, loopback, link-local,
//     multicast, reserved or unspecified; the connection is then pinned to the checked address, so
//     a second lookup cannot swap in another one;
//   * redirects are followed by hand, at most three, and each hop is checked again;
//   * the body is capped, the whole request times out, and only an HTML response is kept.
//
// Nothing is sent but the GET and a plain user agent: no cookies, no form, no script runs. The
// page body is never logged.
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Buffer;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
}

/** Why a request failed, in the vocabulary of `classifyWebsiteFetch` plus the guard's own refusals. */
export type FetchErrorCode = 'dns_not_found' | 'timeout' | 'tls' | 'connection_refused' | 'blocked' | 'too_large' | 'too_many_redirects' | 'other';

/** A capture that could not be made. Its message is for a person and names no internals. */
export class CaptureError extends Error {
  constructor(message: string, readonly code: FetchErrorCode = 'other') { super(message); }
}

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6');

/** True for an address a capture must never connect to. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return blocked.check(address, 'ipv4');
}

/** Checks the shape of a URL before any lookup. Returns the parsed URL. */
export function assertCapturableUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new CaptureError('That page address is not a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CaptureError('Only http and https pages can be captured.');
  if (u.username || u.password) throw new CaptureError('A page address with a user name or password is not captured.');
  if (u.port && u.port !== (u.protocol === 'https:' ? '443' : '80')) throw new CaptureError('Only pages on the standard web ports are captured.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new CaptureError('That page address is not on the public web.', 'blocked');
  }
  if (isIP(host) && isBlockedAddress(host)) throw new CaptureError('That page address is not on the public web.', 'blocked');
  return u;
}

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The one public address a request to `u` will connect to, or a refusal. */
export async function pinnedAddress(u: URL, resolve: Resolver): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return host;
  let addresses: string[];
  try { addresses = await resolve(host); } catch { throw new CaptureError(`${host} could not be found.`, 'dns_not_found'); }
  if (addresses.length === 0) throw new CaptureError(`${host} could not be found.`, 'dns_not_found');
  if (addresses.some(isBlockedAddress)) throw new CaptureError('That page address is not on the public web.', 'blocked');
  return addresses[0]!;
}

export interface PinnedResponse { status: number; location: string | null; contentType: string; bytes: Buffer }

/**
 * One GET of `u`, connected only to `address` (already checked), with no cookies, no body and a
 * plain user agent. Redirects are returned, not followed. The body is read only when `readBody`
 * says so for the response's status and type, and never past MAX_PAGE_BYTES.
 */
export function requestPinned(u: URL, address: string, opts: { userAgent: string; accept: string; readBody: (status: number, contentType: string) => boolean }): Promise<PinnedResponse> {
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: `${u.pathname}${u.search}`, method: 'GET',
      servername: isIP(u.hostname) ? undefined : u.hostname,
      // Connect only to the address that was checked.
      lookup: (_h: string, o: { all?: boolean }, cb: (...a: any[]) => void) => {
        const family = isIP(address);
        if (o?.all) cb(null, [{ address, family }]); else cb(null, address, family);
      },
      headers: { 'user-agent': opts.userAgent, accept: opts.accept, 'accept-encoding': 'identity' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : null;
      const contentType = String(res.headers['content-type'] ?? '');
      if ((status >= 300 && status < 400) || !opts.readBody(status, contentType)) { res.resume(); resolve({ status, location, contentType, bytes: Buffer.alloc(0) }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_PAGE_BYTES) { req.destroy(new CaptureError('The page is larger than Scopely captures (2 MB).', 'too_large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, location, contentType, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new CaptureError('The page took too long to answer.', 'timeout')));
    req.on('error', (err) => reject(err instanceof CaptureError ? err : new CaptureError('The page could not be reached.', networkCode(err))));
    req.end();
  });
}

/** A socket or TLS error as one of the FetchErrorCode words. */
function networkCode(err: unknown): FetchErrorCode {
  const code = String((err as { code?: string })?.code ?? '');
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_not_found';
  if (/CERT|TLS|SSL|EPROTO/.test(code)) return 'tls';
  return 'other';
}

/** The live fetcher used by `pnpm serve`. */
export class SafePageFetcher implements PageFetcher {
  constructor(private readonly resolve: Resolver = systemResolver) {}

  async fetch(url: string): Promise<FetchedPage> {
    let current = assertCapturableUrl(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const address = await pinnedAddress(current, this.resolve);
      const r = await this.once(current, address);
      if (r.status >= 300 && r.status < 400 && r.location) {
        if (hop === MAX_REDIRECTS) throw new CaptureError('The page redirected too many times.', 'too_many_redirects');
        current = assertCapturableUrl(new URL(r.location, current).toString());
        continue;
      }
      if (r.status < 200 || r.status > 299) throw new CaptureError(`The page answered with status ${r.status}, so nothing was captured.`);
      if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(r.contentType)) throw new CaptureError('The address did not return a web page.');
      return { requestedUrl: url, finalUrl: current.toString(), status: r.status, contentType: r.contentType, bytes: r.bytes };
    }
    throw new CaptureError('The page redirected too many times.', 'too_many_redirects');
  }

  private once(u: URL, address: string): Promise<PinnedResponse> {
    return requestPinned(u, address, {
      userAgent: 'ScopelyFixCapture/1 (+page capture for a proposed fix)', accept: 'text/html,application/xhtml+xml', readBody: () => true,
    });
  }
}

/**
 * Sample pages for the local demo. A reserved `.example` host (RFC 2606) can never be a real
 * business, so the demo's sample business is served from a bundled file instead of the network.
 * Every other host goes to the live fetcher.
 */
export const DEMO_PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'demo-pages');

export class DemoAwarePageFetcher implements PageFetcher {
  constructor(private readonly live: PageFetcher = new SafePageFetcher(), private readonly dir = DEMO_PAGE_DIR) {}

  async fetch(url: string): Promise<FetchedPage> {
    const u = new URL(url);
    if (!u.hostname.endsWith('.example')) return this.live.fetch(url);
    const name = u.hostname.replace(/[^a-z0-9.-]/gi, '');
    let bytes: Buffer;
    try { bytes = await readFile(path.join(this.dir, `${name}.html`)); } catch { throw new CaptureError(`${u.hostname} could not be found.`); }
    return { requestedUrl: url, finalUrl: u.toString(), status: 200, contentType: 'text/html; charset=utf-8', bytes };
  }
}
