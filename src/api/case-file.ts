// The Case File (Slice 8): everything Scopely already knows about one opportunity, read in one go
// and organised the way the seller works through it. Nothing here is computed from a guess: every
// field is a stored value, a count of stored rows, or a gate the database already decides, and an
// unknown value is null so the screen can say "not known" instead of inventing one.
//
// Scoped like the rest of src/api: an explicit current_workspace_id() predicate on every query, on
// top of row-level security. An opportunity in another workspace reads as not found.
import type { Db } from '../tenancy/index.js';
import { getBusinessDetail } from './queries.js';
import type {
  BuildState, CaseFile, CaseFileContact, CaseFileOutcome, CaseFileSuppression, DeliveryState, EvidenceItem, FeedStage, OpportunityBuildInfo,
  ProspectReadiness, ReadinessCheck, SellState,
} from './types.js';

const WS = 'workspace_id = scopely.current_workspace_id()';
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

/**
 * Where an opportunity sits in FIND → BUILD → SELL → DELIVER → VERIFY, from its stored states only.
 * Discover is not a stage an opportunity sits in: it is every opportunity (and later the map).
 */
export function stageOf(x: { buildState: BuildState | string; sellState: SellState | string; deliveryState: DeliveryState | string }): FeedStage {
  if (String(x.deliveryState).startsWith('VERIFIED_')) return 'VERIFY';
  if (x.sellState === 'WON') return 'DELIVER';
  if (['APPROVED', 'SENT', 'PITCHED', 'REPLIED', 'LOST'].includes(x.sellState)) return 'SELL';
  if (x.buildState !== 'NONE') return 'BUILD';
  return 'OPPORTUNITIES';
}

/**
 * Which builder can open for each opportunity, and the project it already has. A website build
 * needs a mapped service on the website path; a fix needs an OBSERVED broken contact link that
 * still holds (F1). The same rule the Opportunities list used since Slice 7, in one place.
 */
export async function opportunityBuildInfo(db: Db, opportunityIds: string[]): Promise<Map<string, OpportunityBuildInfo>> {
  const out = new Map<string, OpportunityBuildInfo>();
  if (opportunityIds.length === 0) return out;
  // One client runs one query at a time.
  const base = await db.query(`SELECT opportunity_id, opportunity_kind, mapping_status FROM scopely.v_opportunity_feed
                                WHERE opportunity_id = ANY ($1) AND ${WS}`, [opportunityIds]);
  const projects = await db.query(`SELECT opportunity_id, build_kind, min(id) AS project_id FROM scopely.build_projects WHERE build_kind IN ('website', 'website_fix')
                AND opportunity_id = ANY ($1) AND ${WS} GROUP BY opportunity_id, build_kind`, [opportunityIds]);
  const fixable = await db.query(`SELECT DISTINCT oe.opportunity_id FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
                JOIN scopely.observations o ON o.id = e.observation_id
               WHERE oe.opportunity_id = ANY ($1) AND e.${WS} AND scopely.fix_supported_issue_code(e.issue_code)
                 AND e.claim_state = 'OBSERVED' AND e.recheck_result IS DISTINCT FROM 'changed' AND e.recheck_result IS DISTINCT FROM 'gone' AND o.href IS NOT NULL`,
    [opportunityIds]);
  const canFix = new Set(fixable.rows.map((r) => String(r.opportunity_id)));
  const proj = (kind: string, id: string) => {
    const r = projects.rows.find((x) => x.build_kind === kind && String(x.opportunity_id) === id);
    return r ? String(r.project_id) : null;
  };
  for (const r of base.rows) {
    const id = String(r.opportunity_id);
    out.set(id, {
      buildable: r.opportunity_kind === 'website' && r.mapping_status === 'MAPPED', projectId: proj('website', id),
      fixable: r.opportunity_kind === 'website_fix' && r.mapping_status === 'MAPPED' && canFix.has(id), fixProjectId: proj('website_fix', id),
    });
  }
  return out;
}

/** Why a builder cannot open, in the seller's words, or null when it can. */
function buildBlocker(path: string | null, kind: string | null, mapping: string, info: OpportunityBuildInfo): string | null {
  if (path === 'WEBSITE') {
    if (info.buildable || info.projectId) return null;
    if (mapping !== 'MAPPED') return 'No service from your catalog is mapped to this opportunity yet, so there is nothing to build.';
    return 'This opportunity is not mapped to a website service.';
  }
  if (path === 'FIX') {
    if (info.fixable || info.fixProjectId) return null;
    if (mapping !== 'MAPPED') return 'No service from your catalog is mapped to this opportunity yet, so there is nothing to build.';
    if (kind !== 'website_fix') return 'The Fix Builder repairs broken contact links only. This kind of fix has no builder yet.';
    return 'No observed broken contact link on this opportunity still holds, so there is nothing for the Fix Builder to repair.';
  }
  return 'This opportunity has no build path yet.';
}

function evidenceItem(e: Record<string, any>): EvidenceItem & { observedHref: string | null; visibleText: string | null } {
  return {
    evidenceId: String(e.id), issueCode: e.issue_code, plainIssue: e.plain_issue, url: e.url, quote: e.quote, claimState: e.claim_state,
    confidence: e.confidence, observedAt: iso(e.observed_at)!, snapshotId: String(e.snapshot_id), observationId: String(e.observation_id),
    rule: { key: e.rule_key, version: e.version },
    recheck: e.recheck_result ? { result: e.recheck_result, at: iso(e.rechecked_at)! } : null,
    observedHref: e.href ?? null, visibleText: e.visible_text ?? null,
  };
}


const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Prospect Readiness (Slice 9): what is missing before the seller may act on this prospect, judged
 * by the gates the database already has. The decision is theirs: READY needs evidence_send_blocker
 * to pass now for every finding that still holds (a changed or gone finding is dropped, as the gate
 * requires) and at least one contact to pass contact_outreach_blocker. The other checks only explain
 * which part is missing, so a screen never recomputes a gate.
 */
async function prospectReadiness(db: Db, opportunityId: string, businessId: string,
  contacts: { id: string; email: string | null; outreach_basis: string | null; blocker: string | null; suppressed: boolean }[],
  suppressions: CaseFileSuppression[], highUnchecked: number): Promise<ProspectReadiness> {
  // Judged now, the same time the show and send gates use.
  const ev = (await db.query(
    `SELECT count(*)::int AS holding, scopely.evidence_send_blocker(array_agg(e.id), now()) AS blocker
       FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
      WHERE oe.opportunity_id = $1 AND e.${WS}
        AND e.recheck_result IS DISTINCT FROM 'changed' AND e.recheck_result IS DISTINCT FROM 'gone'`, [opportunityId])).rows[0];
  const rules = (await db.query(
    `SELECT r.outreach_basis, r.requirement, b.company_type, b.company_status,
            (lower(btrim(coalesce(b.company_type, ''))) = ANY (r.allowed_company_types)
             AND lower(btrim(coalesce(b.company_status, ''))) = r.required_company_status) AS met
       FROM scopely.businesses b JOIN scopely.outreach_basis_rules r ON r.active AND r.country_code = b.country_code
      WHERE b.id = $1 AND b.${WS}`, [businessId])).rows;

  const checks: ReadinessCheck[] = [];
  const holding = Number(ev.holding);
  const evidenceBlocker: string | null = holding === 0 ? 'no finding on this opportunity still holds' : ev.blocker;
  checks.push(holding === 0
    ? { key: 'evidence', state: 'blocked', label: 'No finding still holds', detail: 'Every finding was re-checked as changed or gone. Do not pitch on this evidence.' }
    : evidenceBlocker
      ? { key: 'evidence', state: 'missing', label: 'Evidence needs re-check',
          detail: highUnchecked ? `${plural(highUnchecked, 'high-confidence finding has', 'high-confidence findings have')} not been re-checked on a new visit.` : evidenceBlocker }
      : { key: 'evidence', state: 'done', label: 'Evidence re-checked and holds', detail: null });

  const withEmail = contacts.filter((c) => c.email);
  checks.push(withEmail.length
    ? { key: 'contact', state: 'done', label: 'Contact recorded', detail: plural(withEmail.length, 'contact with an email address', 'contacts with an email address') }
    : { key: 'contact', state: 'missing', label: 'Contact missing', detail: contacts.length ? 'No contact has an email address.' : 'No buyer contact is recorded for this business.' });

  const lawful = withEmail.filter((c) => c.outreach_basis === 'corporate_subscriber' || c.outreach_basis === 'consent');
  checks.push(lawful.length
    ? { key: 'lawful_basis', state: 'done', label: 'Lawful basis recorded', detail: null }
    : withEmail.length && withEmail.every((c) => c.outreach_basis === 'not_permitted')
      ? { key: 'lawful_basis', state: 'blocked', label: 'Not permitted to contact', detail: 'Every contact is recorded as not permitted.' }
      : { key: 'lawful_basis', state: 'missing', label: 'Lawful basis missing', detail: 'Record what lets you contact them: corporate subscriber or consent.' });

  const ready = contacts.filter((c) => c.email && c.blocker === null).map((c) => c.id);
  // The country's company rule matters for the bases it covers: the bases recorded so far, or, before
  // any is recorded, every basis it has a rule for.
  const bases = new Set(lawful.map((c) => c.outreach_basis));
  const readyBases = new Set(contacts.filter((c) => ready.includes(c.id)).map((c) => c.outreach_basis));
  const rule = rules.find((r) => (ready.length ? readyBases.has(r.outreach_basis) : bases.size === 0 || bases.has(r.outreach_basis)));
  if (rule) {
    const got = [rule.company_type, rule.company_status].filter(Boolean).join(' · ');
    checks.push(rule.met
      ? { key: 'company', state: 'done', label: 'Company status recorded', detail: got }
      : !rule.company_type || !rule.company_status
        ? { key: 'company', state: 'missing', label: 'Company status missing', detail: `${rule.requirement}. Record the company type and status from the register.` }
        : { key: 'company', state: 'blocked', label: 'Company not eligible', detail: `${rule.requirement}; the register says ${got}.` });
  }

  const whole = suppressions.find((x) => x.target === 'business' || x.target === 'domain');
  const allSuppressed = withEmail.length > 0 && withEmail.every((c) => c.suppressed);
  checks.push(whole
    ? { key: 'suppression', state: 'blocked', label: 'Suppressed', detail: whole.target === 'business' ? 'This business is on your suppression list.' : 'This business’s domain is on your suppression list.' }
    : allSuppressed
      ? { key: 'suppression', state: 'blocked', label: 'Suppressed', detail: 'Every contact’s email address is on your suppression list.' }
      : { key: 'suppression', state: 'done', label: 'Not suppressed', detail: null });

  const status = whole || allSuppressed ? 'SUPPRESSED' : evidenceBlocker === null && ready.length > 0 ? 'READY' : 'NOT_READY';
  return { status, checks, readyContactIds: status === 'READY' ? ready : [], evidenceBlocker };
}

/** One opportunity's Case File, or null when it is not in this workspace. */
export async function getCaseFile(db: Db, opportunityId: string): Promise<CaseFile | null> {
  const o = (await db.query(
    `SELECT f.*, op.why_it_matters, op.not_observable_notes, op.unmapped_reason, op.pitched_at, op.reply_at, op.won_at, op.lost_at, op.deal_value
       FROM scopely.v_opportunity_feed f JOIN scopely.opportunities op ON op.id = f.opportunity_id
      WHERE f.opportunity_id = $1 AND f.${WS}`, [opportunityId])).rows[0];
  if (!o) return null;
  const business = (await getBusinessDetail(db, String(o.business_id)))!;
  const evidence = await db.query(
    `SELECT e.*, o.snapshot_id, o.href, o.visible_text, rv.rule_key, rv.version FROM scopely.opportunity_evidence oe
       JOIN scopely.evidence e ON e.id = oe.evidence_id
       JOIN scopely.observations o ON o.id = e.observation_id
       JOIN scopely.rule_versions rv ON rv.id = e.rule_version_id
      WHERE oe.opportunity_id = $1 AND e.${WS}
      ORDER BY CASE e.confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, e.id`, [opportunityId]);
  const info = (await opportunityBuildInfo(db, [opportunityId])).get(opportunityId)!;
  const projectId = o.opportunity_path === 'FIX' ? info.fixProjectId : info.projectId;
  const latest = projectId ? (await db.query(
    `SELECT b.id, b.version_no, b.status, b.summary, b.created_at, b.approved_at, b.approved_by, b.shown_at,
            (SELECT count(*) FROM scopely.builds x WHERE x.project_id = $1) AS versions
       FROM scopely.builds b WHERE b.project_id = $1 AND b.${WS} AND b.status NOT IN ('DISCARDED', 'SUPERSEDED')
      ORDER BY b.version_no DESC LIMIT 1`, [projectId])).rows[0] : undefined;
  const contacts = await db.query(
    `SELECT c.*, scopely.contact_outreach_blocker(c.id, c.business_id) AS blocker,
            EXISTS (SELECT 1 FROM scopely.suppression s WHERE s.${WS} AND c.email IS NOT NULL
                       AND ((s.email IS NOT NULL AND lower(s.email) = lower(c.email))
                            OR (s.domain IS NOT NULL AND lower(s.domain) = lower(split_part(c.email, '@', 2))))) AS suppressed
       FROM scopely.contacts c
      WHERE c.business_id = $1 AND c.${WS} ORDER BY c.is_decision_maker DESC, c.id`, [o.business_id]);
  // The workspace's suppression entries that reach this business: the business, its domain, or a contact's address or domain.
  const suppression = await db.query(
    `SELECT s.* FROM scopely.suppression s
      WHERE s.${WS} AND (s.business_id = $1
         OR (s.domain IS NOT NULL AND lower(s.domain) = lower(coalesce($2, '')))
         OR EXISTS (SELECT 1 FROM scopely.contacts c WHERE c.business_id = $1 AND c.${WS} AND c.email IS NOT NULL
                       AND ((s.email IS NOT NULL AND lower(s.email) = lower(c.email))
                            OR (s.domain IS NOT NULL AND lower(s.domain) = lower(split_part(c.email, '@', 2))))))
      ORDER BY s.added_at, s.id`, [o.business_id, business.domain]);
  const outcomes = await db.query(
    `SELECT t.*, EXISTS (SELECT 1 FROM scopely.outcomes v WHERE v.corrects_outcome_id = t.id) AS voided_by_later
       FROM scopely.outcomes t WHERE t.opportunity_id = $1 AND t.${WS} ORDER BY t.occurred_at, t.id`, [opportunityId]);

  const items = evidence.rows.map(evidenceItem);
  const suppressions: CaseFileSuppression[] = suppression.rows.map((x) => ({
    suppressionId: String(x.id), target: x.business_id !== null ? 'business' : x.domain !== null ? 'domain' : 'email',
    value: x.business_id !== null ? null : x.domain ?? x.email, reason: x.reason, addedAt: iso(x.added_at)!,
  }));
  const recheckNeeded = items.filter((e) => e.confidence === 'HIGH' && e.recheck?.result !== 'confirmed' && e.recheck?.result !== 'changed' && e.recheck?.result !== 'gone')
    .map((e) => ({ evidenceId: e.evidenceId, plainIssue: e.plainIssue }));
  const readiness = await prospectReadiness(db, opportunityId, String(o.business_id),
    contacts.rows.map((c) => ({ id: String(c.id), email: c.email, outreach_basis: c.outreach_basis, blocker: c.blocker, suppressed: c.suppressed })),
    suppressions, recheckNeeded.length);
  const outcomeViews: CaseFileOutcome[] = outcomes.rows.map((r) => ({
    outcomeId: String(r.id), kind: r.kind, occurredAt: iso(r.occurred_at)!, channel: r.channel, replyClass: r.reply_class,
    amount: s(r.amount), currency: r.currency, notes: r.notes, recordedBy: r.recorded_by, correctsOutcomeId: s(r.corrects_outcome_id),
    voided: Boolean(r.voided_by_later), recordedAt: iso(r.created_at)!,
  }));
  const terminal = outcomeViews.find((x) => (x.kind === 'won' || x.kind === 'lost') && !x.voided) ?? null;
  const pitched = o.pitched_at !== null;
  const contactViews: CaseFileContact[] = contacts.rows.map((c) => ({
    contactId: String(c.id), name: c.full_name, role: c.role, isDecisionMaker: c.is_decision_maker, email: c.email, emailKind: c.email_kind,
    label: c.label, source: c.source, sourceUrl: c.source_url, outreachBasis: c.outreach_basis,
    // The database's own gate (007): basis, the country's rule and suppression. Null means an email may be written.
    emailBlocker: c.blocker,
  }));

  return {
    opportunityId: String(o.opportunity_id), path: o.opportunity_path, kind: o.opportunity_kind, opportunityType: o.opportunity_type,
    status: o.status, stage: stageOf({ buildState: o.build_state, sellState: o.sell_state, deliveryState: o.delivery_state }),
    createdAt: iso(o.created_at)!,
    situation: { whyItMatters: o.why_it_matters, notObservable: o.not_observable_notes },
    evidence: items,
    business: {
      businessId: business.businessId, name: business.name, domain: business.domain, websiteUrl: business.websiteUrl,
      phone: business.phone, vertical: business.vertical, subvertical: business.subvertical, specialty: business.specialty,
      location: business.location, website: business.website, company: business.company, firmographics: business.firmographics,
      sources: business.sources.map((x) => ({ provider: x.provider, sourceType: x.sourceType, foundAt: x.foundAt })),
    },
    service: {
      mappingStatus: o.mapping_status, catalogKey: o.catalog_key, name: o.service, price: s(o.service_price), currency: o.currency,
      unmappedReason: o.unmapped_reason,
    },
    build: {
      builder: o.opportunity_path === 'FIX' ? 'fix' : o.opportunity_path === 'WEBSITE' ? 'website' : null,
      projectId,
      canStart: projectId === null && (o.opportunity_path === 'FIX' ? info.fixable : info.buildable),
      blocker: buildBlocker(o.opportunity_path, o.opportunity_kind, o.mapping_status, info),
      buildState: o.build_state, runState: o.build_run_state,
      versions: latest ? Number(latest.versions) : 0,
      current: latest ? {
        buildId: String(latest.id), versionNo: latest.version_no, status: latest.status, summary: latest.summary, createdAt: iso(latest.created_at)!,
        approvedAt: iso(latest.approved_at), approvedBy: latest.approved_by, shownAt: iso(latest.shown_at),
      } : null,
    },
    buyer: { contacts: contactViews, suppressions },
    readiness,
    outreach: {
      // Rule 12: a HIGH finding is re-checked on a new snapshot before it reaches a prospect.
      recheckNeeded,
      noLongerHolds: items.filter((e) => e.recheck?.result === 'changed' || e.recheck?.result === 'gone')
        .map((e) => ({ evidenceId: e.evidenceId, plainIssue: e.plainIssue, result: e.recheck!.result as 'changed' | 'gone' })),
    },
    sell: {
      sellState: o.sell_state, deliveryState: o.delivery_state,
      pitchedAt: iso(o.pitched_at), replyAt: iso(o.reply_at), wonAt: iso(o.won_at), lostAt: iso(o.lost_at),
      agreedAmount: s(o.deal_value), currency: o.currency,
      outcomes: outcomeViews,
      terminalOutcomeId: terminal?.outcomeId ?? null,
      // Advisory only: the outcome ledger's own guards decide (append-only, pitch before a result, one result).
      can: {
        pitched: true, replied: pitched, call: pitched,
        won: pitched && !terminal, lost: pitched && !terminal, voided: Boolean(terminal),
      },
    },
  };
}

