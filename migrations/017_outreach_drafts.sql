-- 017_outreach_drafts: saved outreach drafts in the Case File (release 1, A41–A43).
--
-- A draft is a `messages` row (002/005/007), not a new table: the message ledger already holds the
-- subject, body, cited evidence, lint result, approval and the send gates, and every gate the
-- database has for a message keeps judging a draft. What this adds is only what a saved draft needs:
--
--   catalog_item_id   the service the draft proposes. It is the opportunity's own mapped service or
--                     nothing (an UNMAPPED opportunity); a draft never proposes another service.
--   drafted_by        who asked for the draft (a free-text actor, like recorded_by; B10).
--   edited_by/_at     the last person who changed the text, and when.
--
-- The sender stays `mailbox_connection_id`, which was already nullable until a send
-- (messages_sender_check): a draft with no mailbox is saved and reads as "no sender set".
-- `sender_email` is still captured from the mailbox only at send (a10_message_addresses), and
-- nothing in the app writes `sent_at`: there is no send.
--
-- message_draft_guard adds two rules the existing triggers did not have:
--   1. its proposed service is the opportunity's own mapped service;
--   2. a message whose lint failed cannot be approved. Lint is recorded by Scopely on every save; a
--      person fixes the text (which re-lints) rather than approving over a failure.
-- (Whose contact a message names is still judged at approval by contact_outreach_blocker, 005/007;
-- the Case File only ever offers the business's own contacts.)
--
-- The lint is a rule like any other, so it is a rule_versions row: lint.outreach_draft v1.

SET search_path = scopely;

ALTER TABLE messages
  ADD COLUMN catalog_item_id bigint REFERENCES catalog_items(id),
  ADD COLUMN drafted_by text CHECK (drafted_by IS NULL OR btrim(drafted_by) <> ''),
  ADD COLUMN edited_by  text CHECK (edited_by IS NULL OR btrim(edited_by) <> ''),
  ADD COLUMN edited_at  timestamptz,
  ADD CONSTRAINT messages_edited_check CHECK ((edited_by IS NULL) = (edited_at IS NULL));

-- The proposed service joins the parents the workspace guard checks (a shared starter is allowed).
DROP TRIGGER a00_workspace_guard ON messages;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','contact_id','contacts',
                                                'mailbox_connection_id','mailbox_connections','catalog_item_id','catalog_items');

CREATE FUNCTION message_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opp record; approving boolean;
BEGIN
  SELECT catalog_item_id INTO opp FROM scopely.opportunities WHERE id = NEW.opportunity_id;
  -- No opportunity: the foreign key reports it.
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.catalog_item_id IS NOT NULL AND NEW.catalog_item_id IS DISTINCT FROM opp.catalog_item_id
     AND (TG_OP = 'INSERT' OR NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id) THEN
    RAISE EXCEPTION 'MESSAGE: a message proposes the opportunity''s own service (catalog item %), not %', opp.catalog_item_id, NEW.catalog_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  approving := NEW.approval_status IN ('approved','edited')
               AND (TG_OP = 'INSERT' OR OLD.approval_status NOT IN ('approved','edited') OR NEW.approved_at IS DISTINCT FROM OLD.approved_at);
  IF approving AND NEW.lint_status = 'fail' THEN
    RAISE EXCEPTION 'MESSAGE: cannot approve: the message failed its lint; correct the text first'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_draft_guard BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION message_draft_guard();

INSERT INTO rule_versions (rule_key, version, kind, playbook_id, description, validation_status, validation_basis, definition) VALUES
('lint.outreach_draft', 1, 'lint', NULL,
 'Deterministic checks on an outreach draft before a person may approve it: the opt-out sentence is present; no cited finding was re-checked as changed or gone; an inferred finding appears only as Scopely''s reading; nothing Scopely could not observe is stated; every money amount is the opportunity''s own price and no percentage appears; no unfilled placeholder remains; the contact and the business are not suppressed. Article 14 wording and links on a first message are open decision B4 and are not judged.',
 'HYPOTHESIS', NULL,
 '{"checks":["opt_out_missing","evidence_changed","evidence_gone","inferred_as_observed","not_observable_claim","unbacked_amount","unbacked_percentage","placeholder","contact_suppressed","business_suppressed"],"open":["B4"]}');
