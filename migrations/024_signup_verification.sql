-- 024: public sign-up proves the email address first (A53).
--
-- With open sign-up on, a person asks for a code, Scopely emails a 6-digit code to that address,
-- and the account and its workspace are created only when the code comes back. The code is stored
-- as sha256 only, works once, for 15 minutes, and for at most 5 wrong guesses. Nothing here is
-- workspace data: like invites (018), row-level security is on with no policy, so the application
-- role sees no row; the sign-in code runs as the connection's own role and filters explicitly.

SET search_path = scopely;

CREATE TABLE signup_verifications (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+$' AND email = lower(email)),
  code_sha256  text NOT NULL CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  used_at      timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour')
);
CREATE INDEX signup_verifications_email_idx ON signup_verifications (email, created_at DESC);
CREATE INDEX signup_verifications_created_idx ON signup_verifications (created_at);

-- A used code never changes again, and attempts only go up.
CREATE FUNCTION signup_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN RAISE EXCEPTION 'signup verification % is used', OLD.id; END IF;
  IF NEW.email <> OLD.email OR NEW.code_sha256 <> OLD.code_sha256 OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'signup verification % may only count attempts or be used', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signup_verification_guard BEFORE UPDATE ON signup_verifications
  FOR EACH ROW EXECUTE FUNCTION signup_verification_guard();

ALTER TABLE signup_verifications ENABLE ROW LEVEL SECURITY;
