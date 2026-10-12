// The Case File's saved outreach drafts (release 1, A41–A43): every message of the opportunity with
// its cited findings, contact, proposed service, sender, the lint as recorded at the last save, its
// approval, and readiness judged now by the database's own gates. Nothing here writes.
//
// Scoped like the rest of src/api: an explicit current_workspace_id() predicate on every query, on
// top of row-level security. Another workspace's opportunity reads as no drafts.
import { type DraftReadiness, DraftRejected, type LintError, draftOpportunity, draftReadiness } from '../sell/drafts.js';
import type { Db } from '../tenancy/index.js';

const WS = 'workspace_id = scopely.current_workspace_id()';
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export interface DraftView {
  messageId: string;
  subject: string;
  body: string;
  /** Who wrote the first version: Scopely's deterministic draft, or a person (a draft recorded by hand). */
  generator: string;
  draftedBy: string | null;
  createdAt: string;
  edited: { by: string; at: string } | null;
  contact: { contactId: string; name: string | null; email: string | null; label: string | null } | null;
  evidence: { evidenceId: string; plainIssue: string; url: string; claimState: 'OBSERVED' | 'INFERRED'; observedAt: string;
              recheck: 'confirmed' | 'changed' | 'gone' | null }[];
  service: { name: string | null; price: string | null; currency: string | null } | null;
  /** The workspace mailbox it would be sent from, or null: "no sender set". */
  sender: { mailboxId: string; email: string; displayName: string | null; state: string } | null;
  /** The lint as recorded at the last save. */
  lint: { status: 'pending' | 'pass' | 'fail'; errors: LintError[]; rule: string | null };
  approval: { status: 'pending' | 'approved' | 'edited' | 'rejected'; approvedBy: string | null; approvedAt: string | null;
              /** Always false: approvedBy is stored as text; since A40 the server fills it with the signed-in person. */
              approvedByIsAuthenticated: false };
  /** Recorded by hand outside Scopely (pnpm record); the app never sends. */
  sentAt: string | null;
  readiness: DraftReadiness;
}

export interface OutreachDrafts {
  drafts: DraftView[];
  /** The workspace's mailboxes a draft may name as its sender. */
  mailboxes: { mailboxId: string; email: string; displayName: string | null; state: string }[];
}

/** The opportunity's drafts, newest first, or null when the opportunity is not in this workspace. */
export async function listDrafts(db: Db, opportunityId: string): Promise<OutreachDrafts | null> {
  let opp;
  try { opp = await draftOpportunity(db, opportunityId); } catch (err) { if (err instanceof DraftRejected) return null; throw err; }
  const rows = (await db.query(
    `SELECT m.*, c.full_name AS contact_name, c.email AS contact_email, c.label AS contact_label,
            mb.email AS mailbox_email, mb.display_name AS mailbox_name, mb.state AS mailbox_state,
            ci.service AS draft_service, rv.rule_key AS lint_rule_key, rv.version AS lint_rule_version
       FROM scopely.messages m
       LEFT JOIN scopely.contacts c ON c.id = m.contact_id AND c.${WS}
       LEFT JOIN scopely.mailbox_connections mb ON mb.id = m.mailbox_connection_id AND mb.${WS}
       LEFT JOIN scopely.catalog_items ci ON ci.id = m.catalog_item_id
       LEFT JOIN scopely.rule_versions rv ON rv.id = m.lint_rule_version_id
      WHERE m.opportunity_id = $1 AND m.${WS} ORDER BY m.created_at DESC, m.id DESC`, [opp.id])).rows;
  const ev = (await db.query(
    `SELECT e.id, e.plain_issue, e.url, e.claim_state, e.observed_at, e.recheck_result
       FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
      WHERE oe.opportunity_id = $1 AND oe.${WS} AND e.${WS}`, [opp.id])).rows;
  const byId = new Map(ev.map((e) => [String(e.id), e]));
  const drafts: DraftView[] = [];
  for (const m of rows) {
    drafts.push({
      messageId: String(m.id), subject: m.subject, body: m.body, generator: m.generator, draftedBy: m.drafted_by, createdAt: iso(m.created_at)!,
      edited: m.edited_by ? { by: m.edited_by, at: iso(m.edited_at)! } : null,
      contact: m.contact_id === null ? null : { contactId: String(m.contact_id), name: m.contact_name, email: m.contact_email, label: m.contact_label },
      evidence: (m.evidence_ids as string[]).map(String).filter((id) => byId.has(id)).map((id) => {
        const e = byId.get(id)!;
        return { evidenceId: id, plainIssue: e.plain_issue, url: e.url, claimState: e.claim_state, observedAt: iso(e.observed_at)!, recheck: e.recheck_result };
      }),
      // A draft proposes the opportunity's own service (message_draft_guard); its price is the opportunity's, or not set.
      service: m.catalog_item_id === null ? null : { name: m.draft_service, price: opp.service_price, currency: opp.currency },
      sender: m.mailbox_connection_id === null ? null
        : { mailboxId: String(m.mailbox_connection_id), email: m.mailbox_email, displayName: m.mailbox_name, state: m.mailbox_state },
      lint: { status: m.lint_status, errors: Array.isArray(m.lint_errors) ? m.lint_errors : [],
        rule: m.lint_rule_key ? `${m.lint_rule_key} v${m.lint_rule_version}` : null },
      approval: { status: m.approval_status, approvedBy: m.approved_by, approvedAt: iso(m.approved_at), approvedByIsAuthenticated: false },
      sentAt: iso(m.sent_at),
      readiness: await draftReadiness(db, opp, m),
    });
  }
  const mailboxes = (await db.query(`SELECT id, email, display_name, state FROM scopely.mailbox_connections WHERE ${WS} ORDER BY id`)).rows
    .map((x) => ({ mailboxId: String(x.id), email: x.email, displayName: x.display_name, state: x.state }));
  return { drafts, mailboxes };
}
