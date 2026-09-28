-- 004_integrity_fixes: four integrity fixes from the PR #1 review.
--
-- 1. At most one effective terminal outcome (won or lost) per opportunity. A mistaken win or
--    loss is corrected by an explicit 'voided' outcome that names it; only then may another
--    terminal outcome be recorded. A win cannot be voided once a delivery rests on it.
-- 2. evidence.observed_at is provenance, so it is derived from the snapshot the observation was
--    made on. A supplied timestamp that differs is refused rather than silently replaced.
-- 3. The rule version is chained end to end: evidence uses its observation's rule version, and a
--    verification uses the baseline evidence's rule version and re-runs it on the new snapshot.
-- 4. The free-text price_override_basis is replaced by structured overrides: DISCOUNT (below the
--    catalog band, named approver) or BUNDLE (inside the summed bands of the catalog items named).

SET search_path = scopely;

-- ------------------------------------------------------------------ 1. one terminal outcome

ALTER TABLE outcomes DROP CONSTRAINT outcomes_kind_check;
ALTER TABLE outcomes ADD CONSTRAINT outcomes_kind_check
  CHECK (kind IN ('pitched','replied','call','won','lost','delivered','voided'));
ALTER TABLE outcomes ADD COLUMN corrects_outcome_id bigint REFERENCES outcomes(id);
ALTER TABLE outcomes ADD CONSTRAINT outcomes_void_target_check
  CHECK ((kind = 'voided') = (corrects_outcome_id IS NOT NULL));
ALTER TABLE outcomes ADD CONSTRAINT outcomes_void_reason_check
  CHECK (kind <> 'voided' OR coalesce(btrim(notes), '') <> '');

CREATE OR REPLACE FUNCTION outcome_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opp record; target record; terminal_id bigint;
BEGIN
  -- Lock the opportunity so two concurrent wins cannot both see "no terminal outcome yet".
  SELECT o.*, c.implementation_type AS impl INTO opp
    FROM scopely.opportunities o LEFT JOIN scopely.catalog_items c ON c.id = o.catalog_item_id
   WHERE o.id = NEW.opportunity_id
     FOR UPDATE OF o;
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
  IF NEW.kind IN ('won','lost') THEN
    IF opp.pitched_at IS NULL THEN
      RAISE EXCEPTION 'OUTCOME: cannot record % before a pitched outcome', NEW.kind USING ERRCODE = 'check_violation';
    END IF;
    SELECT t.id INTO terminal_id FROM scopely.outcomes t
     WHERE t.opportunity_id = NEW.opportunity_id AND t.kind IN ('won','lost')
       AND NOT EXISTS (SELECT 1 FROM scopely.outcomes v WHERE v.corrects_outcome_id = t.id)
     LIMIT 1;
    IF terminal_id IS NOT NULL THEN
      RAISE EXCEPTION 'OUTCOME: opportunity % already has terminal outcome %; record a voided outcome naming it before recording another',
        NEW.opportunity_id, terminal_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- A void with no target is left to outcomes_void_target_check to report.
  IF NEW.kind = 'voided' AND NEW.corrects_outcome_id IS NOT NULL THEN
    SELECT t.opportunity_id, t.kind, t.occurred_at INTO target FROM scopely.outcomes t WHERE t.id = NEW.corrects_outcome_id;
    IF NOT FOUND OR target.opportunity_id <> NEW.opportunity_id THEN
      RAISE EXCEPTION 'OUTCOME: voided outcome must name an outcome of the same opportunity' USING ERRCODE = 'check_violation';
    END IF;
    IF target.kind NOT IN ('won','lost') THEN
      RAISE EXCEPTION 'OUTCOME: only a won or lost outcome can be voided, not %', target.kind USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM scopely.outcomes v WHERE v.corrects_outcome_id = NEW.corrects_outcome_id) THEN
      RAISE EXCEPTION 'OUTCOME: outcome % is already voided', NEW.corrects_outcome_id USING ERRCODE = 'check_violation';
    END IF;
    IF target.kind = 'won' AND opp.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'OUTCOME: cannot void a win that a delivery rests on' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.occurred_at < target.occurred_at THEN
      RAISE EXCEPTION 'OUTCOME: a correction cannot predate the outcome it voids' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.currency IS NOT NULL AND opp.currency IS NOT NULL AND NEW.currency <> opp.currency THEN
    RAISE EXCEPTION 'OUTCOME: currency % differs from opportunity currency %', NEW.currency, opp.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION outcome_project() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voided_kind text;
BEGIN
  PERFORM set_config('scopely.projecting', 'on', true);
  IF NEW.kind = 'voided' THEN
    SELECT kind INTO voided_kind FROM scopely.outcomes WHERE id = NEW.corrects_outcome_id;
    UPDATE scopely.opportunities o SET
      won_at     = CASE WHEN voided_kind = 'won'  THEN NULL ELSE o.won_at END,
      deal_value = CASE WHEN voided_kind = 'won'  THEN NULL ELSE o.deal_value END,
      lost_at    = CASE WHEN voided_kind = 'lost' THEN NULL ELSE o.lost_at END,
      status     = CASE WHEN o.reply_at IS NOT NULL THEN 'REPLIED' ELSE 'PITCHED' END
    WHERE o.id = NEW.opportunity_id;
  ELSE
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
  END IF;
  PERFORM set_config('scopely.projecting', 'off', true);
  RETURN NULL;
END $$;

-- ------------------------------------------------------------------ 2 + 3. evidence provenance

CREATE OR REPLACE FUNCTION evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o_state text; o_result text; o_business bigint; o_rule bigint; s_fetched timestamptz;
BEGIN
  SELECT o.state, o.result, s.business_id, o.rule_version_id, s.fetched_at
    INTO o_state, o_result, o_business, o_rule, s_fetched
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
  -- Provenance time is when the page was captured. Derive it; refuse a different one.
  IF NEW.observed_at IS NULL THEN
    NEW.observed_at := s_fetched;
  ELSIF NEW.observed_at <> s_fetched THEN
    RAISE EXCEPTION 'TRUTH_RULE: evidence observed_at % differs from its snapshot fetched_at %', NEW.observed_at, s_fetched
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.rule_version_id IS NOT NULL AND NEW.rule_version_id <> o_rule THEN
    RAISE EXCEPTION 'TRUTH_RULE: evidence rule version % differs from its observation rule version %', NEW.rule_version_id, o_rule
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- A snapshot's capture time is what evidence cites, so it cannot be rewritten underneath it.
CREATE FUNCTION snapshot_time_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fetched_at IS DISTINCT FROM OLD.fetched_at THEN
    RAISE EXCEPTION 'TRUTH_RULE: snapshot fetched_at is provenance and cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_time_guard BEFORE UPDATE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION snapshot_time_guard();

-- Evidence cites its observation's snapshot, rule, state and result, so none of them can be
-- rewritten underneath it (e.g. a backed 'defect' quietly edited to 'ok').
CREATE FUNCTION observation_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.rule_version_id IS DISTINCT FROM OLD.rule_version_id
       OR NEW.state IS DISTINCT FROM OLD.state OR NEW.result IS DISTINCT FROM OLD.result)
     AND EXISTS (SELECT 1 FROM scopely.evidence WHERE observation_id = OLD.id) THEN
    RAISE EXCEPTION 'TRUTH_RULE: observation % backs evidence, so its snapshot, rule version, state and result cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_provenance_guard BEFORE UPDATE ON observations
  FOR EACH ROW EXECUTE FUNCTION observation_provenance_guard();

-- ------------------------------------------------------------------ 3. verification rule chain

CREATE OR REPLACE FUNCTION verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base record; snap record; obs record; opp_business bigint; linked boolean;
BEGIN
  SELECT e.observed_at, e.business_id, e.rule_version_id, bo.check_code INTO base
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
  -- The same rule version that produced the baseline must be the one that re-checks it.
  IF NEW.rule_version_id <> base.rule_version_id THEN
    RAISE EXCEPTION 'VERIFY: rule version % differs from the baseline evidence rule version %', NEW.rule_version_id, base.rule_version_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.observation_id IS NOT NULL THEN
    SELECT o.snapshot_id, o.check_code, o.state, o.result, o.rule_version_id INTO obs
      FROM scopely.observations o WHERE o.id = NEW.observation_id;
    IF obs.snapshot_id <> NEW.snapshot_id OR obs.check_code <> base.check_code THEN
      RAISE EXCEPTION 'VERIFY: verification must re-run check % on the verification snapshot', base.check_code
        USING ERRCODE = 'check_violation';
    END IF;
    IF obs.rule_version_id <> NEW.rule_version_id THEN
      RAISE EXCEPTION 'VERIFY: verification observation used rule version %, not %', obs.rule_version_id, NEW.rule_version_id
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

-- ------------------------------------------------------------------ 4. structured price overrides

ALTER TABLE opportunities DROP COLUMN price_override_basis;
ALTER TABLE opportunities
  ADD COLUMN price_override_kind            text CHECK (price_override_kind IN ('DISCOUNT','BUNDLE')),
  ADD COLUMN price_override_reason          text,
  ADD COLUMN price_override_approved_by     text,
  ADD COLUMN price_override_approved_at     timestamptz,
  ADD COLUMN price_override_catalog_item_ids bigint[];
ALTER TABLE opportunities ADD CONSTRAINT opportunities_price_override_shape_check CHECK (
  CASE WHEN price_override_kind IS NULL THEN
         price_override_reason IS NULL AND price_override_approved_by IS NULL
         AND price_override_approved_at IS NULL AND price_override_catalog_item_ids IS NULL
       ELSE service_price IS NOT NULL
         AND coalesce(btrim(price_override_reason), '') <> ''
         AND coalesce(btrim(price_override_approved_by), '') <> ''
         AND price_override_approved_at IS NOT NULL
         AND (price_override_kind = 'BUNDLE') = (coalesce(cardinality(price_override_catalog_item_ids), 0) > 0)
  END);

-- A service price comes from the catalog. With no override it must sit inside the mapped item's
-- cited band. DISCOUNT may only go below that band. BUNDLE must sit inside the summed bands of the
-- mapped item plus the other catalog items it names. Currency is never overridable, and an item
-- with no cited price cannot be priced at all.
CREATE OR REPLACE FUNCTION opportunity_price_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; lo numeric; hi numeric; extras int; bad int;
BEGIN
  IF NEW.service_price IS NULL THEN RETURN NEW; END IF;
  IF NEW.catalog_item_id IS NULL THEN
    RAISE EXCEPTION 'PRICE: service_price needs a mapped catalog item' USING ERRCODE = 'check_violation';
  END IF;
  SELECT price_low, price_high, currency INTO c FROM scopely.catalog_items WHERE id = NEW.catalog_item_id;
  IF c.price_low IS NULL THEN
    RAISE EXCEPTION 'PRICE: catalog item % has no cited price, so it cannot be priced', NEW.catalog_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF c.currency <> NEW.currency THEN
    RAISE EXCEPTION 'PRICE: service_price currency % is not the catalog currency %', NEW.currency, c.currency
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.price_override_kind IS NULL THEN
    IF NEW.service_price < c.price_low OR NEW.service_price > c.price_high THEN
      RAISE EXCEPTION 'PRICE: service_price % % is outside catalog band %-% and has no structured override',
        NEW.service_price, NEW.currency, c.price_low, c.price_high USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.price_override_kind = 'DISCOUNT' THEN
    IF NEW.service_price >= c.price_low THEN
      RAISE EXCEPTION 'PRICE: a DISCOUNT must be below the catalog band low %, got %', c.price_low, NEW.service_price
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE -- BUNDLE
    SELECT count(*), count(*) FILTER (WHERE ci.price_low IS NULL OR ci.currency <> c.currency OR NOT ci.active),
           sum(ci.price_low), sum(ci.price_high)
      INTO extras, bad, lo, hi
      FROM (SELECT DISTINCT unnest(NEW.price_override_catalog_item_ids) AS id) x
      JOIN scopely.catalog_items ci ON ci.id = x.id;
    IF NEW.catalog_item_id = ANY (NEW.price_override_catalog_item_ids)
       OR extras <> cardinality(NEW.price_override_catalog_item_ids) OR bad > 0 THEN
      RAISE EXCEPTION 'PRICE: a BUNDLE must name other distinct, active catalog items with a cited price in %', c.currency
        USING ERRCODE = 'check_violation';
    END IF;
    lo := lo + c.price_low; hi := hi + c.price_high;
    IF NEW.service_price < lo OR NEW.service_price > hi THEN
      RAISE EXCEPTION 'PRICE: BUNDLE price % is outside the summed catalog band %-%', NEW.service_price, lo, hi
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

