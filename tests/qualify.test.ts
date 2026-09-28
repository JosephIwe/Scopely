// Pre-qualification is pure: these cases need no database. Unknown inputs stay unknown and send a
// business to review; they never pass or fail on a guess.
import { describe, expect, it } from 'vitest';
import type { SearchCriteria } from '../src/discovery/criteria.js';
import { haversineKm, prequalify, rangeVerdict, type BusinessFacts } from '../src/discovery/qualify.js';

const NONE: SearchCriteria = {
  verticals: [], subverticals: [], specialties: [], businessTypes: [], excludeChains: false, excludeFranchises: false,
  websitePresence: 'any', websiteStatuses: [], opportunityKinds: [], requirePublicEmail: false, requirePhone: false,
  requireDomain: false, excludePreviouslyAnalyzed: false, excludePreviouslyContacted: false, excludeExistingClients: false,
  excludeWon: false, excludeLost: false, excludeSuppressed: false, excludedDomains: [], excludedBusinessTypes: [],
};
const criteria = (c: Partial<SearchCriteria>): SearchCriteria => ({ ...NONE, ...c });

const UNKNOWN: BusinessFacts = {
  countryCode: null, region: null, city: null, postalCode: null, latitude: null, longitude: null, vertical: null, subvertical: null,
  specialty: null, employeeCount: null, employeeCountMin: null, employeeCountMax: null, employeesBasis: null, revenueAmount: null,
  revenueMin: null, revenueMax: null, revenueCurrency: null, revenueBasis: null, independence: null, websiteStatus: 'UNKNOWN',
  reviewCount: null, rating: null, incorporatedOn: null, phone: null, domain: null, hasPublicEmail: false,
  history: { analyzedBefore: false, contacted: false, existingClient: false, won: false, lost: false, suppressed: false },
};
const facts = (f: Partial<BusinessFacts>): BusinessFacts => ({ ...UNKNOWN, ...f });
const asOf = new Date('2026-10-01T00:00:00Z');

describe('range verdicts', () => {
  it('compares an exact value, and a range only when it lies wholly inside or outside', () => {
    const want = { min: 5, max: 30 };
    expect(rangeVerdict(want, { exact: 12, min: null, max: null })).toBe('pass');
    expect(rangeVerdict(want, { exact: 4, min: null, max: null })).toBe('fail');
    expect(rangeVerdict(want, { exact: null, min: 11, max: 20 })).toBe('pass');
    expect(rangeVerdict(want, { exact: null, min: 51, max: 200 })).toBe('fail');
    expect(rangeVerdict(want, { exact: null, min: 11, max: 50 })).toBe('unknown');   // straddles 30
    expect(rangeVerdict(want, { exact: null, min: null, max: null })).toBe('unknown');
    expect(rangeVerdict({ min: 50, max: null }, { exact: null, min: 500, max: null })).toBe('pass'); // "500+"
    expect(rangeVerdict({ min: 5, max: null }, { exact: null, min: null, max: 10 })).toBe('unknown'); // "<10"
  });
});

describe('pre-qualification', () => {
  it('keeps unknown employee count and revenue unknown: the business goes to review, not through or out', () => {
    const q = prequalify(criteria({ employeeMin: 5, employeeMax: 30, revenueMin: 250_000, revenueMax: 5_000_000, revenueCurrency: 'GBP' }),
      facts({}), asOf);
    expect(q.state).toBe('NEEDS_REVIEW');
    expect(q.unknownStages).toEqual(['size', 'revenue']);
    expect(q.criteria.every((c) => c.verdict === 'unknown')).toBe(true);
  });

  it('never converts revenue between currencies', () => {
    const c = criteria({ revenueMin: 1_000_000, revenueMax: 10_000_000, revenueCurrency: 'CAD' });
    expect(prequalify(c, facts({ revenueAmount: 2_000_000, revenueCurrency: 'USD', revenueBasis: 'ESTIMATED' }), asOf).state).toBe('NEEDS_REVIEW');
    expect(prequalify(c, facts({ revenueAmount: 2_000_000, revenueCurrency: 'CAD', revenueBasis: 'ESTIMATED' }), asOf).state).toBe('QUALIFIED');
  });

  it('lets different searches target different sizes with the same business', () => {
    const b = facts({ employeeCount: 40, employeesBasis: 'REPORTED' });
    expect(prequalify(criteria({ employeeMin: 2, employeeMax: 20 }), b, asOf).state).toBe('REJECTED');
    expect(prequalify(criteria({ employeeMin: 10, employeeMax: 50 }), b, asOf).state).toBe('QUALIFIED');
    expect(prequalify(criteria({ employeeMin: 50, employeeMax: 200 }), b, asOf).failedStage).toBe('size');
  });

  it('records the basis of the value it judged on, so an estimate stays visible as an estimate', () => {
    const q = prequalify(criteria({ employeeMin: 5 }), facts({ employeeCountMin: 11, employeeCountMax: 50, employeesBasis: 'ESTIMATED' }), asOf);
    expect(q.criteria[0]).toMatchObject({ stage: 'size', verdict: 'pass', basis: 'ESTIMATED' });
  });

  it('rejects at the first failing stage in order and still explains every criterion', () => {
    const q = prequalify(criteria({ countryCode: 'GB', city: 'Manchester', excludeChains: true }),
      facts({ countryCode: 'GB', city: 'Leeds', independence: 'chain' }), asOf);
    expect(q.state).toBe('REJECTED');
    expect(q.failedStage).toBe('geography');
    expect(q.criteria.map((c) => [c.criterion, c.verdict])).toEqual([['country', 'pass'], ['city', 'fail'], ['exclude_chains', 'fail']]);
  });

  it('excludes chains, groups and franchises only when their structure is known', () => {
    const c = criteria({ excludeChains: true, excludeFranchises: true });
    expect(prequalify(c, facts({ independence: 'group' }), asOf).state).toBe('REJECTED');
    expect(prequalify(c, facts({ independence: 'franchise' }), asOf).state).toBe('REJECTED');
    expect(prequalify(c, facts({ independence: 'independent' }), asOf).state).toBe('QUALIFIED');
    expect(prequalify(c, facts({ independence: 'unknown' }), asOf).state).toBe('NEEDS_REVIEW');
  });

  it('does not read a failed or blocked website fetch as "no website"', () => {
    const absent = criteria({ websitePresence: 'absent' });
    expect(prequalify(absent, facts({ websiteStatus: 'WEBSITE_UNREACHABLE' }), asOf).state).toBe('NEEDS_REVIEW');
    expect(prequalify(absent, facts({ websiteStatus: 'WEBSITE_NOT_OBSERVED' }), asOf).state).toBe('QUALIFIED');
    expect(prequalify(absent, facts({ websiteStatus: 'WEBSITE_PRESENT' }), asOf).state).toBe('REJECTED');
    const required = criteria({ websitePresence: 'required' });
    expect(prequalify(required, facts({ websiteStatus: 'WEBSITE_UNREACHABLE' }), asOf).state).toBe('NEEDS_REVIEW');
  });

  it('applies radius, postcode prefix, signals, contactability and exclusions', () => {
    const manchester = { latitude: 53.4808, longitude: -2.2426 };
    expect(haversineKm(53.4808, -2.2426, 53.8008, -1.5491)).toBeGreaterThan(50);   // Manchester to Leeds
    const c = criteria({ centerLatitude: manchester.latitude, centerLongitude: manchester.longitude, radiusKm: 20, postalPrefix: 'M1',
      reviewCountMin: 10, ratingMin: 4, businessAgeMinYears: 2, requirePhone: true, excludeSuppressed: true,
      excludedDomains: ['bigchain.test'] });
    const ok = facts({ latitude: 53.47, longitude: -2.25, postalCode: 'm1 4bt', reviewCount: 25, rating: 4.6,
      incorporatedOn: '2015-03-01', phone: '0161 000 0000', domain: 'small.test' });
    expect(prequalify(c, ok, asOf).state).toBe('QUALIFIED');
    expect(prequalify(c, { ...ok, latitude: 53.8008, longitude: -1.5491 }, asOf).failedStage).toBe('geography');
    expect(prequalify(c, { ...ok, rating: 3.9 }, asOf).failedStage).toBe('signals');
    expect(prequalify(c, { ...ok, phone: null }, asOf).failedStage).toBe('contactability');
    expect(prequalify(c, { ...ok, domain: 'BigChain.test' }, asOf).failedStage).toBe('exclusions');
    expect(prequalify(c, { ...ok, history: { ...ok.history, suppressed: true } }, asOf).failedStage).toBe('exclusions');
    expect(prequalify(c, { ...ok, incorporatedOn: null }, asOf).state).toBe('NEEDS_REVIEW');
  });

  it('qualifies anything when the search sets no criteria', () => {
    expect(prequalify(NONE, UNKNOWN, asOf)).toEqual({ state: 'QUALIFIED', failedStage: null, unknownStages: [], criteria: [] });
  });
});
