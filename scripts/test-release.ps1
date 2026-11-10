param([switch]$IncludeMigrationSafetyTests)
# Requires the isolated docker-compose.phase3-tests.yml stack; never deletes containers or volumes.
# Never reads the repository DATABASE_URL; all connections are pinned below.
$ErrorActionPreference = 'Stop'

# Fail before any migration/test if the required uniquely named disposable stack is absent.
foreach ($phase3Service in @('postgres', 'redis', 'shard-0', 'shard-1', 'replica')) {
  $phase3Metadata = @(& docker inspect "rota-phase3-obs-$phase3Service" | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or -not $phase3Metadata[0].State.Running -or $phase3Metadata[0].Config.Labels.'com.docker.compose.project' -ne 'rota-phase3-observability-tests') {
    throw 'Start only the named disposable Phase 3 test stack before running tests.'
  }
}

$env:NODE_ENV = 'test'
$env:SENTRY_DSN = ''
$env:EXPO_PUBLIC_SENTRY_DSN = ''
$env:SENTRY_AUTH_TOKEN = ''
$env:DATABASE_URL = 'postgres://postgres:r3-disposable-only@127.0.0.1:5540/rota_r1_test'
$env:REDIS_URL = 'redis://127.0.0.1:6480'
$env:SHARD_0_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5541/rota_r1_shard_0'
$env:SHARD_1_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5542/rota_r1_shard_1'
$env:FLW_SECRET_KEY = 'r3-mocked-provider-only'
$env:FLW_PUBLIC_KEY = 'r3-mocked-provider-only'
$env:FLW_SECRET_HASH = 'r3-mocked-provider-only'
$env:FLW_ENV = 'sandbox'
$env:FLW_BASE_URL = 'http://127.0.0.1:9'
$env:EXPO_PUSH_URL = 'http://127.0.0.1:9'
$env:EXPO_PUSH_RECEIPTS_URL = 'http://127.0.0.1:9'
$env:AUTH_RATE_LIMIT_MAX = '10000'
$env:TEAMS_RATE_LIMIT_MAX = '10000'
$env:INVITATIONS_RATE_LIMIT_MAX = '10000'
$env:JOB_ATTEMPTS = '3'
$env:JOB_BACKOFF_MS = '20'
$env:JOB_POLL_MS = '50'
$env:JOB_QUEUE_NAME = 'rota-phase3-tests'
$env:JOB_CONCURRENCY = '2'
$env:AUTH_MAIL_KEY = '1111111111111111111111111111111111111111111111111111111111111111'
$env:MAIL_API_URL = 'http://127.0.0.1:9'
$env:MAIL_API_KEY = 'r3-mocked-mail-only'
$env:MAIL_FROM = 'test@rota.invalid'
$env:READ_DATABASE_URL = 'postgres://postgres:r3-disposable-only@127.0.0.1:5540/rota_r1_test'
$env:TS_NODE_PROJECT = 'apps/api/tsconfig.json'
# Pre-migrated disposable schema is inspected; no migrator is invoked here.
node scripts/verify-release-test-schema.cjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Push-Location apps/api
try {
  if ($args.Count) {
    node ../../node_modules/jest/bin/jest.js --runInBand @args
  } else {
    Pop-Location
    try {
      if ($IncludeMigrationSafetyTests) { npm test -- -- --silent }
      else { npm test -- -- --silent '--testPathIgnorePatterns=billingMigration|r2Migration|r3Migration|sharding.test' }
    } finally { Push-Location apps/api }
  }
  $testExit = $LASTEXITCODE
} finally { Pop-Location }
exit $testExit
