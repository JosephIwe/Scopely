-- 006_build_fix: the BUILD/FIX boundary. Data model only; nothing here generates anything.
--
-- FIND -> evidence -> opportunity -> service -> BUILD/FIX -> SELL -> DELIVER -> VERIFY -> outcome
--
-- A build is a concrete thing made for one mapped opportunity: a demo made before the pitch so
-- the prospect sees the fix rather than a description of the problem (purpose DEMO), or the
-- implementation made after a win (purpose DELIVERY). What kinds of thing can be built is data
-- (build_kinds), so websites, landing pages, booking flows, lead recovery, SEO, conversion work
-- and automations share one model and new kinds need no schema change.
--
-- Rules the database holds:
--   * a build addresses a MAPPED opportunity, uses that opportunity's catalog item, and that item
--     must declare a build kind (an item with no build path cannot be built);
--   * a build cites at least one evidence row of its own opportunity: it fixes something observed;
--   * a DELIVERY build needs a win; DEMO builds are pre-sale and never count as delivered work;
--   * showing a build to a prospect needs a recorded human approval, and the evidence it cites must
--     pass the same re-check gate as a sent message;
--   * approved content cannot change without a new approval, and shown content cannot change;
--   * build cost is metered in cost_events against the build and its opportunity.
-- Delivery itself is still the 'delivered' outcome, and verification still needs a later snapshot.

SET search_path = scopely;

CREATE TABLE build_kinds (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name         text NOT NULL,
  description  text NOT NULL
);

INSERT INTO build_kinds (key, name, description) VALUES
('website_fix',            'Website fix',            'Targeted repairs to an existing site: broken contact paths, links, forms, content errors.'),
('website',                'Website',                'A new or rebuilt website.'),
('landing_page',           'Landing page',           'A focused page for one offer or campaign.'),
('booking_flow',           'Booking flow',           'Self-booking or enquiry-to-booking flow.'),
('lead_recovery',          'Lead recovery',          'Capture and respond to enquiries that would otherwise be missed (after-hours, missed calls, follow-up).'),
('seo_improvement',        'SEO improvement',        'Search visibility changes to an existing site.'),
('conversion_improvement', 'Conversion improvement', 'Changes that make an existing path to enquiry or purchase work better.'),
('automation',             'Automation',             'A workflow that removes manual steps for the business.');

ALTER TABLE catalog_items ADD COLUMN build_kind text REFERENCES build_kinds(key);
UPDATE catalog_items SET build_kind = 'website_fix'   WHERE key = 'website_fix_sprint';
UPDATE catalog_items SET build_kind = 'booking_flow'  WHERE key = 'booking_lead_automation_sprint';
UPDATE catalog_items SET build_kind = 'lead_recovery' WHERE key = 'lead_recovery_system';
UPDATE catalog_items SET build_kind = 'landing_page'  WHERE key = 'landing_page_build';

CREATE TABLE builds (
  id                   bigserial PRIMARY KEY,
  opportunity_id       bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  catalog_item_id      bigint NOT NULL REFERENCES catalog_items(id),
  build_kind           text NOT NULL REFERENCES build_kinds(key),
  purpose              text NOT NULL CHECK (purpose IN ('DEMO','DELIVERY')),
  status               text NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','APPROVED','SHOWN','DISCARDED','SUPERSEDED')),
  title                text NOT NULL CHECK (btrim(title) <> ''),
  summary              text NOT NULL CHECK (btrim(summary) <> ''),   -- what it does, in plain words
  artifact_ref         text,                                          -- object-store key or URL of the built thing
  artifact_sha256      text CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  generator            text NOT NULL CHECK (btrim(generator) <> ''),  -- 'operator' or '<builder>:<version>'
  approved_by          text,
  approved_at          timestamptz,
  shown_at             timestamptz,
  supersedes_build_id  bigint REFERENCES builds(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (approved_by IS NULL OR btrim(approved_by) <> ''),
  CHECK (status NOT IN ('APPROVED','SHOWN') OR approved_at IS NOT NULL),
  CHECK ((status = 'SHOWN') = (shown_at IS NOT NULL) OR status IN ('DISCARDED','SUPERSEDED')),
  CHECK (shown_at IS NULL OR (purpose = 'DEMO' AND shown_at >= approved_at)),
  CHECK (approved_at IS NULL OR artifact_ref IS NOT NULL)
);
CREATE INDEX builds_opportunity_idx ON builds (opportunity_id);

CREATE TABLE build_evidence (
  build_id     bigint NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  evidence_id  bigint NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (build_id, evidence_id)
);

CREATE FUNCTION build_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opp record; item_kind text; content_changed boolean; ids bigint[]; reason text;
BEGIN
  SELECT o.mapping_status, o.catalog_item_id, o.won_at, o.lost_at INTO opp
    FROM scopely.opportunities o WHERE o.id = NEW.opportunity_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF opp.mapping_status <> 'MAPPED' OR opp.catalog_item_id <> NEW.catalog_item_id THEN
    RAISE EXCEPTION 'BUILD: a build must use its opportunity''s mapped catalog item' USING ERRCODE = 'check_violation';
  END IF;
  SELECT build_kind INTO item_kind FROM scopely.catalog_items WHERE id = NEW.catalog_item_id;
  IF item_kind IS NULL OR item_kind <> NEW.build_kind THEN
    RAISE EXCEPTION 'BUILD: catalog item % builds %, not %', NEW.catalog_item_id, coalesce(item_kind, 'nothing'), NEW.build_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purpose = 'DELIVERY' AND (opp.won_at IS NULL OR opp.lost_at IS NOT NULL) THEN
    RAISE EXCEPTION 'BUILD: a DELIVERY build needs a won opportunity' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_build_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM scopely.builds WHERE id = NEW.supersedes_build_id AND opportunity_id = NEW.opportunity_id) THEN
    RAISE EXCEPTION 'BUILD: can only supersede a build of the same opportunity' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    content_changed := NEW.title IS DISTINCT FROM OLD.title OR NEW.summary IS DISTINCT FROM OLD.summary
      OR NEW.artifact_ref IS DISTINCT FROM OLD.artifact_ref OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
      OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id OR NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id
      OR NEW.build_kind IS DISTINCT FROM OLD.build_kind OR NEW.purpose IS DISTINCT FROM OLD.purpose;
    IF OLD.shown_at IS NOT NULL AND (content_changed OR NEW.shown_at IS DISTINCT FROM OLD.shown_at) THEN
      RAISE EXCEPTION 'BUILD: a shown build cannot change; supersede it' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.approved_at IS NOT NULL AND content_changed AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'BUILD: approved content changed; it needs a new approval' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Showing a build to a prospect is a claim about their business: same re-check gate as a send.
  -- An unapproved or non-DEMO show is left to the builds CHECK constraints to report.
  IF NEW.shown_at IS NOT NULL AND NEW.approved_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.shown_at IS NULL) THEN
    -- A build with no evidence yet is refused at commit by build_has_evidence.
    SELECT array_agg(evidence_id) INTO ids FROM scopely.build_evidence WHERE build_id = NEW.id;
    reason := scopely.evidence_send_blocker(ids, NEW.shown_at);
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION 'BUILD: cannot mark shown: %', reason USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_guard BEFORE INSERT OR UPDATE ON builds
  FOR EACH ROW EXECUTE FUNCTION build_guard();

CREATE FUNCTION build_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scopely.builds bd JOIN scopely.opportunity_evidence oe ON oe.opportunity_id = bd.opportunity_id
                  WHERE bd.id = NEW.build_id AND oe.evidence_id = NEW.evidence_id) THEN
    RAISE EXCEPTION 'BUILD: evidence % is not part of the build''s opportunity', NEW.evidence_id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM scopely.builds WHERE id = NEW.build_id AND approved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'BUILD: the evidence of an approved build cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_evidence_guard BEFORE INSERT ON build_evidence
  FOR EACH ROW EXECUTE FUNCTION build_evidence_guard();

CREATE FUNCTION build_evidence_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM scopely.builds WHERE id = OLD.build_id AND approved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'BUILD: the evidence of an approved build cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER build_evidence_frozen BEFORE DELETE OR UPDATE ON build_evidence
  FOR EACH ROW EXECUTE FUNCTION build_evidence_frozen();

-- Every build fixes something observed: at least one evidence row, checked at commit.
CREATE FUNCTION build_has_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'builds' THEN b_id := NEW.id; ELSE b_id := OLD.build_id; END IF;
  IF EXISTS (SELECT 1 FROM scopely.builds WHERE id = b_id)
     AND NOT EXISTS (SELECT 1 FROM scopely.build_evidence WHERE build_id = b_id) THEN
    RAISE EXCEPTION 'BUILD: build % cites no evidence', b_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER build_has_evidence AFTER INSERT ON builds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION build_has_evidence();
CREATE CONSTRAINT TRIGGER build_evidence_removed AFTER DELETE ON build_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION build_has_evidence();

-- ------------------------------------------------------------------ build cost

ALTER TABLE cost_events DROP CONSTRAINT cost_events_kind_check;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_kind_check
  CHECK (kind IN ('fetch','render','screenshot','llm_call','storage','discovery','enrichment','operator_time','build'));
ALTER TABLE cost_events ADD COLUMN build_id bigint REFERENCES builds(id) ON DELETE CASCADE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_build_check
  CHECK (build_id IS NULL OR opportunity_id IS NOT NULL);

CREATE FUNCTION cost_event_build_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A build cost with no opportunity is left to cost_events_build_check to report.
  IF NEW.build_id IS NOT NULL AND NEW.opportunity_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM scopely.builds WHERE id = NEW.build_id AND opportunity_id = NEW.opportunity_id) THEN
    RAISE EXCEPTION 'COST: build % is not part of opportunity %', NEW.build_id, NEW.opportunity_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_event_build_guard BEFORE INSERT OR UPDATE ON cost_events
  FOR EACH ROW EXECUTE FUNCTION cost_event_build_guard();

-- ------------------------------------------------------------------ experiment ledger

-- One row per opportunity: niche, geography, evidence, service, price, pitch, reply, result,
-- delivery, verification and cost. Unknown values stay NULL.
CREATE VIEW v_opportunity_ledger AS
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
       o.status
  FROM scopely.opportunities o
  JOIN scopely.businesses b ON b.id = o.business_id
  LEFT JOIN scopely.markets m ON m.id = coalesce(o.market_id, b.market_id)
  LEFT JOIN scopely.niche_playbooks p ON p.id = m.playbook_id
  LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id
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
  -- Analysis cost is the opportunity's own metered cost; NULL if nothing is recorded or any
  -- recorded (non-time) cost is unknown.
  LEFT JOIN LATERAL (
    SELECT CASE WHEN count(*) FILTER (WHERE kind <> 'operator_time') = 0
                  OR bool_or(amount IS NULL AND kind <> 'operator_time') THEN NULL
                ELSE sum(amount) END AS analysis_cost,
           sum(minutes) AS operator_minutes
      FROM scopely.cost_events WHERE opportunity_id = o.id) cost ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS demo_builds_shown FROM scopely.builds
     WHERE opportunity_id = o.id AND purpose = 'DEMO' AND shown_at IS NOT NULL) bld ON true;
