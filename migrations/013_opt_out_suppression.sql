-- 013_opt_out_suppression: an explicit opt-out is honoured by the database (Slice 9, Prospect Readiness).
--
-- A reply of class opt_out ("Asked not to be contacted") is the business telling the seller to stop.
-- Until now nothing wrote suppression for it, so the contact stayed emailable unless someone edited
-- the database by hand. From here, recording that reply adds the business to its own workspace's
-- suppression list in the same statement, with no second step, whichever writer recorded it (the
-- Case File, the record CLI or a later importer).
--
-- Why a trigger and not application code: every outcome writer must honour it, and the rule is the
-- same kind as the other ledger rules (002/004/005), which the database enforces.
--
-- What is suppressed: the business. An outcome names an opportunity, not a contact, so the business
-- is the only target the reply itself identifies; contact_outreach_blocker (007) then refuses every
-- contact of that business, so message approval and sending refuse too. The row uses the existing
-- suppression table and its existing reason vocabulary ('opt_out'). It is per workspace: another
-- workspace's list is untouched (B11 is still open).
--
-- Only an explicit opt_out reply suppresses. not_interested, not_now, wrong_person, a call, a loss
-- and every other outcome change nothing here. A business already suppressed stays as it was.
-- Outcomes are append-only and a reply cannot be voided (only won/lost can), so there is no
-- un-suppress path to define.

SET search_path = scopely;

CREATE FUNCTION outcome_opt_out_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'replied' AND NEW.reply_class = 'opt_out' THEN
    INSERT INTO scopely.suppression (workspace_id, business_id, reason)
    SELECT o.workspace_id, o.business_id, 'opt_out' FROM scopely.opportunities o WHERE o.id = NEW.opportunity_id
    ON CONFLICT (workspace_id, business_id) WHERE business_id IS NOT NULL DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER outcome_opt_out_suppression AFTER INSERT ON outcomes
  FOR EACH ROW EXECUTE FUNCTION outcome_opt_out_suppression();
