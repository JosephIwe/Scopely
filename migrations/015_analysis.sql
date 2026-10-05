-- 015_analysis: ANALYZE for businesses a seller selected in a search run (Slice 11).
--
-- SELECTED -> ANALYSIS_QUEUED -> ANALYZED -> OPPORTUNITY_FOUND | NO_OPPORTUNITY already exists (008).
-- This migration adds only what an automated, deterministic analysis needs to stay traceable:
--
-- 1. business_analyses: one row per business per run, written when Scopely analysed it. It says
--    which analyser ran, what address it asked for (or that none was known, or that the address was
--    refused before any request), when, and for whom. One per run and business, so analysing twice
--    is impossible, and the row never changes.
-- 2. snapshots.analysis_id: a page Scopely fetched during an analysis points at it, so every
--    observation, evidence row and opportunity it produced can be traced to the analysis, the run and
--    the search. The snapshot's business is the analysis's business.
-- 3. Rule versions for the automated checks. The VALIDATED version 1 rules describe checks a
--    person made by hand on the golden set; an automated static-HTML implementation of them has not
--    been validated against that set, so it is a new HYPOTHESIS version of each rule (rule 6). The
--    issue codes are unchanged. check.page_signals records page facts (title, description,
--    viewport, forms, contact paths) and has no issue codes: it never produces evidence.
--
-- No price, credit rate or provider is named here. Fetches are metered as cost_events of kind
-- 'fetch' with no amount (unknown is NULL, never 0).

SET search_path = scopely;

-- ------------------------------------------------------------------ 1. analyses

CREATE TABLE business_analyses (
  id             bigserial PRIMARY KEY,
  workspace_id   bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  search_run_id  bigint NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
  business_id    bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  analyzer       text NOT NULL CHECK (analyzer ~ '^[a-z][a-z0-9_.-]{1,40}/[0-9]{1,4}$'),
  -- CHECKED: the address was requested (whatever came back). NO_ADDRESS: no website address is
  -- known, so nothing was requested. REFUSED: the known address is not a public web address, so it
  -- was never requested.
  outcome        text NOT NULL CHECK (outcome IN ('CHECKED','NO_ADDRESS','REFUSED')),
  requested_url  text CHECK (requested_url IS NULL OR length(requested_url) BETWEEN 1 AND 2048),
  requested_by   text NOT NULL CHECK (btrim(requested_by) <> '' AND length(requested_by) <= 80),
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL,
  UNIQUE (search_run_id, business_id),
  CHECK (finished_at >= started_at),
  CHECK ((outcome = 'NO_ADDRESS') = (requested_url IS NULL))
);
CREATE INDEX business_analyses_business_idx ON business_analyses (business_id);

-- An analysis is only for a business a person selected and Scopely queued in that run, and once
-- written it is the record of what was done: it never changes.
CREATE FUNCTION business_analysis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ANALYSIS: an analysis record never changes' USING ERRCODE = 'check_violation';
  END IF;
  SELECT state INTO st FROM scopely.search_run_businesses WHERE search_run_id = NEW.search_run_id AND business_id = NEW.business_id;
  IF st IS DISTINCT FROM 'ANALYSIS_QUEUED' THEN
    RAISE EXCEPTION 'ANALYSIS: business % is % in run %; only a selected business queued for analysis is analysed',
      NEW.business_id, coalesce(st, 'absent'), NEW.search_run_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_analysis_guard BEFORE INSERT OR UPDATE ON business_analyses
  FOR EACH ROW EXECUTE FUNCTION business_analysis_guard();

CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON business_analyses
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('search_run_id','search_runs','business_id','businesses');
ALTER TABLE business_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON business_analyses USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

-- ------------------------------------------------------------------ 2. snapshots of an analysis

ALTER TABLE snapshots ADD COLUMN analysis_id bigint REFERENCES business_analyses(id) ON DELETE CASCADE;
CREATE INDEX snapshots_analysis_idx ON snapshots (analysis_id) WHERE analysis_id IS NOT NULL;
DROP TRIGGER a00_workspace_guard ON snapshots;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','analysis_id','business_analyses');

CREATE FUNCTION snapshot_analysis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ab bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.analysis_id IS DISTINCT FROM OLD.analysis_id THEN
    RAISE EXCEPTION 'ANALYSIS: a snapshot''s analysis never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.analysis_id IS NULL THEN RETURN NEW; END IF;
  SELECT business_id INTO ab FROM scopely.business_analyses WHERE id = NEW.analysis_id;
  IF ab IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'ANALYSIS: snapshot of business % cannot belong to the analysis of business %', NEW.business_id, ab
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_analysis_guard BEFORE INSERT OR UPDATE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION snapshot_analysis_guard();

-- ------------------------------------------------------------------ 3. automated check versions

INSERT INTO rule_versions (rule_key, version, kind, playbook_id, description, validation_status, validation_basis, definition) VALUES
('check.contact_links', 2, 'check', NULL,
 'Automated version of check.contact_links v1 on the page''s served HTML: parse tel:, WhatsApp (wa.me, api.whatsapp.com) and mailto: links; a tel: href with letters, a +44 number that keeps the trunk 0 or fewer than 6 digits; a WhatsApp link with no number or a number without a country code; a mailto: that is not an address or uses a reserved or placeholder domain; a link labelled WhatsApp that opens a call or an email. Whether a mailbox accepts mail is not checked.',
 'HYPOTHESIS', NULL,
 '{"issue_codes":["E-TEL-BROKEN","E-WA-BROKEN","E-LINK-TARGET-MISMATCH","E-EMAIL-INVALID"],"implements":"check.contact_links/1","mechanism":"static_html","analyzer":"scopely.static/1"}'),
('check.booking_cta_trace', 2, 'check', NULL,
 'Automated version of check.booking_cta_trace v1 on the page''s served HTML: a Book/Appointment link to another address is requested once (SSRF-safe GET, no form submitted); an answer of 404 or 410, or a host name that does not exist, is a dead end. A link handled by script (#, javascript:) and a 401, 403, 429, 5xx or timeout are not observable. Booking-to-enquiry is not judged.',
 'HYPOTHESIS', NULL,
 '{"issue_codes":["E-CTA-DEAD-END"],"implements":"check.booking_cta_trace/1","mechanism":"static_html","analyzer":"scopely.static/1"}'),
('check.booking_platform_fingerprint', 2, 'check', NULL,
 'Automated version of check.booking_platform_fingerprint v1: known self-booking platform hosts in the served HTML''s links, scripts and frames. Not finding one is not observable, because a widget can be added by script.',
 'HYPOTHESIS', NULL,
 '{"issue_codes":["O-BOOKING-PLATFORM"],"implements":"check.booking_platform_fingerprint/1","mechanism":"static_html","analyzer":"scopely.static/1"}'),
('check.page_signals', 1, 'check', NULL,
 'Page facts from the served HTML: title, meta description, mobile viewport, forms (never submitted), contact page, and parked or placeholder pages. These are facts for the seller, never a finding: the rule has no issue codes.',
 'HYPOTHESIS', NULL,
 '{"issue_codes":[],"mechanism":"static_html","analyzer":"scopely.static/1"}');
