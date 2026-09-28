// The contract the frontend reads. Every shape here is produced by src/api/queries.ts from the
// v_* views, scoped to the request's workspace. Conventions:
//   * ids are strings (Postgres bigint);
//   * counts are numbers;
//   * money and credits are decimal strings ("350.00") with their currency, never floats;
//   * null means NOT KNOWN and must be shown as unknown, never as 0.
// docs/API_CONTRACT.md describes each shape and the request that returns it.

export type OpportunityPath = 'WEBSITE' | 'FIX';
export type RunBusinessState = 'DISCOVERED' | 'QUALIFIED' | 'REJECTED' | 'NEEDS_REVIEW' | 'SELECTED' | 'ANALYSIS_QUEUED'
  | 'ANALYZED' | 'OPPORTUNITY_FOUND' | 'NO_OPPORTUNITY';
export type WebsiteStatus = 'UNKNOWN' | 'WEBSITE_PRESENT' | 'WEBSITE_NOT_OBSERVED' | 'WEBSITE_UNREACHABLE' | 'WEBSITE_NEEDS_REVIEW';
export type Basis = 'VERIFIED' | 'REPORTED' | 'ESTIMATED';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type SellState = 'NOT_STARTED' | 'DRAFTED' | 'APPROVED' | 'SENT' | 'PITCHED' | 'REPLIED' | 'WON' | 'LOST';
export type BuildState = 'NONE' | `${'DEMO' | 'DELIVERY'}_${'DRAFT' | 'APPROVED' | 'SHOWN'}`;
export type DeliveryState = 'NONE' | 'AWAITING_DELIVERY' | 'DELIVERED' | `VERIFIED_${'PASSED' | 'FAILED' | 'NOT_OBSERVABLE' | 'CLIENT_REQUIRED_UNCONFIRMED'}`;

export interface SearchRunSummary {
  searchRunId: string;
  searchId: string;
  searchName: string;
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  startedAt: string;
  completedAt: string | null;
  counts: {
    discovered: number; qualified: number; rejected: number; needsReview: number; selected: number;
    analysisQueued: number; analyzed: number; businessesWithOpportunity: number; businessesWithoutOpportunity: number;
    opportunities: number; websiteOpportunities: number; fixOpportunities: number; pitched: number; wins: number;
  };
  limits: { maxBusinessesToAnalyze: number | null; budgetCredits: string | null };
  credits: { consumed: string | null; estimatedPending: string | null; remaining: string | null };
  analysisCost: { amount: string | null; currency: string | null };
  revenue: string | null;
  revenuePer100Discovered: string | null;
  revenuePer100Analyzed: string | null;
}

export interface StageFunnelRow {
  stageOrder: number;
  stage: string;
  evaluated: number;
  rejectedAtStage: number;
  needsReviewAtStage: number;
  remainingAfterStage: number;
}

export interface CriterionResult { stage: string; criterion: string; verdict: 'pass' | 'fail' | 'unknown'; expected: unknown; actual: unknown; basis?: string | null }

export interface RunBusinessRow {
  businessId: string;
  name: string;
  city: string | null;
  countryCode: string | null;
  state: RunBusinessState;
  failedStage: string | null;
  unknownStages: string[];
  qualification: CriterionResult[] | null;
  estimatedCredits: string | null;
  source: { provider: string | null; sourceType: string; reference: string } | null;
}

export interface Firmographics {
  employees: { count: number | null; min: number | null; max: number | null; basis: Basis | null; source: string | null; asOf: string | null };
  revenue: { amount: string | null; min: string | null; max: string | null; currency: string | null; basis: Basis | null; source: string | null; asOf: string | null };
  reviews: { count: number | null; rating: string | null; source: string | null; asOf: string | null };
  independence: string | null;
  incorporatedOn: string | null;
}

export interface EvidenceItem {
  evidenceId: string;
  issueCode: string;
  plainIssue: string;
  url: string;
  quote: string;
  claimState: 'OBSERVED' | 'INFERRED';
  confidence: Confidence;
  observedAt: string;
  snapshotId: string;
  observationId: string;
  rule: { key: string; version: number };
  recheck: { result: 'confirmed' | 'changed' | 'gone'; at: string } | null;
}

export interface BusinessDetail {
  businessId: string;
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  vertical: string | null;
  subvertical: string | null;
  specialty: string | null;
  location: { addressLine: string | null; city: string | null; region: string | null; postalCode: string | null; countryCode: string | null;
              latitude: string | null; longitude: string | null; geoSource: string | null };
  website: { status: WebsiteStatus; basis: 'OBSERVED' | 'INFERRED' | 'NOT_OBSERVABLE' | null; source: string | null; checkedAt: string | null };
  company: { register: string | null; number: string | null; type: string | null; status: string | null };
  firmographics: Firmographics;
  sources: { provider: string | null; sourceType: string; reference: string; searchRunId: string | null; foundAt: string }[];
  searchRuns: { searchRunId: string; searchId: string; state: RunBusinessState }[];
  evidence: EvidenceItem[];
  opportunities: OpportunityFeedItem[];
}

export interface OpportunityFeedItem {
  opportunityId: string;
  kind: string | null;
  path: OpportunityPath | null;
  opportunityType: string;
  status: string;
  searchRunId: string | null;
  searchId: string | null;
  business: {
    businessId: string; name: string; domain: string | null; vertical: string | null; subvertical: string | null; specialty: string | null;
    countryCode: string | null; region: string | null; city: string | null; latitude: string | null; longitude: string | null;
    employees: { count: number | null; min: number | null; max: number | null; basis: Basis | null };
    revenue: { amount: string | null; min: string | null; max: string | null; currency: string | null; basis: Basis | null };
    independence: string | null;
    websiteStatus: WebsiteStatus;
  };
  service: { mappingStatus: 'MAPPED' | 'UNMAPPED'; catalogKey: string | null; name: string | null; price: string | null; currency: string | null };
  evidence: { count: number; issueCodes: string[]; claimStates: string[]; topConfidence: Confidence | null };
  buildState: BuildState;
  sellState: SellState;
  deliveryState: DeliveryState;
  dealValue: string | null;
  createdAt: string;
}

export interface OpportunityFeedFilters {
  kinds?: string[];
  paths?: OpportunityPath[];
  verticals?: string[];
  subverticals?: string[];
  countryCode?: string;
  region?: string;
  city?: string;
  /** Businesses whose known size lies wholly inside the range. Unknown size is excluded unless includeUnknownSize. */
  employeeMin?: number;
  employeeMax?: number;
  includeUnknownSize?: boolean;
  /** Same, in revenueCurrency only; revenue in another currency is never converted. */
  revenueMin?: number;
  revenueMax?: number;
  revenueCurrency?: string;
  includeUnknownRevenue?: boolean;
  catalogKeys?: string[];
  minConfidence?: Confidence;
  statuses?: string[];
  buildStates?: BuildState[];
  sellStates?: SellState[];
  searchId?: string;
  searchRunId?: string;
  limit?: number;
  offset?: number;
}

export interface MapQuery {
  bounds?: { north: number; south: number; east: number; west: number };
  near?: { latitude: number; longitude: number; radiusKm: number };
  city?: string;
  region?: string;
  countryCode?: string;
  limit?: number;
}

export interface MapPoint {
  businessId: string;
  name: string;
  latitude: string;
  longitude: string;
  addressLine: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  websiteStatus: WebsiteStatus;
  opportunities: number;
  opportunityPaths: OpportunityPath[];
  opportunityKinds: string[];
}

export interface SearchPerformance {
  searchId: string;
  name: string;
  runs: number;
  discovered: number; qualified: number; analyzed: number;
  opportunities: number; websiteOpportunities: number; fixOpportunities: number;
  pitched: number; wins: number;
  revenue: string | null;
  creditsConsumed: string | null;
  revenuePer100Discovered: string | null;
}
