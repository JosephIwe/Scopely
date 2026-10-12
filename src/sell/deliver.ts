// DELIVER from the Case File (release 1, A44). A delivery is the existing `delivered` outcome in the
// append-only ledger (002/004), recorded by a named person after the work was done: who did it (the
// seller as operator, or the client), whether the client confirmed it, notes, and the day it
// happened. The ledger's own guards stay the judge: no delivery before a win, and CLIENT_REQUIRED
// work only as delivered by the client with their confirmation. Nothing here infers a delivery from a
// build, a shown demo or a finished run, and nothing records a cost or a payment.
import { recordOutcome } from '../record/index.js';
import type { Db } from '../tenancy/index.js';
import { occurredAt, OutcomeRejected } from './outcomes.js';

export class DeliveryRejected extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export const DELIVERED_BY = ['operator', 'client'] as const;

export interface DeliveryInput {
  /** The day the work was delivered, YYYY-MM-DD. */
  occurredOn: string;
  /** 'operator' (the seller did the work) or 'client' (the business did it). */
  deliveredBy: string;
  /** The client confirmed the work is done. Required for CLIENT_REQUIRED work (outcome_guard). */
  clientConfirmed?: boolean | null;
  notes?: string | null;
  recordedBy: string;
}

const text = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max) : null;
};

function plain(message: string): string | null {
  if (/delivery before a won outcome/.test(message)) return 'Record the win first. Only won work can be delivered.';
  if (/CLIENT_REQUIRED/.test(message)) return 'This service needs the business to do the work. Record it as delivered by the client, with their confirmation.';
  return null;
}

/** Records one delivery of this opportunity's work in the current workspace. Returns the outcome id. */
export async function recordDelivery(db: Db, opportunityId: string, input: DeliveryInput, now = new Date()): Promise<string> {
  if (!/^\d{1,18}$/.test(opportunityId)) throw new DeliveryRejected(404, 'That opportunity does not exist.');
  const opp = (await db.query(`SELECT id FROM scopely.opportunities WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`,
    [opportunityId])).rows[0];
  if (!opp) throw new DeliveryRejected(404, 'That opportunity does not exist.');
  const recordedBy = text(input.recordedBy, 120);
  if (!recordedBy) throw new DeliveryRejected(400, 'Say who is recording this.');
  const deliveredBy = String(input.deliveredBy ?? '');
  if (!(DELIVERED_BY as readonly string[]).includes(deliveredBy)) throw new DeliveryRejected(400, 'Say who did the work: you, or the client.');
  let at: string;
  try { at = occurredAt(String(input.occurredOn ?? ''), now); } catch (err) {
    if (err instanceof OutcomeRejected) throw new DeliveryRejected(400, err.message);
    throw err;
  }
  const notes = text(input.notes, 2000);
  await db.query('SAVEPOINT delivery');
  try {
    const id = await recordOutcome(db, { opportunityId: String(opp.id), kind: 'delivered', occurredAt: at, deliveredBy: deliveredBy as 'operator' | 'client',
      clientConfirmed: input.clientConfirmed === true ? true : input.clientConfirmed === false ? false : undefined, notes: notes ?? undefined, recordedBy });
    await db.query('RELEASE SAVEPOINT delivery');
    return id;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT delivery');
    const e = err as { code?: string; message?: string };
    if (e.code === '23514' || e.code === '23503') throw new DeliveryRejected(409, plain(String(e.message ?? '')) ?? 'That could not be recorded. Nothing was changed.');
    throw err;
  }
}
