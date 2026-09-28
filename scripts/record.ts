// Operator CLI for the manual validation test. Each command reads one JSON object (from a file
// path, or stdin with '-') and writes it in its own transaction. It prints ids only, never
// contact details or message bodies. See docs/MANUAL_VALIDATION.md.
//
//   pnpm record <command> <file.json | ->
//   pnpm record ledger            # v_opportunity_ledger as JSON
//   pnpm record funnel            # v_market_funnel as JSON
import { readFile } from 'node:fs/promises';
import { connect } from '../src/db/client.js';
import * as r from '../src/record/index.js';

const commands: Record<string, (db: Awaited<ReturnType<typeof connect>>, input: any) => Promise<unknown>> = {
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
  'message-sent': (db, i) => r.markMessageSent(db, i.messageId, i.sentAt),
  outcome: (db, i) => r.recordOutcome(db, i),
  cost: (db, i) => r.recordCost(db, i),
};

const views: Record<string, string> = {
  ledger: 'SELECT * FROM scopely.v_opportunity_ledger ORDER BY opportunity_id',
  funnel: 'SELECT * FROM scopely.v_market_funnel ORDER BY market_id',
};

async function readInput(arg: string | undefined): Promise<unknown> {
  if (!arg) throw new Error('give a JSON file path, or - for stdin');
  if (arg !== '-') return JSON.parse(await readFile(arg, 'utf8'));
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const [command, arg] = process.argv.slice(2);
if (!command || (!(command in commands) && !(command in views))) {
  console.error(`usage: pnpm record <${[...Object.keys(commands), ...Object.keys(views)].join('|')}> [file.json|-]`);
  process.exit(2);
}

const db = await connect();
try {
  if (command in views) {
    console.log(JSON.stringify((await db.query(views[command]!)).rows, null, 2));
  } else {
    const input = await readInput(arg);
    await db.query('BEGIN');
    try {
      const result = await commands[command]!(db, input);
      await db.query('COMMIT');
      console.log(JSON.stringify({ ok: true, command, result: result ?? null }));
    } catch (err) {
      await db.query('ROLLBACK');
      console.error(JSON.stringify({ ok: false, command, error: (err as Error).message }));
      process.exitCode = 1;
    }
  }
} finally {
  await db.end();
}
