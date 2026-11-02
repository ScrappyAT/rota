import { z } from 'zod';
import { pool } from './db';
import { replayDeadJob } from './services/outbox';
// An operator with database credentials can inspect or requeue a failed intent.
// No provider call is made here, and uncertain sends cannot be requeued.
async function main() {
  try {
    if (process.argv[2] === 'retry') {
      const id = z.string().uuid().parse(process.argv[3]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await replayDeadJob(client, id);
        await client.query('COMMIT');
        console.log('Job requeued:', id);
      }
      catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      finally {
        client.release();
      }
    }
    else {
      const result = await pool.query("SELECT id,kind,status,attempts,failures,dispatch_failures,last_error,created_at FROM job_outbox WHERE status<>'COMPLETED' ORDER BY created_at LIMIT 100");
      console.table(result.rows);
    }
  }
  finally {
    await pool.end();
  }
}
if (require.main === module)
  main().catch(() => { console.error('Job command failed; check the ID, state, delivery uncertainty and database access.'); process.exitCode = 1; });
