-- 009_build_workspace: the Build Workspace foundation. Data, guards and seams only; nothing here
-- calls a model, runs an agent, stores a secret, stores source files or deploys anything.
--
-- OPPORTUNITY -> BUILD PROJECT -> BUILD VERSION -> BUILD RUN -> BUILD AGENT -> MODEL PROVIDER
--
-- 1. build_projects: one build effort for one mapped opportunity and one build kind. It owns the
--    versions of that effort. Existing builds are backfilled: one project per supersedes chain.
-- 2. Build versions are the existing builds rows, extended with project_id and version_no (unique
--    within the project). A version has at most one successor, and superseding a version marks it
--    SUPERSEDED. A DELIVERY version names the DEMO it continues (delivery_of_build_id). A version's
--    purpose never changes. Every existing DEMO / DELIVERY / approval / show / re-check rule holds.
-- 3. build_runs: one attempt by a build agent to produce (or modify) a version. Its state
--    (QUEUED / RUNNING / SUCCEEDED / FAILED / CANCELLED) is separate from the version's human
--    lifecycle (DRAFT / APPROVED / SHOWN / DISCARDED / SUPERSEDED). A run can produce a DRAFT
--    version and nothing else: it holds no approval, show or delivery column, and while the
--    request acts as a build agent the database refuses every human gate.
-- 4. provider_connections: which model provider a workspace uses and in which mode
--    (SCOPELY_MANAGED or CUSTOMER_KEY). credential_ref is a pointer into a future secret store and
--    never the key. Whether a user may own a connection is open decision B14; today every
--    connection is workspace-owned, and a user owner can be added as a nullable column later.
-- 5. Project storage boundary: a version's manifest_ref and a project asset's storage_ref must lie
--    inside that workspace's own project prefix, workspaces/<workspace>/projects/<project>/.
--    No file bytes are stored in Postgres and no URL is invented.
-- 6. cost_events say who pays (billed_to SCOPELY or WORKSPACE), which provider and connection were
--    used, and which build run incurred them. A workspace-billed cost carries no Scopely credits.
--    Payer is NULL where it was never recorded (every row before this migration).
-- 7. No raw secret: credential-like values are refused in credential_ref, run and cost metadata,
--    requirements and asset descriptions.
-- 8. Every new table has workspace_id, a00_workspace_guard and a workspace_isolation RLS policy.

SET search_path = scopely;

-- ------------------------------------------------------------------ 7. secret detection

-- True when a string looks like a credential: a known API-key or token shape, a bearer header or a
-- private key block. Used to refuse secrets in columns that must only ever hold references.
CREATE FUNCTION looks_like_secret(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT v IS NOT NULL AND (
       v ~* '(^|[^a-z0-9])(sk-[a-z0-9_-]{8,}|sk_(live|test)_[a-z0-9]{8,}|rk_(live|test)_[a-z0-9]{8,}|xox[abprs]-[a-z0-9-]{8,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{16,}|ya29\.[a-z0-9_-]{16,})'
    OR v ~ '(^|[^A-Za-z0-9])(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})'
    OR v ~* 'bearer\s+[a-z0-9._~+/-]{16,}'
    OR v ~ '-----BEGIN [A-Z ]*PRIVATE KEY-----')
$$;

-- A metadata key that names a credential. credential_ref and token counts are references and
-- measurements, not credentials.
CREATE FUNCTION is_secret_key_name(k text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT k ~* '(api[_-]?key|secret|password|passwd|private[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|session[_-]?token|oauth[_-]?token)'
      OR k ~* '^(token|key|credential|credentials|auth)$'
$$;

-- The path of the first credential-like key or value in a JSON document, or NULL.
CREATE FUNCTION jsonb_secret_path(j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  WITH RECURSIVE walk(path, key, val) AS (
    SELECT '$'::text, NULL::text, j
    UNION ALL
    SELECT c.path, c.key, c.val FROM walk w CROSS JOIN LATERAL (
      SELECT w.path || '.' || e.key AS path, e.key, e.value AS val
        FROM jsonb_each(CASE WHEN jsonb_typeof(w.val) = 'object' THEN w.val ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT w.path || '[' || (a.ord - 1) || ']', NULL, a.value
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.val) = 'array' THEN w.val ELSE '[]'::jsonb END) WITH ORDINALITY a(value, ord)
    ) c
  )
  SELECT path FROM walk
   WHERE (key IS NOT NULL AND scopely.is_secret_key_name(key))
      OR (jsonb_typeof(val) = 'string' AND scopely.looks_like_secret(val #>> '{}'))
   ORDER BY path LIMIT 1
$$;

-- ------------------------------------------------------------------ 5. project storage boundary

-- Where a project's files will live in future object storage. A key, not a URL: nothing is stored
-- there yet and no address is invented.
CREATE FUNCTION project_storage_prefix(p_workspace_id bigint, p_project_id bigint) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT format('workspaces/%s/projects/%s/', p_workspace_id, p_project_id)
$$;

-- The reason a storage key is not inside the project's own prefix (under `sub`), or NULL.
CREATE FUNCTION project_storage_blocker(p_ref text, p_workspace_id bigint, p_project_id bigint, p_sub text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_ref IS NULL THEN NULL
    WHEN p_ref !~ '^workspaces/[0-9]+/projects/[0-9]+/[A-Za-z0-9._/-]+$' OR p_ref ~ '(^|/)\.\.?(/|$)' OR p_ref ~ '//'
      THEN format('%s is not a project storage key', p_ref)
    WHEN NOT starts_with(p_ref, scopely.project_storage_prefix(p_workspace_id, p_project_id) || p_sub)
      THEN format('%s is outside this project''s storage (%s%s)', p_ref, scopely.project_storage_prefix(p_workspace_id, p_project_id), p_sub)
  END
$$;

-- ------------------------------------------------------------------ actor kind

-- Who the current request acts as. 'person' unless a build-agent executor says otherwise for the
-- writes it makes on an agent's behalf (scopely.actor_kind = 'build_agent'). Authenticated user ids
-- are open decision B10; this only separates an agent's writes from a person's.
CREATE FUNCTION current_actor_kind() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(current_setting('scopely.actor_kind', true), ''), 'person')
$$;

-- A user named on a row must be a member of that row's workspace. SECURITY DEFINER so the check
-- sees memberships even when row-level security would hide them.
CREATE FUNCTION workspace_member_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = scopely, pg_temp AS $$
DECLARE col text := TG_ARGV[0]; uid bigint;
BEGIN
  uid := (to_jsonb(NEW) ->> col)::bigint;
  IF uid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM scopely.workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = uid) THEN
    RAISE EXCEPTION 'WORKSPACE: user % is not a member of workspace %', uid, NEW.workspace_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ------------------------------------------------------------------ 4. provider connections

CREATE TABLE provider_connections (
  id                  bigserial PRIMARY KEY,
  workspace_id        bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$'),   -- data, e.g. 'anthropic'; not an enum
  mode                text NOT NULL CHECK (mode IN ('SCOPELY_MANAGED','CUSTOMER_KEY')),
  credential_ref      text,                                                        -- pointer into a secret store, never the key
  state               text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','ACTIVE','REVOKED','ERROR')),
  scopes              text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['build','analysis']),
  display_name        text CHECK (display_name IS NULL OR btrim(display_name) <> ''),
  created_by_user_id  bigint REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  activated_at        timestamptz,
  revoked_at          timestamptz,
  -- Scopely's own provider credentials never live in a workspace row.
  CHECK (mode = 'CUSTOMER_KEY' OR credential_ref IS NULL),
  CHECK (mode <> 'CUSTOMER_KEY' OR state <> 'ACTIVE' OR credential_ref IS NOT NULL),
  CHECK (state <> 'ACTIVE' OR activated_at IS NOT NULL),
  CHECK (state <> 'REVOKED' OR revoked_at IS NOT NULL)
);
CREATE INDEX provider_connections_workspace_idx ON provider_connections (workspace_id, provider);

-- credential_ref names a secret of this workspace: secretref:ws/<workspace>/<name>. The name is a
-- short lowercase label, so a pasted key cannot be stored as a reference.
CREATE FUNCTION provider_connection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_ref IS NOT NULL THEN
    IF scopely.looks_like_secret(NEW.credential_ref) THEN
      RAISE EXCEPTION 'SECRET: credential_ref holds what looks like a credential; store a reference, never the key'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.credential_ref !~ ('^secretref:ws/' || NEW.workspace_id || '/[a-z0-9][a-z0-9_-]{0,62}$') THEN
      RAISE EXCEPTION 'SECRET: credential_ref must be secretref:ws/%/<name> in this workspace''s secret namespace', NEW.workspace_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.mode IS DISTINCT FROM OLD.mode THEN
      RAISE EXCEPTION 'PROVIDER: a connection''s provider and mode cannot change; create a new connection' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'REVOKED' AND (NEW.state <> 'REVOKED' OR NEW.credential_ref IS DISTINCT FROM OLD.credential_ref) THEN
      RAISE EXCEPTION 'PROVIDER: a revoked connection is final' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_connection_guard BEFORE INSERT OR UPDATE ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION provider_connection_guard();

-- ------------------------------------------------------------------ 1. build projects

CREATE TABLE build_projects (
  id                  bigserial PRIMARY KEY,
  workspace_id        bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id      bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  build_kind          text NOT NULL REFERENCES build_kinds(key),
  title               text NOT NULL CHECK (btrim(title) <> ''),
  created_by_user_id  bigint REFERENCES users(id),     -- unauthenticated until B10
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX build_projects_opportunity_idx ON build_projects (opportunity_id);

-- A project builds its opportunity's mapped service, and never moves to another opportunity or kind.
CREATE FUNCTION build_project_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opp record;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id OR NEW.build_kind IS DISTINCT FROM OLD.build_kind) THEN
    RAISE EXCEPTION 'BUILD: a project cannot change its opportunity or build kind' USING ERRCODE = 'check_violation';
  END IF;
  SELECT o.mapping_status, ci.build_kind INTO opp
    FROM scopely.opportunities o LEFT JOIN scopely.catalog_items ci ON ci.id = o.catalog_item_id WHERE o.id = NEW.opportunity_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF opp.mapping_status <> 'MAPPED' OR opp.build_kind IS DISTINCT FROM NEW.build_kind THEN
    RAISE EXCEPTION 'BUILD: a project must build its opportunity''s mapped service (%), not %', coalesce(opp.build_kind, 'nothing'), NEW.build_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_project_guard BEFORE INSERT OR UPDATE ON build_projects
  FOR EACH ROW EXECUTE FUNCTION build_project_guard();

-- What the seller or client asked for, in their words. Withdrawn, never edited.
CREATE TABLE build_requirements (
  id            bigserial PRIMARY KEY,
  workspace_id  bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    bigint NOT NULL REFERENCES build_projects(id) ON DELETE CASCADE,
  requirement   text NOT NULL CHECK (btrim(requirement) <> ''),
  source        text NOT NULL CHECK (source IN ('seller','client')),
  recorded_by   text NOT NULL CHECK (btrim(recorded_by) <> ''),   -- free text until B10
  created_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz
);
CREATE INDEX build_requirements_project_idx ON build_requirements (project_id);

-- A file the seller or client supplied for the project. Its bytes live in the project's storage;
-- only the key and hash are here.
CREATE TABLE build_assets (
  id            bigserial PRIMARY KEY,
  workspace_id  bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    bigint NOT NULL REFERENCES build_projects(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('logo','image','copy','brand','document','other')),
  storage_ref   text NOT NULL,
  sha256        text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  description   text NOT NULL CHECK (btrim(description) <> ''),
  provided_by   text NOT NULL CHECK (provided_by IN ('seller','client')),
  recorded_by   text NOT NULL CHECK (btrim(recorded_by) <> ''),   -- free text until B10
  created_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz
);
CREATE INDEX build_assets_project_idx ON build_assets (project_id);

CREATE FUNCTION build_input_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reason text; txt text;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD) - 'withdrawn_at') THEN
    RAISE EXCEPTION 'BUILD: a % row is withdrawn, never edited', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    RAISE EXCEPTION 'BUILD: a withdrawn % row stays withdrawn', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  txt := CASE TG_TABLE_NAME WHEN 'build_requirements' THEN to_jsonb(NEW) ->> 'requirement' ELSE to_jsonb(NEW) ->> 'description' END;
  IF scopely.looks_like_secret(txt) THEN
    RAISE EXCEPTION 'SECRET: this % contains what looks like a credential; build-time and runtime secrets never go in project data', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'build_assets' THEN
    reason := scopely.project_storage_blocker(to_jsonb(NEW) ->> 'storage_ref', NEW.workspace_id, NEW.project_id, 'assets/');
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION 'STORAGE: %', reason USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_input_guard BEFORE INSERT OR UPDATE ON build_requirements
  FOR EACH ROW EXECUTE FUNCTION build_input_guard();
CREATE TRIGGER build_input_guard BEFORE INSERT OR UPDATE ON build_assets
  FOR EACH ROW EXECUTE FUNCTION build_input_guard();

-- ------------------------------------------------------------------ 2. build versions

ALTER TABLE builds
  ADD COLUMN project_id           bigint REFERENCES build_projects(id) ON DELETE CASCADE,
  ADD COLUMN version_no           integer CHECK (version_no > 0),
  ADD COLUMN delivery_of_build_id bigint REFERENCES builds(id),
  ADD COLUMN manifest_ref         text,          -- key of the version's project manifest in future storage
  ADD COLUMN manifest_sha256      text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT builds_delivery_of_check CHECK (delivery_of_build_id IS NULL OR purpose = 'DELIVERY'),
  ADD CONSTRAINT builds_manifest_sha_check CHECK (manifest_sha256 IS NULL OR manifest_ref IS NOT NULL);

-- Backfill: one project per existing supersedes chain, versions numbered along the chain, and a
-- version that already has a successor marked SUPERSEDED. A chain that branches (two builds
-- superseding the same build) cannot be numbered without choosing between them, so the upgrade
-- stops and names it rather than guessing. Guard triggers are paused for this backfill only,
-- because it changes nothing but the new columns and the status of superseded versions.
DO $$
DECLARE r record; pid bigint; branched bigint;
BEGIN
  SELECT supersedes_build_id INTO branched FROM scopely.builds WHERE supersedes_build_id IS NOT NULL
   GROUP BY supersedes_build_id HAVING count(*) > 1 ORDER BY 1 LIMIT 1;
  IF branched IS NOT NULL THEN
    RAISE EXCEPTION 'MIGRATION 009: build % has more than one successor; resolve the branch before upgrading', branched;
  END IF;
  ALTER TABLE scopely.builds DISABLE TRIGGER USER;
  FOR r IN SELECT id, workspace_id, opportunity_id, build_kind, title, created_at FROM scopely.builds
            WHERE supersedes_build_id IS NULL ORDER BY id LOOP
    INSERT INTO scopely.build_projects (workspace_id, opportunity_id, build_kind, title, created_at)
    VALUES (r.workspace_id, r.opportunity_id, r.build_kind, r.title, r.created_at) RETURNING id INTO pid;
    WITH RECURSIVE chain(id, n) AS (
      SELECT r.id, 1
      UNION ALL
      SELECT b.id, c.n + 1 FROM scopely.builds b JOIN chain c ON b.supersedes_build_id = c.id
    )
    UPDATE scopely.builds b SET project_id = pid, version_no = chain.n FROM chain WHERE b.id = chain.id;
  END LOOP;
  UPDATE scopely.builds p SET status = 'SUPERSEDED'
   WHERE p.status NOT IN ('SUPERSEDED','DISCARDED')
     AND EXISTS (SELECT 1 FROM scopely.builds c WHERE c.supersedes_build_id = p.id);
  ALTER TABLE scopely.builds ENABLE TRIGGER USER;
END $$;

ALTER TABLE builds ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE builds ALTER COLUMN version_no SET NOT NULL;
ALTER TABLE builds ADD CONSTRAINT builds_project_version_key UNIQUE (project_id, version_no);
CREATE UNIQUE INDEX builds_one_successor_uq ON builds (supersedes_build_id) WHERE supersedes_build_id IS NOT NULL;
CREATE INDEX builds_delivery_of_idx ON builds (delivery_of_build_id) WHERE delivery_of_build_id IS NOT NULL;

-- Versioning rules. Runs after build_guard (alphabetical), so its opportunity, catalog, DEMO/DELIVERY,
-- approval and re-check rules report first. A new version with no project continues the project
-- of the version it supersedes or the demo it delivers, or opens a new project; with no number it
-- takes the next one.
CREATE FUNCTION build_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record; demo record; proj record; reason text; manifest_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
      RAISE EXCEPTION 'BUILD: a version cannot change its project or number' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
      RAISE EXCEPTION 'BUILD: a version''s purpose cannot change; a DELIVERY is a new version that names its DEMO (delivery_of_build_id)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD.supersedes_build_id IS NOT NULL AND NEW.supersedes_build_id IS DISTINCT FROM OLD.supersedes_build_id)
       OR (OLD.delivery_of_build_id IS NOT NULL AND NEW.delivery_of_build_id IS DISTINCT FROM OLD.delivery_of_build_id) THEN
      RAISE EXCEPTION 'BUILD: what a version supersedes or delivers cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'SUPERSEDED' AND NEW.status <> 'SUPERSEDED' THEN
      RAISE EXCEPTION 'BUILD: a superseded version is final' USING ERRCODE = 'check_violation';
    END IF;
    manifest_changed := NEW.manifest_ref IS DISTINCT FROM OLD.manifest_ref OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256;
    IF manifest_changed AND OLD.shown_at IS NOT NULL THEN
      RAISE EXCEPTION 'BUILD: a shown build cannot change; supersede it' USING ERRCODE = 'check_violation';
    END IF;
    IF manifest_changed AND OLD.approved_at IS NOT NULL AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'BUILD: approved content changed; it needs a new approval' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.supersedes_build_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.supersedes_build_id IS NULL) THEN
    SELECT * INTO parent FROM scopely.builds WHERE id = NEW.supersedes_build_id;
    IF FOUND THEN
      IF parent.purpose <> NEW.purpose THEN
        RAISE EXCEPTION 'BUILD: a % version cannot supersede a % version; a DELIVERY names the DEMO it continues with delivery_of_build_id',
          NEW.purpose, parent.purpose USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM scopely.builds WHERE supersedes_build_id = parent.id AND id IS DISTINCT FROM NEW.id) THEN
        RAISE EXCEPTION 'BUILD: build % already has a successor', parent.id USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.project_id IS NULL THEN
        NEW.project_id := parent.project_id;
      ELSIF NEW.project_id <> parent.project_id THEN
        RAISE EXCEPTION 'BUILD: a version can only supersede a version of its own project' USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'UPDATE' AND parent.version_no >= NEW.version_no THEN
        RAISE EXCEPTION 'BUILD: version % cannot supersede the later version %', NEW.version_no, parent.version_no USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.delivery_of_build_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.delivery_of_build_id IS NULL) THEN
    SELECT * INTO demo FROM scopely.builds WHERE id = NEW.delivery_of_build_id;
    IF FOUND THEN
      IF demo.purpose <> 'DEMO' THEN
        RAISE EXCEPTION 'BUILD: a DELIVERY continues a DEMO build; build % is a %', demo.id, demo.purpose USING ERRCODE = 'check_violation';
      END IF;
      IF demo.opportunity_id <> NEW.opportunity_id THEN
        RAISE EXCEPTION 'BUILD: a DELIVERY continues a DEMO of its own opportunity' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.project_id IS NULL THEN
        NEW.project_id := demo.project_id;
      ELSIF NEW.project_id <> demo.project_id THEN
        RAISE EXCEPTION 'BUILD: a DELIVERY continues a DEMO of its own project' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.project_id IS NULL THEN
    INSERT INTO scopely.build_projects (workspace_id, opportunity_id, build_kind, title)
    VALUES (NEW.workspace_id, NEW.opportunity_id, NEW.build_kind, NEW.title) RETURNING id INTO NEW.project_id;
  ELSE
    SELECT * INTO proj FROM scopely.build_projects WHERE id = NEW.project_id;
    IF FOUND AND (proj.opportunity_id <> NEW.opportunity_id OR proj.build_kind <> NEW.build_kind) THEN
      RAISE EXCEPTION 'BUILD: project % builds % for opportunity %, not % for opportunity %',
        proj.id, proj.build_kind, proj.opportunity_id, NEW.build_kind, NEW.opportunity_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.version_no IS NULL THEN
    PERFORM 1 FROM scopely.build_projects WHERE id = NEW.project_id FOR UPDATE;   -- one numberer per project at a time
    SELECT coalesce(max(version_no), 0) + 1 INTO NEW.version_no FROM scopely.builds WHERE project_id = NEW.project_id;
  END IF;

  reason := scopely.project_storage_blocker(NEW.manifest_ref, NEW.workspace_id, NEW.project_id, 'versions/');
  IF reason IS NOT NULL THEN
    RAISE EXCEPTION 'STORAGE: %', reason USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_version_guard BEFORE INSERT OR UPDATE ON builds
  FOR EACH ROW EXECUTE FUNCTION build_version_guard();

-- Superseding a version marks it SUPERSEDED (a discarded version stays DISCARDED).
CREATE FUNCTION build_supersede_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supersedes_build_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.supersedes_build_id IS DISTINCT FROM NEW.supersedes_build_id) THEN
    UPDATE scopely.builds SET status = 'SUPERSEDED'
     WHERE id = NEW.supersedes_build_id AND status NOT IN ('SUPERSEDED','DISCARDED');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER build_supersede_parent AFTER INSERT OR UPDATE OF supersedes_build_id ON builds
  FOR EACH ROW EXECUTE FUNCTION build_supersede_parent();

-- ------------------------------------------------------------------ 3. build runs

CREATE TABLE build_runs (
  id                      bigserial PRIMARY KEY,
  workspace_id            bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id              bigint NOT NULL REFERENCES build_projects(id) ON DELETE CASCADE,
  purpose                 text NOT NULL CHECK (purpose IN ('DEMO','DELIVERY')),   -- of the version it will produce
  base_build_id           bigint REFERENCES builds(id),         -- the version a modifying run starts from
  agent_key               text NOT NULL CHECK (agent_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  agent_version           text CHECK (agent_version IS NULL OR btrim(agent_version) <> ''),
  provider_connection_id  bigint REFERENCES provider_connections(id),   -- NULL: the agent uses no workspace connection
  status                  text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  queued_at               timestamptz NOT NULL DEFAULT now(),
  started_at              timestamptz,
  finished_at             timestamptz,
  error_code              text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,62}$'),
  produced_build_id       bigint UNIQUE REFERENCES builds(id),
  meta                    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object'),
  started_by_user_id      bigint REFERENCES users(id),           -- unauthenticated until B10
  CHECK (status IN ('QUEUED','CANCELLED') OR started_at IS NOT NULL),
  CHECK ((status IN ('SUCCEEDED','FAILED','CANCELLED')) = (finished_at IS NOT NULL)),
  CHECK (started_at IS NULL OR started_at >= queued_at),
  CHECK (finished_at IS NULL OR finished_at >= coalesce(started_at, queued_at)),
  CHECK ((status = 'SUCCEEDED') = (produced_build_id IS NOT NULL)),
  CHECK (status <> 'FAILED' OR error_code IS NOT NULL),
  CHECK (status IN ('FAILED','CANCELLED') OR error_code IS NULL)
);
CREATE INDEX build_runs_project_idx ON build_runs (project_id, queued_at);

-- The run state machine. A run starts QUEUED; QUEUED -> RUNNING | CANCELLED; RUNNING -> SUCCEEDED |
-- FAILED | CANCELLED; a finished run never changes. It may only use an ACTIVE build-scoped
-- connection, and it can only produce a DRAFT version of its own project (the successor of its
-- base version when it modifies one). Approval, showing and delivery are not a run's to record.
CREATE FUNCTION build_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conn record; base record; produced record; path text;
BEGIN
  path := scopely.jsonb_secret_path(NEW.meta);
  IF path IS NOT NULL THEN
    RAISE EXCEPTION 'SECRET: run metadata % looks like a credential', path USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' THEN
      RAISE EXCEPTION 'RUN: a run starts QUEUED, not %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.base_build_id IS NOT NULL THEN
      SELECT project_id, purpose INTO base FROM scopely.builds WHERE id = NEW.base_build_id;
      IF FOUND AND base.project_id <> NEW.project_id THEN
        RAISE EXCEPTION 'RUN: base version % is not part of project %', NEW.base_build_id, NEW.project_id USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND base.purpose <> NEW.purpose THEN
        RAISE EXCEPTION 'RUN: a % run cannot modify a % version', NEW.purpose, base.purpose USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') THEN
      RAISE EXCEPTION 'RUN: run % is %; a finished run cannot change', OLD.id, OLD.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.base_build_id IS DISTINCT FROM OLD.base_build_id
       OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.agent_key IS DISTINCT FROM OLD.agent_key OR NEW.agent_version IS DISTINCT FROM OLD.agent_version
       OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id OR NEW.queued_at IS DISTINCT FROM OLD.queued_at
       OR NEW.started_by_user_id IS DISTINCT FROM OLD.started_by_user_id
       OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
      RAISE EXCEPTION 'RUN: what a run is, and when it started, cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT NEW.status = ANY ((CASE OLD.status
         WHEN 'QUEUED'  THEN ARRAY['RUNNING','CANCELLED']
         WHEN 'RUNNING' THEN ARRAY['SUCCEEDED','FAILED','CANCELLED'] ELSE ARRAY[]::text[] END)) THEN
      RAISE EXCEPTION 'RUN: a run cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The connection must be usable when the run is queued and when it starts.
  IF NEW.provider_connection_id IS NOT NULL AND (TG_OP = 'INSERT' OR (NEW.status = 'RUNNING' AND OLD.status = 'QUEUED')) THEN
    SELECT state, scopes INTO conn FROM scopely.provider_connections WHERE id = NEW.provider_connection_id;
    IF FOUND AND (conn.state <> 'ACTIVE' OR NOT 'build' = ANY (conn.scopes)) THEN
      RAISE EXCEPTION 'RUN: provider connection % is % and scoped %; a run needs an ACTIVE build connection',
        NEW.provider_connection_id, conn.state, conn.scopes USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.produced_build_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.produced_build_id IS NULL) THEN
    SELECT project_id, purpose, status, approved_at, shown_at, supersedes_build_id INTO produced FROM scopely.builds WHERE id = NEW.produced_build_id;
    IF FOUND THEN
      IF produced.project_id <> NEW.project_id THEN
        RAISE EXCEPTION 'RUN: build % is not part of project %', NEW.produced_build_id, NEW.project_id USING ERRCODE = 'check_violation';
      END IF;
      IF produced.purpose <> NEW.purpose THEN
        RAISE EXCEPTION 'RUN: a % run cannot produce a % version', NEW.purpose, produced.purpose USING ERRCODE = 'check_violation';
      END IF;
      IF produced.status <> 'DRAFT' OR produced.approved_at IS NOT NULL OR produced.shown_at IS NOT NULL THEN
        RAISE EXCEPTION 'RUN: a run produces a DRAFT version; build % is %', NEW.produced_build_id, produced.status USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.base_build_id IS NOT NULL AND produced.supersedes_build_id IS DISTINCT FROM NEW.base_build_id THEN
        RAISE EXCEPTION 'RUN: a run that modifies build % must produce its successor', NEW.base_build_id USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_run_guard BEFORE INSERT OR UPDATE ON build_runs
  FOR EACH ROW EXECUTE FUNCTION build_run_guard();

-- While a request acts as a build agent it may write a DRAFT version and its citations, and
-- nothing that is a person's decision: no approval, show or discard of a build, no outcome (won,
-- delivered, ...), verification or evidence re-check, and no message.
CREATE FUNCTION agent_gate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF scopely.current_actor_kind() <> 'build_agent' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'builds' THEN
    IF NEW.approved_at IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)
       OR NEW.status = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD.status <> 'APPROVED') THEN
      RAISE EXCEPTION 'GATE: a build agent cannot approve a build; approval is a person''s decision' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.shown_at IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.shown_at IS DISTINCT FROM OLD.shown_at)
       OR NEW.status = 'SHOWN' AND (TG_OP = 'INSERT' OR OLD.status <> 'SHOWN') THEN
      RAISE EXCEPTION 'GATE: a build agent cannot mark a build shown' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'DISCARDED' AND (TG_OP = 'INSERT' OR OLD.status <> 'DISCARDED') THEN
      RAISE EXCEPTION 'GATE: a build agent cannot discard a build' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'GATE: a build agent cannot write %; % are recorded by a person', TG_TABLE_NAME,
    (CASE TG_TABLE_NAME WHEN 'outcomes' THEN 'wins, losses and deliveries' WHEN 'evidence_rechecks' THEN 're-checks'
                        WHEN 'verifications' THEN 'verifications' ELSE 'messages' END)
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER a01_agent_gate_guard BEFORE INSERT OR UPDATE ON builds            FOR EACH ROW EXECUTE FUNCTION agent_gate_guard();
CREATE TRIGGER a01_agent_gate_guard BEFORE INSERT OR UPDATE ON outcomes          FOR EACH ROW EXECUTE FUNCTION agent_gate_guard();
CREATE TRIGGER a01_agent_gate_guard BEFORE INSERT OR UPDATE ON verifications     FOR EACH ROW EXECUTE FUNCTION agent_gate_guard();
CREATE TRIGGER a01_agent_gate_guard BEFORE INSERT OR UPDATE ON evidence_rechecks FOR EACH ROW EXECUTE FUNCTION agent_gate_guard();
CREATE TRIGGER a01_agent_gate_guard BEFORE INSERT OR UPDATE ON messages          FOR EACH ROW EXECUTE FUNCTION agent_gate_guard();

-- ------------------------------------------------------------------ 6. who pays

ALTER TABLE cost_events DROP CONSTRAINT cost_events_kind_check;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_kind_check
  CHECK (kind IN ('fetch','render','screenshot','llm_call','storage','discovery','enrichment','operator_time','build','agent_run'));
ALTER TABLE cost_events
  ADD COLUMN billed_to              text CHECK (billed_to IN ('SCOPELY','WORKSPACE')),   -- NULL: payer not recorded
  ADD COLUMN provider               text CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  ADD COLUMN provider_connection_id bigint REFERENCES provider_connections(id),
  ADD COLUMN build_run_id           bigint REFERENCES build_runs(id) ON DELETE CASCADE,
  -- A cost the workspace pays its provider directly never consumes Scopely credits.
  ADD CONSTRAINT cost_events_workspace_credits_check CHECK (billed_to IS DISTINCT FROM 'WORKSPACE' OR coalesce(credits, 0) = 0),
  -- A provider cost always says who pays it.
  ADD CONSTRAINT cost_events_provider_payer_check CHECK ((provider IS NULL AND provider_connection_id IS NULL) OR billed_to IS NOT NULL),
  ADD CONSTRAINT cost_events_build_run_check CHECK (build_run_id IS NULL OR opportunity_id IS NOT NULL);
CREATE INDEX cost_events_build_run_idx ON cost_events (build_run_id) WHERE build_run_id IS NOT NULL;
CREATE INDEX cost_events_build_idx ON cost_events (build_id) WHERE build_id IS NOT NULL;

-- A connection's cost goes to whoever holds the key: the workspace for CUSTOMER_KEY, Scopely for
-- SCOPELY_MANAGED. A run's cost stays on the run's project, opportunity and connection. Who paid
-- and through what never changes once recorded.
CREATE FUNCTION cost_event_payer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conn record; run record; b_project bigint; path text;
BEGIN
  path := scopely.jsonb_secret_path(NEW.meta);
  IF path IS NOT NULL THEN
    RAISE EXCEPTION 'SECRET: cost metadata % looks like a credential', path USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id OR NEW.build_run_id IS DISTINCT FROM OLD.build_run_id
       OR (OLD.billed_to IS NOT NULL AND NEW.billed_to IS DISTINCT FROM OLD.billed_to)
       OR (OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider)) THEN
    RAISE EXCEPTION 'COST: who paid, and through which provider or run, cannot change; record a new cost event' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider_connection_id IS NOT NULL THEN
    SELECT provider, mode INTO conn FROM scopely.provider_connections WHERE id = NEW.provider_connection_id;
    IF FOUND THEN
      IF NEW.provider IS NULL THEN
        NEW.provider := conn.provider;
      ELSIF NEW.provider <> conn.provider THEN
        RAISE EXCEPTION 'COST: connection % is %, not %', NEW.provider_connection_id, conn.provider, NEW.provider USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.billed_to IS DISTINCT FROM (CASE conn.mode WHEN 'CUSTOMER_KEY' THEN 'WORKSPACE' ELSE 'SCOPELY' END) THEN
        RAISE EXCEPTION 'COST: a % connection is billed to %, not %', conn.mode,
          (CASE conn.mode WHEN 'CUSTOMER_KEY' THEN 'WORKSPACE' ELSE 'SCOPELY' END), coalesce(NEW.billed_to, 'nobody')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW.build_run_id IS NOT NULL THEN
    SELECT r.project_id, r.provider_connection_id, p.opportunity_id INTO run
      FROM scopely.build_runs r JOIN scopely.build_projects p ON p.id = r.project_id WHERE r.id = NEW.build_run_id;
    IF FOUND THEN
      IF NEW.opportunity_id IS DISTINCT FROM run.opportunity_id THEN
        RAISE EXCEPTION 'COST: build run % is not part of opportunity %', NEW.build_run_id, NEW.opportunity_id USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.build_id IS NOT NULL THEN
        SELECT project_id INTO b_project FROM scopely.builds WHERE id = NEW.build_id;
        IF b_project IS DISTINCT FROM run.project_id THEN
          RAISE EXCEPTION 'COST: build % and build run % belong to different projects', NEW.build_id, NEW.build_run_id USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW.provider_connection_id IS NOT NULL AND NEW.provider_connection_id IS DISTINCT FROM run.provider_connection_id THEN
        RAISE EXCEPTION 'COST: build run % did not use provider connection %', NEW.build_run_id, NEW.provider_connection_id USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_event_payer_guard BEFORE INSERT OR UPDATE ON cost_events
  FOR EACH ROW EXECUTE FUNCTION cost_event_payer_guard();

-- ------------------------------------------------------------------ 8. ownership and isolation

DROP TRIGGER a00_workspace_guard ON builds;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON builds
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities','catalog_item_id','catalog_items',
                                                'supersedes_build_id','builds','project_id','build_projects',
                                                'delivery_of_build_id','builds');
DROP TRIGGER a00_workspace_guard ON cost_events;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON cost_events
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','opportunity_id','opportunities','build_id','builds',
                                                'search_run_id','search_runs','provider_connection_id','provider_connections',
                                                'build_run_id','build_runs');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION workspace_guard();
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON build_projects
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('opportunity_id','opportunities');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON build_requirements
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('project_id','build_projects');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON build_assets
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('project_id','build_projects');
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON build_runs
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('project_id','build_projects','base_build_id','builds',
                                                'provider_connection_id','provider_connections','produced_build_id','builds');

CREATE TRIGGER a02_workspace_member_guard BEFORE INSERT OR UPDATE ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION workspace_member_guard('created_by_user_id');
CREATE TRIGGER a02_workspace_member_guard BEFORE INSERT OR UPDATE ON build_projects
  FOR EACH ROW EXECUTE FUNCTION workspace_member_guard('created_by_user_id');
CREATE TRIGGER a02_workspace_member_guard BEFORE INSERT OR UPDATE ON build_runs
  FOR EACH ROW EXECUTE FUNCTION workspace_member_guard('started_by_user_id');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_connections','build_projects','build_requirements','build_assets','build_runs'] LOOP
    EXECUTE format('ALTER TABLE scopely.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_isolation ON scopely.%I USING (workspace_id = scopely.current_workspace_id())
                    WITH CHECK (workspace_id = scopely.current_workspace_id())', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ gate state for the API

-- Why a build cannot be shown to its prospect at `at`, or NULL when it can. The same rules as the
-- builds CHECK constraints and build_guard, stated as a reason, so a screen never re-derives them.
CREATE FUNCTION build_show_blocker(p_build_id bigint, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE b record; ids bigint[]; successor bigint;
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
  IF b.approved_at IS NULL THEN RETURN 'needs a recorded human approval'; END IF;
  IF p_at < b.approved_at THEN RETURN 'cannot be shown before it was approved'; END IF;
  SELECT array_agg(evidence_id ORDER BY evidence_id) INTO ids FROM scopely.build_evidence WHERE build_id = b.id;
  IF ids IS NULL THEN RETURN 'cites no evidence'; END IF;
  RETURN scopely.evidence_send_blocker(ids, p_at);
END $$;

-- Why a build cannot be approved now, or NULL when it can.
CREATE FUNCTION build_approve_blocker(p_build_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM scopely.builds WHERE id = p_build_id;
  IF NOT FOUND THEN RETURN format('build %s does not exist', p_build_id); END IF;
  IF b.status <> 'DRAFT' THEN RETURN format('build is %s, not DRAFT', b.status); END IF;
  IF b.artifact_ref IS NULL THEN RETURN 'has no artifact to approve'; END IF;
  IF NOT EXISTS (SELECT 1 FROM scopely.build_evidence WHERE build_id = b.id) THEN RETURN 'cites no evidence'; END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------------ views

-- Every version with its place in the project, what produced it and whether it can be approved or
-- shown now. Cost per version is read from cost_events by payer (src/api/queries.ts).
CREATE VIEW v_build_versions AS
SELECT b.workspace_id, b.id AS build_id, b.project_id, b.version_no, b.opportunity_id, b.build_kind, bk.opportunity_path,
       b.purpose, b.status, b.title, b.summary, b.artifact_ref, b.artifact_sha256, b.manifest_ref, b.manifest_sha256,
       b.generator, b.approved_by, b.approved_at, b.shown_at,
       b.supersedes_build_id, succ.id AS successor_build_id, b.delivery_of_build_id,
       run.id AS produced_by_run_id, run.agent_key AS produced_by_agent,
       scopely.build_approve_blocker(b.id) AS approve_blocker,
       scopely.build_show_blocker(b.id, now()) AS show_blocker,
       ev.evidence_ids,
       b.created_at
  FROM scopely.builds b
  JOIN scopely.build_kinds bk ON bk.key = b.build_kind
  LEFT JOIN scopely.builds succ ON succ.supersedes_build_id = b.id
  LEFT JOIN scopely.build_runs run ON run.produced_build_id = b.id
  LEFT JOIN LATERAL (
    SELECT array_agg(evidence_id ORDER BY evidence_id) AS evidence_ids FROM scopely.build_evidence WHERE build_id = b.id) ev ON true;

-- The feed gains the latest agent run's state beside the human build state, so "approved" and
-- "an agent is running" are never one word. Existing columns are unchanged.
CREATE OR REPLACE VIEW v_opportunity_feed AS
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
       o.created_at,
       coalesce(br.status, 'NONE') AS build_run_state,
       br.project_id AS build_run_project_id
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
      FROM scopely.messages WHERE opportunity_id = o.id) msg ON true
  LEFT JOIN LATERAL (
    SELECT rn.status, rn.project_id FROM scopely.build_runs rn JOIN scopely.build_projects p ON p.id = rn.project_id
     WHERE p.opportunity_id = o.id ORDER BY rn.queued_at DESC, rn.id DESC LIMIT 1) br ON true;

ALTER VIEW v_build_versions   SET (security_invoker = true);
ALTER VIEW v_opportunity_feed SET (security_invoker = true);
