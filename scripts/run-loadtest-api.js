const { spawn } = require('child_process');
const path = require('path');

const enableRedisCache = process.argv.includes('--cache=true') ? 'true' : 'false';

process.env.TEAMS_RATE_LIMIT_MAX = '100000';
process.env.ENABLE_REDIS_CACHE = enableRedisCache;
process.env.PORT = '3000';
process.env.NODE_ENV = 'development';

console.log(`[runner] Launching API on port 3000 (ENABLE_REDIS_CACHE=${enableRedisCache}, TEAMS_RATE_LIMIT_MAX=100000)...`);

const apiPath = path.resolve(__dirname, '../apps/api/dist/index.js');
const child = spawn(process.execPath, [apiPath], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  console.log(`[runner] API process exited with code ${code}`);
  process.exit(code || 0);
});
