// Lightweight pre-qualification: decide from firmographics and history alone, before any page is
// fetched, whether a discovered business fits a search. Pure: no I/O, no network, no guesses.
//
// Each criterion that the search sets gives pass, fail or unknown. Unknown means the input needed
// is not known (NULL), or cannot be compared honestly (revenue in another currency, a size range
// that straddles the target). Unknown never passes and never fails: it sends the business to
// NEEDS_REVIEW. The first stage with a fail rejects it, and that stage is recorded.
import type { SearchCriteria } from './criteria.js';

export const STAGES = ['geography', 'industry', 'size', 'revenue', 'structure', 'online_presence', 'signals',
  'contactability', 'exclusions'] as const;
export type Stage = (typeof STAGES)[number];
export type Verdict = 'pass' | 'fail' | 'unknown';

export interface CriterionResult {
  stage: Stage;
  criterion: string;
  verdict: Verdict;
  expected: unknown;
  actual: unknown;
  /** How the business value is known (VERIFIED / REPORTED / ESTIMATED), where that applies. */
  basis?: string | null;
}

export interface QualificationResult {
  state: 'QUALIFIED' | 'REJECTED' | 'NEEDS_REVIEW';
  failedStage: Stage | null;
  unknownStages: Stage[];
  criteria: CriterionResult[];
}

export type WebsiteStatus = 'UNKNOWN' | 'WEBSITE_PRESENT' | 'WEBSITE_NOT_OBSERVED' | 'WEBSITE_UNREACHABLE' | 'WEBSITE_NEEDS_REVIEW';

/** What Scopely already holds about a business. NULL is unknown, never zero. */
export interface BusinessFacts {
  countryCode: string | null;
  region: string | null;
  city: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  vertical: string | null;
  subvertical: string | null;
  specialty: string | null;
  employeeCount: number | null;
  employeeCountMin: number | null;
  employeeCountMax: number | null;
  employeesBasis: string | null;
  revenueAmount: number | null;
  revenueMin: number | null;
  revenueMax: number | null;
  revenueCurrency: string | null;
  revenueBasis: string | null;
  independence: string | null;
  websiteStatus: WebsiteStatus;
  reviewCount: number | null;
  rating: number | null;
  incorporatedOn: string | null;
  phone: string | null;
  domain: string | null;
  /** Facts about this workspace's own records, so they are known, not guessed. */
  hasPublicEmail: boolean;
  history: {
    analyzedBefore: boolean;
    contacted: boolean;
    existingClient: boolean;
    won: boolean;
    lost: boolean;
    suppressed: boolean;
  };
}

const norm = (s: string | null | undefined) => (s == null ? null : s.trim().toLowerCase());

/**
 * Where a business's figure sits against a wanted [min, max]. An exact value is compared directly.
 * A reported range passes only if it lies wholly inside, fails only if it lies wholly outside, and
 * is unknown if it straddles an edge.
 */
export function rangeVerdict(want: { min: number | null; max: number | null },
  have: { exact: number | null; min: number | null; max: number | null }): Verdict {
  const lo = have.exact ?? have.min;
  const hi = have.exact ?? have.max;
  if (lo === null && hi === null) return 'unknown';
  if (want.min !== null && hi !== null && hi < want.min) return 'fail';
  if (want.max !== null && lo !== null && lo > want.max) return 'fail';
  const minOk = want.min === null || (lo !== null && lo >= want.min);
  const maxOk = want.max === null || (hi !== null && hi <= want.max);
  return minOk && maxOk ? 'pass' : 'unknown';
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(a));
}

function inList(list: string[], value: string | null): Verdict {
  if (value === null) return 'unknown';
  return list.map((v) => v.toLowerCase()).includes(value.toLowerCase()) ? 'pass' : 'fail';
}

export function prequalify(c: SearchCriteria, b: BusinessFacts, asOf: Date): QualificationResult {
  const out: CriterionResult[] = [];
  const add = (stage: Stage, criterion: string, verdict: Verdict, expected: unknown, actual: unknown, basis?: string | null) =>
    out.push({ stage, criterion, verdict, expected, actual, ...(basis !== undefined ? { basis } : {}) });
  const eq = (want: string | null | undefined, have: string | null): Verdict =>
    have === null ? 'unknown' : norm(want) === norm(have) ? 'pass' : 'fail';

  // geography
  if (c.countryCode) add('geography', 'country', eq(c.countryCode, b.countryCode), c.countryCode, b.countryCode);
  if (c.region) add('geography', 'region', eq(c.region, b.region), c.region, b.region);
  if (c.city) add('geography', 'city', eq(c.city, b.city), c.city, b.city);
  if (c.postalPrefix) {
    const want = c.postalPrefix.replace(/\s+/g, '').toUpperCase();
    const have = b.postalCode?.replace(/\s+/g, '').toUpperCase() ?? null;
    add('geography', 'postal_prefix', have === null ? 'unknown' : have.startsWith(want) ? 'pass' : 'fail', c.postalPrefix, b.postalCode);
  }
  if (c.radiusKm != null && c.centerLatitude != null && c.centerLongitude != null) {
    const d = b.latitude === null || b.longitude === null ? null
      : haversineKm(c.centerLatitude, c.centerLongitude, b.latitude, b.longitude);
    add('geography', 'radius_km', d === null ? 'unknown' : d <= c.radiusKm ? 'pass' : 'fail', c.radiusKm,
      d === null ? null : Math.round(d * 10) / 10);
  }

  // industry
  if (c.verticals.length) add('industry', 'vertical', inList(c.verticals, b.vertical), c.verticals, b.vertical);
  if (c.subverticals.length) add('industry', 'subvertical', inList(c.subverticals, b.subvertical), c.subverticals, b.subvertical);
  if (c.specialties.length) add('industry', 'specialty', inList(c.specialties, b.specialty), c.specialties, b.specialty);

  // size
  if (c.employeeMin != null || c.employeeMax != null) {
    add('size', 'employees', rangeVerdict({ min: c.employeeMin ?? null, max: c.employeeMax ?? null },
      { exact: b.employeeCount, min: b.employeeCountMin, max: b.employeeCountMax }),
      { min: c.employeeMin ?? null, max: c.employeeMax ?? null },
      { exact: b.employeeCount, min: b.employeeCountMin, max: b.employeeCountMax }, b.employeesBasis);
  }

  // revenue: never converted between currencies
  if (c.revenueMin != null || c.revenueMax != null) {
    const want = { min: c.revenueMin ?? null, max: c.revenueMax ?? null, currency: c.revenueCurrency };
    const have = { exact: b.revenueAmount, min: b.revenueMin, max: b.revenueMax, currency: b.revenueCurrency };
    const verdict = b.revenueCurrency === null || b.revenueCurrency !== c.revenueCurrency ? 'unknown'
      : rangeVerdict(want, have);
    add('revenue', 'revenue', verdict, want, have, b.revenueBasis);
  }

  // structure ('group' counts as a chain: the existing rejection category is CHAIN_OR_GROUP)
  const structure = b.independence === null || b.independence === 'unknown' ? null : b.independence;
  if (c.businessTypes.length) add('structure', 'business_type', inList(c.businessTypes, structure), c.businessTypes, structure);
  if (c.excludeChains) add('structure', 'exclude_chains', structure === null ? 'unknown'
    : ['chain', 'group'].includes(structure) ? 'fail' : 'pass', true, structure);
  if (c.excludeFranchises) add('structure', 'exclude_franchises', structure === null ? 'unknown'
    : structure === 'franchise' ? 'fail' : 'pass', true, structure);

  // online presence: only an observed status decides; a blocked or failed fetch is not an absence
  if (c.websitePresence === 'required') {
    add('online_presence', 'website_required', b.websiteStatus === 'WEBSITE_PRESENT' ? 'pass'
      : b.websiteStatus === 'WEBSITE_NOT_OBSERVED' ? 'fail' : 'unknown', 'WEBSITE_PRESENT', b.websiteStatus);
  } else if (c.websitePresence === 'absent') {
    add('online_presence', 'website_absent', b.websiteStatus === 'WEBSITE_NOT_OBSERVED' ? 'pass'
      : b.websiteStatus === 'WEBSITE_PRESENT' ? 'fail' : 'unknown', 'WEBSITE_NOT_OBSERVED', b.websiteStatus);
  }
  if (c.websiteStatuses.length) {
    add('online_presence', 'website_status', c.websiteStatuses.includes(b.websiteStatus) ? 'pass'
      : b.websiteStatus === 'UNKNOWN' ? 'unknown' : 'fail', c.websiteStatuses, b.websiteStatus);
  }

  // signals
  if (c.reviewCountMin != null || c.reviewCountMax != null) {
    add('signals', 'review_count', rangeVerdict({ min: c.reviewCountMin ?? null, max: c.reviewCountMax ?? null },
      { exact: b.reviewCount, min: null, max: null }), { min: c.reviewCountMin ?? null, max: c.reviewCountMax ?? null }, b.reviewCount);
  }
  if (c.ratingMin != null || c.ratingMax != null) {
    add('signals', 'rating', rangeVerdict({ min: c.ratingMin ?? null, max: c.ratingMax ?? null },
      { exact: b.rating, min: null, max: null }), { min: c.ratingMin ?? null, max: c.ratingMax ?? null }, b.rating);
  }
  if (c.businessAgeMinYears != null || c.businessAgeMaxYears != null) {
    const age = b.incorporatedOn === null ? null
      : Math.floor((asOf.getTime() - new Date(b.incorporatedOn).getTime()) / (365.2425 * 24 * 3600 * 1000));
    add('signals', 'business_age_years', rangeVerdict({ min: c.businessAgeMinYears ?? null, max: c.businessAgeMaxYears ?? null },
      { exact: age, min: null, max: null }), { min: c.businessAgeMinYears ?? null, max: c.businessAgeMaxYears ?? null }, age);
  }

  // contactability: what this workspace holds, which is a fact, not an estimate
  if (c.requirePublicEmail) add('contactability', 'public_email', b.hasPublicEmail ? 'pass' : 'fail', true, b.hasPublicEmail);
  if (c.requirePhone) add('contactability', 'phone', b.phone ? 'pass' : 'fail', true, b.phone !== null);
  if (c.requireDomain) add('contactability', 'domain', b.domain ? 'pass' : 'fail', true, b.domain !== null);

  // exclusions
  const h = b.history;
  if (c.excludePreviouslyAnalyzed) add('exclusions', 'previously_analyzed', h.analyzedBefore ? 'fail' : 'pass', false, h.analyzedBefore);
  if (c.excludePreviouslyContacted) add('exclusions', 'previously_contacted', h.contacted ? 'fail' : 'pass', false, h.contacted);
  if (c.excludeExistingClients) add('exclusions', 'existing_client', h.existingClient ? 'fail' : 'pass', false, h.existingClient);
  if (c.excludeWon) add('exclusions', 'won', h.won ? 'fail' : 'pass', false, h.won);
  if (c.excludeLost) add('exclusions', 'lost', h.lost ? 'fail' : 'pass', false, h.lost);
  if (c.excludeSuppressed) add('exclusions', 'suppressed', h.suppressed ? 'fail' : 'pass', false, h.suppressed);
  if (c.excludedDomains.length) {
    const d = norm(b.domain);
    add('exclusions', 'excluded_domain', d !== null && c.excludedDomains.map((x) => x.toLowerCase()).includes(d) ? 'fail' : 'pass',
      c.excludedDomains, b.domain);
  }
  if (c.excludedBusinessTypes.length) {
    const types = [b.vertical, b.subvertical, b.specialty].filter((t): t is string => t !== null).map((t) => t.toLowerCase());
    const hit = c.excludedBusinessTypes.some((t) => types.includes(t.toLowerCase()));
    add('exclusions', 'excluded_business_type', hit ? 'fail' : types.length === 0 ? 'unknown' : 'pass', c.excludedBusinessTypes, types);
  }

  const failedStage = STAGES.find((s) => out.some((r) => r.stage === s && r.verdict === 'fail')) ?? null;
  const unknownStages = STAGES.filter((s) => out.some((r) => r.stage === s && r.verdict === 'unknown'));
  return {
    state: failedStage ? 'REJECTED' : unknownStages.length ? 'NEEDS_REVIEW' : 'QUALIFIED',
    failedStage,
    unknownStages,
    criteria: out,
  };
}
