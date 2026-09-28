// Golden-set fixture types. A golden case is a real business that was audited by hand in
// OutboundOS rounds 1-2, with what Scopely is expected to conclude about it.

export type ExpectedOutcome = 'QUALIFIED' | 'REJECTED' | 'NEEDS_BROWSER_CHECK';

// OBSERVED: the source recorded it from page markup or text.
// NEEDS_BROWSER_CHECK: the source said it could not confirm it without a real browser.
// MUST_NOT_CLAIM: the source withdrew the claim or said not to make it. Emitting it is a
// false positive.
export type FindingExpectation = 'OBSERVED' | 'NEEDS_BROWSER_CHECK' | 'MUST_NOT_CLAIM';

export const REJECTION_CATEGORIES = [
  'WRONG_BUSINESS_TYPE', 'CLOSED', 'CHAIN_OR_GROUP', 'SERVICE_ALREADY_SOLVED',
  'NO_CREDIBLE_OPPORTUNITY', 'EVIDENCE_TOO_WEAK', 'OPPORTUNITY_TOO_SMALL',
  'NOT_COMMERCIALLY_VIABLE', 'COMPLIANCE', 'INSUFFICIENT_EVIDENCE', 'OUT_OF_GEOGRAPHY',
] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

export interface SourceRef {
  file: string;          // file name under fixtures/golden/sources/outboundos/
  line: number;          // 1-based line in that file
  field?: string;        // CSV column, when the text came from one
}

export interface ExpectedFinding {
  issue_code: string;                 // curated
  expectation: FindingExpectation;    // curated
  verbatim_quote: string;             // exact text from the source
  source: SourceRef;
  url: string | null;
  url_basis: 'evidence_url' | 'business_website' | 'unknown';
  note?: string;
}

export interface GoldenCase {
  id: string;
  round: 1 | 2;
  recorded_on: string;                // date the source audit was written
  business: {
    name: string;
    website_as_recorded: string | null;
    domain: string | null;
    vertical: string;
    country_code: string;
    city: string | null;
  };
  historical_decision: string;        // verbatim label from the source
  historical_reason: string | null;   // verbatim
  historical_offer: string | null;    // verbatim
  expected_outcome: ExpectedOutcome;
  outcome_basis: 'historical_decision' | 'curated_override';
  outcome_note?: string;
  rejection?: {
    category: RejectionCategory;      // curated
    reason_verbatim: string;
    category_note?: string;
  };
  findings: ExpectedFinding[];
  supersedes?: string;                // an earlier case for the same business
  superseded_by?: string;
  sources: SourceRef[];
}

export interface GoldenSet {
  schema_version: 1;
  generated_from: {
    repository: string;
    files: { file: string; branch: string; commit: string; path: string; sha256: string }[];
  };
  counts: Record<string, number>;
  cases: GoldenCase[];
}
