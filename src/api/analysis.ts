// Read model for one business's analysis in a search run (Slice 11): what Scopely requested, what
// it observed and could not observe, the findings that became evidence, and the opportunities they
// opened. Every value is read back from the rows the analysis wrote; nothing is recomputed here.
import type { Db } from '../tenancy/index.js';

const WS = 'workspace_id = scopely.current_workspace_id()';

export interface AnalysisObservationView {
  checkCode: string;
  rule: string;
  state: 'OBSERVED' | 'INFERRED' | 'NOT_OBSERVABLE';
  result: 'ok' | 'gap' | 'defect' | 'n/a' | null;
  fact: string;
  href: string | null;
  visibleText: string | null;
}

export interface AnalysisFindingView {
  evidenceId: string;
  issueCode: string;
  title: string;
  plainIssue: string;
  claimState: 'OBSERVED' | 'INFERRED';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  url: string;
  quote: string;
  observedAt: string;
  rule: string;
  /** The opportunity this finding opened in this run, or the open one that already held it, or null. */
  opportunityId: string | null;
  /** Why the finding is not an opportunity of this run: already held, or no service covers it. */
  note: 'opened' | 'already_held' | 'no_service' | 'not_a_lead';
}

export interface AnalysisView {
  analysisId: string;
  searchRunId: string;
  businessId: string;
  businessName: string;
  state: string;
  analyzer: string;
  outcome: 'CHECKED' | 'NO_ADDRESS' | 'REFUSED';
  requestedUrl: string | null;
  requestedBy: string;
  startedAt: string;
  finishedAt: string;
  website: { status: string; basis: string | null; source: string | null; checkedAt: string | null };
  page: { finalUrl: string | null; httpStatus: number | null; fetchedAt: string; redirects: { url: string; status: number }[]; htmlSha256: string | null } | null;
  requests: number;
  /** Fetch cost as recorded: Scopely has no price for its own requests, so it is never a number. */
  cost: { basis: 'NOT_REPORTED' };
  observations: AnalysisObservationView[];
  findings: AnalysisFindingView[];
  opportunities: { opportunityId: string; service: string | null; path: string | null; kind: string | null; opportunityType: string; evidenceIds: string[] }[];
}

const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export async function getRunBusinessAnalysis(db: Db, runId: string, businessId: string): Promise<AnalysisView | null> {
  const a = (await db.query(
    `SELECT a.*, b.name, b.website_status, b.website_status_basis, b.website_status_source, b.website_status_checked_at, rb.state
       FROM scopely.business_analyses a
       JOIN scopely.businesses b ON b.id = a.business_id
       JOIN scopely.search_run_businesses rb ON rb.search_run_id = a.search_run_id AND rb.business_id = a.business_id
      WHERE a.search_run_id = $1 AND a.business_id = $2 AND a.${WS}`, [runId, businessId])).rows[0];
  if (!a) return null;
  const snap = (await db.query(`SELECT * FROM scopely.snapshots WHERE analysis_id = $1 AND ${WS} ORDER BY id LIMIT 1`, [a.id])).rows[0];
  const obs = snap ? (await db.query(
    `SELECT o.check_code, o.state, o.result, o.href, o.visible_text, o.extracted, rv.rule_key, rv.version
       FROM scopely.observations o JOIN scopely.rule_versions rv ON rv.id = o.rule_version_id
      WHERE o.snapshot_id = $1 AND o.${WS} ORDER BY o.id`, [snap.id])).rows : [];
  const ev = snap ? (await db.query(
    `SELECT e.*, ic.title, ic.lead_eligible, ob.href, rv.rule_key, rv.version,
            (SELECT oe.opportunity_id FROM scopely.opportunity_evidence oe JOIN scopely.opportunities op ON op.id = oe.opportunity_id
              WHERE oe.evidence_id = e.id AND op.search_run_id = $2 LIMIT 1) AS opened_in
       FROM scopely.evidence e
       JOIN scopely.observations ob ON ob.id = e.observation_id
       JOIN scopely.issue_codes ic ON ic.code = e.issue_code
       JOIN scopely.rule_versions rv ON rv.id = e.rule_version_id
      WHERE ob.snapshot_id = $1 AND e.${WS}
      ORDER BY CASE e.confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, e.id`, [snap.id, runId])).rows : [];
  const findings: AnalysisFindingView[] = [];
  for (const e of ev) {
    let opportunityId = e.opened_in === null ? null : String(e.opened_in);
    let note: AnalysisFindingView['note'] = opportunityId ? 'opened' : e.lead_eligible ? 'no_service' : 'not_a_lead';
    if (!opportunityId && e.lead_eligible) {
      // The same finding (business, issue code, link) already held by an open opportunity of this workspace.
      const held = (await db.query(
        `SELECT op.id FROM scopely.opportunities op
           JOIN scopely.opportunity_evidence oe ON oe.opportunity_id = op.id
           JOIN scopely.evidence x ON x.id = oe.evidence_id
           JOIN scopely.observations xo ON xo.id = x.observation_id
          WHERE op.${WS} AND op.business_id = $1 AND x.issue_code = $2 AND xo.href IS NOT DISTINCT FROM $3 AND x.id <> $4
            AND op.status NOT IN ('LOST','DISMISSED')
            AND NOT EXISTS (SELECT 1 FROM scopely.evidence_rechecks r WHERE r.evidence_id = x.id AND r.result IN ('changed','gone'))
          ORDER BY op.id LIMIT 1`, [businessId, e.issue_code, e.href, e.id])).rows[0];
      if (held) { opportunityId = String(held.id); note = 'already_held'; }
    }
    findings.push({
      evidenceId: String(e.id), issueCode: e.issue_code, title: e.title, plainIssue: e.plain_issue, claimState: e.claim_state, confidence: e.confidence,
      url: e.url, quote: e.quote, observedAt: iso(e.observed_at)!, rule: `${e.rule_key}@${e.version}`, opportunityId, note,
    });
  }
  const opps = (await db.query(
    `SELECT f.opportunity_id, f.service, f.opportunity_path, f.opportunity_kind, f.opportunity_type,
            (SELECT array_agg(oe.evidence_id ORDER BY oe.evidence_id) FROM scopely.opportunity_evidence oe WHERE oe.opportunity_id = f.opportunity_id) AS evidence_ids
       FROM scopely.v_opportunity_feed f JOIN scopely.opportunities op ON op.id = f.opportunity_id
      WHERE op.search_run_id = $1 AND op.business_id = $2 AND f.${WS} ORDER BY f.opportunity_id`, [runId, businessId])).rows;
  const requests = Number((await db.query(
    `SELECT count(*) AS n FROM scopely.cost_events WHERE ${WS} AND search_run_id = $1 AND business_id = $2 AND kind = 'fetch' AND meta ->> 'analysisId' = $3`,
    [runId, businessId, String(a.id)])).rows[0].n);
  return {
    analysisId: String(a.id), searchRunId: String(a.search_run_id), businessId: String(a.business_id), businessName: a.name, state: a.state,
    analyzer: a.analyzer, outcome: a.outcome, requestedUrl: a.requested_url, requestedBy: a.requested_by,
    startedAt: iso(a.started_at)!, finishedAt: iso(a.finished_at)!,
    website: { status: a.website_status, basis: a.website_status_basis, source: a.website_status_source, checkedAt: iso(a.website_status_checked_at) },
    page: snap ? { finalUrl: snap.final_url, httpStatus: snap.http_status, fetchedAt: iso(snap.fetched_at)!, redirects: snap.redirect_chain ?? [], htmlSha256: snap.html_sha256 } : null,
    requests,
    cost: { basis: 'NOT_REPORTED' },
    observations: obs.map((o) => ({
      checkCode: o.check_code, rule: `${o.rule_key}@${o.version}`, state: o.state, result: o.result, fact: String(o.extracted?.fact ?? o.check_code),
      href: o.href, visibleText: o.visible_text,
    })),
    findings,
    opportunities: opps.map((o) => ({
      opportunityId: String(o.opportunity_id), service: o.service, path: o.opportunity_path, kind: o.opportunity_kind, opportunityType: o.opportunity_type,
      evidenceIds: (o.evidence_ids ?? []).map(String),
    })),
  };
}

/** One line per analysed business of a run, for the run's list. */
export async function runAnalysisSummaries(db: Db, runId: string): Promise<Map<string, { analysisId: string; outcome: string; findings: number; opportunityIds: string[] }>> {
  const rows = (await db.query(
    `SELECT a.id, a.business_id, a.outcome,
            (SELECT count(*) FROM scopely.evidence e JOIN scopely.observations o ON o.id = e.observation_id JOIN scopely.snapshots s ON s.id = o.snapshot_id
              WHERE s.analysis_id = a.id) AS findings,
            (SELECT array_agg(op.id ORDER BY op.id) FROM scopely.opportunities op WHERE op.search_run_id = a.search_run_id AND op.business_id = a.business_id) AS opps
       FROM scopely.business_analyses a WHERE a.search_run_id = $1 AND a.${WS}`, [runId])).rows;
  return new Map(rows.map((r) => [String(r.business_id), {
    analysisId: String(r.id), outcome: r.outcome, findings: Number(r.findings), opportunityIds: (r.opps ?? []).map(String),
  }]));
}
