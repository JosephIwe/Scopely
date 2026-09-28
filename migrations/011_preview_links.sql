-- 011_preview_links: prospect links that a seller can revoke (Slice 5, decision B17).
--
-- A prospect's link to a shown version is a signed token that names one row here. The row holds
-- when the link stops working (expires_at, 72 hours after creation by default in the app) and
-- whether the seller revoked it early. Serving the link reads the row, so a revocation takes
-- effect on the next request. The build itself is untouched: revoking a link never changes a
-- version, its approval or its shown state.
--
-- A link is created only for a version that was shown, by a person. Once created its version and
-- expiry never change, and a revocation is final.

SET search_path = scopely;

CREATE TABLE preview_links (
  id            bigserial PRIMARY KEY,
  workspace_id  bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    bigint NOT NULL REFERENCES build_projects(id) ON DELETE CASCADE,
  build_id      bigint NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_by    text,                                              -- free text until B10
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_by IS NULL OR btrim(revoked_by) <> ''),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX preview_links_build_idx ON preview_links (build_id);

CREATE FUNCTION preview_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;
BEGIN
  IF scopely.current_actor_kind() = 'build_agent' THEN
    RAISE EXCEPTION 'GATE: a build agent cannot create or revoke a prospect link' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT project_id, shown_at INTO b FROM scopely.builds WHERE id = NEW.build_id;
    IF b.project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'LINK: build % is not a version of project %', NEW.build_id, NEW.project_id USING ERRCODE = 'check_violation';
    END IF;
    IF b.shown_at IS NULL THEN
      RAISE EXCEPTION 'LINK: only a version that was shown can have a prospect link' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'LINK: a new link cannot start revoked' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.build_id IS DISTINCT FROM OLD.build_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'LINK: a link''s version and lifetime never change; make a new link' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'LINK: a revoked link stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a01_preview_link_guard BEFORE INSERT OR UPDATE ON preview_links
  FOR EACH ROW EXECUTE FUNCTION preview_link_guard();

CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON preview_links
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('project_id','build_projects','build_id','builds');

ALTER TABLE preview_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON preview_links USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());
