-- 002_opportunities_outcomes: opportunity -> service -> price -> outcome -> verification,
-- cost tracking, and the commercial views the learning loop reads.

SET search_path = scopely;

-- ------------------------------------------------------------------ opportunities

CREATE TABLE opportunities (
  id                        bigserial PRIMARY KEY,
  business_id               bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  market_id                 bigint REFERENCES markets(id),
  opportunity_type          text NOT NULL,          -- 'broken_contact_path', 'booking_to_enquiry', ...
  status                    text NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN (
                              'DISCOVERED','ANALYZED','QUALIFIED','PITCHED','REPLIED',
                              'WON','LOST','DELIVERED','VERIFIED','DISMISSED')),
  why_it_matters            text,                   -- AI text later; every sentence must cite evidence
  not_observable_notes      text,                   -- what we could not see, said plainly
  mapping_status            text NOT NULL DEFAULT 'UNMAPPED' CHECK (mapping_status IN ('MAPPED','UNMAPPED')),
  catalog_item_id           bigint REFERENCES catalog_items(id),
  unmapped_reason           text,
  mapping_rule_version_id   bigint REFERENCES rule_versions(id),

  -- commercial fields: NULL means unknown, never zero-by-default
  currency                  char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  service_price             numeric(12,2) CHECK (service_price >= 0),
  price_override_basis      text,                   -- why a price outside the catalog band is real
  opportunity_value         numeric(12,2) CHECK (opportunity_value >= 0),
  opportunity_value_basis   text,
  estimated_delivery_effort_minutes integer CHECK (estimated_delivery_effort_minutes > 0),
  effort_basis              text,
  analysis_cost             numeric(12,2) CHECK (analysis_cost >= 0),
  delivery_cost             numeric(12,2) CHECK (delivery_cost >= 0),
  deal_value                numeric(12,2) CHECK (deal_value >= 0),
  gross_margin              numeric(12,2) GENERATED ALWAYS AS (deal_value - delivery_cost - analysis_cost) STORED,
  pitched_at                timestamptz,
  reply_at                  timestamptz,
  won_at                    timestamptz,
  lost_at                   timestamptz,
  delivered_at              timestamptz,
  verified_at               timestamptz,
  verification_status       text CHECK (verification_status IN ('PASSED','FAILED','NOT_OBSERVABLE','CLIENT_REQUIRED_UNCONFIRMED')),

  -- prioritisation must be inspectable: the inputs and formula version, never a bare score
  priority_inputs           jsonb,
  priority_rule_version_id  bigint REFERENCES rule_versions(id),
  created_at                timestamptz NOT NULL DEFAULT now(),

  CHECK ((mapping_status = 'MAPPED') = (catalog_item_id IS NOT NULL)),
  CHECK (mapping_status = 'MAPPED' OR coalesce(btrim(unmapped_reason),'') <> ''),
  CHECK (service_price IS NULL OR (currency IS NOT NULL AND mapping_status = 'MAPPED')),
  CHECK (opportunity_value IS NULL OR (currency IS NOT NULL AND coalesce(btrim(opportunity_value_basis),'') <> '')),
  CHECK (estimated_delivery_effort_minutes IS NULL OR coalesce(btrim(effort_basis),'') <> ''),
  CHECK ((deal_value IS NULL AND delivery_cost IS NULL AND analysis_cost IS NULL) OR currency IS NOT NULL),
  CHECK (NOT (won_at IS NOT NULL AND lost_at IS NOT NULL)),
  CHECK (deal_value IS NULL OR won_at IS NOT NULL),
  CHECK (delivered_at IS NULL OR won_at IS NOT NULL),
  CHECK ((verified_at IS NULL) = (verification_status IS NULL)),
  CHECK (priority_inputs IS NULL OR priority_rule_version_id IS NOT NULL)
);
CREATE INDEX opportunities_business_idx ON opportunities (business_id);

CREATE TABLE opportunity_evidence (
  opportunity_id  bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  evidence_id     bigint NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (opportunity_id, evidence_id)
);

-- A service price cannot be invented: it must sit inside the mapped catalog item's cited
-- price band (same currency), or carry an explicit override basis.
CREATE FUNCTION opportunity_price_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  IF NEW.service_price IS NULL THEN RETURN NEW; END IF;
  IF NEW.catalog_item_id IS NULL THEN
    RAISE EXCEPTION 'PRICE: service_price needs a mapped catalog item' USING ERRCODE = 'check_violation';
  END IF;
  SELECT price_low, price_high, currency INTO c FROM scopely.catalog_items WHERE id = NEW.catalog_item_id;
  IF coalesce(btrim(NEW.price_override_basis),'') <> '' THEN RETURN NEW; END IF;
  IF c.price_low IS NULL THEN
    RAISE EXCEPTION 'PRICE: catalog item % has no cited price, so service_price needs price_override_basis', NEW.catalog_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF c.currency <> NEW.currency OR NEW.service_price < c.price_low OR NEW.service_price > c.price_high THEN
    RAISE EXCEPTION 'PRICE: service_price % % is outside catalog band % %-% and has no override basis',
      NEW.service_price, NEW.currency, c.currency, c.price_low, c.price_high USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_price_guard BEFORE INSERT OR UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunity_price_guard();

-- ------------------------------------------------------------------ outcomes (the ledger)

-- Outcomes are append-only facts. The opportunity's commercial timestamps and deal_value are
-- projections of this ledger: they cannot be set without the matching outcome row.
CREATE TABLE outcomes (
  id              bigserial PRIMARY KEY,
  opportunity_id  bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('pitched','replied','call','won','lost','delivered')),
  occurred_at     timestamptz NOT NULL,
  channel         text,                                 -- 'email','phone','in_person', ...
  reply_class     text CHECK (reply_class IN ('positive','question','pricing','not_now','not_interested','opt_out','wrong_person')),
  amount          numeric(12,2) CHECK (amount >= 0),    -- won: deal value; delivered: delivery cost
  currency        char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  delivered_by    text CHECK (delivered_by IN ('operator','client')),
  client_confirmed boolean,
  notes           text,
  recorded_by     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'won' OR (amount IS NOT NULL AND currency IS NOT NULL)),
  CHECK (amount IS NULL OR kind IN ('won','delivered')),
  CHECK (amount IS NULL OR currency IS NOT NULL),
  CHECK (kind <> 'replied' OR reply_class IS NOT NULL),
  CHECK (kind <> 'delivered' OR delivered_by IS NOT NULL)
);
CREATE INDEX outcomes_opportunity_idx ON outcomes (opportunity_id, kind);

CREATE FUNCTION outcome_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE impl text; opp record;
BEGIN
  SELECT o.*, c.implementation_type AS impl INTO opp
    FROM scopely.opportunities o LEFT JOIN scopely.catalog_items c ON c.id = o.catalog_item_id
   WHERE o.id = NEW.opportunity_id;
  IF NEW.kind = 'delivered' THEN
    IF opp.won_at IS NULL THEN
      RAISE EXCEPTION 'OUTCOME: cannot record delivery before a won outcome' USING ERRCODE = 'check_violation';
    END IF;
    -- Never claim CLIENT_REQUIRED work was completed by the operator; only the client's
    -- confirmed completion counts.
    IF opp.impl = 'CLIENT_REQUIRED' AND NOT (NEW.delivered_by = 'client' AND NEW.client_confirmed IS TRUE) THEN
      RAISE EXCEPTION 'OUTCOME: CLIENT_REQUIRED work can only be recorded as delivered by the client with confirmation'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.kind IN ('won','lost') AND opp.pitched_at IS NULL THEN
    RAISE EXCEPTION 'OUTCOME: cannot record % before a pitched outcome', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.currency IS NOT NULL AND opp.currency IS NOT NULL AND NEW.currency <> opp.currency THEN
    RAISE EXCEPTION 'OUTCOME: currency % differs from opportunity currency %', NEW.currency, opp.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outcome_guard BEFORE INSERT ON outcomes FOR EACH ROW EXECUTE FUNCTION outcome_guard();

CREATE FUNCTION outcomes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OUTCOME: outcomes are append-only; record a correcting outcome instead' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER outcomes_append_only BEFORE UPDATE ON outcomes FOR EACH ROW EXECUTE FUNCTION outcomes_append_only();

-- Project the ledger onto the opportunity. Runs as the only sanctioned writer of these fields.
CREATE FUNCTION outcome_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('scopely.projecting', 'on', true);
  UPDATE scopely.opportunities o SET
    currency      = coalesce(o.currency, NEW.currency),
    pitched_at    = CASE WHEN NEW.kind = 'pitched'   THEN coalesce(o.pitched_at, NEW.occurred_at) ELSE o.pitched_at END,
    reply_at      = CASE WHEN NEW.kind = 'replied'   THEN coalesce(o.reply_at, NEW.occurred_at)   ELSE o.reply_at END,
    won_at        = CASE WHEN NEW.kind = 'won'       THEN NEW.occurred_at ELSE o.won_at END,
    deal_value    = CASE WHEN NEW.kind = 'won'       THEN NEW.amount      ELSE o.deal_value END,
    lost_at       = CASE WHEN NEW.kind = 'lost'      THEN NEW.occurred_at ELSE o.lost_at END,
    delivered_at  = CASE WHEN NEW.kind = 'delivered' THEN NEW.occurred_at ELSE o.delivered_at END,
    delivery_cost = CASE WHEN NEW.kind = 'delivered' AND NEW.amount IS NOT NULL
                         THEN coalesce(o.delivery_cost, 0) + NEW.amount ELSE o.delivery_cost END,
    status        = CASE NEW.kind WHEN 'pitched' THEN (CASE WHEN o.status IN ('DISCOVERED','ANALYZED','QUALIFIED') THEN 'PITCHED' ELSE o.status END)
                                  WHEN 'replied' THEN (CASE WHEN o.status = 'PITCHED' THEN 'REPLIED' ELSE o.status END)
                                  WHEN 'won' THEN 'WON' WHEN 'lost' THEN 'LOST'
                                  WHEN 'delivered' THEN 'DELIVERED' ELSE o.status END
  WHERE o.id = NEW.opportunity_id;
  PERFORM set_config('scopely.projecting', 'off', true);
  RETURN NULL;
END $$;
CREATE TRIGGER outcome_project AFTER INSERT ON outcomes FOR EACH ROW EXECUTE FUNCTION outcome_project();

-- ------------------------------------------------------------------ verification

-- A verification re-runs the check behind one piece of baseline evidence on a LATER snapshot
-- of the same business. PASSED needs an OBSERVED 'ok' from the same check code.
CREATE TABLE verifications (
  id                   bigserial PRIMARY KEY,
  opportunity_id       bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  baseline_evidence_id bigint NOT NULL REFERENCES evidence(id),
  snapshot_id          bigint NOT NULL REFERENCES snapshots(id),
  observation_id       bigint REFERENCES observations(id),
  rule_version_id      bigint NOT NULL REFERENCES rule_versions(id),
  status               text NOT NULL CHECK (status IN ('PASSED','FAILED','NOT_OBSERVABLE','CLIENT_REQUIRED_UNCONFIRMED')),
  verified_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('PASSED','FAILED') OR observation_id IS NOT NULL)
);

CREATE FUNCTION verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base record; snap record; obs record; opp_business bigint; linked boolean;
BEGIN
  SELECT e.observed_at, e.business_id, bo.check_code INTO base
    FROM scopely.evidence e JOIN scopely.observations bo ON bo.id = e.observation_id
   WHERE e.id = NEW.baseline_evidence_id;
  SELECT business_id, fetched_at INTO snap FROM scopely.snapshots WHERE id = NEW.snapshot_id;
  SELECT business_id INTO opp_business FROM scopely.opportunities WHERE id = NEW.opportunity_id;
  SELECT EXISTS (SELECT 1 FROM scopely.opportunity_evidence
                  WHERE opportunity_id = NEW.opportunity_id AND evidence_id = NEW.baseline_evidence_id) INTO linked;
  IF NOT linked THEN
    RAISE EXCEPTION 'VERIFY: baseline evidence % is not part of opportunity %', NEW.baseline_evidence_id, NEW.opportunity_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF snap.business_id <> opp_business THEN
    RAISE EXCEPTION 'VERIFY: snapshot belongs to a different business' USING ERRCODE = 'check_violation';
  END IF;
  IF snap.fetched_at <= base.observed_at THEN
    RAISE EXCEPTION 'VERIFY: verification snapshot (%) must be later than the baseline evidence (%)', snap.fetched_at, base.observed_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.observation_id IS NOT NULL THEN
    SELECT o.snapshot_id, o.check_code, o.state, o.result INTO obs FROM scopely.observations o WHERE o.id = NEW.observation_id;
    IF obs.snapshot_id <> NEW.snapshot_id OR obs.check_code <> base.check_code THEN
      RAISE EXCEPTION 'VERIFY: verification must re-run check % on the verification snapshot', base.check_code
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'PASSED' AND NOT (obs.state = 'OBSERVED' AND obs.result = 'ok') THEN
      RAISE EXCEPTION 'VERIFY: PASSED needs an OBSERVED ok result, got % %', obs.state, obs.result
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'NOT_OBSERVABLE' AND obs.state <> 'NOT_OBSERVABLE' THEN
      RAISE EXCEPTION 'VERIFY: status NOT_OBSERVABLE contradicts observation state %', obs.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_guard BEFORE INSERT ON verifications FOR EACH ROW EXECUTE FUNCTION verification_guard();

CREATE FUNCTION verification_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('scopely.projecting', 'on', true);
  UPDATE scopely.opportunities SET
    verified_at = NEW.verified_at,
    verification_status = NEW.status,
    status = CASE WHEN NEW.status = 'PASSED' AND status = 'DELIVERED' THEN 'VERIFIED' ELSE status END
  WHERE id = NEW.opportunity_id;
  PERFORM set_config('scopely.projecting', 'off', true);
  RETURN NULL;
END $$;
CREATE TRIGGER verification_project AFTER INSERT ON verifications FOR EACH ROW EXECUTE FUNCTION verification_project();

-- Commercial fields that are projections may only change through the ledgers above.
CREATE FUNCTION opportunity_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('scopely.projecting', true), 'off') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.pitched_at IS NOT NULL OR NEW.reply_at IS NOT NULL OR NEW.won_at IS NOT NULL OR NEW.lost_at IS NOT NULL
       OR NEW.deal_value IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.verified_at IS NOT NULL
       OR NEW.verification_status IS NOT NULL OR NEW.delivery_cost IS NOT NULL
       OR NEW.status IN ('PITCHED','REPLIED','WON','LOST','DELIVERED','VERIFIED') THEN
      RAISE EXCEPTION 'OUTCOME: commercial results come from outcomes/verifications, not from the opportunity row'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.pitched_at IS DISTINCT FROM OLD.pitched_at OR NEW.reply_at IS DISTINCT FROM OLD.reply_at
     OR NEW.won_at IS DISTINCT FROM OLD.won_at OR NEW.lost_at IS DISTINCT FROM OLD.lost_at
     OR NEW.deal_value IS DISTINCT FROM OLD.deal_value OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.delivery_cost IS DISTINCT FROM OLD.delivery_cost
     OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('PITCHED','REPLIED','WON','LOST','DELIVERED','VERIFIED')) THEN
    RAISE EXCEPTION 'OUTCOME: commercial results come from outcomes/verifications, not from direct edits'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_projection_guard BEFORE INSERT OR UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunity_projection_guard();

-- Every opportunity needs at least one evidence record, checked at commit so the opportunity
-- and its evidence links can be written in one transaction.
CREATE FUNCTION opportunity_has_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opp_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'opportunities' THEN opp_id := NEW.id; ELSE opp_id := OLD.opportunity_id; END IF;
  IF EXISTS (SELECT 1 FROM scopely.opportunities WHERE id = opp_id)
     AND NOT EXISTS (SELECT 1 FROM scopely.opportunity_evidence WHERE opportunity_id = opp_id) THEN
    RAISE EXCEPTION 'EVIDENCE: opportunity % has no evidence', opp_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER opportunity_has_evidence AFTER INSERT ON opportunities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opportunity_has_evidence();
CREATE CONSTRAINT TRIGGER opportunity_evidence_removed AFTER DELETE ON opportunity_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opportunity_has_evidence();

-- Evidence linked to an opportunity must be about the same business.
CREATE FUNCTION opportunity_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT business_id FROM scopely.evidence WHERE id = NEW.evidence_id)
     <> (SELECT business_id FROM scopely.opportunities WHERE id = NEW.opportunity_id) THEN
    RAISE EXCEPTION 'EVIDENCE: evidence % belongs to a different business than opportunity %', NEW.evidence_id, NEW.opportunity_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_evidence_guard BEFORE INSERT ON opportunity_evidence
  FOR EACH ROW EXECUTE FUNCTION opportunity_evidence_guard();

-- ------------------------------------------------------------------ messages

CREATE TABLE messages (
  id               bigserial PRIMARY KEY,
  opportunity_id   bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  contact_id       bigint REFERENCES contacts(id),
  step             integer NOT NULL CHECK (step >= 0),
  subject          text NOT NULL,
  body             text NOT NULL,
  evidence_ids     bigint[] NOT NULL CHECK (cardinality(evidence_ids) > 0),
  generator        text NOT NULL,                      -- 'claude:<prompt version>' or 'operator'
  lint_rule_version_id bigint REFERENCES rule_versions(id),
  lint_status      text NOT NULL DEFAULT 'pending' CHECK (lint_status IN ('pending','pass','fail')),
  lint_errors      jsonb,
  approval_status  text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','edited','rejected')),
  approved_by      text,
  approved_at      timestamptz,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (approval_status NOT IN ('approved','edited') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (sent_at IS NULL OR approval_status IN ('approved','edited'))
);

CREATE FUNCTION message_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stray bigint;
BEGIN
  SELECT e INTO stray FROM unnest(NEW.evidence_ids) e
   WHERE NOT EXISTS (SELECT 1 FROM scopely.opportunity_evidence oe
                      WHERE oe.opportunity_id = NEW.opportunity_id AND oe.evidence_id = e) LIMIT 1;
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'EVIDENCE: message cites evidence % that is not part of opportunity %', stray, NEW.opportunity_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_evidence_guard BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION message_evidence_guard();

-- ------------------------------------------------------------------ cost tracking

CREATE TABLE cost_events (
  id              bigserial PRIMARY KEY,
  business_id     bigint REFERENCES businesses(id) ON DELETE CASCADE,
  opportunity_id  bigint REFERENCES opportunities(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('fetch','render','screenshot','llm_call','storage',
                                                'discovery','enrichment','operator_time')),
  units           numeric(14,4) NOT NULL DEFAULT 1 CHECK (units >= 0),
  tokens_in       integer CHECK (tokens_in >= 0),
  tokens_out      integer CHECK (tokens_out >= 0),
  minutes         numeric(10,2) CHECK (minutes >= 0),    -- operator_time only
  amount          numeric(12,4) CHECK (amount >= 0),     -- NULL = cost not known, never assumed 0
  currency        char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  meta            jsonb NOT NULL DEFAULT '{}',
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (business_id IS NOT NULL OR opportunity_id IS NOT NULL),
  CHECK (amount IS NULL OR currency IS NOT NULL),
  CHECK (kind <> 'operator_time' OR minutes IS NOT NULL)
);
CREATE INDEX cost_events_business_idx ON cost_events (business_id);

-- ------------------------------------------------------------------ commercial views

-- Funnel per market. Money columns are NULL when any input is unknown; they are never
-- padded with zeros. time_saved has no baseline yet, so only operator minutes are reported.
CREATE VIEW v_market_funnel AS
WITH b AS (
  SELECT market_id,
         count(*)                                              AS prospects_processed,
         count(*) FILTER (WHERE qualification_status = 'QUALIFIED') AS prospects_qualified,
         count(*) FILTER (WHERE qualification_status = 'REJECTED')  AS prospects_rejected
    FROM scopely.businesses GROUP BY market_id
), o AS (
  SELECT b.market_id,
         count(o.*)                                       AS opportunities_found,
         count(o.*) FILTER (WHERE o.pitched_at IS NOT NULL) AS opportunities_pitched,
         count(o.*) FILTER (WHERE o.reply_at IS NOT NULL)   AS replies,
         count(o.*) FILTER (WHERE o.won_at IS NOT NULL)     AS wins,
         sum(o.deal_value)                                  AS revenue,
         sum(o.delivery_cost)                               AS delivery_cost,
         bool_or(o.won_at IS NOT NULL AND o.delivery_cost IS NULL) AS delivery_cost_incomplete
    FROM scopely.opportunities o JOIN scopely.businesses b ON b.id = o.business_id
   GROUP BY b.market_id
), calls AS (
  SELECT b.market_id, count(DISTINCT oc.opportunity_id) AS calls
    FROM scopely.outcomes oc JOIN scopely.opportunities o ON o.id = oc.opportunity_id
    JOIN scopely.businesses b ON b.id = o.business_id
   WHERE oc.kind = 'call' GROUP BY b.market_id
), c AS (
  SELECT b.market_id,
         sum(ce.amount)                         AS analysis_cost,
         bool_or(ce.amount IS NULL AND ce.kind <> 'operator_time') AS analysis_cost_incomplete,
         sum(ce.minutes)                        AS operator_minutes
    FROM scopely.cost_events ce JOIN scopely.businesses b ON b.id = ce.business_id
   GROUP BY b.market_id
)
SELECT b.market_id,
       b.prospects_processed, b.prospects_qualified, b.prospects_rejected,
       coalesce(o.opportunities_found, 0)   AS opportunities_found,
       coalesce(o.opportunities_pitched, 0) AS opportunities_pitched,
       coalesce(o.replies, 0)               AS replies,
       coalesce(calls.calls, 0)             AS calls,
       coalesce(o.wins, 0)                  AS wins,
       o.revenue,
       CASE WHEN o.delivery_cost_incomplete THEN NULL ELSE o.delivery_cost END AS delivery_cost,
       CASE WHEN c.analysis_cost_incomplete THEN NULL ELSE c.analysis_cost END AS analysis_cost,
       CASE WHEN o.revenue IS NULL OR o.delivery_cost_incomplete OR c.analysis_cost_incomplete
                 OR c.analysis_cost IS NULL THEN NULL
            ELSE o.revenue - coalesce(o.delivery_cost, 0) - c.analysis_cost END AS gross_profit,
       CASE WHEN o.revenue IS NULL THEN NULL
            ELSE round(o.revenue * 100.0 / b.prospects_processed, 2) END       AS revenue_per_100_prospects,
       CASE WHEN c.analysis_cost_incomplete OR c.analysis_cost IS NULL OR coalesce(o.opportunities_found, 0) = 0 THEN NULL
            ELSE round(c.analysis_cost / o.opportunities_found, 4) END         AS cost_per_opportunity,
       c.operator_minutes,
       NULL::numeric AS time_saved_minutes   -- needs a measured manual baseline; not assumed
  FROM b
  LEFT JOIN o ON o.market_id IS NOT DISTINCT FROM b.market_id
  LEFT JOIN calls ON calls.market_id IS NOT DISTINCT FROM b.market_id
  LEFT JOIN c ON c.market_id IS NOT DISTINCT FROM b.market_id;

-- The learning loop: which opportunity types are found, pitched, won, and for how much.
-- win_rate is NULL until at least one pitch exists; it is a ratio, not a prediction.
CREATE VIEW v_opportunity_type_performance AS
SELECT m.playbook_id, b.vertical, b.country_code, o.opportunity_type, o.catalog_item_id,
       count(*)                                        AS detected,
       count(*) FILTER (WHERE o.pitched_at IS NOT NULL) AS pitched,
       count(*) FILTER (WHERE o.reply_at IS NOT NULL)   AS replied,
       count(*) FILTER (WHERE o.won_at IS NOT NULL)     AS won,
       sum(o.deal_value)                                AS revenue,
       CASE WHEN count(*) FILTER (WHERE o.pitched_at IS NOT NULL) = 0 THEN NULL
            ELSE round(count(*) FILTER (WHERE o.won_at IS NOT NULL)::numeric
                       / count(*) FILTER (WHERE o.pitched_at IS NOT NULL), 4) END AS win_rate,
       count(*) FILTER (WHERE o.verification_status = 'PASSED') AS verified_passed
  FROM scopely.opportunities o
  JOIN scopely.businesses b ON b.id = o.business_id
  LEFT JOIN scopely.markets m ON m.id = coalesce(o.market_id, b.market_id)
 GROUP BY m.playbook_id, b.vertical, b.country_code, o.opportunity_type, o.catalog_item_id;
