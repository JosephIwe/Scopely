// A search is a workspace's reusable ICP: who the seller wants to find. Every field is optional
// and set by the seller; nothing here assumes a niche, geography, size, revenue band or service.
// The column each field is stored in is listed once, in COLUMNS, and used both ways.
import type { Db } from '../tenancy/index.js';

export type WebsitePresence = 'any' | 'required' | 'absent';

export interface SearchCriteria {
  // geography
  countryCode?: string | null;
  region?: string | null;
  city?: string | null;
  postalPrefix?: string | null;
  centerLatitude?: number | null;
  centerLongitude?: number | null;
  radiusKm?: number | null;
  // industry: industry = vertical, niche = subvertical, sub-niche = specialty
  verticals: string[];
  subverticals: string[];
  specialties: string[];
  // company size and revenue
  employeeMin?: number | null;
  employeeMax?: number | null;
  revenueMin?: number | null;
  revenueMax?: number | null;
  revenueCurrency?: string | null;
  // structure: allowed values of businesses.independence
  businessTypes: string[];
  excludeChains: boolean;
  excludeFranchises: boolean;
  // online presence
  websitePresence: WebsitePresence;
  websiteStatuses: string[];
  // what the seller wants to find (build kind keys, e.g. 'website', 'lead_recovery')
  opportunityKinds: string[];
  // business signals
  reviewCountMin?: number | null;
  reviewCountMax?: number | null;
  ratingMin?: number | null;
  ratingMax?: number | null;
  businessAgeMinYears?: number | null;
  businessAgeMaxYears?: number | null;
  // contactability
  requirePublicEmail: boolean;
  requirePhone: boolean;
  requireDomain: boolean;
  // exclusions
  excludePreviouslyAnalyzed: boolean;
  excludePreviouslyContacted: boolean;
  excludeExistingClients: boolean;
  excludeWon: boolean;
  excludeLost: boolean;
  excludeSuppressed: boolean;
  excludedDomains: string[];
  excludedBusinessTypes: string[];
  // resource limits
  maxBusinessesToAnalyze?: number | null;
  analysisBudgetCredits?: number | null;
  maxDiscoveredPerRun?: number | null;
}

export interface SearchInput extends Partial<SearchCriteria> {
  name: string;
  description?: string;
  playbookKey?: string;
  createdByUserId?: string;
}

const COLUMNS: Record<keyof SearchCriteria, string> = {
  countryCode: 'country_code', region: 'region', city: 'city', postalPrefix: 'postal_prefix',
  centerLatitude: 'center_latitude', centerLongitude: 'center_longitude', radiusKm: 'radius_km',
  verticals: 'verticals', subverticals: 'subverticals', specialties: 'specialties',
  employeeMin: 'employee_min', employeeMax: 'employee_max',
  revenueMin: 'revenue_min', revenueMax: 'revenue_max', revenueCurrency: 'revenue_currency',
  businessTypes: 'business_types', excludeChains: 'exclude_chains', excludeFranchises: 'exclude_franchises',
  websitePresence: 'website_presence', websiteStatuses: 'website_statuses', opportunityKinds: 'opportunity_kinds',
  reviewCountMin: 'review_count_min', reviewCountMax: 'review_count_max', ratingMin: 'rating_min', ratingMax: 'rating_max',
  businessAgeMinYears: 'business_age_min_years', businessAgeMaxYears: 'business_age_max_years',
  requirePublicEmail: 'require_public_email', requirePhone: 'require_phone', requireDomain: 'require_domain',
  excludePreviouslyAnalyzed: 'exclude_previously_analyzed', excludePreviouslyContacted: 'exclude_previously_contacted',
  excludeExistingClients: 'exclude_existing_clients', excludeWon: 'exclude_won', excludeLost: 'exclude_lost',
  excludeSuppressed: 'exclude_suppressed', excludedDomains: 'excluded_domains', excludedBusinessTypes: 'excluded_business_types',
  maxBusinessesToAnalyze: 'max_businesses_to_analyze', analysisBudgetCredits: 'analysis_budget_credits',
  maxDiscoveredPerRun: 'max_discovered_per_run',
};

const NUMERIC = new Set<keyof SearchCriteria>(['centerLatitude', 'centerLongitude', 'radiusKm', 'revenueMin', 'revenueMax',
  'ratingMin', 'ratingMax', 'analysisBudgetCredits']);

/** Creates a search in the current workspace. Fields left out take the column defaults (empty / off). */
export async function createSearch(db: Db, s: SearchInput): Promise<string> {
  const cols = ['name', 'description', 'playbook_id', 'created_by_user_id'];
  const vals: unknown[] = [s.name, s.description ?? null, null, s.createdByUserId ?? null];
  if (s.playbookKey) {
    const p = await db.query<{ id: string }>('SELECT id FROM scopely.niche_playbooks WHERE key = $1', [s.playbookKey]);
    if (!p.rows[0]) throw new Error(`unknown playbook ${s.playbookKey}`);
    vals[2] = p.rows[0].id;
  }
  for (const [field, col] of Object.entries(COLUMNS) as [keyof SearchCriteria, string][]) {
    if (s[field] === undefined) continue;
    cols.push(col);
    vals.push(s[field]);
  }
  const r = await db.query<{ id: string }>(
    `INSERT INTO scopely.searches (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals);
  return r.rows[0]!.id;
}

/** Reads criteria from a searches row or a run's frozen criteria (both are snake_case). */
export function criteriaFromRow(row: Record<string, unknown>): SearchCriteria {
  const c: Record<string, unknown> = {};
  for (const [field, col] of Object.entries(COLUMNS) as [keyof SearchCriteria, string][]) {
    const v = row[col];
    c[field] = v === null || v === undefined ? v ?? null : NUMERIC.has(field) ? Number(v) : v;
  }
  return c as unknown as SearchCriteria;
}
