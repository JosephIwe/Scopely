-- 016_prospect_intelligence: who to contact about an opportunity, why them, how, and on what evidence (Slice 12).
--
-- OPPORTUNITY -> BUSINESS -> PEOPLE -> PUBLIC CONTACT CHANNELS -> PROVENANCE -> READINESS
--
-- Nothing here is a new state machine. People stay in `contacts` (001), the rows the outreach gate
-- (contact_outreach_blocker, 007) already reads, and readiness stays A30. What this adds:
--
-- 1. Provenance on contacts: when the source showed the person (observed_at), the confidence the
--    source itself stated (never computed by Scopely), and, for a person a provider returned, the
--    provider_operations row of the call, the provider's own record of them and its id for them.
-- 2. Claims need a basis. A person is a decision maker only with a recorded basis (what was seen
--    that says they decide); their relationship to the business (owner, director, ...) only with
--    a basis; VERIFIED only with how it was verified. These are NOT VALID checks: they bind every
--    new or changed row, and rows written before Slice 12 keep what their recorder wrote.
-- 3. A provider never verifies anything. A person a provider returned is inserted UNVERIFIED, not
--    a decision maker, with no relationship and outreach basis 'unknown'; only a person raises any
--    of these later, with a basis. Where a provider row came from never changes.
-- 4. contact_facts: one row per externally sourced fact about a person or the business: a title,
--    an email address, a phone or WhatsApp number, a LinkedIn, Instagram or X profile, a contact
--    page. Each carries its source, source URL, observed_at, label and either the provider call or
--    the person that recorded it. Two sources that disagree are two rows, so a conflict is shown,
--    never resolved by overwriting. A fact is never deleted on its own.
-- 5. The gateway gains the capability 'prospect_intelligence' and the connection scope 'prospects'.
--    A live lookup, like live discovery (A32), runs only on the workspace's own connection.
--
-- What is NOT here: no sending of any kind, no mailbox check (mx_ok stays as recorded), no paid
-- enrichment, and no column that infers a relationship or a decision maker.

SET search_path = scopely;

-- ------------------------------------------------------------------ 1. gateway: capability and scope

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_scopes_check;
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_scopes_check
  CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['build','analysis','discovery','prospects']);

ALTER TABLE provider_operations DROP CONSTRAINT provider_operations_capability_check;
ALTER TABLE provider_operations ADD CONSTRAINT provider_operations_capability_check
  CHECK (capability IN ('business_discovery','prospect_intelligence'));
CREATE INDEX provider_operations_opportunity_idx ON provider_operations (opportunity_id) WHERE opportunity_id IS NOT NULL;

-- Same rules as 014, with the connection's scope following the capability: discovery for
-- business_discovery, prospects for prospect_intelligence.
CREATE OR REPLACE FUNCTION provider_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conn record; path text; need text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PROVIDER: provider operations are a ledger; record a new operation' USING ERRCODE = 'check_violation';
  END IF;
  path := scopely.jsonb_secret_path(NEW.meta);
  IF path IS NOT NULL OR scopely.looks_like_secret(NEW.error_detail) OR scopely.looks_like_secret(NEW.request_ref) THEN
    RAISE EXCEPTION 'SECRET: provider operation % looks like a credential', coalesce(path, 'detail') USING ERRCODE = 'check_violation';
  END IF;
  need := CASE NEW.capability WHEN 'prospect_intelligence' THEN 'prospects' ELSE 'discovery' END;
  IF NEW.provider_connection_id IS NOT NULL THEN
    SELECT provider, mode, state, scopes INTO conn FROM scopely.provider_connections WHERE id = NEW.provider_connection_id;
    IF FOUND THEN
      IF conn.provider <> NEW.provider THEN
        RAISE EXCEPTION 'PROVIDER: connection % is %, not %', NEW.provider_connection_id, conn.provider, NEW.provider USING ERRCODE = 'check_violation';
      END IF;
      IF conn.state <> 'ACTIVE' OR NOT need = ANY (conn.scopes) THEN
        RAISE EXCEPTION 'PROVIDER: connection % is % and scoped %; % needs an ACTIVE % connection',
          NEW.provider_connection_id, conn.state, conn.scopes, NEW.capability, need USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.billed_to IS DISTINCT FROM (CASE conn.mode WHEN 'CUSTOMER_KEY' THEN 'WORKSPACE' ELSE 'SCOPELY' END) THEN
        RAISE EXCEPTION 'PROVIDER: a % connection is billed to %, not %', conn.mode,
          (CASE conn.mode WHEN 'CUSTOMER_KEY' THEN 'WORKSPACE' ELSE 'SCOPELY' END), coalesce(NEW.billed_to, 'nobody')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ------------------------------------------------------------------ 2. contacts: provenance and claims with a basis

ALTER TABLE contacts
  ADD COLUMN observed_at            timestamptz,
  ADD COLUMN confidence             text CHECK (confidence IN ('HIGH','MEDIUM','LOW')),   -- as the source stated it; NULL = not stated
  ADD COLUMN relationship           text CHECK (relationship IN ('owner','director','partner','employee','other')),  -- NULL = not known
  ADD COLUMN relationship_basis     text CHECK (relationship_basis IS NULL OR length(relationship_basis) <= 500),
  ADD COLUMN decision_maker_basis   text CHECK (decision_maker_basis IS NULL OR length(decision_maker_basis) <= 500),
  ADD COLUMN verification_basis     text CHECK (verification_basis IS NULL OR length(verification_basis) <= 500),
  ADD COLUMN verified_by            text CHECK (verified_by IS NULL OR length(verified_by) <= 120),
  ADD COLUMN verified_at            timestamptz,
  ADD COLUMN provider_operation_id  bigint REFERENCES provider_operations(id),
  ADD COLUMN provider_record        jsonb CHECK (provider_record IS NULL OR jsonb_typeof(provider_record) = 'object'),
  ADD COLUMN provider_person_ref    text CHECK (provider_person_ref IS NULL OR length(provider_person_ref) BETWEEN 1 AND 200);

ALTER TABLE contacts ADD CONSTRAINT contacts_relationship_needs_basis
  CHECK (relationship IS NULL OR btrim(coalesce(relationship_basis, '')) <> '');
-- NOT VALID: binds every insert and update from now on; rows recorded before Slice 12 are not re-judged.
ALTER TABLE contacts ADD CONSTRAINT contacts_decision_maker_needs_basis
  CHECK (NOT is_decision_maker OR btrim(coalesce(decision_maker_basis, '')) <> '') NOT VALID;
ALTER TABLE contacts ADD CONSTRAINT contacts_verified_needs_basis
  CHECK (label <> 'VERIFIED' OR btrim(coalesce(verification_basis, '')) <> '') NOT VALID;
-- A provider's person is always the provider's, with its own id for them and the time it was seen.
ALTER TABLE contacts ADD CONSTRAINT contacts_provider_provenance_check
  CHECK (provider_operation_id IS NULL OR (provider_person_ref IS NOT NULL AND observed_at IS NOT NULL));
CREATE UNIQUE INDEX contacts_provider_person_uq ON contacts (workspace_id, business_id, source, provider_person_ref)
  WHERE provider_person_ref IS NOT NULL;

DROP TRIGGER a00_workspace_guard ON contacts;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','provider_operation_id','provider_operations');

-- The provider call a contact or fact cites: a SUCCEEDED prospect_intelligence call of the same
-- provider (the row's source) about the same business. Returns the reason it is not, or NULL.
CREATE FUNCTION prospect_operation_blocker(p_operation_id bigint, p_source text, p_business_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE op record;
BEGIN
  SELECT provider, capability, status, business_id INTO op FROM scopely.provider_operations WHERE id = p_operation_id;
  IF NOT FOUND THEN RETURN NULL; END IF;  -- the foreign key reports it
  IF op.capability <> 'prospect_intelligence' THEN RETURN format('operation %s was %s, not a prospect lookup', p_operation_id, op.capability); END IF;
  IF op.status <> 'SUCCEEDED' THEN RETURN format('operation %s failed; a failed call found no one', p_operation_id); END IF;
  IF op.provider IS DISTINCT FROM p_source THEN RETURN format('operation %s is %s, not %s', p_operation_id, op.provider, p_source); END IF;
  IF op.business_id IS DISTINCT FROM p_business_id THEN RETURN format('operation %s looked up another business', p_operation_id); END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION contact_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE path text; why text;
BEGIN
  path := scopely.jsonb_secret_path(NEW.provider_record);
  IF path IS NOT NULL THEN
    RAISE EXCEPTION 'SECRET: provider record % looks like a credential', path USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.observed_at IS NOT NULL AND NEW.observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'TRUTH_RULE: a contact cannot be observed in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_operation_id IS NOT NULL
     AND (NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id OR NEW.provider_record IS DISTINCT FROM OLD.provider_record
          OR NEW.provider_person_ref IS DISTINCT FROM OLD.provider_person_ref OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
          OR NEW.source IS DISTINCT FROM OLD.source OR NEW.business_id IS DISTINCT FROM OLD.business_id) THEN
    RAISE EXCEPTION 'PROVIDER: where a person came from cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_operation_id IS NULL AND NEW.provider_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROVIDER: a person a seller recorded cannot be re-attributed to a provider' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider_operation_id IS NOT NULL THEN
    why := scopely.prospect_operation_blocker(NEW.provider_operation_id, NEW.source, NEW.business_id);
    IF why IS NOT NULL THEN RAISE EXCEPTION 'PROVIDER: %', why USING ERRCODE = 'check_violation'; END IF;
    -- A provider returning a person is not verification, a relationship, a decision or a lawful basis.
    IF TG_OP = 'INSERT' AND (NEW.label <> 'UNVERIFIED' OR NEW.is_decision_maker OR NEW.relationship IS NOT NULL
                             OR NEW.outreach_basis IS DISTINCT FROM 'unknown' OR NEW.mx_ok IS NOT NULL) THEN
      RAISE EXCEPTION 'TRUTH_RULE: a person a provider returned is UNVERIFIED, not a decision maker, with no relationship, outreach basis unknown and no mailbox check'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Only a person raises a provider person's label, and says how.
    IF TG_OP = 'UPDATE' AND NEW.label IS DISTINCT FROM OLD.label AND NEW.label <> 'UNVERIFIED'
       AND (btrim(coalesce(NEW.verified_by, '')) = '' OR btrim(coalesce(NEW.verification_basis, '')) = '') THEN
      RAISE EXCEPTION 'TRUTH_RULE: a provider''s person is % only when a person records who checked it and how', NEW.label
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_provenance_guard BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION contact_provenance_guard();

-- ------------------------------------------------------------------ 3. contact facts

CREATE TABLE contact_facts (
  id                     bigserial PRIMARY KEY,
  workspace_id           bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id            bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id             bigint REFERENCES contacts(id) ON DELETE CASCADE,       -- NULL: the business's own channel
  kind                   text NOT NULL CHECK (kind IN ('title','email','phone','whatsapp','linkedin','instagram','x','contact_page')),
  value                  text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 500),
  source                 text NOT NULL CHECK (btrim(source) <> '' AND length(source) <= 120),
  source_url             text CHECK (source_url IS NULL OR (source_url ~* '^https?://' AND length(source_url) <= 500)),
  observed_at            timestamptz NOT NULL,
  label                  text NOT NULL CHECK (label IN ('VERIFIED','PUBLICLY_FOUND','UNVERIFIED')),
  confidence             text CHECK (confidence IN ('HIGH','MEDIUM','LOW')),    -- as the source stated it; NULL = not stated
  provider_operation_id  bigint REFERENCES provider_operations(id),
  recorded_by            text CHECK (recorded_by IS NULL OR (btrim(recorded_by) <> '' AND length(recorded_by) <= 120)),
  verification_basis     text CHECK (verification_basis IS NULL OR length(verification_basis) <= 500),
  verified_by            text CHECK (verified_by IS NULL OR length(verified_by) <= 120),
  verified_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- Every fact came from exactly one place: a provider call, or a person who recorded it.
  CHECK ((provider_operation_id IS NULL) <> (recorded_by IS NULL)),
  CHECK (label = 'UNVERIFIED' OR (btrim(coalesce(verification_basis, '')) <> '' AND btrim(coalesce(verified_by, '')) <> '' AND verified_at IS NOT NULL)),
  CHECK (kind <> 'title' OR contact_id IS NOT NULL),
  CHECK (kind NOT IN ('linkedin','instagram','x','contact_page') OR value ~* '^https?://'),
  CHECK (kind <> 'email' OR value ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CHECK (kind NOT IN ('phone','whatsapp') OR value ~ '^\+?[0-9]{6,15}$')
);
-- The same source reporting the same value again is the same fact.
CREATE UNIQUE INDEX contact_facts_uq ON contact_facts (workspace_id, business_id, coalesce(contact_id, 0), kind, lower(value), lower(source));
CREATE INDEX contact_facts_business_idx ON contact_facts (business_id);

CREATE FUNCTION contact_fact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cb bigint; why text;
BEGIN
  IF NEW.observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'TRUTH_RULE: a fact cannot be observed in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    SELECT business_id INTO cb FROM scopely.contacts WHERE id = NEW.contact_id;
    IF FOUND AND cb <> NEW.business_id THEN
      RAISE EXCEPTION 'PROSPECT: contact % belongs to another business', NEW.contact_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.business_id, NEW.contact_id, NEW.kind, NEW.value, NEW.source, NEW.source_url, NEW.observed_at,
                           NEW.provider_operation_id, NEW.recorded_by, NEW.confidence)
                          IS DISTINCT FROM (OLD.business_id, OLD.contact_id, OLD.kind, OLD.value, OLD.source, OLD.source_url, OLD.observed_at,
                           OLD.provider_operation_id, OLD.recorded_by, OLD.confidence) THEN
    RAISE EXCEPTION 'PROSPECT: a fact is what its source said; record a new fact instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider_operation_id IS NOT NULL THEN
    why := scopely.prospect_operation_blocker(NEW.provider_operation_id, NEW.source, NEW.business_id);
    IF why IS NOT NULL THEN RAISE EXCEPTION 'PROVIDER: %', why USING ERRCODE = 'check_violation'; END IF;
    IF TG_OP = 'INSERT' AND NEW.label <> 'UNVERIFIED' THEN
      RAISE EXCEPTION 'TRUTH_RULE: a fact a provider returned is UNVERIFIED until a person checks it' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_fact_guard BEFORE INSERT OR UPDATE ON contact_facts
  FOR EACH ROW EXECUTE FUNCTION contact_fact_guard();

CREATE FUNCTION contact_fact_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PROSPECT: contact facts are never deleted on their own' USING ERRCODE = 'check_violation';
END $$;
-- Deleting a workspace, business or contact still cascades; a single fact cannot be removed.
CREATE TRIGGER contact_fact_no_delete BEFORE DELETE ON contact_facts
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION contact_fact_no_delete();

CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON contact_facts
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','contact_id','contacts','provider_operation_id','provider_operations');
ALTER TABLE contact_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON contact_facts USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());
