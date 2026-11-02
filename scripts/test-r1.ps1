# Requires disposable containers rota-r1-test-postgres/redis/shard-0/shard-1.
# Never reads the repository DATABASE_URL; all connections are pinned below.
$ErrorActionPreference = 'Stop'
$env:NODE_ENV = 'test'
$env:DATABASE_URL = 'postgres://postgres:r1-disposable-only@127.0.0.1:5540/rota_r1_test'
$env:REDIS_URL = 'redis://127.0.0.1:6480'
$env:SHARD_0_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5541/rota_r1_shard_0'
$env:SHARD_1_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5542/rota_r1_shard_1'
$env:FLW_SECRET_KEY = 'r1-mocked-provider-only'
$env:FLW_PUBLIC_KEY = 'r1-mocked-provider-only'
$env:FLW_SECRET_HASH = 'r1-mocked-provider-only'
$env:FLW_ENV = 'sandbox'
$env:FLW_BASE_URL = 'http://127.0.0.1:9'
$env:EXPO_PUSH_URL = 'http://127.0.0.1:9'
$env:AUTH_RATE_LIMIT_MAX = '100'
$env:TEAMS_RATE_LIMIT_MAX = '300'
$env:INVITATIONS_RATE_LIMIT_MAX = '300'
$env:TS_NODE_PROJECT = 'apps/api/tsconfig.json'
node -r ts-node/register apps/api/src/migrate.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Push-Location apps/api
try {
  if ($args.Count) {
    node ../../node_modules/jest/bin/jest.js --runInBand @args
  } else {
    npm test -- --runInBand
  }
  $testExit = $LASTEXITCODE
} finally { Pop-Location }
exit $testExit
