// Migration 009 and the Build Workspace seams: projects own versions, runs are agent attempts that
// can only produce DRAFT versions, provider connections hold references not keys, costs say who
// pays, the BuildContext carries only sourced facts, and every new row stays in its workspace.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  getBuildProject, getBuildRun, getSearch, listBuildProjects, listBuildVersions, listOpportunities, listSearches,
} from '../src/api/queries.js';
import {
  activateProviderConnection, approveBuild, assertNoSecrets, BuildAgentRegistry, BuilderRegistry, createBuildProject, executeBuildRun,
  listProviderConnections, loadBuildContext, markBuildShown, ModelProviderRegistry, queueBuildRun, recordAsset, recordRequirement,
  registerProviderConnection, revokeProviderConnection, withAgentActor,
  type BuildAgent, type FixBuilder, type ModelProviderFactory, type SecretResolver,
} from '../src/build/index.js';
import { createSearch, startSearchRun } from '../src/discovery/index.js';
import { addMember, upsertUser } from '../src/tenancy/index.js';
import { asApp, catalogId, enterNewWorkspace, failure, one, refused, seedChain, seedOpportunity, useDb, useWorkspace } from './helpers.js';

const { db } = useDb();

const current = async (d: pg.Client) => (await one<{ ws: string }>(d, 'SELECT scopely.current_workspace_id()::text AS ws')).ws;

const insertVersion = `INSERT INTO builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, artifact_ref, generator,
  supersedes_build_id, project_id, delivery_of_build_id, version_no, manifest_ref)
  VALUES ($1, $2, 'website_fix', $3, 'Fixed links', 'Corrected links', 'preview/1', 'operator', $4, $5, $6, $7, $8) RETURNING id`;

interface Seed { c: Awaited<ReturnType<typeof seedChain>>; opp: string; cat: string; projectId: string; ws: string }

/** A mapped opportunity in the current workspace with one open build project. */
async function seedProject(d: pg.Client): Promise<Seed> {
  const c = await seedChain(d);
  const opp = await seedOpportunity(d, c);
  const projectId = await createBuildProject(d, { opportunityId: opp, title: 'Contact fix' });
  return { c, opp, cat: await catalogId(d, 'website_fix_sprint'), projectId, ws: await current(d) };
}

/** Records a version with its evidence and returns its id. */
async function version(d: pg.Client, s: Seed, o: { purpose?: 'DEMO' | 'DELIVERY'; supersedes?: string | null; projectId?: string | null;
  deliveryOf?: string | null; versionNo?: number | null; manifestRef?: string | null } = {}): Promise<string> {
  // One statement, so it holds even after a test has made the evidence check immediate.
  const b = await one<{ id: string }>(d, `WITH b AS (${insertVersion}) INSERT INTO build_evidence (build_id, evidence_id) SELECT id, $9 FROM b RETURNING build_id AS id`,
    [s.opp, s.cat, o.purpose ?? 'DEMO', o.supersedes ?? null, o.projectId === undefined ? s.projectId : o.projectId, o.deliveryOf ?? null,
     o.versionNo ?? null, o.manifestRef ?? null, s.c.evidenceId]);
  return b.id;
}

async function confirmEvidence(d: pg.Client, c: Seed['c'], at = '2026-10-01T09:00:00Z') {
  const s = await one<{ id: string }>(d, `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'https://example-clinic.test/', $2, 'manual') RETURNING id`, [c.businessId, at]);
  const o = await one<{ id: string }>(d, `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'defect') RETURNING id`, [s.id, c.ruleId]);
  await d.query(`INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1,$2,$3,'confirmed','operator')`, [c.evidenceId, s.id, o.id]);
}

async function win(d: pg.Client, opp: string) {
  const outcome = `INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, recorded_by) VALUES ($1,$2,$3,$4,$5,'operator')`;
  await d.query(outcome, [opp, 'pitched', '2026-10-01', null, null]);
  await d.query(outcome, [opp, 'won', '2026-10-02', 120, 'GBP']);
}

const approve = `UPDATE builds SET status = 'APPROVED', approved_by = 'operator', approved_at = '2026-10-01T10:00:00Z' WHERE id = $1`;
const show = `UPDATE builds SET status = 'SHOWN', shown_at = '2026-10-01T12:00:00Z' WHERE id = $1`;

async function activeConnection(d: pg.Client, mode: 'CUSTOMER_KEY' | 'SCOPELY_MANAGED' = 'CUSTOMER_KEY', scopes: ('build' | 'analysis')[] = ['build']) {
  const ws = await current(d);
  const id = await registerProviderConnection(d, { provider: 'example_ai', mode, scopes,
    credentialRef: mode === 'CUSTOMER_KEY' ? `secretref:ws/${ws}/build-model` : null });
  await activateProviderConnection(d, id, '2026-10-01T08:00:00Z');
  return id;
}

// ------------------------------------------------------------------ stubs (tests only; nothing is registered by default)

const instructor: FixBuilder = {
  kind: 'website_fix', version: 'test-1',
  instruct: async (ctx) => ({
    buildKind: ctx.project.buildKind, purpose: ctx.purpose, objective: 'Fix the contact paths the evidence shows are broken',
    tasks: ctx.evidence.map((e) => ({ title: e.plainIssue, addressesEvidenceIds: [e.evidenceId] })),
    constraints: ['Change only what the evidence names'],
    mustNotClaim: [...ctx.withheldFacts.map((w) => w.attribute), ...ctx.notObservable.map((o) => o.checkCode)],
  }),
};

function stubAgent(over: Partial<BuildAgent> = {}): BuildAgent {
  return {
    key: 'stub_agent', version: 't1', modelUse: 'NONE',
    run: async (task) => ({ title: 'Agent draft', summary: `${task.instructions.tasks.length} fixes`,
      manifestRef: `${task.project.workPrefix}manifest.json`, previewRef: `${task.project.workPrefix}preview/index.html`,
      previewSha256: 'c'.repeat(64), usage: [] }),
    ...over,
  };
}

function deps(agent: BuildAgent = stubAgent(), extra: { providers?: ModelProviderRegistry; secrets?: SecretResolver } = {}) {
  const builders = new BuilderRegistry();
  builders.register(instructor);
  const agents = new BuildAgentRegistry();
  agents.register(agent);
  return { builders, agents, ...extra };
}

// ================================================================== projects and versions

describe('a build project owns numbered versions', () => {
  it('opens a project for a build recorded without one, numbers versions, and continues the project on supersede', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const s: Seed = { c, opp, cat: await catalogId(db(), 'website_fix_sprint'), projectId: '', ws: await current(db()) };
    const v1 = await version(db(), s, { projectId: null });
    const r1 = await one<{ project_id: string; version_no: number }>(db(), 'SELECT project_id, version_no FROM builds WHERE id = $1', [v1]);
    expect(r1.version_no).toBe(1);
    const p = await one<{ opportunity_id: string; build_kind: string }>(db(), 'SELECT opportunity_id, build_kind FROM build_projects WHERE id = $1', [r1.project_id]);
    expect(p).toEqual({ opportunity_id: opp, build_kind: 'website_fix' });
    const v2 = await version(db(), s, { projectId: null, supersedes: v1 });
    expect(await one(db(), 'SELECT project_id, version_no FROM builds WHERE id = $1', [v2])).toEqual({ project_id: r1.project_id, version_no: 2 });
  });

  it('marks a superseded version SUPERSEDED automatically, even after it was shown, and keeps it final', async () => {
    const s = await seedProject(db());
    const v1 = await version(db(), s);
    await db().query(approve, [v1]);
    await confirmEvidence(db(), s.c);
    await db().query(show, [v1]);
    const v2 = await version(db(), s, { supersedes: v1 });
    expect((await one<{ status: string; shown_at: Date }>(db(), 'SELECT status, shown_at FROM builds WHERE id = $1', [v1])).status).toBe('SUPERSEDED');
    expect(await failure(db(), `UPDATE builds SET status = 'APPROVED' WHERE id = $1`, [v1])).toMatch(/superseded version is final/);
    expect((await one<{ status: string }>(db(), 'SELECT status FROM builds WHERE id = $1', [v2])).status).toBe('DRAFT');
  });

  it('keeps version numbers unique within a project', async () => {
    const s = await seedProject(db());
    await version(db(), s);
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DEMO', null, s.projectId, null, 1, null])).toMatch(/builds_project_version_key/);
    const again = await version(db(), s);
    expect((await one<{ version_no: number }>(db(), 'SELECT version_no FROM builds WHERE id = $1', [again])).version_no).toBe(2);
  });

  it('allows at most one successor per version', async () => {
    const s = await seedProject(db());
    const v1 = await version(db(), s);
    await version(db(), s, { supersedes: v1 });
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DEMO', v1, s.projectId, null, null, null])).toMatch(/already has a successor/);
    // The same refusal on an update: re-pointing a later version at a parent that already has a successor.
    const v3 = await version(db(), s);
    expect(await failure(db(), 'UPDATE builds SET supersedes_build_id = $2 WHERE id = $1', [v3, v1])).toMatch(/already has a successor/);
  });

  it('never moves a version, renumbers it, relabels its purpose or rewrites what it supersedes', async () => {
    const s = await seedProject(db());
    const other = await createBuildProject(db(), { opportunityId: s.opp, title: 'Second effort' });
    const v1 = await version(db(), s);
    const v2 = await version(db(), s, { supersedes: v1 });
    const v3 = await version(db(), s);
    expect(await failure(db(), 'UPDATE builds SET project_id = $2 WHERE id = $1', [v3, other])).toMatch(/cannot change its project or number/);
    expect(await failure(db(), 'UPDATE builds SET version_no = 9 WHERE id = $1', [v3])).toMatch(/cannot change its project or number/);
    await win(db(), s.opp); // so the DEMO-to-DELIVERY relabel reaches the version guard, not only the win check
    expect(await failure(db(), `UPDATE builds SET purpose = 'DELIVERY' WHERE id = $1`, [v3])).toMatch(/purpose cannot change/);
    expect(await failure(db(), 'UPDATE builds SET supersedes_build_id = $2 WHERE id = $1', [v2, v3])).toMatch(/supersedes or delivers cannot change/);
    // An older version cannot supersede a newer one.
    const v4 = await version(db(), s);
    expect(await failure(db(), 'UPDATE builds SET supersedes_build_id = $2 WHERE id = $1', [v3, v4])).toMatch(/cannot supersede the later version/);
  });

  it('keeps a project on its opportunity\'s mapped service, and a version on its project\'s opportunity', async () => {
    const s = await seedProject(db());
    expect(await failure(db(), `INSERT INTO build_projects (opportunity_id, build_kind, title) VALUES ($1, 'landing_page', 't')`, [s.opp]))
      .toMatch(/must build its opportunity's mapped service/);
    const unmapped = await one<{ id: string }>(db(), `INSERT INTO opportunities (business_id, opportunity_type, unmapped_reason) VALUES ($1, 't', 'none') RETURNING id`, [s.c.businessId]);
    expect(await failure(db(), `INSERT INTO build_projects (opportunity_id, build_kind, title) VALUES ($1, 'website_fix', 't')`, [unmapped.id]))
      .toMatch(/must build its opportunity's mapped service/);
    expect(await failure(db(), `UPDATE build_projects SET build_kind = 'landing_page' WHERE id = $1`, [s.projectId])).toMatch(/cannot change its opportunity or build kind/);
    const t = await seedProject(db());
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DEMO', null, t.projectId, null, null, null])).toMatch(/project \d+ builds website_fix for opportunity \d+, not/);
    const v = await version(db(), s);
    expect(await failure(db(), insertVersion, [t.opp, t.cat, 'DEMO', v, null, null, null, null])).toMatch(/same opportunity/);
  });
});

describe('DEMO and DELIVERY stay apart', () => {
  it('lets a DELIVERY name the DEMO it continues, in the same project, only after a win', async () => {
    const s = await seedProject(db());
    const demo = await version(db(), s);
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DELIVERY', null, null, demo, null, null])).toMatch(/needs a won opportunity/);
    await win(db(), s.opp);
    const delivery = await version(db(), s, { purpose: 'DELIVERY', projectId: null, deliveryOf: demo });
    expect(await one(db(), 'SELECT project_id, version_no, delivery_of_build_id FROM builds WHERE id = $1', [delivery]))
      .toEqual({ project_id: s.projectId, version_no: 2, delivery_of_build_id: demo });
    // The demo is continued, not superseded: it stays the record of what was pitched.
    expect((await one<{ status: string }>(db(), 'SELECT status FROM builds WHERE id = $1', [demo])).status).toBe('DRAFT');
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DELIVERY', null, null, delivery, null, null])).toMatch(/continues a DEMO build; build \d+ is a DELIVERY/);
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DEMO', null, null, demo, null, null])).toMatch(/builds_delivery_of_check/);
    const other = await createBuildProject(db(), { opportunityId: s.opp, title: 'Other' });
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DELIVERY', null, other, demo, null, null])).toMatch(/DEMO of its own project/);
    const t = await seedProject(db());
    const theirDemo = await version(db(), t);
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DELIVERY', null, null, theirDemo, null, null])).toMatch(/DEMO of its own opportunity/);
  });

  it('never lets a DELIVERY supersede a DEMO, or a DEMO become revenue or delivery', async () => {
    const s = await seedProject(db());
    const demo = await version(db(), s);
    await db().query(approve, [demo]);
    await confirmEvidence(db(), s.c);
    await db().query(show, [demo]);
    await win(db(), s.opp);
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DELIVERY', demo, null, null, null, null])).toMatch(/DELIVERY version cannot supersede a DEMO/);
    // A shown demo leaves revenue to the won outcome and delivery to a delivered outcome.
    const t = await seedProject(db());
    const tDemo = await version(db(), t);
    await db().query(approve, [tDemo]);
    await confirmEvidence(db(), t.c);
    await db().query(show, [tDemo]);
    const ledger = await one<{ deal_value: string | null; result: string | null; delivered_at: Date | null; demo_builds_shown: string }>(db(),
      'SELECT deal_value, result, delivered_at, demo_builds_shown FROM v_opportunity_ledger WHERE opportunity_id = $1', [t.opp]);
    expect(ledger).toEqual({ deal_value: null, result: null, delivered_at: null, demo_builds_shown: '1' });
    const [feed] = await listOpportunities(db(), { searchRunId: undefined, limit: 500 }).then((r) => r.filter((x) => x.opportunityId === String(t.opp)));
    expect(feed!.deliveryState).toBe('NONE');
    expect(await failure(db(), `UPDATE builds SET purpose = 'DELIVERY' WHERE id = $1`, [tDemo])).toMatch(/DELIVERY build needs a won opportunity/);
    expect(await failure(db(), `INSERT INTO outcomes (opportunity_id, kind, occurred_at, delivered_by, recorded_by) VALUES ($1, 'delivered', now(), 'operator', 'operator')`, [t.opp]))
      .toMatch(/before a won outcome/);
  });
});

describe('a version\'s manifest lives in its own project\'s storage', () => {
  it('accepts a key under the project prefix and refuses another project, another workspace, traversal or a URL', async () => {
    const s = await seedProject(db());
    const t = await seedProject(db());
    const own = `workspaces/${s.ws}/projects/${s.projectId}/versions/1/manifest.json`;
    const v = await version(db(), s, { manifestRef: own });
    expect((await one<{ manifest_ref: string }>(db(), 'SELECT manifest_ref FROM builds WHERE id = $1', [v])).manifest_ref).toBe(own);
    for (const bad of [
      `workspaces/${s.ws}/projects/${t.projectId}/versions/1/manifest.json`,
      `workspaces/${Number(s.ws) + 1}/projects/${s.projectId}/versions/1/manifest.json`,
      `workspaces/${s.ws}/projects/${s.projectId}/assets/logo.png`,
      `workspaces/${s.ws}/projects/${s.projectId}/versions/../../${t.projectId}/versions/1/m.json`,
      `https://cdn.example.test/workspaces/${s.ws}/projects/${s.projectId}/versions/1/manifest.json`,
    ]) {
      expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DEMO', null, s.projectId, null, null, bad]), bad).toMatch(/STORAGE: /);
    }
  });

  it('freezes the manifest of an approved or shown version', async () => {
    const s = await seedProject(db());
    const v = await version(db(), s, { manifestRef: `workspaces/${s.ws}/projects/${s.projectId}/versions/1/manifest.json` });
    await db().query(approve, [v]);
    const moved = `UPDATE builds SET manifest_ref = $2 WHERE id = $1`;
    const next = `workspaces/${s.ws}/projects/${s.projectId}/versions/1b/manifest.json`;
    expect(await failure(db(), moved, [v, next])).toMatch(/needs a new approval/);
    await confirmEvidence(db(), s.c);
    await db().query(show, [v]);
    expect(await failure(db(), `UPDATE builds SET manifest_ref = $2, approved_at = '2026-10-01T13:00:00Z' WHERE id = $1`, [v, next])).toMatch(/shown build cannot change/);
  });

  it('keeps project assets inside the project\'s assets prefix', async () => {
    const s = await seedProject(db());
    const t = await seedProject(db());
    const add = (ref: string) => failure(db(), `INSERT INTO build_assets (project_id, kind, storage_ref, description, provided_by, recorded_by)
      VALUES ($1, 'logo', $2, 'Client logo', 'client', 'operator')`, [s.projectId, ref]);
    expect(await add(`workspaces/${s.ws}/projects/${s.projectId}/assets/logo.svg`)).toBeNull();
    expect(await add(`workspaces/${s.ws}/projects/${t.projectId}/assets/logo.svg`)).toMatch(/outside this project's storage/);
    expect(await add(`workspaces/${s.ws}/projects/${s.projectId}/versions/1/logo.svg`)).toMatch(/outside this project's storage/);
  });
});

// ================================================================== runs

describe('a build run is an agent attempt, separate from the version it produces', () => {
  it('starts QUEUED and moves only QUEUED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED; a finished run is frozen', async () => {
    const s = await seedProject(db());
    const q = (status = 'QUEUED') => failure(db(), `INSERT INTO build_runs (project_id, purpose, agent_key, status) VALUES ($1, 'DEMO', 'stub_agent', $2)`, [s.projectId, status]);
    expect(await q('RUNNING')).toMatch(/starts QUEUED/);
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    expect(await failure(db(), `UPDATE build_runs SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1`, [run])).toMatch(/cannot move from QUEUED to SUCCEEDED|check constraint/);
    expect(await failure(db(), `UPDATE build_runs SET status = 'RUNNING' WHERE id = $1`, [run])).toMatch(/check constraint/);
    expect(await failure(db(), `UPDATE build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [run])).toBeNull();
    expect(await failure(db(), `UPDATE build_runs SET agent_key = 'other_agent' WHERE id = $1`, [run])).toMatch(/cannot change/);
    expect(await failure(db(), `UPDATE build_runs SET status = 'FAILED', finished_at = now() WHERE id = $1`, [run])).toMatch(/check constraint/);
    expect(await failure(db(), `UPDATE build_runs SET status = 'FAILED', finished_at = now(), error_code = 'AGENT_TIMEOUT' WHERE id = $1`, [run])).toBeNull();
    expect(await failure(db(), `UPDATE build_runs SET meta = '{"note":"x"}' WHERE id = $1`, [run])).toMatch(/finished run cannot change/);
    expect(await failure(db(), `UPDATE build_runs SET status = 'RUNNING', finished_at = NULL, error_code = NULL WHERE id = $1`, [run])).toMatch(/finished run cannot change/);
  });

  it('has no approval, show or delivery field: those are not a run\'s to record', async () => {
    const cols = (await db().query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scopely' AND table_name = 'build_runs'`))
      .rows.map((r) => r.column_name as string);
    expect(cols.filter((c) => /approv|shown|show|deliver|won|verif|recheck/.test(c))).toEqual([]);
  });

  it('links only a DRAFT version of its own project, the successor of its base when it modifies one', async () => {
    const s = await seedProject(db());
    const base = await version(db(), s);
    const approved = await version(db(), s);
    await db().query(approve, [approved]);
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent', baseBuildId: base });
    await db().query(`UPDATE build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [run]);
    const succeed = `UPDATE build_runs SET status = 'SUCCEEDED', finished_at = now(), produced_build_id = $2 WHERE id = $1`;
    expect(await failure(db(), succeed, [run, approved])).toMatch(/produces a DRAFT version/);
    const unrelated = await version(db(), s);
    expect(await failure(db(), succeed, [run, unrelated])).toMatch(/must produce its successor/);
    const t = await seedProject(db());
    const theirs = await version(db(), t);
    expect(await failure(db(), succeed, [run, theirs])).toMatch(/not part of project/);
    const successor = await version(db(), s, { supersedes: base });
    expect(await failure(db(), succeed, [run, successor])).toBeNull();
    // A run's base must be a version of its project and of its purpose.
    expect(await failure(db(), `INSERT INTO build_runs (project_id, purpose, agent_key, base_build_id) VALUES ($1, 'DEMO', 'a_agent', $2)`, [s.projectId, theirs]))
      .toMatch(/is not part of project/);
    expect(await failure(db(), `INSERT INTO build_runs (project_id, purpose, agent_key, base_build_id) VALUES ($1, 'DELIVERY', 'a_agent', $2)`, [s.projectId, successor]))
      .toMatch(/DELIVERY run cannot modify a DEMO version/);
  });

  it('uses only an ACTIVE, build-scoped provider connection', async () => {
    const s = await seedProject(db());
    const ws = await current(db());
    const pending = await registerProviderConnection(db(), { provider: 'example_ai', mode: 'CUSTOMER_KEY', scopes: ['build'], credentialRef: `secretref:ws/${ws}/k1` });
    const analysisOnly = await activeConnection(db(), 'CUSTOMER_KEY', ['analysis']);
    const ok = await activeConnection(db());
    const queue = (conn: string) => refused(db(), () => queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent', providerConnectionId: conn }));
    expect(await queue(pending)).toMatch(/needs an ACTIVE build connection/);
    expect(await queue(analysisOnly)).toMatch(/needs an ACTIVE build connection/);
    expect(await queue(ok)).toBeNull();
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent', providerConnectionId: ok });
    await revokeProviderConnection(db(), ok, '2026-10-02T00:00:00Z');
    expect(await failure(db(), `UPDATE build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [run])).toMatch(/needs an ACTIVE build connection/);
  });
});

describe('a build agent can never pass a human gate', () => {
  it('refuses approval, show and discard of a build while the request acts as a build agent', async () => {
    const s = await seedProject(db());
    const v = await version(db(), s);
    await confirmEvidence(db(), s.c);
    await withAgentActor(db(), async () => {
      expect(await failure(db(), approve, [v])).toMatch(/build agent cannot approve/);
      expect(await failure(db(), `UPDATE builds SET status = 'DISCARDED' WHERE id = $1`, [v])).toMatch(/cannot discard/);
      // Recording a DRAFT version (with its evidence) is what an agent's run may do.
      const draft = `WITH b AS (${insertVersion.replace("'preview/1', 'operator'", "'preview/1', 'agent:x:1'")})
        INSERT INTO build_evidence (build_id, evidence_id) SELECT id, $9 FROM b`;
      expect(await failure(db(), draft, [s.opp, s.cat, 'DEMO', null, s.projectId, null, null, null, s.c.evidenceId])).toBeNull();
    });
    await db().query(approve, [v]);
    await withAgentActor(db(), async () => {
      expect(await failure(db(), show, [v])).toMatch(/build agent cannot mark a build shown/);
    });
    expect(await failure(db(), show, [v])).toBeNull();
  });

  it('refuses outcomes (won, delivered), verifications, evidence re-checks and messages while acting as a build agent', async () => {
    const s = await seedProject(db());
    await withAgentActor(db(), async () => {
      expect(await failure(db(), `INSERT INTO outcomes (opportunity_id, kind, occurred_at, recorded_by) VALUES ($1, 'pitched', now(), 'agent')`, [s.opp]))
        .toMatch(/build agent cannot write outcomes/);
      expect(await failure(db(), `INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, recorded_by) VALUES ($1, 'won', now(), 120, 'GBP', 'agent')`, [s.opp]))
        .toMatch(/build agent cannot write outcomes/);
      const snap = await one<{ id: string }>(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'u', '2026-10-01T09:00:00Z', 'manual') RETURNING id`, [s.c.businessId]);
      const obs = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'ok') RETURNING id`, [snap.id, s.c.ruleId]);
      expect(await failure(db(), `INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1,$2,$3,'confirmed','agent')`,
        [s.c.evidenceId, snap.id, obs.id])).toMatch(/build agent cannot write evidence_rechecks/);
      expect(await failure(db(), `INSERT INTO verifications (opportunity_id, baseline_evidence_id, snapshot_id, observation_id, rule_version_id, status)
        VALUES ($1, $2, $3, $4, $5, 'PASSED')`, [s.opp, s.c.evidenceId, snap.id, obs.id, s.c.ruleId])).toMatch(/build agent cannot write verifications/);
      expect(await failure(db(), `INSERT INTO messages (opportunity_id, step, subject, body, evidence_ids, generator) VALUES ($1, 0, 's', 'b', $2, 'agent')`,
        [s.opp, [s.c.evidenceId]])).toMatch(/build agent cannot write messages/);
    });
    // The same writes are a person's to make.
    expect(await failure(db(), `INSERT INTO outcomes (opportunity_id, kind, occurred_at, recorded_by) VALUES ($1, 'pitched', now(), 'operator')`, [s.opp])).toBeNull();
  });

  it('executes a run into a DRAFT version that a person must still approve, and whose show still waits for the re-check', async () => {
    const s = await seedProject(db());
    await db().query(`UPDATE opportunities SET not_observable_notes = 'Booking widget not rendered' WHERE id = $1`, [s.opp]);
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent', agentVersion: 't1' });
    const seen: unknown[] = [];
    const agent = stubAgent({ run: async (task, model) => { seen.push({ task, model }); return stubAgent().run(task, model); } });
    const result = await executeBuildRun(db(), deps(agent), run);
    expect(result.status).toBe('SUCCEEDED');
    const b = await one<{ status: string; approved_at: Date | null; generator: string; version_no: number; manifest_ref: string }>(db(),
      'SELECT status, approved_at, generator, version_no, manifest_ref FROM builds WHERE id = $1', [result.buildId]);
    expect(b).toMatchObject({ status: 'DRAFT', approved_at: null, generator: 'agent:stub_agent:t1', version_no: 1 });
    expect(b.manifest_ref).toBe(`workspaces/${s.ws}/projects/${s.projectId}/versions/run-${run}/manifest.json`);
    // The agent received no database handle and no model (it uses none).
    expect(Object.keys(seen[0] as object).sort()).toEqual(['model', 'task']);
    expect((seen[0] as { model: unknown }).model).toBeNull();
    expect(Object.keys((seen[0] as { task: object }).task).sort()).toEqual(['context', 'instructions', 'meta', 'project', 'runId']);
    const view = (await getBuildRun(db(), run))!;
    expect(view).toMatchObject({ status: 'SUCCEEDED', producedBuildId: result.buildId, agent: { key: 'stub_agent', version: 't1' } });
    const asOf = '2026-10-01T12:00:00Z';
    const [v] = await listBuildVersions(db(), { projectId: s.projectId }, { asOf });
    expect(v!.gate).toEqual({ canApprove: true, approveBlocker: null, canShow: false, showBlocker: 'needs a recorded human approval', asOf: '2026-10-01T12:00:00.000Z' });
    await approveBuild(db(), result.buildId!, 'operator', '2026-10-01T10:00:00Z');
    const [approved] = await listBuildVersions(db(), { projectId: s.projectId }, { asOf });
    expect(approved!.gate.canShow).toBe(false);
    expect(approved!.gate.showBlocker).toMatch(/HIGH evidence \d+ has no confirmed re-check/);
  });

  it('records a failed run with an error code and no version', async () => {
    const s = await seedProject(db());
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    const boom = stubAgent({ run: async () => { throw new Error('model said: sk-live-looking text'); } });
    expect(await executeBuildRun(db(), deps(boom), run)).toEqual({ status: 'FAILED', buildId: null, errorCode: 'AGENT_ERROR' });
    expect((await db().query('SELECT id FROM builds WHERE project_id = $1', [s.projectId])).rows).toEqual([]);
    const missing = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'unknown_agent' });
    expect((await executeBuildRun(db(), deps(), missing)).errorCode).toBe('AGENT_NOT_AVAILABLE');
    // A DELIVERY run for an opportunity that was never won: the database refuses the version.
    const delivery = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DELIVERY', agentKey: 'stub_agent' });
    expect((await executeBuildRun(db(), deps(), delivery)).errorCode).toBe('VERSION_REFUSED');
    expect(await refused(db(), () => executeBuildRun(db(), deps(), delivery))).toMatch(/only a QUEUED run can start/);
  });
});

// ================================================================== providers, secrets and cost

describe('provider connections hold a reference, never a key', () => {
  it('accepts a workspace-scoped secret reference and refuses keys, other workspaces\' namespaces and managed credentials', async () => {
    const ws = await current(db());
    const reg = (ref: string | null, mode: 'CUSTOMER_KEY' | 'SCOPELY_MANAGED' = 'CUSTOMER_KEY') =>
      refused(db(), () => registerProviderConnection(db(), { provider: 'example_ai', mode, scopes: ['build'], credentialRef: ref }));
    expect(await reg(`secretref:ws/${ws}/team-key`)).toBeNull();
    for (const key of ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', 'sk-proj-abcdefghijklmnop1234', 'AKIAABCDEFGHIJKLMNOP',
                       'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) {
      expect(await reg(key), key).toMatch(/SECRET: credential_ref holds what looks like a credential/);
    }
    expect(await reg(`secretref:ws/${Number(ws) + 1}/team-key`)).toMatch(/this workspace's secret namespace/);
    expect(await reg('vault/team-key')).toMatch(/this workspace's secret namespace/);
    expect(await reg(`secretref:ws/${ws}/team-key`, 'SCOPELY_MANAGED')).toMatch(/check constraint/);
    const pending = await registerProviderConnection(db(), { provider: 'example_ai', mode: 'CUSTOMER_KEY', scopes: ['build'] });
    expect(await refused(db(), () => activateProviderConnection(db(), pending, '2026-10-01T00:00:00Z'))).toMatch(/check constraint/);
    const managed = await activeConnection(db(), 'SCOPELY_MANAGED');
    expect(await failure(db(), `UPDATE provider_connections SET mode = 'CUSTOMER_KEY' WHERE id = $1`, [managed])).toMatch(/provider and mode cannot change/);
    await revokeProviderConnection(db(), managed, '2026-10-02T00:00:00Z');
    expect(await failure(db(), `UPDATE provider_connections SET state = 'ACTIVE' WHERE id = $1`, [managed])).toMatch(/revoked connection is final/);
    const listed = await listProviderConnections(db());
    expect(listed.map((c) => [c.mode, c.billedTo, c.hasCredentialRef])).toEqual([['CUSTOMER_KEY', 'WORKSPACE', true], ['CUSTOMER_KEY', 'WORKSPACE', false], ['SCOPELY_MANAGED', 'SCOPELY', false]]);
    expect(JSON.stringify(listed)).not.toContain('secretref:');
  });

  it('has no column anywhere in the schema that could hold a raw secret', async () => {
    const cols = (await db().query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'scopely'`)).rows
      .map((r) => `${r.table_name}.${r.column_name}`);
    const risky = cols.filter((c) => /(api_?key|secret|password|passwd|private_?key|access_?token|refresh_?token|oauth|bearer|\btoken\b|\.token$|_token$|credential(?!_ref$))/i.test(c));
    expect(risky).toEqual([]);
    expect(cols).toContain('provider_connections.credential_ref');
    expect(cols).toContain('mailbox_connections.credential_ref');
  });

  it('refuses credential-like metadata on runs and costs, and secrets in requirements or asset notes', async () => {
    const s = await seedProject(db());
    const runWith = (meta: unknown) => failure(db(), `INSERT INTO build_runs (project_id, purpose, agent_key, meta) VALUES ($1, 'DEMO', 'stub_agent', $2)`, [s.projectId, meta]);
    expect(await runWith({ model: 'x', attempt: 1 })).toBeNull();
    expect(await runWith({ api_key: 'anything' })).toMatch(/SECRET: run metadata \$\.api_key/);
    expect(await runWith({ steps: [{ headers: { Authorization: 'x' } }] })).toMatch(/\$\.steps\[0\]\.headers\.Authorization/);
    expect(await runWith({ log: 'called with sk-ant-api03-AbCdEfGhIjKlMn' })).toMatch(/\$\.log looks like a credential/);
    expect(await runWith({ note: 'Bearer abcdefghijklmnopqrstuvwxyz' })).toMatch(/looks like a credential/);
    expect(await failure(db(), `INSERT INTO cost_events (opportunity_id, kind, meta) VALUES ($1, 'llm_call', $2)`, [s.opp, { token: 'x' }])).toMatch(/SECRET: cost metadata/);
    expect(await failure(db(), `INSERT INTO cost_events (opportunity_id, kind, meta) VALUES ($1, 'llm_call', $2)`, [s.opp, { tokens_in: 10, model: 'm' }])).toBeNull();
    expect(await refused(db(), () => recordRequirement(db(), { projectId: s.projectId, source: 'client', recordedBy: 'operator',
      requirement: 'Use our Stripe key sk_live_abcdefghijklmnop for the booking form' }))).toMatch(/SECRET: this build_requirements/);
    expect(await refused(db(), () => recordAsset(db(), { projectId: s.projectId, kind: 'document', providedBy: 'client', recordedBy: 'operator',
      storageRef: `workspaces/${s.ws}/projects/${s.projectId}/assets/creds.txt`, description: 'Admin login: ghp_abcdefghijklmnopqrstuvwxyz0123456789' })))
      .toMatch(/SECRET: this build_assets/);
  });

  it('never hands a BuildContext or agent output carrying a credential to anyone', async () => {
    await expect(assertNoSecrets(db(), 'build context', { requirements: [{ requirement: 'ok' }] })).resolves.toBeUndefined();
    await expect(assertNoSecrets(db(), 'build context', { requirements: [{ requirement: 'token sk-ant-api03-AbCdEfGhIjKl' }] }))
      .rejects.toThrow(/build context \$\.requirements\[0\]\.requirement looks like a credential/);
    const s = await seedProject(db());
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    const leaky = stubAgent({ run: async (task) => ({ ...(await stubAgent().run(task, null)), summary: 'deployed with sk-ant-api03-AbCdEfGhIjKlMn' }) });
    expect((await executeBuildRun(db(), deps(leaky), run)).errorCode).toBe('AGENT_ERROR');
    expect((await db().query('SELECT id FROM builds WHERE project_id = $1', [s.projectId])).rows).toEqual([]);
  });
});

describe('cost events say who pays', () => {
  const cost = `INSERT INTO cost_events (opportunity_id, kind, amount, currency, credits, billed_to, provider, provider_connection_id, build_run_id, build_id)
    VALUES ($1, 'llm_call', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`;

  it('records a BYOK model cost billed to the workspace with no Scopely credits', async () => {
    const s = await seedProject(db());
    const byok = await activeConnection(db(), 'CUSTOMER_KEY');
    expect(await failure(db(), cost, [s.opp, '0.0420', 'USD', null, 'WORKSPACE', null, byok, null, null])).toBeNull();
    expect(await failure(db(), cost, [s.opp, '0.0420', 'USD', 0, 'WORKSPACE', null, byok, null, null])).toBeNull();
    expect(await failure(db(), cost, [s.opp, '0.0420', 'USD', 3, 'WORKSPACE', null, byok, null, null])).toMatch(/cost_events_workspace_credits_check/);
    expect(await failure(db(), cost, [s.opp, null, null, 5, 'WORKSPACE', null, null, null, null])).toMatch(/cost_events_workspace_credits_check/);
    const row = await one<{ provider: string }>(db(), `SELECT provider FROM cost_events WHERE provider_connection_id = $1 LIMIT 1`, [byok]);
    expect(row.provider).toBe('example_ai');
  });

  it('bills a connection\'s cost to whoever holds the key, and refuses a provider cost with no payer', async () => {
    const s = await seedProject(db());
    const byok = await activeConnection(db(), 'CUSTOMER_KEY');
    const managed = await activeConnection(db(), 'SCOPELY_MANAGED');
    expect(await failure(db(), cost, [s.opp, null, null, null, 'SCOPELY', null, byok, null, null])).toMatch(/CUSTOMER_KEY connection is billed to WORKSPACE/);
    expect(await failure(db(), cost, [s.opp, null, null, null, 'WORKSPACE', null, managed, null, null])).toMatch(/SCOPELY_MANAGED connection is billed to SCOPELY/);
    expect(await failure(db(), cost, [s.opp, null, null, null, null, null, managed, null, null])).toMatch(/billed to SCOPELY, not nobody|provider_payer_check/);
    expect(await failure(db(), cost, [s.opp, null, null, null, 'SCOPELY', 'other_ai', managed, null, null])).toMatch(/is example_ai, not other_ai/);
    expect(await failure(db(), cost, [s.opp, null, null, null, null, 'example_ai', null, null, null])).toMatch(/cost_events_provider_payer_check/);
    // Scopely-managed AI keeps normal credit accounting possible; unknown money stays NULL.
    const id = (await one<{ id: string }>(db(), cost, [s.opp, null, null, 2, 'SCOPELY', null, managed, null, null])).id;
    expect(await failure(db(), `UPDATE cost_events SET billed_to = 'WORKSPACE', credits = NULL WHERE id = $1`, [id])).toMatch(/who paid, .*cannot change/);
    expect(await failure(db(), `UPDATE cost_events SET provider_connection_id = $2 WHERE id = $1`, [id, byok])).toMatch(/who paid, .*cannot change/);
  });

  it('keeps a run\'s cost on the run\'s opportunity, project and connection', async () => {
    const s = await seedProject(db());
    const t = await seedProject(db());
    const conn = await activeConnection(db());
    const other = await activeConnection(db());
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent', providerConnectionId: conn });
    const theirVersion = await version(db(), t);
    expect(await failure(db(), cost, [s.opp, null, null, null, 'WORKSPACE', null, conn, run, null])).toBeNull();
    expect(await failure(db(), cost, [t.opp, null, null, null, 'WORKSPACE', null, conn, run, null])).toMatch(/build run \d+ is not part of opportunity/);
    expect(await failure(db(), cost, [s.opp, null, null, null, 'WORKSPACE', null, other, run, null])).toMatch(/did not use provider connection/);
    expect(await failure(db(), `INSERT INTO cost_events (kind, build_run_id, business_id) VALUES ('agent_run', $1, $2)`, [run, s.c.businessId]))
      .toMatch(/build run \d+ is not part of opportunity|cost_events_build_run_check/);
    const sVersion = await version(db(), s);
    expect(await failure(db(), cost, [s.opp, null, null, null, 'WORKSPACE', null, conn, run, sVersion])).toBeNull();
    expect(await failure(db(), cost, [t.opp, null, null, null, null, null, null, null, theirVersion])).toBeNull();
  });

  it('meters an executed run\'s model use to the workspace for its own key, and reports cost by payer', async () => {
    const s = await seedProject(db());
    const conn = await activeConnection(db());
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'model_agent', providerConnectionId: conn });
    const providers = new ModelProviderRegistry();
    const opened: string[] = [];
    const factory: ModelProviderFactory = {
      provider: 'example_ai',
      open: (c) => { opened.push(c.credentialRef ?? 'none'); return { provider: 'example_ai', complete: async () => ({ text: 'ok',
        usage: { provider: 'example_ai', model: 'm-1', tokensIn: 100, tokensOut: 50, cost: { amount: null, currency: null } } }) }; },
    };
    providers.register(factory);
    const secrets: SecretResolver = { withSecret: async (_ref, use) => use('resolved-in-memory-only') };
    const agent = stubAgent({ key: 'model_agent', modelUse: 'PROVIDER_CONNECTION', run: async (task, model) => {
      const r = await model!.complete({ purpose: 'build', messages: [{ role: 'user', content: task.instructions.objective }] });
      return { ...(await stubAgent().run(task, null)), usage: [r.usage, { ...r.usage, cost: { amount: '0.0100', currency: 'USD' } }] };
    } });
    const result = await executeBuildRun(db(), deps(agent, { providers, secrets }), run);
    expect(result.status).toBe('SUCCEEDED');
    expect(opened).toEqual([`secretref:ws/${s.ws}/build-model`]);
    const rows = (await db().query('SELECT billed_to, provider, credits, amount, tokens_in FROM cost_events WHERE build_run_id = $1 ORDER BY id', [run])).rows;
    expect(rows).toEqual([{ billed_to: 'WORKSPACE', provider: 'example_ai', credits: null, amount: null, tokens_in: 100 },
                          { billed_to: 'WORKSPACE', provider: 'example_ai', credits: null, amount: '0.0100', tokens_in: 100 }]);
    const view = (await getBuildRun(db(), run))!;
    expect(view.providerConnection).toMatchObject({ mode: 'CUSTOMER_KEY', billedTo: 'WORKSPACE' });
    // One amount is unknown, so the total is unknown; credits are zero because the workspace paid.
    expect(view.cost).toEqual([{ payer: 'WORKSPACE', events: 2, amount: null, currency: 'USD', credits: '0', operatorMinutes: null }]);
    const needsModel = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'model_agent' });
    expect((await executeBuildRun(db(), deps(agent, { providers, secrets }), needsModel)).errorCode).toBe('NO_PROVIDER_CONNECTION');
  });
});

// ================================================================== BuildContext

describe('the BuildContext carries only what an agent may know', () => {
  it('passes every business fact with its basis, keeps estimates and NOT_OBSERVABLE as they are, and withholds unsourced attributes', async () => {
    const s = await seedProject(db());
    await db().query(`UPDATE businesses SET employee_count_min = 5, employee_count_max = 20, employees_basis = 'ESTIMATED', employees_source = 'directory model',
        employees_as_of = '2026-09-01', revenue_min = 250000, revenue_max = 500000, revenue_currency = 'GBP', revenue_basis = 'REPORTED',
        revenue_source = 'filed accounts', revenue_as_of = '2026-03-31', review_count = 41, rating = 4.6, reviews_source = 'maps listing',
        reviews_as_of = '2026-09-20', website_status = 'WEBSITE_UNREACHABLE', website_status_basis = 'NOT_OBSERVABLE',
        website_status_source = 'fetch timed out', website_status_checked_at = '2026-09-28', phone = '+44 20 7946 0999',
        address_line = '1 Unsourced Street', independence = 'chain', company_type = 'ltd' WHERE id = $1`, [s.c.businessId]);
    const ctx = await loadBuildContext(db(), s.projectId, { purpose: 'DEMO' });
    const byAttr = Object.fromEntries(ctx.facts.map((f) => [f.attribute, f]));
    expect(byAttr.employee_count).toMatchObject({ basis: 'ESTIMATED', source: 'directory model', value: { count: null, min: 5, max: 20 } });
    expect(byAttr.revenue).toMatchObject({ basis: 'REPORTED', value: { min: '250000.00', max: '500000.00', currency: 'GBP' } });
    expect(byAttr.reviews).toMatchObject({ basis: 'REPORTED', source: 'maps listing', value: { count: 41 } });
    expect(byAttr.website_status).toMatchObject({ basis: 'NOT_OBSERVABLE', value: { status: 'WEBSITE_UNREACHABLE' } });
    for (const f of ctx.facts) {
      expect(f.basis, f.attribute).toMatch(/^(VERIFIED|REPORTED|ESTIMATED|OBSERVED|INFERRED|NOT_OBSERVABLE)$/);
      expect(f.source.trim(), f.attribute).not.toBe('');
    }
    const withheld = ctx.withheldFacts.map((w) => w.attribute);
    for (const a of ['phone', 'address', 'structure', 'company_type', 'city', 'country', 'industry']) expect(withheld, a).toContain(a);
    const json = JSON.stringify(ctx);
    expect(json).not.toContain('7946');
    expect(json).not.toContain('Unsourced Street');
    expect(json).not.toMatch(/"chain"/);
  });

  it('withholds an UNKNOWN website status and passes structured NOT_OBSERVABLE observations, never page content', async () => {
    const s = await seedProject(db());
    await db().query(`UPDATE snapshots SET html_ref = 'raw/page-html-object' WHERE business_id = $1`, [s.c.businessId]);
    const nob = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, visible_text, extracted)
      VALUES ($1, 'booking.widget', $2, 'NOT_OBSERVABLE', 'secret page words', '{"html":"<div>page</div>"}') RETURNING id`, [s.c.snapshotId, s.c.ruleId]);
    const other = await seedChain(db());
    void other;
    await db().query(`UPDATE opportunities SET not_observable_notes = 'The booking widget is drawn by JavaScript' WHERE id = $1`, [s.opp]);
    const ctx = await loadBuildContext(db(), s.projectId, { purpose: 'DEMO' });
    expect(ctx.withheldFacts).toContainEqual({ attribute: 'website_status', reason: 'website status is UNKNOWN' });
    expect(ctx.facts.find((f) => f.attribute === 'website_status')).toBeUndefined();
    expect(ctx.notObservable).toEqual([{ observationId: String(nob.id), checkCode: 'booking.widget', url: 'https://example-clinic.test/',
      observedAt: expect.any(String), state: 'NOT_OBSERVABLE' }]);
    expect(ctx.notObservableNotes).toMatch(/JavaScript/);
    expect(ctx.evidence.map((e) => e.evidenceId)).toEqual([String(s.c.evidenceId)]);
    expect(ctx.evidence[0]!.recheck).toBeNull();
    const json = JSON.stringify(ctx);
    for (const leak of ['secret page words', '<div>', 'raw/page-html-object', 'href="tel:WhatsApp:0800"x']) expect(json).not.toContain(leak);
    // NOT_OBSERVABLE never becomes evidence: the observation is not in the evidence list.
    expect(ctx.evidence.some((e) => e.issueCode.includes('booking'))).toBe(false);
  });

  it('includes live requirements and assets, and drops withdrawn ones and evidence a re-check found gone', async () => {
    const s = await seedProject(db());
    await recordRequirement(db(), { projectId: s.projectId, requirement: 'Keep the existing brand colours', source: 'client', recordedBy: 'operator' });
    const gone = await recordRequirement(db(), { projectId: s.projectId, requirement: 'Add a chat widget', source: 'seller', recordedBy: 'operator' });
    await db().query('UPDATE build_requirements SET withdrawn_at = now() WHERE id = $1', [gone]);
    expect(await failure(db(), `UPDATE build_requirements SET requirement = 'edited' WHERE id = $1`, [gone])).toMatch(/withdrawn, never edited/);
    await recordAsset(db(), { projectId: s.projectId, kind: 'logo', storageRef: `workspaces/${s.ws}/projects/${s.projectId}/assets/logo.svg`,
      description: 'Client logo', providedBy: 'client', recordedBy: 'operator' });
    const ctx = await loadBuildContext(db(), s.projectId, { purpose: 'DEMO' });
    expect(ctx.requirements.map((r) => r.requirement)).toEqual(['Keep the existing brand colours']);
    expect(ctx.assets.map((a) => a.storageRef)).toEqual([`workspaces/${s.ws}/projects/${s.projectId}/assets/logo.svg`]);
    const snap = await one<{ id: string }>(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'u', '2026-10-01', 'manual') RETURNING id`, [s.c.businessId]);
    const ok = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'ok') RETURNING id`, [snap.id, s.c.ruleId]);
    await db().query(`INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1,$2,$3,'gone','operator')`, [s.c.evidenceId, snap.id, ok.id]);
    await expect(loadBuildContext(db(), s.projectId, { purpose: 'DEMO' })).rejects.toThrow(/no evidence that still holds/);
  });
});

// ================================================================== API contracts

describe('the Build Workspace read contract', () => {
  it('returns a project with its opportunity, version history, gates, runs and cost, computed server-side', async () => {
    const s = await seedProject(db());
    await recordRequirement(db(), { projectId: s.projectId, requirement: 'Mobile first', source: 'seller', recordedBy: 'operator' });
    const v1 = await version(db(), s);
    const v2 = await version(db(), s, { supersedes: v1 });
    await db().query(`INSERT INTO cost_events (opportunity_id, build_id, kind, minutes) VALUES ($1, $2, 'operator_time', 30)`, [s.opp, v2]);
    const conn = await activeConnection(db(), 'SCOPELY_MANAGED');
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent', providerConnectionId: conn, baseBuildId: v2 });
    await db().query(`UPDATE build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [run]);
    await db().query(`INSERT INTO cost_events (opportunity_id, build_run_id, kind, credits, billed_to, provider_connection_id) VALUES ($1, $2, 'llm_call', 2, 'SCOPELY', $3)`,
      [s.opp, run, conn]);
    await db().query(approve, [v2]);

    const p = (await getBuildProject(db(), s.projectId, { asOf: '2026-10-01T12:00:00Z' }))!;
    expect(p).toMatchObject({ projectId: s.projectId, buildKind: 'website_fix', path: 'FIX', storagePrefix: `workspaces/${s.ws}/projects/${s.projectId}/`,
      opportunity: { opportunityId: String(s.opp), won: false, service: { catalogKey: 'website_fix_sprint' } }, runState: 'RUNNING' });
    expect(p.versions.map((v) => [v.versionNo, v.status, v.supersedesBuildId, v.successorBuildId]))
      .toEqual([[1, 'SUPERSEDED', null, v2], [2, 'APPROVED', v1, null]]);
    expect(p.currentVersion!.buildId).toBe(v2);
    expect(p.currentVersion!.approval).toEqual({ approved: true, approvedAt: '2026-10-01T10:00:00.000Z', approvedBy: 'operator', approvedByIsAuthenticated: false });
    expect(p.currentVersion!.gate).toMatchObject({ canApprove: false, canShow: false });
    expect(p.currentVersion!.gate.showBlocker).toMatch(/HIGH evidence \d+ has no confirmed re-check/);
    expect(p.currentVersion!.evidence.map((e) => e.evidenceId)).toEqual([String(s.c.evidenceId)]);
    expect(p.versions[0]!.gate.showBlocker).toBe(`superseded by build ${v2}`);
    expect(p.runs[0]).toMatchObject({ runId: run, status: 'RUNNING', baseBuildId: v2, providerConnection: { billedTo: 'SCOPELY' } });
    expect(p.requirements.map((r) => r.requirement)).toEqual(['Mobile first']);
    expect(p.cost).toEqual([
      { payer: 'SCOPELY', events: 1, amount: null, currency: null, credits: '2.0000', operatorMinutes: null },
      { payer: 'UNATTRIBUTED', events: 1, amount: null, currency: null, credits: '0', operatorMinutes: '30.00' },
    ]);
    // The feed keeps the version's human state and the agent's run state apart.
    const [item] = (await listOpportunities(db(), { limit: 500 })).filter((x) => x.opportunityId === String(s.opp));
    expect([item!.buildState, item!.buildRunState]).toEqual(['DEMO_APPROVED', 'RUNNING']);
    expect(await listBuildProjects(db(), { opportunityId: s.opp })).toEqual([expect.objectContaining({ projectId: s.projectId, versions: 2,
      latestVersionStatus: 'APPROVED', runState: 'RUNNING' })]);
  });

  it('agrees with the database: canShow is true exactly when marking shown succeeds', async () => {
    const s = await seedProject(db());
    const v = await version(db(), s);
    // The gate is asked about the same moment the show would be recorded at.
    const gate = async () => (await listBuildVersions(db(), { projectId: s.projectId }, { asOf: '2026-10-01T12:00:00Z' }))[0]!.gate;
    expect((await gate()).canShow).toBe(false);
    expect(await refused(db(), () => markBuildShown(db(), v, '2026-10-01T12:00:00Z'))).toMatch(/check constraint/);
    await approveBuild(db(), v, 'operator', '2026-10-01T10:00:00Z');
    expect((await gate()).showBlocker).toMatch(/no confirmed re-check/);
    expect(await refused(db(), () => markBuildShown(db(), v, '2026-10-01T12:00:00Z'))).toMatch(/no confirmed re-check/);
    await confirmEvidence(db(), s.c);
    expect(await gate()).toMatchObject({ canShow: true, showBlocker: null });
    expect(await refused(db(), () => markBuildShown(db(), v, '2026-10-01T12:00:00Z'))).toBeNull();
    expect((await gate()).showBlocker).toBe('already shown');
    await win(db(), s.opp);
    const d = await version(db(), s, { purpose: 'DELIVERY', deliveryOf: v });
    const dv = (await listBuildVersions(db(), { opportunityId: s.opp })).find((x) => x.buildId === d)!;
    expect(dv.gate.showBlocker).toMatch(/DELIVERY build is delivered, not shown/);
    expect(dv.deliveryOfBuildId).toBe(v);
  });

  it('returns a saved search\'s actual criteria, not its performance', async () => {
    const id = await createSearch(db(), { name: 'Manchester plumbers', countryCode: 'GB', city: 'Manchester', verticals: ['home_services'],
      subverticals: ['plumbing'], employeeMin: 5, employeeMax: 30, revenueMin: 250000, revenueMax: 5000000, revenueCurrency: 'GBP',
      businessTypes: ['independent'], excludeChains: true, websitePresence: 'required', opportunityKinds: ['lead_recovery', 'website_fix'],
      reviewCountMin: 10, ratingMin: 3.5, excludedDomains: ['competitor.test'], exclude_won: undefined, excludeWon: true,
      maxBusinessesToAnalyze: 40, analysisBudgetCredits: 120.5 } as never);
    await startSearchRun(db(), id);
    const s = (await getSearch(db(), id))!;
    expect(s).toMatchObject({
      name: 'Manchester plumbers',
      geography: { countryCode: 'GB', city: 'Manchester', region: null, center: null },
      industry: { verticals: ['home_services'], subverticals: ['plumbing'], specialties: [] },
      employees: { min: 5, max: 30 },
      revenue: { min: '250000.00', max: '5000000.00', currency: 'GBP' },
      structure: { businessTypes: ['independent'], excludeChains: true, excludeFranchises: false },
      website: { presence: 'required', statuses: [] },
      opportunityKinds: ['lead_recovery', 'website_fix'],
      reviews: { countMin: 10, countMax: null, ratingMin: '3.50', ratingMax: null },
      exclusions: { won: true, suppressed: true, domains: ['competitor.test'] },
      limits: { maxBusinessesToAnalyze: 40, analysisBudgetCredits: '120.5000', maxDiscoveredPerRun: null },
    });
    expect(s.runs).toHaveLength(1);
    expect(await listSearches(db())).toEqual([expect.objectContaining({ searchId: id, name: 'Manchester plumbers', runs: 1 })]);
  });
});

// ================================================================== tenancy

describe('every Build Workspace row and reference stays inside one workspace', () => {
  async function populateA(d: pg.Client) {
    const s = await seedProject(d);
    const v = await version(d, s);
    const conn = await activeConnection(d);
    const run = await queueBuildRun(d, { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent', providerConnectionId: conn });
    const req = await recordRequirement(d, { projectId: s.projectId, requirement: 'r', source: 'seller', recordedBy: 'operator' });
    const asset = await recordAsset(d, { projectId: s.projectId, kind: 'logo', storageRef: `workspaces/${s.ws}/projects/${s.projectId}/assets/l.svg`,
      description: 'd', providedBy: 'client', recordedBy: 'operator' });
    const costId = (await one<{ id: string }>(d, `INSERT INTO cost_events (opportunity_id, build_run_id, kind, billed_to, provider_connection_id)
      VALUES ($1, $2, 'llm_call', 'WORKSPACE', $3) RETURNING id`, [s.opp, run, conn])).id;
    const searchId = await createSearch(d, { name: 'A search' });
    return { ...s, v, conn, run, req, asset, costId, searchId };
  }

  it('refuses every cross-workspace reference from a new or extended table', async () => {
    const A = await populateA(db());
    await enterNewWorkspace(db(), 'beta');
    const B = await seedProject(db());
    const bVersion = await version(db(), B);
    const bConn = await activeConnection(db());
    const bRun = await queueBuildRun(db(), { projectId: B.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    const cross = /WORKSPACE: .* belongs to workspace/;
    const attempts: [string, string, unknown[]][] = [
      ['build_projects.opportunity_id', `INSERT INTO build_projects (opportunity_id, build_kind, title) VALUES ($1, 'website_fix', 't')`, [A.opp]],
      ['builds.project_id', insertVersion, [B.opp, B.cat, 'DEMO', null, A.projectId, null, null, null]],
      ['builds.delivery_of_build_id', insertVersion, [B.opp, B.cat, 'DELIVERY', null, null, A.v, null, null]],
      ['builds.supersedes_build_id', insertVersion, [B.opp, B.cat, 'DEMO', A.v, null, null, null, null]],
      ['build_evidence.evidence_id', `INSERT INTO build_evidence (build_id, evidence_id) VALUES ($1, $2)`, [bVersion, A.c.evidenceId]],
      ['build_runs.project_id', `INSERT INTO build_runs (project_id, purpose, agent_key) VALUES ($1, 'DEMO', 'x_agent')`, [A.projectId]],
      ['build_runs.base_build_id', `INSERT INTO build_runs (project_id, purpose, agent_key, base_build_id) VALUES ($1, 'DEMO', 'x_agent', $2)`, [B.projectId, A.v]],
      ['build_runs.provider_connection_id', `INSERT INTO build_runs (project_id, purpose, agent_key, provider_connection_id) VALUES ($1, 'DEMO', 'x_agent', $2)`, [B.projectId, A.conn]],
      ['build_requirements.project_id', `INSERT INTO build_requirements (project_id, requirement, source, recorded_by) VALUES ($1, 'r', 'seller', 'op')`, [A.projectId]],
      ['build_assets.project_id', `INSERT INTO build_assets (project_id, kind, storage_ref, description, provided_by, recorded_by)
        VALUES ($1, 'logo', $2, 'd', 'client', 'op')`, [A.projectId, `workspaces/${A.ws}/projects/${A.projectId}/assets/x.svg`]],
      ['cost_events.provider_connection_id', `INSERT INTO cost_events (opportunity_id, kind, billed_to, provider_connection_id) VALUES ($1, 'llm_call', 'WORKSPACE', $2)`, [B.opp, A.conn]],
      ['cost_events.build_run_id', `INSERT INTO cost_events (opportunity_id, kind, build_run_id) VALUES ($1, 'agent_run', $2)`, [B.opp, A.run]],
      ['cost_events.build_id', `INSERT INTO cost_events (opportunity_id, kind, build_id) VALUES ($1, 'build', $2)`, [B.opp, A.v]],
    ];
    for (const [what, sql, params] of attempts) expect(await failure(db(), sql, params), what).toMatch(cross);
    // Existing rows cannot be re-pointed across either.
    await db().query(`UPDATE build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [bRun]);
    expect(await failure(db(), `UPDATE build_runs SET status = 'SUCCEEDED', finished_at = now(), produced_build_id = $2 WHERE id = $1`, [bRun, A.v]))
      .toMatch(cross);
    const bCost = (await one<{ id: string }>(db(), `INSERT INTO cost_events (opportunity_id, kind, billed_to, provider_connection_id) VALUES ($1, 'llm_call', 'WORKSPACE', $2) RETURNING id`, [B.opp, bConn])).id;
    expect(await failure(db(), 'UPDATE cost_events SET provider_connection_id = $2 WHERE id = $1', [bCost, A.conn])).toMatch(cross);
    // A project manifest in workspace B cannot point into workspace A's storage.
    expect(await failure(db(), insertVersion, [B.opp, B.cat, 'DEMO', null, B.projectId, null, null,
      `workspaces/${A.ws}/projects/${A.projectId}/versions/1/manifest.json`])).toMatch(/STORAGE: .* outside this project's storage/);
  });

  it('refuses a creator or run starter who is not a member of the workspace', async () => {
    const s = await seedProject(db());
    const member = await upsertUser(db(), 'member@seller-a.test');
    await addMember(db(), s.ws, member, 'member');
    const outsider = await upsertUser(db(), 'outsider@seller-b.test');
    expect(await refused(db(), () => createBuildProject(db(), { opportunityId: s.opp, title: 't', createdByUserId: member }))).toBeNull();
    expect(await refused(db(), () => createBuildProject(db(), { opportunityId: s.opp, title: 't', createdByUserId: outsider }))).toMatch(/is not a member of workspace/);
    expect(await refused(db(), () => queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'a_agent', startedByUserId: outsider })))
      .toMatch(/is not a member of workspace/);
    expect(await refused(db(), () => registerProviderConnection(db(), { provider: 'example_ai', mode: 'SCOPELY_MANAGED', scopes: ['build'], createdByUserId: outsider })))
      .toMatch(/is not a member of workspace/);
  });

  it('refuses moving any new row to another workspace', async () => {
    const A = await populateA(db());
    const b = await enterNewWorkspace(db(), 'beta');
    await useWorkspace(db(), A.ws);
    for (const [t, id] of [['build_projects', A.projectId], ['build_runs', A.run], ['provider_connections', A.conn],
                           ['build_requirements', A.req], ['build_assets', A.asset], ['cost_events', A.costId]] as const) {
      expect(await failure(db(), `UPDATE ${t} SET workspace_id = $2 WHERE id = $1`, [id, b]), t).toMatch(/cannot move|withdrawn, never edited/);
    }
  });

  it('shows workspace B none of workspace A\'s projects, versions, runs, connections, costs, searches or context', async () => {
    const A = await populateA(db());
    const b = await enterNewWorkspace(db(), 'beta');
    const B = await populateA(db());
    await asApp(db(), b, async () => {
      for (const t of ['build_projects', 'builds', 'build_runs', 'provider_connections', 'build_requirements', 'build_assets', 'cost_events', 'searches']) {
        const other = await one<{ n: string }>(db(), `SELECT count(*) AS n FROM ${t} WHERE workspace_id <> $1`, [b]);
        expect(other.n, `${t} leaks another workspace's rows`).toBe('0');
      }
      expect((await db().query('SELECT build_id FROM v_build_versions')).rows.map((r) => String(r.build_id))).toEqual([B.v]);
      expect(await getBuildProject(db(), A.projectId)).toBeNull();
      expect(await getBuildRun(db(), A.run)).toBeNull();
      expect(await listBuildVersions(db(), { projectId: A.projectId })).toEqual([]);
      expect(await listBuildVersions(db(), { opportunityId: A.opp })).toEqual([]);
      expect(await getSearch(db(), A.searchId)).toBeNull();
      expect((await listProviderConnections(db())).map((c) => c.connectionId)).toEqual([B.conn]);
      expect((await getBuildProject(db(), B.projectId))!.projectId).toBe(B.projectId);
    });
    // The owner connection bypasses row-level security, and the seams still read another workspace's rows as missing.
    expect(await refused(db(), () => loadBuildContext(db(), A.projectId, { purpose: 'DEMO' }))).toMatch(/does not exist in this workspace/);
    expect(await refused(db(), () => executeBuildRun(db(), deps(), A.run))).toMatch(/does not exist in this workspace/);
    expect(await getBuildProject(db(), A.projectId)).toBeNull();
    expect(await getBuildRun(db(), A.run)).toBeNull();
    expect(await getSearch(db(), A.searchId)).toBeNull();
    expect(await refused(db(), () => createBuildProject(db(), { opportunityId: A.opp, title: 'steal' }))).toMatch(/expected one row, got 0/);
  });

  it('keeps every new table under row-level security with the workspace guard', async () => {
    const tables = ['provider_connections', 'build_projects', 'build_requirements', 'build_assets', 'build_runs'];
    const rls = (await db().query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'scopely' AND relrowsecurity AND relname = ANY ($1)`, [tables])).rows.map((r) => r.relname).sort();
    expect(rls).toEqual([...tables].sort());
    const guarded = (await db().query(`SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = 'a00_workspace_guard' AND c.relname = ANY ($1)`, [tables])).rows.map((r) => r.relname).sort();
    expect(guarded).toEqual([...tables].sort());
  });
});

// ================================================================== every rule of 009 is exercised
// These close the gaps a mutation run of migration 009 found: each assertion fails when the one
// clause or constraint it names is removed.

describe('every guard clause and constraint of the Build Workspace holds on its own', () => {
  it('keeps a withdrawn requirement or asset withdrawn', async () => {
    const s = await seedProject(db());
    const r = await recordRequirement(db(), { projectId: s.projectId, requirement: 'Mobile first', source: 'seller', recordedBy: 'operator' });
    await db().query('UPDATE build_requirements SET withdrawn_at = now() WHERE id = $1', [r]);
    expect(await failure(db(), 'UPDATE build_requirements SET withdrawn_at = NULL WHERE id = $1', [r])).toMatch(/withdrawn build_requirements row stays withdrawn/);
  });

  it('refuses a version that names its own project yet supersedes a version of another project', async () => {
    const s = await seedProject(db());
    const other = await createBuildProject(db(), { opportunityId: s.opp, title: 'Second effort' });
    const v1 = await version(db(), s);
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DEMO', v1, other, null, null, null])).toMatch(/only supersede a version of its own project/);
  });

  it('never moves a run backwards, and a DEMO run never produces a DELIVERY version', async () => {
    const s = await seedProject(db());
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    await db().query(`UPDATE build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [run]);
    expect(await failure(db(), `UPDATE build_runs SET status = 'QUEUED' WHERE id = $1`, [run])).toMatch(/cannot move from RUNNING to QUEUED/);
    await win(db(), s.opp);
    const delivery = await version(db(), s, { purpose: 'DELIVERY' });
    expect(await failure(db(), `UPDATE build_runs SET status = 'SUCCEEDED', finished_at = now(), produced_build_id = $2 WHERE id = $1`, [run, delivery]))
      .toMatch(/DEMO run cannot produce a DELIVERY version/);
    // A version is produced by one run at most.
    const draft = await version(db(), s);
    await db().query(`UPDATE build_runs SET status = 'SUCCEEDED', finished_at = now(), produced_build_id = $2 WHERE id = $1`, [run, draft]);
    const second = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    await db().query(`UPDATE build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [second]);
    expect(await failure(db(), `UPDATE build_runs SET status = 'SUCCEEDED', finished_at = now(), produced_build_id = $2 WHERE id = $1`, [second, draft]))
      .toMatch(/build_runs_produced_build_id_key/);
  });

  it('keeps a cost\'s build and run in the same project', async () => {
    const s = await seedProject(db());
    const other = await createBuildProject(db(), { opportunityId: s.opp, title: 'Second effort' });
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    const elsewhere = await version(db(), s, { projectId: other });
    expect(await failure(db(), `INSERT INTO cost_events (opportunity_id, kind, build_run_id, build_id) VALUES ($1, 'agent_run', $2, $3)`, [s.opp, run, elsewhere]))
      .toMatch(/belong to different projects/);
  });

  it('refuses malformed provider connections', async () => {
    const pc = (cols: string, vals: string) => failure(db(), `INSERT INTO provider_connections (provider, mode, scopes${cols}) VALUES ('example_ai', 'SCOPELY_MANAGED', '{build}'${vals})`);
    expect(await pc('', '')).toBeNull();
    expect(await failure(db(), `INSERT INTO provider_connections (provider, mode, scopes) VALUES ('Example AI', 'SCOPELY_MANAGED', '{build}')`)).toMatch(/provider_connections_provider_check/);
    expect(await failure(db(), `INSERT INTO provider_connections (provider, mode, scopes) VALUES ('example_ai', 'SHARED', '{build}')`)).toMatch(/provider_connections_mode_check/);
    expect(await pc(', state', `, 'LIVE'`)).toMatch(/provider_connections_state_check/);
    expect(await failure(db(), `INSERT INTO provider_connections (provider, mode, scopes) VALUES ('example_ai', 'SCOPELY_MANAGED', '{}')`)).toMatch(/provider_connections_scopes_check/);
    expect(await failure(db(), `INSERT INTO provider_connections (provider, mode, scopes) VALUES ('example_ai', 'SCOPELY_MANAGED', '{deploy}')`)).toMatch(/provider_connections_scopes_check/);
    expect(await pc(', display_name', `, '  '`)).toMatch(/provider_connections_display_name_check/);
    expect(await pc(', state', `, 'ACTIVE'`)).toMatch(/provider_connections_check/);
    expect(await pc(', state', `, 'REVOKED'`)).toMatch(/provider_connections_check/);
    expect(await pc(', state, activated_at, revoked_at', `, 'REVOKED', now(), now()`)).toBeNull();
  });

  it('refuses blank or unknown values on projects, requirements and assets', async () => {
    const s = await seedProject(db());
    expect(await failure(db(), `INSERT INTO build_projects (opportunity_id, build_kind, title) VALUES ($1, 'website_fix', ' ')`, [s.opp])).toMatch(/build_projects_title_check/);
    const req = (requirement: string, source: string, by: string) => failure(db(),
      'INSERT INTO build_requirements (project_id, requirement, source, recorded_by) VALUES ($1, $2, $3, $4)', [s.projectId, requirement, source, by]);
    expect(await req('Mobile first', 'seller', 'operator')).toBeNull();
    expect(await req(' ', 'seller', 'operator')).toMatch(/build_requirements_requirement_check/);
    expect(await req('Mobile first', 'agent', 'operator')).toMatch(/build_requirements_source_check/);
    expect(await req('Mobile first', 'seller', ' ')).toMatch(/build_requirements_recorded_by_check/);
    const ref = `workspaces/${s.ws}/projects/${s.projectId}/assets/logo.svg`;
    const asset = (kind: string, sha: string | null, description: string, providedBy: string, by: string) => failure(db(),
      `INSERT INTO build_assets (project_id, kind, storage_ref, sha256, description, provided_by, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [s.projectId, kind, ref, sha, description, providedBy, by]);
    expect(await asset('logo', 'a'.repeat(64), 'Client logo', 'client', 'operator')).toBeNull();
    expect(await asset('video', null, 'Client logo', 'client', 'operator')).toMatch(/build_assets_kind_check/);
    expect(await asset('logo', 'not-a-hash', 'Client logo', 'client', 'operator')).toMatch(/build_assets_sha256_check/);
    expect(await asset('logo', null, ' ', 'client', 'operator')).toMatch(/build_assets_description_check/);
    expect(await asset('logo', null, 'Client logo', 'agent', 'operator')).toMatch(/build_assets_provided_by_check/);
    expect(await asset('logo', null, 'Client logo', 'client', ' ')).toMatch(/build_assets_recorded_by_check/);
  });

  it('refuses a non-positive version number and a manifest hash that is malformed or has no manifest', async () => {
    const s = await seedProject(db());
    const manifest = `workspaces/${s.ws}/projects/${s.projectId}/versions/1/manifest.json`;
    expect(await failure(db(), insertVersion, [s.opp, s.cat, 'DEMO', null, s.projectId, null, 0, null])).toMatch(/builds_version_no_check/);
    const withSha = `WITH b AS (${insertVersion.replace('manifest_ref)', 'manifest_ref, manifest_sha256)').replace('$8)', '$8, $9)')})
      INSERT INTO build_evidence (build_id, evidence_id) SELECT id, $10 FROM b`;
    expect(await failure(db(), withSha, [s.opp, s.cat, 'DEMO', null, s.projectId, null, null, manifest, 'b'.repeat(64), s.c.evidenceId])).toBeNull();
    expect(await failure(db(), withSha, [s.opp, s.cat, 'DEMO', null, s.projectId, null, null, manifest, 'nope', s.c.evidenceId])).toMatch(/builds_manifest_sha256_check/);
    expect(await failure(db(), withSha, [s.opp, s.cat, 'DEMO', null, s.projectId, null, null, null, 'b'.repeat(64), s.c.evidenceId])).toMatch(/builds_manifest_sha_check/);
  });

  it('refuses a run whose fields contradict its status or each other', async () => {
    const s = await seedProject(db());
    const ins = (cols: string, vals: string) => failure(db(), `INSERT INTO build_runs (project_id, purpose, agent_key${cols}) VALUES ($1, $2, $3${vals})`,
      [s.projectId, 'DEMO', 'stub_agent']);
    expect(await ins('', '')).toBeNull();
    expect(await failure(db(), `INSERT INTO build_runs (project_id, purpose, agent_key) VALUES ($1, 'PITCH', 'stub_agent')`, [s.projectId])).toMatch(/build_runs_purpose_check/);
    expect(await failure(db(), `INSERT INTO build_runs (project_id, purpose, agent_key) VALUES ($1, 'DEMO', 'Stub Agent')`, [s.projectId])).toMatch(/build_runs_agent_key_check/);
    expect(await ins(', agent_version', `, ' '`)).toMatch(/build_runs_agent_version_check/);
    expect(await ins(', meta', `, '[]'`)).toMatch(/build_runs_meta_check/);
    expect(await ins(', queued_at, status, finished_at', `, now(), 'QUEUED', now()`)).toMatch(/build_runs_check/);
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    const upd = (set: string) => failure(db(), `UPDATE build_runs SET ${set} WHERE id = $1`, [run]);
    expect(await upd(`status = 'BOGUS'`)).toMatch(/build_runs_status_check|cannot move/);
    expect(await upd(`status = 'CANCELLED'`)).toMatch(/build_runs_check/);
    expect(await upd(`status = 'RUNNING', started_at = queued_at - interval '1 minute'`)).toMatch(/build_runs_check/);
    expect(await upd(`status = 'RUNNING', started_at = now(), error_code = 'EARLY'`)).toMatch(/build_runs_check/);
    await db().query(`UPDATE build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [run]);
    expect(await upd(`status = 'CANCELLED', finished_at = started_at - interval '1 minute'`)).toMatch(/build_runs_check/);
    expect(await upd(`status = 'SUCCEEDED', finished_at = now()`)).toMatch(/build_runs_check/);
    expect(await upd(`status = 'CANCELLED', finished_at = now(), error_code = 'not a code'`)).toMatch(/build_runs_error_code_check/);
    expect(await upd(`status = 'CANCELLED', finished_at = now(), error_code = 'OPERATOR_STOPPED'`)).toBeNull();
  });

  it('refuses an unknown payer or a malformed provider on a cost', async () => {
    const s = await seedProject(db());
    const cost = (billedTo: string | null, provider: string | null) => failure(db(),
      `INSERT INTO cost_events (opportunity_id, kind, billed_to, provider) VALUES ($1, 'llm_call', $2, $3)`, [s.opp, billedTo, provider]);
    expect(await cost('SCOPELY', 'example_ai')).toBeNull();
    expect(await cost('CLIENT', 'example_ai')).toMatch(/cost_events_billed_to_check/);
    expect(await cost('SCOPELY', 'Example AI')).toMatch(/cost_events_provider_check/);
  });

  it('keeps its backstop constraints when the guard in front of each is switched off', async () => {
    // Each of these is normally refused earlier by a trigger with a clearer message. With triggers
    // off (replica mode, test only), the constraint underneath still refuses the same row.
    const s = await seedProject(db());
    const v1 = await version(db(), s);
    await version(db(), s, { supersedes: v1 });
    const run = await queueBuildRun(db(), { projectId: s.projectId, purpose: 'DEMO', agentKey: 'stub_agent' });
    await db().query(`SET LOCAL session_replication_role = replica`);
    try {
      expect(await failure(db(), `INSERT INTO builds (workspace_id, opportunity_id, catalog_item_id, build_kind, purpose, title, summary, generator,
        supersedes_build_id, project_id, version_no) VALUES ($1, $2, $3, 'website_fix', 'DEMO', 't', 's', 'operator', $4, $5, 9)`,
        [s.ws, s.opp, s.cat, v1, s.projectId])).toMatch(/builds_one_successor_uq/);
      expect(await failure(db(), `UPDATE build_runs SET status = 'PAUSED', started_at = now() WHERE id = $1`, [run])).toMatch(/build_runs_status_check/);
      expect(await failure(db(), `INSERT INTO cost_events (workspace_id, kind, build_run_id) VALUES ($1, 'agent_run', $2)`, [s.ws, run]))
        .toMatch(/cost_events_build_run_check/);
    } finally {
      await db().query(`SET LOCAL session_replication_role = origin`);
    }
  });

  it('names every reason a version cannot be approved or shown', async () => {
    const s = await seedProject(db());
    const gateOf = async (id: string, asOf = '2026-10-01T12:00:00Z') =>
      (await listBuildVersions(db(), { projectId: s.projectId }, { asOf })).find((v) => v.buildId === id)!.gate;
    // Inside the recording transaction, before its evidence is linked.
    const bare = await one<{ id: string }>(db(), insertVersion, [s.opp, s.cat, 'DEMO', null, s.projectId, null, null, null]);
    expect(await gateOf(bare.id)).toMatchObject({ canApprove: false, approveBlocker: 'cites no evidence' });
    await db().query('INSERT INTO build_evidence (build_id, evidence_id) VALUES ($1, $2)', [bare.id, s.c.evidenceId]);
    const noPreview = await one<{ id: string }>(db(), `WITH b AS (${insertVersion.replace("'preview/1'", 'NULL')})
      INSERT INTO build_evidence (build_id, evidence_id) SELECT id, $9 FROM b RETURNING build_id AS id`,
      [s.opp, s.cat, 'DEMO', null, s.projectId, null, null, null, s.c.evidenceId]);
    expect(await gateOf(noPreview.id)).toMatchObject({ canApprove: false, approveBlocker: 'has no artifact to approve' });
    const v = await version(db(), s);
    await db().query(approve, [v]);
    expect((await gateOf(v, '2026-10-01T09:00:00Z')).showBlocker).toBe('cannot be shown before it was approved');
    const dropped = await version(db(), s);
    await db().query(`UPDATE builds SET status = 'DISCARDED' WHERE id = $1`, [dropped]);
    expect(await gateOf(dropped)).toMatchObject({ canShow: false, showBlocker: 'discarded' });
    expect(await refused(db(), () => recordRequirement(db(), { projectId: s.projectId, requirement: 'Use this: -----BEGIN RSA PRIVATE KEY-----',
      source: 'client', recordedBy: 'operator' }))).toMatch(/SECRET: /);
    // Last, because this row cannot commit: approved inside its recording transaction before any evidence is linked.
    const unlinked = await one<{ id: string }>(db(), insertVersion, [s.opp, s.cat, 'DEMO', null, s.projectId, null, null, null]);
    await db().query(approve, [unlinked.id]);
    expect(await gateOf(unlinked.id)).toMatchObject({ canShow: false, showBlocker: 'cites no evidence' });
  });

  it('refuses, through row-level security, a row written for another workspace', async () => {
    const a = await current(db());
    const b = await enterNewWorkspace(db(), 'beta');
    await useWorkspace(db(), a);
    const msg = await asApp(db(), a, () => failure(db(),
      `INSERT INTO provider_connections (workspace_id, provider, mode, scopes) VALUES ($1, 'example_ai', 'SCOPELY_MANAGED', '{build}')`, [b]));
    expect(msg).toMatch(/row-level security|WORKSPACE: /);
  });
});
