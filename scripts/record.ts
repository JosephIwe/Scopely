// Operator CLI for manual validation. Each command reads one JSON object (from a file path, or
// stdin with '-') and writes it in its own transaction. It prints ids only, never contact
// details or message bodies. See docs/MANUAL_VALIDATION.md.
//
// Every command except `workspace` acts inside one workspace, named by SCOPELY_WORKSPACE_ID.
// There is no default workspace: without it the command refuses to run.
//
//   pnpm record workspace <file.json | ->          # provisions a workspace (and its owner)
//   SCOPELY_WORKSPACE_ID=<id> pnpm record <command> <file.json | ->
//   SCOPELY_WORKSPACE_ID=<id> pnpm record ledger    # v_opportunity_ledger as JSON
import { readFile } from 'node:fs/promises';
import { connect } from '../src/db/client.js';
import * as r from '../src/record/index.js';
import * as d from '../src/discovery/index.js';
import * as api from '../src/api/queries.js';
import { registerManualMailbox, listMailboxes } from '../src/sell/mailbox.js';
import { createWorkspace, withWorkspace } from '../src/tenancy/index.js';

type Db = Awaited<ReturnType<typeof connect>>;

const commands: Record<string, (db: Db, input: any) => Promise<unknown>> = {
  mailbox: (db, i) => registerManualMailbox(db, i),
  search: (db, i) => d.createSearch(db, i),
  'search-run': (db, i) => d.startSearchRun(db, i.searchId, i.startedByUserId),
  'complete-run': (db, i) => d.completeSearchRun(db, i.searchRunId, i.at, i.status),
  discovered: (db, i) => d.recordDiscoveredBusiness(db, i.searchRunId, i.business),
  prequalify: (db, i) => d.prequalifyRun(db, i.searchRunId, i.asOf ? new Date(i.asOf) : undefined),
  review: (db, i) => d.resolveReview(db, i.searchRunId, i.businessId, i),
  select: (db, i) => d.selectForAnalysis(db, i.searchRunId, i.picks, i.selectedBy, i.at),
  queue: (db, i) => d.queueForAnalysis(db, i.searchRunId, i.businessIds, i.at),
  analyzed: (db, i) => d.markAnalyzed(db, i.searchRunId, i.businessId, i.at),
  conclude: (db, i) => d.concludeAnalysis(db, i.searchRunId, i.businessId, i.at),
  prospect: (db, i) => r.recordProspect(db, i),
  qualify: (db, i) => r.qualifyBusiness(db, i.businessId),
  reject: (db, i) => r.rejectBusiness(db, i.businessId, i),
  snapshot: (db, i) => r.recordSnapshot(db, i),
  finding: (db, i) => r.recordFinding(db, i),
  recheck: (db, i) => r.recordRecheck(db, i),
  opportunity: (db, i) => r.recordOpportunity(db, i),
  contact: (db, i) => r.recordContact(db, i),
  message: (db, i) => r.recordMessage(db, i),
  'approve-message': (db, i) => r.approveMessage(db, i.messageId, i.approvedBy, i.approvedAt),
  'message-sent': (db, i) => r.markMessageSent(db, i.messageId, i.sentAt, i.mailboxConnectionId),
  outcome: (db, i) => r.recordOutcome(db, i),
  cost: (db, i) => r.recordCost(db, i),
};

const views: Record<string, (db: Db, arg: string | undefined) => Promise<unknown>> = {
  ledger: async (db) => (await db.query(`SELECT * FROM scopely.v_opportunity_ledger
    WHERE workspace_id = scopely.current_workspace_id() ORDER BY opportunity_id`)).rows,
  funnel: async (db) => (await db.query(`SELECT * FROM scopely.v_market_funnel
    WHERE workspace_id = scopely.current_workspace_id() ORDER BY market_id`)).rows,
  mailboxes: (db) => listMailboxes(db),
  'run-summary': (db, id) => api.getSearchRunSummary(db, need(id, 'search run id')),
  'run-funnel': (db, id) => api.getSearchRunStageFunnel(db, need(id, 'search run id')),
  'run-estimate': (db, id) => d.estimateRunAnalysis(db, need(id, 'search run id')),
  opportunities: (db) => api.listOpportunities(db),
};

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`give the ${what}`);
  return v;
}

async function readInput(arg: string | undefined): Promise<unknown> {
  if (!arg) throw new Error('give a JSON file path, or - for stdin');
  if (arg !== '-') return JSON.parse(await readFile(arg, 'utf8'));
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const [command, arg] = process.argv.slice(2);
if (!command || (command !== 'workspace' && !(command in commands) && !(command in views))) {
  console.error(`usage: pnpm record <workspace|${[...Object.keys(commands), ...Object.keys(views)].join('|')}> [file.json|-|id]`);
  process.exit(2);
}
const workspaceId = process.env.SCOPELY_WORKSPACE_ID;
if (command !== 'workspace' && !workspaceId) {
  console.error(JSON.stringify({ ok: false, command, error: 'set SCOPELY_WORKSPACE_ID: every record belongs to one workspace' }));
  process.exit(2);
}

const db = await connect();
try {
  const input = command in views ? undefined : await readInput(arg);
  await db.query('BEGIN');
  try {
    const result = command === 'workspace'
      ? await createWorkspace(db, input as Parameters<typeof createWorkspace>[1])
      : await withWorkspace(db, workspaceId!, () => (command in views ? views[command]!(db, arg) : commands[command]!(db, input)));
    await db.query('COMMIT');
    console.log(command in views ? JSON.stringify(result, null, 2) : JSON.stringify({ ok: true, command, result: result ?? null }));
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(JSON.stringify({ ok: false, command, error: (err as Error).message }));
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
