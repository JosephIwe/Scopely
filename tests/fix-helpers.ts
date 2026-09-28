// Fixtures for the Fix Builder (Slice 7): a website_fix opportunity on the seeded chain's
// E-LINK-TARGET-MISMATCH evidence (a WhatsApp label whose link is tel:WhatsApp:0800), and a page
// fetcher that serves a captured copy of that page without touching the network.
import type pg from 'pg';
import { CaptureError, type FetchedPage, type PageFetcher } from '../src/build/fix/index.js';
import { one, seedChain, seedOpportunity } from './helpers.js';

/**
 * The page the evidence was observed on. Two links carry the broken destination (one in double
 * quotes, one in single quotes); a comment and a script mention it too and must never change.
 */
export const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Example Clinic</title>
<script>var tpl = '<a href="tel:WhatsApp:0800">x</a>';</script></head>
<body><!-- old: <a href="tel:WhatsApp:0800">old</a> -->
<p>Book a consultation with our team today.</p>
<a class="wa" href="tel:WhatsApp:0800">WhatsApp: 0800</a>
<p>Open Monday to Saturday.</p>
<footer><a href='tel:WhatsApp:0800'>Chat on WhatsApp</a> <a href="tel:+442079460000">Call us</a> Café &amp; clinic</footer>
</body></html>`;

export class StubFetcher implements PageFetcher {
  calls: string[] = [];
  constructor(public page: string | null = PAGE, public status = 200) {}
  async fetch(url: string): Promise<FetchedPage> {
    this.calls.push(url);
    if (this.page === null) throw new CaptureError('example-clinic.test could not be found.');
    return { requestedUrl: url, finalUrl: url, status: this.status, contentType: 'text/html; charset=utf-8', bytes: Buffer.from(this.page, 'utf8') };
  }
}

/** A website_fix opportunity mapped to the shared Website Fix Sprint, on one VALIDATED contact-link finding. */
export async function seedFixOpportunity(db: pg.Client) {
  const c = await seedChain(db);
  const opportunityId = await seedOpportunity(db, c);
  return { ...c, opportunityId };
}

/** Adds a second evidence row of the given issue code to an opportunity. */
export async function addEvidence(db: pg.Client, c: { businessId: string; snapshotId: string; ruleId: string }, opportunityId: string,
  opts: { code: string; href?: string | null; claim?: 'OBSERVED' | 'INFERRED'; rule?: string }) {
  const rule = opts.rule ?? c.ruleId;
  const o = await one<{ id: string }>(db, `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result, href, visible_text, observed_at, inferred_from)
    VALUES ($1, 'contact_links.other', $2, $3, 'defect', $4, 'Link', '2026-09-28T10:00:00Z', $5) RETURNING id`,
    [c.snapshotId, rule, opts.claim ?? 'OBSERVED', opts.href === undefined ? 'tel:0800BROKEN' : opts.href, opts.claim === 'INFERRED' ? '{1}' : null]);
  const e = await one<{ id: string }>(db, `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, observed_at, confidence)
    VALUES ($1, $2, $3, $4, $5, 'Another link', 'https://example-clinic.test/', 'href', '2026-09-28T10:00:00Z', 'HIGH') RETURNING id`,
    [c.businessId, o.id, opts.code, rule, opts.claim ?? 'OBSERVED']);
  await db.query('INSERT INTO opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2)', [opportunityId, e.id]);
  return e.id;
}

/** Records a re-check that found the finding changed, so it no longer holds. */
export async function recheckChanged(db: pg.Client, businessId: string, evidenceId: string, at = '2026-10-01T09:00:00Z') {
  const s = await one<{ id: string }>(db, `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'https://example-clinic.test/', $2, 'manual') RETURNING id`, [businessId, at]);
  await db.query(`INSERT INTO evidence_rechecks (evidence_id, snapshot_id, result, recorded_by, notes) VALUES ($1, $2, 'changed', 'operator', 'The link now opens a different number')`, [evidenceId, s.id]);
}
