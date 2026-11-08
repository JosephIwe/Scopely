-- 020_lists: Analyse a website without discovery (P3, 2026-11-07).
--
-- A list is a search a person fills by hand (one entry, or a CSV of name, domain and optional
-- company number) instead of running a provider. It reuses everything after discovery unchanged:
-- one search run holds its businesses, pre-qualification sends unknowns to review, and the same
-- SELECT → ANALYSE → OPPORTUNITY → CASE FILE path, guards and RLS apply.
--
-- Guards added here:
--   * searches.kind is 'search' or 'list', fixed once set.
--   * a list has exactly one run, and no provider operation can ever be recorded against it:
--     a list never calls a provider (no Clay, no enrichment).
--   * a business enters a list run only from a source of kind 'manual' or 'csv_import' with no
--     provider operation behind it.
--   * qualify.list_entry v1: the search criteria rule, plus "an entry with no domain or website
--     needs review" (it cannot be analysed until a person adds one). A new rule, not an edit (Rule 6).

SET search_path = scopely;

ALTER TABLE searches ADD COLUMN kind text NOT NULL DEFAULT 'search' CHECK (kind IN ('search','list'));

CREATE FUNCTION search_kind_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'LIST: a search cannot become a list or stop being one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_kind_fixed BEFORE UPDATE ON searches FOR EACH ROW EXECUTE FUNCTION search_kind_fixed();

CREATE FUNCTION list_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM scopely.searches WHERE id = NEW.search_id) = 'list'
     AND EXISTS (SELECT 1 FROM scopely.search_runs WHERE search_id = NEW.search_id AND id <> NEW.id) THEN
    RAISE EXCEPTION 'LIST: list % already has its run', NEW.search_id USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER list_run_guard BEFORE INSERT ON search_runs FOR EACH ROW EXECUTE FUNCTION list_run_guard();

CREATE FUNCTION list_no_provider_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.search_run_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM scopely.search_runs r JOIN scopely.searches s ON s.id = r.search_id
        WHERE r.id = NEW.search_run_id AND s.kind = 'list') THEN
    RAISE EXCEPTION 'LIST: a list never calls a provider' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER list_no_provider_guard BEFORE INSERT OR UPDATE ON provider_operations
  FOR EACH ROW EXECUTE FUNCTION list_no_provider_guard();

CREATE FUNCTION list_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.search_run_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM scopely.search_runs r JOIN scopely.searches s ON s.id = r.search_id
        WHERE r.id = NEW.search_run_id AND s.kind = 'list')
     AND (NEW.kind NOT IN ('manual','csv_import') OR NEW.provider_operation_id IS NOT NULL OR NEW.provider IS DISTINCT FROM NEW.kind) THEN
    RAISE EXCEPTION 'LIST: a list entry comes from a person (manual or csv_import), never a provider' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER list_source_guard BEFORE INSERT OR UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION list_source_guard();

INSERT INTO rule_versions (rule_key, version, kind, playbook_id, description, validation_status, validation_basis, definition) VALUES
('qualify.list_entry', 1, 'qualification', NULL,
 'Pre-qualify a business a person added to a list exactly as qualify.search_criteria v1 does against the list''s criteria (exclusions such as the do-not-contact list still apply), and send an entry with no domain or website address to review: it cannot be analysed until a person adds one. Nothing about the business is assumed from the list.',
 'HYPOTHESIS', NULL, '{"extends":"qualify.search_criteria@1","unknown_when":["no domain and no website address"]}');
