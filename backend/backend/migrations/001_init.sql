CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('TRANSFER','FUNDING')),
  sender_wallet_id UUID REFERENCES wallets(id), receiver_wallet_id UUID NOT NULL REFERENCES wallets(id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  description TEXT, status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','FAILED')),
  idempotency_key TEXT, initiator_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (initiator_user_id, idempotency_key));
CREATE INDEX tx_sender_idx ON transactions(sender_wallet_id, created_at DESC);
CREATE INDEX tx_receiver_idx ON transactions(receiver_wallet_id, created_at DESC);
-- Double-entry: system funding wallet is the counter-party for funding.
CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX ledger_wallet_idx ON ledger_entries(wallet_id);
-- Financial records are append-only.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'append-only table'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER tx_no_delete BEFORE DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
