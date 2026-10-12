// The Case File's 10 Deliver · verify (release 1, A44–A46): the truthful state ladder, the recorded
// deliveries, the delivery builds, and every verification of each baseline finding, read from stored
// rows only.
//
//   proposed (a mapped opportunity) → pitched → won → delivered → verified, or lost.
//
// There is no "in progress" state: the model has none, so none is shown. A demo build, a draft or an
// offer is never sold or delivered here: won comes only from a won outcome, delivered only from a
// delivered outcome, and verified only from verifications whose latest result for every baseline
// finding is PASSED. A correction (a voided win or loss) is shown as what it is.
//
// Scoped like the rest of src/api: an explicit current_workspace_id() predicate on every query.
import type { Db } from '../tenancy/index.js';
import { verifyBlocker } from '../verify/index.js';

const WS = 'workspace_id = scopely.current_workspace_id()';
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export type LadderKey = 'proposed' | 'pitched' | 'won' | 'delivered' | 'verified';
export interface LadderStep {
  key: LadderKey;
  label: string;
  /** done; current (the next step to happen); todo; failed (a verification found the problem still there); lost. */
  state: 'done' | 'current' | 'todo' | 'failed' | 'lost';
  at: string | null;
  detail: string | null;
}

export interface VerificationView {
  verificationId: string;
  evidenceId: string;
  status: 'PASSED' | 'FAILED' | 'NOT_OBSERVABLE' | 'CLIENT_REQUIRED_UNCONFIRMED';
  verifiedAt: string;
  requestedBy: string | null;
  /** What was requested, how and what it answered. */
  source: { url: string; finalUrl: string | null; httpStatus: number | null; fetchedAt: string; method: string };
  observation: { checkCode: string; state: string; result: string | null; href: string | null; visibleText: string | null } | null;
  fact: string | null;
  changed: string | null;
  unknown: string | null;
}

export interface DeliverView {
  ladder: LadderStep[];
  implementationType: 'FULL' | 'ASSISTED' | 'CLIENT_REQUIRED' | null;
  deliveries: { outcomeId: string; occurredAt: string; deliveredBy: 'operator' | 'client'; clientConfirmed: boolean | null; notes: string | null;
                recordedBy: string; recordedAt: string }[];
  /** DELIVERY builds of the opportunity: the delivered work, if it was built in Scopely. A DEMO is never listed here. */
  deliveryBuilds: { buildId: string; versionNo: number | null; status: string; title: string; summary: string; approvedBy: string | null; approvedAt: string | null }[];
  corrections: { outcomeId: string; corrects: string; correctedKind: string; occurredAt: string; notes: string | null; recordedBy: string }[];
  can: { deliver: boolean; verify: boolean };
  /** Why the seller cannot record a delivery or verify now, or null. Advisory: the database decides. */
  blockers: { deliver: string | null; verify: string | null };
  evidence: {
    evidenceId: string; plainIssue: string; url: string; quote: string; observedAt: string; claimState: 'OBSERVED' | 'INFERRED';
    rule: { key: string; version: number }; checkCode: string; baseline: { href: string | null; visibleText: string | null; result: string | null };
    verifiable: boolean; verifyBlocker: string | null; latest: VerificationView | null;
  }[];
  /** Every verification of the opportunity, newest first. Append-only. */
  verifications: VerificationView[];
}

/** The Deliver · verify view of one opportunity, or null when it is not in this workspace. */
export async function getDeliverView(db: Db, opportunityId: string): Promise<DeliverView | null> {
  const o = (await db.query(
    `SELECT o.id, o.mapping_status, o.created_at, o.pitched_at, o.won_at, o.lost_at, o.delivered_at, c.implementation_type, c.service
       FROM scopely.opportunities o LEFT JOIN scopely.catalog_items c ON c.id = o.catalog_item_id
      WHERE o.id = $1 AND o.${WS}`, [opportunityId])).rows[0];
  if (!o) return null;
  const outcomes = (await db.query(
    `SELECT t.*, c.kind AS corrected_kind FROM scopely.outcomes t LEFT JOIN scopely.outcomes c ON c.id = t.corrects_outcome_id
      WHERE t.opportunity_id = $1 AND t.${WS} AND t.kind IN ('delivered','voided') ORDER BY t.occurred_at, t.id`, [o.id])).rows;
  const builds = (await db.query(
    `SELECT b.id, b.version_no, b.status, b.title, b.summary, b.approved_by, b.approved_at FROM scopely.builds b
      WHERE b.opportunity_id = $1 AND b.${WS} AND b.purpose = 'DELIVERY' AND b.status NOT IN ('DISCARDED','SUPERSEDED')
      ORDER BY b.created_at DESC, b.id DESC`, [o.id])).rows;
  const evidence = (await db.query(
    `SELECT e.id, e.plain_issue, e.url, e.quote, e.observed_at, e.claim_state, ob.check_code, ob.href, ob.visible_text, ob.result, rv.rule_key, rv.version
       FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
       JOIN scopely.observations ob ON ob.id = e.observation_id JOIN scopely.rule_versions rv ON rv.id = e.rule_version_id
      WHERE oe.opportunity_id = $1 AND oe.${WS} AND e.${WS}
      ORDER BY CASE e.confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, e.id`, [o.id])).rows;
  const verifications: VerificationView[] = (await db.query(
    `SELECT v.id, v.baseline_evidence_id, v.status, v.verified_at, v.requested_by, s.url, s.final_url, s.http_status, s.fetched_at, s.fetch_method,
            ob.check_code, ob.state, ob.result, ob.href, ob.visible_text, ob.extracted
       FROM scopely.verifications v JOIN scopely.snapshots s ON s.id = v.snapshot_id
       LEFT JOIN scopely.observations ob ON ob.id = v.observation_id
      WHERE v.opportunity_id = $1 AND v.${WS} ORDER BY v.verified_at DESC, v.id DESC`, [o.id])).rows.map((v) => ({
    verificationId: String(v.id), evidenceId: String(v.baseline_evidence_id), status: v.status, verifiedAt: iso(v.verified_at)!, requestedBy: v.requested_by,
    source: { url: v.url, finalUrl: v.final_url, httpStatus: v.http_status, fetchedAt: iso(v.fetched_at)!, method: v.fetch_method },
    observation: v.check_code ? { checkCode: v.check_code, state: v.state, result: v.result, href: v.href, visibleText: v.visible_text } : null,
    fact: v.extracted?.fact ?? null, changed: v.extracted?.changed ?? null, unknown: v.extracted?.unknown ?? null,
  }));

  const items = evidence.map((e) => {
    const blocker = verifyBlocker({ claimState: e.claim_state, ruleKey: e.rule_key, ruleVersion: e.version });
    return {
      evidenceId: String(e.id), plainIssue: e.plain_issue, url: e.url, quote: e.quote, observedAt: iso(e.observed_at)!, claimState: e.claim_state,
      rule: { key: e.rule_key, version: e.version }, checkCode: e.check_code, baseline: { href: e.href, visibleText: e.visible_text, result: e.result },
      verifiable: blocker === null, verifyBlocker: blocker, latest: verifications.find((v) => v.evidenceId === String(e.id)) ?? null,
    };
  });

  const deliveries = outcomes.filter((t) => t.kind === 'delivered').map((t) => ({
    outcomeId: String(t.id), occurredAt: iso(t.occurred_at)!, deliveredBy: t.delivered_by, clientConfirmed: t.client_confirmed, notes: t.notes,
    recordedBy: t.recorded_by, recordedAt: iso(t.created_at)!,
  }));
  const corrections = outcomes.filter((t) => t.kind === 'voided').map((t) => ({
    outcomeId: String(t.id), corrects: String(t.corrects_outcome_id), correctedKind: t.corrected_kind, occurredAt: iso(t.occurred_at)!, notes: t.notes,
    recordedBy: t.recorded_by,
  }));

  // Verified only when the latest verification of every baseline finding passed.
  const latest = items.map((e) => e.latest?.status ?? null);
  const passed = latest.filter((s) => s === 'PASSED').length;
  const failed = latest.some((s) => s === 'FAILED');
  const verifiedAll = items.length > 0 && passed === items.length;
  const lastVerified = verifications[0]?.verifiedAt ?? null;
  const ladder: LadderStep[] = [
    { key: 'proposed', label: 'Proposed', state: o.mapping_status === 'MAPPED' ? 'done' : 'current', at: iso(o.created_at),
      detail: o.mapping_status === 'MAPPED' ? (o.service ? `Mapped to ${o.service}` : 'Mapped to a service') : 'No service is mapped yet' },
    { key: 'pitched', label: 'Pitched', state: o.pitched_at ? 'done' : 'todo', at: iso(o.pitched_at), detail: null },
    { key: 'won', label: o.lost_at ? 'Lost' : 'Won', state: o.won_at ? 'done' : o.lost_at ? 'lost' : 'todo', at: iso(o.won_at ?? o.lost_at),
      detail: o.won_at ? 'Sold: a won outcome is recorded' : o.lost_at ? 'A lost outcome is recorded' : null },
    { key: 'delivered', label: 'Delivered', state: o.delivered_at ? 'done' : 'todo', at: iso(o.delivered_at),
      detail: o.delivered_at ? `${deliveries.length === 1 ? 'One delivery' : `${deliveries.length} deliveries`} recorded` : null },
    { key: 'verified', label: 'Verified', state: verifiedAll ? 'done' : failed ? 'failed' : 'todo', at: verifiedAll ? lastVerified : null,
      detail: items.length === 0 ? 'No baseline finding to verify'
        : verifications.length === 0 ? null
          : `${passed} of ${items.length} finding${items.length === 1 ? '' : 's'} passed${failed ? '; at least one still shows the problem' : ''}` },
  ];
  const next = ladder.find((s) => s.state === 'todo');
  if (next && !o.lost_at && ladder.every((s) => s.state !== 'current')) next.state = 'current';

  const canDeliver = o.won_at !== null;
  const canVerify = o.delivered_at !== null && items.some((e) => e.verifiable);
  return {
    ladder, implementationType: o.implementation_type, deliveries,
    deliveryBuilds: builds.map((b) => ({ buildId: String(b.id), versionNo: b.version_no, status: b.status, title: b.title, summary: b.summary,
      approvedBy: b.approved_by, approvedAt: iso(b.approved_at) })),
    corrections,
    can: { deliver: canDeliver, verify: canVerify },
    blockers: {
      deliver: canDeliver ? null : o.lost_at ? 'This opportunity is marked lost. Only won work can be delivered.' : 'Record the win in 09 first. Only won work can be delivered.',
      verify: o.delivered_at === null ? 'Record the delivery first. Scopely verifies delivered work only.'
        : canVerify ? null : 'No finding on this opportunity can be re-checked automatically. Record a re-check by hand in 02.',
    },
    evidence: items,
    verifications,
  };
}
