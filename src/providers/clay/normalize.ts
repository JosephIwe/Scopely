// A Clay company record in Scopely's words. Every value comes from the record; what Clay does not
// say stays unknown, and what Scopely cannot represent honestly is kept in the provider record only:
//
// - Size: Clay returns the company's LinkedIn size bucket and its own estimated headcount, and the
//   two can disagree (a "2-10" company with 51 estimated employees). The bucket is what the
//   company states, so it becomes the employee range with basis REPORTED; the estimate stays in
//   the provider record.
// - Revenue: Clay's revenue bucket names no currency. Revenue is never stored without one (rule
//   15), so it stays in the provider record and the business's revenue stays unknown.
// - Company type and structure: Clay's "Privately Held" / "Public Company" labels are not a
//   company register's types (a two-person clinic can be "Public Company"), and they say nothing
//   about chains or franchises. Neither is mapped.
// - Website: a domain in a provider's record is not an observation of a live site, so the
//   business's website_status stays UNKNOWN until Scopely checks it itself.
import type { ProviderBusiness } from '../discovery.js';
import { CLAY_SIZE_BUCKETS } from './query.js';

export interface ClayCompany {
  entityId: string;
  name: string;
  url?: string;
  size?: string;
  type?: string;
  domain?: string;
  country?: string;
  website?: string;
  industry?: string;
  locality?: string;
  employee_count?: number;
  annual_revenue?: string;
  order?: number;
}

/** The fields Scopely keeps from a Clay record, as Clay named them. Descriptions and logos are not kept. */
const KEPT = ['entityId', 'name', 'url', 'size', 'type', 'domain', 'country', 'website', 'industry', 'locality', 'employee_count', 'annual_revenue'] as const;

let countryIndex: Map<string, string> | null = null;
/** ISO 3166 alpha-2 code for an English country name, from the runtime's own region names. */
export function countryCode(name: string | undefined): string | null {
  if (!name) return null;
  if (!countryIndex) {
    countryIndex = new Map();
    const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const n = names.of(code);
        // First code wins: GB, not the reserved UK, for "United Kingdom".
        if (n && n !== code && !countryIndex.has(n.toLowerCase())) countryIndex.set(n.toLowerCase(), code);
      }
    }
  }
  return countryIndex.get(name.trim().toLowerCase()) ?? null;
}

/** Constituent countries a locality can name instead of a town. They are never a city. */
const NOT_A_CITY = new Set(['england', 'scotland', 'wales', 'northern ireland']);

/**
 * Splits a provider locality ("Leeds, West Yorkshire", "Leeds LS8 2ET, England", "Chelmsford,
 * CM1 7GU") into city, region and postal code. A part that is the country itself is dropped.
 */
export function parseLocality(locality: string | undefined, country: string | undefined): { city: string | null; region: string | null; postalCode: string | null } {
  const out = { city: null as string | null, region: null as string | null, postalCode: null as string | null };
  if (!locality) return out;
  const countryName = country?.trim().toLowerCase();
  const parts = locality.split(',').map((p) => p.trim()).filter((p) => p && p.toLowerCase() !== countryName);
  const named: string[] = [];
  for (const p of parts) {
    // A part with digits is a postal code, or a town followed by one ("Leeds LS8 2ET").
    const m = /^(.*?)\s*\b([A-Za-z]{0,2}\d[A-Za-z0-9]*(?:\s+\d[A-Za-z0-9]*)?)$/.exec(p);
    if (m && /\d/.test(p)) {
      if (!out.postalCode) out.postalCode = m[2]!.toUpperCase();
      if (m[1]) named.push(m[1]);
    } else named.push(p);
  }
  const first = named[0] ?? null;
  if (first && !NOT_A_CITY.has(first.toLowerCase())) {
    out.city = first;
    out.region = named[1] ?? null;
  } else {
    out.region = first;
  }
  return out;
}

/** The registrable host of a URL, without www. */
export function domainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch { return null; }
}

/** Normalizes one Clay company. Returns null for a record without an id or a name. */
export function normalizeClayCompany(raw: unknown, observedAt: string): ProviderBusiness | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as ClayCompany;
  if (typeof c.entityId !== 'string' || !c.entityId || typeof c.name !== 'string' || !c.name.trim()) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const record: Record<string, unknown> = {};
  for (const k of KEPT) if (c[k] !== undefined && c[k] !== null) record[k] = c[k];
  const loc = parseLocality(str(c.locality), str(c.country));
  const bucket = CLAY_SIZE_BUCKETS.find(([label]) => label === str(c.size));
  const website = str(c.website);
  const domain = str(c.domain)?.toLowerCase().replace(/^www\./, '') ?? domainOf(website) ?? undefined;
  const b: ProviderBusiness = {
    source: { provider: 'clay', sourceType: 'api', reference: `company:${c.entityId}`, discoveredAt: observedAt, record },
    name: c.name.trim(),
  };
  if (domain) b.domain = domain;
  if (website) b.websiteUrl = website;
  const industry = str(c.industry);
  if (industry) b.vertical = industry;
  if (loc.city) b.city = loc.city;
  if (loc.region) b.region = loc.region;
  if (loc.postalCode) b.postalCode = loc.postalCode;
  const cc = countryCode(str(c.country));
  if (cc) b.countryCode = cc;
  if (bucket) {
    b.employees = { min: bucket[1], ...(bucket[2] === null ? {} : { max: bucket[2] }), basis: 'REPORTED', source: 'clay:company_size', asOf: observedAt };
  }
  return b;
}
