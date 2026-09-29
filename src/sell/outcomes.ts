// Manual SELL recording (Slice 8, U4). Scopely sends nothing: the seller pitches from their own
// inbox, phone or in person, then records here what they did and what happened. Every record is
// one row in the append-only outcomes ledger (002/004/005), written through recordOutcome, so the
// ledger's own guards stay the judge: a pitch before a result, one result at a time, a correction
// by a voided row that names what it corrects, and the opportunity's currency.
//
// Nothing here infers a sale, a payment or an amount. A won outcome carries the amount the seller
// typed and nothing else; there is no default currency or price.
import { recordOutcome } from '../record/index.js';
import type { Db } from '../tenancy/index.js';

export class OutcomeRejected extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export const MANUAL_OUTCOME_KINDS = ['pitched', 'replied', 'call', 'won', 'lost', 'voided'] as const;
export type ManualOutcomeKind = (typeof MANUAL_OUTCOME_KINDS)[number];

/** How the seller reached the business. Recorded, never used to send. */
export const OUTREACH_CHANNELS = ['email', 'phone', 'in_person', 'linkedin', 'whatsapp', 'social', 'other'] as const;
export const REPLY_CLASSES = ['positive', 'question', 'pricing', 'not_now', 'not_interested', 'opt_out', 'wrong_person'] as const;

export interface ManualOutcomeInput {
  kind: string;
  /** The day it happened, YYYY-MM-DD, as the seller entered it. */
  occurredOn: string;
  recordedBy: string;
  channel?: string | null;
  replyClass?: string | null;
  /** Won only: the amount the seller agreed with the business. */
  amount?: string | number | null;
  /** Won only, and only when the opportunity has no currency yet. */
  currency?: string | null;
  notes?: string | null;
  /** Voided only: the won or lost outcome it corrects. */
  correctsOutcomeId?: string | null;
}

/** A day becomes a time: today (or the seller's today, ahead of UTC) is now; an earlier day is its UTC noon. */
export function occurredAt(day: string, now = new Date()): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) throw new OutcomeRejected(400, 'Enter the date it happened.');
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  if (day > tomorrow) throw new OutcomeRejected(400, 'That date is in the future. Record what has already happened.');
  if (day === today || day === tomorrow) return now.toISOString();
  return `${day}T12:00:00.000Z`;
}

const text = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max) : null;
};

/** The ledger's refusals, said plainly. Anything else is not the seller's to fix. */
function plain(message: string, currency: string | null): string | null {
  if (/before a pitched outcome/.test(message)) return 'Record the pitch first. A reply, win or loss follows a pitch.';
  if (/already has terminal outcome/.test(message)) return 'This opportunity is already marked won or lost. Correct that record first.';
  if (/currency .* differs/.test(message)) return `Use the opportunity’s currency${currency ? `, ${currency}` : ''}.`;
  if (/cannot void a win that a delivery rests on/.test(message)) return 'A delivery rests on this win, so it cannot be corrected here.';
  if (/is already voided/.test(message)) return 'That record has already been corrected.';
  if (/correction cannot predate/.test(message)) return 'A correction cannot be dated before the record it corrects.';
  if (/only a won or lost outcome can be voided|must name an outcome of the same opportunity/.test(message)) return 'Only a win or a loss on this opportunity can be corrected.';
  return null;
}

/** Records one thing the seller did or that happened, in the current workspace. Returns the new outcome's id. */
export async function recordManualOutcome(db: Db, opportunityId: string, input: ManualOutcomeInput, now = new Date()): Promise<string> {
  const opp = (await db.query(`SELECT id, currency FROM scopely.opportunities WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`,
    [opportunityId])).rows[0];
  if (!opp) throw new OutcomeRejected(404, 'That opportunity does not exist.');
  const kind = String(input.kind ?? '') as ManualOutcomeKind;
  // Delivery is planned (Deliver & verify), so it is never recorded from here.
  if (!MANUAL_OUTCOME_KINDS.includes(kind)) throw new OutcomeRejected(400, 'Choose what happened: a pitch, a reply, a call, a win, a loss or a correction.');
  const recordedBy = text(input.recordedBy, 120);
  if (!recordedBy) throw new OutcomeRejected(400, 'Say who is recording this.');
  const at = occurredAt(String(input.occurredOn ?? ''), now);
  const notes = text(input.notes, 2000);

  let channel: string | null = null;
  if (kind === 'pitched' || kind === 'replied' || kind === 'call') {
    channel = text(input.channel, 40);
    if (kind === 'pitched' && !channel) throw new OutcomeRejected(400, 'Say how you pitched: email, phone, in person or another channel.');
    if (channel && !(OUTREACH_CHANNELS as readonly string[]).includes(channel)) throw new OutcomeRejected(400, 'That is not a channel Scopely records.');
  }
  let replyClass: string | null = null;
  if (kind === 'replied') {
    replyClass = text(input.replyClass, 40);
    if (!replyClass || !(REPLY_CLASSES as readonly string[]).includes(replyClass)) throw new OutcomeRejected(400, 'Say what kind of reply it was.');
  }
  let amount: number | undefined;
  let currency: string | undefined;
  if (kind === 'won') {
    const raw = String(input.amount ?? '').replace(/[\s,]/g, '');
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) throw new OutcomeRejected(400, 'Enter the amount you agreed with the business.');
    amount = Number(raw);
    const typed = text(input.currency, 3)?.toUpperCase() ?? null;
    currency = opp.currency ?? typed ?? undefined;
    if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new OutcomeRejected(400, 'Enter the currency of the amount, for example GBP.');
    if (typed && opp.currency && typed !== opp.currency) throw new OutcomeRejected(409, `Use the opportunity’s currency, ${opp.currency}.`);
  } else if (input.amount !== undefined && input.amount !== null && String(input.amount).trim() !== '') {
    throw new OutcomeRejected(400, 'Only a win records an amount.');
  }
  let corrects: string | undefined;
  if (kind === 'voided') {
    corrects = /^\d{1,18}$/.test(String(input.correctsOutcomeId ?? '')) ? String(input.correctsOutcomeId) : undefined;
    if (!corrects) throw new OutcomeRejected(400, 'Choose the record to correct.');
    if (!notes) throw new OutcomeRejected(400, 'Say why the record was wrong.');
  }

  // A savepoint keeps the caller's transaction usable when the ledger refuses.
  await db.query('SAVEPOINT manual_outcome');
  try {
    const id = await recordOutcome(db, {
      opportunityId: String(opp.id), kind, occurredAt: at, recordedBy, channel: channel ?? undefined, replyClass: replyClass ?? undefined,
      amount, currency, notes: notes ?? undefined, correctsOutcomeId: corrects,
    });
    await db.query('RELEASE SAVEPOINT manual_outcome');
    return id;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT manual_outcome');
    const e = err as { code?: string; message?: string };
    if (e.code === '23514' || e.code === '23503') {
      throw new OutcomeRejected(409, plain(String(e.message ?? ''), opp.currency) ?? 'That could not be recorded. Nothing was changed.');
    }
    throw err;
  }
}
