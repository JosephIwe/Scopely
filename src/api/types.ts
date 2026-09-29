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
  /** The business's public phone number, as a source listed it. */
  phone: string | null;
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
  /** The latest version's human lifecycle state. */
  buildState: BuildState;
  /** The latest agent run's execution state: never merged into buildState. */
  buildRunState: 'NONE' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
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

// ------------------------------------------------------------------ searches (saved criteria)

/** A saved search exactly as the seller defined it. Every criterion is present; null / [] / false means not set. */
export interface SearchDefinition {
  searchId: string;
  name: string;
  description: string | null;
  playbookKey: string | null;
  geography: { countryCode: string | null; region: string | null; city: string | null; postalPrefix: string | null;
               center: { latitude: string; longitude: string } | null; radiusKm: string | null };
  industry: { verticals: string[]; subverticals: string[]; specialties: string[] };
  employees: { min: number | null; max: number | null };
  revenue: { min: string | null; max: string | null; currency: string | null };
  structure: { businessTypes: string[]; excludeChains: boolean; excludeFranchises: boolean };
  website: { presence: 'any' | 'required' | 'absent'; statuses: WebsiteStatus[] };
  opportunityKinds: string[];
  reviews: { countMin: number | null; countMax: number | null; ratingMin: string | null; ratingMax: string | null };
  businessAge: { minYears: number | null; maxYears: number | null };
  contactability: { requirePublicEmail: boolean; requirePhone: boolean; requireDomain: boolean };
  exclusions: { previouslyAnalyzed: boolean; previouslyContacted: boolean; existingClients: boolean; won: boolean; lost: boolean;
                suppressed: boolean; domains: string[]; businessTypes: string[] };
  limits: { maxBusinessesToAnalyze: number | null; analysisBudgetCredits: string | null; maxDiscoveredPerRun: number | null };
  runs: { searchRunId: string; status: 'OPEN' | 'COMPLETED' | 'CANCELLED'; startedAt: string; completedAt: string | null }[];
  createdByUserId: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface SearchListItem {
  searchId: string;
  name: string;
  runs: number;
  lastRunAt: string | null;
  createdAt: string;
  archivedAt: string | null;
}

// ------------------------------------------------------------------ build workspace

/** The human lifecycle of a version. Never an agent's execution state. */
export type BuildVersionStatus = 'DRAFT' | 'APPROVED' | 'SHOWN' | 'DISCARDED' | 'SUPERSEDED';
/** An agent run's execution state. Never a version's approval state. */
export type BuildRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type Payer = 'SCOPELY' | 'WORKSPACE' | 'UNATTRIBUTED';

/** Cost grouped by who pays. UNATTRIBUTED is cost recorded before payers were (or with no payer). */
export interface CostByPayer {
  payer: Payer;
  events: number;
  /** null when any event's amount is unknown or currencies differ. */
  amount: string | null;
  currency: string | null;
  /** Scopely credits. Always "0" for WORKSPACE; null when any metered event has no credits recorded. */
  credits: string | null;
  operatorMinutes: string | null;
}

export interface BuildRunView {
  runId: string;
  projectId: string;
  purpose: 'DEMO' | 'DELIVERY';
  agent: { key: string; version: string | null };
  providerConnection: { connectionId: string; provider: string; mode: 'SCOPELY_MANAGED' | 'CUSTOMER_KEY'; billedTo: 'SCOPELY' | 'WORKSPACE' } | null;
  status: BuildRunStatus;
  baseBuildId: string | null;
  producedBuildId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  /** Free text until authentication exists (B10). */
  startedByUserId: string | null;
  cost: CostByPayer[];
}

export interface BuildVersionView {
  buildId: string;
  projectId: string;
  versionNo: number;
  purpose: 'DEMO' | 'DELIVERY';
  status: BuildVersionStatus;
  title: string;
  summary: string;
  supersedesBuildId: string | null;
  successorBuildId: string | null;
  deliveryOfBuildId: string | null;
  generator: string;
  /** The reviewable artifact (preview or file), when one exists. A reference, never an invented URL. */
  previewRef: string | null;
  manifestRef: string | null;
  evidence: EvidenceItem[];
  approval: { approved: boolean; approvedAt: string | null; approvedBy: string | null; approvedByIsAuthenticated: false };
  shown: { shown: boolean; shownAt: string | null };
  /** Computed by the server. canShow = false always carries a reason. */
  /** Computed by the server. canShow answers "could this be marked shown at `asOf`" (default: now). */
  gate: { canApprove: boolean; approveBlocker: string | null; canShow: boolean; showBlocker: string | null; asOf: string };
  producedByRun: { runId: string; agentKey: string } | null;
  cost: CostByPayer[];
  createdAt: string;
}

export interface BuildProjectView {
  projectId: string;
  title: string;
  buildKind: string;
  path: OpportunityPath;
  storagePrefix: string;
  createdAt: string;
  createdByUserId: string | null;
  opportunity: {
    opportunityId: string; opportunityType: string; kind: string | null; status: string;
    business: { businessId: string; name: string };
    service: { catalogKey: string | null; name: string | null; price: string | null; currency: string | null };
    sellState: SellState; deliveryState: DeliveryState; won: boolean;
  };
  /** The newest version that is not superseded or discarded, else null. */
  currentVersion: BuildVersionView | null;
  /** Every version, oldest first. */
  versions: BuildVersionView[];
  /** Newest first. */
  runs: BuildRunView[];
  /** Latest run's state, separate from any version's status. NONE when no run exists. */
  runState: BuildRunStatus | 'NONE';
  requirements: { requirementId: string; requirement: string; source: 'seller' | 'client'; recordedBy: string; recordedAt: string }[];
  assets: { assetId: string; kind: string; storageRef: string; description: string; providedBy: 'seller' | 'client' }[];
  cost: CostByPayer[];
}

export interface BuildProjectListItem {
  projectId: string;
  opportunityId: string;
  title: string;
  buildKind: string;
  versions: number;
  latestVersionStatus: BuildVersionStatus | null;
  runState: BuildRunStatus | 'NONE';
  createdAt: string;
}

// ------------------------------------------------------------------ product shell and case file (Slice 8)

/** Where an opportunity sits in the lifecycle. Discover is every opportunity, not a stage of one. */
export type FeedStage = 'OPPORTUNITIES' | 'BUILD' | 'SELL' | 'DELIVER' | 'VERIFY';

export interface OpportunityBuildInfo {
  /** A website build can start (a mapped service on the website path). */
  buildable: boolean;
  projectId: string | null;
  /** A fix build can start (an OBSERVED broken contact link that still holds, F1). */
  fixable: boolean;
  fixProjectId: string | null;
}

export interface CaseFileContact {
  contactId: string;
  name: string | null;
  role: string | null;
  isDecisionMaker: boolean;
  email: string | null;
  emailKind: 'role' | 'personal' | null;
  label: 'VERIFIED' | 'PUBLICLY_FOUND' | 'UNVERIFIED';
  source: string;
  sourceUrl: string | null;
  outreachBasis: 'corporate_subscriber' | 'consent' | 'not_permitted' | 'unknown' | null;
  /** Why this contact may not be emailed (the database's contact_outreach_blocker), or null. */
  emailBlocker: string | null;
}

export interface CaseFileOutcome {
  outcomeId: string;
  kind: 'pitched' | 'replied' | 'call' | 'won' | 'lost' | 'delivered' | 'voided';
  occurredAt: string;
  channel: string | null;
  replyClass: string | null;
  /** A won outcome's agreed amount, as the seller entered it. Never a payment. */
  amount: string | null;
  currency: string | null;
  notes: string | null;
  recordedBy: string;
  correctsOutcomeId: string | null;
  /** A later voided outcome names this one. */
  voided: boolean;
  recordedAt: string;
}

export interface CaseFile {
  opportunityId: string;
  path: OpportunityPath | null;
  kind: string | null;
  opportunityType: string;
  status: string;
  stage: FeedStage;
  createdAt: string;
  situation: { whyItMatters: string | null; notObservable: string | null };
  /** This opportunity's own evidence, strongest first. */
  evidence: (EvidenceItem & { observedHref: string | null; visibleText: string | null })[];
  business: Pick<BusinessDetail, 'businessId' | 'name' | 'domain' | 'websiteUrl' | 'phone' | 'vertical' | 'subvertical' | 'specialty'
    | 'location' | 'website' | 'company' | 'firmographics'> & { sources: { provider: string | null; sourceType: string; foundAt: string }[] };
  service: { mappingStatus: 'MAPPED' | 'UNMAPPED'; catalogKey: string | null; name: string | null; price: string | null; currency: string | null;
             unmappedReason: string | null };
  build: {
    builder: 'website' | 'fix' | null;
    projectId: string | null;
    canStart: boolean;
    /** Why no builder can open, or null. */
    blocker: string | null;
    buildState: BuildState;
    runState: string;
    versions: number;
    current: { buildId: string; versionNo: number; status: string; summary: string; createdAt: string;
               approvedAt: string | null; approvedBy: string | null; shownAt: string | null } | null;
  };
  buyer: { contacts: CaseFileContact[] };
  outreach: {
    /** HIGH findings not yet re-checked on a new snapshot (rule 12): re-check before they reach a prospect. */
    recheckNeeded: { evidenceId: string; plainIssue: string }[];
    /** Findings a re-check found changed or gone: never cite them. */
    noLongerHolds: { evidenceId: string; plainIssue: string; result: 'changed' | 'gone' }[];
  };
  sell: {
    sellState: SellState;
    deliveryState: DeliveryState;
    pitchedAt: string | null; replyAt: string | null; wonAt: string | null; lostAt: string | null;
    /** The won outcome's amount, entered by the seller. Not a payment. */
    agreedAmount: string | null;
    currency: string | null;
    /** The append-only ledger, oldest first. */
    outcomes: CaseFileOutcome[];
    terminalOutcomeId: string | null;
    can: { pitched: boolean; replied: boolean; call: boolean; won: boolean; lost: boolean; voided: boolean };
  };
}
