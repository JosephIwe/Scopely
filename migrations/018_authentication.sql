-- 018_authentication: sign-in for the people in users (007), decided as A40 (was B10).
--
-- 1. user_credentials: one password hash per user (scrypt, encoded by src/auth/password.ts). The
--    plain password is never stored, logged or returned.
-- 2. user_sessions: a signed-in browser. The cookie carries a random token; only its sha256 is
--    stored, so a read of this table cannot be replayed as a session. A session expires, can be
--    revoked (sign-out), and acts in at most one workspace, which must be one of the user's
--    memberships at the time it is chosen. Losing the membership later ends access at once,
--    because every request re-checks it (src/auth/session.ts).
-- 3. workspace_invites: how a person joins. A workspace invite adds a member to that workspace.
--    A setup invite (workspace_id NULL) lets one person create a new workspace as its owner; it
--    is issued by the operator's CLI (pnpm auth:invite), never by a request. Tokens are stored as
--    sha256 only, used once, and expire.
--
-- None of these tables is workspace data the application role reads: row-level security is on
-- with no policy, so the application role sees no row. The sign-in code runs as the connection's
-- own role and filters explicitly.

SET search_path = scopely;

CREATE TABLE user_credentials (
  user_id        bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash  text NOT NULL CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_sessions (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_sha256  text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  workspace_id  bigint REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

-- A session may only act in a workspace its user belongs to.
CREATE FUNCTION session_workspace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM scopely.workspace_memberships m WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'SESSION: user % is not a member of workspace %', NEW.user_id, NEW.workspace_id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.token_sha256 <> OLD.token_sha256 OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'SESSION: a session''s user, token and start never change' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    RAISE EXCEPTION 'SESSION: a revoked session cannot be revived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_workspace_guard BEFORE INSERT OR UPDATE ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION session_workspace_guard();

CREATE TABLE workspace_invites (
  id                  bigserial PRIMARY KEY,
  workspace_id        bigint REFERENCES workspaces(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('owner','admin','member')),
  email               text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+$'),
  token_sha256        text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  created_by          text NOT NULL CHECK (btrim(created_by) <> ''),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  used_by_user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  revoked_at          timestamptz,
  CHECK (expires_at > created_at),
  -- A setup invite makes its user the owner of a new workspace.
  CHECK (workspace_id IS NOT NULL OR role = 'owner'),
  CHECK (used_by_user_id IS NULL OR used_at IS NOT NULL)
);

-- An invite is used once, and a used or revoked invite never changes again.
CREATE FUNCTION workspace_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE: invite % was already used or revoked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.role <> OLD.role OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.token_sha256 <> OLD.token_sha256 OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'INVITE: an invite''s terms never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_invite_guard BEFORE UPDATE ON workspace_invites
  FOR EACH ROW EXECUTE FUNCTION workspace_invite_guard();

-- Default deny for the application role: RLS on, no policy.
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;
