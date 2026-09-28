-- 007_workspaces: the tenant boundary. Scopely is a multi-user product; the first operator's
-- manual validation is one workspace among many, not the application's identity.
--
-- 1. users, workspaces and memberships. No authentication: a later API layer authenticates a
--    user, checks the membership and sets the request's workspace (below). Nothing here names a
--    default user, workspace or sender.
-- 2. Every commercial row carries workspace_id. It is NOT NULL, has no fixed default, and is
--    taken from the request context (the scopely.workspace_id setting) or inherited from the
--    parent row. A row can never point at a row of another workspace (a00_workspace_guard) and
--    can never move to another workspace.
-- 3. Shared vocabulary stays global: playbooks, issue codes, rule versions and build kinds.
--    Markets and catalog items may be shared starter rows (workspace_id NULL, read-only to
--    workspaces) or a workspace's own. Commercial rows may reference a shared market or catalog
--    item; they may never reference another workspace's.
-- 4. Row-level security isolates workspaces for any non-owner role (the application role). The
--    migration owner and superusers bypass it, so migrations and operations still work.
-- 5. Suppression is scoped to the workspace and can also name a business.
-- 6. Mailboxes are workspace connections. A message is marked sent only from a mailbox of its own
--    workspace, and the sender and recipient addresses are captured from that mailbox and contact.
-- 7. The corporate-subscriber outreach rule becomes data (outreach_basis_rules); the UK row keeps
--    the current rule (active Ltd/LLP, no PLC).
-- 8. The commercial views run with the caller's rights and group by workspace.
--
-- Existing data: if any commercial row already exists it is assigned to one new workspace named
-- 'Migrated workspace', so nothing is lost or left unowned. A fresh database gets no workspace.

SET search_path = scopely;

-- ------------------------------------------------------------------ 1. users and workspaces

CREATE TABLE workspaces (
  id          bigserial PRIMARY KEY,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A person who can belong to several workspaces. Identity only: no password, no session.
CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+$'),
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE workspace_memberships (
  workspace_id  bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user_idx ON workspace_memberships (user_id);

-- The request's workspace. NULL when unset, so an insert with no context and no parent fails.
CREATE FUNCTION current_workspace_id() RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('scopely.workspace_id', true), '')::bigint
$$;

-- ------------------------------------------------------------------ 6. mailbox connections

-- A sending mailbox belongs to one workspace. MANUAL means registered so manual sends can be
-- recorded against it; no provider credentials exist. Tokens are never stored in this table:
-- credential_ref names an entry in a secret store once provider connections are built.
CREATE TABLE mailbox_connections (
  id                   bigserial PRIMARY KEY,
  workspace_id         bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('google_workspace','microsoft_365')),
  email                text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+$'),
  display_name         text,
  state                text NOT NULL DEFAULT 'MANUAL'
                       CHECK (state IN ('MANUAL','PENDING','CONNECTED','DISCONNECTED','REVOKED','ERROR')),
  provider_account_id  text,
  credential_ref       text,
  connected_by_user_id bigint REFERENCES users(id),
  connected_at         timestamptz,
  disconnected_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'CONNECTED' OR connected_at IS NOT NULL),
  CHECK (state NOT IN ('DISCONNECTED','REVOKED') OR disconnected_at IS NOT NULL)
);
CREATE UNIQUE INDEX mailbox_connections_email_uq ON mailbox_connections (workspace_id, lower(email));

-- ------------------------------------------------------------------ 2. workspace_id on owned rows

ALTER TABLE markets        ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE catalog_items  ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE businesses        ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE sources           ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE snapshots         ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE observations      ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE evidence          ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE evidence_rechecks ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE contacts          ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE suppression       ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE opportunities     ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE opportunity_evidence ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE outcomes          ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE verifications     ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE messages          ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE cost_events       ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE builds            ADD COLUMN workspace_id bigint REFERENCES workspaces(id);
ALTER TABLE build_evidence    ADD COLUMN workspace_id bigint REFERENCES workspaces(id);

-- Existing data goes to one migrated workspace. Append-only and guard triggers are paused for the
-- backfill only, because it changes nothing but the new column.
DO $$
DECLARE ws bigint; t text;
BEGIN
  IF EXISTS (SELECT 1 FROM scopely.businesses) OR EXISTS (SELECT 1 FROM scopely.suppression) THEN
    INSERT INTO scopely.workspaces (slug, name) VALUES ('migrated', 'Migrated workspace') RETURNING id INTO ws;
    FOREACH t IN ARRAY ARRAY['businesses','sources','snapshots','observations','evidence','evidence_rechecks','contacts',
                             'suppression','opportunities','opportunity_evidence','outcomes','verifications','messages',
                             'cost_events','builds','build_evidence'] LOOP
      EXECUTE format('ALTER TABLE scopely.%I DISABLE TRIGGER USER', t);
      EXECUTE format('UPDATE scopely.%I SET workspace_id = $1', t) USING ws;
      EXECUTE format('ALTER TABLE scopely.%I ENABLE TRIGGER USER', t);
    END LOOP;
    -- Markets and catalog items created after the seed migrations were that operator's own.
    UPDATE scopely.markets SET workspace_id = ws
     WHERE name NOT IN ('London aesthetics (benchmark)', 'UK trades, Lead Recovery (experiment)');
    UPDATE scopely.catalog_items SET workspace_id = ws
     WHERE key NOT IN ('website_fix_sprint','booking_lead_automation_sprint','lead_recovery_system','landing_page_build');
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['markets','catalog_items','businesses','sources','snapshots','observations','evidence',
                           'evidence_rechecks','contacts','suppression','opportunities','opportunity_evidence','outcomes',
                           'verifications','messages','cost_events','builds','build_evidence'] LOOP
    EXECUTE format('ALTER TABLE scopely.%I ALTER COLUMN workspace_id SET DEFAULT scopely.current_workspace_id()', t);
    IF t NOT IN ('markets','catalog_items') THEN
      EXECUTE format('ALTER TABLE scopely.%I ALTER COLUMN workspace_id SET NOT NULL', t);
    END IF;
  END LOOP;
END $$;

-- A domain is unique per market within a workspace. Two workspaces can hold the same business in
-- the same shared market; the old global key would have refused the second and leaked the first.
ALTER TABLE businesses DROP CONSTRAINT businesses_market_id_domain_key;
ALTER TABLE businesses ADD CONSTRAINT businesses_workspace_market_domain_key UNIQUE (workspace_id, market_id, domain);

-- Catalog keys are unique per owner: a workspace can define its own item with a shared key.
ALTER TABLE catalog_items DROP CONSTRAINT catalog_items_key_key;
CREATE UNIQUE INDEX catalog_items_owner_key_uq ON catalog_items (coalesce(workspace_id, 0), key);
CREATE INDEX markets_workspace_idx ON markets (workspace_id);

-- Every foreign key between owned rows stays inside one workspace. Arguments are pairs of
-- (column, parent table). A NULL workspace_id is inherited from the first parent found; a
-- supplied one must match. Only markets and catalog items may be shared (workspace_id NULL).
-- SECURITY DEFINER so the check sees the parent even when row-level security would hide it:
-- a hidden parent must fail loudly, not pass silently. Named a00_ so it fires before every other
-- BEFORE trigger on the table.
CREATE FUNCTION workspace_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = scopely, pg_temp AS $$
DECLARE i int := 0; col text; parent text; pid bigint; pws bigint; hit boolean; j jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'WORKSPACE: a % row cannot move to another workspace', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  WHILE i < TG_NARGS LOOP
    col := TG_ARGV[i]; parent := TG_ARGV[i + 1]; i := i + 2;
    pid := (j ->> col)::bigint;
    CONTINUE WHEN pid IS NULL;
    hit := NULL;
    EXECUTE format('SELECT workspace_id, true FROM scopely.%I WHERE id = $1', parent) INTO pws, hit USING pid;
    CONTINUE WHEN hit IS NULL;                 -- no such parent: the foreign key reports it
    IF pws IS NULL THEN
      CONTINUE WHEN parent IN ('markets','catalog_items');  -- shared starter row
      RAISE EXCEPTION 'WORKSPACE: % % has no workspace', parent, pid USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.workspace_id IS NULL THEN
      NEW.workspace_id := pws;
    ELSIF NEW.workspace_id <> pws THEN
      RAISE EXCEPTION 'WORKSPACE: % % belongs to workspace %, not workspace %', parent, pid, pws, NEW.workspace_id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  -- A row with no workspace and no parent to inherit one from is left to NOT NULL to report.
  RETURN NEW;
END $$;

CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON markets FOR EACH ROW EXECUTE FUNCTION workspace_guard();
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON catalog_items FOR EACH ROW EXECUTE FUNCTION workspace_guard();
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('market_id','markets');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON observations
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('snapshot_id','snapshots');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON evidence
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','observation_id','observations');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON evidence_rechecks
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('evidence_id','evidence','snapshot_id','snapshots','observation_id','observations');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','market_id','markets','catalog_item_id','catalog_items');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON opportunity_evidence
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','evidence_id','evidence');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON outcomes
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','message_id','messages','corrects_outcome_id','outcomes');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON verifications
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','baseline_evidence_id','evidence',
                                                'snapshot_id','snapshots','observation_id','observations');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON builds
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','catalog_item_id','catalog_items','supersedes_build_id','builds');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON build_evidence
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('build_id','builds','evidence_id','evidence');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON cost_events
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','opportunity_id','opportunities','build_id','builds');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON mailbox_connections
  FOR EACH ROW EXECUTE FUNCTION workspace_guard();

-- A bundle price may only name catalog items the opportunity's workspace can see.
CREATE FUNCTION opportunity_bundle_workspace_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = scopely, pg_temp AS $$
BEGIN
  IF NEW.price_override_catalog_item_ids IS NOT NULL AND EXISTS (
       SELECT 1 FROM scopely.catalog_items ci
        WHERE ci.id = ANY (NEW.price_override_catalog_item_ids)
          AND ci.workspace_id IS NOT NULL AND ci.workspace_id <> NEW.workspace_id) THEN
    RAISE EXCEPTION 'WORKSPACE: a bundle names a catalog item of another workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a01_opportunity_bundle_workspace_guard BEFORE INSERT OR UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunity_bundle_workspace_guard();

-- ------------------------------------------------------------------ 5. suppression scope

ALTER TABLE suppression ADD COLUMN business_id bigint REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE suppression DROP CONSTRAINT suppression_check;
ALTER TABLE suppression ADD CONSTRAINT suppression_target_check
  CHECK (email IS NOT NULL OR domain IS NOT NULL OR business_id IS NOT NULL);
DROP INDEX suppression_email_uq;
DROP INDEX suppression_domain_uq;
CREATE UNIQUE INDEX suppression_email_uq    ON suppression (workspace_id, lower(email))  WHERE email IS NOT NULL;
CREATE UNIQUE INDEX suppression_domain_uq   ON suppression (workspace_id, lower(domain)) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX suppression_business_uq ON suppression (workspace_id, business_id)   WHERE business_id IS NOT NULL;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON suppression
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses');

-- ------------------------------------------------------------------ 7. outreach rules as data

-- Which company types and status a corporate-subscriber contact needs, per country. A country
-- with no row has no corporate-subscriber restriction in Scopely (the seller remains responsible
-- for local law). Changing the rule is a data change citing a rule version, not a code change.
CREATE TABLE outreach_basis_rules (
  id                      bigserial PRIMARY KEY,
  country_code            char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  outreach_basis          text NOT NULL CHECK (outreach_basis IN ('corporate_subscriber','consent')),
  allowed_company_types   text[] NOT NULL CHECK (cardinality(allowed_company_types) > 0),
  required_company_status text NOT NULL,
  requirement             text NOT NULL CHECK (btrim(requirement) <> ''),   -- shown when refused
  rule_version_id         bigint NOT NULL REFERENCES rule_versions(id),
  active                  boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX outreach_basis_rules_active_uq ON outreach_basis_rules (country_code, outreach_basis) WHERE active;

-- Current rule (decision A4): active Ltd or LLP only. PLC is open decision B3 and is not added.
INSERT INTO outreach_basis_rules (country_code, outreach_basis, allowed_company_types, required_company_status, requirement, rule_version_id)
SELECT 'GB', 'corporate_subscriber', ARRAY['ltd','llp'], 'active', 'UK corporate-subscriber outreach needs an active Ltd or LLP', id
  FROM rule_versions WHERE rule_key = 'qualify.corporate_subscriber' AND version = 1;

-- The reason this contact cannot be contacted about this business, or NULL. Suppression is the
-- business's own workspace's list: another workspace's opt-outs never apply.
CREATE OR REPLACE FUNCTION contact_outreach_blocker(p_contact_id bigint, p_business_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE c record; b record; r record;
BEGIN
  IF p_contact_id IS NULL THEN RETURN 'an approved message needs a contact'; END IF;
  SELECT * INTO c FROM scopely.contacts WHERE id = p_contact_id;
  SELECT * INTO b FROM scopely.businesses WHERE id = p_business_id;
  IF c.business_id <> b.id THEN RETURN 'contact belongs to a different business'; END IF;
  IF c.email IS NULL THEN RETURN 'contact has no email address'; END IF;
  IF c.outreach_basis IS NULL OR c.outreach_basis NOT IN ('corporate_subscriber','consent') THEN
    RETURN format('contact outreach basis is %s; it must be corporate_subscriber or consent', coalesce(c.outreach_basis, 'NULL'));
  END IF;
  SELECT * INTO r FROM scopely.outreach_basis_rules
   WHERE active AND country_code = b.country_code AND outreach_basis = c.outreach_basis;
  IF FOUND AND NOT (lower(btrim(coalesce(b.company_type, ''))) = ANY (r.allowed_company_types)
                    AND lower(btrim(coalesce(b.company_status, ''))) = r.required_company_status) THEN
    RETURN format('%s, got %s / %s', r.requirement, coalesce(b.company_type, 'NULL'), coalesce(b.company_status, 'NULL'));
  END IF;
  IF EXISTS (SELECT 1 FROM scopely.suppression s
              WHERE s.workspace_id = b.workspace_id
                AND ((s.email IS NOT NULL AND lower(s.email) = lower(c.email))
                     OR (s.domain IS NOT NULL AND (lower(s.domain) = lower(split_part(c.email, '@', 2))
                                                   OR lower(s.domain) = lower(coalesce(b.domain, ''))))
                     OR s.business_id = b.id)) THEN
    RETURN 'contact or business is suppressed';
  END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------------ 6. messages: sender and recipient

ALTER TABLE messages
  ADD COLUMN mailbox_connection_id bigint REFERENCES mailbox_connections(id),
  ADD COLUMN sender_email    text,
  ADD COLUMN recipient_email text;
ALTER TABLE messages ADD CONSTRAINT messages_sender_check
  CHECK (sent_at IS NULL OR (mailbox_connection_id IS NOT NULL AND sender_email IS NOT NULL AND recipient_email IS NOT NULL));
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','contact_id','contacts',
                                                'mailbox_connection_id','mailbox_connections');
CREATE INDEX messages_opportunity_idx ON messages (opportunity_id);

-- The addresses a message went between are facts of the send, captured from the contact at
-- approval and from the mailbox at send, never typed in and never a global default. Runs after
-- a00_workspace_guard (same workspace) and before message_gate.
CREATE FUNCTION message_addresses() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mb record; addr text;
BEGIN
  IF NEW.approval_status IN ('approved','edited') AND NEW.contact_id IS NOT NULL THEN
    SELECT email INTO addr FROM scopely.contacts WHERE id = NEW.contact_id;
    IF NEW.recipient_email IS NULL OR (TG_OP = 'UPDATE' AND NEW.contact_id IS DISTINCT FROM OLD.contact_id) THEN
      NEW.recipient_email := addr;
    ELSIF lower(NEW.recipient_email) <> lower(coalesce(addr, '')) THEN
      RAISE EXCEPTION 'MESSAGE: recipient_email must be the contact''s address' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- An unapproved send is left to the messages CHECK constraints to report.
  IF NEW.sent_at IS NOT NULL AND NEW.approval_status IN ('approved','edited') AND (TG_OP = 'INSERT' OR OLD.sent_at IS NULL) THEN
    IF NEW.mailbox_connection_id IS NULL THEN
      RAISE EXCEPTION 'MESSAGE: cannot mark sent without the workspace mailbox it was sent from' USING ERRCODE = 'check_violation';
    END IF;
    SELECT email, state INTO mb FROM scopely.mailbox_connections WHERE id = NEW.mailbox_connection_id;
    IF mb.state NOT IN ('MANUAL','CONNECTED') THEN
      RAISE EXCEPTION 'MESSAGE: mailbox % is %; it cannot send', NEW.mailbox_connection_id, mb.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.sender_email IS NULL THEN
      NEW.sender_email := mb.email;
    ELSIF lower(NEW.sender_email) <> lower(mb.email) THEN
      RAISE EXCEPTION 'MESSAGE: sender_email must be the mailbox''s address' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a10_message_addresses BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION message_addresses();

-- A sent message's mailbox and addresses are part of what was sent.
CREATE FUNCTION message_sent_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sent_at IS NOT NULL AND (NEW.mailbox_connection_id IS DISTINCT FROM OLD.mailbox_connection_id
       OR NEW.sender_email IS DISTINCT FROM OLD.sender_email OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email) THEN
    RAISE EXCEPTION 'MESSAGE: a sent message cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_sent_frozen BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION message_sent_frozen();

-- ------------------------------------------------------------------ 4. row-level security

-- Applies to every role except the table owner and superusers. The application connects as a
-- non-owner role and sets scopely.workspace_id per request (SET LOCAL). With no workspace set, a
-- workspace sees nothing but shared rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses','sources','snapshots','observations','evidence','evidence_rechecks','contacts',
                           'suppression','opportunities','opportunity_evidence','outcomes','verifications','messages',
                           'cost_events','builds','build_evidence','mailbox_connections'] LOOP
    EXECUTE format('ALTER TABLE scopely.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_isolation ON scopely.%I USING (workspace_id = scopely.current_workspace_id())
                    WITH CHECK (workspace_id = scopely.current_workspace_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['markets','catalog_items'] LOOP
    EXECUTE format('ALTER TABLE scopely.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_isolation ON scopely.%I
                    USING (workspace_id IS NULL OR workspace_id = scopely.current_workspace_id())
                    WITH CHECK (workspace_id = scopely.current_workspace_id())', t);
  END LOOP;
END $$;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspaces USING (id = current_workspace_id()) WITH CHECK (id = current_workspace_id());
ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_memberships
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
-- A user is visible to a workspace only through a membership of that workspace.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_members ON users USING (EXISTS (
  SELECT 1 FROM scopely.workspace_memberships m WHERE m.user_id = users.id AND m.workspace_id = scopely.current_workspace_id()));

-- ------------------------------------------------------------------ 8. views per workspace

-- Funnel per workspace and market (a shared market is counted separately for each workspace).
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
         sum(o.deal_value)                                  AS revenue,
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
       b.workspace_id
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
       sum(o.deal_value)                                AS revenue,
       CASE WHEN count(*) FILTER (WHERE o.pitched_at IS NOT NULL) = 0 THEN NULL
            ELSE round(count(*) FILTER (WHERE o.won_at IS NOT NULL)::numeric
                       / count(*) FILTER (WHERE o.pitched_at IS NOT NULL), 4) END AS win_rate,
       count(*) FILTER (WHERE o.verification_status = 'PASSED') AS verified_passed,
       o.workspace_id
  FROM scopely.opportunities o
  JOIN scopely.businesses b ON b.id = o.business_id
  LEFT JOIN scopely.markets m ON m.id = coalesce(o.market_id, b.market_id)
 GROUP BY o.workspace_id, m.playbook_id, b.vertical, b.country_code, o.opportunity_type, o.catalog_item_id;

-- Views run with the querying role's rights, so row-level security applies through them.
ALTER VIEW v_market_funnel SET (security_invoker = true);
ALTER VIEW v_opportunity_type_performance SET (security_invoker = true);
ALTER VIEW v_opportunity_ledger SET (security_invoker = true);
