// Read-only validation of the retained disposable schema; never migrate automatically.
const {Pool}=require('pg');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
 const urls=[process.env.DATABASE_URL,process.env.SHARD_0_DATABASE_URL,process.env.SHARD_1_DATABASE_URL];
 const expected=fs.readdirSync(path.resolve(__dirname,'../apps/api/migrations')).filter(n=>n.endsWith('.sql')).sort();
 for(const value of urls){
  const url=new URL(value);if(url.hostname!=='127.0.0.1'||!['5540','5541','5542'].includes(url.port)||!url.pathname.startsWith('/rota_r1_'))throw new Error('Named disposable databases only');
  const pool=new Pool({connectionString:value});try{
   const rows=(await pool.query('SELECT name FROM migrations ORDER BY name')).rows.map(r=>r.name);
   if(JSON.stringify(rows)!==JSON.stringify(expected))throw new Error('Disposable schema must already contain 001-009; no automatic migrations allowed');
   console.log('PASS existing disposable schema metadata on port '+url.port);
  }finally{await pool.end();}
 }
})().catch(()=>{console.error('Existing disposable schema check failed; no migration was attempted');process.exitCode=1});
