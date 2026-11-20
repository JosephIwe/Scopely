-- 024: discovery that works without a provider account (A54), and the "needs a website" path (A55).
--
-- 1. A search can be centred on a place a person typed ("Chelmsford", "CM1", "CM1 1JE"). The
--    server resolves it through the postcode directory; the search keeps what the centre is and
--    where it came from, beside the centre_latitude / centre_longitude / radius_km it already had.
--    A run freezes these with the rest of the search, as before.
-- 2. A live call to an open-data source needs no connection and has no payer (A54). Until now every
--    live call had to go through one of the workspace's own connections (A32), because every live
--    source was an account someone pays for. OpenStreetMap (Overpass) is free open data with no
--    account or key; its calls are still recorded, one row each, with no connection, no payer and
--    cost NOT_REPORTED. Only the providers named here may do this: Clay, or any provider added
--    later, still needs the workspace's own ACTIVE connection.
-- 3. A shared starter service for the Website path: "Website build", for the one finding that
--    means a business has no website (E-NO-WEBSITE). Like Landing Page Build it has no price: none
--    is established, so none is written, and a workspace can override it with its own item.
--    E-NO-WEBSITE itself is unchanged: it still needs website status WEBSITE_NOT_OBSERVED, which
--    the database still refuses while any domain or URL is known (008).

SET search_path = scopely;

ALTER TABLE searches
  ADD COLUMN center_label  text CHECK (center_label IS NULL OR length(center_label) BETWEEN 1 AND 160),
  ADD COLUMN center_source text CHECK (center_source IS NULL OR length(center_source) BETWEEN 1 AND 300),
  ADD CONSTRAINT search_center_named CHECK (center_label IS NULL OR (center_latitude IS NOT NULL AND center_longitude IS NOT NULL AND center_source IS NOT NULL));

-- The 014 check has a generated name, so it is found by what it says, and must be found exactly once.
DO $$
DECLARE names text[];
BEGIN
  SELECT array_agg(conname) INTO names FROM pg_constraint
   WHERE conrelid = 'scopely.provider_operations'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) = 'CHECK (((transport <> ''live''::text) OR ((provider_connection_id IS NOT NULL) AND (billed_to IS NOT NULL))))';
  IF coalesce(array_length(names, 1), 0) <> 1 THEN
    RAISE EXCEPTION 'expected one live-call payer check on provider_operations, found %', coalesce(array_length(names, 1), 0);
  END IF;
  EXECUTE format('ALTER TABLE scopely.provider_operations DROP CONSTRAINT %I', names[1]);
END $$;
ALTER TABLE provider_operations ADD CONSTRAINT provider_operation_live_payer CHECK (
  transport <> 'live'
  OR (provider_connection_id IS NOT NULL AND billed_to IS NOT NULL)
  OR (provider IN ('openstreetmap') AND capability = 'business_discovery'
      AND provider_connection_id IS NULL AND billed_to IS NULL AND cost_basis = 'NOT_REPORTED'));

INSERT INTO catalog_items (key, service, description, build_kind, supported_issue_codes)
VALUES ('website_build', 'Website build',
        'A first website for a business that has none. Price not established.',
        'website', ARRAY['E-NO-WEBSITE']);
