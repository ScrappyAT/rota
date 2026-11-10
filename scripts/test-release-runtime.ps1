param([string]$Image='rota-graduation-release:2026-11-10')
$ErrorActionPreference='Stop'
$releaseRoot=Split-Path $PSScriptRoot -Parent
Push-Location $releaseRoot
function Check-ReleaseExit([string]$Step){if($LASTEXITCODE -ne 0){throw "$Step failed"}}
$compose=@('compose','-f','infrastructure/docker-compose.release-smoke.yml')
try{
  $meta=@(& docker inspect rota-phase3-obs-postgres | ConvertFrom-Json)
  if(-not $meta[0].State.Running -or $meta[0].Config.Labels.'com.docker.compose.project' -ne 'rota-phase3-observability-tests'){throw 'Retained disposable Phase3 PostgreSQL required'}
  & docker run --name rota-release-dependencies-20261110 --network none --entrypoint node $Image scripts/runtime-dependencies.cjs
  Check-ReleaseExit 'Final image production dependency smoke'
  $config=@(& docker image inspect $Image | ConvertFrom-Json)[0].Config
  if(($config.Cmd -join ' ') -ne 'node apps/api/dist/index.js' -or $config.User -ne 'node' -or $config.Env -notcontains 'PORT=8080'){throw 'API-only CMD/unprivileged runtime/port contract failed'}
  $exists=& docker exec rota-phase3-obs-postgres psql -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='rota_release_smoke_20261110'"
  Check-ReleaseExit 'Inspect disposable smoke DB'
  if($exists){throw 'Release smoke DB already exists; retain it and inspect before rerunning'}
  & docker exec rota-phase3-obs-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE rota_release_smoke_20261110 TEMPLATE rota_r1_test'
  Check-ReleaseExit 'Clone pre-migrated disposable DB (no migration runner)'
  $digestSql="SELECT COUNT(*)::text||':'||md5(string_agg(name||executed_at::text,',' ORDER BY name)) FROM migrations"
  $before=& docker exec rota-phase3-obs-postgres psql -U postgres -d rota_release_smoke_20261110 -Atc $digestSql
  if(-not $before.StartsWith('9:')){throw 'Existing nine-migration schema required'}
  # Quarantine copied pending jobs; only the harmless smoke job is eligible.
  & docker exec rota-phase3-obs-postgres psql -U postgres -d rota_release_smoke_20261110 -v ON_ERROR_STOP=1 -c "UPDATE job_outbox SET next_dispatch_at='2100-01-01' WHERE status NOT IN ('COMPLETED','DEAD')"
  Check-ReleaseExit 'Isolate copied test jobs'
  & docker @compose up -d --wait api
  Check-ReleaseExit 'Final API startup'
  & docker @compose run --name rota-release-peer-20261110 --no-deps client -e "fetch('http://api:8080/health',{signal:AbortSignal.timeout(5000)}).then(async r=>{const b=await r.json();if(!r.ok||!b.success||b.data.db!=='ok'||b.data.redis!=='ok')throw new Error('Readiness failed');console.log('PASS peer HTTP readiness on 8080')}).catch(()=>{console.error('HTTP readiness failed');process.exitCode=1})"
  Check-ReleaseExit 'Peer HTTP health check'
  & docker @compose up -d worker
  Check-ReleaseExit 'Separate worker startup'
  & docker exec rota-phase3-obs-postgres psql -U postgres -d rota_release_smoke_20261110 -v ON_ERROR_STOP=1 -c "INSERT INTO job_outbox(event_key,kind,payload) VALUES('release-smoke-20261110','BILLING_RECHECK','{}')"
  Check-ReleaseExit 'Enqueue harmless cloned-DB job'
  $done=$false
  for($attempt=0;$attempt -lt 30;$attempt++){
    $state=& docker exec rota-phase3-obs-postgres psql -U postgres -d rota_release_smoke_20261110 -Atc "SELECT status FROM job_outbox WHERE event_key='release-smoke-20261110'"
    Check-ReleaseExit 'Inspect durable job'
    if($state -eq 'COMPLETED'){$done=$true;break}
    Start-Sleep -Seconds 1
  }
  if(-not $done){throw 'Separate worker did not complete harmless job'}
  $after=& docker exec rota-phase3-obs-postgres psql -U postgres -d rota_release_smoke_20261110 -Atc $digestSql
  if($before -ne $after){throw 'Migration metadata changed during API/worker startup'}
  Write-Output 'PASS separate worker completed durable job; migrations 001-009 unchanged; no migration runner executed'
}finally{
  & docker @compose stop api worker
  Pop-Location
  Write-Output 'Release smoke containers, database clone, network and volumes retained; nothing deleted'
}
