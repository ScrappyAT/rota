-- Migration 003: Shifts, Shift Assignments, Swap Requests, Activity Events

CREATE TYPE shift_status AS ENUM ('ACTIVE', 'CANCELLED');
CREATE TYPE swap_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status shift_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (ends_at > starts_at)
);

CREATE TABLE shift_assignments (
    shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (shift_id, user_id)
);

CREATE TABLE swap_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offered_to UUID REFERENCES users(id) ON DELETE SET NULL,
    status swap_status NOT NULL DEFAULT 'PENDING',
    reason TEXT,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Shift listing / cursor pagination order: (team_id, starts_at, id)
CREATE INDEX idx_shifts_team_starts ON shifts (team_id, starts_at, id);
CREATE INDEX idx_shifts_team_status_starts ON shifts (team_id, status, starts_at, id);

CREATE INDEX idx_shift_assignments_user ON shift_assignments (user_id);
CREATE INDEX idx_shift_assignments_shift ON shift_assignments (shift_id);

CREATE INDEX idx_swap_requests_shift ON swap_requests (shift_id, status);
CREATE INDEX idx_swap_requests_requester ON swap_requests (requested_by, status, created_at, id);
CREATE INDEX idx_swap_requests_pending_target ON swap_requests (status, created_at) WHERE status = 'PENDING';

-- Activity feed cursor order: (team_id, created_at, id)
CREATE INDEX idx_activity_team_created ON activity_events (team_id, created_at, id);
CREATE INDEX idx_activity_team_type_created ON activity_events (team_id, type, created_at, id);
CREATE INDEX idx_activity_actor ON activity_events (actor_id);