import { pool } from './db';
import { redisClient } from './redis';
import { env } from './env';
import { createJobQueue, dispatchOutbox, startJobWorker } from './services/job-runtime';
export const runWorker = async () => {
  await redisClient.connect();
  const queue = createJobQueue();
  const worker = startJobWorker(pool);
  let polling = false;
  const poll = async () => {
    if (polling)
      return;
    polling = true;
    try {
      await dispatchOutbox(pool, queue);
    }
    catch {
      console.error(JSON.stringify({ source: 'jobs', event: 'outbox-poll-error' }));
    }
    finally {
      polling = false;
    }
  };
  await poll();
  const timer = setInterval(() => { void poll(); }, env.JOB_POLL_MS);
  const close = async () => {
    clearInterval(timer); await worker.close(); await queue.close(); while (polling)
      await new Promise(resolve => setTimeout(resolve, 20)); await pool.end(); await redisClient.quit();
  };
  return { close };
};
if (require.main === module) {
  runWorker().then(({ close }) => {
    process.once('SIGTERM', () => { void close(); });
    process.once('SIGINT', () => { void close(); });
  }).catch(() => { console.error('Worker could not start'); process.exitCode = 1; });
}
