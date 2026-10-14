<#
.SYNOPSIS
  Starts the local two-PostgreSQL-database sharding cluster and applies migrations.
.DESCRIPTION
  Provisions Shard 0 (port 5441) and Shard 1 (port 5442) using Docker Compose,
  waits for container health probes to pass, and applies schema migrations.
#>

Write-Host "`n[1/3] Starting Shard 0 and Shard 1 PostgreSQL containers..." -ForegroundColor Cyan
docker compose -f infrastructure/docker-compose.sharding.yml up -d

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to start sharding containers via Docker Compose."
    exit 1
}

Write-Host "`n[2/3] Waiting for shard health checks to pass..." -ForegroundColor Cyan
$maxAttempts = 15
$attempt = 0
$healthy = $false

while ($attempt -lt $maxAttempts -and -not $healthy) {
    $attempt++
    Start-Sleep -Seconds 2
    $s0 = docker inspect --format="{{.State.Health.Status}}" rota-postgres-shard-0 2>$null
    $s1 = docker inspect --format="{{.State.Health.Status}}" rota-postgres-shard-1 2>$null

    if ($s0 -eq "healthy" -and $s1 -eq "healthy") {
        $healthy = $true
        Write-Host "  ✓ Shard 0 (:5441) is healthy" -ForegroundColor Green
        Write-Host "  ✓ Shard 1 (:5442) is healthy" -ForegroundColor Green
    } else {
        Write-Host "  ... waiting for containers (attempt $attempt/$maxAttempts) [Shard 0: $s0, Shard 1: $s1]" -ForegroundColor Yellow
    }
}

if (-not $healthy) {
    Write-Error "Containers did not report healthy within the timeout window."
    exit 1
}

Write-Host "`n[3/3] Running migrations and sharding demonstration..." -ForegroundColor Cyan
npx ts-node apps/api/scripts/demo-sharding.ts

Write-Host "`nShard cluster is ready for testing! Run: npm run test:sharding" -ForegroundColor Green
