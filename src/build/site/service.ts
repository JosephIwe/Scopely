// Build Workspace workflows for the website kind. Every function acts inside the request's
// workspace (the caller has run withWorkspace in a transaction) and reuses the PR4 model:
//
//   open a project    createBuildProject (one website project per opportunity, reused)
//   generate          queueBuildRun + executeBuildRun with the scopely_site agent: a DRAFT version
//   AI edit           the same, as a run that modifies the current version (its successor)
//   visual edit/save  a person's version: validated operations applied to the current version,
//                     recorded with recordBuild as its successor, citing the same evidence
//   approve / show    approveBuild / markBuildShown, behind the database's own gates
//
// A version's files are written once and never changed; an edit to an approved or shown version
// is always a new version, and the database refuses anything else.
import { randomUUID } from 'node:crypto';
import { getBuildProject } from '../../api/queries.js';
import type { BuildProjectView } from '../../api/types.js';
import { type ObjectStore, ProjectFiles, editFiles, projectPrefix, sha256 } from '../../storage/index.js';
import { type Db, requireWorkspace } from '../../tenancy/index.js';
import { BuildAgentRegistry } from '../agents.js';
import { assertNoSecrets, loadBuildContext } from '../context.js';
import { BuilderRegistry, approveBuild, markBuildShown, recordBuild } from '../index.js';
import { createBuildProject, executeBuildRun, queueBuildRun } from '../runs.js';
import { ScopelySiteAgent, WEBSITE_KIND, websiteBuilder } from './agent.js';
import { type BuildBasis, type ReadinessItem, type SiteDocument, describeBasis, readiness } from './document.js';
import { EXT, type ImageAsset, MAX_IMAGE_BYTES, imageType, loadPlacedImages } from './images.js';
import { type EditInterpreter, RuleBasedEditInterpreter } from './interpret.js';
import { applyEdits, assertValidDocument, describeOperation } from './operations.js';
import { type PreviewClaims, signPreview } from './preview.js';
import { renderSite } from './render.js';
import { MERIDIAN, type SiteTemplate, getTemplate, listTemplates } from './template.js';

export interface SiteDeps {
  store: ObjectStore;
  interpreter?: EditInterpreter;
}

/** A plain-language failure a screen can show as is. */
export class SiteError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

/** The registries and storage the website kind runs with. */
export function siteRunDeps(deps: SiteDeps) {
  const builders = new BuilderRegistry();
  builders.register(websiteBuilder);
  const agents = new BuildAgentRegistry();
  agents.register(new ScopelySiteAgent(deps.interpreter ?? new RuleBasedEditInterpreter()));
  return { builders, agents, storage: deps.store };
}

const AGENT_KEY = 'scopely_site';

// ------------------------------------------------------------------ opening a project

/** Opens the website project for an opportunity, or returns the one already open. */
export async function openWebsiteProject(db: Db, opportunityId: string, opts: { createdByUserId?: string | null } = {}): Promise<string> {
  const o = (await db.query(
    `SELECT o.id, o.mapping_status, ci.build_kind, b.name
       FROM scopely.opportunities o JOIN scopely.businesses b ON b.id = o.business_id
       LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id
      WHERE o.id = $1 AND o.workspace_id = scopely.current_workspace_id()`, [opportunityId])).rows[0];
  if (!o) throw new SiteError(404, 'That opportunity does not exist.');
  if (o.mapping_status !== 'MAPPED' || o.build_kind !== WEBSITE_KIND) {
    throw new SiteError(400, 'This opportunity is not mapped to a website service, so there is no website to build for it.');
  }
  const existing = (await db.query(
    `SELECT id FROM scopely.build_projects WHERE opportunity_id = $1 AND build_kind = $2 AND workspace_id = scopely.current_workspace_id()
      ORDER BY id LIMIT 1`, [opportunityId, WEBSITE_KIND])).rows[0];
  if (existing) return String(existing.id);
  return createBuildProject(db, { opportunityId, title: `Website for ${o.name}`.slice(0, 200), createdByUserId: opts.createdByUserId ?? null });
}

async function projectRow(db: Db, projectId: string) {
  const p = (await db.query(
    `SELECT p.*, o.catalog_item_id FROM scopely.build_projects p JOIN scopely.opportunities o ON o.id = p.opportunity_id
      WHERE p.id = $1 AND p.workspace_id = scopely.current_workspace_id()`, [projectId])).rows[0];
  if (!p) throw new SiteError(404, 'That build does not exist.');
  if (p.build_kind !== WEBSITE_KIND) throw new SiteError(400, 'This build is not a website.');
  return p as { id: string; workspace_id: string; opportunity_id: string; catalog_item_id: string; title: string };
}

// ------------------------------------------------------------------ build setup (steps 3 to 5)

export interface BuildSetup {
  projectId: string;
  business: { name: string; websiteUrl: string | null };
  buildType: { key: string; name: string; description: string };
  templates: { key: string; name: string; description: string; sections: string[] }[];
  /** The problem, the plan, and what will and will not be used. */
  basis: BuildBasis;
  hasVersions: boolean;
}

export async function getBuildSetup(db: Db, projectId: string): Promise<BuildSetup> {
  const p = await projectRow(db, projectId);
  let ctx;
  try {
    ctx = await loadBuildContext(db, projectId, { purpose: 'DEMO' });
  } catch {
    throw new SiteError(409, 'The evidence behind this opportunity no longer holds, so there is nothing to build from. Re-check it first.');
  }
  const instructions = await websiteBuilder.instruct!(ctx);
  const kind = (await db.query('SELECT name, description FROM scopely.build_kinds WHERE key = $1', [WEBSITE_KIND])).rows[0];
  const versions = (await db.query('SELECT count(*)::int AS n FROM scopely.builds WHERE project_id = $1 AND workspace_id = scopely.current_workspace_id()', [p.id])).rows[0];
  return {
    projectId: String(p.id),
    business: { name: ctx.business.name, websiteUrl: ctx.business.websiteUrl },
    buildType: { key: WEBSITE_KIND, name: kind.name, description: kind.description },
    templates: listTemplates(WEBSITE_KIND).map((t) => ({ key: t.key, name: t.name, description: t.description, sections: t.sections.map((s) => s.name) })),
    basis: describeBasis(ctx, instructions),
    hasVersions: versions.n > 0,
  };
}

// ------------------------------------------------------------------ runs: generate and AI edit

export interface RunOutcome { runId: string; status: 'SUCCEEDED' | 'FAILED'; buildId: string | null; errorCode: string | null; message: string | null }

const RUN_MESSAGES: Record<string, string> = {
  EDIT_NOT_UNDERSTOOD: 'Scopely could not turn that into an edit. Try naming what to change, for example "make it feel more premium", "hide the gallery" or "change the button to WhatsApp".',
  EDIT_REFUSED: 'That edit would have added something the site cannot back up, so nothing was changed.',
  EDIT_REQUEST_EMPTY: 'Say what you would like to change.',
  TEMPLATE_NOT_FOUND: 'That template is not available.',
  VERSION_REFUSED: 'The new version could not be saved. Reload and try again.',
  SECRET_REFUSED: 'That looked like a password or key, so nothing was saved. Never put credentials into a site.',
};
const runMessage = (code: string | null) => (code ? RUN_MESSAGES[code] ?? 'Something went wrong while building. Nothing was changed; try again.' : null);

async function runAgent(db: Db, deps: SiteDeps, projectId: string, baseBuildId: string | null, meta: Record<string, unknown>,
  startedByUserId: string | null): Promise<RunOutcome> {
  let runId: string;
  await db.query('SAVEPOINT queue_run');
  try {
    runId = await queueBuildRun(db, { projectId, purpose: 'DEMO', agentKey: AGENT_KEY, agentVersion: '1', baseBuildId, startedByUserId, meta });
    await db.query('RELEASE SAVEPOINT queue_run');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT queue_run');
    if (/SECRET:/.test((err as Error).message)) throw new SiteError(400, RUN_MESSAGES.SECRET_REFUSED!);
    throw err;
  }
  const out = await executeBuildRun(db, siteRunDeps(deps), runId);
  return { runId, ...out, message: runMessage(out.errorCode) };
}

/** Steps 6 to 8: builds the first version of the site from the opportunity with a template. */
export async function generateSite(db: Db, deps: SiteDeps, projectId: string, opts: { templateKey: string; startedByUserId?: string | null }): Promise<RunOutcome> {
  const p = await projectRow(db, projectId);
  const live = await currentVersion(db, p.id);
  if (live) throw new SiteError(409, 'This site is already built. Edit it in the workspace.');
  return runAgent(db, deps, p.id, null, { template: opts.templateKey }, opts.startedByUserId ?? null);
}

/** Step 11: a controlled AI edit of the current version, producing its successor. */
export async function requestAiEdit(db: Db, deps: SiteDeps, projectId: string, opts: { baseBuildId: string; request: string; startedByUserId?: string | null }): Promise<RunOutcome> {
  const p = await projectRow(db, projectId);
  await requireCurrent(db, p.id, opts.baseBuildId);
  const request = String(opts.request ?? '').trim();
  if (!request) throw new SiteError(400, 'Say what you would like to change.');
  if (request.length > 500) throw new SiteError(400, 'Keep the request under 500 characters.');
  return runAgent(db, deps, p.id, opts.baseBuildId, { request }, opts.startedByUserId ?? null);
}

// ------------------------------------------------------------------ versions and documents

interface VersionRow {
  id: string; version_no: number; status: string; manifest_ref: string | null; manifest_sha256: string | null;
  artifact_ref: string | null; artifact_sha256: string | null; approved_at: Date | null; shown_at: Date | null;
}

async function currentVersion(db: Db, projectId: string): Promise<VersionRow | null> {
  return (await db.query(
    `SELECT * FROM scopely.builds WHERE project_id = $1 AND workspace_id = scopely.current_workspace_id()
        AND status NOT IN ('SUPERSEDED','DISCARDED') ORDER BY version_no DESC LIMIT 1`, [projectId])).rows[0] ?? null;
}

/** Edits apply to the newest live version only; anything else means the screen is out of date. */
async function requireCurrent(db: Db, projectId: string, buildId: string): Promise<VersionRow> {
  const cur = await currentVersion(db, projectId);
  if (!cur) throw new SiteError(409, 'This site has not been built yet.');
  if (String(cur.id) !== String(buildId)) throw new SiteError(409, 'A newer version exists. Reload to edit the latest version.');
  return cur;
}

const filesFor = (store: ObjectStore, workspaceId: string, projectId: string) => {
  const prefix = projectPrefix(String(workspaceId), String(projectId));
  return new ProjectFiles(store, prefix, `${prefix}versions/`);
};

async function readDocument(store: ObjectStore, workspaceId: string, projectId: string, v: VersionRow): Promise<{ doc: SiteDocument; template: SiteTemplate }> {
  if (!v.manifest_ref) throw new SiteError(409, 'This version has no editable site.');
  const o = await filesFor(store, workspaceId, projectId).readVerified(v.manifest_ref, v.manifest_sha256);
  const doc = JSON.parse(o.bytes.toString('utf8')) as SiteDocument;
  const template = getTemplate(doc.template.templateKey, doc.template.version);
  assertValidDocument(doc, template);
  return { doc, template };
}

async function imageAssets(db: Db, projectId: string): Promise<ImageAsset[]> {
  const r = await db.query(
    `SELECT id, storage_ref, sha256, description FROM scopely.build_assets
      WHERE project_id = $1 AND kind = 'image' AND withdrawn_at IS NULL AND workspace_id = scopely.current_workspace_id() ORDER BY id`, [projectId]);
  return r.rows.map((a) => ({ assetId: String(a.id), storageRef: a.storage_ref, sha256: a.sha256, description: a.description }));
}

export interface DraftRender { document: SiteDocument; html: string; readiness: ReadinessItem[]; applied: string[] }

/**
 * Step 9 and 10: the live preview of unsaved visual edits. Applies the operations to the current
 * version's document in memory and renders it in editor mode. Nothing is stored.
 */
export async function renderDraft(db: Db, store: ObjectStore, projectId: string,
  opts: { baseBuildId: string; operations: unknown; selected?: string | null }): Promise<DraftRender> {
  const p = await projectRow(db, projectId);
  const base = await requireCurrent(db, p.id, opts.baseBuildId);
  const { doc, template } = await readDocument(store, p.workspace_id, p.id, base);
  const assets = await imageAssets(db, p.id);
  const { document, applied } = applyEdits(doc, opts.operations, { template, origin: 'person', imageAssetIds: new Set(assets.map((a) => a.assetId)) });
  const images = await loadPlacedImages(filesFor(store, p.workspace_id, p.id), assets, document);
  return { document, html: renderSite(document, template, images, { mode: 'editor', selected: opts.selected ?? null }), readiness: readiness(document, template),
    applied: applied.map((op) => describeOperation(op, template)) };
}

/** Writes a person's version of the site and records it as the successor of `base`. */
async function recordPersonVersion(db: Db, store: ObjectStore, p: Awaited<ReturnType<typeof projectRow>>, base: VersionRow,
  doc: SiteDocument, template: SiteTemplate, summary: string, lastEdit: SiteDocument['lastEdit']): Promise<string> {
  const assets = await imageAssets(db, p.id);
  const next: SiteDocument = { ...doc, lastEdit };
  try {
    await assertNoSecrets(db, 'site document', next);
  } catch {
    throw new SiteError(400, 'That looked like a password or key, so nothing was saved. Never put credentials into a site.');
  }
  const files = editFiles(store, String(p.workspace_id), String(p.id));
  const images = await loadPlacedImages(files, assets, next);
  const html = renderSite(next, template, images, { mode: 'artifact' });
  const manifest = await files.write('site.json', Buffer.from(JSON.stringify(next)), 'application/json');
  const preview = await files.write('index.html', Buffer.from(html), 'text/html; charset=utf-8');
  const evidence = (await db.query('SELECT evidence_id AS id FROM scopely.build_evidence WHERE build_id = $1', [base.id])).rows.map((r) => ({ id: String(r.id) }));
  await db.query('SAVEPOINT person_version');
  try {
    const id = await recordBuild(db, { opportunityId: String(p.opportunity_id), catalogItem: { id: String(p.catalog_item_id), key: '', service: '', components: [] },
      buildKind: WEBSITE_KIND, evidence },
      { title: `${next.brand.name} website`.slice(0, 120), summary, artifactRef: preview.key, artifactSha256: preview.sha256,
        manifestRef: manifest.key, manifestSha256: manifest.sha256 },
      { purpose: 'DEMO', generator: `editor:${template.key}@${template.version}`, supersedesBuildId: String(base.id), projectId: String(p.id) });
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query('SET CONSTRAINTS ALL DEFERRED');
    await db.query('RELEASE SAVEPOINT person_version');
    return id;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT person_version');
    await store.removePrefix(files.writablePrefix).catch(() => undefined);
    if (/already has a successor/.test((err as Error).message)) throw new SiteError(409, 'A newer version exists. Reload to edit the latest version.');
    throw err;
  }
}

/** Step 13: saves the visual edits as a new version. The version it edits is never changed. */
export async function saveEdits(db: Db, store: ObjectStore, projectId: string,
  opts: { baseBuildId: string; operations: unknown }): Promise<{ buildId: string }> {
  const p = await projectRow(db, projectId);
  const base = await requireCurrent(db, p.id, opts.baseBuildId);
  const { doc, template } = await readDocument(store, p.workspace_id, p.id, base);
  const assets = await imageAssets(db, p.id);
  const { document, applied } = applyEdits(doc, opts.operations, { template, origin: 'person', imageAssetIds: new Set(assets.map((a) => a.assetId)) });
  if (applied.length === 0) throw new SiteError(400, 'There are no changes to save.');
  const lines = applied.map((op) => describeOperation(op, template));
  const unique = [...new Set(lines)];
  const summary = `Edited: ${unique.join('; ')}`.slice(0, 600);
  return { buildId: await recordPersonVersion(db, store, p, base, document, template, summary, { by: 'person', request: null, applied: unique, needsInput: [] }) };
}

/** Makes an earlier version's site the newest version again. History stays linear; nothing is rewritten. */
export async function restoreVersion(db: Db, store: ObjectStore, projectId: string, opts: { baseBuildId: string; fromBuildId: string }): Promise<{ buildId: string }> {
  const p = await projectRow(db, projectId);
  const base = await requireCurrent(db, p.id, opts.baseBuildId);
  const from = (await db.query(`SELECT * FROM scopely.builds WHERE id = $1 AND project_id = $2 AND workspace_id = scopely.current_workspace_id()`,
    [opts.fromBuildId, p.id])).rows[0] as VersionRow | undefined;
  if (!from) throw new SiteError(404, 'That version does not exist.');
  if (String(from.id) === String(base.id)) throw new SiteError(400, 'That is already the current version.');
  const { doc, template } = await readDocument(store, p.workspace_id, p.id, from);
  return { buildId: await recordPersonVersion(db, store, p, base, doc, template, `Restored version ${from.version_no}`,
    { by: 'person', request: null, applied: [`Restored version ${from.version_no}`], needsInput: [] }) };
}

// ------------------------------------------------------------------ images

/** Adds a photo to the project (step 10, image replacement). Only PNG, JPEG, WebP or GIF, by content. */
export async function uploadImage(db: Db, store: ObjectStore, projectId: string,
  opts: { bytes: Buffer; description: string; recordedBy: string }): Promise<{ assetId: string }> {
  const p = await projectRow(db, projectId);
  const description = String(opts.description ?? '').replace(/\s+/g, ' ').trim();
  if (!description || description.length > 200) throw new SiteError(400, 'Describe the photo in a few words (this becomes its alt text).');
  if (opts.bytes.length === 0 || opts.bytes.length > MAX_IMAGE_BYTES) throw new SiteError(400, 'Photos can be up to 5 MB.');
  const type = imageType(opts.bytes);
  if (!type) throw new SiteError(400, 'Use a PNG, JPEG, WebP or GIF photo.');
  const prefix = projectPrefix(String(p.workspace_id), String(p.id));
  const files = new ProjectFiles(store, prefix, `${prefix}assets/`);
  const stored = await files.write(`${randomUUID()}.${EXT[type]}`, opts.bytes, type);
  const r = await db.query<{ id: string }>(
    `INSERT INTO scopely.build_assets (project_id, kind, storage_ref, sha256, description, provided_by, recorded_by)
     VALUES ($1, 'image', $2, $3, $4, 'seller', $5) RETURNING id`, [p.id, stored.key, stored.sha256, description, opts.recordedBy || 'seller']);
  return { assetId: String(r.rows[0]!.id) };
}

// ------------------------------------------------------------------ approve and show (steps 13 to 14)

const plainBlocker = (b: string | null) => {
  if (!b) return null;
  if (/no confirmed re-check|re-checked as|needs website status/.test(b)) {
    return 'The problem this site answers must be re-checked on a fresh visit to the business\'s site before you show it.';
  }
  if (/needs a recorded human approval/.test(b)) return 'Approve this version first.';
  if (/already shown/.test(b)) return 'This version has already been shown.';
  if (/superseded/.test(b)) return 'A newer version exists.';
  return b;
};

export async function approveVersion(db: Db, projectId: string, buildId: string, opts: { approvedBy: string; at?: string }): Promise<void> {
  const p = await projectRow(db, projectId);
  const approvedBy = String(opts.approvedBy ?? '').trim();
  if (!approvedBy) throw new SiteError(400, 'Say who is approving.');
  const b = (await db.query(`SELECT scopely.build_approve_blocker(id) AS blocker FROM scopely.builds WHERE id = $1 AND project_id = $2 AND workspace_id = scopely.current_workspace_id()`,
    [buildId, p.id])).rows[0];
  if (!b) throw new SiteError(404, 'That version does not exist.');
  if (b.blocker) throw new SiteError(409, `This version cannot be approved: ${b.blocker}.`);
  await approveBuild(db, buildId, approvedBy.slice(0, 120), opts.at ?? new Date().toISOString());
}

export async function showVersion(db: Db, projectId: string, buildId: string, opts: { at?: string } = {}): Promise<void> {
  const p = await projectRow(db, projectId);
  const at = opts.at ?? new Date().toISOString();
  const b = (await db.query(`SELECT scopely.build_show_blocker(id, $3::timestamptz) AS blocker FROM scopely.builds WHERE id = $1 AND project_id = $2 AND workspace_id = scopely.current_workspace_id()`,
    [buildId, p.id, at])).rows[0];
  if (!b) throw new SiteError(404, 'That version does not exist.');
  if (b.blocker) throw new SiteError(409, plainBlocker(b.blocker)!);
  await markBuildShown(db, buildId, at);
}

/** A signed, expiring link to one version's stored preview. `show` links open only a shown version. */
export async function previewLink(db: Db, projectId: string, buildId: string,
  opts: { kind: 'edit' | 'show'; signingKey: string; ttlSeconds: number; nowSeconds?: number }): Promise<{ token: string; expiresAt: string }> {
  const p = await projectRow(db, projectId);
  const b = (await db.query(`SELECT id, shown_at, artifact_ref FROM scopely.builds WHERE id = $1 AND project_id = $2 AND workspace_id = scopely.current_workspace_id()`,
    [buildId, p.id])).rows[0];
  if (!b || !b.artifact_ref) throw new SiteError(404, 'That version has no preview.');
  if (opts.kind === 'show' && !b.shown_at) throw new SiteError(409, 'Only a version you have approved and shown can be shared.');
  const e = (opts.nowSeconds ?? Math.floor(Date.now() / 1000)) + opts.ttlSeconds;
  const claims: PreviewClaims = { w: String(await requireWorkspace(db)), p: String(p.id), b: String(b.id), k: opts.kind, e };
  return { token: signPreview(opts.signingKey, claims), expiresAt: new Date(e * 1000).toISOString() };
}

// ------------------------------------------------------------------ the workspace screen

export interface SiteWorkspace {
  project: BuildProjectView;
  /** The version being edited: the newest live one. */
  current: {
    buildId: string; versionNo: number; status: string; document: SiteDocument; readiness: ReadinessItem[];
    html: string; approveBlocker: string | null; showBlocker: string | null; artifactSha256: string | null;
  } | null;
  template: SiteTemplate;
  images: { assetId: string; description: string; dataUrl: string }[];
}

/** Everything the Build Workspace screen needs, with no storage key, hash or credential it would have to understand. */
export async function getSiteWorkspace(db: Db, store: ObjectStore, projectId: string, opts: { selected?: string | null } = {}): Promise<SiteWorkspace> {
  const p = await projectRow(db, projectId);
  const project = (await getBuildProject(db, p.id))!;
  const cur = await currentVersion(db, p.id);
  const assets = await imageAssets(db, p.id);
  const files = filesFor(store, p.workspace_id, p.id);
  const images: SiteWorkspace['images'] = [];
  for (const a of assets) {
    try {
      const o = await files.readVerified(a.storageRef, a.sha256);
      const t = imageType(o.bytes);
      if (t) images.push({ assetId: a.assetId, description: a.description, dataUrl: `data:${t};base64,${o.bytes.toString('base64')}` });
    } catch { /* an image that fails its hash is not offered */ }
  }
  if (!cur) return { project, current: null, template: MERIDIAN, images };
  const { doc, template } = await readDocument(store, p.workspace_id, p.id, cur);
  const html = renderSite(doc, template, await loadPlacedImages(files, assets, doc), { mode: 'editor', selected: opts.selected ?? null });
  const v = project.versions.find((x) => x.buildId === String(cur.id))!;
  return {
    project,
    current: { buildId: String(cur.id), versionNo: cur.version_no, status: cur.status, document: doc, readiness: readiness(doc, template), html,
      approveBlocker: v.gate.approveBlocker, showBlocker: plainBlocker(v.gate.showBlocker), artifactSha256: cur.artifact_sha256 },
    template, images,
  };
}

/** Re-renders a stored version from its document and checks the result is byte-identical to its artifact. */
export async function verifyVersionArtifact(db: Db, store: ObjectStore, projectId: string, buildId: string): Promise<boolean> {
  const p = await projectRow(db, projectId);
  const v = (await db.query(`SELECT * FROM scopely.builds WHERE id = $1 AND project_id = $2 AND workspace_id = scopely.current_workspace_id()`, [buildId, p.id])).rows[0] as VersionRow | undefined;
  if (!v || !v.artifact_ref) return false;
  const files = filesFor(store, p.workspace_id, p.id);
  const artifact = await files.readVerified(v.artifact_ref, v.artifact_sha256);
  const { doc, template } = await readDocument(store, p.workspace_id, p.id, v);
  const html = renderSite(doc, template, await loadPlacedImages(files, await imageAssets(db, p.id), doc), { mode: 'artifact' });
  return sha256(html) === sha256(artifact.bytes);
}
