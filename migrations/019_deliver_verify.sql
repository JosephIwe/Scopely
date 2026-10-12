-- 019_deliver_verify: Deliver and Verify from the Case File (release 1, A44–A46).
--
-- Delivery is the existing `delivered` outcome (002/004): outcome_guard still refuses a delivery
-- before a win and CLIENT_REQUIRED work not delivered by the client with confirmation. Nothing here
-- changes that.
--
-- Verification is the existing `verifications` table and verification_guard (002/004): a later
-- snapshot of the same business, the same check and rule version as the baseline evidence, and
-- PASSED only on an OBSERVED ok. This migration adds:
--
--   requested_by   who asked Scopely to run the verification (a free-text actor, like recorded_by;
--                  A40 fills it with the signed-in person). Nullable because earlier rows were written by hand without one.
--   append-only    a verification is history: a later check is a new row, never an edit. The same
--                  rule as evidence_rechecks (005).

SET search_path = scopely;

ALTER TABLE verifications
  ADD COLUMN requested_by text CHECK (requested_by IS NULL OR btrim(requested_by) <> '');

CREATE FUNCTION verifications_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VERIFY: verifications are append-only; run a new verification instead' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER verifications_append_only BEFORE UPDATE ON verifications
  FOR EACH ROW EXECUTE FUNCTION verifications_append_only();
