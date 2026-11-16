-- 003_security: step-up auth, 2FA, limits, risk decisions, login throttling, tamper-evident audit log.

ALTER TABLE users
  ADD COLUMN pin_hash TEXT,
  ADD COLUMN totp_secret_enc TEXT,
  ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step BIGINT,
  ADD COLUMN daily_send_limit_paise BIGINT CHECK (daily_send_limit_paise IS NULL OR daily_send_limit_paise BETWEEN 0 AND 100000000);

CREATE TABLE recovery_codes (
  id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL UNIQUE, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX recovery_user_idx ON recovery_codes(user_id);

-- Failed-attempt counters keyed by an opaque string (hashed email, IP, user id). Works for unknown accounts too,
-- so a lockout never reveals whether an email is registered.
CREATE TABLE auth_throttle (
  key TEXT PRIMARY KEY, fails INT NOT NULL DEFAULT 0,
  first_fail_at TIMESTAMPTZ NOT NULL DEFAULT now(), locked_until TIMESTAMPTZ);

-- Every scored payment. BLOCK rows form the admin review queue.
CREATE TABLE risk_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id), recipient_user_id UUID REFERENCES users(id),
  transaction_id UUID REFERENCES transactions(id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  score INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW','CHALLENGE','BLOCK')),
  reasons JSONB NOT NULL DEFAULT '[]', ip TEXT,
  review_status TEXT NOT NULL DEFAULT 'NONE' CHECK (review_status IN ('NONE','OPEN','DISMISSED','CONFIRMED_FRAUD')),
  reviewed_by UUID REFERENCES users(id), reviewed_at TIMESTAMPTZ, review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX risk_user_idx ON risk_events(user_id, created_at DESC);
CREATE INDEX risk_open_idx ON risk_events(created_at DESC) WHERE review_status = 'OPEN';
CREATE TRIGGER risk_no_delete BEFORE DELETE ON risk_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE INDEX audit_actor_idx ON audit_logs(actor_user_id, created_at DESC);

-- Tamper-evident audit log: every row stores the hash of the previous row, so editing or removing a row in the
-- middle breaks the chain from that point on. Hashing happens in a trigger, so every insert path is covered.
ALTER TABLE audit_logs ADD COLUMN seq BIGINT, ADD COLUMN prev_hash TEXT, ADD COLUMN row_hash TEXT;

CREATE FUNCTION audit_hash(prev TEXT, a audit_logs) RETURNS TEXT AS $$
  SELECT encode(digest(
    prev || '|' || a.seq::text || '|' || COALESCE(a.actor_user_id::text, '') || '|' || a.action || '|' ||
    COALESCE(a.target, '') || '|' || COALESCE(a.metadata::text, '') || '|' || COALESCE(a.ip, '') || '|' ||
    to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'sha256'), 'hex')
$$ LANGUAGE sql IMMUTABLE;

-- Backfill rows written before this migration (the append-only trigger is lifted for this one statement block).
ALTER TABLE audit_logs DISABLE TRIGGER audit_immutable;
DO $$
DECLARE r audit_logs; p TEXT := repeat('0', 64); n BIGINT := 0; h TEXT;
BEGIN
  FOR r IN SELECT * FROM audit_logs ORDER BY id LOOP
    n := n + 1; r.seq := n; h := audit_hash(p, r);
    UPDATE audit_logs SET seq = n, prev_hash = p, row_hash = h WHERE id = r.id;
    p := h;
  END LOOP;
END $$;
ALTER TABLE audit_logs ENABLE TRIGGER audit_immutable;

ALTER TABLE audit_logs ALTER COLUMN seq SET NOT NULL, ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN row_hash SET NOT NULL;
CREATE UNIQUE INDEX audit_seq_idx ON audit_logs(seq);

-- The advisory lock serialises chain writers; it is held until the writing transaction ends, so code must make the
-- audit insert the LAST statement of any transaction that also locks other rows (otherwise two writers can deadlock).
CREATE FUNCTION audit_chain() RETURNS trigger AS $$
DECLARE p TEXT; s BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);
  SELECT row_hash, seq INTO p, s FROM audit_logs ORDER BY seq DESC LIMIT 1;
  NEW.seq := COALESCE(s, 0) + 1;
  NEW.prev_hash := COALESCE(p, repeat('0', 64));
  NEW.row_hash := audit_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_chain_ins BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain();

CREATE FUNCTION audit_verify() RETURNS TABLE(checked BIGINT, broken_seq BIGINT, head TEXT) AS $$
DECLARE r audit_logs; p TEXT := repeat('0', 64); n BIGINT := 0;
BEGIN
  FOR r IN SELECT * FROM audit_logs ORDER BY seq LOOP
    n := n + 1;
    IF r.seq <> n OR r.prev_hash <> p OR r.row_hash <> audit_hash(p, r) THEN
      checked := n; broken_seq := r.seq; head := p; RETURN NEXT; RETURN;
    END IF;
    p := r.row_hash;
  END LOOP;
  checked := n; broken_seq := NULL; head := p; RETURN NEXT;
END $$ LANGUAGE plpgsql STABLE;
