// A Scopely search as a Clay company search (Clay's Search DSL). Only what Clay can filter on is
// pushed down; everything else is left to Scopely's own pre-qualification, which runs on every
// business the provider returns. Pushing a filter down narrows what is pulled (and paid for); it
// never decides qualification.
import type { SearchCriteria } from '../../discovery/index.js';

/** Clay's company_size buckets, as [label, min, max]. */
export const CLAY_SIZE_BUCKETS: [string, number, number | null][] = [
  ['1', 1, 1], ['2-10', 2, 10], ['11-50', 11, 50], ['51-200', 51, 200], ['201-500', 201, 500], ['501-1,000', 501, 1000],
  ['1,001-5,000', 1001, 5000], ['5,001-10,000', 5001, 10000], ['10,001+', 10001, null],
];

/**
 * Clay's annual_revenue buckets, as [label, min, max]. Clay labels them without a currency; they
 * read as US dollars (Clay labels its funding ranges USD), so only a USD revenue range is pushed
 * down. A range in any other currency is never converted: Clay is not filtered on it, and Scopely's
 * own revenue check decides.
 */
export const CLAY_REVENUE_BUCKETS: [string, number, number][] = [
  ['0-500K', 0, 5e5], ['500K-1M', 5e5, 1e6], ['1M-5M', 1e6, 5e6], ['5M-10M', 5e6, 1e7], ['10M-25M', 1e7, 2.5e7],
  ['25M-75M', 2.5e7, 7.5e7], ['75M-200M', 7.5e7, 2e8], ['200M-500M', 2e8, 5e8], ['500M-1B', 5e8, 1e9], ['1B-10B', 1e9, 1e10],
  ['10B-100B', 1e10, 1e11], ['100B-1T', 1e11, 1e12],
];
/** The only currency Clay's revenue filter is in. */
export const CLAY_REVENUE_CURRENCY = 'USD';

/** A DSL string literal. Values come from a seller's search, so they are escaped, never spliced. */
export function dslString(v: string): string {
  const t = v.trim();
  if (!t || t.length > 120 || /[\u0000-\u001f\u007f]/.test(t)) throw new Error(`"${t.slice(0, 40)}" cannot be sent to the provider`);
  return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The size buckets that overlap a wanted employee range; null when every bucket does. */
export function sizeBuckets(min: number | null | undefined, max: number | null | undefined): string[] | null {
  if (min == null && max == null) return null;
  const hit = CLAY_SIZE_BUCKETS.filter(([, lo, hi]) => (min == null || hi === null || hi >= min) && (max == null || lo <= max)).map(([l]) => l);
  return hit.length === CLAY_SIZE_BUCKETS.length ? null : hit;
}

/** The revenue buckets that overlap a wanted range; null when every bucket does. */
export function revenueBuckets(min: number | null | undefined, max: number | null | undefined): string[] | null {
  if (min == null && max == null) return null;
  const hit = CLAY_REVENUE_BUCKETS.filter(([, lo, hi]) => (min == null || hi >= min) && (max == null || lo <= max)).map(([l]) => l);
  return hit.length === CLAY_REVENUE_BUCKETS.length ? null : hit;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
/** The English country name Clay's locations carry for an ISO code ("GB" → "United Kingdom"), or null. */
export function clayCountryName(code: string | null | undefined): string | null {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  return regionNames.of(code) ?? null;
}

export interface ClayCompanyQuery {
  dsl: string;
  /** Which of the search's criteria the provider filters on; the rest are Scopely's alone. */
  pushedDown: ('industry' | 'size' | 'revenue' | 'city' | 'country')[];
}

/**
 * Builds the company search for a search's criteria, or says why it cannot. A search must set an
 * industry or a city: without either the provider would return an unbounded list.
 */
export function clayCompanyQuery(c: SearchCriteria): ClayCompanyQuery | { refused: string } {
  const where: string[] = [];
  const pushedDown: ClayCompanyQuery['pushedDown'] = [];
  try {
    const industries = [...new Set(c.verticals.map((v) => v.trim()).filter(Boolean))];
    if (industries.length === 1) where.push(`industry = ${dslString(industries[0]!)}`);
    else if (industries.length > 1) where.push(`industry in (${industries.map(dslString).join(', ')})`);
    if (industries.length) pushedDown.push('industry');
    const sizes = sizeBuckets(c.employeeMin, c.employeeMax);
    if (sizes && sizes.length === 0) return { refused: 'No company size matches this search’s employee range.' };
    if (sizes) { where.push(`company_size in (${sizes.map(dslString).join(', ')})`); pushedDown.push('size'); }
    if (c.revenueCurrency === CLAY_REVENUE_CURRENCY) {
      const revenue = revenueBuckets(c.revenueMin, c.revenueMax);
      if (revenue && revenue.length === 0) return { refused: 'No revenue range the provider knows matches this search’s revenue.' };
      if (revenue) { where.push(`annual_revenue in (${revenue.map(dslString).join(', ')})`); pushedDown.push('revenue'); }
    }
    // City and country go in one location clause, so both must hold for the same office.
    const place: string[] = [];
    if (c.city?.trim()) { place.push(`city = ${dslString(c.city)}`); pushedDown.push('city'); }
    const country = clayCountryName(c.countryCode);
    if (country) { place.push(`country_name = ${dslString(country)}`); pushedDown.push('country'); }
    if (place.length) where.push(`locations.any(${place.join(' and ')})`);
  } catch (err) {
    return { refused: `This search cannot be sent to the provider: ${(err as Error).message}.` };
  }
  if (!pushedDown.includes('industry') && !pushedDown.includes('city')) {
    return { refused: 'Add an industry or a city to this search first. Without one the provider would return an unbounded list.' };
  }
  return { dsl: `select from companies where ${where.join(' and ')}`, pushedDown };
}
