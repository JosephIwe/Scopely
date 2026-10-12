export * from './password.js';
export * from './session.js';

/** The session cookie. With secure cookies (production), the __Host- prefix pins it to this origin over HTTPS. */
export const cookieName = (secure: boolean) => secure ? '__Host-scopely_session' : 'scopely_session';

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export function sessionCookie(name: string, token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
export const clearCookie = (name: string, secure: boolean) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

/**
 * A small fixed-window limiter for sign-in and invite attempts, per key (address and email). It
 * lives in memory: one server process, which is how Scopely runs. It slows guessing; the scrypt
 * cost and a long password minimum do the rest.
 */
export class AttemptLimiter {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly max = 10, private readonly windowMs = 15 * 60_000) {}
  /** True when this key has used up its attempts. */
  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return Boolean(h && h.until > now && h.n >= this.max);
  }
  hit(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (!h || h.until <= now) this.hits.set(key, { n: 1, until: now + this.windowMs });
    else h.n += 1;
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k);
  }
  clear(key: string): void { this.hits.delete(key); }
}
