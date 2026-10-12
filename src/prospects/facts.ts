// A contact fact in Scopely's words: one normal form per kind, so the same value from two sources
// is recognised as the same, and a value that is not what its kind says is dropped, never repaired
// into something the source did not say. A phone number keeps the digits it was given: a national
// number is not turned into an international one, because which country it belongs to would be a
// guess.
import { FACT_KINDS, type FactKind } from '../providers/prospects.js';

const PROFILE_HOSTS: Partial<Record<FactKind, RegExp>> = {
  linkedin: /(^|\.)linkedin\.com$/,
  instagram: /(^|\.)instagram\.com$/,
  x: /(^|\.)(x|twitter)\.com$/,
};

function httpUrl(v: string): URL | null {
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || u.username || u.password) return null;
    return u;
  } catch { return null; }
}

/** The stored form of a fact, or null when the value is not a fact of that kind. */
export function normalizeFact(kind: string, raw: unknown): string | null {
  if (!(FACT_KINDS as readonly string[]).includes(kind) || typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > 500 || /[\u0000-\u001f\u007f]/.test(v)) return null;
  switch (kind as FactKind) {
    case 'title':
      return v.length <= 200 ? v.replace(/\s+/g, ' ') : null;
    case 'email': {
      const e = v.replace(/^mailto:/i, '').split('?')[0]!.trim().toLowerCase();
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254 ? e : null;
    }
    case 'phone':
    case 'whatsapp': {
      let t = v.replace(/^tel:/i, '');
      const wa = httpUrl(v);
      if (kind === 'whatsapp' && wa && /(^|\.)(wa\.me|whatsapp\.com)$/.test(wa.hostname)) {
        t = wa.hostname.endsWith('wa.me') ? wa.pathname.slice(1) : wa.searchParams.get('phone') ?? '';
      }
      t = decodeURIComponent(t).trim();
      if (!/^\+?[\d\s().-]+$/.test(t)) return null;
      const digits = (t.startsWith('+') ? '+' : '') + t.replace(/\D/g, '');
      return /^\+?\d{6,15}$/.test(digits) ? digits : null;
    }
    case 'linkedin':
    case 'instagram':
    case 'x': {
      const u = httpUrl(v);
      if (!u || !PROFILE_HOSTS[kind as FactKind]!.test(u.hostname.toLowerCase()) || u.pathname.replace(/\/+$/, '') === '') return null;
      // One host per service, so a profile reached through a country or legacy host is the same profile.
      const host = kind === 'linkedin' ? 'www.linkedin.com' : kind === 'instagram' ? 'www.instagram.com' : 'x.com';
      return `https://${host}${u.pathname.replace(/\/+$/, '')}`;
    }
    case 'contact_page': {
      const u = httpUrl(v);
      if (!u) return null;
      u.hash = '';
      return u.toString();
    }
  }
}

/** A person's name compared loosely: case, accents, spacing and punctuation do not matter. */
export function nameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const k = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return k.length >= 2 ? k : null;
}
