-- 001_foundation: core entities for Scopely slice 1.
--
-- The chain this schema protects:
--   snapshot -> observation -> evidence -> opportunity -> catalog item (service, price)
--            -> outcomes (pitched .. won/lost .. delivered) -> verification (later snapshot)
--
-- Truth Rule, enforced in the database rather than trusted to callers:
--   * evidence cannot exist without an observation made on a stored snapshot;
--   * a NOT_OBSERVABLE observation can never carry a defect or back evidence;
--   * every observation, evidence row and rejection names the rule version that produced it;
--   * prices must cite where they came from; unknown commercial values stay NULL;
--   * revenue, delivery and verification fields need the matching outcome/verification row.
--
-- Nothing here is niche- or country-specific. Verticals, issue codes and rules live in data
-- (niche_playbooks, issue_codes, rule_versions), not in CHECK constraints.

CREATE SCHEMA IF NOT EXISTS scopely;
SET search_path = scopely;

-- ------------------------------------------------------------------ playbooks and rules

-- VALIDATED / HYPOTHESIS is about DETECTION: is the rule backed by real, recorded
-- observations? Commercial value (does it sell?) is a separate axis, commercial_status,
-- and nothing is commercially PROVEN until outcomes exist.
CREATE TABLE niche_playbooks (
  id                 bigserial PRIMARY KEY,
  key                text NOT NULL UNIQUE,              -- 'aesthetics', 'uk_trades_lead_recovery'
  name               text NOT NULL,
  description        text NOT NULL,
  verticals          text[] NOT NULL,                   -- data, not an enum
  subverticals       text[] NOT NULL DEFAULT '{}',
  validation_status  text NOT NULL CHECK (validation_status IN ('VALIDATED','HYPOTHESIS')),
  validation_basis   text,                              -- required when VALIDATED
  commercial_status  text NOT NULL DEFAULT 'UNPROVEN' CHECK (commercial_status IN ('UNPROVEN','PROVEN')),
  commercial_basis   text,                              -- required when PROVEN
  definition         jsonb NOT NULL DEFAULT '{}',       -- discovery terms, classification notes
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (validation_status <> 'VALIDATED' OR coalesce(btrim(validation_basis),'') <> ''),
  CHECK (commercial_status <> 'PROVEN'   OR coalesce(btrim(commercial_basis),'') <> '')
);

-- Issue codes are shared vocabulary. playbook_id NULL = core code usable by any playbook.
CREATE TABLE issue_codes (
  code               text PRIMARY KEY,                  -- 'E-TEL-BROKEN'
  playbook_id        bigint REFERENCES niche_playbooks(id),
  kind               text NOT NULL CHECK (kind IN ('issue','observation')),
  title              text NOT NULL,
  description        text NOT NULL,
  default_confidence text CHECK (default_confidence IN ('HIGH','MEDIUM','LOW')),
  lead_eligible      boolean NOT NULL DEFAULT true,     -- false = never the lead line of a pitch
  validation_status  text NOT NULL CHECK (validation_status IN ('VALIDATED','HYPOTHESIS')),
  validation_basis   text,
  CHECK (validation_status <> 'VALIDATED' OR coalesce(btrim(validation_basis),'') <> ''),
  CHECK (kind <> 'issue' OR default_confidence IS NOT NULL)
);

-- Every check, qualification rule and mapping is versioned. Findings and rejections point at
-- the exact version that produced them, so a result is always traceable to its logic.
CREATE TABLE rule_versions (
  id                 bigserial PRIMARY KEY,
  rule_key           text NOT NULL,                     -- 'check.contact_links', 'qualify.booking_solved'
  version            integer NOT NULL CHECK (version > 0),
  kind               text NOT NULL CHECK (kind IN ('check','qualification','mapping','prioritisation','lint')),
  playbook_id        bigint REFERENCES niche_playbooks(id),   -- NULL = core rule
  description        text NOT NULL,
  validation_status  text NOT NULL CHECK (validation_status IN ('VALIDATED','HYPOTHESIS')),
  validation_basis   text,
  definition         jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz,
  UNIQUE (rule_key, version),
  CHECK (validation_status <> 'VALIDATED' OR coalesce(btrim(validation_basis),'') <> '')
);

-- ------------------------------------------------------------------ markets

-- A market is what the operator defines: niche + geography + service catalog.
CREATE TABLE markets (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL,
  playbook_id    bigint NOT NULL REFERENCES niche_playbooks(id),
  vertical       text NOT NULL,
  subvertical    text,
  country_code   char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  region         text,
  city           text,
  postal_area    text,
  timezone       text,
  currency       char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  purpose        text NOT NULL CHECK (purpose IN ('benchmark','experiment','production')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ businesses and sources

CREATE TABLE businesses (
  id                        bigserial PRIMARY KEY,
  market_id                 bigint REFERENCES markets(id),
  name                      text NOT NULL,
  legal_name                text,
  domain                    text,
  website_url               text,
  vertical                  text,
  subvertical               text,
  country_code              char(2) CHECK (country_code ~ '^[A-Z]{2}$'),
  region                    text,
  city                      text,
  postal_code               text,
  timezone                  text,
  company_number            text,
  company_register          text,                         -- 'uk_companies_house', ...
  company_type              text,                         -- 'ltd','llp','sole_trader',... (register vocabulary)
  company_status            text,
  independence              text CHECK (independence IN ('independent','group','chain','unknown')),
  qualification_status      text NOT NULL DEFAULT 'NEW'
                            CHECK (qualification_status IN ('NEW','QUALIFIED','HOLD','REJECTED')),
  rejection_category        text CHECK (rejection_category IN (
                              'WRONG_BUSINESS_TYPE','CLOSED','CHAIN_OR_GROUP','SERVICE_ALREADY_SOLVED',
                              'NO_CREDIBLE_OPPORTUNITY','EVIDENCE_TOO_WEAK','OPPORTUNITY_TOO_SMALL',
                              'NOT_COMMERCIALLY_VIABLE','COMPLIANCE','INSUFFICIENT_EVIDENCE',
                              'OUT_OF_GEOGRAPHY')),
  rejection_reason          text,
  rejection_stage           text CHECK (rejection_stage IN ('discovery','classification','qualification',
                                                            'observation','opportunity','compliance','review')),
  rejection_rule_version_id bigint REFERENCES rule_versions(id),
  rejected_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, domain),
  -- A rejection is an outcome: it must say why, where, and under which rule.
  CHECK (qualification_status <> 'REJECTED' OR (
           rejection_category IS NOT NULL AND coalesce(btrim(rejection_reason),'') <> ''
           AND rejection_stage IS NOT NULL AND rejection_rule_version_id IS NOT NULL
           AND rejected_at IS NOT NULL)),
  CHECK (qualification_status = 'REJECTED' OR (
           rejection_category IS NULL AND rejection_reason IS NULL AND rejection_stage IS NULL
           AND rejection_rule_version_id IS NULL AND rejected_at IS NULL))
);

CREATE TABLE sources (
  id            bigserial PRIMARY KEY,
  business_id   bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind          text NOT NULL,                           -- 'csv_import','clay_search','web_search','register','golden'
  ref           text NOT NULL,                           -- query, file path, task id, URL
  found_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ snapshots and observations

CREATE TABLE snapshots (
  id              bigserial PRIMARY KEY,
  business_id     bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url             text NOT NULL,
  final_url       text,
  http_status     integer,
  fetched_at      timestamptz NOT NULL,
  fetch_method    text NOT NULL CHECK (fetch_method IN ('http','render','manual')),
  viewport        text CHECK (viewport IN ('desktop','mobile')),
  html_sha256     text CHECK (html_sha256 ~ '^[0-9a-f]{64}$'),
  html_ref        text,                                  -- object-store key
  screenshot_ref  text,
  redirect_chain  jsonb NOT NULL DEFAULT '[]',
  CHECK (fetch_method <> 'render' OR viewport IS NOT NULL)
);
CREATE INDEX snapshots_business_idx ON snapshots (business_id, fetched_at);
CREATE INDEX snapshots_hash_idx ON snapshots (html_sha256);

-- State is the Truth Rule's vocabulary:
--   OBSERVED       seen in the stored snapshot;
--   INFERRED       derived by reasoning from observed facts (must say from what);
--   NOT_OBSERVABLE the check could not see this (JS widget, post-submit behaviour, a call).
-- result is what the check concluded, and only an OBSERVED or INFERRED state may conclude
-- anything: NOT_OBSERVABLE is never a defect, a gap, or ok.
CREATE TABLE observations (
  id               bigserial PRIMARY KEY,
  snapshot_id      bigint NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  check_code       text NOT NULL,
  rule_version_id  bigint NOT NULL REFERENCES rule_versions(id),
  state            text NOT NULL CHECK (state IN ('OBSERVED','INFERRED','NOT_OBSERVABLE')),
  result           text CHECK (result IN ('ok','gap','defect','n/a')),
  selector         text,
  href             text,
  visible_text     text,
  extracted        jsonb NOT NULL DEFAULT '{}',
  inferred_from    bigint[],                              -- observation ids, required for INFERRED
  observed_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'NOT_OBSERVABLE' OR result IS NULL),
  CHECK (state = 'NOT_OBSERVABLE' OR result IS NOT NULL),
  CHECK (state <> 'INFERRED' OR cardinality(inferred_from) > 0)
);

-- ------------------------------------------------------------------ evidence

CREATE TABLE evidence (
  id               bigserial PRIMARY KEY,
  business_id      bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  observation_id   bigint NOT NULL REFERENCES observations(id),
  issue_code       text NOT NULL REFERENCES issue_codes(code),
  rule_version_id  bigint NOT NULL REFERENCES rule_versions(id),
  claim_state      text NOT NULL CHECK (claim_state IN ('OBSERVED','INFERRED')),
  plain_issue      text NOT NULL CHECK (btrim(plain_issue) <> ''),
  url              text NOT NULL CHECK (btrim(url) <> ''),
  quote            text NOT NULL CHECK (btrim(quote) <> ''),
  observed_at      timestamptz NOT NULL,
  confidence       text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  rechecked_at     timestamptz,
  recheck_result   text CHECK (recheck_result IN ('confirmed','changed','gone')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((rechecked_at IS NULL) = (recheck_result IS NULL))
);

-- Evidence must rest on a usable observation of the same business.
CREATE FUNCTION evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o_state text; o_result text; o_business bigint;
BEGIN
  SELECT o.state, o.result, s.business_id INTO o_state, o_result, o_business
    FROM scopely.observations o JOIN scopely.snapshots s ON s.id = o.snapshot_id
   WHERE o.id = NEW.observation_id;
  -- No row: let the NOT NULL / foreign-key constraint report the real problem.
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF o_state = 'NOT_OBSERVABLE' THEN
    RAISE EXCEPTION 'TRUTH_RULE: evidence cannot rest on a NOT_OBSERVABLE observation (observation %)', NEW.observation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF o_result IS NULL OR o_result NOT IN ('gap','defect') THEN
    RAISE EXCEPTION 'TRUTH_RULE: evidence needs an observation that found a gap or defect, got %', o_result
      USING ERRCODE = 'check_violation';
  END IF;
  IF o_business <> NEW.business_id THEN
    RAISE EXCEPTION 'TRUTH_RULE: evidence business % does not match observation business %', NEW.business_id, o_business
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.claim_state = 'OBSERVED' AND o_state <> 'OBSERVED' THEN
    RAISE EXCEPTION 'TRUTH_RULE: evidence claims OBSERVED but its observation is %', o_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_guard BEFORE INSERT OR UPDATE ON evidence
  FOR EACH ROW EXECUTE FUNCTION evidence_guard();

-- ------------------------------------------------------------------ contacts and suppression

CREATE TABLE contacts (
  id               bigserial PRIMARY KEY,
  business_id      bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  full_name        text,
  role             text,
  is_decision_maker boolean NOT NULL DEFAULT false,
  email            text,
  email_kind       text CHECK (email_kind IN ('role','personal')),
  source           text NOT NULL,
  source_url       text,
  label            text NOT NULL CHECK (label IN ('VERIFIED','PUBLICLY_FOUND','UNVERIFIED')),
  mx_ok            boolean,
  outreach_basis   text CHECK (outreach_basis IN ('corporate_subscriber','consent','not_permitted','unknown')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (full_name IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE suppression (
  id          bigserial PRIMARY KEY,
  email       text,
  domain      text,
  reason      text NOT NULL,                              -- 'opt_out','bounce','complaint','contacted','dnc'
  added_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR domain IS NOT NULL)
);
CREATE UNIQUE INDEX suppression_email_uq  ON suppression (lower(email))  WHERE email IS NOT NULL;
CREATE UNIQUE INDEX suppression_domain_uq ON suppression (lower(domain)) WHERE domain IS NOT NULL;

-- ------------------------------------------------------------------ service catalog

-- What the operator can sell. A price must cite where it came from (price_source); unknown
-- effort, margin and implementation type stay NULL rather than being guessed.
CREATE TABLE catalog_items (
  id                      bigserial PRIMARY KEY,
  key                     text NOT NULL UNIQUE,
  service                 text NOT NULL,
  description             text NOT NULL,
  price_low               numeric(12,2) CHECK (price_low >= 0),
  price_high              numeric(12,2) CHECK (price_high >= 0),
  currency                char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  price_source            text,
  supported_issue_codes   text[] NOT NULL DEFAULT '{}',
  supported_verticals     text[] NOT NULL DEFAULT '{}',   -- empty = any vertical
  supported_subverticals  text[] NOT NULL DEFAULT '{}',
  implementation_type     text CHECK (implementation_type IN ('FULL','ASSISTED','CLIENT_REQUIRED')),
  estimated_effort_minutes integer CHECK (estimated_effort_minutes > 0),
  effort_source           text,
  prerequisites           text[] NOT NULL DEFAULT '{}',
  verification_checks     text[] NOT NULL DEFAULT '{}',
  components              text[] NOT NULL DEFAULT '{}',
  playbook_id             bigint REFERENCES niche_playbooks(id),
  commercial_status       text NOT NULL DEFAULT 'UNPROVEN' CHECK (commercial_status IN ('UNPROVEN','PROVEN')),
  commercial_basis        text,
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((price_low IS NULL) = (price_high IS NULL)),
  CHECK (price_low IS NULL OR price_high >= price_low),
  CHECK (price_low IS NULL OR (currency IS NOT NULL AND coalesce(btrim(price_source),'') <> '')),
  CHECK (estimated_effort_minutes IS NULL OR coalesce(btrim(effort_source),'') <> ''),
  CHECK (commercial_status <> 'PROVEN' OR coalesce(btrim(commercial_basis),'') <> '')
);

CREATE FUNCTION catalog_issue_codes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE missing text;
BEGIN
  SELECT c INTO missing FROM unnest(NEW.supported_issue_codes) c
   WHERE NOT EXISTS (SELECT 1 FROM scopely.issue_codes i WHERE i.code = c) LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'catalog item % names unknown issue code %', NEW.key, missing USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_issue_codes_guard BEFORE INSERT OR UPDATE ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION catalog_issue_codes_guard();
