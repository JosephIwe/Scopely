-- 014_provider_gateway: the smallest provider gateway (Slice 10).
--
-- Scopely owns search, qualification, evidence and the seller's workflow; commodity data (which
-- businesses exist, their size, their website) can come from an external provider. This migration
-- adds only what the first provider path, business discovery, needs:
--
-- 1. A provider connection can be scoped to 'discovery'. A live discovery call needs an ACTIVE
--    discovery connection of this workspace; its key stays a secretref, resolved server-side.
-- 2. provider_operations: one append-only row per provider call. It records the workspace, the
--    capability and operation, the provider's own request reference, which run (and business or
--    opportunity, when one is known) it served, when, how long it took, whether it failed and why
--    (normalized error code), how many results came back, and the provider's cost exactly as the
--    provider reported it. A cost the provider did not report is NOT_REPORTED and NULL, never 0.
--    A replay of a recorded response is transport 'recorded': it has no connection and no cost, so
--    it can never be mistaken for, or averaged into, live provider economics.
-- 3. sources gains the operation that found the business and the provider's record of it as the
--    adapter read it (provider field names, provider values), so every normalized value can be
--    traced back to what the provider said and when.
--
-- Nothing here names a provider: 'clay' is data in these rows, like 'anthropic' in 009.

SET search_path = scopely;

-- ------------------------------------------------------------------ 1. discovery-scoped connections

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_scopes_check;
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_scopes_check
  CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['build','analysis','discovery']);

-- ------------------------------------------------------------------ 2. provider operations

CREATE TABLE provider_operations (
  id                      bigserial PRIMARY KEY,
  workspace_id            bigint NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id) ON DELETE CASCADE,
  provider                text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  capability              text NOT NULL CHECK (capability IN ('business_discovery')),
  operation               text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_]{1,60}$'),
  transport               text NOT NULL CHECK (transport IN ('live','recorded')),
  provider_connection_id  bigint REFERENCES provider_connections(id),
  billed_to               text CHECK (billed_to IN ('SCOPELY','WORKSPACE')),
  search_run_id           bigint REFERENCES search_runs(id) ON DELETE CASCADE,
  business_id             bigint REFERENCES businesses(id) ON DELETE CASCADE,
  opportunity_id          bigint REFERENCES opportunities(id) ON DELETE CASCADE,
  request_ref             text CHECK (request_ref IS NULL OR length(request_ref) BETWEEN 1 AND 200),   -- the provider's id for the call
  request_sha256          text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),                    -- what was asked, without credentials
  status                  text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  error_code              text CHECK (error_code IN ('auth','rate_limited','invalid_request','not_recorded','provider_unavailable',
                                                     'timeout','network','malformed_response')),
  error_detail            text CHECK (error_detail IS NULL OR length(error_detail) <= 300),
  attempts                smallint NOT NULL CHECK (attempts BETWEEN 1 AND 5),
  started_at              timestamptz NOT NULL,
  completed_at            timestamptz NOT NULL,
  latency_ms              integer NOT NULL CHECK (latency_ms >= 0),
  result_count            integer CHECK (result_count >= 0),
  cost_basis              text NOT NULL CHECK (cost_basis IN ('REPORTED','NOT_REPORTED')),
  provider_credits        numeric(14,4) CHECK (provider_credits >= 0),   -- the provider's own credits, as it reported them
  provider_cost_amount    numeric(12,4) CHECK (provider_cost_amount >= 0),
  provider_cost_currency  char(3) CHECK (provider_cost_currency ~ '^[A-Z]{3}$'),
  meta                    jsonb NOT NULL DEFAULT '{}',
  CHECK (completed_at >= started_at),
  CHECK ((status = 'FAILED') = (error_code IS NOT NULL)),
  CHECK (status = 'FAILED' OR result_count IS NOT NULL),
  CHECK ((cost_basis = 'REPORTED') = (provider_credits IS NOT NULL OR provider_cost_amount IS NOT NULL)),
  CHECK (provider_cost_amount IS NULL OR provider_cost_currency IS NOT NULL),
  -- A live call goes through one of the workspace's connections and says who pays for it.
  CHECK (transport <> 'live' OR (provider_connection_id IS NOT NULL AND billed_to IS NOT NULL)),
  -- A replay touches no provider: no connection, no payer, no cost.
  CHECK (transport <> 'recorded' OR (provider_connection_id IS NULL AND billed_to IS NULL AND cost_basis = 'NOT_REPORTED')),
  CHECK (error_code IS DISTINCT FROM 'not_recorded' OR transport = 'recorded')
);
CREATE INDEX provider_operations_run_idx ON provider_operations (search_run_id) WHERE search_run_id IS NOT NULL;
CREATE INDEX provider_operations_workspace_idx ON provider_operations (workspace_id, provider, capability, started_at);

-- The ledger is append-only, its connection must be this provider's ACTIVE discovery connection,
-- the payer follows the connection's mode (as cost_event_payer_guard does), and nothing in it may
-- look like a credential.
CREATE FUNCTION provider_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conn record; path text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PROVIDER: provider operations are a ledger; record a new operation' USING ERRCODE = 'check_violation';
  END IF;
  path := scopely.jsonb_secret_path(NEW.meta);
  IF path IS NOT NULL OR scopely.looks_like_secret(NEW.error_detail) OR scopely.looks_like_secret(NEW.request_ref) THEN
    RAISE EXCEPTION 'SECRET: provider operation % looks like a credential', coalesce(path, 'detail') USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider_connection_id IS NOT NULL THEN
    SELECT provider, mode, state, scopes INTO conn FROM scopely.provider_connections WHERE id = NEW.provider_connection_id;
    IF FOUND THEN
      IF conn.provider <> NEW.provider THEN
        RAISE EXCEPTION 'PROVIDER: connection % is %, not %', NEW.provider_connection_id, conn.provider, NEW.provider USING ERRCODE = 'check_violation';
      END IF;
      IF conn.state <> 'ACTIVE' OR NOT 'discovery' = ANY (conn.scopes) THEN
        RAISE EXCEPTION 'PROVIDER: connection % is % and scoped %; discovery needs an ACTIVE discovery connection',
          NEW.provider_connection_id, conn.state, conn.scopes USING ERRCODE = 'check_violation';
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
CREATE TRIGGER provider_operation_guard BEFORE INSERT OR UPDATE ON provider_operations
  FOR EACH ROW EXECUTE FUNCTION provider_operation_guard();
CREATE FUNCTION provider_operation_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PROVIDER: provider operations are a ledger and are never deleted' USING ERRCODE = 'check_violation';
END $$;
-- Deleting a whole workspace, run or business still cascades; a single row cannot be removed.
CREATE TRIGGER provider_operation_no_delete BEFORE DELETE ON provider_operations
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION provider_operation_no_delete();

CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON provider_operations
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('provider_connection_id','provider_connections','search_run_id','search_runs',
                                                'business_id','businesses','opportunity_id','opportunities');
ALTER TABLE provider_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON provider_operations USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

-- ------------------------------------------------------------------ 3. provenance on sources

ALTER TABLE sources
  ADD COLUMN provider_operation_id bigint REFERENCES provider_operations(id),
  ADD COLUMN provider_record       jsonb CHECK (provider_record IS NULL OR jsonb_typeof(provider_record) = 'object');
CREATE INDEX sources_provider_operation_idx ON sources (provider_operation_id) WHERE provider_operation_id IS NOT NULL;

CREATE FUNCTION source_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op record; path text;
BEGIN
  path := scopely.jsonb_secret_path(NEW.provider_record);
  IF path IS NOT NULL THEN
    RAISE EXCEPTION 'SECRET: provider record % looks like a credential', path USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider_operation_id IS NOT NULL THEN
    SELECT provider, status, search_run_id INTO op FROM scopely.provider_operations WHERE id = NEW.provider_operation_id;
    IF FOUND THEN
      IF op.status <> 'SUCCEEDED' THEN
        RAISE EXCEPTION 'PROVIDER: operation % failed; a failed call found nothing', NEW.provider_operation_id USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.provider IS DISTINCT FROM op.provider THEN
        RAISE EXCEPTION 'PROVIDER: operation % is %, not %', NEW.provider_operation_id, op.provider, coalesce(NEW.provider, 'no provider')
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.search_run_id IS DISTINCT FROM op.search_run_id THEN
        RAISE EXCEPTION 'PROVIDER: operation % served another run', NEW.provider_operation_id USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id
                           OR NEW.provider_record IS DISTINCT FROM OLD.provider_record) THEN
    RAISE EXCEPTION 'PROVIDER: where a business came from cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_provenance_guard BEFORE INSERT OR UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION source_provenance_guard();

DROP TRIGGER a00_workspace_guard ON sources;
CREATE TRIGGER a00_workspace_guard BEFORE INSERT OR UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION workspace_guard('business_id','businesses','search_run_id','search_runs',
                                                'provider_operation_id','provider_operations');

-- ------------------------------------------------------------------ economics

-- Per workspace, provider, capability and transport: how many calls, how many failed, results,
-- latency and the cost the provider reported. Recorded replays are their own rows, never mixed in.
CREATE VIEW v_provider_economics WITH (security_invoker = true) AS
SELECT workspace_id, provider, capability, transport,
       count(*)                                              AS operations,
       count(*) FILTER (WHERE status = 'FAILED')             AS failed,
       coalesce(sum(result_count), 0)                        AS results,
       round(avg(latency_ms))::integer                       AS avg_latency_ms,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::integer AS p50_latency_ms,
       max(latency_ms)                                       AS max_latency_ms,
       count(*) FILTER (WHERE cost_basis = 'REPORTED')       AS cost_reported_operations,
       sum(provider_credits)                                 AS provider_credits,
       min(started_at)                                       AS first_at,
       max(started_at)                                       AS last_at
  FROM scopely.provider_operations
 GROUP BY workspace_id, provider, capability, transport;
