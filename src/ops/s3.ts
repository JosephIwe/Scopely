// A minimal S3 client for the pre-deploy backup: PUT one object, GET it back. AWS Signature
// Version 4, with node:crypto and fetch only (no SDK). Works with any S3-compatible store; Railway
// Storage Buckets use virtual-hosted URLs (https://<bucket>.<endpoint host>/<key>).
//
// The client has no delete, list or overwrite path: the backup writes a new, uniquely named object
// each time and nothing in Scopely removes one. Keys and secrets are never logged or returned; an
// error carries the HTTP status and the S3 error code only.
import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  endpoint: string;          // https://t3.storageapi.dev
  bucket: string;
  region: string;            // 'auto' for Railway
  accessKeyId: string;
  secretAccessKey: string;
  urlStyle: 'virtual' | 'path';
}

const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
/** RFC 3986 encoding, as SigV4 wants it; '/' kept in paths. */
const enc = (s: string, keepSlash = false) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  .replace(keepSlash ? /%2F/g : /$^/, '/');

export interface SignInput {
  method: string; host: string; path: string; query?: Record<string, string>;
  headers: Record<string, string>; payloadSha256: string; amzDate: string; region: string; service?: string;
  accessKeyId: string; secretAccessKey: string;
}

/** Signs a request (SigV4, header auth) and returns the Authorization header value. Exported for the AWS test vector. */
export function signV4(i: SignInput): string {
  const service = i.service ?? 's3';
  const date = i.amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...i.headers, host: i.host })) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const query = Object.entries(i.query ?? {}).map(([k, v]) => [enc(k), enc(v)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [i.method, enc(i.path, true), query, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), i.payloadSha256].join('\n');
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

export class S3Error extends Error {
  constructor(readonly status: number, readonly code: string) { super(`object storage answered ${status}${code ? ` ${code}` : ''}`); }
}

export class S3Client {
  constructor(private readonly cfg: S3Config, private readonly fetchFn: typeof fetch = fetch) {}

  private target(key: string) {
    const base = new URL(this.cfg.endpoint);
    const host = this.cfg.urlStyle === 'virtual' ? `${this.cfg.bucket}.${base.host}` : base.host;
    const path = this.cfg.urlStyle === 'virtual' ? `/${key}` : `/${this.cfg.bucket}/${key}`;
    return { url: `${base.protocol}//${host}${enc(path, true)}`, host, path };
  }

  private async send(method: 'PUT' | 'GET', key: string, body?: Buffer, extra: Record<string, string> = {}) {
    const { url, host, path } = this.target(key);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadSha256 = body ? sha256Hex(body) : sha256Hex('');
    const headers: Record<string, string> = { 'x-amz-content-sha256': payloadSha256, 'x-amz-date': amzDate, ...extra };
    const authorization = signV4({ method, host, path, headers, payloadSha256, amzDate, region: this.cfg.region,
      accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey });
    const res = await this.fetchFn(url, { method, headers: { ...headers, authorization }, body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new S3Error(res.status, /<Code>([A-Za-z]{1,64})<\/Code>/.exec(text)?.[1] ?? '');
    }
    return res;
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await this.send('PUT', key, body, { 'content-type': contentType });
  }

  async get(key: string): Promise<Buffer> {
    return Buffer.from(await (await this.send('GET', key)).arrayBuffer());
  }
}
