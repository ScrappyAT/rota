-- Additive R2 structures. Original financial rows and migrations 001-007 stay intact.
CREATE TABLE user_settings (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 values JSONB NOT NULL DEFAULT '{"quietHours":{"enabled":false,"start":"22:00","end":"06:00"},"timeZone":"UTC","notificationCategories":{"shifts":true,"swaps":true,"billing":true},"language":"en","theme":"system"}',
 field_updated_at JSONB NOT NULL DEFAULT '{}',
 updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO user_settings(user_id) SELECT id FROM users ON CONFLICT DO NOTHING;

CREATE TABLE job_outbox (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sequence BIGSERIAL NOT NULL UNIQUE, event_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('DOMAIN_EVENT','NOTIFICATION','PAYMENT_WEBHOOK','PAYMENT_INITIALIZE','PAYMENT_RECONCILE','PAYMENT_VERIFY','BILLING_RECHECK')),
 team_id UUID, payload JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','QUEUED','RUNNING','COMPLETED','DEAD')),
 available_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
 next_dispatch_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
 generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0, dispatch_failures INTEGER NOT NULL DEFAULT 0,
 manual_replays INTEGER NOT NULL DEFAULT 0, result JSONB, last_error TEXT,
 created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
 completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_outbox_dispatch ON job_outbox(next_dispatch_at,available_at,id) WHERE status IN ('PENDING','QUEUED','RUNNING');
CREATE INDEX idx_outbox_team ON job_outbox(team_id,created_at);
CREATE INDEX idx_outbox_dead ON job_outbox(created_at) WHERE status='DEAD';
CREATE TABLE job_attempts (
 id BIGSERIAL PRIMARY KEY, outbox_id UUID NOT NULL REFERENCES job_outbox(id) ON DELETE CASCADE,
 attempt INTEGER NOT NULL, started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
 finished_at TIMESTAMP WITH TIME ZONE, outcome TEXT NOT NULL DEFAULT 'RUNNING', error TEXT,
 UNIQUE(outbox_id,attempt)
);
CREATE TABLE notification_deliveries (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 token TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SENDING','SENT','RETRYABLE','INVALID','SUPPRESSED','UNKNOWN')),
 attempts INTEGER NOT NULL DEFAULT 0, ticket_id TEXT, last_error TEXT,
 updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(notification_id,token)
);
CREATE INDEX idx_delivery_notification_state ON notification_deliveries(notification_id,state);
ALTER TABLE payment_transactions ADD COLUMN initialization_state TEXT
 CHECK(initialization_state IN ('QUEUED','CLAIMED','READY','AMBIGUOUS','RESOLVED','MANUAL_REVIEW')),
 ADD COLUMN checkout_url TEXT;
-- Old pending requests can only be verified. Never initialize them a second time.
UPDATE payment_transactions SET initialization_state='AMBIGUOUS' WHERE status='PENDING';
INSERT INTO job_outbox(event_key,kind,team_id,payload)
 SELECT 'reconcile:'||id,'PAYMENT_RECONCILE',team_id,jsonb_build_object('paymentId',id,'teamId',team_id,'txRef',tx_ref)
 FROM payment_transactions WHERE status='PENDING' AND change_id IS NOT NULL;
