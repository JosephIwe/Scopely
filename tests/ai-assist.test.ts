// P6: bounded AI assistance (A49). A model may reword a saved draft. Its output is never evidence,
// never a price, contact, outcome or verification, cites exactly the evidence of the draft it
// reworded, is refused when it adds facts, is born pending, and carries its provenance.
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AnthropicModelProvider, DEFAULT_ASSIST_MODEL, assistProviderFromEnv } from '../src/ai/anthropic.js';
import { ASSIST_PROMPT_VERSION, checkRewrite, maskContact, unmaskContact } from '../src/ai/assist.js';
import type { ModelProvider, ModelRequest } from '../src/build/agents.js';
import { OPT_OUT_SENTENCE } from '../src/sell/drafts.js';
import { enterNewWorkspace, failure, manualMailbox, one, seedChain, seedOpportunity, useDb, useWorkspace } from './helpers.js';
import { useServer } from './server-helpers.js';
import { confirmRecheck } from './site-helpers.js';

const { db } = useDb();
const start = useServer(db);

/** A model stand-in: records what it was sent, answers with `reply(subject, body)`. */
class FakeModel implements ModelProvider {
  readonly provider = 'anthropic';
  readonly calls: ModelRequest[] = [];
  constructor(private readonly reply: (x: { subject: string; body: string }) => { subject: string; body: string } | string) {}
  async complete(req: ModelRequest) {
    this.calls.push(req);
    const input = JSON.parse(req.messages.find((m) => m.role === 'user')!.content) as { subject: string; body: string };
    const out = this.reply(input);
    return { text: typeof out === 'string' ? out : JSON.stringify(out), usage: { provider: 'anthropic', model: 'claude-haiku-5-5', tokensIn: 812, tokensOut: 240, cost: { amount: null, currency: null } } };
  }
}
/** Rewords the greeting and closing only: a rewrite that keeps every fact. */
const gentle = () => new FakeModel(({ subject, body }) => ({ subject: `Quick note: ${subject}`, body: body.replace(/^Hello/, 'Hi').replace('If you would like the details, reply to this email.', 'Happy to share the details if you reply.') }));

async function readyCase(d: pg.Client) {
  const c = await seedChain(d);
  const opp = await seedOpportunity(d, c, 'website_fix_sprint', 120);
  await confirmRecheck(d, c);
  await d.query(`UPDATE businesses SET company_type = 'ltd', company_status = 'active' WHERE id = $1`, [c.businessId]);
  const contactId = (await one<{ id: string }>(d, `INSERT INTO contacts (business_id, full_name, email, source, label, outreach_basis)
    VALUES ($1, 'Pat Owner', 'pat@example-clinic.test', 'website', 'PUBLICLY_FOUND', 'corporate_subscriber') RETURNING id`, [c.businessId])).id;
  await manualMailbox(d, 'seller@seller.test');
  return { c, opp, contactId };
}
const msg = (id: string) => one<Record<string, any>>(db(), 'SELECT * FROM messages WHERE id = $1', [id]);
const counts = async () => (await db().query(`SELECT (SELECT count(*) FROM evidence) ev, (SELECT count(*) FROM observations) obs, (SELECT count(*) FROM outcomes) oc,
  (SELECT count(*) FROM contacts) ct, (SELECT count(*) FROM verifications) vf, (SELECT count(*) FROM opportunity_evidence) oe,
  (SELECT string_agg(coalesce(service_price::text,'-') || coalesce(status,'') || coalesce(deal_value::text,'') || coalesce(opportunity_value::text,'') || coalesce(mapping_status,''), ',' ORDER BY id) FROM opportunities) opp`)).rows[0];

const original = { subject: 'A problem on the Clinic website', body: `Hello Pat Owner,\n\nOn 5 October 2026, the page https://clinic.test/contact showed this problem:\n- The "WhatsApp us" button uses a number with no country code.\n  As published: <a href="https://wa.me/07700900461">WhatsApp us</a>\n\nIf you would like the details, reply to this email.\n\n${OPT_OUT_SENTENCE}` };
const keep = ['<a href="https://wa.me/07700900461">WhatsApp us</a>', 'https://clinic.test/contact'];

describe('checkRewrite: Scopely refuses a rewrite that changes what the draft says', () => {
  it('accepts a rewording that keeps every fact, quote, link and the opt-out', () => {
    expect(checkRewrite(original, { subject: 'Your contact page', body: original.body.replace('Hello', 'Hi') }, keep)).toEqual([]);
  });
  it('refuses an added link, number, email, quotation, percentage or placeholder', () => {
    const add = (extra: string) => checkRewrite(original, { ...original, body: `${original.body.replace(OPT_OUT_SENTENCE, '')}${extra}\n\n${OPT_OUT_SENTENCE}` }, keep);
    expect(add('See https://scopely.example/offer')).toEqual([expect.stringMatching(/added a link/)]);
    expect(add('Clinics like yours lose 30 bookings a month.')).toEqual([expect.stringMatching(/added a number.*30/)]);
    expect(add('Write to me at me@seller.test.')).toEqual([expect.stringMatching(/email address/)]);
    expect(add('A patient told us "it never works".')).toEqual([expect.stringMatching(/quotation/)]);
    expect(add('Fixing it lifts enquiries by half %.')).toEqual([expect.stringMatching(/percentage/)]);
    expect(add('Regards, {{sender}}')).toEqual([expect.stringMatching(/placeholder/)]);
  });
  it('refuses a dropped or altered quote of the page, link or opt-out sentence', () => {
    expect(checkRewrite(original, { ...original, body: original.body.replace('07700900461', '+447700900461') }, keep).join(' ')).toMatch(/quoted from the page|number/);
    expect(checkRewrite(original, { ...original, body: original.body.replace(OPT_OUT_SENTENCE, 'Reply STOP to opt out.') }, keep)).toEqual([expect.stringMatching(/opt-out/)]);
    expect(checkRewrite(original, { subject: '', body: '' }, keep)).toContain('The suggestion was empty.');
  });
  it('masks the contact’s name and address before the model sees the text, and restores them after', () => {
    const c = { name: 'Pat Owner', email: 'pat@example-clinic.test' };
    const masked = maskContact('Hello Pat Owner, (pat@example-clinic.test)', c);
    expect(masked).toBe('Hello [[CONTACT]], ([[ADDRESS]])');
    expect(unmaskContact(masked, c)).toBe('Hello Pat Owner, (pat@example-clinic.test)');
  });
});

describe('the provider seam', () => {
  it('is off unless a provider and key are configured; the default model is the low-cost one', () => {
    expect(assistProviderFromEnv({})).toBeNull();
    expect(() => assistProviderFromEnv({ SCOPELY_AI_PROVIDER: 'openai', SCOPELY_AI_API_KEY: 'k' })).toThrow(/not a provider/);
    expect(() => assistProviderFromEnv({ SCOPELY_AI_PROVIDER: 'anthropic' })).toThrow(/SCOPELY_AI_API_KEY/);
    const p = assistProviderFromEnv({ SCOPELY_AI_PROVIDER: 'anthropic', SCOPELY_AI_API_KEY: 'test-key' }) as AnthropicModelProvider;
    expect(p.model).toBe(DEFAULT_ASSIST_MODEL);
    expect(DEFAULT_ASSIST_MODEL).toBe('claude-haiku-5-5');
    expect((assistProviderFromEnv({ SCOPELY_AI_PROVIDER: 'anthropic', SCOPELY_AI_API_KEY: 'k', SCOPELY_AI_MODEL: 'claude-sonnet-5-5' }) as AnthropicModelProvider).model).toBe('claude-sonnet-5-5');
  });
  it('sends the model, low effort and the JSON schema through the SDK, records tokens, assumes no price, and treats a refusal as no answer', async () => {
    const sent: any[] = [];
    let stop = 'end_turn';
    const client = { messages: { create: async (p: unknown) => { sent.push(p); return { model: 'claude-haiku-5-5', stop_reason: stop, content: [{ type: 'text', text: '{"subject":"s","body":"b"}' }], usage: { input_tokens: 10, output_tokens: 5 } }; } } };
    const p = new AnthropicModelProvider('unused', 'claude-haiku-5-5', client as never);
    const r = await p.complete({ purpose: 'assist', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }], maxTokens: 100, jsonSchema: { type: 'object' } });
    expect(sent[0]).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 100, system: 'sys', messages: [{ role: 'user', content: 'u' }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } } });
    expect(r).toEqual({ text: '{"subject":"s","body":"b"}', usage: { provider: 'anthropic', model: 'claude-haiku-5-5', tokensIn: 10, tokensOut: 5, cost: { amount: null, currency: null } } });
    stop = 'refusal';
    await expect(p.complete({ purpose: 'assist', messages: [{ role: 'user', content: 'u' }] })).rejects.toThrow();
  });
});

describe('asking for an AI rewording of a draft', () => {
  it('is refused plainly when assistance is off', async () => {
    const { opp, contactId } = await readyCase(db());
    const { call } = await start();
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    expect((await call('GET', `/api/opportunities/${opp}/drafts`)).json().ai).toEqual({ enabled: false, provider: null });
    const r = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/assist`, { task: 'tone', requestedBy: 'Sam' });
    expect(r.status).toBe(503);
    expect(r.json().error).toMatch(/not set up/);
  });

  it('saves an accepted rewording as a new pending draft with the same evidence, its provenance and a metered call; nothing authoritative changes', async () => {
    const { opp, contactId } = await readyCase(db());
    const model = gentle();
    const { call } = await start({ assist: model });
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    const source = await msg(messageId);
    const before = await counts();
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/assist`, { task: 'nonsense', requestedBy: 'Sam' })).status).toBe(400);
    const r = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/assist`, { task: 'tone', requestedBy: 'Sam' });
    expect(r.status).toBe(200);
    const out = r.json();
    expect(out).toMatchObject({ status: 'accepted', provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: ASSIST_PROMPT_VERSION, lint: { status: 'pass' } });
    // What the model saw: the wording only, the contact masked, no page HTML beyond the cited quote.
    const sentText = JSON.stringify(model.calls[0]!.messages);
    expect(sentText).not.toContain('Pat Owner');
    expect(sentText).not.toContain('pat@example-clinic.test');
    expect(sentText).not.toMatch(/<html|<body|<head/i);
    const m = await msg(out.messageId);
    expect(m).toMatchObject({ approval_status: 'pending', approved_at: null, sent_at: null, generator: `ai:anthropic:claude-haiku-5-5:${ASSIST_PROMPT_VERSION}`,
      contact_id: source.contact_id, catalog_item_id: source.catalog_item_id, mailbox_connection_id: source.mailbox_connection_id, drafted_by: 'Sam' });
    expect(m.evidence_ids.map(String)).toEqual(source.evidence_ids.map(String));
    expect(m.body).toMatch(/^Hi /);
    expect(m.body).toContain(OPT_OUT_SENTENCE);
    const s = await one<Record<string, any>>(db(), 'SELECT * FROM ai_suggestions WHERE id = $1', [out.suggestionId]);
    expect(s).toMatchObject({ origin: 'ai', provider: 'anthropic', model: 'claude-haiku-5-5', prompt_version: ASSIST_PROMPT_VERSION, task: 'tone', status: 'accepted',
      tokens_in: 812, tokens_out: 240, requested_by: 'Sam', source_message_id: messageId });
    const cost = await one<Record<string, any>>(db(), `SELECT kind, tokens_in, tokens_out, amount, currency, meta FROM cost_events WHERE opportunity_id = $1 AND kind = 'llm_call'`, [opp]);
    expect(cost).toMatchObject({ kind: 'llm_call', tokens_in: 812, tokens_out: 240, amount: null, currency: null, meta: { suggestionId: out.suggestionId } });
    // AI output became no evidence, observation, outcome, contact, verification, price or status.
    expect(await counts()).toEqual(before);
    // The Case File labels it and shows its origin.
    const d = (await call('GET', `/api/opportunities/${opp}/drafts`)).json().drafts.find((x: { messageId: string }) => x.messageId === out.messageId);
    expect(d).toMatchObject({ origin: { kind: 'ai', model: 'claude-haiku-5-5', promptVersion: ASSIST_PROMPT_VERSION }, approval: { status: 'pending' }, handoff: null });
    // A person still approves it, through the same gate.
    expect((await call('POST', `/api/opportunities/${opp}/drafts/${out.messageId}/approve`, { approvedBy: 'Sam' })).status).toBe(200);
  });

  it('records a refused rewording with its reasons and saves no draft', async () => {
    const { opp, contactId } = await readyCase(db());
    const model = new FakeModel(({ subject, body }) => ({ subject, body: body.replace(OPT_OUT_SENTENCE, `Clinics lose 40% of bookings to this. Fixing it costs £99.\n\n${OPT_OUT_SENTENCE}`) }));
    const { call } = await start({ assist: model });
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    const r = await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/assist`, { task: 'clarify', requestedBy: 'Sam' });
    expect(r.status).toBe(409);
    expect(r.json()).toMatchObject({ status: 'refused', messageId: null });
    expect(r.json().error).toMatch(/refused the AI suggestion.*number/);
    expect((await db().query('SELECT count(*)::int n FROM messages WHERE opportunity_id = $1', [opp])).rows[0].n).toBe(1);
    const s = await one<Record<string, any>>(db(), 'SELECT status, refusal_reasons FROM ai_suggestions WHERE id = $1', [r.json().suggestionId]);
    expect(s.status).toBe('refused');
    expect(s.refusal_reasons.join(' ')).toMatch(/number.*40|percentage/);
    // A malformed answer is refused the same way.
    const junk = new FakeModel(() => 'not json');
    const again = await start({ assist: junk });
    expect((await again.call('POST', `/api/opportunities/${opp}/drafts/${messageId}/assist`, { task: 'tone', requestedBy: 'Sam' })).json().reasons).toEqual(['The suggestion was not in the expected form.']);
  });

  it('never calls the model for a suppressed business, a sent message, or another workspace’s draft', async () => {
    const { c, opp, contactId } = await readyCase(db());
    const model = gentle();
    const own = await start({ assist: model });
    const { messageId } = (await own.call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    const a = await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws');
    const b = await enterNewWorkspace(db(), 'beta');
    await useWorkspace(db(), a.ws);
    const other = await start({ workspaceId: b, assist: model });
    expect((await other.call('POST', `/api/opportunities/${opp}/drafts/${messageId}/assist`, { task: 'tone', requestedBy: 'Mallory' })).status).toBe(404);
    await useWorkspace(db(), a.ws);
    const mine = await start({ assist: model });
    await mine.call('POST', `/api/opportunities/${opp}/drafts/${messageId}/approve`, { approvedBy: 'Sam' });
    await mine.call('POST', `/api/opportunities/${opp}/drafts/${messageId}/sent`, { recordedBy: 'Sam' });
    expect((await mine.call('POST', `/api/opportunities/${opp}/drafts/${messageId}/assist`, { task: 'tone', requestedBy: 'Sam' })).json().error).toMatch(/does not write follow-ups/);
    const { messageId: second } = (await mine.call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    await db().query(`INSERT INTO suppression (business_id, reason) VALUES ($1, 'opt_out')`, [c.businessId]);
    const s = await mine.call('POST', `/api/opportunities/${opp}/drafts/${second}/assist`, { task: 'tone', requestedBy: 'Sam' });
    expect(s.status).toBe(409);
    expect(s.json().error).toMatch(/asked not to be contacted/);
    expect(model.calls).toHaveLength(0);
  });
});

describe('the database keeps AI output bounded (message_ai_guard; fails when the guard is dropped)', () => {
  it('refuses a model draft that is approved, cites other evidence, comes from a refused suggestion, or loses its origin', async () => {
    const { c, opp, contactId } = await readyCase(db());
    const { call } = await start({ assist: gentle() });
    const { messageId } = (await call('POST', `/api/opportunities/${opp}/drafts`, { draftedBy: 'Sam', contactId })).json();
    const out = (await call('POST', `/api/opportunities/${opp}/drafts/${messageId}/assist`, { task: 'tone', requestedBy: 'Sam' })).json();
    const src = await msg(messageId);
    const ins = (over: string, sid: string, evidence: unknown = src.evidence_ids) => failure(db(), `INSERT INTO messages (opportunity_id, step, subject, body, evidence_ids, generator, ai_suggestion_id${over ? ', approval_status, approved_by, approved_at' : ''})
      VALUES ($1, 0, 's', 'b', $2, 'ai:anthropic:x:assist.draft_rewrite/1', $3${over ? `, 'approved', 'AI', now()` : ''})`, [opp, evidence, sid]);
    expect(await ins('approved', out.suggestionId)).toMatch(/born pending/);
    expect(await ins('', out.suggestionId, [])).toMatch(/exactly the evidence/);
    expect(await ins('', out.suggestionId, [...src.evidence_ids, ...src.evidence_ids])).toMatch(/exactly the evidence/);
    const refused = await one<{ id: string }>(db(), `INSERT INTO ai_suggestions (opportunity_id, source_message_id, task, provider, model, prompt_version, input_sha256, status, refusal_reasons, requested_by)
      VALUES ($1, $2, 'tone', 'anthropic', 'm', 'assist.draft_rewrite/1', $3, 'refused', '["x"]', 'Sam') RETURNING id`, [opp, messageId, 'a'.repeat(64)]);
    expect(await ins('', refused.id)).toMatch(/accepted suggestion/);
    expect(await failure(db(), `UPDATE messages SET ai_suggestion_id = NULL, generator = 'scopely:draft/1' WHERE id = $1`, [out.messageId])).toMatch(/origin cannot be removed/);
    expect(await failure(db(), `UPDATE messages SET evidence_ids = '{}' WHERE id = $1`, [out.messageId])).toMatch(/keeps its origin and its evidence|check/);
    expect(await failure(db(), `UPDATE ai_suggestions SET status = 'accepted' WHERE id = $1`, [refused.id])).toMatch(/append-only/);
    expect(await failure(db(), `INSERT INTO messages (opportunity_id, step, subject, body, evidence_ids, generator) VALUES ($1, 0, 's', 'b', $2, 'ai:anthropic:x:y/1')`, [opp, src.evidence_ids]))
      .toMatch(/messages_ai_generator_check/);
    void c;
  });

  it('src/ai writes only suggestions, metering and pending drafts: never evidence, observations, outcomes, contacts, prices or verifications', async () => {
    for (const f of ['src/ai/assist.ts', 'src/ai/anthropic.ts']) {
      const src = await readFile(f, 'utf8');
      const writes = [...src.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+scopely\.(\w+)/g)].map((m) => m[2]);
      expect(new Set(writes), f).toEqual(new Set(f.endsWith('assist.ts') ? ['ai_suggestions', 'cost_events', 'messages'] : []));
      expect(src, f).not.toMatch(/approved_at\s*=|sent_at\s*=|approval_status\s*=\s*'approved'/);
    }
    // Nothing in the schema lets evidence or observations point at a model's output.
    const refs = (await db().query(`SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE confrelid = 'scopely.ai_suggestions'::regclass`)).rows.map((r) => r.t);
    expect(refs.map((t: string) => t.replace(/^scopely\./, ''))).toEqual(['messages']);
  });
});
