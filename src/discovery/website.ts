// Website status. The one rule that matters: a fetch that failed, timed out or was blocked says
// nothing about whether the business has a website. Only a business profile or listing that shows
// no website, while no domain or URL is known, is WEBSITE_NOT_OBSERVED; the database refuses that
// status whenever an address is known.
import type { Db } from '../tenancy/index.js';
import type { WebsiteStatus } from './qualify.js';

export type ObservationBasis = 'OBSERVED' | 'INFERRED' | 'NOT_OBSERVABLE';

export type FetchOutcome =
  | { kind: 'response'; httpStatus: number }
  | { kind: 'error'; error: 'dns_not_found' | 'timeout' | 'tls' | 'connection_refused' | 'blocked' | 'other' };

/** Classifies a fetch of a KNOWN address. It can never return WEBSITE_NOT_OBSERVED. */
export function classifyWebsiteFetch(f: FetchOutcome): { status: Exclude<WebsiteStatus, 'WEBSITE_NOT_OBSERVED' | 'UNKNOWN'>; basis: ObservationBasis } {
  if (f.kind === 'response') {
    if (f.httpStatus >= 200 && f.httpStatus < 400) return { status: 'WEBSITE_PRESENT', basis: 'OBSERVED' };
    // Bot walls and rate limits hide the site; they do not show its absence.
    if ([401, 403, 407, 429].includes(f.httpStatus)) return { status: 'WEBSITE_UNREACHABLE', basis: 'NOT_OBSERVABLE' };
    if (f.httpStatus >= 500) return { status: 'WEBSITE_UNREACHABLE', basis: 'OBSERVED' };
    return { status: 'WEBSITE_NEEDS_REVIEW', basis: 'OBSERVED' };
  }
  if (f.error === 'dns_not_found' || f.error === 'connection_refused') return { status: 'WEBSITE_UNREACHABLE', basis: 'OBSERVED' };
  return { status: 'WEBSITE_UNREACHABLE', basis: 'NOT_OBSERVABLE' };
}

export async function recordWebsiteStatus(db: Db, businessId: string,
  s: { status: WebsiteStatus; basis: ObservationBasis; source: string; checkedAt: string }): Promise<void> {
  await db.query(
    `UPDATE scopely.businesses SET website_status = $2, website_status_basis = $3, website_status_source = $4,
       website_status_checked_at = $5 WHERE id = $1`, [businessId, s.status, s.basis, s.source, s.checkedAt]);
}
