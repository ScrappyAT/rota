import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
describe('R1 additive upgrade preserves existing NGN records', () => {
  it('migrates a pre-R1 database without rewriting prices,payments,invoices or subscriptions', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '5540' || url.pathname !== '/rota_r1_test')
      throw new Error('Disposable R1 server required');
    const admin = new Pool({ connectionString: url.toString() });
    let database: Pool | undefined, created = false;
    try {
      await admin.query('CREATE DATABASE rota_r1_upgrade_test');
      created = true;
      url.pathname = '/rota_r1_upgrade_test';
      database = new Pool({ connectionString: url.toString() });
      const files = fs.readdirSync(path.join(__dirname, '../migrations')).filter(f => f.endsWith('.sql')).sort();
      for (const file of files.filter(f => !f.startsWith('007_')))
        await database.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
      const user = (await database.query("INSERT INTO users(email,first_name,last_name,password_hash) VALUES('historical@test.example','Old','Owner','mock-hash') RETURNING id")).rows[0].id;
      const team = (await database.query("INSERT INTO teams(name,owner_id) VALUES('Historical',$1) RETURNING id", [user])).rows[0].id;
      await database.query("INSERT INTO team_subscriptions(team_id,plan_code,seats,period_started_at,period_ends_at) VALUES($1,'STARTER',2,NOW(),NOW()+INTERVAL '30 days')", [team]);
      const change = (await database.query("INSERT INTO subscription_changes(team_id,actor_id,type,amount_minor,status) VALUES($1,$2,'RENEWAL',1234,'PAID') RETURNING id", [team, user])).rows[0].id;
      await database.query("INSERT INTO payment_transactions(team_id,change_id,tx_ref,amount_minor,currency,status) VALUES($1,$2,'historic-paid',1234,'NGN','SUCCESSFUL'),($1,$2,'historic-pending',4567,'NGN','PENDING')", [team, change]);
      await database.query("INSERT INTO billing_invoices(team_id,change_id,amount_minor,description,status) VALUES($1,$2,1234,'Historical','PAID')", [team, change]);
      const read = async () => ({
        plans: (await database!.query('SELECT code,price_per_seat_minor,currency,max_seats FROM billing_plans ORDER BY code')).rows,
        subscriptions: (await database!.query('SELECT team_id,plan_code,seats,status,period_started_at,period_ends_at FROM team_subscriptions')).rows,
        payments: (await database!.query('SELECT * FROM payment_transactions ORDER BY tx_ref')).rows,
        invoices: (await database!.query('SELECT * FROM billing_invoices')).rows,
      });
      const before = await read();
      const client = await database.connect();
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(__dirname, '../migrations/007_billing_financial_integrity.sql'), 'utf8'));
        await client.query('COMMIT');
      }
      finally {
        client.release();
      }
      const after = await read();
      expect(after.subscriptions).toEqual(before.subscriptions);
      expect(after.payments).toEqual(before.payments);
      expect(after.invoices).toEqual(before.invoices);
      expect(after.plans.filter(p => before.plans.some(old => old.code === p.code))).toEqual(before.plans);
      expect((await database.query("SELECT kind,amount_minor,currency FROM financial_ledger WHERE kind='CHARGE'")).rows).toEqual([{ kind: 'CHARGE', amount_minor: '1234', currency: 'NGN' }]);
      expect((await database.query("SELECT detail->'subscription'->>'plan_code' AS plan FROM financial_ledger WHERE kind='STATE'")).rows[0].plan).toBe('STARTER');
    }
    finally {
      await database?.end();
      // This exact database is created above on the explicitly guarded disposable server.
      if (created)
        await admin.query('DROP DATABASE rota_r1_upgrade_test');
      await admin.end();
    }
  }, 20000);
});
