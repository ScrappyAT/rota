-- Preserve the original NGN catalog and all historical billing records.
ALTER TABLE billing_plans
  ADD COLUMN pricing_model TEXT NOT NULL DEFAULT 'LEGACY_PER_SEAT' CHECK (pricing_model IN ('LEGACY_PER_SEAT','INCLUDED_SEATS')),
  ADD COLUMN public_code VARCHAR(32),
  ADD COLUMN base_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (base_price_minor >= 0),
  ADD COLUMN included_seats INTEGER NOT NULL DEFAULT 0 CHECK (included_seats >= 0),
  ADD COLUMN extra_seat_minor INTEGER CHECK (extra_seat_minor >= 0);
CREATE UNIQUE INDEX idx_billing_plans_public_code ON billing_plans(public_code) WHERE public_code IS NOT NULL;
-- Versioned internal IDs avoid reinterpreting existing STARTER/NGN references.
-- max_seats=0 means extra seats have no plan cap (the API safety bound applies).
INSERT INTO billing_plans (code,public_code,name,currency,price_per_seat_minor,max_seats,pricing_model,base_price_minor,included_seats,extra_seat_minor) VALUES
 ('STARTER_USD_V1','STARTER','Starter','USD',0,5,'INCLUDED_SEATS',2000,5,NULL),
 ('TEAM_USD_V1','TEAM','Team','USD',0,0,'INCLUDED_SEATS',5000,15,300),
 ('BUSINESS_USD_V1','BUSINESS','Business','USD',0,0,'INCLUDED_SEATS',12000,40,200);
ALTER TABLE team_subscriptions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0, ADD COLUMN scheduled_change_id UUID;
ALTER TABLE subscription_changes ADD COLUMN currency VARCHAR(3), ADD COLUMN effective_at TIMESTAMP WITH TIME ZONE,
 ADD COLUMN expected_revision INTEGER, ADD COLUMN quote JSONB;
CREATE TABLE billing_idempotency (
 team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 key UUID NOT NULL, request_hash TEXT NOT NULL, response JSONB NOT NULL, http_status INTEGER NOT NULL,
 completed BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(team_id,actor_id,key)
);
-- No cascading FKs: operational entity deletion must not erase financial history.
CREATE TABLE financial_ledger (
 sequence BIGSERIAL PRIMARY KEY, team_id UUID NOT NULL, event_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK (kind IN ('CHARGE','CREDIT','REFUND','STATE')),
 amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0), currency VARCHAR(3) NOT NULL,
 payment_id UUID, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (kind <> 'STATE' OR amount_minor=0)
);
CREATE INDEX idx_financial_ledger_team_sequence ON financial_ledger(team_id,sequence);
CREATE INDEX idx_financial_ledger_payment ON financial_ledger(payment_id);
CREATE FUNCTION reject_financial_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'financial_ledger is append-only; post a correcting entry' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER financial_ledger_no_update_delete BEFORE UPDATE OR DELETE ON financial_ledger
 FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_ledger_mutation();
CREATE TRIGGER financial_ledger_no_truncate BEFORE TRUNCATE ON financial_ledger
 FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_ledger_mutation();
-- Opening snapshots describe imported state honestly; they do not invent history.
INSERT INTO financial_ledger(team_id,event_key,kind,amount_minor,currency,detail)
SELECT s.team_id,'opening:'||s.team_id,'STATE',0,p.currency,
 jsonb_build_object('source','R1 opening snapshot','subscription',to_jsonb(s))
FROM team_subscriptions s JOIN billing_plans p ON p.code=s.plan_code;
INSERT INTO financial_ledger(team_id,event_key,kind,amount_minor,currency,payment_id,detail)
SELECT team_id,'legacy-charge:'||id,'CHARGE',amount_minor,currency,id,
 jsonb_build_object('source','historical stored amount; original unchanged','txRef',tx_ref)
FROM payment_transactions WHERE status='SUCCESSFUL';
