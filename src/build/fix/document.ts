// The fix document: what one fix version is, stated as data. It is the version's manifest
// (fix.json), written once beside the corrected page copy (after.html) and the preview a prospect
// sees (index.html). It cites the evidence, the capture it was made from (by storage key and
// hash) and each corrected value, so every byte of the AFTER traces to something observed or to a
// value a person supplied.
import type { Channel } from './destination.js';

export const FIX_SCHEMA = 'scopely.fix/1';

export interface FixProblem {
  evidenceId: string;
  issueCode: string;
  plainIssue: string;
  quote: string;
  url: string;
  observedAt: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface FixCorrectionApplied {
  correctionId: string;
  evidenceId: string;
  channel: Channel;
  observedHref: string;
  correctedHref: string;
  /** How many links on the captured page carried the observed destination and were corrected. */
  replaced: number;
  /** The link's text on the captured page, and a little of the page around it. */
  label: string | null;
  context: { before: string; after: string } | null;
}

export interface FixDocument {
  schema: typeof FIX_SCHEMA;
  business: { name: string; domain: string | null };
  page: { url: string; finalUrl: string; capturedAt: string };
  problems: FixProblem[];
  capture: { captureId: string; ref: string; sha256: string; contentType: string };
  corrections: FixCorrectionApplied[];
  after: { ref: string; sha256: string };
}

/** Throws unless `v` is a fix document of this schema. */
export function assertFixDocument(v: unknown): asserts v is FixDocument {
  const d = v as FixDocument;
  if (!d || d.schema !== FIX_SCHEMA || !Array.isArray(d.corrections) || d.corrections.length === 0 || !d.capture?.ref || !d.after?.ref) {
    throw new Error('not a fix document');
  }
}
