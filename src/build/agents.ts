// The three build roles, kept apart. Interfaces and empty registries only: no agent, model
// provider or secret store is implemented, and nothing here calls a model.
//
//   FixBuilder     WHAT to build. Keyed by build kind (website, website_fix, booking_flow, ...).
//                  Turns a BuildContext into structured instructions and owns the kind's rules.
//   BuildAgent     HOW the work is executed: a Scopely-managed agent, Claude Code, Codex, another
//                  coding agent or an external build tool. Chosen per run, independent of the kind.
//                  It may use no model, its own model (billed outside Scopely), or a model from
//                  one of the workspace's provider connections.
//   ModelProvider  WHICH model API powers a call: Scopely-managed, Anthropic, OpenAI, Google or
//                  another. Opened from a provider connection; it never exposes the key.
//
// An agent receives the context, the instructions and a handle to its project's storage prefix.
// It never receives a database handle, so it cannot approve, show or deliver anything; the run
// executor records what it returns as a DRAFT version (see runs.ts).
import type { ProjectFiles } from '../storage/index.js';
import type { BuildContext } from './context.js';

export interface BuildInstructions {
  buildKind: string;
  purpose: 'DEMO' | 'DELIVERY';
  /** What the version must achieve, in plain words. */
  objective: string;
  /** Each task names the evidence it addresses, so every change traces to something observed. */
  tasks: { title: string; addressesEvidenceIds: string[] }[];
  constraints: string[];
  /** Things the output must not assert: NOT_OBSERVABLE items and withheld facts. */
  mustNotClaim: string[];
}

/** Handle to the project's future storage. A key prefix inside the workspace's own namespace, not a URL. */
export interface ProjectHandle {
  projectId: string;
  storagePrefix: string;
  /** Where this run writes its version manifest and files: `${storagePrefix}versions/run-<runId>/`. */
  workPrefix: string;
  /**
   * Project storage when the executor has a store: reads anywhere in this project, writes only
   * under `workPrefix`. Never another project's or workspace's files.
   */
  files?: ProjectFiles;
}

// ------------------------------------------------------------------ ModelProvider

export interface ModelUsage {
  provider: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** What the provider reported it cost, if it did. Unknown stays null; no price is assumed. */
  cost: { amount: string | null; currency: string | null };
}

export interface ModelRequest {
  purpose: 'build';
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
}

export interface ModelProvider {
  provider: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** A provider connection as a worker sees it: a reference to a secret, never the secret. */
export interface ProviderConnectionHandle {
  connectionId: string;
  provider: string;
  mode: 'SCOPELY_MANAGED' | 'CUSTOMER_KEY';
  scopes: string[];
  credentialRef: string | null;
}

/**
 * The future secret store. A key is resolved at call time, used in memory inside `use`, and
 * dropped. It is never returned, logged, stored in a row, put in a BuildContext or written into
 * a generated project. Build-time credentials never share a namespace with runtime website secrets.
 */
export interface SecretResolver {
  withSecret<T>(credentialRef: string, use: (secret: string) => Promise<T>): Promise<T>;
}

export interface ModelProviderFactory {
  provider: string;
  open(connection: ProviderConnectionHandle, secrets: SecretResolver): ModelProvider;
}

// ------------------------------------------------------------------ BuildAgent

/** How an agent gets its model, which decides who pays for model use. */
export type AgentModelUse =
  | 'NONE'                  // no model at all (e.g. a deterministic template tool)
  | 'OWN_MODEL'             // the agent brings its own model and billing; Scopely records no provider cost
  | 'PROVIDER_CONNECTION';  // the agent uses the run's workspace provider connection

export interface BuildAgentTask {
  runId: string;
  context: BuildContext;
  instructions: BuildInstructions;
  project: ProjectHandle;
  /** The run's own parameters as queued (for example a template key or an edit request). Never a credential. */
  meta: Record<string, unknown>;
}

export interface BuildAgentResult {
  title: string;
  summary: string;
  /** The version's manifest, inside `project.workPrefix`. */
  manifestRef: string;
  manifestSha256?: string;
  /** A preview of the built thing, when the agent made one. Never invented. */
  previewRef?: string;
  previewSha256?: string;
  usage: ModelUsage[];
}

export interface BuildAgent {
  key: string;
  version: string;
  modelUse: AgentModelUse;
  run(task: BuildAgentTask, model: ModelProvider | null): Promise<BuildAgentResult>;
}

// ------------------------------------------------------------------ registries (empty by default)

class Registry<T> {
  private readonly items = new Map<string, T>();
  constructor(private readonly what: string, private readonly keyOf: (t: T) => string) {}
  register(item: T): void {
    const k = this.keyOf(item);
    if (this.items.has(k)) throw new Error(`a ${this.what} for ${k} is already registered`);
    this.items.set(k, item);
  }
  get(k: string): T {
    const item = this.items.get(k);
    if (!item) throw new Error(`no ${this.what} is available for ${k}`);
    return item;
  }
  has(k: string): boolean { return this.items.has(k); }
  keys(): string[] { return [...this.items.keys()].sort(); }
}

export class BuildAgentRegistry extends Registry<BuildAgent> {
  constructor() { super('build agent', (a) => a.key); }
}

export class ModelProviderRegistry extends Registry<ModelProviderFactory> {
  constructor() { super('model provider', (p) => p.provider); }
}
