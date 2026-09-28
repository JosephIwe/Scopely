// BuildContext: everything a builder or build agent is allowed to see for one build project, and
// nothing else. It replaces BuildInput for agent runs (BuildInput stays for the operator path).
//
// The Truth Rule holds at this seam:
//   * every business attribute travels as a BusinessFact with its basis, source and date. An
//     ESTIMATED figure stays ESTIMATED and a NOT_OBSERVABLE status stays NOT_OBSERVABLE;
//   * an attribute recorded without any basis or source is withheld and named in `withheldFacts`,
//     so an agent can say it is missing but can never state it;
//   * evidence is the opportunity's cited evidence that still holds (a re-check that found it
//     changed or gone drops it), with its re-check state;
//   * what could not be observed is passed as structured NOT_OBSERVABLE observations, never as a claim;
//   * no page HTML, snapshot body, visible page text, contact detail or credential is ever loaded.
// The whole context is checked for credential-like keys and values before it is returned.
import type { Db } from '../tenancy/index.js';

export type FactBasis = 'VERIFIED' | 'REPORTED' | 'ESTIMATED' | 'OBSERVED' | 'INFERRED' | 'NOT_OBSERVABLE';

export type BusinessAttribute = 'employee_count' | 'revenue' | 'reviews' | 'website_status' | 'coordinates';

export interface BusinessFact {
  attribute: BusinessAttribute;
  /** Decimal figures are strings, as everywhere in the API. */
  value: Record<string, string | number | null>;
  basis: FactBasis;
  source: string;
  asOf: string | null;
}

export interface WithheldFact {
  attribute: string;
  reason: string;
}

export interface ContextEvidence {
  evidenceId: string;
  issueCode: string;
  plainIssue: string;
  url: string;
  quote: string;
  observedAt: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  claimState: 'OBSERVED' | 'INFERRED';
  recheck: { result: 'confirmed'; at: string } | null;
}

export interface NotObservableObservation {
  observationId: string;
  checkCode: string;
  url: string;
  observedAt: string;
  state: 'NOT_OBSERVABLE';
}

export interface BuildContext {
  contextVersion: 1;
  purpose: 'DEMO' | 'DELIVERY';
  project: { projectId: string; buildKind: string; opportunityPath: 'WEBSITE' | 'FIX'; storagePrefix: string };
  /** The version a modifying run starts from. */
  baseVersion: { buildId: string; versionNo: number; manifestRef: string | null; artifactRef: string | null } | null;
  /** Who the build is for. Identity, not claims: name and domain as recorded, with where they came from. */
  business: {
    businessId: string;
    name: string;
    domain: string | null;
    websiteUrl: string | null;
    identitySources: { provider: string | null; sourceType: string; reference: string; foundAt: string }[];
  };
  facts: BusinessFact[];
  withheldFacts: WithheldFact[];
  opportunity: { opportunityId: string; opportunityType: string; kind: string | null };
  catalogItem: { catalogItemId: string; catalogKey: string; service: string; components: string[] };
  evidence: ContextEvidence[];
  notObservable: NotObservableObservation[];
  /** The operator's own note of what could not be seen. Never a claim. */
  notObservableNotes: string | null;
  requirements: { requirementId: string; requirement: string; source: 'seller' | 'client'; recordedAt: string }[];
  assets: { assetId: string; kind: string; storageRef: string; sha256: string | null; description: string; providedBy: 'seller' | 'client' }[];
}

const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Business attributes that carry no basis or source column. They are withheld while that is so (B12). */
const UNSOURCED: [string, string][] = [
  ['address_line', 'address'], ['postal_code', 'postal_code'], ['city', 'city'], ['region', 'region'], ['country_code', 'country'],
  ['phone', 'phone'], ['company_register', 'company_register'], ['company_number', 'company_number'],
  ['company_type', 'company_type'], ['company_status', 'company_status'], ['incorporated_on', 'incorporated_on'],
  ['independence', 'structure'], ['vertical', 'industry'], ['subvertical', 'niche'], ['specialty', 'specialty'],
];

/** The facts about a business an agent may use, each with its basis, and the ones it may not. */
export function businessFacts(b: Record<string, any>): { facts: BusinessFact[]; withheld: WithheldFact[] } {
  const facts: BusinessFact[] = [];
  const withheld: WithheldFact[] = [];
  if (b.employees_basis) {
    facts.push({ attribute: 'employee_count', value: { count: b.employee_count, min: b.employee_count_min, max: b.employee_count_max },
      basis: b.employees_basis, source: b.employees_source, asOf: iso(b.employees_as_of) });
  }
  if (b.revenue_basis) {
    facts.push({ attribute: 'revenue', value: { amount: s(b.revenue_amount), min: s(b.revenue_min), max: s(b.revenue_max), currency: b.revenue_currency },
      basis: b.revenue_basis, source: b.revenue_source, asOf: iso(b.revenue_as_of) });
  }
  if (b.reviews_source && (b.review_count !== null || b.rating !== null)) {
    // A review count is what the named review source reports; no stronger basis is recorded.
    facts.push({ attribute: 'reviews', value: { count: b.review_count, rating: s(b.rating) },
      basis: 'REPORTED', source: b.reviews_source, asOf: iso(b.reviews_as_of) });
  }
  if (b.website_status !== 'UNKNOWN' && b.website_status_basis) {
    facts.push({ attribute: 'website_status', value: { status: b.website_status },
      basis: b.website_status_basis, source: b.website_status_source, asOf: iso(b.website_status_checked_at) });
  } else if (b.website_status === 'UNKNOWN') {
    withheld.push({ attribute: 'website_status', reason: 'website status is UNKNOWN' });
  }
  if (b.latitude !== null && b.geo_source) {
    facts.push({ attribute: 'coordinates', value: { latitude: s(b.latitude), longitude: s(b.longitude) },
      basis: 'REPORTED', source: b.geo_source, asOf: null });
  }
  for (const [col, attribute] of UNSOURCED) {
    if (b[col] !== null && b[col] !== undefined && b[col] !== 'unknown') {
      withheld.push({ attribute, reason: 'recorded without a source or basis' });
    }
  }
  return { facts, withheld };
}

/** Throws if any key or value in `value` looks like a credential. Uses the database's own rule. */
export async function assertNoSecrets(db: Db, label: string, value: unknown): Promise<void> {
  const r = await db.query<{ path: string | null }>('SELECT scopely.jsonb_secret_path($1::jsonb) AS path', [JSON.stringify(value)]);
  const path = r.rows[0]!.path;
  if (path) throw new Error(`${label} ${path} looks like a credential; secrets never reach a build agent`);
}

/**
 * Loads what a build agent may see for one project of the request's workspace. Another
 * workspace's project reads as missing. Refuses a project whose opportunity has no evidence
 * that still holds.
 */
export async function loadBuildContext(db: Db, projectId: string,
  opts: { purpose: 'DEMO' | 'DELIVERY'; baseBuildId?: string | null }): Promise<BuildContext> {
  const p = (await db.query(
    `SELECT p.id, p.workspace_id, p.build_kind, bk.opportunity_path, p.opportunity_id,
            o.opportunity_type, o.opportunity_kind, o.mapping_status, o.not_observable_notes, o.business_id,
            ci.id AS catalog_item_id, ci.key AS catalog_key, ci.service, ci.components
       FROM scopely.build_projects p
       JOIN scopely.build_kinds bk ON bk.key = p.build_kind
       JOIN scopely.opportunities o ON o.id = p.opportunity_id
       LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id
      WHERE p.id = $1 AND p.workspace_id = scopely.current_workspace_id()`, [projectId])).rows[0];
  if (!p) throw new Error(`build project ${projectId} does not exist in this workspace`);
  if (p.mapping_status !== 'MAPPED' || !p.catalog_item_id) throw new Error(`opportunity ${p.opportunity_id} is UNMAPPED; there is no service to build`);

  let baseVersion: BuildContext['baseVersion'] = null;
  if (opts.baseBuildId) {
    const bv = (await db.query(
      `SELECT id, version_no, manifest_ref, artifact_ref FROM scopely.builds
        WHERE id = $1 AND project_id = $2 AND workspace_id = scopely.current_workspace_id()`, [opts.baseBuildId, projectId])).rows[0];
    if (!bv) throw new Error(`build ${opts.baseBuildId} is not a version of project ${projectId}`);
    baseVersion = { buildId: String(bv.id), versionNo: bv.version_no, manifestRef: bv.manifest_ref, artifactRef: bv.artifact_ref };
  }

  const [biz, sources, ev, nobs, reqs, assets] = await Promise.all([
    db.query(`SELECT * FROM scopely.businesses WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [p.business_id]),
    db.query(`SELECT provider, kind, ref, found_at FROM scopely.sources WHERE business_id = $1 AND workspace_id = scopely.current_workspace_id() ORDER BY id`,
      [p.business_id]),
    db.query(`SELECT e.id, e.issue_code, e.plain_issue, e.url, e.quote, e.observed_at, e.confidence, e.claim_state, e.recheck_result, e.rechecked_at
                FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
               WHERE oe.opportunity_id = $1 AND e.workspace_id = scopely.current_workspace_id()
                 AND e.recheck_result IS DISTINCT FROM 'changed' AND e.recheck_result IS DISTINCT FROM 'gone'
               ORDER BY e.id`, [p.opportunity_id]),
    db.query(`SELECT o.id, o.check_code, s.url, o.observed_at FROM scopely.observations o JOIN scopely.snapshots s ON s.id = o.snapshot_id
               WHERE s.business_id = $1 AND o.state = 'NOT_OBSERVABLE' AND o.workspace_id = scopely.current_workspace_id()
               ORDER BY o.id`, [p.business_id]),
    db.query(`SELECT id, requirement, source, created_at FROM scopely.build_requirements
               WHERE project_id = $1 AND withdrawn_at IS NULL AND workspace_id = scopely.current_workspace_id() ORDER BY id`, [projectId]),
    db.query(`SELECT id, kind, storage_ref, sha256, description, provided_by FROM scopely.build_assets
               WHERE project_id = $1 AND withdrawn_at IS NULL AND workspace_id = scopely.current_workspace_id() ORDER BY id`, [projectId]),
  ]);
  if (ev.rows.length === 0) throw new Error(`opportunity ${p.opportunity_id} has no evidence that still holds`);
  const b = biz.rows[0];
  const { facts, withheld } = businessFacts(b);

  const ctx: BuildContext = {
    contextVersion: 1,
    purpose: opts.purpose,
    project: { projectId: String(p.id), buildKind: p.build_kind, opportunityPath: p.opportunity_path,
               storagePrefix: `workspaces/${p.workspace_id}/projects/${p.id}/` },
    baseVersion,
    business: {
      businessId: String(b.id), name: b.name, domain: b.domain, websiteUrl: b.website_url,
      identitySources: sources.rows.map((x) => ({ provider: x.provider, sourceType: x.kind, reference: x.ref, foundAt: iso(x.found_at)! })),
    },
    facts,
    withheldFacts: withheld,
    opportunity: { opportunityId: String(p.opportunity_id), opportunityType: p.opportunity_type, kind: p.opportunity_kind },
    catalogItem: { catalogItemId: String(p.catalog_item_id), catalogKey: p.catalog_key, service: p.service, components: p.components },
    evidence: ev.rows.map((e) => ({
      evidenceId: String(e.id), issueCode: e.issue_code, plainIssue: e.plain_issue, url: e.url, quote: e.quote,
      observedAt: iso(e.observed_at)!, confidence: e.confidence, claimState: e.claim_state,
      recheck: e.recheck_result === 'confirmed' ? { result: 'confirmed', at: iso(e.rechecked_at)! } : null,
    })),
    notObservable: nobs.rows.map((o) => ({ observationId: String(o.id), checkCode: o.check_code, url: o.url,
      observedAt: iso(o.observed_at)!, state: 'NOT_OBSERVABLE' as const })),
    notObservableNotes: p.not_observable_notes,
    requirements: reqs.rows.map((r) => ({ requirementId: String(r.id), requirement: r.requirement, source: r.source, recordedAt: iso(r.created_at)! })),
    assets: assets.rows.map((a) => ({ assetId: String(a.id), kind: a.kind, storageRef: a.storage_ref, sha256: a.sha256,
      description: a.description, providedBy: a.provided_by })),
  };
  await assertNoSecrets(db, 'build context', ctx);
  return ctx;
}
