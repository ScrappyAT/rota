<#
.SYNOPSIS
  Stops and tears down the local two-PostgreSQL-database sharding cluster.
#>

Write-Host "`nTearing down Shard 0 and Shard 1 containers..." -ForegroundColor Cyan
docker compose -f infrastructure/docker-compose.sharding.yml down

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Sharding cluster stopped successfully." -ForegroundColor Green
} else {
    Write-Error "Failed to stop sharding cluster."
}
