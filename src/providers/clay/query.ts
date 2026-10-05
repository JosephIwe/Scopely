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

export interface ClayCompanyQuery {
  dsl: string;
  /** Which of the search's criteria the provider filters on; the rest are Scopely's alone. */
  pushedDown: ('industry' | 'size' | 'city')[];
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
    if (c.city?.trim()) { where.push(`locations.any(city = ${dslString(c.city)})`); pushedDown.push('city'); }
  } catch (err) {
    return { refused: `This search cannot be sent to the provider: ${(err as Error).message}.` };
  }
  if (!pushedDown.includes('industry') && !pushedDown.includes('city')) {
    return { refused: 'Add an industry or a city to this search first. Without one the provider would return an unbounded list.' };
  }
  return { dsl: `select from companies where ${where.join(' and ')}`, pushedDown };
}
