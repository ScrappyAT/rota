-- Migration 006: Add attempts column to invitations table for brute-force tracking
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
