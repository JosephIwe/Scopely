-- 005_manual_validation: what the manual 20-30 prospect test needs before a single email goes out.
--
-- 1. Evidence re-checks become an append-only ledger backed by a fresh snapshot. A HIGH finding
--    must be re-fetched and confirmed before a message citing it is marked sent, and any finding
--    re-checked as changed or gone blocks the send (it has to be dropped from the message).
-- 2. Message approval and sending are gated on the recipient: a named contact of the same
--    business, a recorded outreach basis, the UK Ltd/LLP-only rule for corporate subscribers
--    (PECR), and suppression. Approved content cannot change without a new approval, and sent
--    content cannot change at all. Nothing here sends anything: sent_at records a manual send.
-- 3. A pitched or replied outcome can name the message it came from, so the pitch is traceable.
-- 4. The Landing Page Build catalog item exists with no price, because no price is established.
-- 5. messages_sent on the market funnel. The per-opportunity ledger view is created in 006,
--    once builds exist.
--
-- Deliberately NOT decided here (open decisions, see docs/DECISIONS.md): the evidence freshness
-- window before a send (D7), daily caps, and whether PLC counts alongside Ltd/LLP.

SET search_path = scopely;

-- ------------------------------------------------------------------ 1. evidence re-check ledger

CREATE TABLE evidence_rechecks (
  id              bigserial PRIMARY KEY,
  evidence_id     bigint NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  snapshot_id     bigint NOT NULL REFERENCES snapshots(id),
  observation_id  bigint REFERENCES observations(id),
  result          text NOT NULL CHECK (result IN ('confirmed','changed','gone')),
  rechecked_at    timestamptz NOT NULL,                  -- derived: the re-check snapshot's fetched_at
  recorded_by     text NOT NULL CHECK (btrim(recorded_by) <> ''),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- confirmed and gone must show the re-run observation; changed must say what changed.
  CHECK (result = 'changed' OR observation_id IS NOT NULL),
  CHECK (result <> 'changed' OR coalesce(btrim(notes), '') <> '')
);
CREATE INDEX evidence_rechecks_evidence_idx ON evidence_rechecks (evidence_id, rechecked_at);

CREATE FUNCTION evidence_recheck_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base record; snap record; obs record; latest timestamptz;
BEGIN
  SELECT e.business_id, e.observed_at, e.rule_version_id, bo.check_code INTO base
    FROM scopely.evidence e JOIN scopely.observations bo ON bo.id = e.observation_id
   WHERE e.id = NEW.evidence_id
     FOR UPDATE OF e;
  IF NOT FOUND THEN RETURN NEW; END IF;  -- the foreign key reports it
  SELECT business_id, fetched_at INTO snap FROM scopely.snapshots WHERE id = NEW.snapshot_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF snap.business_id <> base.business_id THEN
    RAISE EXCEPTION 'RECHECK: snapshot belongs to a different business than evidence %', NEW.evidence_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF snap.fetched_at <= base.observed_at THEN
    RAISE EXCEPTION 'RECHECK: re-check snapshot (%) must be later than the evidence (%)', snap.fetched_at, base.observed_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.rechecked_at IS NULL THEN
    NEW.rechecked_at := snap.fetched_at;
  ELSIF NEW.rechecked_at <> snap.fetched_at THEN
    RAISE EXCEPTION 'RECHECK: rechecked_at % differs from its snapshot fetched_at %', NEW.rechecked_at, snap.fetched_at
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(rechecked_at) INTO latest FROM scopely.evidence_rechecks WHERE evidence_id = NEW.evidence_id;
  IF latest IS NOT NULL AND NEW.rechecked_at <= latest THEN
    RAISE EXCEPTION 'RECHECK: evidence % already has a re-check at or after %', NEW.evidence_id, NEW.rechecked_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.observation_id IS NOT NULL THEN
    SELECT o.snapshot_id, o.check_code, o.rule_version_id, o.state, o.result INTO obs
      FROM scopely.observations o WHERE o.id = NEW.observation_id;
    IF obs.snapshot_id <> NEW.snapshot_id OR obs.check_code <> base.check_code OR obs.rule_version_id <> base.rule_version_id THEN
      RAISE EXCEPTION 'RECHECK: must re-run check % with the evidence rule version on the re-check snapshot', base.check_code
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result = 'confirmed' AND NOT (obs.state = 'OBSERVED' AND obs.result IN ('gap','defect')) THEN
      RAISE EXCEPTION 'RECHECK: confirmed needs an OBSERVED gap or defect, got % %', obs.state, obs.result
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result = 'gone' AND NOT (obs.state = 'OBSERVED' AND obs.result = 'ok') THEN
      RAISE EXCEPTION 'RECHECK: gone needs an OBSERVED ok, got % %', obs.state, obs.result
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_recheck_guard BEFORE INSERT ON evidence_rechecks
  FOR EACH ROW EXECUTE FUNCTION evidence_recheck_guard();

CREATE FUNCTION evidence_rechecks_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RECHECK: re-checks are append-only; record a new re-check instead' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER evidence_rechecks_append_only BEFORE UPDATE ON evidence_rechecks
  FOR EACH ROW EXECUTE FUNCTION evidence_rechecks_append_only();

-- evidence.rechecked_at / recheck_result are a projection of the latest re-check.
CREATE FUNCTION evidence_recheck_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('scopely.projecting', 'on', true);
  UPDATE scopely.evidence SET rechecked_at = NEW.rechecked_at, recheck_result = NEW.result WHERE id = NEW.evidence_id;
  PERFORM set_config('scopely.projecting', 'off', true);
  RETURN NULL;
END $$;
CREATE TRIGGER evidence_recheck_project AFTER INSERT ON evidence_rechecks
  FOR EACH ROW EXECUTE FUNCTION evidence_recheck_project();

CREATE FUNCTION evidence_recheck_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('scopely.projecting', true), 'off') = 'on' THEN RETURN NEW; END IF;
  IF (TG_OP = 'INSERT' AND (NEW.rechecked_at IS NOT NULL OR NEW.recheck_result IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (NEW.rechecked_at IS DISTINCT FROM OLD.rechecked_at
                               OR NEW.recheck_result IS DISTINCT FROM OLD.recheck_result)) THEN
    RAISE EXCEPTION 'RECHECK: re-check results come from evidence_rechecks, not from the evidence row'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_recheck_projection_guard BEFORE INSERT OR UPDATE ON evidence
  FOR EACH ROW EXECUTE FUNCTION evidence_recheck_projection_guard();

-- The reason these evidence rows cannot be put in front of a prospect at time `at`, or NULL.
-- Judged on the latest re-check at or before `at`: changed or gone blocks any finding, and a
-- HIGH finding needs a confirmed re-check. Shared by message sends and shown builds.
CREATE FUNCTION evidence_send_blocker(ids bigint[], at timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT DISTINCT ON (e.id) e.id, e.confidence, r.result
      FROM scopely.evidence e
      LEFT JOIN scopely.evidence_rechecks r ON r.evidence_id = e.id AND r.rechecked_at <= at
     WHERE e.id = ANY (ids)
     ORDER BY e.id, r.rechecked_at DESC NULLS LAST
  )
  SELECT CASE WHEN result IN ('changed','gone')
              THEN format('evidence %s was re-checked as %s and must be dropped', id, result)
              ELSE format('HIGH evidence %s has no confirmed re-check at or before %s', id, at) END
    FROM latest
   WHERE result IN ('changed','gone') OR (confidence = 'HIGH' AND result IS NULL)
   ORDER BY id LIMIT 1
$$;

-- ------------------------------------------------------------------ 2. message approval and send gates

-- The reason this contact cannot be contacted about this business, or NULL.
CREATE FUNCTION contact_outreach_blocker(p_contact_id bigint, p_business_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE c record; b record;
BEGIN
  IF p_contact_id IS NULL THEN RETURN 'an approved message needs a contact'; END IF;
  SELECT * INTO c FROM scopely.contacts WHERE id = p_contact_id;
  SELECT * INTO b FROM scopely.businesses WHERE id = p_business_id;
  IF c.business_id <> b.id THEN RETURN 'contact belongs to a different business'; END IF;
  IF c.email IS NULL THEN RETURN 'contact has no email address'; END IF;
  IF c.outreach_basis IS NULL OR c.outreach_basis NOT IN ('corporate_subscriber','consent') THEN
    RETURN format('contact outreach basis is %s; it must be corporate_subscriber or consent', coalesce(c.outreach_basis, 'NULL'));
  END IF;
  -- PECR: cold B2B email in the UK only to corporate subscribers, and the operator's rule is Ltd/LLP, active.
  IF c.outreach_basis = 'corporate_subscriber' AND b.country_code = 'GB'
     AND NOT (lower(btrim(coalesce(b.company_type, ''))) IN ('ltd','llp')
              AND lower(btrim(coalesce(b.company_status, ''))) = 'active') THEN
    RETURN format('UK corporate-subscriber outreach needs an active Ltd or LLP, got %s / %s',
                  coalesce(b.company_type, 'NULL'), coalesce(b.company_status, 'NULL'));
  END IF;
  IF EXISTS (SELECT 1 FROM scopely.suppression s
              WHERE (s.email IS NOT NULL AND lower(s.email) = lower(c.email))
                 OR (s.domain IS NOT NULL AND (lower(s.domain) = lower(split_part(c.email, '@', 2))
                                               OR lower(s.domain) = lower(coalesce(b.domain, ''))))) THEN
    RETURN 'contact or business is suppressed';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION message_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opp_business bigint; reason text; approved boolean; was_approved boolean; content_changed boolean;
BEGIN
  SELECT business_id INTO opp_business FROM scopely.opportunities WHERE id = NEW.opportunity_id;
  approved := NEW.approval_status IN ('approved','edited');
  was_approved := TG_OP = 'UPDATE' AND OLD.approval_status IN ('approved','edited');
  content_changed := TG_OP = 'UPDATE' AND (NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body
                       OR NEW.evidence_ids IS DISTINCT FROM OLD.evidence_ids OR NEW.contact_id IS DISTINCT FROM OLD.contact_id);

  IF TG_OP = 'UPDATE' AND OLD.sent_at IS NOT NULL AND (content_changed OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
                                                       OR NEW.approval_status IS DISTINCT FROM OLD.approval_status) THEN
    RAISE EXCEPTION 'MESSAGE: a sent message cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF was_approved AND approved AND content_changed AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'MESSAGE: approved content changed; it needs a new approval' USING ERRCODE = 'check_violation';
  END IF;

  -- A new approval (or re-approval) is only valid for a contact we may lawfully email.
  IF approved AND (NOT was_approved OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR content_changed) THEN
    reason := scopely.contact_outreach_blocker(NEW.contact_id, opp_business);
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION 'MESSAGE: cannot approve: %', reason USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- An unapproved send is left to the messages CHECK constraint to report.
  IF NEW.sent_at IS NOT NULL AND approved AND (TG_OP = 'INSERT' OR OLD.sent_at IS NULL) THEN
    IF NEW.sent_at < NEW.approved_at THEN
      RAISE EXCEPTION 'MESSAGE: sent_at must follow a recorded approval' USING ERRCODE = 'check_violation';
    END IF;
    reason := scopely.contact_outreach_blocker(NEW.contact_id, opp_business);
    IF reason IS NULL THEN reason := scopely.evidence_send_blocker(NEW.evidence_ids, NEW.sent_at); END IF;
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION 'MESSAGE: cannot mark sent: %', reason USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_gate BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION message_gate();

-- ------------------------------------------------------------------ 3. pitch traceability

ALTER TABLE outcomes ADD COLUMN message_id bigint REFERENCES messages(id);
ALTER TABLE outcomes ADD CONSTRAINT outcomes_message_kind_check
  CHECK (message_id IS NULL OR kind IN ('pitched','replied'));

CREATE FUNCTION outcome_message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record;
BEGIN
  IF NEW.message_id IS NULL THEN RETURN NEW; END IF;
  SELECT opportunity_id, sent_at INTO m FROM scopely.messages WHERE id = NEW.message_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF m.opportunity_id <> NEW.opportunity_id THEN
    RAISE EXCEPTION 'OUTCOME: message % belongs to another opportunity', NEW.message_id USING ERRCODE = 'check_violation';
  END IF;
  IF m.sent_at IS NULL OR NEW.occurred_at < m.sent_at THEN
    RAISE EXCEPTION 'OUTCOME: % outcome cannot cite message % before it was sent', NEW.kind, NEW.message_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outcome_message_guard BEFORE INSERT ON outcomes
  FOR EACH ROW EXECUTE FUNCTION outcome_message_guard();

-- ------------------------------------------------------------------ 4. catalog: landing page build

-- Named by the operator as a service; no price, effort or scope is recorded anywhere, so the
-- price stays NULL and opportunity_price_guard refuses to price it until one is cited.
INSERT INTO catalog_items (key, service, description)
VALUES ('landing_page_build', 'Landing Page Build',
        'Build a focused landing page for one offer or campaign. Price not established.');

-- ------------------------------------------------------------------ 5. funnel

-- messages_sent appended to the funnel (CREATE OR REPLACE may only add columns at the end).
CREATE OR REPLACE VIEW v_market_funnel AS
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
), s AS (
  SELECT b.market_id, count(*) AS messages_sent
    FROM scopely.messages msg JOIN scopely.opportunities o ON o.id = msg.opportunity_id
    JOIN scopely.businesses b ON b.id = o.business_id
   WHERE msg.sent_at IS NOT NULL GROUP BY b.market_id
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
       NULL::numeric AS time_saved_minutes,  -- needs a measured manual baseline; not assumed
       coalesce(s.messages_sent, 0)         AS messages_sent
  FROM b
  LEFT JOIN o ON o.market_id IS NOT DISTINCT FROM b.market_id
  LEFT JOIN calls ON calls.market_id IS NOT DISTINCT FROM b.market_id
  LEFT JOIN c ON c.market_id IS NOT DISTINCT FROM b.market_id
  LEFT JOIN s ON s.market_id IS NOT DISTINCT FROM b.market_id;
