-- 010_site_artifacts: the artifact boundary for template-built versions (Slice 5).
--
-- Slice 5 stores a version's rendered preview in project storage and records its key in
-- builds.artifact_ref, next to the manifest (the structured site document) in manifest_ref. 009
-- already keeps manifest_ref inside the project's own versions/ prefix. This does the same for an
-- artifact that lives in project storage, so a version can never point at another project's or
-- another workspace's files, and requires its hash, so a preview is only served when its bytes
-- match what was recorded.
--
-- An artifact_ref that is not a storage key (an operator's own reference, as recorded before this
-- slice) is left as it was; nothing existing changes.

SET search_path = scopely;

CREATE FUNCTION build_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reason text;
BEGIN
  IF NEW.artifact_ref IS NULL OR NOT starts_with(NEW.artifact_ref, 'workspaces/') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.artifact_ref IS NOT DISTINCT FROM OLD.artifact_ref
     AND NEW.artifact_sha256 IS NOT DISTINCT FROM OLD.artifact_sha256 AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
    RETURN NEW;
  END IF;
  reason := scopely.project_storage_blocker(NEW.artifact_ref, NEW.workspace_id, NEW.project_id, 'versions/');
  IF reason IS NOT NULL THEN
    RAISE EXCEPTION 'STORAGE: %', reason USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.artifact_sha256 IS NULL THEN
    RAISE EXCEPTION 'STORAGE: a stored artifact needs its sha256, so it can be verified before it is served'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- After build_version_guard (alphabetical), which fills in project_id for a new version.
CREATE TRIGGER build_version_zz_artifact_guard BEFORE INSERT OR UPDATE ON builds
  FOR EACH ROW EXECUTE FUNCTION build_artifact_guard();
