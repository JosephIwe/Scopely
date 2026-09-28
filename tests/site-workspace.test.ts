// Slice 5: the template-first Build Workspace for the website kind. An opportunity becomes a
// generated, previewable, editable site through PR4's projects, runs and versions; edits are
// validated operations that make new versions; approved and shown versions never change; and no
// workspace can reach another's projects, versions or artifacts.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { getBuildProject, getBuildRun } from '../src/api/queries.js';
import { BuildAgentRegistry, BuilderRegistry, executeBuildRun, queueBuildRun } from '../src/build/index.js';
import {
  ARTIFACT_HEADERS, type EditInterpreter, EditRejected, RuleBasedEditInterpreter, ScopelySiteAgent, SiteError, type SiteDocument,
  approveVersion, generateSite, getBuildSetup, getSiteWorkspace, loadPreviewArtifact, openWebsiteProject, previewLink, renderDraft,
  requestAiEdit, restoreVersion, saveEdits, showVersion, uploadImage, verifyPreview, verifyVersionArtifact, websiteBuilder,
} from '../src/build/site/index.js';
import { MemoryObjectStore, ProjectFiles, projectPrefix, sha256 } from '../src/storage/index.js';
import { asApp, enterNewWorkspace, failure, one, useDb, useWorkspace } from './helpers.js';
import { PNG, SIGNING_KEY, confirmRecheck, seedWebsiteOpportunity } from './site-helpers.js';

const { db } = useDb();
const ws = async (d: pg.Client) => (await one<{ ws: string }>(d, 'SELECT scopely.current_workspace_id()::text AS ws')).ws;

async function built(d: pg.Client, store = new MemoryObjectStore(), opts: { reviews?: boolean } = {}) {
  const seed = await seedWebsiteOpportunity(d, opts);
  const projectId = await openWebsiteProject(d, seed.opportunityId);
  const run = await generateSite(d, { store }, projectId, { templateKey: 'meridian' });
  expect(run).toMatchObject({ status: 'SUCCEEDED', errorCode: null });
  return { seed, projectId, store, buildId: run.buildId!, runId: run.runId, workspaceId: await ws(d) };
}

async function doc(d: pg.Client, store: MemoryObjectStore, projectId: string): Promise<SiteDocument> {
  return (await getSiteWorkspace(d, store, projectId)).current!.document;
}

async function artifactHtml(d: pg.Client, store: MemoryObjectStore, buildId: string): Promise<string> {
  const b = await one<{ artifact_ref: string }>(d, 'SELECT artifact_ref FROM builds WHERE id = $1', [buildId]);
  return store.objects.get(b.artifact_ref)!.bytes.toString('utf8');
}

// ================================================================== A-C: creation, template, context

describe('opening a website build from an opportunity', () => {
  it('opens one website project per opportunity and reuses it', async () => {
    const seed = await seedWebsiteOpportunity(db());
    const p1 = await openWebsiteProject(db(), seed.opportunityId);
    expect(await openWebsiteProject(db(), seed.opportunityId)).toBe(p1);
    expect(await one(db(), 'SELECT build_kind, opportunity_id FROM build_projects WHERE id = $1', [p1]))
      .toEqual({ build_kind: 'website', opportunity_id: seed.opportunityId });
  });

  it('refuses an opportunity whose service is not a website', async () => {
    const { seedChain, seedOpportunity } = await import('./helpers.js');
    const c = await seedChain(db());
    const fix = await seedOpportunity(db(), c);
    await expect(openWebsiteProject(db(), fix)).rejects.toThrow(/not mapped to a website service/);
  });

  it('shows the build type, the one template and what will and will not be used, before building', async () => {
    const seed = await seedWebsiteOpportunity(db(), { reviews: true });
    const projectId = await openWebsiteProject(db(), seed.opportunityId);
    const setup = await getBuildSetup(db(), projectId);
    expect(setup.buildType.key).toBe('website');
    expect(setup.templates.map((t) => t.key)).toEqual(['meridian']);
    expect(setup.basis.problem).toHaveLength(1);
    expect(setup.basis.problem[0]).toMatchObject({ evidenceId: seed.evidenceId, issueCode: 'E-LINK-TARGET-MISMATCH', claimState: 'OBSERVED' });
    expect(setup.basis.addresses[0]!.evidenceIds).toEqual([seed.evidenceId]);
    expect(setup.basis.usedFacts.map((f) => f.attribute)).toEqual(['business name', 'review rating and count']);
    const notUsed = setup.basis.notUsed.map((n) => n.what);
    expect(notUsed).toEqual(expect.arrayContaining(['address', 'phone', 'city', 'industry', 'revenue', 'Where the booking button leads']));
    expect(setup.hasVersions).toBe(false);
  });
});

// ================================================================== D-G: generation, truth, artifact

describe('generating the site', () => {
  it('builds version 1 as a DRAFT through a build run, with a stored document and preview whose hashes are recorded', async () => {
    const { projectId, buildId, runId, store, workspaceId, seed } = await built(db());
    const run = await getBuildRun(db(), runId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', producedBuildId: buildId, agent: { key: 'scopely_site', version: '1' }, providerConnection: null });
    const b = await one<Record<string, any>>(db(), 'SELECT * FROM builds WHERE id = $1', [buildId]);
    expect(b).toMatchObject({ status: 'DRAFT', purpose: 'DEMO', version_no: 1, generator: 'agent:scopely_site:1', approved_at: null });
    const prefix = `${projectPrefix(workspaceId, projectId)}versions/run-${runId}/`;
    expect(b.manifest_ref).toBe(`${prefix}site.json`);
    expect(b.artifact_ref).toBe(`${prefix}index.html`);
    expect(sha256(store.objects.get(b.artifact_ref)!.bytes)).toBe(b.artifact_sha256);
    expect(sha256(store.objects.get(b.manifest_ref)!.bytes)).toBe(b.manifest_sha256);
    expect((await db().query('SELECT evidence_id FROM build_evidence WHERE build_id = $1', [buildId])).rows).toEqual([{ evidence_id: seed.evidenceId }]);
  });

  it('meters nothing: a deterministic build calls no model and records no cost or credits', async () => {
    const { projectId, runId } = await built(db());
    expect((await db().query('SELECT count(*)::int AS n FROM cost_events WHERE build_run_id = $1', [runId])).rows[0].n).toBe(0);
    expect((await getBuildProject(db(), projectId))!.cost).toEqual([]);
  });

  it('states only the business name and sourced facts; withheld, private and unobservable facts never reach the site', async () => {
    const { projectId, buildId, store } = await built(db(), new MemoryObjectStore(), { reviews: true });
    const html = await artifactHtml(db(), store, buildId);
    expect(html).toContain('Example Clinic');
    for (const hidden of ['7946', 'Hidden Street', 'ZZ1', 'London', 'aesthetics', '950', 'GB']) expect(html).not.toContain(hidden);
    expect(html).not.toMatch(/booking/i);
    // The review rating is shown with its source and date, from the fact.
    expect(html).toContain('>4.8<');
    expect(html).not.toContain('4.80');
    expect(html).toMatch(/From 132 reviews on Google as of Sep 2026/);
    const d = await doc(db(), store, projectId);
    expect(d.provenance['proof.rating']).toBe('fact');
    // Services and the button destination could not be observed, so they are left for a person.
    expect(d.cta.action).toEqual({ kind: 'unset' });
    expect(d.sections.find((s: { type: string }) => s.type === 'services')!.content.items).toEqual([]);
  });

  it('hides the reviews section when there is no sourced review data and refuses to show it', async () => {
    const { projectId, buildId, store } = await built(db());
    const d = await doc(db(), store, projectId);
    expect(d.sections.find((s: { type: string }) => s.type === 'proof')!.visible).toBe(false);
    await expect(renderDraft(db(), store, projectId, { baseBuildId: buildId, operations: [{ op: 'show_section', section: 'proof' }] }))
      .rejects.toThrow(/no sourced review data/);
  });

  it('renders deterministically: re-rendering the stored document gives the stored artifact byte for byte', async () => {
    const { projectId, buildId, store } = await built(db());
    expect(await verifyVersionArtifact(db(), store, projectId, buildId)).toBe(true);
  });

  it('never serves or edits from an artifact or document whose bytes no longer match the recorded hash', async () => {
    const { projectId, buildId, store, workspaceId } = await built(db());
    const b = await one<{ artifact_ref: string; manifest_ref: string }>(db(), 'SELECT artifact_ref, manifest_ref FROM builds WHERE id = $1', [buildId]);
    const token = (await previewLink(db(), projectId, buildId, { kind: 'edit', signingKey: SIGNING_KEY, ttlSeconds: 60 })).token;
    const claims = verifyPreview(SIGNING_KEY, token, Math.floor(Date.now() / 1000))!;
    expect(await loadPreviewArtifact(db(), store, claims)).not.toBeNull();
    store.objects.get(b.artifact_ref)!.bytes.write('X', 0);
    expect(await loadPreviewArtifact(db(), store, claims)).toBeNull();
    store.objects.get(b.manifest_ref)!.bytes.write('X', 0);
    await expect(getSiteWorkspace(db(), store, projectId)).rejects.toThrow(/does not match its recorded hash/);
    await useWorkspace(db(), workspaceId);
  });

  it('fails the run and keeps nothing when the agent fails: no version, no stored files, an error code on the run', async () => {
    const seed = await seedWebsiteOpportunity(db());
    const projectId = await openWebsiteProject(db(), seed.opportunityId);
    const store = new MemoryObjectStore();
    const r = await generateSite(db(), { store }, projectId, { templateKey: 'no-such-template' });
    expect(r).toMatchObject({ status: 'FAILED', buildId: null, errorCode: 'TEMPLATE_NOT_FOUND' });
    expect(r.message).toMatch(/template is not available/);
    expect((await db().query('SELECT count(*)::int AS n FROM builds WHERE project_id = $1', [projectId])).rows[0].n).toBe(0);
    expect(store.objects.size).toBe(0);
    // An agent that writes files and then fails leaves nothing behind either.
    const agents = new BuildAgentRegistry();
    agents.register({ key: 'scopely_site', version: '1', modelUse: 'NONE', run: async (task) => {
      await task.project.files!.write('index.html', Buffer.from('<p>half</p>'), 'text/html');
      throw new Error('boom');
    } });
    const builders = new BuilderRegistry();
    builders.register(websiteBuilder);
    const runId = await queueBuildRun(db(), { projectId, purpose: 'DEMO', agentKey: 'scopely_site', meta: { template: 'meridian' } });
    expect(await executeBuildRun(db(), { builders, agents, storage: store }, runId)).toMatchObject({ status: 'FAILED', errorCode: 'AGENT_ERROR' });
    expect(store.objects.size).toBe(0);
  });

  it('refuses a stored result whose hash does not match, or that lies outside the run\'s own prefix', async () => {
    const seed = await seedWebsiteOpportunity(db());
    const projectId = await openWebsiteProject(db(), seed.opportunityId);
    const store = new MemoryObjectStore();
    const builders = new BuilderRegistry();
    builders.register(websiteBuilder);
    const lying = (mode: 'hash' | 'outside') => {
      const agents = new BuildAgentRegistry();
      agents.register({ key: 'scopely_site', version: '1', modelUse: 'NONE', run: async (task) => {
        const m = await task.project.files!.write('site.json', Buffer.from('{}'), 'application/json');
        return { title: 't', summary: 's', usage: [],
          manifestRef: mode === 'outside' ? `${task.project.storagePrefix}versions/other/site.json` : m.key,
          manifestSha256: mode === 'hash' ? 'f'.repeat(64) : m.sha256 };
      } });
      return agents;
    };
    for (const [mode, code] of [['hash', 'ARTIFACT_UNVERIFIED'], ['outside', 'ARTIFACT_OUTSIDE_RUN']] as const) {
      const runId = await queueBuildRun(db(), { projectId, purpose: 'DEMO', agentKey: 'scopely_site' });
      expect(await executeBuildRun(db(), { builders, agents: lying(mode), storage: store }, runId)).toMatchObject({ status: 'FAILED', errorCode: code });
    }
  });
});

// ================================================================== H-J: visual edits, AI edits, versions

describe('editing makes new versions', () => {
  it('previews unsaved visual edits without storing anything, then saves them as version 2', async () => {
    const { projectId, buildId, store } = await built(db());
    const before = store.objects.size;
    const ops = [
      { op: 'update_text', section: 'hero', slot: 'eyebrow', value: 'Skin and aesthetics clinic' },
      { op: 'update_items', section: 'services', slot: 'items', items: [{ title: 'Consultations', text: 'A first conversation about what you want.' }] },
      { op: 'update_cta', label: 'Book a consultation', action: { kind: 'whatsapp', value: '+44 7700 900123' } },
      { op: 'change_color', palette: 'evergreen' },
      { op: 'hide_section', section: 'about' },
      { op: 'move_section', section: 'contact', direction: 'up' },
    ];
    const draft = await renderDraft(db(), store, projectId, { baseBuildId: buildId, operations: ops, selected: 'services' });
    expect(draft.html).toContain('Consultations');
    expect(draft.html).toContain('href="https://wa.me/447700900123"');
    expect(draft.html).toContain('data-selected');
    expect(draft.readiness.map((r: { section: string }) => r.section)).not.toContain('cta');
    expect(store.objects.size).toBe(before);
    expect((await db().query('SELECT count(*)::int AS n FROM builds WHERE project_id = $1', [projectId])).rows[0].n).toBe(1);

    const { buildId: v2 } = await saveEdits(db(), store, projectId, { baseBuildId: buildId, operations: ops });
    const rows = (await db().query('SELECT id, version_no, status, supersedes_build_id, generator FROM builds WHERE project_id = $1 ORDER BY version_no', [projectId])).rows;
    expect(rows).toEqual([
      { id: buildId, version_no: 1, status: 'SUPERSEDED', supersedes_build_id: null, generator: 'agent:scopely_site:1' },
      { id: v2, version_no: 2, status: 'DRAFT', supersedes_build_id: buildId, generator: 'editor:meridian@1' },
    ]);
    const d = await doc(db(), store, projectId);
    expect(d.provenance['hero.eyebrow']).toBe('person');
    expect(d.lastEdit.by).toBe('person');
    expect(d.basis.problem[0]!.issueCode).toBe('E-LINK-TARGET-MISMATCH'); // the BEFORE travels with every version
    expect(d.sections.map((s: { type: string }) => s.type)).toEqual(['hero', 'services', 'about', 'proof', 'contact', 'gallery', 'footer']);
    expect(await verifyVersionArtifact(db(), store, projectId, v2)).toBe(true);
    // Version 1's files are untouched.
    expect(await verifyVersionArtifact(db(), store, projectId, buildId)).toBe(true);
  });

  it('refuses edits against a version that is no longer the newest', async () => {
    const { projectId, buildId, store } = await built(db());
    await saveEdits(db(), store, projectId, { baseBuildId: buildId, operations: [{ op: 'change_font', fonts: 'classic' }] });
    await expect(saveEdits(db(), store, projectId, { baseBuildId: buildId, operations: [{ op: 'change_font', fonts: 'modern' }] }))
      .rejects.toThrow(/newer version exists/);
  });

  it('applies a controlled AI edit as a run that produces the successor version', async () => {
    const { projectId, buildId, store } = await built(db());
    const r = await requestAiEdit(db(), { store }, projectId, { baseBuildId: buildId, request: 'Make the hero feel more premium and change the CTA to WhatsApp.' });
    expect(r).toMatchObject({ status: 'SUCCEEDED', errorCode: null });
    const run = await getBuildRun(db(), r.runId);
    expect(run).toMatchObject({ baseBuildId: buildId, producedBuildId: r.buildId });
    const d = await doc(db(), store, projectId);
    expect(d.theme).toEqual({ palette: 'graphite', fonts: 'editorial', accent: null });
    expect(d.sections[0]!.variant).toBe('centered');
    expect(d.cta).toEqual({ label: 'Message us on WhatsApp', action: { kind: 'unset' } });
    // It could not know the number, so it asks rather than inventing one.
    expect(d.lastEdit.needsInput).toEqual([expect.stringMatching(/Which WhatsApp number/)]);
    expect(d.lastEdit).toMatchObject({ by: 'ai', request: 'Make the hero feel more premium and change the CTA to WhatsApp.' });
    expect(d.provenance.cta).toBe('ai');
    expect((await one<{ status: string }>(db(), 'SELECT status FROM builds WHERE id = $1', [buildId])).status).toBe('SUPERSEDED');
  });

  it('uses a contact target only when the person wrote it in the request', async () => {
    const { projectId, buildId, store } = await built(db());
    const r = await requestAiEdit(db(), { store }, projectId, { baseBuildId: buildId, request: 'Change the button to WhatsApp +44 7700 900456' });
    expect(r.status).toBe('SUCCEEDED');
    expect((await doc(db(), store, projectId)).cta.action).toEqual({ kind: 'whatsapp', value: '447700900456' });
  });

  it('fails an AI edit it cannot understand, with a plain message and no new version', async () => {
    const { projectId, buildId, store } = await built(db());
    const r = await requestAiEdit(db(), { store }, projectId, { baseBuildId: buildId, request: 'Please sort out the vibes somehow' });
    expect(r).toMatchObject({ status: 'FAILED', errorCode: 'EDIT_NOT_UNDERSTOOD', buildId: null });
    expect((await one<{ status: string }>(db(), 'SELECT status FROM builds WHERE id = $1', [buildId])).status).toBe('DRAFT');
  });

  it('restores an earlier version as a new version, keeping history linear', async () => {
    const { projectId, buildId, store } = await built(db());
    const { buildId: v2 } = await saveEdits(db(), store, projectId, { baseBuildId: buildId, operations: [{ op: 'change_color', palette: 'clay' }] });
    const { buildId: v3 } = await restoreVersion(db(), store, projectId, { baseBuildId: v2, fromBuildId: buildId });
    expect((await one<{ version_no: number; supersedes_build_id: string }>(db(), 'SELECT version_no, supersedes_build_id FROM builds WHERE id = $1', [v3])))
      .toEqual({ version_no: 3, supersedes_build_id: v2 });
    expect((await doc(db(), store, projectId)).theme.palette).toBe('harbor');
  });

  it('replaces images only with this project\'s verified uploads', async () => {
    const { projectId, buildId, store } = await built(db());
    const { assetId } = await uploadImage(db(), store, projectId, { bytes: PNG, description: 'Treatment room', recordedBy: 'seller' });
    const d = await renderDraft(db(), store, projectId, { baseBuildId: buildId, operations: [{ op: 'replace_image', section: 'hero', slot: 'image', assetId }] });
    expect(d.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}" alt="Treatment room"`);
    await expect(uploadImage(db(), store, projectId, { bytes: Buffer.from('<svg onload="alert(1)"/>'), description: 'x', recordedBy: 'seller' }))
      .rejects.toThrow(/PNG, JPEG, WebP or GIF/);
    await expect(renderDraft(db(), store, projectId, { baseBuildId: buildId, operations: [{ op: 'replace_image', section: 'hero', slot: 'image', assetId: '999999' }] }))
      .rejects.toThrow(/not one of this project's images/);
  });
});

// ================================================================== K: approve and show

describe('approval and showing', () => {
  it('approves a version, refuses to show it until the evidence is re-checked, then shows it', async () => {
    const { projectId, buildId, store, seed } = await built(db());
    await expect(showVersion(db(), projectId, buildId, { at: '2026-10-01T12:00:00Z' })).rejects.toThrow(/Approve this version first/);
    await approveVersion(db(), projectId, buildId, { approvedBy: 'seller', at: '2026-10-01T10:00:00Z' });
    await expect(showVersion(db(), projectId, buildId, { at: '2026-10-01T12:00:00Z' })).rejects.toThrow(/must be re-checked/);
    await confirmRecheck(db(), seed);
    await showVersion(db(), projectId, buildId, { at: '2026-10-01T12:00:00Z' });
    expect(await one(db(), 'SELECT status FROM builds WHERE id = $1', [buildId])).toEqual({ status: 'SHOWN' });
    expect((await getSiteWorkspace(db(), store, projectId)).current!.status).toBe('SHOWN');
  });

  it('never changes an approved or shown version: its files are write-once and the database refuses a new artifact', async () => {
    const { projectId, buildId, store, seed } = await built(db());
    await approveVersion(db(), projectId, buildId, { approvedBy: 'seller', at: '2026-10-01T10:00:00Z' });
    expect(await failure(db(), `UPDATE builds SET artifact_sha256 = $2 WHERE id = $1`, [buildId, 'a'.repeat(64)])).toMatch(/approved content changed/);
    const b = await one<{ artifact_ref: string }>(db(), 'SELECT artifact_ref FROM builds WHERE id = $1', [buildId]);
    await expect(store.put(b.artifact_ref, Buffer.from('changed'), 'text/html')).rejects.toThrow(/write-once/);
    await confirmRecheck(db(), seed);
    await showVersion(db(), projectId, buildId, { at: '2026-10-01T12:00:00Z' });
    expect(await failure(db(), `UPDATE builds SET manifest_sha256 = $2 WHERE id = $1`, [buildId, 'b'.repeat(64)])).toMatch(/shown build cannot change/);
    // Editing a shown version makes version 2 and leaves version 1 as it was shown.
    const { buildId: v2 } = await saveEdits(db(), store, projectId, { baseBuildId: buildId, operations: [{ op: 'change_font', fonts: 'editorial' }] });
    expect((await db().query('SELECT id, status, shown_at IS NOT NULL AS shown FROM builds WHERE project_id = $1 ORDER BY version_no', [projectId])).rows)
      .toEqual([{ id: buildId, status: 'SUPERSEDED', shown: true }, { id: v2, status: 'DRAFT', shown: false }]);
    expect(await verifyVersionArtifact(db(), store, projectId, buildId)).toBe(true);
  });

  it('keeps approval and showing with a person: the site agent cannot approve or show', async () => {
    const { projectId, buildId } = await built(db());
    await db().query('SAVEPOINT agent');
    await db().query(`SELECT set_config('scopely.actor_kind', 'build_agent', true)`);
    const err = await approveVersion(db(), projectId, buildId, { approvedBy: 'agent' }).then(() => null, (e: Error) => e.message);
    await db().query('ROLLBACK TO SAVEPOINT agent');
    expect(err)
      .toMatch(/build agent cannot approve/);
  });

  it('issues share links only for a shown version, and edit links that expire', async () => {
    const { projectId, buildId } = await built(db());
    await expect(previewLink(db(), projectId, buildId, { kind: 'show', signingKey: SIGNING_KEY, ttlSeconds: 60 })).rejects.toThrow(/approved and shown/);
    const { token } = await previewLink(db(), projectId, buildId, { kind: 'edit', signingKey: SIGNING_KEY, ttlSeconds: 60, nowSeconds: 1000 });
    expect(verifyPreview(SIGNING_KEY, token, 1059)).not.toBeNull();
    expect(verifyPreview(SIGNING_KEY, token, 1061)).toBeNull();
    expect(verifyPreview('another-signing-key-0123456789abcdefgh', token, 1000)).toBeNull();
  });
});

// ================================================================== L, M: isolation and secrets

describe('workspace isolation', () => {
  it('gives another workspace nothing: projects, setup, versions, drafts, edits, images and approvals all read as missing', async () => {
    const a = await built(db());
    await enterNewWorkspace(db(), 'other');
    const store = a.store;
    const missing = /does not exist/;
    await expect(openWebsiteProject(db(), a.seed.opportunityId)).rejects.toThrow(missing);
    await expect(getBuildSetup(db(), a.projectId)).rejects.toThrow(missing);
    await expect(getSiteWorkspace(db(), store, a.projectId)).rejects.toThrow(missing);
    await expect(renderDraft(db(), store, a.projectId, { baseBuildId: a.buildId, operations: [] })).rejects.toThrow(missing);
    await expect(saveEdits(db(), store, a.projectId, { baseBuildId: a.buildId, operations: [{ op: 'change_font', fonts: 'classic' }] })).rejects.toThrow(missing);
    await expect(requestAiEdit(db(), { store }, a.projectId, { baseBuildId: a.buildId, request: 'make it premium' })).rejects.toThrow(missing);
    await expect(uploadImage(db(), store, a.projectId, { bytes: PNG, description: 'x', recordedBy: 'x' })).rejects.toThrow(missing);
    await expect(approveVersion(db(), a.projectId, a.buildId, { approvedBy: 'x' })).rejects.toThrow(missing);
    await expect(previewLink(db(), a.projectId, a.buildId, { kind: 'edit', signingKey: SIGNING_KEY, ttlSeconds: 60 })).rejects.toThrow(missing);
    expect(await getBuildProject(db(), a.projectId)).toBeNull();
    // Row-level security as the application role sees none of A's rows either.
    const b = await ws(db());
    await asApp(db(), b, async () => {
      for (const t of ['build_projects', 'build_runs', 'build_assets']) {
        expect((await db().query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      }
    });
  });

  it('serves a preview only inside the workspace the link was signed for; a forged or re-pointed link gets nothing', async () => {
    const a = await built(db());
    const { token } = await previewLink(db(), a.projectId, a.buildId, { kind: 'edit', signingKey: SIGNING_KEY, ttlSeconds: 600 });
    const now = Math.floor(Date.now() / 1000);
    const claims = verifyPreview(SIGNING_KEY, token, now)!;
    expect((await loadPreviewArtifact(db(), a.store, claims))!.html.toString()).toContain('Example Clinic');
    const other = await enterNewWorkspace(db(), 'other');
    // Changing the workspace in the token breaks the signature.
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), w: other })).toString('base64url');
    expect(verifyPreview(SIGNING_KEY, `${forged}.${sig}`, now)).toBeNull();
    // A validly signed link that names another workspace's version finds nothing.
    expect(await loadPreviewArtifact(db(), a.store, { ...claims, w: other })).toBeNull();
    // A version of another project in the same workspace is not reachable through this project's link.
    await useWorkspace(db(), a.workspaceId);
    const b = await built(db(), a.store);
    expect(await loadPreviewArtifact(db(), a.store, { ...claims, b: b.buildId })).toBeNull();
    expect(await loadPreviewArtifact(db(), a.store, { ...claims, k: 'show' })).toBeNull();
  });

  it('keeps every storage handle inside its own project', async () => {
    const store = new MemoryObjectStore();
    const mine = new ProjectFiles(store, 'workspaces/1/projects/2/', 'workspaces/1/projects/2/versions/edit-x/');
    await expect(mine.read('workspaces/9/projects/2/versions/a/index.html')).rejects.toThrow(/outside this project/);
    await expect(mine.read('workspaces/1/projects/3/versions/a/index.html')).rejects.toThrow(/outside this project/);
    await expect(mine.read('workspaces/1/projects/2/versions/../../3/x')).rejects.toThrow(/not a project storage key/);
    await expect(mine.write('../../assets/x', Buffer.from(''), 'text/plain')).rejects.toThrow(/not a project storage key/);
    expect(() => new ProjectFiles(store, 'workspaces/1/projects/2/', 'workspaces/1/projects/3/')).toThrow(/inside its own project/);
  });

  it('refuses a version whose stored artifact lies outside its own project, or has no hash (migration 010)', async () => {
    const a = await built(db());
    const other = `workspaces/${a.workspaceId}/projects/${Number(a.projectId) + 1000}/versions/x/index.html`;
    expect(await failure(db(), `UPDATE builds SET artifact_ref = $2 WHERE id = $1`, [a.buildId, other])).toMatch(/outside this project's storage/);
    expect(await failure(db(), `UPDATE builds SET artifact_ref = $2, artifact_sha256 = NULL WHERE id = $1`,
      [a.buildId, `workspaces/${a.workspaceId}/projects/${a.projectId}/versions/y/index.html`])).toMatch(/needs its sha256/);
    expect(await failure(db(), `UPDATE builds SET artifact_ref = $2 WHERE id = $1`,
      [a.buildId, `workspaces/${a.workspaceId}/projects/${a.projectId}/assets/x.html`])).toMatch(/outside this project's storage/);
  });
});

describe('secrets never reach a build', () => {
  it('refuses a credential typed into the site and stores nothing', async () => {
    const { projectId, buildId, store } = await built(db());
    const before = store.objects.size;
    await expect(saveEdits(db(), store, projectId, { baseBuildId: buildId,
      operations: [{ op: 'update_text', section: 'about', slot: 'body', value: 'our key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }] }))
      .rejects.toThrow(/looked like a password or key/);
    expect(store.objects.size).toBe(before);
  });

  it('refuses a credential in an AI edit request before any run starts', async () => {
    const { projectId, buildId, store } = await built(db());
    await expect(requestAiEdit(db(), { store }, projectId, { baseBuildId: buildId, request: 'use key ghp_abcdefghijklmnopqrstuvwxyz0123 for the button' }))
      .rejects.toThrow(SiteError);
    expect((await db().query('SELECT count(*)::int AS n FROM build_runs WHERE project_id = $1', [projectId])).rows[0].n).toBe(1);
  });

  it('puts no credential, environment secret or storage internals into the document, the artifact or the workspace view', async () => {
    process.env.SCOPELY_TEST_SECRET = 'sk-live-should-never-appear-0123456789';
    const { projectId, buildId, store } = await built(db());
    const view = JSON.stringify(await getSiteWorkspace(db(), store, projectId));
    const html = await artifactHtml(db(), store, buildId);
    for (const out of [view, html]) {
      expect(out).not.toContain(process.env.SCOPELY_TEST_SECRET);
      expect(out).not.toMatch(/secretref:|credential_ref|PREVIEW_SIGNING_KEY|DATABASE_URL/);
    }
    for (const out of [view, html]) {
      expect((await one<{ s: boolean }>(db(), 'SELECT scopely.looks_like_secret($1) AS s', [out])).s).toBe(false);
    }
    delete process.env.SCOPELY_TEST_SECRET;
  });
});

// ================================================================== N: the whole loop

describe('the full loop, and another workspace', () => {
  it('opportunity → build → template → generated site → visual edit → AI edit → new version → approve → show, and B sees none of it', async () => {
    const store = new MemoryObjectStore();
    const workspaceA = await ws(db());
    const seed = await seedWebsiteOpportunity(db(), { reviews: true });
    const projectId = await openWebsiteProject(db(), seed.opportunityId);
    const setup = await getBuildSetup(db(), projectId);
    expect(setup.templates[0]!.name).toBe('Meridian');
    const gen = await generateSite(db(), { store }, projectId, { templateKey: 'meridian' });
    let current = gen.buildId!;
    const visual = await saveEdits(db(), store, projectId, { baseBuildId: current, operations: [
      { op: 'update_items', section: 'services', slot: 'items', items: [{ title: 'Facials', text: '' }, { title: 'Skin consultations', text: '' }] },
      { op: 'update_text', section: 'about', slot: 'body', value: 'A small, independent clinic.' },
      { op: 'update_cta', action: { kind: 'whatsapp', value: '447700900123' } },
    ] });
    current = visual.buildId;
    const ai = await requestAiEdit(db(), { store }, projectId, { baseBuildId: current, request: 'Make the hero feel more premium and change the CTA to WhatsApp.' });
    expect(ai.status).toBe('SUCCEEDED');
    current = ai.buildId!;
    const d = await doc(db(), store, projectId);
    expect(d.cta).toEqual({ label: 'Message us on WhatsApp', action: { kind: 'whatsapp', value: '447700900123' } }); // kept the number the person gave
    expect(d.lastEdit.needsInput).toEqual([]);
    await approveVersion(db(), projectId, current, { approvedBy: 'seller', at: '2026-10-01T10:00:00Z' });
    await confirmRecheck(db(), seed);
    await showVersion(db(), projectId, current, { at: '2026-10-01T12:00:00Z' });
    const view = await getSiteWorkspace(db(), store, projectId);
    expect(view.project.versions.map((v: { versionNo: number; status: string }) => [v.versionNo, v.status])).toEqual([[1, 'SUPERSEDED'], [2, 'SUPERSEDED'], [3, 'SHOWN']]);
    expect(view.current!.document.basis.problem[0]!.plainIssue).toBe('WhatsApp label opens a phone call');
    const { token } = await previewLink(db(), projectId, current, { kind: 'show', signingKey: SIGNING_KEY, ttlSeconds: 3600 });
    const claims = verifyPreview(SIGNING_KEY, token, Math.floor(Date.now() / 1000))!;
    const served = (await loadPreviewArtifact(db(), store, claims))!.html.toString();
    expect(served).toContain('Facials');
    expect(served).toContain('https://wa.me/447700900123');
    expect(served).not.toMatch(/<script/i);
    expect(ARTIFACT_HEADERS['content-security-policy']).toMatch(/default-src 'none'.*sandbox/);

    await enterNewWorkspace(db(), 'b');
    expect(await getBuildProject(db(), projectId)).toBeNull();
    await expect(getSiteWorkspace(db(), store, projectId)).rejects.toThrow(/does not exist/);
    expect(await loadPreviewArtifact(db(), store, { ...claims, w: await ws(db()) })).toBeNull();
    expect((await db().query('SELECT count(*)::int AS n FROM builds WHERE workspace_id = scopely.current_workspace_id()')).rows[0].n).toBe(0);
    await useWorkspace(db(), workspaceA);
  });
});

// ================================================================== AI boundary

describe('the AI edit boundary', () => {
  async function withInterpreter(interpreter: EditInterpreter) {
    const { projectId, buildId, store } = await built(db());
    return requestAiEdit(db(), { store, interpreter }, projectId, { baseBuildId: buildId, request: 'anything' });
  }
  const fixed = (operations: unknown[]): EditInterpreter => ({ key: 't', version: '1', modelUse: 'NONE', interpret: async () => ({ operations, needsInput: [] }) });

  it('refuses operations outside the schema, and anything else an interpreter might try', async () => {
    for (const ops of [
      [{ op: 'raw_html', html: '<script>alert(1)</script>' }],
      [{ op: 'update_text', section: 'hero', slot: 'headline', value: 'Hi', style: 'color:red' }],
      [{ op: 'update_text', section: 'hero', slot: 'onload', value: 'x' }],
      [{ op: 'change_color', accent: 'red;}</style><script>alert(1)</script>' }],
      [{ op: 'update_cta', action: { kind: 'link', value: 'javascript:alert(1)' } }],
      [{ op: 'update_cta', action: { kind: 'phone', value: '+44 20 7946 0000' } }],   // invented contact detail
      [{ op: 'update_text', section: 'about', slot: 'body', value: 'Rated 5 stars by over 500 customers since 1998' }],
      [{ op: 'update_text', section: 'hero', slot: 'subheadline', value: 'We are the best clinic around' }],
      [{ op: 'update_text', section: 'hero', slot: 'subheadline', value: 'Unlike before, you can now book online' }],
      [{ op: 'move_section', section: 'footer', direction: 'up' }],
      [{ op: 'hide_section', section: 'hero' }],
    ]) {
      expect(await withInterpreter(fixed(ops)), JSON.stringify(ops)).toMatchObject({ status: 'FAILED', errorCode: 'EDIT_REFUSED', buildId: null });
    }
  });

  it('keeps the interpreter separate from any model: the deterministic interpreter needs none and the agent reports no usage', async () => {
    const agent = new ScopelySiteAgent(new RuleBasedEditInterpreter());
    expect(agent.modelUse).toBe('NONE');
    const modelBacked = new ScopelySiteAgent({ key: 'm', version: '1', modelUse: 'PROVIDER_CONNECTION', interpret: async () => ({ operations: [], needsInput: [] }) });
    expect(modelBacked.modelUse).toBe('PROVIDER_CONNECTION');
    expect(EditRejected).toBeDefined();
  });
});
