-- Additive R3 security state; existing tokens migrate lazily on refresh.
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE auth_sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
ALTER TABLE refresh_tokens ADD COLUMN session_id UUID REFERENCES auth_sessions(id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens ADD COLUMN token_digest TEXT;
CREATE UNIQUE INDEX refresh_tokens_digest_idx ON refresh_tokens(token_digest) WHERE token_digest IS NOT NULL;
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(session_id);
CREATE TABLE auth_action_tokens (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('RESET','MAGIC')),
 token_digest TEXT NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_action_user_idx ON auth_action_tokens(user_id,purpose);
ALTER TABLE job_outbox DROP CONSTRAINT job_outbox_kind_check;
ALTER TABLE job_outbox ADD CONSTRAINT job_outbox_kind_check CHECK(kind IN
 ('DOMAIN_EVENT','NOTIFICATION','PAYMENT_WEBHOOK','PAYMENT_INITIALIZE','PAYMENT_RECONCILE','PAYMENT_VERIFY','BILLING_RECHECK','AUTH_EMAIL'));
-- Durable, cross-process read-your-writes fencing, independent of Redis availability.
CREATE TABLE user_write_fences (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 primary_until TIMESTAMPTZ NOT NULL
);
