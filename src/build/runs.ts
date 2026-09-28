// Build projects and build runs.
//
// A project is one build effort for one mapped opportunity. A run is one attempt by a build agent
// to produce a version of it (or modify one). The executor below is the only code that turns an
// agent's result into a row, and it can only write a DRAFT version: it records the version while
// the request acts as a build agent (scopely.actor_kind = 'build_agent'), so the database refuses
// any approval, show, discard, outcome, verification, re-check or message in that step. Approval
// and showing stay with approveBuild / markBuildShown, called for a person.
//
// No agent or model provider is registered by default; nothing here calls a model.
import type { Db } from '../tenancy/index.js';
import type { BuildAgentRegistry, ModelProvider, ModelProviderRegistry, ProviderConnectionHandle, SecretResolver } from './agents.js';
import { assertNoSecrets, loadBuildContext } from './context.js';
import type { BuilderRegistry } from './index.js';

const one = async <T>(db: Db, sql: string, params: unknown[]): Promise<T> => {
  const r = await db.query(sql, params);
  if (r.rows.length !== 1) throw new Error(`expected one row, got ${r.rows.length}`);
  return r.rows[0] as T;
};

// ------------------------------------------------------------------ projects

/** Opens a build project for a mapped opportunity; the build kind is the opportunity's service's kind. */
export async function createBuildProject(db: Db, p: { opportunityId: string; title: string; createdByUserId?: string | null }): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.build_projects (opportunity_id, build_kind, title, created_by_user_id)
     SELECT o.id, ci.build_kind, $2, $3 FROM scopely.opportunities o LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id
      WHERE o.id = $1 AND o.workspace_id = scopely.current_workspace_id()
     RETURNING id`, [p.opportunityId, p.title, p.createdByUserId ?? null])).id;
}

export async function recordRequirement(db: Db, r: { projectId: string; requirement: string; source: 'seller' | 'client'; recordedBy: string }): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.build_requirements (project_id, requirement, source, recorded_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [r.projectId, r.requirement, r.source, r.recordedBy])).id;
}

export async function recordAsset(db: Db, a: { projectId: string; kind: string; storageRef: string; sha256?: string | null;
  description: string; providedBy: 'seller' | 'client'; recordedBy: string }): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.build_assets (project_id, kind, storage_ref, sha256, description, provided_by, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [a.projectId, a.kind, a.storageRef, a.sha256 ?? null, a.description, a.providedBy, a.recordedBy])).id;
}

// ------------------------------------------------------------------ runs

export interface BuildRunInput {
  projectId: string;
  purpose: 'DEMO' | 'DELIVERY';
  agentKey: string;
  agentVersion?: string | null;
  providerConnectionId?: string | null;
  /** The version to modify. The run's version will supersede it. */
  baseBuildId?: string | null;
  startedByUserId?: string | null;
}

export async function queueBuildRun(db: Db, r: BuildRunInput): Promise<string> {
  return (await one<{ id: string }>(db,
    `INSERT INTO scopely.build_runs (project_id, purpose, agent_key, agent_version, provider_connection_id, base_build_id, started_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [r.projectId, r.purpose, r.agentKey, r.agentVersion ?? null, r.providerConnectionId ?? null, r.baseBuildId ?? null,
     r.startedByUserId ?? null])).id;
}

export async function cancelBuildRun(db: Db, runId: string, errorCode?: string): Promise<void> {
  await db.query(`UPDATE scopely.build_runs SET status = 'CANCELLED', finished_at = now(), error_code = $2
                   WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [runId, errorCode ?? null]);
}

/** A failure the executor records on the run as its error code. */
export class BuildRunError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/**
 * Runs `fn` with the request acting as a build agent, then restores the prior actor. The
 * database refuses every human gate while this is set.
 */
export async function withAgentActor<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const prior = (await db.query<{ a: string | null }>(`SELECT current_setting('scopely.actor_kind', true) AS a`)).rows[0]!.a;
  await db.query(`SELECT set_config('scopely.actor_kind', 'build_agent', true)`);
  try {
    return await fn();
  } finally {
    await db.query(`SELECT set_config('scopely.actor_kind', $1, true)`, [prior ?? '']);
  }
}

export interface BuildRunDeps {
  builders: BuilderRegistry;
  agents: BuildAgentRegistry;
  providers?: ModelProviderRegistry;
  secrets?: SecretResolver;
}

/**
 * Executes one QUEUED run of the request's workspace: marks it RUNNING, loads the BuildContext,
 * asks the kind's FixBuilder for instructions, hands both to the run's agent (with a model from
 * the run's provider connection when the agent uses one), then records the result as a DRAFT
 * version plus one cost event per reported model use, billed to whoever holds the key. Any
 * failure rolls back the partial version and marks the run FAILED with an error code.
 * The caller owns the transaction.
 */
export async function executeBuildRun(db: Db, deps: BuildRunDeps, runId: string): Promise<{ status: 'SUCCEEDED' | 'FAILED'; buildId: string | null; errorCode: string | null }> {
  const run = (await db.query(
    `SELECT r.*, p.opportunity_id, p.build_kind, o.catalog_item_id
       FROM scopely.build_runs r JOIN scopely.build_projects p ON p.id = r.project_id JOIN scopely.opportunities o ON o.id = p.opportunity_id
      WHERE r.id = $1 AND r.workspace_id = scopely.current_workspace_id()`, [runId])).rows[0];
  if (!run) throw new Error(`build run ${runId} does not exist in this workspace`);
  if (run.status !== 'QUEUED') throw new Error(`build run ${runId} is ${run.status}; only a QUEUED run can start`);
  await db.query(`UPDATE scopely.build_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [runId]);

  await db.query('SAVEPOINT build_run');
  try {
    if (!deps.agents.has(run.agent_key)) throw new BuildRunError('AGENT_NOT_AVAILABLE', `no build agent ${run.agent_key}`);
    const agent = deps.agents.get(run.agent_key);
    const builder = deps.builders.get(run.build_kind);
    if (!builder.instruct) throw new BuildRunError('BUILDER_CANNOT_INSTRUCT', `the ${run.build_kind} builder cannot instruct an agent`);
    const context = await loadBuildContext(db, String(run.project_id), { purpose: run.purpose, baseBuildId: run.base_build_id ? String(run.base_build_id) : null });
    const instructions = await builder.instruct(context);
    await assertNoSecrets(db, 'build instructions', instructions);

    let conn: ProviderConnectionHandle | null = null;
    let model: ModelProvider | null = null;
    if (run.provider_connection_id) {
      const c = (await db.query(`SELECT * FROM scopely.provider_connections WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`,
        [run.provider_connection_id])).rows[0];
      conn = { connectionId: String(c.id), provider: c.provider, mode: c.mode, scopes: c.scopes, credentialRef: c.credential_ref };
    }
    if (agent.modelUse === 'PROVIDER_CONNECTION') {
      if (!conn) throw new BuildRunError('NO_PROVIDER_CONNECTION', `agent ${agent.key} needs a provider connection`);
      if (!deps.providers?.has(conn.provider) || !deps.secrets) throw new BuildRunError('PROVIDER_NOT_AVAILABLE', `no model provider ${conn.provider}`);
      model = deps.providers.get(conn.provider).open(conn, deps.secrets);
    }

    const storagePrefix = context.project.storagePrefix;
    const result = await agent.run({ runId: String(runId), context, instructions,
      project: { projectId: String(run.project_id), storagePrefix, workPrefix: `${storagePrefix}versions/run-${runId}/` } }, model);
    await assertNoSecrets(db, 'agent result', result);

    const buildId = await withAgentActor(db, async () => {
      const b = await one<{ id: string }>(db,
        `INSERT INTO scopely.builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, artifact_ref, artifact_sha256,
           manifest_ref, manifest_sha256, generator, supersedes_build_id, project_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [run.opportunity_id, run.catalog_item_id, run.build_kind, run.purpose, result.title, result.summary,
         result.previewRef ?? null, result.previewSha256 ?? null, result.manifestRef, result.manifestSha256 ?? null,
         `agent:${agent.key}:${agent.version}`, run.base_build_id, run.project_id]);
      for (const e of context.evidence) {
        await db.query('INSERT INTO scopely.build_evidence (build_id, evidence_id) VALUES ($1, $2)', [b.id, e.evidenceId]);
      }
      return b.id;
    });

    // Model use is costed only through a workspace connection. An agent that brings its own model
    // is billed outside Scopely, so no payer can be recorded here for it.
    if (conn) {
      for (const u of result.usage) {
        await db.query(
          `INSERT INTO scopely.cost_events (opportunity_id, build_id, build_run_id, kind, tokens_in, tokens_out, amount, currency,
             provider, provider_connection_id, billed_to, meta)
           VALUES ($1, $2, $3, 'llm_call', $4, $5, $6, $7, $8, $9, $10, $11)`,
          [run.opportunity_id, buildId, runId, u.tokensIn, u.tokensOut, u.cost.amount, u.cost.amount === null ? null : u.cost.currency,
           conn.provider, conn.connectionId, conn.mode === 'CUSTOMER_KEY' ? 'WORKSPACE' : 'SCOPELY', { model: u.model }]);
      }
    }
    await db.query(`UPDATE scopely.build_runs SET status = 'SUCCEEDED', finished_at = now(), produced_build_id = $2 WHERE id = $1`, [runId, buildId]);
    await db.query('RELEASE SAVEPOINT build_run');
    return { status: 'SUCCEEDED', buildId, errorCode: null };
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT build_run');
    // A database refusal (a guard or constraint) means the version could not be recorded as returned.
    const sqlState = (err as { code?: unknown }).code;
    const code = err instanceof BuildRunError ? err.code
      : typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? 'VERSION_REFUSED' : 'AGENT_ERROR';
    // The error's message may quote agent output; only the code is stored.
    await db.query(`UPDATE scopely.build_runs SET status = 'FAILED', finished_at = now(), error_code = $2 WHERE id = $1`, [runId, code]);
    return { status: 'FAILED', buildId: null, errorCode: code };
  }
}
