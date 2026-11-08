// P4: revenue counts only when money has actually been received (founder decision, 2026-11-07).
// pitched → replied → won → paid → delivered → verified. A win's amount is agreed value; a paid
// outcome is money received; the Case File shows quoted, agreed, paid and payment status apart.
import { describe, expect, it } from 'vitest';
import { recordManualOutcome } from '../src/sell/outcomes.js';
import { failure, one, seedChain, seedOpportunity, useDb } from './helpers.js';
import { useServer } from './server-helpers.js';

const { db } = useDb();
const start = useServer(db);

const ins = `INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, corrects_outcome_id, notes, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'operator') RETURNING id`;
const rec = async (opp: string, kind: string, at: string, amount: number | null = null, currency: string | null = amount === null ? null : 'GBP', corrects: string | null = null, notes: string | null = null) =>
  (await one<{ id: string }>(db(), ins, [opp, kind, at, amount, currency, corrects, notes])).id;
const tryRec = (opp: string, kind: string, at: string, amount: number | null = null, currency: string | null = amount === null ? null : 'GBP', corrects: string | null = null, notes: string | null = null) =>
  failure(db(), ins, [opp, kind, at, amount, currency, corrects, notes]);
const opp = async () => seedOpportunity(db(), await seedChain(db()));
const projection = (id: string) => one<{ deal_value: string | null; paid_amount: string | null; paid_at: Date | null; status: string; payment_status: string }>(db(),
  `SELECT deal_value, paid_amount, paid_at, status, scopely.payment_status(won_at, deal_value, paid_amount) AS payment_status FROM opportunities WHERE id = $1`, [id]);

describe('the paid outcome in the ledger', () => {
  it('needs a standing win, a positive amount and the opportunity’s currency; never converts', async () => {
    const o = await opp();
    expect(await tryRec(o, 'paid', '2026-10-02', 120)).toMatch(/payment before a won outcome/);
    await rec(o, 'pitched', '2026-10-01');
    expect(await tryRec(o, 'paid', '2026-10-02', 120)).toMatch(/payment before a won outcome/);
    await rec(o, 'won', '2026-10-03', 240);
    expect(await tryRec(o, 'paid', '2026-10-04', null, null)).toMatch(/check constraint/);
    expect(await tryRec(o, 'paid', '2026-10-04', 0)).toMatch(/check constraint/);
    expect(await tryRec(o, 'paid', '2026-10-04', 120, 'EUR')).toMatch(/currency EUR differs from opportunity currency GBP/);
    expect(await tryRec(o, 'paid', '2026-09-01', 120)).toMatch(/cannot predate the pitch/);
    expect(await tryRec(o, 'pitched', '2026-10-04', 120)).toMatch(/check constraint/);
  });

  it('a win alone is agreed value, not revenue; deposits and balances add up; status compares like with like', async () => {
    const o = await opp();
    await rec(o, 'pitched', '2026-10-01');
    await rec(o, 'won', '2026-10-03', 240);
    expect(await projection(o)).toMatchObject({ deal_value: '240.00', paid_amount: null, paid_at: null, status: 'WON', payment_status: 'awaiting_payment' });
    await rec(o, 'paid', '2026-10-05', 100);
    expect(await projection(o)).toMatchObject({ paid_amount: '100.00', payment_status: 'part_paid' });
    await rec(o, 'paid', '2026-10-09', 140);
    const p = await projection(o);
    expect(p).toMatchObject({ deal_value: '240.00', paid_amount: '240.00', payment_status: 'paid_in_full', status: 'WON' });
    expect(new Date(p.paid_at!).toISOString().slice(0, 10)).toBe('2026-10-05');
    await rec(o, 'paid', '2026-10-10', 20);
    expect((await projection(o)).payment_status).toBe('paid_more_than_agreed');
  });

  it('a wrong payment is corrected by a void, the projection is recomputed, and a win a payment rests on cannot be voided', async () => {
    const o = await opp();
    await rec(o, 'pitched', '2026-10-01');
    const win = await rec(o, 'won', '2026-10-03', 240);
    const pay = await rec(o, 'paid', '2026-10-05', 999);
    expect(await tryRec(o, 'voided', '2026-10-06', null, null, win, 'wrong client')).toMatch(/payment rests on/);
    await rec(o, 'voided', '2026-10-06', null, null, pay, 'Typed 999 instead of 240');
    expect(await projection(o)).toMatchObject({ paid_amount: null, paid_at: null, status: 'WON', payment_status: 'awaiting_payment' });
    expect(await tryRec(o, 'voided', '2026-10-07', null, null, pay, 'again')).toMatch(/already voided/);
    await rec(o, 'paid', '2026-10-07', 240);
    expect((await projection(o)).paid_amount).toBe('240.00');
    expect(await failure(db(), 'UPDATE outcomes SET amount = 1 WHERE id = $1', [pay])).toMatch(/append-only/);
  });

  it('money received changes only through the ledger', async () => {
    const o = await opp();
    expect(await failure(db(), 'UPDATE opportunities SET paid_amount = 500, paid_at = now() WHERE id = $1', [o])).toMatch(/money received comes from paid outcomes/);
    expect(await failure(db(), 'UPDATE opportunities SET paid_at = now() WHERE id = $1', [o])).toMatch(/money received|opportunities_paid_check/);
  });

  it('every revenue figure is money received; agreed value sits beside it; mixed currencies are never summed', async () => {
    const a = await opp();
    await rec(a, 'pitched', '2026-10-01');
    await rec(a, 'won', '2026-10-03', 240);
    const market = (await one<{ m: string }>(db(), 'SELECT market_id AS m FROM opportunities WHERE id = $1', [a])).m;
    const funnel = () => one(db(), 'SELECT revenue, revenue_currency, agreed_value, paid, gross_profit FROM v_market_funnel WHERE market_id = $1', [market]);
    expect(await funnel()).toMatchObject({ revenue: null, agreed_value: '240.00', paid: '0', gross_profit: null });
    await rec(a, 'paid', '2026-10-05', 100);
    expect(await funnel()).toMatchObject({ revenue: '100.00', revenue_currency: 'GBP', agreed_value: '240.00', paid: '1' });
    const ledger = await one(db(), 'SELECT deal_value, paid_amount, payment_status FROM v_opportunity_ledger WHERE opportunity_id = $1', [a]);
    expect(ledger).toEqual({ deal_value: '240.00', paid_amount: '100.00', payment_status: 'part_paid' });
    // A second opportunity in the same market, won and paid in another currency: no total is invented.
    const chain = await seedChain(db());
    const b = (await one<{ id: string }>(db(), `INSERT INTO opportunities (business_id, market_id, opportunity_type, mapping_status, unmapped_reason)
      VALUES ($1, $2, 'broken_contact_path', 'UNMAPPED', 'priced by hand') RETURNING id`, [chain.businessId, chain.marketId])).id;
    await rec(b, 'pitched', '2026-10-01');
    await rec(b, 'won', '2026-10-03', 300, 'EUR');
    await rec(b, 'paid', '2026-10-05', 300, 'EUR');
    expect(await funnel()).toMatchObject({ revenue: null, revenue_currency: null, agreed_value: null, paid: '2' });
  });
});

describe('recording a payment from the Case File', () => {
  it('records money received, shows quoted / agreed / paid / status apart, and corrects a payment', async () => {
    const o = await opp();
    const srv = await start();
    const post = (body: Record<string, unknown>) => srv.call('POST', `/api/opportunities/${o}/outcomes`, { recordedBy: 'Seller', occurredOn: '2026-10-01', ...body });
    expect((await post({ kind: 'pitched', channel: 'email' })).status).toBe(200);
    let cf = (await srv.call('GET', `/api/opportunities/${o}`)).json();
    expect(cf.sell).toMatchObject({ paymentStatus: 'not_won', paidAmount: null, can: { paid: false } });
    const bad = await post({ kind: 'paid', amount: '120' });
    expect(bad.status).toBe(409);
    expect(bad.json().error).toMatch(/Record the win/);
    expect((await post({ kind: 'won', amount: '240', currency: 'GBP', occurredOn: '2026-10-03' })).status).toBe(200);
    cf = (await srv.call('GET', `/api/opportunities/${o}`)).json();
    expect(cf.sell).toMatchObject({ quotedAmount: '120.00', agreedAmount: '240.00', paidAmount: null, paymentStatus: 'awaiting_payment', can: { paid: true } });
    expect((await post({ kind: 'paid', amount: '100', currency: 'EUR', occurredOn: '2026-10-05' })).json().error).toMatch(/never converts/);
    expect((await post({ kind: 'paid', amount: '0', occurredOn: '2026-10-05' })).json().error).toMatch(/actually paid/);
    expect((await post({ kind: 'paid', amount: '100', occurredOn: '2026-10-05' })).status).toBe(200);
    cf = (await srv.call('GET', `/api/opportunities/${o}`)).json();
    expect(cf.sell).toMatchObject({ quotedAmount: '120.00', agreedAmount: '240.00', paidAmount: '100.00', paymentStatus: 'part_paid', currency: 'GBP' });
    const pay = cf.sell.outcomes.find((x: { kind: string }) => x.kind === 'paid');
    expect(pay).toMatchObject({ amount: '100.00', currency: 'GBP', voided: false });
    expect(cf.sell.correctable).toEqual(expect.arrayContaining([pay.outcomeId, cf.sell.terminalOutcomeId]));
    // Correcting the win while a payment stands is refused in plain words; the payment can be corrected.
    expect((await post({ kind: 'voided', correctsOutcomeId: cf.sell.terminalOutcomeId, notes: 'x', occurredOn: '2026-10-06' })).json().error).toMatch(/Correct the payment first/);
    expect((await post({ kind: 'voided', correctsOutcomeId: pay.outcomeId, notes: 'Bank reversed it', occurredOn: '2026-10-06' })).status).toBe(200);
    cf = (await srv.call('GET', `/api/opportunities/${o}`)).json();
    expect(cf.sell).toMatchObject({ paidAmount: null, paymentStatus: 'awaiting_payment' });
    // Only won and paid carry an amount.
    expect((await post({ kind: 'call', amount: '5' })).json().error).toMatch(/Only a win or a payment records an amount/);
  });

  it('never records a payment from anything but a person’s paid outcome', async () => {
    const o = await opp();
    await recordManualOutcome(db(), o, { kind: 'pitched', channel: 'email', occurredOn: '2026-10-01', recordedBy: 'Seller' });
    await recordManualOutcome(db(), o, { kind: 'won', amount: '240', currency: 'GBP', occurredOn: '2026-10-02', recordedBy: 'Seller' });
    expect((await projection(o)).paid_amount).toBeNull();
    await recordManualOutcome(db(), o, { kind: 'delivered' as never, occurredOn: '2026-10-03', recordedBy: 'Seller' }).catch(() => undefined);
    expect((await projection(o)).paid_amount).toBeNull();
  });
});
