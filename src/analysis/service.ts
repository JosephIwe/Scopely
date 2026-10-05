// ANALYZE → evidence → OPPORTUNITY for one business a seller selected in a search run (Slice 11).
//
//   SELECTED → ANALYSIS_QUEUED → (fetch, check, record) → ANALYZED → OPPORTUNITY_FOUND | NO_OPPORTUNITY
//
// Everything is written through the existing tables and guards: a snapshot per page Scopely
// requested, observations in OBSERVED / INFERRED / NOT_OBSERVABLE, evidence only for an OBSERVED
// gap or defect with an issue code, the business's website status through classifyWebsiteFetch,
// and an opportunity only where the catalog maps the finding to a service (mapping.catalog_v1).
// No model is called, no form is submitted, no business is contacted, and no page is stored: the
// snapshot keeps the page's hash, the evidence keeps the link exactly as served.
//
// The caller owns the transaction. One call analyses one business once: the run's state machine
// and business_analyses' (run, business) key make a second call return the first result.
import { createHash } from 'node:crypto';
import type { Db } from '../tenancy/index.js';
import { recordWebsiteStatus } from '../discovery/website.js';
import { ANALYZER, type CheckObservation, contactObservations, ctaObservations, platformObservations, presenceObservation, signalObservations } from './checks.js';
import { assertCapturableUrl } from '../build/fix/fetch.js';
import type { Probe } from './fetch.js';
import { clean, readPage } from './html.js';

/** A refusal the seller can act on. Its message names no internals. */
export class AnalysisRefused extends Error {
  readonly status = 422;
}

const CONCLUDED = ['ANALYZED', 'OPPORTUNITY_FOUND', 'NO_OPPORTUNITY'];

/** Which kind of opportunity a finding is, in the words the existing rows use. */
const OPPORTUNITY_TYPE: Record<string, string> = {
  'E-TEL-BROKEN': 'broken_contact_path', 'E-WA-BROKEN': 'broken_contact_path', 'E-EMAIL-INVALID': 'broken_contact_path',
  'E-LINK-TARGET-MISMATCH': 'broken_contact_path', 'E-CTA-DEAD-END': 'dead_end_booking_link', 'E-NO-WEBSITE': 'no_website',
};

export interface AnalyzeDeps {
  probe: Probe;
  now?: () => Date;
}

export interface AnalyzeResult {
  analysisId: string;
  /** False when this call found the business already analysed and returned that result. */
  analysedNow: boolean;
  state: 'OPPORTUNITY_FOUND' | 'NO_OPPORTUNITY';
  opportunityIds: string[];
}

/** The address an analysis asks for: the recorded website, else the domain over HTTPS. */
export function addressToAnalyse(b: { website_url: string | null; domain: string | null }): string | null {
  const url = b.website_url?.trim();
  if (url) return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`;
  const d = b.domain?.trim().toLowerCase();
  return d ? `https://${d}/` : null;
}

export async function analyzeRunBusiness(db: Db, deps: AnalyzeDeps, runId: string, businessId: string, requestedBy: string): Promise<AnalyzeResult> {
  const now = deps.now ?? (() => new Date());
  const by = clean(String(requestedBy ?? ''), 80);
  if (!by) throw new AnalysisRefused('Say who is asking for this analysis.');
  // Lock the business's place in the run (and the run, through its guard) for the whole analysis.
  const rb = (await db.query(
    `SELECT rb.state, r.analysis_budget_credits, r.status AS run_status, s.opportunity_kinds
       FROM scopely.search_run_businesses rb JOIN scopely.search_runs r ON r.id = rb.search_run_id JOIN scopely.searches s ON s.id = r.search_id
      WHERE rb.search_run_id = $1 AND rb.business_id = $2 AND rb.workspace_id = scopely.current_workspace_id()
      FOR UPDATE OF rb`, [runId, businessId])).rows[0];
  if (!rb) throw new AnalysisRefused('That business is not in this search run.');
  if (CONCLUDED.includes(rb.state)) {
    const done = await existingResult(db, runId, businessId);
    if (done) return done;
    throw new AnalysisRefused('This business was already analysed in this run by hand.');
  }
  // ANALYSIS_QUEUED without an analysis: queued by hand (pnpm record); Scopely analyses it now.
  if (rb.state !== 'SELECTED' && rb.state !== 'ANALYSIS_QUEUED') throw new AnalysisRefused('Only a business you selected for analysis can be analysed.');
  if (rb.run_status !== 'OPEN') throw new AnalysisRefused('This search run is closed, so nothing more can be analysed in it.');
  // A budget is counted in credits, and analysis has no credit rate yet (B13): never guess one.
  if (rb.analysis_budget_credits !== null) {
    throw new AnalysisRefused('This search has a credit budget, and Scopely has no credit rate for analysis yet, so nothing is analysed against it.');
  }

  const started = now().toISOString();
  if (rb.state === 'SELECTED') {
    await db.query(`UPDATE scopely.search_run_businesses SET state = 'ANALYSIS_QUEUED', queued_at = $3 WHERE search_run_id = $1 AND business_id = $2`,
      [runId, businessId, started]);
  }
  const biz = (await db.query(`SELECT id, name, domain, website_url, vertical, market_id FROM scopely.businesses WHERE id = $1`, [businessId])).rows[0];
  const address = addressToAnalyse(biz);

  let outcome: 'CHECKED' | 'NO_ADDRESS' | 'REFUSED' = 'CHECKED';
  if (address === null) outcome = 'NO_ADDRESS';
  else { try { assertCapturableUrl(address); } catch { outcome = 'REFUSED'; } }

  const evidence: { id: string; issueCode: string; href: string | null }[] = [];
  const notObservable: string[] = [];
  let analysisId: string;
  if (outcome !== 'CHECKED') {
    analysisId = await insertAnalysis(db, runId, businessId, outcome, address, by, started, now().toISOString());
  } else {
    const page = await deps.probe.get(address!);
    const finished = now().toISOString();
    analysisId = await insertAnalysis(db, runId, businessId, 'CHECKED', address, by, started, finished);
    await meterFetch(db, runId, businessId, analysisId, 'page');
    const presence = presenceObservation(page);
    const html = page.kind === 'response' && page.status >= 200 && page.status < 300 ? page.html : null;
    const snapshotId = (await db.query(
      `INSERT INTO scopely.snapshots (business_id, analysis_id, url, final_url, http_status, fetched_at, fetch_method, html_sha256, redirect_chain)
       VALUES ($1, $2, $3, $4, $5, $6, 'http', $7, $8) RETURNING id`,
      [businessId, analysisId, address, page.kind === 'response' ? page.finalUrl : null, page.kind === 'response' ? page.status : null,
       page.fetchedAt, html === null ? null : createHash('sha256').update(html).digest('hex'), JSON.stringify(page.hops)])).rows[0].id as string;
    const observations: CheckObservation[] = [presence.observation];
    if (html !== null && page.kind === 'response') {
      const facts = readPage(html);
      observations.push(...signalObservations(page.finalUrl, facts), ...contactObservations(page.finalUrl, facts), ...platformObservations(page.finalUrl, facts));
      const cta = await ctaObservations(deps.probe, page.finalUrl, facts);
      for (let i = 0; i < cta.requests; i++) await meterFetch(db, runId, businessId, analysisId, 'booking_destination');
      observations.push(...cta.observations);
    } else if (page.kind === 'response' && page.status >= 200 && page.status < 300) {
      observations.push({ ruleKey: 'check.page_signals', ruleVersion: 1, checkCode: 'page_signals.content', state: 'NOT_OBSERVABLE',
        fact: 'The address answered with something other than a web page, so the page could not be read.' });
    }
    const evidenceUrl = page.kind === 'response' ? page.finalUrl : address!;
    const ids = new Map<string, string>();
    for (const o of observations) {
      const id = await insertObservation(db, snapshotId, o, ids);
      if (!ids.has(o.checkCode)) ids.set(o.checkCode, id);
      if (o.state === 'NOT_OBSERVABLE') notObservable.push(o.fact);
      if (o.evidence && o.state === 'OBSERVED' && (o.result === 'defect' || o.result === 'gap')) {
        const e = o.evidence;
        const ev = (await db.query(
          `INSERT INTO scopely.evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, confidence)
           SELECT $1, $2, $3, rule_version_id, 'OBSERVED', $4, $5, $6, $7 FROM scopely.observations WHERE id = $2 RETURNING id`,
          [businessId, id, e.issueCode, clean(e.plainIssue, 300), evidenceUrl, e.quote.replace(/\u0000/g, ''), e.confidence])).rows[0].id as string;
        evidence.push({ id: ev, issueCode: e.issueCode, href: o.href ?? null });
      }
    }
    // A page that answers but is parked or a placeholder is not a website the business runs: it
    // needs a person's review, never "no website" (the address is known).
    const placeholder = observations.some((o) => o.checkCode === 'page_signals.meaningful_presence' && o.result === 'gap');
    await recordWebsiteStatus(db, businessId, placeholder
      ? { status: 'WEBSITE_NEEDS_REVIEW', basis: 'INFERRED', source: `scopely:${ANALYZER}`, checkedAt: page.fetchedAt }
      : { status: presence.status, basis: presence.basis, source: `scopely:${ANALYZER}`, checkedAt: page.fetchedAt });
  }

  await db.query(`UPDATE scopely.search_run_businesses SET state = 'ANALYZED', analyzed_at = $3 WHERE search_run_id = $1 AND business_id = $2`,
    [runId, businessId, now().toISOString()]);
  const opportunityIds = await openOpportunities(db, runId, biz, evidence, rb.opportunity_kinds ?? [], notObservable);
  const state = opportunityIds.length > 0 ? 'OPPORTUNITY_FOUND' : 'NO_OPPORTUNITY';
  await db.query(`UPDATE scopely.search_run_businesses SET state = $3, concluded_at = $4 WHERE search_run_id = $1 AND business_id = $2`,
    [runId, businessId, state, now().toISOString()]);
  return { analysisId, analysedNow: true, state, opportunityIds };
}

async function existingResult(db: Db, runId: string, businessId: string): Promise<AnalyzeResult | null> {
  const a = (await db.query(`SELECT a.id, rb.state FROM scopely.business_analyses a
      JOIN scopely.search_run_businesses rb ON rb.search_run_id = a.search_run_id AND rb.business_id = a.business_id
     WHERE a.search_run_id = $1 AND a.business_id = $2 AND a.workspace_id = scopely.current_workspace_id()`, [runId, businessId])).rows[0];
  if (!a || !['OPPORTUNITY_FOUND', 'NO_OPPORTUNITY'].includes(a.state)) return null;
  const opps = await db.query(`SELECT id FROM scopely.opportunities WHERE search_run_id = $1 AND business_id = $2 ORDER BY id`, [runId, businessId]);
  return { analysisId: String(a.id), analysedNow: false, state: a.state, opportunityIds: opps.rows.map((r) => String(r.id)) };
}

async function insertAnalysis(db: Db, runId: string, businessId: string, outcome: string, url: string | null, by: string, started: string, finished: string): Promise<string> {
  return (await db.query(
    `INSERT INTO scopely.business_analyses (search_run_id, business_id, analyzer, outcome, requested_url, requested_by, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [runId, businessId, ANALYZER, outcome, url, by, started, finished])).rows[0].id;
}

/** One cost row per request Scopely made. Its price is not known, so amount and credits stay NULL. */
async function meterFetch(db: Db, runId: string, businessId: string, analysisId: string, purpose: string) {
  await db.query(`INSERT INTO scopely.cost_events (business_id, search_run_id, kind, units, meta) VALUES ($1, $2, 'fetch', 1, $3)`,
    [businessId, runId, { purpose: 'analysis', request: purpose, analysisId, analyzer: ANALYZER }]);
}

async function insertObservation(db: Db, snapshotId: string, o: CheckObservation, ids: Map<string, string>): Promise<string> {
  const inferred = o.state === 'INFERRED' ? (o.inferredFrom ?? []).map((c) => ids.get(c)).filter((x): x is string => Boolean(x)) : null;
  // An inference needs what it was drawn from; without it the observation is not made at all.
  const state = o.state === 'INFERRED' && (!inferred || inferred.length === 0) ? 'NOT_OBSERVABLE' : o.state;
  return (await db.query(
    `INSERT INTO scopely.observations (snapshot_id, check_code, rule_version_id, state, result, href, visible_text, extracted, inferred_from, observed_at)
     SELECT $1, $2, rv.id, $4, $5, $6, $7, $8, $9, s.fetched_at
       FROM scopely.rule_versions rv, scopely.snapshots s WHERE rv.rule_key = $3 AND rv.version = $10 AND s.id = $1
     RETURNING id`,
    [snapshotId, o.checkCode, o.ruleKey, state, state === 'NOT_OBSERVABLE' ? null : o.result, o.href ?? null, o.visibleText ?? null,
     { ...(o.extracted ?? {}), fact: clean(o.fact, 400), analyzer: ANALYZER }, state === 'INFERRED' ? inferred : null, o.ruleVersion])).rows[0].id;
}

// ------------------------------------------------------------------ OPPORTUNITY (mapping.catalog_v1)

interface MappedItem { id: string; key: string; build_kind: string | null; own: boolean }

/**
 * The catalog item a finding maps to: an active item the workspace can use (its own, or a shared
 * starter it has not overridden) that lists the issue code, for the business's vertical or any, and
 * builds a kind the search asked for (when it named any). The most specific wins: the workspace's
 * own item, then one made for the business's vertical, then the one covering the fewest codes, then
 * the key. None means the finding stays evidence without an opportunity.
 */
async function mapFinding(db: Db, issueCode: string, vertical: string | null, kinds: string[]): Promise<MappedItem | null> {
  const r = await db.query(
    `SELECT c.id, c.key, c.build_kind, c.workspace_id IS NOT NULL AS own
       FROM scopely.catalog_items c
      WHERE c.active AND $1 = ANY (c.supported_issue_codes)
        AND (c.workspace_id = scopely.current_workspace_id()
             OR (c.workspace_id IS NULL AND NOT EXISTS (SELECT 1 FROM scopely.catalog_items o
                   WHERE o.key = c.key AND o.workspace_id = scopely.current_workspace_id())))
        AND (cardinality(c.supported_verticals) = 0 OR $2::text = ANY (c.supported_verticals))
        AND (cardinality($3::text[]) = 0 OR c.build_kind = ANY ($3::text[]))
      ORDER BY (c.workspace_id IS NOT NULL) DESC, (cardinality(c.supported_verticals) > 0) DESC,
               cardinality(c.supported_issue_codes), c.key
      LIMIT 1`, [issueCode, vertical, kinds]);
  const x = r.rows[0];
  return x ? { id: String(x.id), key: x.key, build_kind: x.build_kind, own: x.own } : null;
}

/**
 * Opens one opportunity per mapped service for this run's findings. A finding the workspace already
 * holds in an open opportunity of the same service (same business, issue code and link, not lost,
 * dismissed or re-checked as changed or gone) is not opened again.
 */
async function openOpportunities(db: Db, runId: string, biz: { id: string; vertical: string | null; market_id: string | null },
  evidence: { id: string; issueCode: string; href: string | null }[], kinds: string[], notObservable: string[]): Promise<string[]> {
  if (evidence.length === 0) return [];
  const codes = (await db.query(`SELECT code FROM scopely.issue_codes WHERE kind = 'issue' AND lead_eligible AND code = ANY ($1)`,
    [[...new Set(evidence.map((e) => e.issueCode))]])).rows.map((r) => r.code as string);
  const mapping = (await db.query(`SELECT id FROM scopely.rule_versions WHERE rule_key = 'mapping.catalog_v1' AND version = 1`)).rows[0].id;
  const groups = new Map<string, { item: MappedItem; evidence: typeof evidence }>();
  for (const e of evidence) {
    if (!codes.includes(e.issueCode)) continue;
    const item = await mapFinding(db, e.issueCode, biz.vertical, kinds);
    if (!item) continue;
    const held = (await db.query(
      `SELECT 1 FROM scopely.opportunities op
         JOIN scopely.opportunity_evidence oe ON oe.opportunity_id = op.id
         JOIN scopely.evidence ev ON ev.id = oe.evidence_id
         JOIN scopely.observations ob ON ob.id = ev.observation_id
        WHERE op.workspace_id = scopely.current_workspace_id() AND op.business_id = $1 AND op.catalog_item_id = $2
          AND op.status NOT IN ('LOST','DISMISSED') AND ev.issue_code = $3 AND ob.href IS NOT DISTINCT FROM $4
          AND NOT EXISTS (SELECT 1 FROM scopely.evidence_rechecks r WHERE r.evidence_id = ev.id AND r.result IN ('changed','gone'))
        LIMIT 1`, [biz.id, item.id, e.issueCode, e.href])).rows.length > 0;
    if (held) continue;
    const g = groups.get(item.id) ?? { item, evidence: [] };
    g.evidence.push(e);
    groups.set(item.id, g);
  }
  const notes = notObservable.length ? clean(`Not observable in this analysis: ${notObservable.join(' ')}`, 1500) : null;
  const out: string[] = [];
  for (const g of groups.values()) {
    const lead = g.evidence[0]!;
    const opp = (await db.query(
      `INSERT INTO scopely.opportunities (business_id, market_id, opportunity_type, mapping_status, catalog_item_id, mapping_rule_version_id,
         not_observable_notes, search_run_id)
       VALUES ($1, $2, $3, 'MAPPED', $4, $5, $6, $7) RETURNING id`,
      [biz.id, biz.market_id, OPPORTUNITY_TYPE[lead.issueCode] ?? 'website_finding', g.item.id, mapping, notes, runId])).rows[0].id as string;
    for (const e of g.evidence) await db.query('INSERT INTO scopely.opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2)', [opp, e.id]);
    out.push(opp);
  }
  return out;
}
