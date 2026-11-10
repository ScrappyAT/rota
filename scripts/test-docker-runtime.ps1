param(
  [string]$Image = 'rota-runtime-repair:local',
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Split-Path $PSScriptRoot -Parent
$composeFile = Join-Path $runtimeRoot 'infrastructure/docker-compose.runtime-smoke.yml'
$composeArgs = @('compose', '--project-name', 'rota-runtime-smoke', '-f', $composeFile)
$allProfiles = $composeArgs + @('--profile', 'workers', '--profile', 'tools')
$savedImage = $env:ROTA_RUNTIME_IMAGE
$started = $false
function Check-Exit([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw "$step failed (exit $LASTEXITCODE)" }
}
Push-Location $runtimeRoot
try {
  $env:ROTA_RUNTIME_IMAGE = $Image
  if (-not $SkipBuild) {
    & docker build --progress=plain -t $Image .
    Check-Exit 'Production image build'
  }
  # No network, bind mounts, credentials or DB access during dependency imports.
  & docker run --rm --network none --entrypoint node $Image scripts/runtime-dependencies.cjs
  Check-Exit 'Final-image dependency smoke'
  $imageConfig = (& docker image inspect $Image | ConvertFrom-Json)[0].Config
  if (($imageConfig.Cmd -join ' ') -ne 'node apps/api/dist/index.js') { throw 'Image CMD must start API without migrations' }
  if ($imageConfig.User -ne 'node') { throw 'Runtime must remain unprivileged' }
  if ($imageConfig.Env -notcontains 'PORT=8080') { throw 'Image default must match Railway target 8080' }
  $existing = @(& docker @allProfiles ps -aq)
  Check-Exit 'Check disposable stack ownership'
  if ($existing.Count) { throw 'An existing rota-runtime-smoke stack exists; inspect it before running this destructive test' }
  $started = $true
  & docker @composeArgs up -d --wait --wait-timeout 90 postgres redis api
  Check-Exit 'Isolated API startup'
  # A peer HTTP client tests the listening interface and target port without
  # opening any host ports or giving the disposable services external access.
  & docker @composeArgs run --rm --no-deps --entrypoint node migrate -e "fetch('http://api:8080/health',{signal:AbortSignal.timeout(5000)}).then(async r=>{const b=await r.json();if(!r.ok||!b.success||b.data.db!=='ok'||b.data.redis!=='ok')throw new Error('API readiness failed');console.log('PASS peer HTTP client reached API on port 8080')}).catch(e=>{console.error(e.message);process.exitCode=1})"
  Check-Exit 'API readiness from separate container on target 8080'
  $tables = & docker @composeArgs exec -T postgres psql -U postgres -d rota_runtime_smoke -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'"
  Check-Exit 'Check API does not migrate on startup'
  if ($tables.Trim() -ne '0') { throw 'API startup unexpectedly created database tables' }
  Write-Output 'PASS API health on 8080 with zero schema tables: no automatic migration'
  # Only this named disposable database can receive migrations from this runner.
  & docker @composeArgs run --rm --no-deps migrate
  Check-Exit 'Explicit disposable migration job'
  $migrations = & docker @composeArgs exec -T postgres psql -U postgres -d rota_runtime_smoke -Atc 'SELECT COUNT(*) FROM migrations'
  Check-Exit 'Verify disposable migration count'
  if ($migrations.Trim() -ne '9') { throw 'Expected migrations 001-009' }
  & docker @composeArgs up -d worker
  Check-Exit 'Separate worker startup'
  & docker @composeArgs exec -T postgres psql -U postgres -d rota_runtime_smoke -v ON_ERROR_STOP=1 -c "INSERT INTO job_outbox(event_key,kind,payload) VALUES('runtime-smoke','DOMAIN_EVENT','{}')"
  Check-Exit 'Enqueue harmless disposable job'
  $completed = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $state = & docker @composeArgs exec -T postgres psql -U postgres -d rota_runtime_smoke -Atc "SELECT status FROM job_outbox WHERE event_key='runtime-smoke'"
    Check-Exit 'Check worker result'
    if ($state.Trim() -eq 'COMPLETED') { $completed = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $completed) { throw 'Separate worker did not complete the harmless outbox job' }
  Write-Output 'PASS separate BullMQ worker completed durable job; 9 disposable migrations applied explicitly'
  Write-Output 'Docker runtime smoke passed with dummy credentials and isolated internal networking.'
} finally {
  $cleanupFailed = $false
  if ($started) {
    & docker @composeArgs logs --no-color --tail 15 api worker
    # Include profiled services so the worker stops before its DB/Redis, and no
    # exited worker is left behind or ignored by the next ownership check.
    & docker @allProfiles down --volumes --remove-orphans
    if ($LASTEXITCODE -ne 0) { $cleanupFailed = $true }
    $leftover = @(& docker @allProfiles ps -aq)
    if ($LASTEXITCODE -ne 0 -or $leftover.Count) { $cleanupFailed = $true }
  }
  $env:ROTA_RUNTIME_IMAGE = $savedImage
  Pop-Location
  if ($cleanupFailed) { throw 'Disposable runtime cleanup failed; inspect rota-runtime-smoke' }
}
