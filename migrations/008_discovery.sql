-- 008_discovery: one discovery and qualification system that yields both opportunity paths.
--
-- USER / WORKSPACE -> SEARCH (the ICP) -> SEARCH RUN -> DISCOVERED -> PRE-QUALIFIED (cheap, from
-- firmographics only) -> SELECTED within the run's limits -> ANALYSIS -> OPPORTUNITY (WEBSITE or
-- FIX path) -> evidence -> service -> BUILD -> SELL -> DELIVER -> VERIFY -> outcome.
--
-- 1. Firmographics on the business, each group with where it came from and how sure it is
--    (VERIFIED / REPORTED / ESTIMATED). Unknown stays NULL; an estimate is never a verified value.
-- 2. Website status is explicit, and a failed or blocked fetch can never become "no website":
--    WEBSITE_NOT_OBSERVED is refused while any domain or URL is known, and the E-NO-WEBSITE finding
--    needs that status.
-- 3. build_kinds say which path they belong to (WEBSITE or FIX); an opportunity carries its kind.
--    A business can hold any number of opportunities of either path.
-- 4. searches are reusable ICPs owned by a workspace; search_runs are single executions that
--    freeze the criteria they ran with; search_run_businesses hold each business's state in a run.
--    A business is one row per workspace and can appear in many runs.
-- 5. Analysis is resource-aware: selection is capped by the run's max_businesses_to_analyze,
--    queueing is capped by its credit budget, and a metered cost that would exceed the budget is
--    refused. An unknown cost under a budget is refused, never assumed.
-- 6. Views for the frontend: run summary, stage funnel, unified opportunity feed, map points and
--    per-search performance. All run with the caller's rights.

SET search_path = scopely;

-- ------------------------------------------------------------------ 1. firmographics

ALTER TABLE businesses DROP CONSTRAINT businesses_independence_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_independence_check
  CHECK (independence IN ('independent','franchise','group','chain','unknown'));

ALTER TABLE businesses
  ADD COLUMN specialty          text,                    -- sub-niche (industry = vertical, niche = subvertical)
  ADD COLUMN address_line       text,
  ADD COLUMN latitude           numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude          numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN geo_source         text,
  ADD COLUMN phone              text,
  ADD COLUMN incorporated_on    date,
  ADD COLUMN employee_count     integer CHECK (employee_count >= 0),
  ADD COLUMN employee_count_min integer CHECK (employee_count_min >= 0),
  ADD COLUMN employee_count_max integer CHECK (employee_count_max >= 0),
  ADD COLUMN employees_basis    text CHECK (employees_basis IN ('VERIFIED','REPORTED','ESTIMATED')),
  ADD COLUMN employees_source   text,
  ADD COLUMN employees_as_of    timestamptz,
  ADD COLUMN revenue_amount     numeric(16,2) CHECK (revenue_amount >= 0),
  ADD COLUMN revenue_min        numeric(16,2) CHECK (revenue_min >= 0),
  ADD COLUMN revenue_max        numeric(16,2) CHECK (revenue_max >= 0),
  ADD COLUMN revenue_currency   char(3) CHECK (revenue_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN revenue_basis      text CHECK (revenue_basis IN ('VERIFIED','REPORTED','ESTIMATED')),
  ADD COLUMN revenue_source     text,
  ADD COLUMN revenue_as_of      timestamptz,
  ADD COLUMN review_count       integer CHECK (review_count >= 0),
  ADD COLUMN rating             numeric(3,2) CHECK (rating BETWEEN 0 AND 5),
  ADD COLUMN reviews_source     text,
  ADD COLUMN reviews_as_of      timestamptz,
  ADD COLUMN website_status     text NOT NULL DEFAULT 'UNKNOWN' CHECK (website_status IN (
                                  'UNKNOWN','WEBSITE_PRESENT','WEBSITE_NOT_OBSERVED','WEBSITE_UNREACHABLE','WEBSITE_NEEDS_REVIEW')),
  ADD COLUMN website_status_basis text CHECK (website_status_basis IN ('OBSERVED','INFERRED','NOT_OBSERVABLE')),
  ADD COLUMN website_status_source text,
  ADD COLUMN website_status_checked_at timestamptz;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_geo_check CHECK ((latitude IS NULL) = (longitude IS NULL)
    AND (latitude IS NULL OR coalesce(btrim(geo_source), '') <> '')),
  -- A size or revenue figure always says where it came from, how sure it is, and when.
  ADD CONSTRAINT businesses_employees_check CHECK (
    (employee_count IS NULL AND employee_count_min IS NULL AND employee_count_max IS NULL
       AND employees_basis IS NULL AND employees_source IS NULL AND employees_as_of IS NULL)
    OR (employees_basis IS NOT NULL AND coalesce(btrim(employees_source), '') <> '' AND employees_as_of IS NOT NULL
        AND (employee_count IS NOT NULL OR employee_count_min IS NOT NULL OR employee_count_max IS NOT NULL))),
  ADD CONSTRAINT businesses_employee_range_check CHECK (
    (employee_count_min IS NULL OR employee_count_max IS NULL OR employee_count_min <= employee_count_max)
    AND (employee_count IS NULL OR employee_count_min IS NULL OR employee_count >= employee_count_min)
    AND (employee_count IS NULL OR employee_count_max IS NULL OR employee_count <= employee_count_max)),
  ADD CONSTRAINT businesses_revenue_check CHECK (
    (revenue_amount IS NULL AND revenue_min IS NULL AND revenue_max IS NULL AND revenue_currency IS NULL
       AND revenue_basis IS NULL AND revenue_source IS NULL AND revenue_as_of IS NULL)
    OR (revenue_currency IS NOT NULL AND revenue_basis IS NOT NULL AND coalesce(btrim(revenue_source), '') <> ''
        AND revenue_as_of IS NOT NULL AND (revenue_amount IS NOT NULL OR revenue_min IS NOT NULL OR revenue_max IS NOT NULL))),
  ADD CONSTRAINT businesses_revenue_range_check CHECK (
    (revenue_min IS NULL OR revenue_max IS NULL OR revenue_min <= revenue_max)
    AND (revenue_amount IS NULL OR revenue_min IS NULL OR revenue_amount >= revenue_min)
    AND (revenue_amount IS NULL OR revenue_max IS NULL OR revenue_amount <= revenue_max)),
  ADD CONSTRAINT businesses_reviews_check CHECK (
    (review_count IS NULL AND rating IS NULL) OR (coalesce(btrim(reviews_source), '') <> '' AND reviews_as_of IS NOT NULL)),
  -- ------------------------------------------------------------ 2. website status
  -- Any status other than UNKNOWN says how it was established, by what, and when.
  ADD CONSTRAINT businesses_website_basis_required_check CHECK (
    website_status = 'UNKNOWN'
    OR (website_status_basis IS NOT NULL AND coalesce(btrim(website_status_source), '') <> '' AND website_status_checked_at IS NOT NULL)),
  -- A present or unreachable website is a known address; "not observed" means no address is known.
  -- So a fetch that failed on a known domain is UNREACHABLE, never NOT_OBSERVED.
  ADD CONSTRAINT businesses_website_not_observed_check CHECK (
    website_status <> 'WEBSITE_NOT_OBSERVED' OR (domain IS NULL AND website_url IS NULL)),
  ADD CONSTRAINT businesses_website_address_check CHECK (
    website_status NOT IN ('WEBSITE_PRESENT','WEBSITE_UNREACHABLE') OR domain IS NOT NULL OR website_url IS NOT NULL),
  -- What could not be observed never becomes a presence or an absence.
  ADD CONSTRAINT businesses_website_not_observable_check CHECK (
    website_status_basis IS DISTINCT FROM 'NOT_OBSERVABLE'
    OR website_status IN ('UNKNOWN','WEBSITE_UNREACHABLE','WEBSITE_NEEDS_REVIEW'));

-- Findings that only hold for one website status (E-NO-WEBSITE needs WEBSITE_NOT_OBSERVED).
ALTER TABLE issue_codes ADD COLUMN requires_website_status text CHECK (requires_website_status IN (
  'WEBSITE_PRESENT','WEBSITE_NOT_OBSERVED','WEBSITE_UNREACHABLE','WEBSITE_NEEDS_REVIEW'));

INSERT INTO rule_versions (rule_key, version, kind, playbook_id, description, validation_status, validation_basis, definition) VALUES
('check.website_presence', 1, 'check', NULL,
 'Establish whether the business has a website: a known domain or URL that loads (present), a known one that does not (unreachable), or a business profile or listing that shows no website while no domain is known (not observed). A failed, blocked or timed-out fetch is never "no website".',
 'HYPOTHESIS', NULL, '{"issue_codes":["E-NO-WEBSITE"]}'),
('qualify.search_criteria', 1, 'qualification', NULL,
 'Pre-qualify a discovered business against its search run''s frozen criteria, stage by stage (geography, industry, size, revenue, structure, online presence, signals, contactability, exclusions). A criterion whose input is unknown is recorded as unknown and sends the business to review; it never passes or fails on a guess.',
 'HYPOTHESIS', NULL, '{"stages":["geography","industry","size","revenue","structure","online_presence","signals","contactability","exclusions"]}');

INSERT INTO issue_codes (code, playbook_id, kind, title, description, default_confidence, lead_eligible, validation_status, requires_website_status) VALUES
('E-NO-WEBSITE', NULL, 'issue', 'No website found',
 'The business''s own profile or listing shows no website and no domain is known. Needs website status WEBSITE_NOT_OBSERVED; a failed or blocked fetch is never this finding.',
 'MEDIUM', true, 'HYPOTHESIS', 'WEBSITE_NOT_OBSERVED');

CREATE FUNCTION evidence_website_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE needed text; actual text;
BEGIN
  SELECT requires_website_status INTO needed FROM scopely.issue_codes WHERE code = NEW.issue_code;
  IF needed IS NULL THEN RETURN NEW; END IF;
  SELECT website_status INTO actual FROM scopely.businesses WHERE id = NEW.business_id;
  IF actual IS DISTINCT FROM needed THEN
    RAISE EXCEPTION 'TRUTH_RULE: % needs website status %, but the business is %', NEW.issue_code, needed, coalesce(actual, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_website_status_guard BEFORE INSERT OR UPDATE ON evidence
  FOR EACH ROW EXECUTE FUNCTION evidence_website_status_guard();

-- The send/show gate also refuses a finding whose website-status premise no longer holds (a
-- "no website" finding for a business now known to have one), whatever its confidence.
CREATE OR REPLACE FUNCTION evidence_send_blocker(ids bigint[], at timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT DISTINCT ON (e.id) e.id, e.confidence, r.result
      FROM scopely.evidence e
      LEFT JOIN scopely.evidence_rechecks r ON r.evidence_id = e.id AND r.rechecked_at <= at
     WHERE e.id = ANY (ids)
     ORDER BY e.id, r.rechecked_at DESC NULLS LAST
  ), reasons AS (
    SELECT id, CASE WHEN result IN ('changed','gone')
                    THEN format('evidence %s was re-checked as %s and must be dropped', id, result)
                    ELSE format('HIGH evidence %s has no confirmed re-check at or before %s', id, at) END AS reason
      FROM latest
     WHERE result IN ('changed','gone') OR (confidence = 'HIGH' AND result IS NULL)
    UNION ALL
    SELECT e.id, format('evidence %s needs website status %s but the business is now %s; re-check it',
                        e.id, ic.requires_website_status, b.website_status)
      FROM scopely.evidence e
      JOIN scopely.issue_codes ic ON ic.code = e.issue_code
      JOIN scopely.businesses b ON b.id = e.business_id
     WHERE e.id = ANY (ids) AND ic.requires_website_status IS NOT NULL AND b.website_status <> ic.requires_website_status
  )
  SELECT reason FROM reasons ORDER BY id LIMIT 1
$$;

-- ------------------------------------------------------------------ 3. opportunity paths

ALTER TABLE build_kinds ADD COLUMN opportunity_path text CHECK (opportunity_path IN ('WEBSITE','FIX'));
UPDATE build_kinds SET opportunity_path = CASE WHEN key = 'website' THEN 'WEBSITE' ELSE 'FIX' END;
-- Only building a website from nothing is the WEBSITE path; every other kind improves something
-- the business already has, so a new kind is FIX unless it says otherwise.
ALTER TABLE build_kinds ALTER COLUMN opportunity_path SET NOT NULL;
ALTER TABLE build_kinds ALTER COLUMN opportunity_path SET DEFAULT 'FIX';

-- ------------------------------------------------------------------ 4. searches and runs

CREATE TABLE searches (
  id                     bigserial PRIMARY KEY,
  workspace_id           bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  name                   text NOT NULL CHECK (btrim(name) <> ''),
  description            text,
  playbook_id            bigint REFERENCES niche_playbooks(id),   -- which detection rules analysis uses
  -- geography
  country_code           char(2) CHECK (country_code ~ '^[A-Z]{2}$'),
  region                 text,
  city                   text,
  postal_prefix          text,
  center_latitude        numeric(9,6) CHECK (center_latitude BETWEEN -90 AND 90),
  center_longitude       numeric(9,6) CHECK (center_longitude BETWEEN -180 AND 180),
  radius_km              numeric(8,2) CHECK (radius_km > 0),
  -- industry (industry = vertical, niche = subvertical, sub-niche = specialty)
  verticals              text[] NOT NULL DEFAULT '{}',
  subverticals           text[] NOT NULL DEFAULT '{}',
  specialties            text[] NOT NULL DEFAULT '{}',
  -- company size and revenue: the seller's commercial qualification, not a product assumption
  employee_min           integer CHECK (employee_min >= 0),
  employee_max           integer CHECK (employee_max >= 0),
  revenue_min            numeric(16,2) CHECK (revenue_min >= 0),
  revenue_max            numeric(16,2) CHECK (revenue_max >= 0),
  revenue_currency       char(3) CHECK (revenue_currency ~ '^[A-Z]{3}$'),
  -- business structure
  business_types         text[] NOT NULL DEFAULT '{}',            -- allowed values of businesses.independence
  exclude_chains         boolean NOT NULL DEFAULT false,
  exclude_franchises     boolean NOT NULL DEFAULT false,
  -- online presence
  website_presence       text NOT NULL DEFAULT 'any' CHECK (website_presence IN ('any','required','absent')),
  website_statuses       text[] NOT NULL DEFAULT '{}',
  -- what the seller wants to find (build_kinds keys); guides analysis and filters results
  opportunity_kinds      text[] NOT NULL DEFAULT '{}',
  -- business signals
  review_count_min       integer CHECK (review_count_min >= 0),
  review_count_max       integer CHECK (review_count_max >= 0),
  rating_min             numeric(3,2) CHECK (rating_min BETWEEN 0 AND 5),
  rating_max             numeric(3,2) CHECK (rating_max BETWEEN 0 AND 5),
  business_age_min_years integer CHECK (business_age_min_years >= 0),
  business_age_max_years integer CHECK (business_age_max_years >= 0),
  -- contactability
  require_public_email   boolean NOT NULL DEFAULT false,
  require_phone          boolean NOT NULL DEFAULT false,
  require_domain         boolean NOT NULL DEFAULT false,
  -- exclusions (suppressed businesses cannot be contacted anyway, so they are excluded by default)
  exclude_previously_analyzed  boolean NOT NULL DEFAULT false,
  exclude_previously_contacted boolean NOT NULL DEFAULT false,
  exclude_existing_clients     boolean NOT NULL DEFAULT false,
  exclude_won                  boolean NOT NULL DEFAULT false,
  exclude_lost                 boolean NOT NULL DEFAULT false,
  exclude_suppressed           boolean NOT NULL DEFAULT true,
  excluded_domains             text[] NOT NULL DEFAULT '{}',
  excluded_business_types      text[] NOT NULL DEFAULT '{}',      -- matched against vertical, subvertical, specialty
  -- resource limits
  max_businesses_to_analyze    integer CHECK (max_businesses_to_analyze > 0),
  analysis_budget_credits      numeric(14,4) CHECK (analysis_budget_credits >= 0),
  max_discovered_per_run       integer CHECK (max_discovered_per_run > 0),
  created_by_user_id     bigint REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  CHECK (employee_min IS NULL OR employee_max IS NULL OR employee_min <= employee_max),
  CHECK (revenue_min IS NULL OR revenue_max IS NULL OR revenue_min <= revenue_max),
  CHECK ((revenue_min IS NULL AND revenue_max IS NULL) OR revenue_currency IS NOT NULL),
  CHECK (review_count_min IS NULL OR review_count_max IS NULL OR review_count_min <= review_count_max),
  CHECK (rating_min IS NULL OR rating_max IS NULL OR rating_min <= rating_max),
  CHECK (business_age_min_years IS NULL OR business_age_max_years IS NULL OR business_age_min_years <= business_age_max_years),
  CHECK ((center_latitude IS NULL) = (center_longitude IS NULL)),
  CHECK (radius_km IS NULL OR center_latitude IS NOT NULL),
  CHECK (business_types <@ ARRAY['independent','franchise','group','chain','unknown']),
  CHECK (website_statuses <@ ARRAY['UNKNOWN','WEBSITE_PRESENT','WEBSITE_NOT_OBSERVED','WEBSITE_UNREACHABLE','WEBSITE_NEEDS_REVIEW'])
);
CREATE INDEX searches_workspace_idx ON searches (workspace_id, created_at);

CREATE FUNCTION search_kinds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE missing text;
BEGIN
  SELECT k INTO missing FROM unnest(NEW.opportunity_kinds) k
   WHERE NOT EXISTS (SELECT 1 FROM scopely.build_kinds b WHERE b.key = k) LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'SEARCH: unknown opportunity kind %', missing USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_kinds_guard BEFORE INSERT OR UPDATE ON searches FOR EACH ROW EXECUTE FUNCTION search_kinds_guard();

-- One execution of a search. The criteria and limits it ran with are frozen here, so a later edit
-- of the search never changes what a past run meant.
CREATE TABLE search_runs (
  id                        bigserial PRIMARY KEY,
  workspace_id              bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  search_id                 bigint NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  criteria                  jsonb NOT NULL,
  max_businesses_to_analyze integer CHECK (max_businesses_to_analyze > 0),
  analysis_budget_credits   numeric(14,4) CHECK (analysis_budget_credits >= 0),
  max_discovered_per_run    integer CHECK (max_discovered_per_run > 0),
  status                    text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
  started_by_user_id        bigint REFERENCES users(id),
  started_at                timestamptz NOT NULL DEFAULT now(),
  completed_at              timestamptz,
  CHECK ((status = 'OPEN') = (completed_at IS NULL))
);
CREATE INDEX search_runs_search_idx ON search_runs (search_id, started_at);

CREATE FUNCTION search_run_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO s FROM scopely.searches WHERE id = NEW.search_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF s.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'SEARCH: search % is archived', NEW.search_id USING ERRCODE = 'check_violation';
    END IF;
    NEW.criteria := to_jsonb(s) - 'id' - 'workspace_id' - 'created_at' - 'created_by_user_id' - 'archived_at';
    NEW.max_businesses_to_analyze := s.max_businesses_to_analyze;
    NEW.analysis_budget_credits := s.analysis_budget_credits;
    NEW.max_discovered_per_run := s.max_discovered_per_run;
  ELSIF NEW.criteria IS DISTINCT FROM OLD.criteria OR NEW.search_id IS DISTINCT FROM OLD.search_id
     OR NEW.max_businesses_to_analyze IS DISTINCT FROM OLD.max_businesses_to_analyze
     OR NEW.analysis_budget_credits IS DISTINCT FROM OLD.analysis_budget_credits
     OR NEW.max_discovered_per_run IS DISTINCT FROM OLD.max_discovered_per_run THEN
    RAISE EXCEPTION 'SEARCH: a run''s criteria and limits are frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_run_freeze BEFORE INSERT OR UPDATE ON search_runs FOR EACH ROW EXECUTE FUNCTION search_run_freeze();

-- Where a discovered business came from, per run and provider.
ALTER TABLE sources
  ADD COLUMN provider      text,                          -- 'clay', 'google_places', 'csv', 'operator', ...
  ADD COLUMN search_run_id bigint REFERENCES search_runs(id) ON DELETE SET NULL;
CREATE INDEX sources_business_idx ON sources (business_id);
DROP TRIGGER a00_workspace_guard ON sources;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','search_run_id','search_runs');

-- A business's state within one run. DISCOVERED is not QUALIFIED is not ANALYZED is not an
-- opportunity. Qualification is per run (a business can fit one search and not another), and it
-- is separate from businesses.qualification_status, the operator's standing verdict.
CREATE TABLE search_run_businesses (
  id                            bigserial PRIMARY KEY,
  workspace_id                  bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  search_run_id                 bigint NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
  business_id                   bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_id                     bigint REFERENCES sources(id) ON DELETE SET NULL,
  state                         text NOT NULL DEFAULT 'DISCOVERED' CHECK (state IN (
                                  'DISCOVERED','QUALIFIED','REJECTED','NEEDS_REVIEW','SELECTED',
                                  'ANALYSIS_QUEUED','ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY')),
  discovered_at                 timestamptz NOT NULL DEFAULT now(),
  qualification                 jsonb,                   -- per-criterion pass / fail / unknown, with the values used
  failed_stage                  text CHECK (failed_stage IN ('geography','industry','size','revenue','structure',
                                                             'online_presence','signals','contactability','exclusions')),
  unknown_stages                text[] NOT NULL DEFAULT '{}',
  qualification_rule_version_id bigint REFERENCES rule_versions(id),
  qualified_at                  timestamptz,
  reviewed_by                   text,
  review_note                   text,
  selected_at                   timestamptz,
  selected_by                   text,
  estimated_credits             numeric(14,4) CHECK (estimated_credits >= 0),   -- NULL = not known
  queued_at                     timestamptz,
  analyzed_at                   timestamptz,
  concluded_at                  timestamptz,
  UNIQUE (search_run_id, business_id),
  CHECK (state = 'DISCOVERED' OR (qualification IS NOT NULL AND qualification_rule_version_id IS NOT NULL AND qualified_at IS NOT NULL)),
  CHECK ((state = 'REJECTED') = (failed_stage IS NOT NULL)),
  CHECK (state NOT IN ('SELECTED','ANALYSIS_QUEUED','ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY')
         OR (selected_at IS NOT NULL AND coalesce(btrim(selected_by), '') <> '')),
  CHECK (state NOT IN ('ANALYSIS_QUEUED','ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY') OR queued_at IS NOT NULL),
  CHECK (state NOT IN ('ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY') OR analyzed_at IS NOT NULL),
  CHECK (state NOT IN ('OPPORTUNITY_FOUND','NO_OPPORTUNITY') OR concluded_at IS NOT NULL)
);
CREATE INDEX search_run_businesses_run_state_idx ON search_run_businesses (search_run_id, state);
CREATE INDEX search_run_businesses_business_idx ON search_run_businesses (business_id);

-- The run pipeline. Only the transitions below exist, so a rejected or merely discovered business
-- can never be queued for analysis, and nothing is analyzed that was not selected and queued.
-- Selection respects max_businesses_to_analyze; queueing respects the credit budget.
CREATE FUNCTION search_run_business_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run record; allowed text[]; n bigint; consumed numeric; pending numeric; opps bigint;
BEGIN
  SELECT * INTO run FROM scopely.search_runs WHERE id = NEW.search_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DISCOVERED' THEN
      RAISE EXCEPTION 'SEARCH: a business enters a run as DISCOVERED, not %', NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF run.status <> 'OPEN' THEN
      RAISE EXCEPTION 'SEARCH: run % is %', run.id, run.status USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n FROM scopely.search_run_businesses WHERE search_run_id = run.id;
    IF run.max_discovered_per_run IS NOT NULL AND n >= run.max_discovered_per_run THEN
      RAISE EXCEPTION 'SEARCH: run % already holds its limit of % discovered businesses', run.id, run.max_discovered_per_run
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.search_run_id <> OLD.search_run_id OR NEW.business_id <> OLD.business_id THEN
    RAISE EXCEPTION 'SEARCH: a run membership cannot move' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    IF NEW.state IN ('ANALYSIS_QUEUED','ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY')
       AND NEW.estimated_credits IS DISTINCT FROM OLD.estimated_credits THEN
      RAISE EXCEPTION 'SEARCH: the estimate of a queued analysis cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  allowed := CASE OLD.state
    WHEN 'DISCOVERED'      THEN ARRAY['QUALIFIED','REJECTED','NEEDS_REVIEW']
    WHEN 'NEEDS_REVIEW'    THEN ARRAY['QUALIFIED','REJECTED']
    WHEN 'QUALIFIED'       THEN ARRAY['SELECTED','REJECTED']
    WHEN 'SELECTED'        THEN ARRAY['QUALIFIED','ANALYSIS_QUEUED']
    WHEN 'ANALYSIS_QUEUED' THEN ARRAY['ANALYZED']
    WHEN 'ANALYZED'        THEN ARRAY['OPPORTUNITY_FOUND','NO_OPPORTUNITY']
    WHEN 'NO_OPPORTUNITY'  THEN ARRAY['OPPORTUNITY_FOUND']
    ELSE ARRAY[]::text[] END;
  IF NOT NEW.state = ANY (allowed) THEN
    RAISE EXCEPTION 'SEARCH: a business cannot move from % to % in a run', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  -- Leaving review for QUALIFIED or REJECTED is a person's decision and says so.
  IF OLD.state = 'NEEDS_REVIEW' AND (coalesce(btrim(NEW.reviewed_by), '') = '' OR coalesce(btrim(NEW.review_note), '') = '') THEN
    RAISE EXCEPTION 'SEARCH: resolving a review needs reviewed_by and review_note' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('SELECTED','ANALYSIS_QUEUED') AND run.status <> 'OPEN' THEN
    RAISE EXCEPTION 'SEARCH: run % is %', run.id, run.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'SELECTED' AND run.max_businesses_to_analyze IS NOT NULL THEN
    SELECT count(*) INTO n FROM scopely.search_run_businesses
     WHERE search_run_id = run.id AND id <> NEW.id
       AND state IN ('SELECTED','ANALYSIS_QUEUED','ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY');
    IF n >= run.max_businesses_to_analyze THEN
      RAISE EXCEPTION 'SEARCH: run % already has its limit of % businesses selected for analysis', run.id, run.max_businesses_to_analyze
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Committed credits = what has been metered on the run + estimates of analyses still queued.
  IF NEW.state = 'ANALYSIS_QUEUED' AND run.analysis_budget_credits IS NOT NULL THEN
    IF NEW.estimated_credits IS NULL THEN
      RAISE EXCEPTION 'SEARCH: run % has a credit budget, so a queued analysis needs a known estimate', run.id
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(credits), 0) INTO consumed FROM scopely.cost_events WHERE search_run_id = run.id;
    SELECT coalesce(sum(estimated_credits), 0) INTO pending FROM scopely.search_run_businesses
     WHERE search_run_id = run.id AND id <> NEW.id AND state = 'ANALYSIS_QUEUED';
    IF consumed + pending + NEW.estimated_credits > run.analysis_budget_credits THEN
      RAISE EXCEPTION 'SEARCH: queueing needs % credits but run % has % of % left', NEW.estimated_credits, run.id,
        run.analysis_budget_credits - consumed - pending, run.analysis_budget_credits USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.state IN ('OPPORTUNITY_FOUND','NO_OPPORTUNITY') THEN
    SELECT count(*) INTO opps FROM scopely.opportunities WHERE search_run_id = run.id AND business_id = NEW.business_id;
    IF NEW.state = 'OPPORTUNITY_FOUND' AND opps = 0 THEN
      RAISE EXCEPTION 'SEARCH: OPPORTUNITY_FOUND needs an opportunity recorded for this business in this run' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'NO_OPPORTUNITY' AND opps > 0 THEN
      RAISE EXCEPTION 'SEARCH: this business has % opportunities in this run', opps USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_run_business_guard BEFORE INSERT OR UPDATE ON search_run_businesses
  FOR EACH ROW EXECUTE FUNCTION search_run_business_guard();

-- ------------------------------------------------------------------ 3 + 4. opportunities in runs

ALTER TABLE opportunities
  ADD COLUMN opportunity_kind text REFERENCES build_kinds(key),
  ADD COLUMN search_run_id    bigint REFERENCES search_runs(id) ON DELETE SET NULL;
CREATE INDEX opportunities_workspace_kind_idx ON opportunities (workspace_id, opportunity_kind, status);
CREATE INDEX opportunities_run_idx ON opportunities (search_run_id) WHERE search_run_id IS NOT NULL;
DROP TRIGGER a00_workspace_guard ON opportunities;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','market_id','markets','catalog_item_id','catalog_items',
                                                'search_run_id','search_runs');

-- The kind follows the mapped service when that service builds something; a stated kind that
-- contradicts it is refused. An opportunity found in a run must come from an analyzed business.
CREATE FUNCTION opportunity_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_kind text; st text;
BEGIN
  IF NEW.catalog_item_id IS NOT NULL THEN
    SELECT build_kind INTO item_kind FROM scopely.catalog_items WHERE id = NEW.catalog_item_id;
    IF item_kind IS NOT NULL THEN
      IF NEW.opportunity_kind IS NULL THEN
        NEW.opportunity_kind := item_kind;
      ELSIF NEW.opportunity_kind <> item_kind THEN
        RAISE EXCEPTION 'OPPORTUNITY: kind % contradicts its service, which builds %', NEW.opportunity_kind, item_kind
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW.search_run_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.search_run_id IS DISTINCT FROM OLD.search_run_id) THEN
    SELECT state INTO st FROM scopely.search_run_businesses WHERE search_run_id = NEW.search_run_id AND business_id = NEW.business_id;
    IF st IS NULL OR st NOT IN ('ANALYZED','OPPORTUNITY_FOUND') THEN
      RAISE EXCEPTION 'OPPORTUNITY: the business is % in run %, not analyzed', coalesce(st, 'absent'), NEW.search_run_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_kind_guard BEFORE INSERT OR UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunity_kind_guard();

-- ------------------------------------------------------------------ 5. credits

ALTER TABLE cost_events
  ADD COLUMN search_run_id bigint REFERENCES search_runs(id) ON DELETE CASCADE,
  ADD COLUMN credits       numeric(14,4) CHECK (credits >= 0);   -- Scopely analysis credits; NULL = not metered
CREATE INDEX cost_events_run_idx ON cost_events (search_run_id) WHERE search_run_id IS NOT NULL;
CREATE INDEX cost_events_opportunity_idx ON cost_events (opportunity_id) WHERE opportunity_id IS NOT NULL;
DROP TRIGGER a00_workspace_guard ON cost_events;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON cost_events
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','opportunity_id','opportunities','build_id','builds',
                                                'search_run_id','search_runs');

-- Analysis work in a run is only for businesses queued for it, and never takes the run past its
-- credit budget. Under a budget, analysis work must say what it cost in credits.
CREATE FUNCTION cost_event_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run record; st text; consumed numeric; is_analysis boolean;
BEGIN
  IF NEW.search_run_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.credits IS DISTINCT FROM OLD.credits OR NEW.search_run_id IS DISTINCT FROM OLD.search_run_id) THEN
    RAISE EXCEPTION 'COST: metered credits cannot be edited; record a new cost event' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  SELECT * INTO run FROM scopely.search_runs WHERE id = NEW.search_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  is_analysis := NEW.kind IN ('fetch','render','screenshot','llm_call');
  IF is_analysis THEN
    IF NEW.business_id IS NULL THEN
      RAISE EXCEPTION 'COST: analysis work in a run names the business analyzed' USING ERRCODE = 'check_violation';
    END IF;
    SELECT state INTO st FROM scopely.search_run_businesses WHERE search_run_id = run.id AND business_id = NEW.business_id;
    IF st IS NULL OR st NOT IN ('ANALYSIS_QUEUED','ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY') THEN
      RAISE EXCEPTION 'COST: business % is % in run %; only businesses queued for analysis are analyzed',
        NEW.business_id, coalesce(st, 'absent'), run.id USING ERRCODE = 'check_violation';
    END IF;
    IF run.analysis_budget_credits IS NOT NULL AND NEW.credits IS NULL THEN
      RAISE EXCEPTION 'COST: run % has a credit budget, so analysis work must record its credits', run.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.credits IS NOT NULL AND run.analysis_budget_credits IS NOT NULL THEN
    SELECT coalesce(sum(credits), 0) INTO consumed FROM scopely.cost_events WHERE search_run_id = run.id;
    IF consumed + NEW.credits > run.analysis_budget_credits THEN
      RAISE EXCEPTION 'COST: % credits would take run % past its budget (% of % used)', NEW.credits, run.id, consumed,
        run.analysis_budget_credits USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_event_run_guard BEFORE INSERT OR UPDATE ON cost_events
  FOR EACH ROW EXECUTE FUNCTION cost_event_run_guard();

-- ------------------------------------------------------------------ ownership and isolation

CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON searches
  FOR EACH ROW EXECUTE FUNCTION workspace_guard();
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON search_runs
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('search_id','searches');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON search_run_businesses
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('search_run_id','search_runs','business_id','businesses','source_id','sources');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['searches','search_runs','search_run_businesses'] LOOP
    EXECUTE format('ALTER TABLE scopely.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_isolation ON scopely.%I USING (workspace_id = scopely.current_workspace_id())
                    WITH CHECK (workspace_id = scopely.current_workspace_id())', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ filter indexes

-- Every frontend query is scoped to one workspace first, then filtered by these columns
-- (see docs/API_CONTRACT.md). Row-level security adds workspace_id to every predicate.
CREATE INDEX businesses_workspace_geo_idx      ON businesses (workspace_id, country_code, region, city);
CREATE INDEX businesses_workspace_industry_idx ON businesses (workspace_id, vertical, subvertical);
CREATE INDEX businesses_workspace_website_idx  ON businesses (workspace_id, website_status);
CREATE INDEX businesses_workspace_size_idx     ON businesses (workspace_id, employee_count_min, employee_count_max);
CREATE INDEX businesses_workspace_revenue_idx  ON businesses (workspace_id, revenue_currency, revenue_min, revenue_max);
CREATE INDEX businesses_workspace_latlng_idx   ON businesses (workspace_id, latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX businesses_workspace_domain_idx   ON businesses (workspace_id, lower(domain)) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX businesses_workspace_register_uq ON businesses (workspace_id, company_register, company_number)
  WHERE company_register IS NOT NULL AND company_number IS NOT NULL;
CREATE INDEX contacts_business_idx ON contacts (business_id);
CREATE INDEX evidence_business_idx ON evidence (business_id);

-- ------------------------------------------------------------------ 6. views

-- One row per run: how many businesses reached each stage, what the analysis cost in credits and
-- money, what it produced. Money and credit figures are NULL when any input is unknown.
CREATE VIEW v_search_run_summary AS
WITH m AS (
  SELECT search_run_id,
         count(*) AS discovered,
         count(*) FILTER (WHERE state IN ('QUALIFIED','SELECTED','ANALYSIS_QUEUED','ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY')) AS qualified,
         count(*) FILTER (WHERE state = 'REJECTED')     AS rejected,
         count(*) FILTER (WHERE state = 'NEEDS_REVIEW') AS needs_review,
         count(*) FILTER (WHERE state IN ('SELECTED','ANALYSIS_QUEUED','ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY')) AS selected,
         count(*) FILTER (WHERE state = 'ANALYSIS_QUEUED') AS analysis_queued,
         count(*) FILTER (WHERE state IN ('ANALYZED','OPPORTUNITY_FOUND','NO_OPPORTUNITY')) AS analyzed,
         count(*) FILTER (WHERE state = 'OPPORTUNITY_FOUND') AS with_opportunity,
         count(*) FILTER (WHERE state = 'NO_OPPORTUNITY')    AS without_opportunity,
         CASE WHEN bool_or(estimated_credits IS NULL) FILTER (WHERE state IN ('SELECTED','ANALYSIS_QUEUED')) THEN NULL
              ELSE coalesce(sum(estimated_credits) FILTER (WHERE state IN ('SELECTED','ANALYSIS_QUEUED')), 0) END AS estimated_credits_pending
    FROM scopely.search_run_businesses GROUP BY search_run_id
), o AS (
  SELECT o.search_run_id,
         count(*) AS opportunities,
         count(*) FILTER (WHERE bk.opportunity_path = 'WEBSITE') AS website_opportunities,
         count(*) FILTER (WHERE bk.opportunity_path = 'FIX')     AS fix_opportunities,
         count(*) FILTER (WHERE o.pitched_at IS NOT NULL) AS pitched,
         count(*) FILTER (WHERE o.won_at IS NOT NULL)     AS wins,
         sum(o.deal_value) AS revenue
    FROM scopely.opportunities o LEFT JOIN scopely.build_kinds bk ON bk.key = o.opportunity_kind
   WHERE o.search_run_id IS NOT NULL GROUP BY o.search_run_id
), c AS (
  SELECT search_run_id,
         CASE WHEN bool_or(credits IS NULL AND kind IN ('fetch','render','screenshot','llm_call')) THEN NULL
              ELSE coalesce(sum(credits), 0) END AS credits_consumed,
         CASE WHEN bool_or(amount IS NULL AND kind <> 'operator_time') THEN NULL ELSE sum(amount) END AS analysis_cost,
         min(currency) AS analysis_cost_currency,
         count(DISTINCT currency) AS currencies
    FROM scopely.cost_events WHERE search_run_id IS NOT NULL GROUP BY search_run_id
)
SELECT r.workspace_id, r.id AS search_run_id, r.search_id, s.name AS search_name, r.status, r.started_at, r.completed_at,
       coalesce(m.discovered, 0) AS discovered, coalesce(m.qualified, 0) AS qualified, coalesce(m.rejected, 0) AS rejected,
       coalesce(m.needs_review, 0) AS needs_review, coalesce(m.selected, 0) AS selected,
       coalesce(m.analysis_queued, 0) AS analysis_queued, coalesce(m.analyzed, 0) AS analyzed,
       coalesce(m.with_opportunity, 0) AS businesses_with_opportunity, coalesce(m.without_opportunity, 0) AS businesses_without_opportunity,
       coalesce(o.opportunities, 0) AS opportunities, coalesce(o.website_opportunities, 0) AS website_opportunities,
       coalesce(o.fix_opportunities, 0) AS fix_opportunities, coalesce(o.pitched, 0) AS pitched, coalesce(o.wins, 0) AS wins,
       r.max_businesses_to_analyze,
       r.analysis_budget_credits AS budget_credits,
       CASE WHEN c.search_run_id IS NULL THEN 0 ELSE c.credits_consumed END AS credits_consumed,
       m.estimated_credits_pending,
       CASE WHEN r.analysis_budget_credits IS NULL OR (c.search_run_id IS NOT NULL AND c.credits_consumed IS NULL) THEN NULL
            ELSE r.analysis_budget_credits - coalesce(c.credits_consumed, 0) END AS remaining_credits,
       CASE WHEN c.currencies > 1 THEN NULL ELSE c.analysis_cost END AS analysis_cost,
       CASE WHEN c.currencies > 1 THEN NULL ELSE c.analysis_cost_currency END AS analysis_cost_currency,
       o.revenue,
       CASE WHEN o.revenue IS NULL OR coalesce(m.discovered, 0) = 0 THEN NULL ELSE round(o.revenue * 100.0 / m.discovered, 2) END
         AS revenue_per_100_discovered,
       CASE WHEN o.revenue IS NULL OR coalesce(m.analyzed, 0) = 0 THEN NULL ELSE round(o.revenue * 100.0 / m.analyzed, 2) END
         AS revenue_per_100_analyzed
  FROM scopely.search_runs r
  JOIN scopely.searches s ON s.id = r.search_id
  LEFT JOIN m ON m.search_run_id = r.id
  LEFT JOIN o ON o.search_run_id = r.id
  LEFT JOIN c ON c.search_run_id = r.id;

-- The pre-qualification funnel: how many businesses remain after each stage, in stage order.
-- A business rejected at a stage leaves the pool there; one only unknown at a stage stays in the
-- pool and is counted under needs_review_at_stage.
CREATE VIEW v_search_run_stage_funnel AS
WITH stages(stage_order, stage) AS (VALUES
  (1,'geography'),(2,'industry'),(3,'size'),(4,'revenue'),(5,'structure'),
  (6,'online_presence'),(7,'signals'),(8,'contactability'),(9,'exclusions'))
SELECT r.workspace_id, r.id AS search_run_id, st.stage_order, st.stage,
       count(rb.*) FILTER (WHERE rb.state <> 'DISCOVERED')                                            AS evaluated,
       count(rb.*) FILTER (WHERE rb.failed_stage = st.stage)                                          AS rejected_at_stage,
       count(rb.*) FILTER (WHERE rb.state <> 'DISCOVERED' AND st.stage = ANY (rb.unknown_stages)
                                 AND (rb.failed_stage IS NULL OR fs.stage_order > st.stage_order))    AS needs_review_at_stage,
       count(rb.*) FILTER (WHERE rb.state <> 'DISCOVERED' AND (rb.failed_stage IS NULL OR fs.stage_order > st.stage_order))
                                                                                                      AS remaining_after_stage
  FROM scopely.search_runs r
  CROSS JOIN stages st
  LEFT JOIN scopely.search_run_businesses rb ON rb.search_run_id = r.id
  LEFT JOIN stages fs ON fs.stage = rb.failed_stage
 GROUP BY r.workspace_id, r.id, st.stage_order, st.stage;

-- The unified opportunity feed: WEBSITE and FIX opportunities in one list with everything the
-- frontend filters on. build_state and sell_state are derived from builds, messages and outcomes.
CREATE VIEW v_opportunity_feed AS
SELECT o.workspace_id, o.id AS opportunity_id, o.opportunity_kind, bk.opportunity_path, o.opportunity_type, o.status,
       o.search_run_id, r.search_id,
       b.id AS business_id, b.name AS business_name, b.domain, b.vertical, b.subvertical, b.specialty,
       b.country_code, b.region, b.city, b.latitude, b.longitude,
       b.employee_count, b.employee_count_min, b.employee_count_max, b.employees_basis,
       b.revenue_amount, b.revenue_min, b.revenue_max, b.revenue_currency, b.revenue_basis,
       b.independence, b.website_status,
       o.mapping_status, o.catalog_item_id, ci.key AS catalog_key, ci.service, o.service_price, o.currency,
       ev.evidence_count, ev.issue_codes, ev.claim_states,
       CASE ev.best WHEN 3 THEN 'HIGH' WHEN 2 THEN 'MEDIUM' WHEN 1 THEN 'LOW' END AS top_confidence,
       CASE WHEN bl.purpose IS NULL THEN 'NONE' ELSE bl.purpose || '_' || bl.status END AS build_state,
       CASE WHEN o.won_at IS NOT NULL THEN 'WON'
            WHEN o.lost_at IS NOT NULL THEN 'LOST'
            WHEN o.reply_at IS NOT NULL THEN 'REPLIED'
            WHEN o.pitched_at IS NOT NULL THEN 'PITCHED'
            WHEN msg.sent THEN 'SENT'
            WHEN msg.approved THEN 'APPROVED'
            WHEN msg.drafted THEN 'DRAFTED'
            ELSE 'NOT_STARTED' END AS sell_state,
       CASE WHEN o.verification_status IS NOT NULL THEN 'VERIFIED_' || o.verification_status
            WHEN o.delivered_at IS NOT NULL THEN 'DELIVERED'
            WHEN o.won_at IS NOT NULL THEN 'AWAITING_DELIVERY'
            ELSE 'NONE' END AS delivery_state,
       o.pitched_at, o.reply_at, o.won_at, o.lost_at, o.deal_value, o.delivered_at, o.verified_at, o.verification_status,
       o.created_at
  FROM scopely.opportunities o
  JOIN scopely.businesses b ON b.id = o.business_id
  LEFT JOIN scopely.build_kinds bk ON bk.key = o.opportunity_kind
  LEFT JOIN scopely.search_runs r ON r.id = o.search_run_id
  LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS evidence_count,
           array_agg(DISTINCT e.issue_code ORDER BY e.issue_code) AS issue_codes,
           array_agg(DISTINCT e.claim_state ORDER BY e.claim_state) AS claim_states,
           max(CASE e.confidence WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END) AS best
      FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
     WHERE oe.opportunity_id = o.id) ev ON true
  LEFT JOIN LATERAL (
    SELECT purpose, status FROM scopely.builds
     WHERE opportunity_id = o.id AND status NOT IN ('DISCARDED','SUPERSEDED')
     ORDER BY (purpose = 'DELIVERY') DESC, created_at DESC, id DESC LIMIT 1) bl ON true
  LEFT JOIN LATERAL (
    SELECT bool_or(sent_at IS NOT NULL) AS sent,
           bool_or(approval_status IN ('approved','edited')) AS approved,
           count(*) > 0 AS drafted
      FROM scopely.messages WHERE opportunity_id = o.id) msg ON true;

-- Map points: only businesses with coordinates from a named source. No contacts, no emails.
CREATE VIEW v_business_map AS
SELECT b.workspace_id, b.id AS business_id, b.name, b.latitude, b.longitude, b.address_line, b.city, b.region,
       b.country_code, b.postal_code, b.vertical, b.subvertical, b.website_status,
       coalesce(o.opportunities, 0) AS opportunities, o.opportunity_paths, o.opportunity_kinds
  FROM scopely.businesses b
  LEFT JOIN LATERAL (
    SELECT count(*) AS opportunities,
           array_agg(DISTINCT bk.opportunity_path) FILTER (WHERE bk.opportunity_path IS NOT NULL) AS opportunity_paths,
           array_agg(DISTINCT op.opportunity_kind) FILTER (WHERE op.opportunity_kind IS NOT NULL) AS opportunity_kinds
      FROM scopely.opportunities op LEFT JOIN scopely.build_kinds bk ON bk.key = op.opportunity_kind
     WHERE op.business_id = b.id AND op.status <> 'DISMISSED') o ON true
 WHERE b.latitude IS NOT NULL;

-- Which ICPs pay: every run of a search added up.
CREATE VIEW v_search_performance AS
SELECT s.workspace_id, s.id AS search_id, s.name,
       count(DISTINCT r.search_run_id) AS runs,
       coalesce(sum(r.discovered), 0) AS discovered, coalesce(sum(r.qualified), 0) AS qualified,
       coalesce(sum(r.analyzed), 0) AS analyzed, coalesce(sum(r.opportunities), 0) AS opportunities,
       coalesce(sum(r.website_opportunities), 0) AS website_opportunities, coalesce(sum(r.fix_opportunities), 0) AS fix_opportunities,
       coalesce(sum(r.pitched), 0) AS pitched, coalesce(sum(r.wins), 0) AS wins,
       sum(r.revenue) AS revenue,
       CASE WHEN bool_or(r.credits_consumed IS NULL) THEN NULL ELSE coalesce(sum(r.credits_consumed), 0) END AS credits_consumed,
       CASE WHEN sum(r.revenue) IS NULL OR coalesce(sum(r.discovered), 0) = 0 THEN NULL
            ELSE round(sum(r.revenue) * 100.0 / sum(r.discovered), 2) END AS revenue_per_100_discovered
  FROM scopely.searches s
  LEFT JOIN scopely.v_search_run_summary r ON r.search_id = s.id
 GROUP BY s.workspace_id, s.id, s.name;

-- The experiment ledger gains the product dimensions the learning loop groups by (columns are
-- appended; existing ones are unchanged).
CREATE OR REPLACE VIEW v_opportunity_ledger AS
SELECT o.id                                   AS opportunity_id,
       b.id                                   AS business_id,
       b.name                                 AS business_name,
       m.name                                 AS market,
       p.key                                  AS playbook,
       p.validation_status                    AS playbook_validation_status,
       coalesce(b.vertical, m.vertical)       AS vertical,
       coalesce(b.subvertical, m.subvertical) AS subvertical,
       coalesce(b.country_code, m.country_code) AS country_code,
       b.region, b.city,
       o.opportunity_type,
       ev.issue_codes                         AS evidence_types,
       ev.claim_states                        AS evidence_claim_states,
       ev.evidence_count,
       o.mapping_status,
       ci.key                                 AS catalog_item,
       ci.service,
       o.service_price, o.currency,
       o.price_override_kind,
       msg.first_message_id                   AS pitch_message_id,
       msg.messages_sent,
       o.pitched_at,
       rep.reply_class                        AS latest_reply_class,
       o.reply_at,
       coalesce(calls.n, 0)                   AS calls,
       CASE WHEN o.won_at IS NOT NULL THEN 'won' WHEN o.lost_at IS NOT NULL THEN 'lost' END AS result,
       o.won_at, o.lost_at,
       o.deal_value,
       o.delivered_at,
       o.delivery_cost,
       cost.analysis_cost,
       CASE WHEN o.deal_value IS NULL OR o.delivery_cost IS NULL OR cost.analysis_cost IS NULL THEN NULL
            ELSE o.deal_value - o.delivery_cost - cost.analysis_cost END AS gross_profit,
       cost.operator_minutes,
       o.verification_status, o.verified_at,
       bld.demo_builds_shown,
       o.status,
       o.workspace_id,
       o.opportunity_kind,
       bk.opportunity_path,
       o.search_run_id,
       sr.search_id,
       b.specialty,
       b.employee_count, b.employee_count_min, b.employee_count_max, b.employees_basis,
       b.revenue_amount, b.revenue_min, b.revenue_max, b.revenue_currency, b.revenue_basis,
       cost.credits
  FROM scopely.opportunities o
  JOIN scopely.businesses b ON b.id = o.business_id
  LEFT JOIN scopely.markets m ON m.id = coalesce(o.market_id, b.market_id)
  LEFT JOIN scopely.niche_playbooks p ON p.id = m.playbook_id
  LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id
  LEFT JOIN scopely.build_kinds bk ON bk.key = o.opportunity_kind
  LEFT JOIN scopely.search_runs sr ON sr.id = o.search_run_id
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT e.issue_code ORDER BY e.issue_code) AS issue_codes,
           array_agg(DISTINCT e.claim_state ORDER BY e.claim_state) AS claim_states,
           count(*) AS evidence_count
      FROM scopely.opportunity_evidence oe JOIN scopely.evidence e ON e.id = oe.evidence_id
     WHERE oe.opportunity_id = o.id) ev ON true
  LEFT JOIN LATERAL (
    SELECT (array_agg(id ORDER BY sent_at, id))[1] AS first_message_id, count(*) AS messages_sent
      FROM scopely.messages WHERE opportunity_id = o.id AND sent_at IS NOT NULL) msg ON true
  LEFT JOIN LATERAL (
    SELECT reply_class FROM scopely.outcomes
     WHERE opportunity_id = o.id AND kind = 'replied' ORDER BY occurred_at DESC, id DESC LIMIT 1) rep ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM scopely.outcomes WHERE opportunity_id = o.id AND kind = 'call') calls ON true
  LEFT JOIN LATERAL (
    SELECT CASE WHEN count(*) FILTER (WHERE kind <> 'operator_time') = 0
                  OR bool_or(amount IS NULL AND kind <> 'operator_time') THEN NULL
                ELSE sum(amount) END AS analysis_cost,
           sum(minutes) AS operator_minutes,
           sum(credits) AS credits
      FROM scopely.cost_events WHERE opportunity_id = o.id) cost ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS demo_builds_shown FROM scopely.builds
     WHERE opportunity_id = o.id AND purpose = 'DEMO' AND shown_at IS NOT NULL) bld ON true;

ALTER VIEW v_opportunity_ledger      SET (security_invoker = true);
ALTER VIEW v_search_run_summary      SET (security_invoker = true);
ALTER VIEW v_search_run_stage_funnel SET (security_invoker = true);
ALTER VIEW v_opportunity_feed        SET (security_invoker = true);
ALTER VIEW v_business_map            SET (security_invoker = true);
ALTER VIEW v_search_performance      SET (security_invoker = true);
