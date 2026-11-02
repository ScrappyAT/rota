import { Worker } from 'bullmq';
import { pool } from '../../src/db';
import { jobRedisConnection, startJobWorker } from '../../src/services/job-runtime';
const url = new URL(process.env.DATABASE_URL!);
if (!process.send || process.env.R2_DRILL_CHILD !== 'true' || url.hostname !== '127.0.0.1' || url.port !== '5540' || url.pathname !== '/rota_r1_test')
  throw new Error('Disposable IPC failure drill only');
const name = process.env.R2_DRILL_QUEUE!;
if (process.env.R2_DRILL_MODE === 'before') {
  const worker = new Worker(name, async () => { process.send!('claimed'); await new Promise(() => { }); }, { connection: jobRedisConnection(true), lockDuration: 500, stalledInterval: 250 });
  worker.on('error', () => { });
}
else {
  globalThis.fetch = async () => { process.send!('at-provider'); return new Promise(() => { }); };
  startJobWorker(pool, name, { lockDuration: 500, stalledInterval: 250 });
}
