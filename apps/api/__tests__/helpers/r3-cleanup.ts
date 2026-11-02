import { createClient } from 'redis';
// Redis limits persist across processes. Isolate serial suites by clearing only
// limiter keys on the named disposable service, never cache/jobs/financial data.
beforeEach(async()=>{
  if(process.env.REDIS_URL!=='redis://127.0.0.1:6480')return;
  const c=createClient({url:process.env.REDIS_URL});await c.connect();
  try{for await(const key of c.scanIterator({MATCH:'rl:*'}))await c.del(key);}finally{await c.quit();}
});
// Every Jest file owns its own module graph/pools. Close only its replica pool.
afterAll(async()=>{const {replicaPool}=await import('../../src/services/read-routing');await replicaPool?.end();});
