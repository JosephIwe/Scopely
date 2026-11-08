-- 023_operator_events: an append-only record of the two operator actions that run without a
-- person at a terminal (docs/OPERATIONS.md, "Operator path"):
--
-- 1. The one-time owner bootstrap. The release step (pnpm release) turns a bootstrap invite whose
--    sha256 an operator put in the service's variables into an ordinary setup invite, only while no
--    owner can sign in. The person then accepts it through the normal sign-up (acceptInvite).
-- 2. The pre-deploy logical backup: an encrypted pg_dump written to external object storage and
--    read back before the deploy may continue.
--
-- A row holds ids, counts, hashes and a short reason code. Never an email, a token, a key, a
-- connection string, a password or a row of data. Rows are never changed or removed.
--
-- Like the sign-in tables (018), this is not workspace data: row-level security is on with no
-- policy, so the application role sees no row. The release step and the sign-in code write it as
-- the connection's own role.

SET search_path = scopely;

CREATE TABLE operator_events (
  id                 bigserial PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN (
                       'bootstrap_invite_issued', 'bootstrap_invite_refused', 'bootstrap_completed', 'bootstrap_accept_refused',
                       'backup_completed', 'backup_failed')),
  reason             text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  invite_id          bigint,
  user_id            bigint,
  workspace_id       bigint,
  object_key         text CHECK (object_key IS NULL OR object_key ~ '^scopely-backups/[0-9TZ]+-[0-9a-f]{8}\.dump\.enc$'),
  size_bytes         bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  ciphertext_sha256  text CHECK (ciphertext_sha256 IS NULL OR ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  dump_sha256        text CHECK (dump_sha256 IS NULL OR dump_sha256 ~ '^[0-9a-f]{64}$'),
  archive_entries    integer CHECK (archive_entries IS NULL OR archive_entries > 0),
  pg_dump_version    text CHECK (pg_dump_version IS NULL OR pg_dump_version ~ '^[0-9]+(\.[0-9]+)*$'),
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- A completed backup names its object and both checksums; a failure names a reason.
  CHECK (kind <> 'backup_completed' OR (object_key IS NOT NULL AND ciphertext_sha256 IS NOT NULL AND dump_sha256 IS NOT NULL AND archive_entries IS NOT NULL)),
  CHECK (kind NOT IN ('backup_failed', 'bootstrap_invite_refused', 'bootstrap_accept_refused') OR reason IS NOT NULL),
  CHECK (kind <> 'bootstrap_invite_issued' OR (invite_id IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (kind <> 'bootstrap_completed' OR (invite_id IS NOT NULL AND user_id IS NOT NULL AND workspace_id IS NOT NULL))
);
CREATE INDEX operator_events_kind_idx ON operator_events (kind, created_at);

CREATE FUNCTION operator_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OPERATOR_EVENTS: the operator record is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER operator_events_append_only BEFORE UPDATE OR DELETE ON operator_events
  FOR EACH ROW EXECUTE FUNCTION operator_events_append_only();
CREATE TRIGGER operator_events_no_truncate BEFORE TRUNCATE ON operator_events
  FOR EACH STATEMENT EXECUTE FUNCTION operator_events_append_only();

-- Default deny for the application role: RLS on, no policy.
ALTER TABLE operator_events ENABLE ROW LEVEL SECURITY;
