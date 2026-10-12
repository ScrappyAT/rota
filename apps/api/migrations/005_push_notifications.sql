-- Migration 005: Push notifications - device tokens, per-user notification
-- preferences, and a deduplicating notification ledger.
--
-- Expo push tokens are the only device credential stored; permanently rejected
-- tokens (DeviceNotRegistered / InvalidPushToken) are pruned at delivery time.

CREATE TYPE notification_status AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

CREATE TABLE device_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform VARCHAR(16) NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios', 'web')),
    push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One registered device token per user (re-registration upserts on this key).
CREATE UNIQUE INDEX idx_device_tokens_user_token ON device_tokens (user_id, token);
-- Token-level lookups and Expo invalid-token pruning.
CREATE INDEX idx_device_tokens_token ON device_tokens (token);

-- Per-user notification preference toggles. Missing rows mean "all enabled";
-- a row is materialized when the user first reads or updates preferences.
CREATE TABLE notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    shift_assigned BOOLEAN NOT NULL DEFAULT TRUE,
    swap_requested BOOLEAN NOT NULL DEFAULT TRUE,
    swap_approved BOOLEAN NOT NULL DEFAULT TRUE,
    swap_rejected BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Notification ledger: dedupes deliveries (event_key UNIQUE -> idempotent
-- across retries) and provides per-user history plus send/retry audit.
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    event_key VARCHAR(255) NOT NULL UNIQUE,
    status notification_status NOT NULL DEFAULT 'PENDING',
    delivered_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- History cursor order: (user_id, created_at, id)
CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at, id);
-- Undelivered rows (candidate set for a future retry sweep).
CREATE INDEX idx_notifications_pending ON notifications (status) WHERE status IN ('PENDING', 'FAILED');