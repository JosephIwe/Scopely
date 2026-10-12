// VERIFY from the Case File (release 1, A45–A46): after a recorded delivery, Scopely re-runs the
// check behind one baseline finding on a fresh request of that finding's own page and records what it
// saw as a `verifications` row.
//
//   one SSRF-safe GET of evidence.url (the probe of A34; reserved .example hosts are answered from
//   fixtures/demo-pages) → a new snapshot (fetch_method 'http', the request's own time) → the same
//   check code and rule version as the baseline, run on the served HTML → an observation → PASSED
//   (OBSERVED ok: the defect is no longer observed), FAILED (OBSERVED defect: still there) or
//   NOT_OBSERVABLE (the page could not be read, or the link is no longer there to judge).
//
// verification_guard (002/004) stays the judge of the chain: a later snapshot of the same business,
// the baseline's own check and rule version, PASSED only on an OBSERVED ok. A failed fetch, a blocked
// address or a link that is gone is never a pass. Nothing here is triggered by a build: a finished
// build, a shown demo or a delivery record never declares success; only a re-observation does.
//
// Only the automated static-HTML rules can be re-run (check.contact_links v2 and
// check.booking_cta_trace v2, A34). A finding recorded under a person's check (a v1 rule) cannot be
// re-run by Scopely under the same rule version, so it is refused, not approximated.
//
// The booking check traces the link it judges once more, as its rule says (one request without a
// body). Every request is metered as a `cost_events` fetch row with no amount (cost not reported).
// No page HTML is stored or logged: the snapshot keeps its hash.
import { createHash } from 'node:crypto';
import type { Db } from '../tenancy/index.js';
import { ANALYZER, type CheckObservation, contactKind, contactObservations, ctaObservations, presenceObservation } from '../analysis/checks.js';
import type { Probe, ProbeResult } from '../analysis/fetch.js';
import { clean, readPage } from '../analysis/html.js';

export class VerifyRefused extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422, message: string) { super(message); }
}

/** The rules Scopely can re-run itself, by key and version. */
export const VERIFIABLE_RULES: Record<string, number[]> = { 'check.contact_links': [2], 'check.booking_cta_trace': [2] };

const UNKNOWN: Record<string, string> = {
  'check.contact_links': 'Whether a call, message or email to the destination is answered is not checked, and a link added by script is not seen.',
  'check.booking_cta_trace': 'Whether a booking can be completed there is not checked: nothing is submitted, and a link handled by script is not seen.',
};

export type VerificationStatus = 'PASSED' | 'FAILED' | 'NOT_OBSERVABLE';

export interface VerifyDeps {
  probe: Probe;
}

export interface VerifyResult {
  verificationId: string;
  status: VerificationStatus;
  /** What Scopely saw, in one sentence. */
  fact: string;
  /** What changed against the baseline finding. */
  changed: string;
  /** What this check cannot tell. */
  unknown: string;
  requests: number;
}

/** Why Scopely cannot re-run this finding's check itself, or null when it can. */
export function verifyBlocker(e: { claimState: string; ruleKey: string; ruleVersion: number }): string | null {
  if (e.claimState !== 'OBSERVED') return 'This finding was inferred, not seen on the page, so a page check cannot verify it.';
  if (!(VERIFIABLE_RULES[e.ruleKey] ?? []).includes(e.ruleVersion)) {
    return `This finding was recorded under ${e.ruleKey} v${e.ruleVersion}, a check made by a person. Scopely re-runs only its automated checks, so it cannot verify this one under the same rule.`;
  }
  return null;
}

interface Baseline { checkCode: string; ruleKey: string; href: string | null; visibleText: string | null; result: string }

interface Rerun {
  state: 'OBSERVED' | 'NOT_OBSERVABLE';
  result?: 'ok' | 'defect';
  href?: string;
  visibleText?: string;
  fact: string;
  requests: number;
}

const label = (t: string | null) => (t ? `"${clean(t, 60)}"` : 'unlabelled');

/** The baseline's check, re-run on what the probe returned. Never a pass without an OBSERVED ok. */
export async function rerunCheck(probe: Probe, base: Baseline, page: ProbeResult): Promise<Rerun> {
  if (page.kind === 'error') return { state: 'NOT_OBSERVABLE', fact: presenceObservation(page).observation.fact, requests: 0 };
  if (page.status < 200 || page.status >= 300) {
    return { state: 'NOT_OBSERVABLE', fact: `${page.finalUrl} answered ${page.status}, so the page could not be read.`, requests: 0 };
  }
  if (page.html === null) return { state: 'NOT_OBSERVABLE', fact: `${page.finalUrl} answered with something other than a web page, so it could not be read.`, requests: 0 };
  const facts = readPage(page.html);
  const gone = { state: 'NOT_OBSERVABLE' as const, requests: 0,
    fact: `The link ${label(base.visibleText)} is no longer in the served HTML, so the same check has nothing to judge. Whether it was fixed elsewhere or removed cannot be told from this page, and a link added by script is not seen.` };

  let found: CheckObservation[];
  let requests = 0;
  if (base.checkCode === 'booking_cta_trace.target') {
    const links = facts.links.filter((l) => base.visibleText !== null && l.label === base.visibleText);
    if (links.length === 0) return gone;
    const cta = await ctaObservations(probe, page.finalUrl, { ...facts, links });
    requests = cta.requests;
    found = cta.observations;
  } else if (base.checkCode === 'contact_links.target') {
    const links = facts.links.filter((l) => base.visibleText !== null && l.label === base.visibleText);
    if (links.length === 0) return gone;
    found = contactObservations(page.finalUrl, { ...facts, links }).filter((o) => o.checkCode === 'contact_links.target');
    if (found.length === 0) {
      // No mismatch on a link with the same label: the rule's defect is not observed. It is a pass only
      // when the link now opens what its label says.
      const l = links[0]!;
      if (contactKind(l.href) === 'whatsapp') {
        return { state: 'OBSERVED', result: 'ok', href: clean(l.href, 500), visibleText: l.label || undefined, requests: 0,
          fact: `The link labelled ${label(l.label)} now opens WhatsApp (${clean(l.href, 200)}).` };
      }
      return { state: 'NOT_OBSERVABLE', requests: 0,
        fact: `The link labelled ${label(l.label)} now opens ${clean(l.href, 200)}, which this check does not judge.` };
    }
  } else {
    const all = contactObservations(page.finalUrl, facts).filter((o) => o.checkCode === base.checkCode);
    const same = all.filter((o) => base.href !== null && o.href === clean(base.href, 500) && (base.visibleText === null || o.visibleText === base.visibleText));
    found = same.length ? same : all.filter((o) => base.visibleText !== null && o.visibleText === base.visibleText);
  }
  if (found.length === 0) return { ...gone, requests };
  const pick = found.find((o) => o.state === 'OBSERVED' && (o.result === 'defect' || o.result === 'gap'))
    ?? found.find((o) => o.state === 'NOT_OBSERVABLE') ?? found[0]!;
  if (pick.state === 'NOT_OBSERVABLE') return { state: 'NOT_OBSERVABLE', href: pick.href, visibleText: pick.visibleText, fact: pick.fact, requests };
  return { state: 'OBSERVED', result: pick.result === 'ok' ? 'ok' : 'defect', href: pick.href, visibleText: pick.visibleText, fact: pick.fact, requests };
}

function changedWords(base: Baseline, r: Rerun, status: VerificationStatus): string {
  if (status === 'NOT_OBSERVABLE') return 'Nothing could be compared with the original finding.';
  if (status === 'FAILED') {
    return r.href && base.href && r.href === clean(base.href, 500)
      ? 'Nothing: the same link is still on the page, as it was.'
      : `The link changed${r.href ? ` to ${clean(r.href, 200)}` : ''}, but the same check still finds the problem.`;
  }
  return base.href && r.href && r.href !== clean(base.href, 500)
    ? `The link ${label(base.visibleText)} went from ${clean(base.href, 200)} to ${clean(r.href, 200)}, and the same check no longer finds the problem.`
    : 'The same check no longer finds the problem on this link.';
}

/** Re-runs one cited finding's check on its own page after a delivery, and records the verification. */
export async function verifyEvidence(db: Db, deps: VerifyDeps, opportunityId: string, evidenceId: string, input: { requestedBy: string }): Promise<VerifyResult> {
  if (!/^\d{1,18}$/.test(opportunityId) || !/^\d{1,18}$/.test(evidenceId)) throw new VerifyRefused(404, 'That finding is not part of this opportunity.');
  const opp = (await db.query(`SELECT id, business_id, delivered_at FROM scopely.opportunities WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`,
    [opportunityId])).rows[0];
  if (!opp) throw new VerifyRefused(404, 'That opportunity does not exist.');
  const ev = (await db.query(
    `SELECT e.id, e.url, e.claim_state, e.rule_version_id, e.observed_at, o.check_code, o.href, o.visible_text, o.result, rv.rule_key, rv.version
       FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
       JOIN scopely.observations o ON o.id = e.observation_id JOIN scopely.rule_versions rv ON rv.id = e.rule_version_id
      WHERE oe.opportunity_id = $1 AND oe.evidence_id = $2
        AND oe.workspace_id = scopely.current_workspace_id() AND e.workspace_id = scopely.current_workspace_id()`, [opp.id, evidenceId])).rows[0];
  if (!ev) throw new VerifyRefused(404, 'That finding is not part of this opportunity.');
  const requestedBy = typeof input.requestedBy === 'string' ? input.requestedBy.trim().slice(0, 120) : '';
  if (!requestedBy) throw new VerifyRefused(400, 'Say who is asking for this verification.');
  if (opp.delivered_at === null) throw new VerifyRefused(409, 'Record the delivery first. Scopely verifies delivered work only.');
  const blocker = verifyBlocker({ claimState: ev.claim_state, ruleKey: ev.rule_key, ruleVersion: ev.version });
  if (blocker) throw new VerifyRefused(422, blocker);

  const base: Baseline = { checkCode: ev.check_code, ruleKey: ev.rule_key, href: ev.href, visibleText: ev.visible_text, result: ev.result };
  // The evidence's own page, never an address the request names.
  const page = await deps.probe.get(ev.url);
  // A verification re-observes delivered work, so it must be read after the delivery was recorded.
  if (Date.parse(page.fetchedAt) <= new Date(opp.delivered_at).getTime()) {
    throw new VerifyRefused(409, 'The page was read at a time before the recorded delivery, so it cannot verify it. Check the delivery date and the clock, then try again.');
  }
  const rerun = await rerunCheck(deps.probe, base, page);
  const status: VerificationStatus = rerun.state === 'NOT_OBSERVABLE' ? 'NOT_OBSERVABLE' : rerun.result === 'ok' ? 'PASSED' : 'FAILED';
  const changed = changedWords(base, rerun, status);
  const unknown = UNKNOWN[ev.rule_key] ?? 'What this check does not read is not known.';
  const html = page.kind === 'response' && page.status >= 200 && page.status < 300 ? page.html : null;

  await db.query('SAVEPOINT verify');
  try {
    const snap = (await db.query(
      `INSERT INTO scopely.snapshots (business_id, url, final_url, http_status, fetched_at, fetch_method, html_sha256, redirect_chain)
       VALUES ($1, $2, $3, $4, $5, 'http', $6, $7) RETURNING id, fetched_at`,
      [opp.business_id, ev.url, page.kind === 'response' ? page.finalUrl : null, page.kind === 'response' ? page.status : null, page.fetchedAt,
       html === null ? null : createHash('sha256').update(html).digest('hex'), JSON.stringify(page.hops)])).rows[0];
    const obs = (await db.query(
      `INSERT INTO scopely.observations (snapshot_id, check_code, rule_version_id, state, result, href, visible_text, extracted, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [snap.id, ev.check_code, ev.rule_version_id, rerun.state, rerun.state === 'NOT_OBSERVABLE' ? null : rerun.result, rerun.href ?? null,
       rerun.visibleText ?? null, { fact: clean(rerun.fact, 400), changed: clean(changed, 400), unknown, verification: true, analyzer: ANALYZER,
         ...(page.kind === 'response' ? { status: page.status, finalUrl: page.finalUrl } : { error: page.error }) }, snap.fetched_at])).rows[0];
    for (let i = 0; i < 1 + rerun.requests; i++) {
      await db.query(`INSERT INTO scopely.cost_events (business_id, opportunity_id, kind, units, meta) VALUES ($1, $2, 'fetch', 1, $3)`,
        [opp.business_id, opp.id, { purpose: 'verification', request: i === 0 ? 'page' : 'booking_destination', evidenceId: String(ev.id), analyzer: ANALYZER }]);
    }
    const v = (await db.query(
      `INSERT INTO scopely.verifications (opportunity_id, baseline_evidence_id, snapshot_id, observation_id, rule_version_id, status, verified_at, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [opp.id, ev.id, snap.id, obs.id, ev.rule_version_id, status, snap.fetched_at, requestedBy])).rows[0];
    await db.query('RELEASE SAVEPOINT verify');
    return { verificationId: String(v.id), status, fact: rerun.fact, changed, unknown, requests: 1 + rerun.requests };
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT verify');
    const e = err as { code?: string; message?: string };
    if (e.code === '23514' && /must be later than the baseline/.test(String(e.message))) {
      throw new VerifyRefused(409, 'The page was read at a time before the finding was recorded. Check the clock and try again.');
    }
    if (e.code === '23514') throw new VerifyRefused(409, 'That verification could not be recorded. Nothing was changed.');
    throw err;
  }
}
