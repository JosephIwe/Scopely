// Fix Builder workflows for the website_fix kind (Slice 7). Every function acts inside the
// request's workspace (the caller has run withWorkspace in a transaction) and reuses the Slice 4
// to 6 primitives: build projects, build runs through executeBuildRun, immutable versions,
// approveBuild / markBuildShown behind the database's gates, and the signed, revocable prospect
// links of the website path.
//
//   PROBLEM / PROOF   the opportunity's VALIDATED contact-link evidence (the source of truth)
//   CAPTURE           captureFixPage: one local capture of the evidence page into captures/ (F3)
//   PROPOSED FIX      proposeCorrection: the destination a person types, checked for shape only
//   GENERATE          generateFix: a build run of the scopely_fix agent, a DRAFT version
//   BEFORE / AFTER    the captured page and the corrected copy, plus the prospect's preview
//   CONFIRM           confirmFix: a person confirms each corrected value, then approves (F4)
//   SHOW              showFixVersion + previewLink: the same gates and links as a website
import { randomUUID } from 'node:crypto';
import { getBuildProject } from '../../api/queries.js';
import { type ObjectStore, ProjectFiles, projectPrefix } from '../../storage/index.js';
import type { Db } from '../../tenancy/index.js';
import { BuildAgentRegistry } from '../agents.js';
import { BuilderRegistry, approveBuild, markBuildShown } from '../index.js';
import { createBuildProject, executeBuildRun, queueBuildRun } from '../runs.js';
import { type RunOutcome, SiteError } from '../site/service.js';
import { FIX_AGENT_KEY, FIX_KIND, type FixRunMeta, ScopelyFixAgent, websiteFixBuilder } from './agent.js';
import { CHANNELS_FOR, type Channel, DestinationError, describeHref, toHref } from './destination.js';
import { type FixDocument, assertFixDocument } from './document.js';
import { CaptureError, type PageFetcher } from './fetch.js';
import { findLinks, linkContext, pageText } from './page.js';

export interface FixDeps {
  store: ObjectStore;
  fetcher: PageFetcher;
}

/** The registries and storage the fix kind runs with. */
export function fixRunDeps(store: ObjectStore) {
  const builders = new BuilderRegistry();
  builders.register(websiteFixBuilder);
  const agents = new BuildAgentRegistry();
  agents.register(new ScopelyFixAgent());
  return { builders, agents, storage: store };
}

// ------------------------------------------------------------------ the project and its evidence

/** The finding the Fix Builder can repair, as the database decides it (F1). */
const SUPPORTED = `scopely.fix_supported_issue_code(e.issue_code) AND e.claim_state = 'OBSERVED'
  AND e.recheck_result IS DISTINCT FROM 'changed' AND e.recheck_result IS DISTINCT FROM 'gone' AND o.href IS NOT NULL`;

/** Opens the fix project for an opportunity, or returns the one already open. */
export async function openFixProject(db: Db, opportunityId: string, opts: { createdByUserId?: string | null } = {}): Promise<string> {
  const o = (await db.query(
    `SELECT o.id, o.mapping_status, ci.build_kind, b.name
       FROM scopely.opportunities o JOIN scopely.businesses b ON b.id = o.business_id
       LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id
      WHERE o.id = $1 AND o.workspace_id = scopely.current_workspace_id()`, [opportunityId])).rows[0];
  if (!o) throw new SiteError(404, 'That opportunity does not exist.');
  if (o.mapping_status !== 'MAPPED' || o.build_kind !== FIX_KIND) {
    throw new SiteError(400, 'This opportunity is not mapped to a website fix service, so there is no fix to build for it.');
  }
  const fixable = (await db.query(
    `SELECT 1 FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id JOIN scopely.observations o ON o.id = e.observation_id
      WHERE oe.opportunity_id = $1 AND e.workspace_id = scopely.current_workspace_id() AND ${SUPPORTED} LIMIT 1`, [opportunityId])).rows[0];
  if (!fixable) throw new SiteError(400, 'The Fix Builder repairs broken contact links, and this opportunity has no observed broken contact link that still holds.');
  const existing = (await db.query(
    `SELECT id FROM scopely.build_projects WHERE opportunity_id = $1 AND build_kind = $2 AND workspace_id = scopely.current_workspace_id()
      ORDER BY id LIMIT 1`, [opportunityId, FIX_KIND])).rows[0];
  if (existing) return String(existing.id);
  return createBuildProject(db, { opportunityId, title: `Fix for ${o.name}`.slice(0, 200), createdByUserId: opts.createdByUserId ?? null });
}

interface ProjectRow { id: string; workspace_id: string; opportunity_id: string; catalog_item_id: string; title: string }

async function fixProjectRow(db: Db, projectId: string): Promise<ProjectRow> {
  const p = (await db.query(
    `SELECT p.*, o.catalog_item_id FROM scopely.build_projects p JOIN scopely.opportunities o ON o.id = p.opportunity_id
      WHERE p.id = $1 AND p.workspace_id = scopely.current_workspace_id()`, [projectId])).rows[0];
  if (!p) throw new SiteError(404, 'That fix does not exist.');
  if (p.build_kind !== FIX_KIND) throw new SiteError(400, 'This build is not a website fix.');
  return p;
}

export interface FixEvidence {
  evidenceId: string;
  issueCode: string;
  plainIssue: string;
  url: string;
  quote: string;
  observedAt: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  claimState: 'OBSERVED' | 'INFERRED';
  recheck: { result: string; at: string } | null;
  /** The broken destination and link text as observed. */
  observedHref: string | null;
  observedLabel: string | null;
  /** Whether the Fix Builder repairs this finding, and with which kinds of destination. */
  supported: boolean;
  channels: Channel[];
}

async function projectEvidence(db: Db, p: ProjectRow): Promise<FixEvidence[]> {
  const r = await db.query(
    `SELECT e.id, e.issue_code, e.plain_issue, e.url, e.quote, e.observed_at, e.confidence, e.claim_state, e.recheck_result, e.rechecked_at,
            o.href, o.visible_text, (${SUPPORTED}) AS supported
       FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id JOIN scopely.observations o ON o.id = e.observation_id
      WHERE oe.opportunity_id = $1 AND e.workspace_id = scopely.current_workspace_id() ORDER BY e.id`, [p.opportunity_id]);
  const all = r.rows.map((e) => ({
    evidenceId: String(e.id), issueCode: e.issue_code, plainIssue: e.plain_issue, url: e.url, quote: e.quote,
    observedAt: new Date(e.observed_at).toISOString(), confidence: e.confidence, claimState: e.claim_state,
    recheck: e.recheck_result ? { result: e.recheck_result, at: new Date(e.rechecked_at).toISOString() } : null,
    observedHref: e.href, observedLabel: e.visible_text, supported: Boolean(e.supported), channels: e.supported ? CHANNELS_FOR[e.issue_code] ?? [] : [],
  }));
  return [...all.filter((e) => e.supported), ...all.filter((e) => !e.supported)];
}

async function supportedEvidence(db: Db, p: ProjectRow, evidenceId: string): Promise<FixEvidence> {
  const ev = (await projectEvidence(db, p)).find((e) => e.evidenceId === String(evidenceId));
  if (!ev) throw new SiteError(404, 'That finding is not part of this fix.');
  if (!ev.supported) throw new SiteError(400, 'The Fix Builder only repairs an observed broken contact link that still holds, and this finding is not one.');
  return ev;
}

// ------------------------------------------------------------------ capture (F3)

interface CaptureRow {
  id: string; evidence_id: string; requested_url: string; final_url: string; http_status: number; content_type: string;
  storage_ref: string; sha256: string; byte_size: number; observed_href: string; href_occurrences: number; captured_at: Date; captured_by: string;
}

async function latestCapture(db: Db, projectId: string, evidenceId: string): Promise<CaptureRow | null> {
  return (await db.query(`SELECT * FROM scopely.fix_captures WHERE project_id = $1 AND evidence_id = $2 AND workspace_id = scopely.current_workspace_id()
                          ORDER BY id DESC LIMIT 1`, [projectId, evidenceId])).rows[0] ?? null;
}

export interface FixCapture {
  captureId: string; evidenceId: string; capturedAt: string; capturedBy: string; finalUrl: string; httpStatus: number; bytes: number;
  /** How many links on the captured page carry the observed broken destination. */
  hrefOccurrences: number;
  /** The first such link's text on the page, and a little of the page on each side. */
  label: string | null;
  context: { before: string; after: string } | null;
}

const filesFor = (store: ObjectStore, workspaceId: string, projectId: string, writable = 'versions/') => {
  const prefix = projectPrefix(String(workspaceId), String(projectId));
  return new ProjectFiles(store, prefix, `${prefix}${writable}`);
};

async function describeCapture(store: ObjectStore, p: ProjectRow, c: CaptureRow): Promise<FixCapture> {
  let context: ReturnType<typeof linkContext> = null;
  try {
    const o = await filesFor(store, p.workspace_id, p.id).readVerified(c.storage_ref, c.sha256);
    context = linkContext(pageText(o.bytes, c.content_type), c.observed_href);
  } catch { /* a capture that fails its hash shows no page text */ }
  return {
    captureId: String(c.id), evidenceId: String(c.evidence_id), capturedAt: new Date(c.captured_at).toISOString(), capturedBy: c.captured_by,
    finalUrl: c.final_url, httpStatus: c.http_status, bytes: c.byte_size, hrefOccurrences: c.href_occurrences,
    label: context?.label ?? null, context: context ? { before: context.before, after: context.after } : null,
  };
}

/**
 * Captures the page a finding was observed on, into the project's captures/ prefix, and records
 * it with its hash and how many links on it carry the observed broken destination. A capture is
 * proof material, never the source of truth, and never changes. A new capture withdraws the
 * corrected value typed against the previous one, so a fix is always made from the latest capture.
 */
export async function captureFixPage(db: Db, deps: FixDeps, projectId: string, opts: { evidenceId: string; capturedBy?: string }): Promise<FixCapture> {
  const p = await fixProjectRow(db, projectId);
  const ev = await supportedEvidence(db, p, opts.evidenceId);
  let page;
  try {
    page = await deps.fetcher.fetch(ev.url);
  } catch (err) {
    // A failed capture records nothing and is never evidence of anything.
    throw new SiteError(409, `Scopely could not capture the page. ${err instanceof CaptureError ? err.message : 'It could not be reached.'} Nothing was recorded.`);
  }
  if (page.bytes.length === 0) throw new SiteError(409, 'The page came back empty, so nothing was captured.');
  const occurrences = findLinks(page.bytes.toString('latin1'), ev.observedHref!).length;
  const stored = await filesFor(deps.store, p.workspace_id, p.id, 'captures/').write(`${randomUUID()}.html`, page.bytes, page.contentType);
  await db.query('SAVEPOINT fix_capture');
  try {
    await db.query(`UPDATE scopely.fix_corrections SET withdrawn_at = now() WHERE project_id = $1 AND evidence_id = $2 AND withdrawn_at IS NULL
                     AND confirmed_at IS NULL AND workspace_id = scopely.current_workspace_id()`, [p.id, ev.evidenceId]);
    const c = (await db.query(
      `INSERT INTO scopely.fix_captures (project_id, evidence_id, requested_url, final_url, http_status, content_type, storage_ref, sha256, byte_size,
         observed_href, href_occurrences, captured_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [p.id, ev.evidenceId, page.requestedUrl, page.finalUrl, page.status, page.contentType.slice(0, 200), stored.key, stored.sha256, page.bytes.length,
       ev.observedHref, occurrences, String(opts.capturedBy ?? 'Scopely').slice(0, 120) || 'Scopely'])).rows[0] as CaptureRow;
    // One GET of the business's page. Its money cost is not known, so none is recorded.
    await db.query(`INSERT INTO scopely.cost_events (opportunity_id, kind, units, meta) VALUES ($1, 'fetch', 1, $2)`,
      [p.opportunity_id, { purpose: 'fix_capture', captureId: String(c.id) }]);
    await db.query('RELEASE SAVEPOINT fix_capture');
    return describeCapture(deps.store, p, c);
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT fix_capture');
    await deps.store.removePrefix(stored.key.replace(/[^/]+$/, '')).catch(() => undefined);
    throw err;
  }
}

// ------------------------------------------------------------------ the corrected value (F4)

interface CorrectionRow {
  id: string; evidence_id: string; capture_id: string; channel: Channel; corrected_href: string; proposed_by: string; proposed_at: Date;
  confirmed_by: string | null; confirmed_at: Date | null; withdrawn_at: Date | null;
}

export interface FixCorrection {
  correctionId: string; evidenceId: string; captureId: string; channel: Channel; correctedHref: string; reads: string;
  proposedBy: string; proposedAt: string; confirmedBy: string | null; confirmedAt: string | null;
}

const correctionView = (c: CorrectionRow): FixCorrection => ({
  correctionId: String(c.id), evidenceId: String(c.evidence_id), captureId: String(c.capture_id), channel: c.channel, correctedHref: c.corrected_href,
  reads: describeHref(c.corrected_href), proposedBy: c.proposed_by, proposedAt: new Date(c.proposed_at).toISOString(),
  confirmedBy: c.confirmed_by, confirmedAt: c.confirmed_at ? new Date(c.confirmed_at).toISOString() : null,
});

async function activeCorrections(db: Db, projectId: string): Promise<CorrectionRow[]> {
  return (await db.query(`SELECT * FROM scopely.fix_corrections WHERE project_id = $1 AND withdrawn_at IS NULL AND workspace_id = scopely.current_workspace_id()
                          ORDER BY evidence_id`, [projectId])).rows;
}

/**
 * Records the destination a person typed for one broken link, against the latest capture of its
 * page. It starts unconfirmed. A different value withdraws the previous one; the same value again
 * changes nothing.
 */
export async function proposeCorrection(db: Db, projectId: string,
  opts: { evidenceId: string; channel: string; value: string; proposedBy?: string }): Promise<FixCorrection> {
  const p = await fixProjectRow(db, projectId);
  const ev = await supportedEvidence(db, p, opts.evidenceId);
  const channel = opts.channel as Channel;
  if (!ev.channels.includes(channel)) {
    throw new SiteError(400, `This finding is repaired with ${ev.channels.map((c) => ({ phone: 'a phone number', whatsapp: 'a WhatsApp number', email: 'an email address' })[c]).join(' or ')}.`);
  }
  let href: string;
  try { href = toHref(channel, opts.value); } catch (err) {
    if (err instanceof DestinationError) throw new SiteError(400, err.message);
    throw err;
  }
  if (href === ev.observedHref) throw new SiteError(400, 'That is the broken destination. Type the one the link should open.');
  const cap = await latestCapture(db, p.id, ev.evidenceId);
  if (!cap) throw new SiteError(409, 'Capture the page first, so the fix is made on a copy of it.');
  if (cap.href_occurrences === 0) {
    throw new SiteError(409, 'The captured page no longer shows the broken link, so there is nothing to correct. Re-check the finding.');
  }
  const current = (await activeCorrections(db, p.id)).find((c) => String(c.evidence_id) === ev.evidenceId);
  if (current && current.corrected_href === href && String(current.capture_id) === String(cap.id)) return correctionView(current);
  if (current) await db.query('UPDATE scopely.fix_corrections SET withdrawn_at = now() WHERE id = $1', [current.id]);
  const row = (await db.query(
    `INSERT INTO scopely.fix_corrections (project_id, evidence_id, capture_id, channel, corrected_href, proposed_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [p.id, ev.evidenceId, cap.id, channel, href, String(opts.proposedBy ?? 'seller').trim().slice(0, 120) || 'seller'])).rows[0] as CorrectionRow;
  return correctionView(row);
}

// ------------------------------------------------------------------ generate (a build run)

const RUN_MESSAGES: Record<string, string> = {
  NO_CORRECTION: 'Type the corrected destination first.',
  CAPTURE_UNVERIFIED: 'The captured page no longer matches what was recorded. Capture it again.',
  CORRECTION_UNSUPPORTED: 'That corrected destination does not answer a finding that still holds, so nothing was made.',
  LINK_NOT_ON_PAGE: 'The broken link is not on the captured page, so there is nothing to correct.',
  VERSION_REFUSED: 'The new version could not be saved. Reload and try again.',
  SECRET_REFUSED: 'The captured page holds what looks like a credential, so the fix was not saved.',
};
const runMessage = (code: string | null) => (code ? RUN_MESSAGES[code] ?? 'Something went wrong while building the fix. Nothing was changed; try again.' : null);

interface VersionRow {
  id: string; version_no: number; status: string; manifest_ref: string | null; manifest_sha256: string | null;
  artifact_ref: string | null; artifact_sha256: string | null; approved_at: Date | null; shown_at: Date | null;
}

async function currentVersion(db: Db, projectId: string): Promise<VersionRow | null> {
  return (await db.query(
    `SELECT * FROM scopely.builds WHERE project_id = $1 AND workspace_id = scopely.current_workspace_id()
        AND status NOT IN ('SUPERSEDED','DISCARDED') ORDER BY version_no DESC LIMIT 1`, [projectId])).rows[0] ?? null;
}

async function appliedCorrectionIds(db: Db, buildId: string): Promise<string[]> {
  return (await db.query('SELECT correction_id FROM scopely.build_fix_corrections WHERE build_id = $1 ORDER BY correction_id', [buildId]))
    .rows.map((r) => String(r.correction_id));
}

/**
 * Makes the fix: a run of the scopely_fix agent on the latest capture with the standing corrected
 * values, producing a DRAFT version (the successor of the current one, if any), then records which
 * corrected values it applied. Unconfirmed values may be generated, so a person can see the
 * BEFORE and AFTER before confirming; nothing can be approved or shown until they confirm.
 */
export async function generateFix(db: Db, deps: { store: ObjectStore }, projectId: string, opts: { startedByUserId?: string | null } = {}): Promise<RunOutcome> {
  const p = await fixProjectRow(db, projectId);
  const corrections = await activeCorrections(db, p.id);
  if (corrections.length === 0) throw new SiteError(409, 'Type the corrected destination first.');
  const captureIds = [...new Set(corrections.map((c) => String(c.capture_id)))];
  if (captureIds.length !== 1) throw new SiteError(409, 'A fix repairs one page at a time. Keep the corrected destinations for one page.');
  const cap = (await db.query('SELECT * FROM scopely.fix_captures WHERE id = $1 AND workspace_id = scopely.current_workspace_id()', [captureIds[0]])).rows[0] as CaptureRow;
  const live = await currentVersion(db, p.id);
  if (live) {
    const applied = await appliedCorrectionIds(db, String(live.id));
    if (applied.join(',') === corrections.map((c) => String(c.id)).join(',')) throw new SiteError(409, 'This fix is already made with these destinations.');
  }
  const meta: FixRunMeta = {
    capture: { captureId: String(cap.id), ref: cap.storage_ref, sha256: cap.sha256, contentType: cap.content_type, finalUrl: cap.final_url,
               capturedAt: new Date(cap.captured_at).toISOString() },
    corrections: corrections.map((c) => ({ correctionId: String(c.id), evidenceId: String(c.evidence_id), channel: c.channel,
      observedHref: cap.observed_href, correctedHref: c.corrected_href })),
  };
  const runId = await queueBuildRun(db, { projectId: p.id, purpose: 'DEMO', agentKey: FIX_AGENT_KEY, agentVersion: '1',
    baseBuildId: live ? String(live.id) : null, startedByUserId: opts.startedByUserId ?? null, meta: meta as unknown as Record<string, unknown> });
  const out = await executeBuildRun(db, fixRunDeps(deps.store), runId);
  if (out.status === 'SUCCEEDED' && out.buildId) {
    for (const c of corrections) {
      await db.query('INSERT INTO scopely.build_fix_corrections (build_id, correction_id) VALUES ($1, $2)', [out.buildId, c.id]);
    }
  }
  return { runId, ...out, message: runMessage(out.errorCode) };
}

// ------------------------------------------------------------------ confirm, approve and show

/** Why a fix version cannot move on, in words for the seller. The database decides; this only rewords. */
export function plainFixBlocker(b: string | null): string | null {
  if (!b) return null;
  if (/needs a person to confirm/.test(b)) return 'Confirm the corrected destination first.';
  if (/applies no corrected value/.test(b)) return 'Make the fix first.';
  if (/withdrawn/.test(b)) return 'The destination changed after this version was made. Make the fix again.';
  if (/no confirmed re-check|re-checked as/.test(b)) return 'The broken link must be re-checked on a fresh visit to the business\'s site before you show the fix.';
  if (/needs a recorded human approval/.test(b)) return 'Confirm and approve this version first.';
  if (/already shown/.test(b)) return 'This version has already been shown.';
  if (/superseded/.test(b)) return 'A newer version exists.';
  return b;
}

async function versionOf(db: Db, p: ProjectRow, buildId: string): Promise<VersionRow> {
  const v = (await db.query(`SELECT * FROM scopely.builds WHERE id = $1 AND project_id = $2 AND workspace_id = scopely.current_workspace_id()`,
    [buildId, p.id])).rows[0];
  if (!v) throw new SiteError(404, 'That version does not exist.');
  return v;
}

/**
 * The human confirmation (F4): the person states that each corrected destination this version
 * applies is right for the business, and approves the version. Both are recorded with who and
 * when. Only the current draft can be confirmed.
 */
export async function confirmFix(db: Db, projectId: string, buildId: string, opts: { confirmedBy: string; confirmed: boolean; at?: string }): Promise<void> {
  const p = await fixProjectRow(db, projectId);
  const by = String(opts.confirmedBy ?? '').trim().slice(0, 120);
  if (opts.confirmed !== true) throw new SiteError(400, 'Tick the box to confirm the corrected destination.');
  if (!by) throw new SiteError(400, 'Say who is confirming.');
  const v = await versionOf(db, p, buildId);
  const live = await currentVersion(db, p.id);
  if (!live || String(live.id) !== String(v.id)) throw new SiteError(409, 'A newer version exists. Reload to confirm the latest fix.');
  if (v.status !== 'DRAFT') throw new SiteError(409, 'This version is already confirmed.');
  const ids = await appliedCorrectionIds(db, String(v.id));
  if (ids.length === 0) throw new SiteError(409, 'This version applies no corrected destination.');
  const at = opts.at ?? new Date().toISOString();
  await db.query(`UPDATE scopely.fix_corrections SET confirmed_by = $2, confirmed_at = GREATEST($3::timestamptz, proposed_at)
                   WHERE id = ANY ($1::bigint[]) AND confirmed_at IS NULL AND workspace_id = scopely.current_workspace_id()`, [ids, by, at]);
  const blocker = (await db.query('SELECT scopely.build_approve_blocker($1) AS b', [v.id])).rows[0].b as string | null;
  if (blocker) throw new SiteError(409, plainFixBlocker(blocker) ?? blocker);
  await approveBuild(db, String(v.id), by, at);
}

/** Marks a confirmed, approved fix version shown, behind the database's gates. */
export async function showFixVersion(db: Db, projectId: string, buildId: string, opts: { at?: string } = {}): Promise<void> {
  const p = await fixProjectRow(db, projectId);
  const at = opts.at ?? new Date().toISOString();
  await versionOf(db, p, buildId);
  const b = (await db.query('SELECT scopely.build_show_blocker($1, $2::timestamptz) AS b', [buildId, at])).rows[0].b as string | null;
  if (b) throw new SiteError(409, plainFixBlocker(b)!);
  await markBuildShown(db, buildId, at);
}

// ------------------------------------------------------------------ reading a version

async function readFixDocument(store: ObjectStore, p: ProjectRow, v: VersionRow): Promise<FixDocument> {
  if (!v.manifest_ref) throw new SiteError(409, 'This version has no fix document.');
  const o = await filesFor(store, p.workspace_id, p.id).readVerified(v.manifest_ref, v.manifest_sha256);
  const doc = JSON.parse(o.bytes.toString('utf8'));
  assertFixDocument(doc);
  return doc;
}

/**
 * One page of a fix version for the seller's side-by-side view: the page as captured (before) or
 * the corrected copy (after), each read against the hash its fix document recorded, from inside
 * the version's own project.
 */
export async function readFixPage(db: Db, store: ObjectStore, projectId: string, buildId: string, view: 'before' | 'after'): Promise<Buffer | null> {
  const p = await fixProjectRow(db, projectId).catch(() => null);
  if (!p) return null;
  const v = (await db.query(`SELECT * FROM scopely.builds WHERE id = $1 AND project_id = $2 AND workspace_id = scopely.current_workspace_id()`, [buildId, p.id])).rows[0] as VersionRow | undefined;
  if (!v) return null;
  try {
    const doc = await readFixDocument(store, p, v);
    const prefix = projectPrefix(String(p.workspace_id), String(p.id));
    const [ref, sha, sub] = view === 'before' ? [doc.capture.ref, doc.capture.sha256, 'captures/'] : [doc.after.ref, doc.after.sha256, 'versions/'];
    if (!ref.startsWith(`${prefix}${sub}`)) return null;
    return (await filesFor(store, p.workspace_id, p.id).readVerified(ref, sha)).bytes;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the fix screen

export type StepState = 'done' | 'current' | 'todo';

export interface FixWorkspace {
  /** opportunityId: where the Case File lives (Slice 8). */
  project: { projectId: string; title: string; opportunityId: string };
  business: { name: string; domain: string | null; websiteUrl: string | null };
  service: { name: string | null; price: string | null; currency: string | null };
  evidence: FixEvidence[];
  /** The finding this fix repairs: the first supported one. */
  focus: FixEvidence | null;
  capture: FixCapture | null;
  correction: FixCorrection | null;
  current: {
    buildId: string; versionNo: number; status: string; summary: string; document: FixDocument;
    /** The corrected values this version applies, with whether a person has confirmed each. */
    corrections: FixCorrection[];
    confirmed: boolean;
    /** The current corrected value differs from the one this version applies. */
    stale: boolean;
    approvedBy: string | null; approvedAt: string | null; shownAt: string | null;
    approveBlocker: string | null; showBlocker: string | null;
  } | null;
  versions: { buildId: string; versionNo: number; status: string; summary: string; createdAt: string; approvedBy: string | null; shownAt: string | null }[];
  steps: Record<'problem' | 'proof' | 'capture' | 'fix' | 'beforeAfter' | 'confirm' | 'show', StepState>;
}

export async function getFixWorkspace(db: Db, store: ObjectStore, projectId: string): Promise<FixWorkspace> {
  const p = await fixProjectRow(db, projectId);
  const view = (await getBuildProject(db, p.id))!;
  const biz = (await db.query(`SELECT b.name, b.domain, b.website_url FROM scopely.opportunities o JOIN scopely.businesses b ON b.id = o.business_id
                               WHERE o.id = $1 AND o.workspace_id = scopely.current_workspace_id()`, [p.opportunity_id])).rows[0];
  const evidence = await projectEvidence(db, p);
  const focus = evidence.find((e) => e.supported) ?? null;
  const capRow = focus ? await latestCapture(db, p.id, focus.evidenceId) : null;
  const capture = capRow ? await describeCapture(store, p, capRow) : null;
  const active = focus ? (await activeCorrections(db, p.id)).find((c) => String(c.evidence_id) === focus.evidenceId) ?? null : null;
  const correction = active ? correctionView(active) : null;

  let current: FixWorkspace['current'] = null;
  const cur = await currentVersion(db, p.id);
  if (cur) {
    const v = view.versions.find((x) => x.buildId === String(cur.id))!;
    const ids = await appliedCorrectionIds(db, String(cur.id));
    const rows = ids.length ? (await db.query('SELECT * FROM scopely.fix_corrections WHERE id = ANY ($1::bigint[]) ORDER BY id', [ids])).rows as CorrectionRow[] : [];
    const doc = await readFixDocument(store, p, cur);
    const confirmed = rows.length > 0 && rows.every((r) => r.confirmed_at !== null && r.withdrawn_at === null);
    current = {
      buildId: String(cur.id), versionNo: cur.version_no, status: cur.status, summary: v.summary, document: doc,
      corrections: rows.map(correctionView), confirmed,
      stale: Boolean(active) && !ids.includes(String(active!.id)),
      approvedBy: v.approval.approvedBy, approvedAt: v.approval.approvedAt, shownAt: v.shown.shownAt,
      approveBlocker: plainFixBlocker(v.gate.approveBlocker), showBlocker: plainFixBlocker(v.gate.showBlocker),
    };
  }
  const shown = Boolean(current?.shownAt);
  const confirmed = Boolean(current?.confirmed && current.approvedAt && !current.stale);
  const made = Boolean(current && !current.stale);
  const steps: FixWorkspace['steps'] = {
    problem: 'done', proof: 'done',
    capture: capture ? 'done' : 'current',
    fix: !capture ? 'todo' : correction ? 'done' : 'current',
    beforeAfter: !correction ? 'todo' : made ? 'done' : 'current',
    confirm: !made ? 'todo' : confirmed ? 'done' : 'current',
    show: !confirmed ? 'todo' : shown ? 'done' : 'current',
  };
  return {
    project: { projectId: String(p.id), title: p.title, opportunityId: String(p.opportunity_id) },
    business: { name: biz.name, domain: biz.domain, websiteUrl: biz.website_url },
    service: { name: view.opportunity.service.name ?? null, price: view.opportunity.service.price ?? null, currency: view.opportunity.service.currency ?? null },
    evidence, focus, capture, correction, current,
    versions: [...view.versions].reverse().map((v) => ({ buildId: v.buildId, versionNo: v.versionNo, status: v.status, summary: v.summary, createdAt: v.createdAt,
      approvedBy: v.approval.approvedBy, shownAt: v.shown.shownAt })),
    steps,
  };
}

