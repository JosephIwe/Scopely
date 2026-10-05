// Fixtures for Slice 11 (ANALYZE): a search run with businesses in any state, and a probe that
// answers from a table of pages instead of the network.
import type pg from 'pg';
import type { Probe, ProbeResult } from '../src/analysis/index.js';
import { one, ruleId } from './helpers.js';

export const AT = '2026-10-05T12:00:00.000Z';

type Answer =
  | { html?: string; status?: number; contentType?: string; redirectFrom?: { url: string; status: number }[]; finalUrl?: string }
  | { error: 'dns_not_found' | 'timeout' | 'tls' | 'connection_refused' | 'blocked' | 'too_large' | 'too_many_redirects' | 'other' };

/** Answers each URL from `pages`; anything else is a host that does not exist. Records every request. */
export class TableProbe implements Probe {
  calls: { url: string; body: boolean }[] = [];
  constructor(public pages: Record<string, Answer> = {}) {}
  async get(url: string, opts: { body?: boolean } = {}): Promise<ProbeResult> {
    this.calls.push({ url, body: opts.body !== false });
    const a = this.pages[url];
    if (!a) return { kind: 'error', requestedUrl: url, lastUrl: url, hops: [], fetchedAt: AT, error: 'dns_not_found' };
    if ('error' in a) return { kind: 'error', requestedUrl: url, lastUrl: url, hops: [], fetchedAt: AT, error: a.error };
    const status = a.status ?? 200;
    const ok = status >= 200 && status < 300;
    return { kind: 'response', requestedUrl: url, finalUrl: a.finalUrl ?? url, status, contentType: a.contentType ?? 'text/html; charset=utf-8',
      html: ok && opts.body !== false && a.html !== undefined ? a.html : null, hops: a.redirectFrom ?? [], fetchedAt: AT };
  }
}

/** A clinic page with every kind of contact link: two broken ones, a mismatched label, and working ones. */
export const CLINIC = `<!doctype html><html><head><meta charset="utf-8"><title>Harbour Clinic</title>
<meta name="description" content="Independent clinic">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>var x = '<a href="tel:+4400000">not a link</a>';</script></head>
<body><!-- <a href="https://wa.me/07700900461">old</a> -->
<nav><a href="/contact">Contact</a></nav>
<p>Welcome to our clinic. We look after families across the city with care and good sense.</p>
<a class="wa" href="https://api.whatsapp.com/send?phone=07700900461">WhatsApp us</a>
<a href="tel:+4402079460000">Call 020 7946 0000</a>
<a href="tel:+442079460001">Reception</a>
<a href="tel:+442079460002">Message us on WhatsApp</a>
<a href="mailto:hello@yourdomain.com">Email us</a>
<a href="mailto:team@harbourclinic.co.uk">Team</a>
<a href="https://wa.me/447700900462">Chat</a>
<form action="/enquire" method="post"><input name="name"><input type="hidden" name="t"><textarea name="m"></textarea></form>
</body></html>`;

/** A page whose only problem is a booking link to a page that no longer exists. */
export const BOOKING = `<!doctype html><html><head><title>Lane Physio</title><meta name="viewport" content="width=device-width"></head>
<body><p>Physiotherapy for runners and everyone else in the neighbourhood, six days a week.</p>
<a href="https://book.lanephysio.test/old">Book an appointment</a>
<a href="#">Book now</a>
<a href="https://lanephysio.test/contact">Contact us</a>
<script src="https://widget.example-cdn.test/w.js"></script></body></html>`;

export const PLATFORM = `<!doctype html><html><head><title>Oak Dental</title></head>
<body><p>Family dentistry.</p><a href="https://oakdental.setmore.com/">Book online</a><a href="tel:01132000000">Call us</a></body></html>`;

/** A search (no limits beyond those given) and an OPEN run of it in the current workspace. */
export async function seedRun(db: pg.Client, opts: { budget?: number; kinds?: string[]; maxAnalyze?: number } = {}) {
  const s = await one<{ id: string }>(db,
    `INSERT INTO searches (name, analysis_budget_credits, opportunity_kinds, max_businesses_to_analyze) VALUES ('Clinics', $1, $2, $3) RETURNING id`,
    [opts.budget ?? null, opts.kinds ?? [], opts.maxAnalyze ?? null]);
  const r = await one<{ id: string }>(db, 'INSERT INTO search_runs (search_id) VALUES ($1) RETURNING id', [s.id]);
  return { searchId: s.id, runId: r.id };
}

/** A business in the run, moved to `state` (DISCOVERED, QUALIFIED, REJECTED or SELECTED). */
export async function runBusiness(db: pg.Client, runId: string, b: { name?: string; domain?: string | null; websiteUrl?: string | null; vertical?: string | null },
  state: 'DISCOVERED' | 'QUALIFIED' | 'REJECTED' | 'SELECTED' = 'SELECTED') {
  const biz = await one<{ id: string }>(db, `INSERT INTO businesses (name, domain, website_url, vertical) VALUES ($1, $2, $3, $4) RETURNING id`,
    [b.name ?? 'Harbour Clinic', b.domain === undefined ? `clinic-${Math.random().toString(36).slice(2, 8)}.test` : b.domain, b.websiteUrl ?? null, b.vertical ?? null]);
  await db.query('INSERT INTO search_run_businesses (search_run_id, business_id) VALUES ($1, $2)', [runId, biz.id]);
  if (state === 'DISCOVERED') return biz.id;
  const rule = await ruleId(db, 'qualify.search_criteria');
  await db.query(`UPDATE search_run_businesses SET state = $3, qualification = '[]', qualification_rule_version_id = $4, qualified_at = $5,
      failed_stage = CASE WHEN $3 = 'REJECTED' THEN 'industry' END WHERE search_run_id = $1 AND business_id = $2`,
    [runId, biz.id, state === 'REJECTED' ? 'REJECTED' : 'QUALIFIED', rule, AT]);
  if (state === 'SELECTED') {
    await db.query(`UPDATE search_run_businesses SET state = 'SELECTED', selected_at = $3, selected_by = 'Seller' WHERE search_run_id = $1 AND business_id = $2`,
      [runId, biz.id, AT]);
  }
  return biz.id;
}
