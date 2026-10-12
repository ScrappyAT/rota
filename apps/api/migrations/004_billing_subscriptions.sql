-- Migration 004: Billing - subscription plans, team subscriptions, seat changes,
-- payment transactions, webhook dedupe log, invoices.
--
-- Money is stored in integer minor units (kobo for NGN) to stay exact.

CREATE TYPE subscription_status AS ENUM ('ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED');
CREATE TYPE subscription_change_type AS ENUM (
    'PLAN_UPGRADE',
    'PLAN_DOWNGRADE',
    'ADD_SEATS',
    'REDUCE_SEATS',
    'RENEWAL'
);
CREATE TYPE subscription_change_status AS ENUM ('PENDING_PAYMENT', 'PAID', 'FAILED');
CREATE TYPE payment_status AS ENUM ('PENDING', 'SUCCESSFUL', 'FAILED', 'CANCELLED');
CREATE TYPE invoice_status AS ENUM ('OUTSTANDING', 'PAID', 'REFUNDED');

CREATE TABLE billing_plans (
    code VARCHAR(32) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    price_per_seat_minor INTEGER NOT NULL CHECK (price_per_seat_minor >= 0),
    max_seats INTEGER NOT NULL CHECK (max_seats >= 0),
    currency VARCHAR(3) NOT NULL,
    is_free BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE team_subscriptions (
    team_id UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    plan_code VARCHAR(32) NOT NULL REFERENCES billing_plans(code),
    seats INTEGER NOT NULL CHECK (seats > 0),
    status subscription_status NOT NULL DEFAULT 'ACTIVE',
    period_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    period_ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_renewal_failed_at TIMESTAMP WITH TIME ZONE,
    grace_ends_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subscription_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type subscription_change_type NOT NULL,
    from_plan_code VARCHAR(32),
    to_plan_code VARCHAR(32),
    from_seats INTEGER,
    to_seats INTEGER,
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    status subscription_change_status NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    change_id UUID REFERENCES subscription_changes(id) ON DELETE SET NULL,
    tx_ref VARCHAR(128) NOT NULL UNIQUE,
    flw_transaction_id VARCHAR(128) UNIQUE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    currency VARCHAR(3) NOT NULL,
    status payment_status NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE webhook_events (
    event_key VARCHAR(255) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE billing_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    change_id UUID REFERENCES subscription_changes(id) ON DELETE SET NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    description TEXT NOT NULL,
    status invoice_status NOT NULL DEFAULT 'OUTSTANDING',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP WITH TIME ZONE
);

-- Subscription change history cursor order: (team_id, created_at, id)
CREATE INDEX idx_subscription_changes_team_created ON subscription_changes (team_id, created_at, id);

-- Pending payment lookup by reference (idempotency checks)
CREATE INDEX idx_payment_transactions_team ON payment_transactions (team_id, created_at, id);
CREATE INDEX idx_payment_transactions_change ON payment_transactions (change_id);
CREATE INDEX idx_payment_transactions_pending ON payment_transactions (tx_ref) WHERE status = 'PENDING';

-- Invoice listing cursor order: (team_id, created_at, id)
CREATE INDEX idx_billing_invoices_team_created ON billing_invoices (team_id, created_at, id);

-- Plan seeds. Prices in kobo (minor units) per seat per period (NGN).
INSERT INTO billing_plans (code, name, price_per_seat_minor, max_seats, currency, is_free) VALUES
    ('FREE', 'Free', 0, 100, 'NGN', TRUE),
    ('STARTER', 'Starter', 250000, 10, 'NGN', FALSE),
    ('GROWTH', 'Growth', 300000, 50, 'NGN', FALSE),
    ('SCALE', 'Scale', 350000, 500, 'NGN', FALSE);

-- Backfill: every existing team already has an active FREE subscription capped by
-- plan max (100 seats) but never below one seat per member.
INSERT INTO team_subscriptions (team_id, plan_code, seats, status, period_started_at, period_ends_at)
SELECT
    t.id,
    'FREE',
    LEAST(100, GREATEST(1, (SELECT COUNT(*) FROM team_memberships tm WHERE tm.team_id = t.id))) AS seats,
    'ACTIVE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP + INTERVAL '30 days'
FROM teams t;