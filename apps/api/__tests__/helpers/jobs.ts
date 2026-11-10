import { pool } from '../../src/db';
import { JobKind } from '../../src/services/outbox';
import { processOutboxJob } from '../../src/services/job-runtime';
/** Executes the real worker processor against committed rows; external providers remain mocked. */
export const drainTestJobs = async (kinds: JobKind[], max = 200) => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== '127.0.0.1' || url.port !== '5540' || url.pathname !== '/rota_r1_test')
    throw new Error('Disposable test server required');
  for (let round = 0;round < max;round++) {
    const rows = (await pool.query("SELECT id,clock_timestamp() AS evaluated_at FROM job_outbox WHERE kind=ANY($1::text[]) AND payload->>'receiptCheck' IS DISTINCT FROM 'true' AND status IN ('PENDING','QUEUED') AND available_at<=NOW() ORDER BY sequence LIMIT 1", [kinds])).rows;
    if (!rows.length)
      return;
    // Failures stay in the durable attempt log for assertions; no implicit repeated tries here.
    try {
      // Match the database clock that determined this row was due. The production
      // worker is unchanged; injecting this time avoids WSL/host skew in fast drains.
      await processOutboxJob(pool, rows[0].id, rows[0].evaluated_at);
    }
    catch {
      return;
    }
  }
  throw new Error('Test drain exceeded bounded work');
};
