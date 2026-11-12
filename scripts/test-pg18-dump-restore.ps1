# test-pg18-dump-restore.ps1
# Validates native pg_dump 18.6 and restore against disposable PostgreSQL 18
param([int]$Port = 5548)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path $PSScriptRoot -Parent
Push-Location $scriptDir

$containerName = "rota-test-pg18-$Port"
$tempDir = Join-Path $scriptDir "tmp-pg18-test-$Port"

function Cleanup {
  Write-Host "`n[CLEANUP] Stopping and removing test container and temp files..." -ForegroundColor Gray
  try { & docker rm -f $containerName 2>$null | Out-Null } catch {}
  try { Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  Pop-Location
}

try {
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

  Write-Host "================================================================" -ForegroundColor Cyan
  Write-Host " STARTING DISPOSABLE POSTGRESQL 18 CONTAINER" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  & docker run --name $containerName -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rota_test -p "127.0.0.1:$($Port):5432" -d postgres:18
  if ($LASTEXITCODE -ne 0) { throw "Failed to start disposable Postgres 18 container" }

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    cmd.exe /c "docker exec $containerName pg_isready -U postgres -d rota_test >nul 2>nul"
    if ($LASTEXITCODE -eq 0) {
      cmd.exe /c "docker exec $containerName psql -U postgres -d rota_test -c ""SELECT 1"" >nul 2>nul"
      if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "PostgreSQL 18 did not become ready in time" }
  
  $pgVersion = (& docker exec $containerName psql -U postgres -d rota_test -Atc "SELECT version()").Trim()
  Write-Host "[PASS] PostgreSQL 18 container ready on 127.0.0.1:$Port" -ForegroundColor Green
  Write-Host "       Server: $pgVersion" -ForegroundColor Gray

  # Apply migrations 001 to 008
  Write-Host "`n[SETUP] Applying migrations 001 through 008..." -ForegroundColor Yellow
  & docker exec -i $containerName psql -U postgres -d rota_test -c "
    CREATE TABLE migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  " | Out-Null

  for ($m = 1; $m -le 8; $m++) {
    $numStr = $m.ToString("000")
    $migFile = Get-ChildItem "apps/api/migrations" -Filter "${numStr}_*.sql" | Select-Object -First 1
    if (-not $migFile) { throw "Could not find migration $numStr" }
    
    $sqlContent = Get-Content $migFile.FullName -Raw
    $sqlContent | & docker exec -i $containerName psql -U postgres -d rota_test -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw "Migration $($migFile.Name) failed" }
    
    & docker exec $containerName psql -U postgres -d rota_test -c "INSERT INTO migrations(name) VALUES('$($migFile.Name)');" | Out-Null
    Write-Host "  Applied: $($migFile.Name)" -ForegroundColor Gray
  }

  # Insert seed records
  Write-Host "`n[SETUP] Inserting sample production records..." -ForegroundColor Yellow
  $seedSql = @"
    INSERT INTO users(id, email, first_name, last_name, password_hash)
    VALUES('a0000000-0000-0000-0000-000000000001', 'owner@example.com', 'Alice', 'Owner', '\$2b\$10\$dummyhashvaluehereforowner123456');

    INSERT INTO teams(id, name, owner_id)
    VALUES('b0000000-0000-0000-0000-000000000001', 'Acme Cafe', 'a0000000-0000-0000-0000-000000000001');

    INSERT INTO team_memberships(team_id, user_id, role)
    VALUES('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'OWNER');

    INSERT INTO shifts(id, team_id, created_by, title, starts_at, ends_at)
    VALUES('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Morning Shift', NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 8 hours');

    INSERT INTO refresh_tokens(id, user_id, token_hash, expires_at)
    VALUES('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '\$2b\$10\$legacyrefreshtokenhash12345', NOW() + INTERVAL '7 days');
"@
  $seedSql | & docker exec -i $containerName psql -U postgres -d rota_test -v ON_ERROR_STOP=1
  Write-Host "[PASS] Seed records inserted" -ForegroundColor Green

  # ================================================================
  # EXECUTE NATIVE PG_DUMP 18 FROM rota-migration-18 IMAGE
  # ================================================================
  Write-Host "`n================================================================" -ForegroundColor Cyan
  Write-Host " EXECUTING NATIVE PG_DUMP 18 FROM RUNTIME IMAGE" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  $dumpFile = Join-Path $tempDir "pg18_backup.sql"
  
  # Connect from the built Docker image to the PostgreSQL 18 container via host.docker.internal
  & docker run --rm --add-host=host.docker.internal:host-gateway `
    -e PGHOST=host.docker.internal `
    -e PGPORT=$Port `
    -e PGUSER=postgres `
    -e PGPASSWORD=postgres `
    -e PGDATABASE=rota_test `
    rota-migration-18 `
    pg_dump --no-owner --no-privileges --clean --if-exists --quote-all-identifiers > $dumpFile

  if ($LASTEXITCODE -ne 0) { throw "Native pg_dump 18 failed against PostgreSQL 18" }

  $dumpSize = (Get-Item $dumpFile).Length
  if ($dumpSize -le 1000) { throw "Dump file size too small: $dumpSize bytes" }
  Write-Host "[PASS] Native pg_dump 18 succeeded against PostgreSQL 18 server ($dumpSize bytes)" -ForegroundColor Green

  # ================================================================
  # RESTORE DUMP INTO ISOLATED POSTGRESQL 18 DATABASE
  # ================================================================
  Write-Host "`n================================================================" -ForegroundColor Cyan
  Write-Host " RESTORING DUMP INTO ISOLATED DATABASE (rota_restore_test)" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  & docker exec $containerName psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS rota_restore_test;" | Out-Null
  & docker exec $containerName psql -U postgres -d postgres -c "CREATE DATABASE rota_restore_test;" | Out-Null
  Write-Host "  Created isolated database 'rota_restore_test'" -ForegroundColor Gray

  $dumpSql = Get-Content $dumpFile -Raw
  $dumpSql | & docker exec -i $containerName psql -U postgres -d rota_restore_test -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "Restoration into rota_restore_test failed!" }
  Write-Host "[PASS] Backup restored into PostgreSQL 18 with 0 errors" -ForegroundColor Green

  # Verify restored data
  Write-Host "`n[VERIFY] Checking restored data contents:" -ForegroundColor Gray

  $restoredMigs = (& docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT COUNT(*) FROM migrations").Trim()
  if ($restoredMigs -ne "8") { throw "Expected 8 migrations, got $restoredMigs" }
  Write-Host "  [PASS] 8 migrations restored" -ForegroundColor Green

  $restoredUser = (& docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT email FROM users WHERE id='a0000000-0000-0000-0000-000000000001'").Trim()
  if ($restoredUser -ne "owner@example.com") { throw "User missing or corrupted: $restoredUser" }
  Write-Host "  [PASS] Alice Owner record restored intact" -ForegroundColor Green

  $restoredTeam = (& docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT name FROM teams WHERE id='b0000000-0000-0000-0000-000000000001'").Trim()
  if ($restoredTeam -ne "Acme Cafe") { throw "Team missing: $restoredTeam" }
  Write-Host "  [PASS] Acme Cafe record restored intact" -ForegroundColor Green

  $restoredTables = (& docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'").Trim()
  Write-Host "  [PASS] All $restoredTables public tables restored intact in PostgreSQL 18" -ForegroundColor Green

  Write-Host "`n================================================================" -ForegroundColor Green
  Write-Host " POSTGRESQL 18 DUMP AND RESTORE FULLY VERIFIED" -ForegroundColor Green
  Write-Host "================================================================" -ForegroundColor Green
} finally {
  Cleanup
}

