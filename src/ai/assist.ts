// Bounded AI assistance (P6, A49): a person asks a model to rewrite a saved outreach draft's
// wording, for clearer evidence language or a better tone. Nothing else.
//
// What the model may do: reword the subject and the body of one draft.
// What it may not do, and how that is enforced:
//   - create evidence, observations, outcomes, contacts, prices, eligibility or verifications:
//     this module writes only an ai_suggestions row, a cost_events row and, when accepted, a new
//     PENDING messages row (a source test keeps it that way);
//   - change which evidence a draft cites: the new draft copies the source's evidence ids, and
//     message_ai_guard refuses anything else;
//   - invent facts: Scopely's own checks (checkRewrite) refuse output that adds a link, a number,
//     an email address, a quotation, a percentage or a placeholder the draft did not have, drops a
//     verbatim quote of the page, or drops the opt-out sentence; then the ordinary lint runs;
//   - approve, send or bypass an opt-out: the new draft is born pending (message_ai_guard), the
//     approval path is the person's own, and a suppressed business or contact is refused before
//     any model is called.
// What the model sees: the subject and body only, with the contact's name and address masked.
// Never page HTML, never contact details, never another workspace's data.
// Provenance: provider, model, prompt version, origin 'ai', who asked, the input's digest, tokens.
// Logs carry ids and counts only.
import { createHash } from 'node:crypto';
import type { ModelProvider } from '../build/agents.js';
import { DraftRejected, MAX_BODY, MAX_SUBJECT, OPT_OUT_SENTENCE, draftEvidence, draftLintRuleId, draftOpportunity, draftRow,
  guardedDraftWrite, type LintResult, lintMessage } from '../sell/drafts.js';
import type { Db } from '../tenancy/index.js';

export const ASSIST_TASKS = ['tone', 'clarify'] as const;
export type AssistTask = (typeof ASSIST_TASKS)[number];
export const ASSIST_PROMPT_VERSION = 'assist.draft_rewrite/1';
const CONTACT_MASK = '[[CONTACT]]';
const EMAIL_MASK = '[[ADDRESS]]';

export class AssistRejected extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502 | 503, message: string, readonly reasons: string[] = []) { super(message); }
}

const TASK_WORDS: Record<AssistTask, string> = {
  tone: 'Make the tone warmer, plainer and more human, as a short note from one small business owner to another.',
  clarify: 'Make the description of each problem easier to understand for someone who is not technical.',
};

const SYSTEM = `You rewrite one cold outreach email so it reads better. You change wording only.
Rules you must keep, without exception:
- Do not add any fact, claim, number, date, price, percentage, link, email address, name, result or promise that is not already in the email.
- Keep every line that starts with "As published:" exactly as it is, character for character.
- Keep every link exactly as it is.
- Keep this sentence exactly as it is, as the last paragraph before any sign-off: ${OPT_OUT_SENTENCE}
- Keep ${CONTACT_MASK} and ${EMAIL_MASK} exactly where a name or address belongs, if they appear. Do not add them otherwise.
- Something described as Scopely's reading stays a reading; never say it was seen.
- No placeholders, no brackets other than the ones above, no markdown.
Return JSON with "subject" and "body".`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['subject', 'body'],
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
};

// ------------------------------------------------------------------ checks (pure)

const URLS = /https?:\/\/[^\s<>"')\]]+/g;
const EMAILS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DIGITS = /\d+/g;
const QUOTED = /"([^"\n]{2,})"|“([^”\n]{2,})”/g;
const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[0]);

/**
 * Scopely's own refusal of a rewrite that adds what the draft did not say or drops what it must
 * keep. Returns the reasons, empty when the rewrite may become a draft.
 */
export function checkRewrite(original: { subject: string; body: string }, rewrite: { subject: string; body: string }, mustKeep: string[]): string[] {
  const reasons: string[] = [];
  const before = `${original.subject}\n${original.body}`;
  const after = `${rewrite.subject}\n${rewrite.body}`;
  if (!rewrite.subject.trim() || !rewrite.body.trim()) reasons.push('The suggestion was empty.');
  if (rewrite.subject.length > MAX_SUBJECT) reasons.push('The suggested subject is too long.');
  if (rewrite.body.length > MAX_BODY) reasons.push('The suggested message is too long.');
  for (const u of new Set(all(URLS, after))) if (!before.includes(u)) reasons.push(`It added a link that was not in the draft: ${u}`);
  for (const e of new Set(all(EMAILS, after))) if (!before.includes(e)) reasons.push('It added an email address that was not in the draft.');
  const known = new Set(all(DIGITS, before));
  for (const d of new Set(all(DIGITS, after))) if (!known.has(d)) reasons.push(`It added a number that was not in the draft: ${d}`);
  if (/%/.test(after) && !/%/.test(before)) reasons.push('It added a percentage.');
  for (const q of new Set(all(QUOTED, after))) if (!before.includes(q)) reasons.push(`It added a quotation that was not in the draft: "${q}"`);
  for (const k of mustKeep) if (before.includes(k) && !after.includes(k)) reasons.push('It changed or dropped text quoted from the page.');
  if (!rewrite.body.includes(OPT_OUT_SENTENCE)) reasons.push('It changed or dropped the opt-out sentence.');
  const brackets = all(/\[\[[^\]]*\]\]|\{\{[^}]*\}\}/g, after).filter((b) => b !== CONTACT_MASK && b !== EMAIL_MASK);
  if (brackets.length) reasons.push('It added a placeholder.');
  for (const mask of [CONTACT_MASK, EMAIL_MASK]) if (after.includes(mask) && !before.includes(mask)) reasons.push('It added a name or address that was not in the draft.');
  return [...new Set(reasons)];
}

/** Masks the contact's name and address before anything leaves Scopely; unmask restores them. */
export function maskContact(text: string, contact: { name: string | null; email: string | null }): string {
  let t = text;
  if (contact.email) t = t.split(contact.email).join(EMAIL_MASK);
  if (contact.name && contact.name.trim().length > 1) t = t.split(contact.name).join(CONTACT_MASK);
  return t;
}
export function unmaskContact(text: string, contact: { name: string | null; email: string | null }): string {
  return text.split(CONTACT_MASK).join(contact.name ?? '').split(EMAIL_MASK).join(contact.email ?? '');
}

function parseRewrite(text: string): { subject: string; body: string } | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && typeof (v as { subject?: unknown }).subject === 'string' && typeof (v as { body?: unknown }).body === 'string') {
      const o = v as { subject: string; body: string };
      return { subject: o.subject.replace(/\r\n?/g, '\n').trim(), body: o.body.replace(/\r\n?/g, '\n').trim() };
    }
  } catch { /* refused below */ }
  return null;
}

// ------------------------------------------------------------------ the request

export interface AssistResult {
  suggestionId: string;
  status: 'accepted' | 'refused';
  /** The new pending draft, when accepted. It still needs the lint and a person's approval. */
  messageId: string | null;
  lint: LintResult | null;
  reasons: string[];
  provider: string;
  model: string;
  promptVersion: string;
}

/**
 * Asks the model for a rewrite of one saved draft and, if Scopely's checks accept it, saves it as a
 * new pending draft citing the same evidence. A refused rewrite is recorded with its reasons and
 * saves no draft.
 */
export async function suggestDraftRewrite(db: Db, model: ModelProvider | null, opportunityId: string, messageId: string,
  input: { task: string; requestedBy: string }): Promise<AssistResult> {
  if (!model) throw new AssistRejected(503, 'AI assistance is not set up for this deployment.');
  const task = String(input.task ?? '') as AssistTask;
  if (!ASSIST_TASKS.includes(task)) throw new AssistRejected(400, 'Choose what to improve: the tone, or how clearly the problem is explained.');
  const requestedBy = typeof input.requestedBy === 'string' ? input.requestedBy.trim().slice(0, 120) : '';
  if (!requestedBy) throw new AssistRejected(400, 'Say who is asking.');
  let opp; let m;
  try {
    opp = await draftOpportunity(db, opportunityId);
    m = await draftRow(db, opp.id, messageId);
  } catch (err) {
    if (err instanceof DraftRejected) throw new AssistRejected(404, err.message);
    throw err;
  }
  if (m.sent_at !== null) throw new AssistRejected(409, 'This message is recorded as sent. Scopely does not write follow-ups.');
  if (m.approval_status === 'rejected') throw new AssistRejected(409, 'This draft was rejected.');
  const evidenceIds = (m.evidence_ids as string[]).map(String);
  const contactId = m.contact_id === null ? null : String(m.contact_id);
  // Suppression first: no model is called for a business or person who asked not to be contacted.
  const sourceLint = await lintMessage(db, opp, { subject: m.subject, body: m.body, evidenceIds, contactId });
  if (sourceLint.errors.some((e) => e.code === 'business_suppressed' || e.code === 'contact_suppressed')) {
    throw new AssistRejected(409, 'This business or contact asked not to be contacted, so no AI suggestion is made.');
  }
  const contact = contactId === null ? { name: null, email: null }
    : (await db.query(`SELECT full_name AS name, email FROM scopely.contacts WHERE id = $1 AND workspace_id = scopely.current_workspace_id()`, [contactId])).rows[0] ?? { name: null, email: null };
  const masked = { subject: maskContact(m.subject, contact), body: maskContact(m.body, contact) };
  const user = JSON.stringify({ task: TASK_WORDS[task], subject: masked.subject, body: masked.body });
  const inputSha = createHash('sha256').update(`${ASSIST_PROMPT_VERSION}\n${SYSTEM}\n${user}`).digest('hex');

  let response;
  try {
    response = await model.complete({ purpose: 'assist', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], maxTokens: 4000, jsonSchema: SCHEMA });
  } catch {
    throw new AssistRejected(502, 'The AI provider did not give a usable answer. Nothing was saved.');
  }
  const modelName = (response.usage.model ?? 'unknown').slice(0, 120);
  const parsed = parseRewrite(response.text);
  const quotes = (await draftEvidence(db, opp.id)).filter((e) => evidenceIds.includes(e.evidenceId)).flatMap((e) => [e.quote, e.url]);
  const reasons = parsed ? checkRewrite(masked, parsed, quotes) : ['The suggestion was not in the expected form.'];

  return guardedDraftWrite(db, async () => {
    const suggestionId = String((await db.query(
      `INSERT INTO scopely.ai_suggestions (opportunity_id, source_message_id, task, provider, model, prompt_version, input_sha256, status, refusal_reasons,
         tokens_in, tokens_out, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [opp.id, m.id, task, model.provider, modelName, ASSIST_PROMPT_VERSION, inputSha, reasons.length ? 'refused' : 'accepted', JSON.stringify(reasons),
       response.usage.tokensIn, response.usage.tokensOut, requestedBy])).rows[0].id);
    // Metered per call; the price is not assumed, so the amount stays unknown.
    await db.query(
      `INSERT INTO scopely.cost_events (business_id, opportunity_id, kind, tokens_in, tokens_out, meta)
       VALUES ($1, $2, 'llm_call', $3, $4, $5)`,
      [opp.business_id, opp.id, response.usage.tokensIn, response.usage.tokensOut,
       JSON.stringify({ provider: model.provider, model: modelName, promptVersion: ASSIST_PROMPT_VERSION, suggestionId })]);
    const base = { suggestionId, provider: model.provider, model: modelName, promptVersion: ASSIST_PROMPT_VERSION };
    if (reasons.length || !parsed) return { ...base, status: 'refused' as const, messageId: null, lint: null, reasons };
    const subject = unmaskContact(parsed.subject, contact);
    const body = unmaskContact(parsed.body, contact);
    const lint = await lintMessage(db, opp, { subject, body, evidenceIds, contactId });
    const rule = await draftLintRuleId(db);
    const newId = String((await db.query(
      `INSERT INTO scopely.messages (opportunity_id, contact_id, step, subject, body, evidence_ids, generator, lint_rule_version_id, lint_status, lint_errors,
         mailbox_connection_id, catalog_item_id, drafted_by, ai_suggestion_id)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [opp.id, contactId, subject, body, evidenceIds, `ai:${model.provider}:${modelName}:${ASSIST_PROMPT_VERSION}`, rule, lint.status, JSON.stringify(lint.errors),
       m.mailbox_connection_id, m.catalog_item_id, requestedBy, suggestionId])).rows[0].id);
    return { ...base, status: 'accepted' as const, messageId: newId, lint, reasons: [] };
  });
}
