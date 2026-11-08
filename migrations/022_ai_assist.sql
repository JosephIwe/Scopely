-- P6: bounded AI assistance for outreach drafts (A49).
--
-- A person may ask a model to rewrite a saved draft's wording (clearer evidence language, a better
-- tone). The model's output is never evidence, never OBSERVED, never a price, a contact, an
-- outcome or a verification. It can only become a new PENDING draft that cites exactly the
-- evidence of the draft it rewrote, and then it goes through the same lint and the same human
-- approval as any other draft.
--
--   ai_suggestions   one row per model call: who asked, which provider, model and prompt version,
--                    the input's digest, token counts, and whether Scopely's own checks accepted
--                    the output or refused it (with the reasons). origin is always 'ai'.
--                    Append-only. Nothing else in the schema references it except messages.
--   messages.ai_suggestion_id
--                    set exactly when a draft came from a model (generator 'ai:...').
--   message_ai_guard a model's draft is born pending, from an accepted suggestion of the same
--                    opportunity, and cites the same evidence as the draft it rewrote.

CREATE TABLE ai_suggestions (
  id                 bigserial PRIMARY KEY,
  workspace_id       bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id     bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  source_message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  task               text NOT NULL CHECK (task IN ('tone','clarify')),
  origin             text NOT NULL DEFAULT 'ai' CHECK (origin = 'ai'),
  provider           text NOT NULL CHECK (provider ~ '^[a-z0-9_-]{1,40}$'),
  model              text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  prompt_version     text NOT NULL CHECK (prompt_version ~ '^[a-z0-9_.]+/[0-9]+$'),
  input_sha256       char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  status             text NOT NULL CHECK (status IN ('accepted','refused')),
  refusal_reasons    jsonb NOT NULL DEFAULT '[]',
  tokens_in          integer CHECK (tokens_in >= 0),
  tokens_out         integer CHECK (tokens_out >= 0),
  requested_by       text NOT NULL CHECK (length(btrim(requested_by)) > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'refused') = (jsonb_array_length(refusal_reasons) > 0))
);
CREATE INDEX ai_suggestions_opportunity_idx ON ai_suggestions (opportunity_id);

CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON ai_suggestions
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','source_message_id','messages');
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON ai_suggestions USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

CREATE FUNCTION ai_suggestions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI: suggestions are append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER ai_suggestions_append_only BEFORE UPDATE ON ai_suggestions
  FOR EACH ROW EXECUTE FUNCTION ai_suggestions_append_only();

ALTER TABLE messages ADD COLUMN ai_suggestion_id bigint REFERENCES ai_suggestions(id);
DROP TRIGGER a00_workspace_guard ON messages;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','contact_id','contacts',
                                                'mailbox_connection_id','mailbox_connections','catalog_item_id','catalog_items',
                                                'ai_suggestion_id','ai_suggestions');
ALTER TABLE messages ADD CONSTRAINT messages_ai_generator_check
  CHECK ((ai_suggestion_id IS NOT NULL) = (generator LIKE 'ai:%'));

CREATE FUNCTION message_ai_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; src record;
BEGIN
  IF NEW.ai_suggestion_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.ai_suggestion_id IS NOT NULL THEN
      RAISE EXCEPTION 'AI: a draft''s AI origin cannot be removed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.ai_suggestion_id IS DISTINCT FROM OLD.ai_suggestion_id OR NEW.evidence_ids IS DISTINCT FROM OLD.evidence_ids THEN
      RAISE EXCEPTION 'AI: a model''s draft keeps its origin and its evidence' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT opportunity_id, source_message_id, status INTO s FROM scopely.ai_suggestions WHERE id = NEW.ai_suggestion_id;
  IF NOT FOUND OR s.status <> 'accepted' THEN
    RAISE EXCEPTION 'AI: a draft can come only from an accepted suggestion' USING ERRCODE = 'check_violation';
  END IF;
  IF s.opportunity_id <> NEW.opportunity_id THEN
    RAISE EXCEPTION 'AI: the suggestion belongs to another opportunity' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.approval_status <> 'pending' OR NEW.approved_at IS NOT NULL OR NEW.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'AI: a model''s draft is born pending; only a person approves it' USING ERRCODE = 'check_violation';
  END IF;
  SELECT evidence_ids INTO src FROM scopely.messages WHERE id = s.source_message_id;
  IF NEW.evidence_ids IS DISTINCT FROM src.evidence_ids THEN
    RAISE EXCEPTION 'AI: a model''s draft cites exactly the evidence of the draft it rewrote' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_ai_guard BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION message_ai_guard();
