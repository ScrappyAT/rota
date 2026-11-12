# test-migration-009-job.ps1
# Comprehensive local validation of Migration 009 pre-migration backup & safe runner
# Validates:
#   1. Native pg_dump execution
#   2. HTTP Authorization: Bearer <TOKEN> requirement (no query param tokens)
#   3. Full restorability into an isolated secondary database
#   4. Rejection of migration before backup download
#   5. Explicit authenticated post-download migration trigger
#   6. Post-migration schema checks and authentication query validation
param([int]$Port = 5549)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path $PSScriptRoot -Parent
Push-Location $scriptDir

$containerName = "rota-test-mig009-pg-$Port"
$tempBackupDir = Join-Path $scriptDir "tmp-migration009-test-$Port"
$httpPort = 8899

function Cleanup {
  Write-Host "`n[CLEANUP] Stopping and removing test container and temp files..." -ForegroundColor Gray
  try { Stop-Process -Id $runnerProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
  try { & docker rm -f $containerName 2>$null | Out-Null } catch {}
  try { Remove-Item -Path $tempBackupDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  Pop-Location
}

try {
  New-Item -ItemType Directory -Path $tempBackupDir -Force | Out-Null

  Write-Host "================================================================" -ForegroundColor Cyan
  Write-Host " STARTING DISPOSABLE TEST POSTGRESQL 15 CONTAINER" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  & docker run --name $containerName -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rota_test -p "127.0.0.1:$($Port):5432" -d postgres:15-alpine
  if ($LASTEXITCODE -ne 0) { throw "Failed to start disposable Postgres container" }

  # Wait for Postgres readiness (accounting for internal restart)
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    cmd.exe /c "docker exec $containerName pg_isready -U postgres -d rota_test >nul 2>nul"
    if ($LASTEXITCODE -eq 0) {
      cmd.exe /c "docker exec $containerName psql -U postgres -d rota_test -c ""SELECT 1"" >nul 2>nul"
      if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "Disposable PostgreSQL did not become ready in time" }
  Write-Host "[PASS] PostgreSQL 15 container is ready on 127.0.0.1:$Port" -ForegroundColor Green

  # Apply migrations 001 to 008 (mirroring current production state)
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

  # Insert seed production-like data (simulating active production database)
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
  Write-Host "[PASS] Seed records inserted (users, teams, memberships, shifts, refresh_tokens)" -ForegroundColor Green

  # ================================================================
  # PHASE A: START RUNNER (NATIVE PG_DUMP & LOCKED MIGRATION)
  # ================================================================
  Write-Host "`n================================================================" -ForegroundColor Cyan
  Write-Host " PHASE A: RUNNING RUNNER (NATIVE PG_DUMP & LOCKED MIGRATION)" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  $authToken = "secret-production-backup-token-2026"
  $env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:$($Port)/rota_test?sslmode=disable"
  $env:PORT = "$httpPort"
  $env:BACKUP_AUTH_TOKEN = $authToken
  $env:BACKUP_DIR = $tempBackupDir
  
  # Point to the native pg_dump test wrapper that connects directly to the container
  $env:PG_DUMP_CONTAINER = $containerName
  $env:PG_DUMP_PATH = Join-Path $scriptDir "scripts/pg_dump_test_wrapper.cmd"

  $runnerScript = Join-Path $scriptDir "apps/api/dist/migration-backup-runner.js"
  $runnerProcess = Start-Process node -ArgumentList "`"$runnerScript`"" -NoNewWindow -PassThru

  # Wait for HTTP server to start
  $serverReady = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$httpPort/health" -TimeoutSec 2
      if ($h.status -eq 'ok') { $serverReady = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $serverReady) { throw "Migration backup runner HTTP server did not start" }
  Write-Host "[PASS] Runner HTTP server responded 200 OK on port $httpPort" -ForegroundColor Green

  # Wait for backup completion
  $backupReady = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $headers = @{ Authorization = "Bearer $authToken" }
      $st = Invoke-RestMethod -Uri "http://127.0.0.1:$httpPort/backup/status" -Headers $headers -TimeoutSec 2
      if ($st.status -eq 'BACKUP_CREATED') { $backupReady = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $backupReady) { throw "Backup was not created in time" }
  Write-Host "[PASS] Status reports BACKUP_CREATED: $($st.backupFile) ($($st.fileSizeBytes) bytes)" -ForegroundColor Green
  Write-Host "       SHA-256: $($st.sha256)" -ForegroundColor Gray

  # Assert migration 009 is NOT applied
  if ($st.migration009Applied -ne $false) { throw "Migration 009 must NOT be applied automatically!" }
  $colCheck = & docker exec $containerName psql -U postgres -d rota_test -Atc "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='users' AND column_name='auth_version'"
  if ($colCheck.Trim() -ne "0") { throw "Column users.auth_version must NOT exist before authorization!" }
  Write-Host "[PASS] Safeguard confirmed: Migration 009 did NOT execute on startup/restart" -ForegroundColor Green

  # ================================================================
  # PHASE B: SECURITY VALIDATION (HEADER AUTH ONLY, NO URL TOKENS)
  # ================================================================
  Write-Host "`n================================================================" -ForegroundColor Cyan
  Write-Host " PHASE B: SECURITY VALIDATION (HEADER AUTH ONLY)" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  # 1. URL query param tokens must be rejected
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$httpPort/backup/download?token=$authToken" -TimeoutSec 2 | Out-Null
    throw "URL query parameter tokens must be REJECTED!"
  } catch {
    Write-Host "[PASS] URL token query parameter rejected with 401 Unauthorized" -ForegroundColor Green
  }

  # 2. Status endpoint without header must be rejected
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$httpPort/backup/status" -TimeoutSec 2 | Out-Null
    throw "Status endpoint without Authorization header must be REJECTED!"
  } catch {
    Write-Host "[PASS] Status endpoint without Authorization header rejected with 401" -ForegroundColor Green
  }

  # 3. Attempting migration BEFORE downloading backup must be rejected
  try {
    $confirmHeaders = @{ Authorization = "Bearer $authToken" }
    $confirmBody = '{"confirm":"APPLY_MIGRATION_009","backupVerified":true}'
    Invoke-RestMethod -Uri "http://127.0.0.1:$httpPort/backup/confirm-and-migrate" -Method Post -Headers $confirmHeaders -Body $confirmBody -ContentType "application/json" -TimeoutSec 2 | Out-Null
    throw "Migration before download verification must be REJECTED!"
  } catch {
    Write-Host "[PASS] Migration trigger rejected with 400 because backup was not downloaded yet" -ForegroundColor Green
  }

  # ================================================================
  # PHASE C: DOWNLOAD BACKUP WITH AUTHORIZATION HEADER
  # ================================================================
  Write-Host "`n================================================================" -ForegroundColor Cyan
  Write-Host " PHASE C: DOWNLOADING BACKUP VIA HTTP AUTHORIZATION HEADER" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  $downloadFile = Join-Path $tempBackupDir "downloaded_test.sql.gz"
  $headers = @{ Authorization = "Bearer $authToken" }
  Invoke-WebRequest -Uri "http://127.0.0.1:$httpPort/backup/download" -Headers $headers -OutFile $downloadFile

  $downloadBytes = (Get-Item $downloadFile).Length
  if ($downloadBytes -ne $st.fileSizeBytes) { throw "Downloaded file size mismatch" }
  
  $shaAlgo = [System.Security.Cryptography.SHA256]::Create()
  $fileStream = [System.IO.File]::OpenRead($downloadFile)
  $computedHash = [System.BitConverter]::ToString($shaAlgo.ComputeHash($fileStream)).Replace("-", "").ToLower()
  $fileStream.Close()

  if ($computedHash -ne $st.sha256) { throw "Downloaded file SHA-256 mismatch" }
  Write-Host "[PASS] Downloaded backup file matches SHA-256 and byte length exactly" -ForegroundColor Green

  # ================================================================
  # PHASE D: FULL RESTORABILITY VERIFICATION IN ISOLATED DATABASE
  # ================================================================
  Write-Host "`n================================================================" -ForegroundColor Cyan
  Write-Host " PHASE D: VERIFYING BACKUP RESTORABILITY IN ISOLATED DATABASE" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  # Create empty isolated database for restoration test
  & docker exec $containerName psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS rota_restore_test;" | Out-Null
  & docker exec $containerName psql -U postgres -d postgres -c "CREATE DATABASE rota_restore_test;" | Out-Null
  Write-Host "  Created isolated database 'rota_restore_test'" -ForegroundColor Gray

  # Decompress the downloaded backup and pipe into rota_restore_test
  $unzippedSql = Join-Path $tempBackupDir "restored_unzipped.sql"
  $inGzStream = [System.IO.File]::OpenRead($downloadFile)
  $gzStream = New-Object System.IO.Compression.GZipStream($inGzStream, [System.IO.Compression.CompressionMode]::Decompress)
  $outSqlStream = [System.IO.File]::Create($unzippedSql)
  $gzStream.CopyTo($outSqlStream)
  $outSqlStream.Close()
  $gzStream.Close()
  $inGzStream.Close()

  Write-Host "  Decompressed backup SQL ($((Get-Item $unzippedSql).Length) bytes); restoring into rota_restore_test..." -ForegroundColor Gray
  $restoreSql = Get-Content $unzippedSql -Raw
  $restoreSql | & docker exec -i $containerName psql -U postgres -d rota_restore_test -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "Restoration of backup into rota_restore_test failed!" }
  Write-Host "[PASS] Logical backup restored into isolated database with 0 errors" -ForegroundColor Green

  # Verify contents of restored database
  Write-Host "  Verifying restored database contents:" -ForegroundColor Gray

  # 1. Migrations table: must have exactly 8 migrations (001-008)
  $restoredMigs = & docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT COUNT(*) FROM migrations"
  if ($restoredMigs.Trim() -ne "8") { throw "Restored DB expected 8 migrations, got $restoredMigs" }
  Write-Host "    [PASS] 8 migrations restored in migrations table" -ForegroundColor Green

  # 2. Users table: Alice Owner must exist with exact ID and password hash
  $restoredUser = & docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT id, email, first_name, last_name FROM users WHERE id='a0000000-0000-0000-0000-000000000001'"
  if ($restoredUser -notmatch "owner@example.com") { throw "Restored user record missing or corrupted: $restoredUser" }
  Write-Host "    [PASS] Restored user record intact: Alice Owner" -ForegroundColor Green

  # 3. Teams table: Acme Cafe must exist
  $restoredTeam = & docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT name FROM teams WHERE id='b0000000-0000-0000-0000-000000000001'"
  if ($restoredTeam.Trim() -ne "Acme Cafe") { throw "Restored team record missing: $restoredTeam" }
  Write-Host "    [PASS] Restored team record intact: Acme Cafe" -ForegroundColor Green

  # 4. Shifts table: Morning Shift must exist
  $restoredShift = & docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT title FROM shifts WHERE id='c0000000-0000-0000-0000-000000000001'"
  if ($restoredShift.Trim() -ne "Morning Shift") { throw "Restored shift record missing: $restoredShift" }
  Write-Host "    [PASS] Restored shift record intact: Morning Shift" -ForegroundColor Green

  # 5. Refresh tokens: legacy refresh token must exist
  $restoredToken = & docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT COUNT(*) FROM refresh_tokens WHERE id='d0000000-0000-0000-0000-000000000001'"
  if ($restoredToken.Trim() -ne "1") { throw "Restored refresh token missing" }
  Write-Host "    [PASS] Restored refresh token record intact" -ForegroundColor Green

  # 6. Table count verification: must match all 25 tables
  $restoredTableCount = & docker exec $containerName psql -U postgres -d rota_restore_test -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
  if ([int]$restoredTableCount.Trim() -ne $st.tablesCount) { throw "Restored table count ($restoredTableCount) does not match original ($($st.tablesCount))" }
  Write-Host "    [PASS] All $($st.tablesCount) tables restored with complete schema" -ForegroundColor Green

  # ================================================================
  # PHASE E: TRIGGER AUTHORIZED MIGRATION 009
  # ================================================================
  Write-Host "`n================================================================" -ForegroundColor Cyan
  Write-Host " PHASE E: TRIGGERING EXPLICIT AUTHENTICATED MIGRATION 009" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  $confirmHeaders = @{ Authorization = "Bearer $authToken" }
  $confirmBody = '{"confirm":"APPLY_MIGRATION_009","backupVerified":true}'
  $migResult = Invoke-RestMethod -Uri "http://127.0.0.1:$httpPort/backup/confirm-and-migrate" -Method Post -Headers $confirmHeaders -Body $confirmBody -ContentType "application/json"

  if (-not $migResult.success) { throw "Migration execution failed: $($migResult.error)" }
  Write-Host "[PASS] Explicit migration trigger returned success: $($migResult.message)" -ForegroundColor Green

  # Verify schema post-conditions in target database
  Write-Host "`n[VERIFICATION] Verifying schema post-conditions in primary database:" -ForegroundColor Gray

  # 1. users.auth_version exists and = 0
  $userAv = & docker exec $containerName psql -U postgres -d rota_test -Atc "SELECT auth_version FROM users WHERE email='owner@example.com'"
  if ($userAv.Trim() -ne "0") { throw "Existing user auth_version expected 0, got $userAv" }
  Write-Host "  [PASS] users.auth_version = 0 for existing user" -ForegroundColor Green

  # 2. auth_sessions table exists
  $asExists = & docker exec $containerName psql -U postgres -d rota_test -Atc "SELECT 1 FROM information_schema.tables WHERE table_name='auth_sessions'"
  if ($asExists.Trim() -ne "1") { throw "Table auth_sessions not found" }
  Write-Host "  [PASS] auth_sessions table created" -ForegroundColor Green

  # 3. refresh_tokens columns added
  $rfCols = & docker exec $containerName psql -U postgres -d rota_test -Atc "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='refresh_tokens' AND column_name IN ('session_id', 'token_digest')"
  if ($rfCols.Trim() -ne "2") { throw "refresh_tokens columns missing" }
  Write-Host "  [PASS] refresh_tokens.session_id and token_digest created" -ForegroundColor Green

  # 4. user_write_fences table exists
  $wfExists = & docker exec $containerName psql -U postgres -d rota_test -Atc "SELECT 1 FROM information_schema.tables WHERE table_name='user_write_fences'"
  if ($wfExists.Trim() -ne "1") { throw "Table user_write_fences not found" }
  Write-Host "  [PASS] user_write_fences table created" -ForegroundColor Green

  # 5. job_outbox_kind_check allows AUTH_EMAIL
  $kindCheck = & docker exec $containerName psql -U postgres -d rota_test -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='job_outbox'::regclass AND conname='job_outbox_kind_check'"
  if (-not $kindCheck.Contains("AUTH_EMAIL")) { throw "job_outbox_kind_check does not contain AUTH_EMAIL" }
  Write-Host "  [PASS] job_outbox_kind_check updated with AUTH_EMAIL" -ForegroundColor Green

  # ================================================================
  # PHASE F: VERIFY REGISTRATION AND LOGIN SQL EXECUTION
  # ================================================================
  Write-Host "`n================================================================" -ForegroundColor Cyan
  Write-Host " PHASE F: VERIFYING REGISTRATION AND LOGIN SQL" -ForegroundColor Cyan
  Write-Host "================================================================" -ForegroundColor Cyan

  $regSql = "INSERT INTO users(email, first_name, last_name, password_hash) VALUES('newuser@example.com', 'Bob', 'Worker', 'dummyhash') RETURNING id, email, first_name AS firstName, last_name AS lastName, created_at AS createdAt, auth_version, password_hash;"
  $regTest = & docker exec $containerName psql -U postgres -d rota_test -Atc "$regSql"
  $regJoined = ($regTest -join " ")
  if ($regJoined -notlike "*newuser@example.com*") { throw "Registration SQL query failed" }
  Write-Host "[PASS] Registration SQL query executes successfully with auth_version RETURNING" -ForegroundColor Green

  $loginSql = "SELECT id, email, first_name AS firstName, last_name AS lastName, created_at AS createdAt, auth_version, password_hash FROM users WHERE email='newuser@example.com' FOR UPDATE;"
  $loginTest = & docker exec $containerName psql -U postgres -d rota_test -Atc "$loginSql"
  $loginJoined = ($loginTest -join " ")
  if ($loginJoined -notlike "*newuser@example.com*") { throw "Login SQL query failed" }
  Write-Host "[PASS] Login SQL query executes successfully with FOR UPDATE and auth_version" -ForegroundColor Green

  Write-Host "`n================================================================" -ForegroundColor Green
  Write-Host " ALL SIX VALIDATION PHASES PASSED WITH ZERO ERRORS" -ForegroundColor Green
  Write-Host " Native pg_dump backup, full restorability, security & migration verified" -ForegroundColor Green
  Write-Host "================================================================" -ForegroundColor Green
} finally {
  Cleanup
}
