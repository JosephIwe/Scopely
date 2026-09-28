// BUILD/FIX seam. A builder turns one mapped opportunity into a concrete artifact (a demo made
// before the pitch, or the implementation after a win). This module defines the boundary only:
// what a builder receives, what it returns, and how the result is recorded. No builder is
// registered yet; website, landing page, booking flow, lead recovery, SEO, conversion and
// automation builders plug in here later by build kind.
//
// A builder never sees page HTML or uncited facts. Its input is the opportunity's cited evidence
// (issue, URL, verbatim quote, capture time, confidence, claim state), what could not be observed,
// and the catalog item being sold. Evidence that a re-check found changed or gone is excluded.
import type pg from 'pg';

type Db = pg.Client | pg.PoolClient;

export interface BuildEvidence {
  id: string;
  issueCode: string;
  plainIssue: string;
  url: string;
  quote: string;
  observedAt: Date;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  claimState: 'OBSERVED' | 'INFERRED';
}

export interface BuildInput {
  opportunityId: string;
  opportunityType: string;
  buildKind: string;
  catalogItem: { id: string; key: string; service: string; components: string[] };
  business: { name: string; vertical: string | null; subvertical: string | null; countryCode: string | null; city: string | null };
  evidence: BuildEvidence[];
  /** What the evidence could not show, said plainly. Never to be turned into a claim. */
  notObservable: string | null;
}

export interface BuildArtifact {
  title: string;
  summary: string;
  artifactRef: string;
  artifactSha256?: string;
}

export interface FixBuilder {
  kind: string;
  /** Recorded on the build as `<kind>:<version>` so every artifact traces to the builder that made it. */
  version: string;
  build(input: BuildInput): Promise<BuildArtifact>;
}

export class BuilderRegistry {
  private readonly builders = new Map<string, FixBuilder>();

  register(builder: FixBuilder): void {
    if (this.builders.has(builder.kind)) throw new Error(`a builder for ${builder.kind} is already registered`);
    this.builders.set(builder.kind, builder);
  }

  get(kind: string): FixBuilder {
    const b = this.builders.get(kind);
    if (!b) throw new Error(`no builder is available for build kind ${kind}`);
    return b;
  }

  kinds(): string[] {
    return [...this.builders.keys()].sort();
  }
}

/** Loads what a builder may see for one opportunity. Refuses anything that cannot be built. */
export async function loadBuildInput(db: Db, opportunityId: string): Promise<BuildInput> {
  const r = await db.query(
    `SELECT o.id, o.opportunity_type, o.mapping_status, o.not_observable_notes,
            ci.id AS catalog_item_id, ci.key, ci.service, ci.components, ci.build_kind,
            b.name, coalesce(b.vertical, m.vertical) AS vertical, coalesce(b.subvertical, m.subvertical) AS subvertical,
            coalesce(b.country_code, m.country_code) AS country_code, b.city
       FROM scopely.opportunities o
       JOIN scopely.businesses b ON b.id = o.business_id
       LEFT JOIN scopely.markets m ON m.id = coalesce(o.market_id, b.market_id)
       LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id
      WHERE o.id = $1`, [opportunityId]);
  const o = r.rows[0];
  if (!o) throw new Error(`opportunity ${opportunityId} does not exist`);
  if (o.mapping_status !== 'MAPPED') throw new Error(`opportunity ${opportunityId} is UNMAPPED; there is no service to build`);
  if (!o.build_kind) throw new Error(`catalog item ${o.key} has no build kind; it cannot be built`);
  const ev = await db.query(
    `SELECT e.id, e.issue_code, e.plain_issue, e.url, e.quote, e.observed_at, e.confidence, e.claim_state
       FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
      WHERE oe.opportunity_id = $1 AND e.recheck_result IS DISTINCT FROM 'changed' AND e.recheck_result IS DISTINCT FROM 'gone'
      ORDER BY e.id`, [opportunityId]);
  if (ev.rows.length === 0) throw new Error(`opportunity ${opportunityId} has no evidence that still holds`);
  return {
    opportunityId: String(o.id),
    opportunityType: o.opportunity_type,
    buildKind: o.build_kind,
    catalogItem: { id: String(o.catalog_item_id), key: o.key, service: o.service, components: o.components },
    business: { name: o.name, vertical: o.vertical, subvertical: o.subvertical, countryCode: o.country_code, city: o.city },
    evidence: ev.rows.map((e) => ({
      id: String(e.id), issueCode: e.issue_code, plainIssue: e.plain_issue, url: e.url, quote: e.quote,
      observedAt: e.observed_at, confidence: e.confidence, claimState: e.claim_state,
    })),
    notObservable: o.not_observable_notes,
  };
}

/** Records a build and the evidence it addresses. `generator` is 'operator' for hand-made builds. */
export async function recordBuild(db: Db, input: BuildInput, artifact: BuildArtifact,
  opts: { purpose: 'DEMO' | 'DELIVERY'; generator: string; supersedesBuildId?: string }): Promise<string> {
  const b = await db.query(
    `INSERT INTO scopely.builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, artifact_ref,
       artifact_sha256, generator, supersedes_build_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [input.opportunityId, input.catalogItem.id, input.buildKind, opts.purpose, artifact.title, artifact.summary,
     artifact.artifactRef, artifact.artifactSha256 ?? null, opts.generator, opts.supersedesBuildId ?? null]);
  const id = String(b.rows[0].id);
  for (const e of input.evidence) {
    await db.query('INSERT INTO scopely.build_evidence (build_id, evidence_id) VALUES ($1,$2)', [id, e.id]);
  }
  return id;
}

/** Runs a registered builder and records its artifact as a DRAFT build. Nothing is shown or deployed. */
export async function runBuilder(db: Db, registry: BuilderRegistry, opportunityId: string,
  purpose: 'DEMO' | 'DELIVERY'): Promise<string> {
  const input = await loadBuildInput(db, opportunityId);
  const builder = registry.get(input.buildKind);
  const artifact = await builder.build(input);
  return recordBuild(db, input, artifact, { purpose, generator: `${builder.kind}:${builder.version}` });
}

export async function approveBuild(db: Db, buildId: string, approvedBy: string, approvedAt: string): Promise<void> {
  await db.query(`UPDATE scopely.builds SET status = 'APPROVED', approved_by = $2, approved_at = $3 WHERE id = $1`,
    [buildId, approvedBy, approvedAt]);
}

/** Records that an approved DEMO build was shown to the prospect. */
export async function markBuildShown(db: Db, buildId: string, shownAt: string): Promise<void> {
  await db.query(`UPDATE scopely.builds SET status = 'SHOWN', shown_at = $2 WHERE id = $1`, [buildId, shownAt]);
}
