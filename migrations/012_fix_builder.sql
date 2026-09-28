-- 012_fix_builder: the first Fix Builder (Slice 7): a Website Fix Sprint for a broken contact link.
--
-- Decisions F1 to F4 (DECISIONS A21 to A24):
--   F1  The first fix kind is website_fix, limited to the VALIDATED findings of check.contact_links
--       (E-TEL-BROKEN, E-WA-BROKEN, E-LINK-TARGET-MISMATCH, E-EMAIL-INVALID). The list is read from
--       the rule and issue data, not repeated here.
--   F2  A FIX build may read the page captured into its own project. The BuildContext still carries
--       no page HTML; a fix agent reads the capture file named by its run.
--   F3  The page is captured locally into project storage (captures/), with its hash. The capture is
--       proof material: it never changes and it is never the source of truth. The structured evidence is.
--   F4  Every corrected value is supplied and then explicitly confirmed by a person. A fix version
--       cannot be approved or shown until each corrected value it uses is confirmed and still stands.
--
-- Three owned tables, each with the workspace guard and row-level security:
--   fix_captures            one capture of the page an evidence row was observed on
--   fix_corrections         a person's corrected destination for one broken link, and its confirmation
--   build_fix_corrections   which corrections a fix version applied
--
-- Nothing here changes an existing row or an existing website build. The approve and show gates
-- gain one reason, only for versions of a Fix Builder project (a website_fix project with a capture).

SET search_path = scopely;

-- ------------------------------------------------------------------ what the Fix Builder supports

-- True for an issue code the Fix Builder may repair: an issue of the VALIDATED contact-link check
-- that is itself VALIDATED. HYPOTHESIS codes and every other check stay out (F1).
CREATE FUNCTION fix_supported_issue_code(p_code text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM scopely.rule_versions r JOIN scopely.issue_codes ic ON ic.code = p_code
     WHERE r.rule_key = 'check.contact_links' AND r.validation_status = 'VALIDATED'
       AND ic.validation_status = 'VALIDATED' AND ic.kind = 'issue'
       AND (r.definition -> 'issue_codes') ? p_code)
$$;

-- Which kind of destination may repair which finding. A malformed phone link is repaired with a
-- phone number, a malformed WhatsApp link with a WhatsApp number, an unreachable email with an
-- email address. A label that opens the wrong channel may be pointed at any of the three.
CREATE FUNCTION fix_channel_allowed(p_code text, p_channel text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_code
    WHEN 'E-TEL-BROKEN' THEN p_channel = 'phone'
    WHEN 'E-WA-BROKEN' THEN p_channel = 'whatsapp'
    WHEN 'E-EMAIL-INVALID' THEN p_channel = 'email'
    WHEN 'E-LINK-TARGET-MISMATCH' THEN p_channel IN ('phone', 'whatsapp', 'email')
    ELSE false END
$$;

-- ------------------------------------------------------------------ captures

CREATE TABLE fix_captures (
  id                bigserial PRIMARY KEY,
  workspace_id      bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id        bigint NOT NULL REFERENCES build_projects(id) ON DELETE CASCADE,
  evidence_id       bigint NOT NULL REFERENCES evidence(id),
  requested_url     text NOT NULL CHECK (requested_url ~ '^https?://'),
  final_url         text NOT NULL CHECK (final_url ~ '^https?://'),
  http_status       integer NOT NULL CHECK (http_status BETWEEN 200 AND 299),
  content_type      text NOT NULL CHECK (btrim(content_type) <> ''),
  storage_ref       text NOT NULL,
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size         integer NOT NULL CHECK (byte_size > 0),
  -- The broken destination as observed (the evidence's observation href), and how many links on the
  -- captured page carry it. Zero means the page no longer shows the link: nothing can be fixed from it.
  observed_href     text NOT NULL CHECK (btrim(observed_href) <> ''),
  href_occurrences  integer NOT NULL CHECK (href_occurrences >= 0),
  captured_at       timestamptz NOT NULL DEFAULT now(),
  captured_by       text NOT NULL CHECK (btrim(captured_by) <> '')     -- free text until B10
);
CREATE INDEX fix_captures_project_idx ON fix_captures (project_id, evidence_id, id);

CREATE FUNCTION fix_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; e record; reason text;
BEGIN
  IF scopely.current_actor_kind() = 'build_agent' THEN
    RAISE EXCEPTION 'GATE: a build agent cannot record a page capture' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'FIX: a capture is proof material and never changes; take a new capture' USING ERRCODE = 'check_violation';
  END IF;
  SELECT bp.build_kind, bp.opportunity_id INTO p FROM scopely.build_projects bp WHERE bp.id = NEW.project_id;
  IF p.build_kind IS DISTINCT FROM 'website_fix' THEN
    RAISE EXCEPTION 'FIX: only a website_fix project captures a page' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ev.issue_code, ev.claim_state, ev.recheck_result, o.href INTO e
    FROM scopely.evidence ev JOIN scopely.observations o ON o.id = ev.observation_id
   WHERE ev.id = NEW.evidence_id;
  IF NOT EXISTS (SELECT 1 FROM scopely.opportunity_evidence WHERE opportunity_id = p.opportunity_id AND evidence_id = NEW.evidence_id) THEN
    RAISE EXCEPTION 'FIX: evidence % is not part of the project''s opportunity', NEW.evidence_id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT scopely.fix_supported_issue_code(e.issue_code) THEN
    RAISE EXCEPTION 'FIX: % is not a finding the Fix Builder repairs', e.issue_code USING ERRCODE = 'check_violation';
  END IF;
  IF e.claim_state <> 'OBSERVED' THEN
    RAISE EXCEPTION 'FIX: only an OBSERVED finding is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF e.recheck_result IN ('changed', 'gone') THEN
    RAISE EXCEPTION 'FIX: evidence % was re-checked as % and no longer holds', NEW.evidence_id, e.recheck_result USING ERRCODE = 'check_violation';
  END IF;
  IF e.href IS NULL OR NEW.observed_href IS DISTINCT FROM e.href THEN
    RAISE EXCEPTION 'FIX: a capture records the destination that was observed, not another one' USING ERRCODE = 'check_violation';
  END IF;
  reason := scopely.project_storage_blocker(NEW.storage_ref, NEW.workspace_id, NEW.project_id, 'captures/');
  IF reason IS NOT NULL THEN
    RAISE EXCEPTION 'STORAGE: %', reason USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fix_capture_guard BEFORE INSERT OR UPDATE ON fix_captures
  FOR EACH ROW EXECUTE FUNCTION fix_capture_guard();

-- ------------------------------------------------------------------ corrections

CREATE TABLE fix_corrections (
  id              bigserial PRIMARY KEY,
  workspace_id    bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      bigint NOT NULL REFERENCES build_projects(id) ON DELETE CASCADE,
  evidence_id     bigint NOT NULL REFERENCES evidence(id),
  capture_id      bigint NOT NULL REFERENCES fix_captures(id),
  channel         text NOT NULL CHECK (channel IN ('phone', 'whatsapp', 'email')),
  corrected_href  text NOT NULL,
  proposed_by     text NOT NULL CHECK (btrim(proposed_by) <> ''),     -- free text until B10
  proposed_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by    text CHECK (confirmed_by IS NULL OR btrim(confirmed_by) <> ''),
  confirmed_at    timestamptz,
  withdrawn_at    timestamptz,
  CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  CHECK (confirmed_at IS NULL OR confirmed_at >= proposed_at),
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= proposed_at),
  CHECK ((channel = 'phone' AND corrected_href ~ '^tel:\+[1-9][0-9]{6,14}$')
      OR (channel = 'whatsapp' AND corrected_href ~ '^https://wa\.me/[1-9][0-9]{7,14}$')
      OR (channel = 'email' AND corrected_href ~ '^mailto:[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$'))
);
-- One standing correction per finding in a project; a new value withdraws the old one.
CREATE UNIQUE INDEX fix_corrections_active_idx ON fix_corrections (project_id, evidence_id) WHERE withdrawn_at IS NULL;

CREATE FUNCTION fix_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; code text;
BEGIN
  IF scopely.current_actor_kind() = 'build_agent' THEN
    RAISE EXCEPTION 'GATE: a build agent cannot supply or confirm a corrected value; a person does' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT project_id, evidence_id, observed_href, href_occurrences INTO c FROM scopely.fix_captures WHERE id = NEW.capture_id;
    IF c.project_id IS DISTINCT FROM NEW.project_id OR c.evidence_id IS DISTINCT FROM NEW.evidence_id THEN
      RAISE EXCEPTION 'FIX: capture % is not a capture of this project''s evidence %', NEW.capture_id, NEW.evidence_id USING ERRCODE = 'check_violation';
    END IF;
    IF c.href_occurrences = 0 THEN
      RAISE EXCEPTION 'FIX: the captured page does not show the observed link, so there is nothing to correct on it' USING ERRCODE = 'check_violation';
    END IF;
    SELECT issue_code INTO code FROM scopely.evidence WHERE id = NEW.evidence_id;
    IF NOT scopely.fix_channel_allowed(code, NEW.channel) THEN
      RAISE EXCEPTION 'FIX: a % destination does not repair %', NEW.channel, code USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.corrected_href = c.observed_href THEN
      RAISE EXCEPTION 'FIX: the corrected destination is the broken one' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.confirmed_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'FIX: a corrected value starts unconfirmed; a person confirms it after seeing the fix' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'confirmed_by' - 'confirmed_at' - 'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD) - 'confirmed_by' - 'confirmed_at' - 'withdrawn_at') THEN
    RAISE EXCEPTION 'FIX: a corrected value never changes; propose a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by) THEN
    RAISE EXCEPTION 'FIX: a confirmation stands; propose a new value instead' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    RAISE EXCEPTION 'FIX: a withdrawn corrected value stays withdrawn' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL AND NEW.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIX: a withdrawn corrected value cannot be confirmed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fix_correction_guard BEFORE INSERT OR UPDATE ON fix_corrections
  FOR EACH ROW EXECUTE FUNCTION fix_correction_guard();

-- ------------------------------------------------------------------ what a version applied

CREATE TABLE build_fix_corrections (
  workspace_id   bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  build_id       bigint NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  correction_id  bigint NOT NULL REFERENCES fix_corrections(id),
  PRIMARY KEY (build_id, correction_id)
);

CREATE FUNCTION build_fix_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; c record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'FIX: what a version applied never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM scopely.builds WHERE id = OLD.build_id AND approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FIX: what an approved version applied never changes' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT project_id, build_kind, approved_at INTO b FROM scopely.builds WHERE id = NEW.build_id;
  SELECT project_id, withdrawn_at INTO c FROM scopely.fix_corrections WHERE id = NEW.correction_id;
  IF b.build_kind IS DISTINCT FROM 'website_fix' OR b.project_id IS DISTINCT FROM c.project_id THEN
    RAISE EXCEPTION 'FIX: correction % is not part of build %''s project', NEW.correction_id, NEW.build_id USING ERRCODE = 'check_violation';
  END IF;
  IF b.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIX: what an approved version applied never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF c.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIX: correction % was withdrawn', NEW.correction_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_fix_correction_guard BEFORE INSERT OR UPDATE OR DELETE ON build_fix_corrections
  FOR EACH ROW EXECUTE FUNCTION build_fix_correction_guard();

-- ------------------------------------------------------------------ the fix gate (F4)

-- Why a version of a Fix Builder project cannot be approved or shown on its corrected values, or
-- NULL. NULL for every other build, so website builds and earlier website_fix builds are unchanged.
-- Takes the build's kind and project rather than reading the row, so the BEFORE INSERT gate can ask
-- it about a row that does not exist yet (and so has no corrected value linked to it).
CREATE FUNCTION fix_version_blocker(p_build_id bigint, p_kind text, p_project_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_kind IS DISTINCT FROM 'website_fix' OR p_project_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM scopely.fix_captures WHERE project_id = p_project_id) THEN
    RETURN NULL;
  END IF;
  IF p_build_id IS NULL OR NOT EXISTS (SELECT 1 FROM scopely.build_fix_corrections WHERE build_id = p_build_id) THEN
    RETURN 'applies no corrected value';
  END IF;
  IF EXISTS (SELECT 1 FROM scopely.build_fix_corrections l JOIN scopely.fix_corrections c ON c.id = l.correction_id
              WHERE l.build_id = p_build_id AND c.withdrawn_at IS NOT NULL) THEN
    RETURN 'uses a corrected value that was withdrawn';
  END IF;
  IF EXISTS (SELECT 1 FROM scopely.build_fix_corrections l JOIN scopely.fix_corrections c ON c.id = l.correction_id
              WHERE l.build_id = p_build_id AND c.confirmed_at IS NULL) THEN
    RETURN 'needs a person to confirm the corrected value';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION fix_build_blocker(p_build_id bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT scopely.fix_version_blocker(b.id, b.build_kind, b.project_id) FROM scopely.builds b WHERE b.id = p_build_id
$$;

CREATE FUNCTION build_fix_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reason text;
BEGIN
  IF NEW.build_kind <> 'website_fix' THEN RETURN NEW; END IF;
  IF (NEW.approved_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.approved_at IS NULL))
     OR (NEW.shown_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.shown_at IS NULL)) THEN
    reason := scopely.fix_version_blocker(CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE NEW.id END, NEW.build_kind, NEW.project_id);
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION 'FIX: this fix version %', reason USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- After build_version_guard, which fills in project_id for a new version.
CREATE TRIGGER build_version_zz_fix_gate BEFORE INSERT OR UPDATE ON builds
  FOR EACH ROW EXECUTE FUNCTION build_fix_gate();

-- The API's gate reasons gain the fix reason, in the order a person meets them. Bodies are 009's,
-- with one added line each.
CREATE OR REPLACE FUNCTION build_show_blocker(p_build_id bigint, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE b record; ids bigint[]; successor bigint; fix text;
BEGIN
  SELECT * INTO b FROM scopely.builds WHERE id = p_build_id;
  IF NOT FOUND THEN RETURN format('build %s does not exist', p_build_id); END IF;
  IF b.purpose <> 'DEMO' THEN RETURN 'a DELIVERY build is delivered, not shown as a pitch'; END IF;
  IF b.status = 'SHOWN' THEN RETURN 'already shown'; END IF;
  IF b.status = 'SUPERSEDED' THEN
    SELECT id INTO successor FROM scopely.builds WHERE supersedes_build_id = b.id;
    RETURN format('superseded by build %s', coalesce(successor::text, 'unknown'));
  END IF;
  IF b.status = 'DISCARDED' THEN RETURN 'discarded'; END IF;
  fix := scopely.fix_build_blocker(b.id);
  IF fix IS NOT NULL THEN RETURN fix; END IF;
  IF b.approved_at IS NULL THEN RETURN 'needs a recorded human approval'; END IF;
  IF p_at < b.approved_at THEN RETURN 'cannot be shown before it was approved'; END IF;
  SELECT array_agg(evidence_id ORDER BY evidence_id) INTO ids FROM scopely.build_evidence WHERE build_id = b.id;
  IF ids IS NULL THEN RETURN 'cites no evidence'; END IF;
  RETURN scopely.evidence_send_blocker(ids, p_at);
END $$;

CREATE OR REPLACE FUNCTION build_approve_blocker(p_build_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM scopely.builds WHERE id = p_build_id;
  IF NOT FOUND THEN RETURN format('build %s does not exist', p_build_id); END IF;
  IF b.status <> 'DRAFT' THEN RETURN format('build is %s, not DRAFT', b.status); END IF;
  IF b.artifact_ref IS NULL THEN RETURN 'has no artifact to approve'; END IF;
  IF NOT EXISTS (SELECT 1 FROM scopely.build_evidence WHERE build_id = b.id) THEN RETURN 'cites no evidence'; END IF;
  RETURN scopely.fix_build_blocker(b.id);
END $$;

-- ------------------------------------------------------------------ ownership and isolation

CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON fix_captures
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('project_id','build_projects','evidence_id','evidence');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON fix_corrections
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('project_id','build_projects','evidence_id','evidence','capture_id','fix_captures');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON build_fix_corrections
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('build_id','builds','correction_id','fix_corrections');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fix_captures','fix_corrections','build_fix_corrections'] LOOP
    EXECUTE format('ALTER TABLE scopely.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_isolation ON scopely.%I USING (workspace_id = scopely.current_workspace_id())
                    WITH CHECK (workspace_id = scopely.current_workspace_id())', t);
  END LOOP;
END $$;
