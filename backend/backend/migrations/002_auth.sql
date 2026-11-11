ALTER TABLE users ADD COLUMN full_name TEXT;
CREATE TABLE refresh_tokens (
  id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE, family_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
  user_agent TEXT, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX rt_user_idx ON refresh_tokens(user_id); CREATE INDEX rt_family_idx ON refresh_tokens(family_id);
CREATE TABLE password_reset_tokens (
  id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, actor_user_id UUID REFERENCES users(id), action TEXT NOT NULL,
  target TEXT, metadata JSONB, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX audit_action_idx ON audit_logs(action, created_at DESC);
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
