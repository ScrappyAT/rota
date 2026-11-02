import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
describe('R2 additive migration preserves R1 financial and preference history', () => {
  it('adds outbox/settings without reinterpreting any original financial record', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '5540' || url.pathname !== '/rota_r1_test')
      throw new Error('Disposable PostgreSQL only');
    const admin = new Pool({ connectionString: url.toString() });
    let database: Pool | undefined, created = false;
    try {
      await admin.query('CREATE DATABASE rota_r2_upgrade_test');
      created = true;
      url.pathname = '/rota_r2_upgrade_test';
      database = new Pool({ connectionString: url.toString() });
      const folder = path.join(__dirname, '../migrations');
      for (const file of fs.readdirSync(folder).filter(f => f.endsWith('.sql') && f < '008_').sort())
        await database.query(fs.readFileSync(path.join(folder, file), 'utf8'));
      const user = (await database.query("INSERT INTO users(email,first_name,last_name,password_hash) VALUES('r2-history@test.example','Old','Owner','hash') RETURNING id")).rows[0].id;
      const team = (await database.query("INSERT INTO teams(name,owner_id) VALUES('Before R2',$1) RETURNING id", [user])).rows[0].id;
      await database.query("INSERT INTO team_subscriptions(team_id,plan_code,seats,period_started_at,period_ends_at,revision) VALUES($1,'TEAM_USD_V1',18,NOW(),NOW()+INTERVAL '30 days',7)", [team]);
      const change = (await database.query("INSERT INTO subscription_changes(team_id,actor_id,type,amount_minor,status,currency,expected_revision,quote) VALUES($1,$2,'RENEWAL',5900,'PENDING_PAYMENT','USD',7,'{\"costMinor\":5900,\"creditMinor\":0}') RETURNING id", [team, user])).rows[0].id;
      await database.query("INSERT INTO payment_transactions(team_id,change_id,tx_ref,amount_minor,currency,status) VALUES($1,$2,'r2-historical-pending',5900,'USD','PENDING')", [team, change]);
      await database.query("INSERT INTO financial_ledger(team_id,event_key,kind,amount_minor,currency) VALUES($1,'r2-preserve-charge','CHARGE',1234,'NGN')", [team]);
      await database.query("INSERT INTO notification_preferences(user_id,swap_requested) VALUES($1,FALSE)", [user]);
      const snapshot = async () => ({
        plans: (await database!.query('SELECT * FROM billing_plans ORDER BY code')).rows,
        subscription: (await database!.query('SELECT * FROM team_subscriptions')).rows,
        payments: (await database!.query("SELECT to_jsonb(p)-'initialization_state'-'checkout_url' AS row FROM payment_transactions p ORDER BY id")).rows,
        ledger: (await database!.query('SELECT * FROM financial_ledger ORDER BY sequence')).rows,
        changes: (await database!.query('SELECT * FROM subscription_changes')).rows,
        preferences: (await database!.query('SELECT * FROM notification_preferences')).rows,
      });
      const before = await snapshot();
      await database.query('BEGIN');
      await database.query(fs.readFileSync(path.join(folder, '008_durable_jobs_and_settings.sql'), 'utf8'));
      await database.query('COMMIT');
      expect(await snapshot()).toEqual(before);
      expect((await database.query('SELECT kind,status FROM job_outbox')).rows).toEqual([{ kind: 'PAYMENT_RECONCILE', status: 'PENDING' }]);
      expect((await database.query('SELECT initialization_state FROM payment_transactions')).rows[0].initialization_state).toBe('AMBIGUOUS');
      expect((await database.query('SELECT user_id FROM user_settings')).rows).toEqual([{ user_id: user }]);
    }
    finally {
      await database?.end();
      if (created)
        await admin.query('DROP DATABASE rota_r2_upgrade_test');
      await admin.end();
    }
  }, 20000);
});
