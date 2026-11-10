import { logEvent } from './services/observability';
import { Pool } from 'pg';
import { env } from './env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  connectionTimeoutMillis: 2000,
  statement_timeout: 15000,
  idle_in_transaction_session_timeout: 30000,
});

pool.on('error', () => {
  logEvent('database.error', { outcome: 'unexpected' }, 'warn');
  process.exit(-1);
});
