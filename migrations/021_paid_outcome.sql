-- 021_paid_outcome: revenue is money received (P4, founder decision 2026-11-07, closes B1).
--
-- The ledger now records `paid`: an amount of money the business actually paid, in the
-- opportunity's currency, on the day it arrived. A win's amount stays what it always was, the
-- value the seller agreed (opportunities.deal_value). Only paid outcomes are revenue.
--
--   pitched → replied → won → paid → delivered → verified
--
-- Rules, enforced here:
--   * paid needs a standing win (a voided win leaves nothing to pay against) and an amount > 0 in
--     the opportunity's currency. Currency is never converted.
--   * several payments may be recorded (a deposit, then the balance). Each is its own row.
--   * a mistaken payment is corrected by a `voided` outcome naming it, like a win or a loss.
--   * a win that a standing payment rests on cannot be voided: void the payment first.
--   * opportunities.paid_amount / paid_at are projections of the standing payments, guarded like
--     every other commercial field.
--   * every view's `revenue` is now money received (sum of paid_amount), NULL when the amounts
--     are in more than one currency. The agreed value is kept beside it as `agreed_value`, and
--     the ledger's gross profit is computed from money received.
--
-- payment_status(won_at, agreed, paid): 'not_won', 'awaiting_payment', 'part_paid', 'paid_in_full',
-- or 'paid_more_than_agreed'. It is a comparison of two recorded amounts in the same currency,
-- never an estimate.

SET search_path = scopely;

ALTER TABLE outcomes DROP CONSTRAINT outcomes_kind_check;
ALTER TABLE outcomes ADD CONSTRAINT outcomes_kind_check
  CHECK (kind IN ('pitched','replied','call','won','lost','paid','delivered','voided'));
ALTER TABLE outcomes DROP CONSTRAINT outcomes_check1;
ALTER TABLE outcomes ADD CONSTRAINT outcomes_amount_kind_check CHECK (amount IS NULL OR kind IN ('won','paid','delivered'));
ALTER TABLE outcomes ADD CONSTRAINT outcomes_paid_amount_check CHECK (kind <> 'paid' OR (amount > 0 AND currency IS NOT NULL));

ALTER TABLE opportunities
  ADD COLUMN paid_amount numeric(12,2) CHECK (paid_amount > 0),
  ADD COLUMN paid_at     timestamptz,
  ADD CONSTRAINT opportunities_paid_check CHECK ((paid_amount IS NULL) = (paid_at IS NULL));

CREATE FUNCTION payment_status(won_at timestamptz, agreed numeric, paid numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN won_at IS NULL THEN 'not_won'
              WHEN paid IS NULL THEN 'awaiting_payment'
              WHEN agreed IS NULL OR paid < agreed THEN 'part_paid'
              WHEN paid = agreed THEN 'paid_in_full'
              ELSE 'paid_more_than_agreed' END
$$;

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
  -- Money received needs a standing win to be paid against, in the win's currency.
  IF NEW.kind = 'paid' THEN
    IF opp.won_at IS NULL THEN
      RAISE EXCEPTION 'OUTCOME: cannot record a payment before a won outcome' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.occurred_at < opp.pitched_at THEN
      RAISE EXCEPTION 'OUTCOME: a payment cannot predate the pitch' USING ERRCODE = 'check_violation';
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
    IF target.kind NOT IN ('won','lost','paid') THEN
      RAISE EXCEPTION 'OUTCOME: only a won, lost or paid outcome can be voided, not %', target.kind USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM scopely.outcomes v WHERE v.corrects_outcome_id = NEW.corrects_outcome_id) THEN
      RAISE EXCEPTION 'OUTCOME: outcome % is already voided', NEW.corrects_outcome_id USING ERRCODE = 'check_violation';
    END IF;
    IF target.kind = 'won' AND opp.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'OUTCOME: cannot void a win that a delivery rests on' USING ERRCODE = 'check_violation';
    END IF;
    IF target.kind = 'won' AND opp.paid_amount IS NOT NULL THEN
      RAISE EXCEPTION 'OUTCOME: cannot void a win that a payment rests on; void the payment first' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.occurred_at < target.occurred_at THEN
      RAISE EXCEPTION 'OUTCOME: a correction cannot predate the outcome it voids' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.currency IS NOT NULL AND opp.currency IS NOT NULL AND NEW.currency <> opp.currency THEN
    RAISE EXCEPTION 'OUTCOME: currency % differs from opportunity currency %', NEW.currency, opp.currency
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'paid' AND opp.currency IS NULL THEN
    RAISE EXCEPTION 'OUTCOME: a payment needs the opportunity''s currency' USING ERRCODE = 'check_violation';
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
      status     = CASE WHEN voided_kind = 'paid' THEN o.status WHEN o.reply_at IS NOT NULL THEN 'REPLIED' ELSE 'PITCHED' END
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
  -- Money received is the sum of the standing payments, recomputed from the ledger each time.
  IF NEW.kind = 'paid' OR (NEW.kind = 'voided' AND voided_kind = 'paid') THEN
    UPDATE scopely.opportunities o SET (paid_amount, paid_at) = (
      SELECT sum(p.amount), min(p.occurred_at) FROM scopely.outcomes p
       WHERE p.opportunity_id = o.id AND p.kind = 'paid'
         AND NOT EXISTS (SELECT 1 FROM scopely.outcomes v WHERE v.corrects_outcome_id = p.id))
    WHERE o.id = NEW.opportunity_id;
  END IF;
  PERFORM set_config('scopely.projecting', 'off', true);
  RETURN NULL;
END $$;

-- paid_amount and paid_at change only through the ledger, like every other commercial field.
CREATE FUNCTION opportunity_paid_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('scopely.projecting', true), 'off') = 'on' THEN RETURN NEW; END IF;
  IF (TG_OP = 'INSERT' AND (NEW.paid_amount IS NOT NULL OR NEW.paid_at IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (NEW.paid_amount IS DISTINCT FROM OLD.paid_amount OR NEW.paid_at IS DISTINCT FROM OLD.paid_at)) THEN
    RAISE EXCEPTION 'OUTCOME: money received comes from paid outcomes, not from the opportunity row' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_paid_projection_guard BEFORE INSERT OR UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunity_paid_projection_guard();

-- ------------------------------------------------------------------ views: revenue = money received

CREATE OR REPLACE VIEW v_market_funnel AS
WITH b AS (
  SELECT workspace_id, market_id,
         count(*)                                              AS prospects_processed,
         count(*) FILTER (WHERE qualification_status = 'QUALIFIED') AS prospects_qualified,
         count(*) FILTER (WHERE qualification_status = 'REJECTED')  AS prospects_rejected
    FROM scopely.businesses GROUP BY workspace_id, market_id
), o AS (
  SELECT b.workspace_id, b.market_id,
         count(o.*)                                       AS opportunities_found,
         count(o.*) FILTER (WHERE o.pitched_at IS NOT NULL) AS opportunities_pitched,
         count(o.*) FILTER (WHERE o.reply_at IS NOT NULL)   AS replies,
         count(o.*) FILTER (WHERE o.won_at IS NOT NULL)     AS wins,
         CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) > 1 THEN NULL ELSE sum(o.paid_amount) END AS revenue,
         CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) = 1 THEN min(o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) END AS revenue_currency,
         CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.deal_value IS NOT NULL) > 1 THEN NULL ELSE sum(o.deal_value) END AS agreed_value,
         count(o.*) FILTER (WHERE o.paid_amount IS NOT NULL) AS paid,
         sum(o.delivery_cost)                               AS delivery_cost,
         bool_or(o.won_at IS NOT NULL AND o.delivery_cost IS NULL) AS delivery_cost_incomplete
    FROM scopely.opportunities o JOIN scopely.businesses b ON b.id = o.business_id
   GROUP BY b.workspace_id, b.market_id
), calls AS (
  SELECT b.workspace_id, b.market_id, count(DISTINCT oc.opportunity_id) AS calls
    FROM scopely.outcomes oc JOIN scopely.opportunities o ON o.id = oc.opportunity_id
    JOIN scopely.businesses b ON b.id = o.business_id
   WHERE oc.kind = 'call' GROUP BY b.workspace_id, b.market_id
), c AS (
  SELECT b.workspace_id, b.market_id,
         sum(ce.amount)                         AS analysis_cost,
         bool_or(ce.amount IS NULL AND ce.kind <> 'operator_time') AS analysis_cost_incomplete,
         sum(ce.minutes)                        AS operator_minutes
    FROM scopely.cost_events ce JOIN scopely.businesses b ON b.id = ce.business_id
   GROUP BY b.workspace_id, b.market_id
), s AS (
  SELECT b.workspace_id, b.market_id, count(*) AS messages_sent
    FROM scopely.messages msg JOIN scopely.opportunities o ON o.id = msg.opportunity_id
    JOIN scopely.businesses b ON b.id = o.business_id
   WHERE msg.sent_at IS NOT NULL GROUP BY b.workspace_id, b.market_id
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
       coalesce(s.messages_sent, 0)         AS messages_sent,
       b.workspace_id,
       o.revenue_currency,
       o.agreed_value,
       coalesce(o.paid, 0)                  AS paid
  FROM b
  LEFT JOIN o     ON o.workspace_id = b.workspace_id     AND o.market_id IS NOT DISTINCT FROM b.market_id
  LEFT JOIN calls ON calls.workspace_id = b.workspace_id AND calls.market_id IS NOT DISTINCT FROM b.market_id
  LEFT JOIN c     ON c.workspace_id = b.workspace_id     AND c.market_id IS NOT DISTINCT FROM b.market_id
  LEFT JOIN s     ON s.workspace_id = b.workspace_id     AND s.market_id IS NOT DISTINCT FROM b.market_id;

CREATE OR REPLACE VIEW v_opportunity_type_performance AS
SELECT m.playbook_id, b.vertical, b.country_code, o.opportunity_type, o.catalog_item_id,
       count(*)                                        AS detected,
       count(*) FILTER (WHERE o.pitched_at IS NOT NULL) AS pitched,
       count(*) FILTER (WHERE o.reply_at IS NOT NULL)   AS replied,
       count(*) FILTER (WHERE o.won_at IS NOT NULL)     AS won,
       CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) > 1 THEN NULL ELSE sum(o.paid_amount) END AS revenue,
       CASE WHEN count(*) FILTER (WHERE o.pitched_at IS NOT NULL) = 0 THEN NULL
            ELSE round(count(*) FILTER (WHERE o.won_at IS NOT NULL)::numeric
                       / count(*) FILTER (WHERE o.pitched_at IS NOT NULL), 4) END AS win_rate,
       count(*) FILTER (WHERE o.verification_status = 'PASSED') AS verified_passed,
       o.workspace_id,
       CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) = 1 THEN min(o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) END AS revenue_currency,
       CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.deal_value IS NOT NULL) > 1 THEN NULL ELSE sum(o.deal_value) END AS agreed_value,
       count(*) FILTER (WHERE o.paid_amount IS NOT NULL) AS paid
  FROM scopely.opportunities o
  JOIN scopely.businesses b ON b.id = o.business_id
  LEFT JOIN scopely.markets m ON m.id = coalesce(o.market_id, b.market_id)
 GROUP BY o.workspace_id, m.playbook_id, b.vertical, b.country_code, o.opportunity_type, o.catalog_item_id;

CREATE OR REPLACE VIEW v_search_run_summary AS
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
         CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) > 1 THEN NULL ELSE sum(o.paid_amount) END AS revenue,
         CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) = 1 THEN min(o.currency) FILTER (WHERE o.paid_amount IS NOT NULL) END AS revenue_currency,
         CASE WHEN count(DISTINCT o.currency) FILTER (WHERE o.deal_value IS NOT NULL) > 1 THEN NULL ELSE sum(o.deal_value) END AS agreed_value,
         count(*) FILTER (WHERE o.paid_amount IS NOT NULL) AS paid
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
         AS revenue_per_100_analyzed,
       o.revenue_currency,
       o.agreed_value,
       coalesce(o.paid, 0) AS paid
  FROM scopely.search_runs r
  JOIN scopely.searches s ON s.id = r.search_id
  LEFT JOIN m ON m.search_run_id = r.id
  LEFT JOIN o ON o.search_run_id = r.id
  LEFT JOIN c ON c.search_run_id = r.id;

CREATE OR REPLACE VIEW v_search_performance AS
SELECT s.workspace_id, s.id AS search_id, s.name,
       count(DISTINCT r.search_run_id) AS runs,
       coalesce(sum(r.discovered), 0) AS discovered, coalesce(sum(r.qualified), 0) AS qualified,
       coalesce(sum(r.analyzed), 0) AS analyzed, coalesce(sum(r.opportunities), 0) AS opportunities,
       coalesce(sum(r.website_opportunities), 0) AS website_opportunities, coalesce(sum(r.fix_opportunities), 0) AS fix_opportunities,
       coalesce(sum(r.pitched), 0) AS pitched, coalesce(sum(r.wins), 0) AS wins,
       CASE WHEN count(DISTINCT r.revenue_currency) > 1 THEN NULL ELSE sum(r.revenue) END AS revenue,
       CASE WHEN bool_or(r.credits_consumed IS NULL) THEN NULL ELSE coalesce(sum(r.credits_consumed), 0) END AS credits_consumed,
       CASE WHEN sum(r.revenue) IS NULL OR coalesce(sum(r.discovered), 0) = 0 THEN NULL
            WHEN count(DISTINCT r.revenue_currency) > 1 THEN NULL
            ELSE round(sum(r.revenue) * 100.0 / sum(r.discovered), 2) END AS revenue_per_100_discovered,
       CASE WHEN count(DISTINCT r.revenue_currency) = 1 THEN min(r.revenue_currency) END AS revenue_currency,
       coalesce(sum(r.paid), 0) AS paid
  FROM scopely.searches s
  LEFT JOIN scopely.v_search_run_summary r ON r.search_id = s.id
 GROUP BY s.workspace_id, s.id, s.name;

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
       CASE WHEN o.paid_amount IS NULL OR o.delivery_cost IS NULL OR cost.analysis_cost IS NULL THEN NULL
            ELSE o.paid_amount - o.delivery_cost - cost.analysis_cost END AS gross_profit,
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
       cost.credits,
       o.paid_amount,
       o.paid_at,
       scopely.payment_status(o.won_at, o.deal_value, o.paid_amount) AS payment_status
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

ALTER VIEW v_market_funnel                SET (security_invoker = true);
ALTER VIEW v_opportunity_type_performance SET (security_invoker = true);
ALTER VIEW v_search_run_summary           SET (security_invoker = true);
ALTER VIEW v_search_performance           SET (security_invoker = true);
ALTER VIEW v_opportunity_ledger           SET (security_invoker = true);
