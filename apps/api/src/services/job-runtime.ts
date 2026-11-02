import { Pool } from 'pg';
import { Queue, Worker, UnrecoverableError, ConnectionOptions, Job } from 'bullmq';
import { env } from '../env';
import { HttpError } from '../http-error';
import { handleOutbox } from './job-handlers';
import { DeferJob, OutboxRow } from './outbox';
export const jobBackoff = (failure: number): number => Math.min(60000, env.JOB_BACKOFF_MS * 2 ** Math.max(0, failure - 1));
export const jobRedisConnection = (worker = false): ConnectionOptions => {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname, port: Number(url.port || 6379), username: url.username ? decodeURIComponent(url.username) : undefined, password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0), ...(url.protocol === 'rediss:' ? { tls: {} } : {}), maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker, connectTimeout: 3000
  };
};
export const createJobQueue = (name = env.JOB_QUEUE_NAME) => {
  const queue = new Queue(name, {
    connection: jobRedisConnection(),
    defaultJobOptions: { attempts: env.JOB_ATTEMPTS, backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS }, removeOnComplete: { count: 1000 }, removeOnFail: false }
  });
  queue.on('error', () => console.error(JSON.stringify({ source: 'jobs', event: 'queue-connection-error' })));
  return queue;
};
/** Durable PostgreSQL status and session locks fence duplicates even after Redis loss. */
export const processOutboxJob = async (pool: Pool, id: string, now = new Date()): Promise<void> => {
  const client = await pool.connect();
  let locked = false, row: OutboxRow | undefined;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [id])).rows[0].locked;
    if (!locked)
      throw new Error('Job is already running');
    row = (await client.query('SELECT * FROM job_outbox WHERE id=$1', [id])).rows[0];
    if (!row || ['COMPLETED', 'DEAD'].includes(row.status))
      return;
    if (row.available_at.getTime() > now.getTime())
      throw new DeferJob(row.available_at);
    await client.query("UPDATE job_attempts SET outcome='INTERRUPTED',finished_at=NOW() WHERE outbox_id=$1 AND finished_at IS NULL", [id]);
    const claim = await client.query("UPDATE job_outbox SET status='RUNNING',attempts=attempts+1 WHERE id=$1 RETURNING attempts", [id]);
    row.attempts = claim.rows[0].attempts;
    await client.query('INSERT INTO job_attempts(outbox_id,attempt) VALUES($1,$2)', [id, row.attempts]);
    console.log(JSON.stringify({ source: 'jobs', event: 'attempt', id, kind: row.kind, attempt: row.attempts }));
    const result = await handleOutbox(client, row, now);
    await client.query("UPDATE job_outbox SET status='COMPLETED',result=$2,completed_at=NOW(),last_error=NULL WHERE id=$1", [id, JSON.stringify(result ?? null)]);
    await client.query("UPDATE job_attempts SET outcome='COMPLETED',finished_at=NOW() WHERE outbox_id=$1 AND attempt=$2", [id, row.attempts]);
  }
  catch (error) {
    // A delivery-window deferral is scheduling, not a failed attempt.
    if (row && locked && error instanceof DeferJob) {
      await client.query("UPDATE job_outbox SET status='PENDING',available_at=$2,next_dispatch_at=NOW(),generation=generation+1 WHERE id=$1", [id, error.until]);
      await client.query("UPDATE job_attempts SET outcome='DEFERRED',finished_at=NOW() WHERE outbox_id=$1 AND attempt=$2", [id, row.attempts]);
      return;
    }
    if (row && locked) {
      const dead = error instanceof UnrecoverableError || (error instanceof HttpError && error.statusCode < 500) || row.failures + 1 >= env.JOB_ATTEMPTS;
      const sqlState = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
      const code = error instanceof HttpError ? error.code : error instanceof UnrecoverableError ? 'UNRECOVERABLE' : sqlState ? 'DATABASE_' + sqlState : 'RETRYABLE';
      const result = error instanceof HttpError ? { statusCode: error.statusCode, error: { code: error.code, message: error.message } } : null;
      await client.query(`UPDATE job_outbox SET failures=failures+1,status=$2,last_error=$3,result=$4,
        next_dispatch_at=NOW()+($5::int*INTERVAL '1 millisecond') WHERE id=$1`, [id, dead ? 'DEAD' : 'QUEUED', code, JSON.stringify(result), jobBackoff(row.failures + 1)]);
      await client.query('UPDATE job_attempts SET outcome=$3,error=$4,finished_at=NOW() WHERE outbox_id=$1 AND attempt=$2', [id, row.attempts, dead ? 'DEAD' : 'RETRYABLE', code]);
      if (dead && row.kind === 'PAYMENT_RECONCILE')
        await client.query("UPDATE payment_transactions SET initialization_state='MANUAL_REVIEW' WHERE id=$1 AND status='PENDING'", [row.payload.paymentId]);
      console.warn(JSON.stringify({ source: 'jobs', event: dead ? 'dead' : 'retry', id, attempt: row.attempts, code }));
      if (dead)
        throw new UnrecoverableError(code);
    }
    throw error;
  }
  finally {
    if (locked)
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [id]).catch(() => { });
    client.release();
  }
};
/** Safe to repeat after crash between Redis publication and PostgreSQL acknowledgement. */
export const dispatchOutbox = async (pool: Pool, queue: Queue): Promise<number> => {
  const rows = (await pool.query(`SELECT * FROM job_outbox WHERE status IN ('PENDING','QUEUED','RUNNING')
    AND next_dispatch_at<=NOW() AND available_at<=NOW()+INTERVAL '2 days' ORDER BY next_dispatch_at,id LIMIT 100`)).rows as OutboxRow[];
  let count = 0;
  for (const row of rows) {
    try {
      const jobId = row.id + '-' + row.generation;
      const old = await queue.getJob(jobId);
      if (old && await old.getState() === 'failed') {
        await pool.query("UPDATE job_outbox SET status='DEAD',last_error='BullMQ exhausted attempts or stalled recovery' WHERE id=$1 AND status NOT IN ('COMPLETED','DEAD')", [row.id]);
        continue;
      }
      if (!old)
        await queue.add(row.kind, { outboxId: row.id }, { jobId, delay: Math.max(0, row.available_at.getTime() - Date.now()) });
      await pool.query("UPDATE job_outbox SET status=CASE WHEN status='PENDING' THEN 'QUEUED' ELSE status END,next_dispatch_at=NOW()+INTERVAL '30 seconds' WHERE id=$1 AND generation=$2 AND status NOT IN ('COMPLETED','DEAD')", [row.id, row.generation]);
      count++;
    }
    catch {
      await pool.query(`UPDATE job_outbox SET dispatch_failures=dispatch_failures+1,last_error='Redis publication failed',
        status=CASE WHEN dispatch_failures+1 >= $2 THEN 'DEAD' ELSE status END,next_dispatch_at=NOW()+($3::int*INTERVAL '1 millisecond')
        WHERE id=$1 AND generation=$4 AND status NOT IN ('COMPLETED','DEAD')`, [row.id, env.JOB_ATTEMPTS, jobBackoff(row.dispatch_failures + 1), row.generation]);
    }
  }
  return count;
};
export const startJobWorker = (pool: Pool, name = env.JOB_QUEUE_NAME, options: {
  lockDuration?: number;
  stalledInterval?: number;
} = {}) => {
  const worker = new Worker(name, async (job: Job<{
    outboxId: string;
  }>) => processOutboxJob(pool, job.data.outboxId), {
    connection: jobRedisConnection(true), concurrency: env.JOB_CONCURRENCY, maxStalledCount: 1, ...options,
  });
  worker.on('error', () => console.error(JSON.stringify({ source: 'jobs', event: 'worker-connection-error' })));
  return worker;
};
