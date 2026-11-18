import { Pool, PoolClient } from 'pg';
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { spawn, execSync } from 'child_process';

interface TableInventory {
  name: string;
  rowCount: number;
}

interface BackupState {
  status: 'INITIALIZING' | 'BACKUP_IN_PROGRESS' | 'BACKUP_CREATED' | 'MIGRATION_IN_PROGRESS' | 'MIGRATION_COMPLETE' | 'ERROR';
  fileName?: string;
  filePath?: string;
  fileSizeBytes?: number;
  sha256?: string;
  tables: TableInventory[];
  appliedMigrations: string[];
  migration009Applied: boolean;
  downloadCount: number;
  errorMessage?: string;
  createdAt?: string;
  completedAt?: string;
}

const state: BackupState = {
  status: 'INITIALIZING',
  tables: [],
  appliedMigrations: [],
  migration009Applied: false,
  downloadCount: 0,
};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL environment variable is required');
  process.exit(1);
}

const BACKUP_AUTH_TOKEN = (process.env.BACKUP_AUTH_TOKEN || '').trim();
if (!BACKUP_AUTH_TOKEN || BACKUP_AUTH_TOKEN.length < 16) {
  console.error('[FATAL] BACKUP_AUTH_TOKEN environment variable must be set with at least 16 characters');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '8080', 10);
const PG_DUMP_PATH = process.env.PG_DUMP_PATH || 'pg_dump';

const BACKUP_DIR = process.env.BACKUP_DIR || '/tmp';
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function sanitizeDbUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return 'postgres://[sanitized]';
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

function verifyPgDumpBinary(): string {
  try {
    const versionOutput = execSync(`"${PG_DUMP_PATH}" --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    console.log(`[PG_DUMP] Verified native utility: ${versionOutput}`);
    return versionOutput;
  } catch (err: any) {
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`[FATAL] Native pg_dump utility check failed at '${PG_DUMP_PATH}': ${err.message}. A valid native pg_dump utility is required.`);
  }
}

async function inspectDatabase(client: PoolClient) {
  const metaRes = await client.query('SELECT current_database() as db, version() as version');
  console.log(`[DIAGNOSTIC] Connected to database: ${metaRes.rows[0].db}`);
  console.log(`[DIAGNOSTIC] Engine: ${metaRes.rows[0].version}`);

  const hasMigrationsTable = (await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'migrations'
    ) as exists
  `)).rows[0].exists;

  if (hasMigrationsTable) {
    const migRes = await client.query<{ name: string }>('SELECT name FROM migrations ORDER BY id ASC');
    state.appliedMigrations = migRes.rows.map(r => r.name);
    state.migration009Applied = state.appliedMigrations.includes('009_auth_security_routing.sql');
    console.log(`[DIAGNOSTIC] Applied migrations (${state.appliedMigrations.length}): ${state.appliedMigrations.join(', ')}`);
  } else {
    state.appliedMigrations = [];
    state.migration009Applied = false;
    console.log('[DIAGNOSTIC] Notice: migrations table does not exist yet');
  }

  const tablesRes = await client.query<{ table_name: string }>(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC
  `);

  state.tables = [];
  for (const row of tablesRes.rows) {
    try {
      const countRes = await client.query(`SELECT COUNT(*)::int as count FROM "${row.table_name}"`);
      state.tables.push({ name: row.table_name, rowCount: countRes.rows[0].count });
    } catch {
      state.tables.push({ name: row.table_name, rowCount: -1 });
    }
  }

  console.log(`[DIAGNOSTIC] Public tables found (${state.tables.length}):`);
  for (const t of state.tables) {
    console.log(`  - ${t.name}: ${t.rowCount} rows`);
  }
}

async function dumpWithNativePgDump(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('[BACKUP] Executing native pg_dump logical backup...');
    const args = [
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      '--quote-all-identifiers',
    ];

    let pgEnv = { ...process.env };
    try {
      const parsed = new URL(DATABASE_URL!);
      pgEnv = {
        ...pgEnv,
        PGHOST: parsed.hostname,
        PGPORT: parsed.port || '5432',
        PGUSER: parsed.username,
        PGPASSWORD: parsed.password,
        PGDATABASE: parsed.pathname.slice(1),
      };
    } catch (e) {
      void e;
    }

    let child;
    try {
      const command = process.platform === 'win32' && PG_DUMP_PATH.includes(' ') && !PG_DUMP_PATH.startsWith('"')
        ? `"${PG_DUMP_PATH}"`
        : PG_DUMP_PATH;
      child = spawn(command, args, {
        env: pgEnv,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      return reject(new Error(`Failed to spawn pg_dump: ${err.message}`));
    }

    const gzip = zlib.createGzip({ level: 9 });
    const outStream = fs.createWriteStream(outputPath);

    child.stdout.pipe(gzip).pipe(outStream);

    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) { void e; }
      reject(new Error(`pg_dump process error: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        outStream.on('finish', () => {
          console.log('[BACKUP] Native pg_dump completed successfully');
          resolve();
        });
        outStream.on('error', reject);
      } else {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) { void e; }
        reject(new Error(`pg_dump failed with exit code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function createLogicalBackup(): Promise<{ fileName: string; filePath: string; size: number; sha256: string }> {
  state.status = 'BACKUP_IN_PROGRESS';
  state.createdAt = new Date().toISOString();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `rota_production_pre009_${timestamp}.sql.gz`;
  const filePath = path.join(BACKUP_DIR, fileName);

  console.log(`[BACKUP] Output path: ${filePath}`);

  // Native pg_dump is required; fail safely if it fails
  await dumpWithNativePgDump(filePath);

  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    throw new Error('Created backup file has 0 bytes length');
  }

  const fileBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Verify gzip decompression integrity
  try {
    zlib.gunzipSync(fileBuffer.subarray(0, Math.min(fileBuffer.length, 65536)));
  } catch (err: any) {
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Gzip decompression check failed: ${err.message}`);
  }

  state.status = 'BACKUP_CREATED';
  state.fileName = fileName;
  state.filePath = filePath;
  state.fileSizeBytes = stat.size;
  state.sha256 = sha256;

  console.log('================================================================');
  console.log('[BACKUP SUCCESS] Native pg_dump logical backup generated and verified:');
  console.log(`  File:         ${fileName}`);
  console.log(`  Size:         ${stat.size} bytes (${(stat.size / 1024).toFixed(2)} KB)`);
  console.log(`  SHA-256:      ${sha256}`);
  console.log(`  Tables Saved: ${state.tables.length}`);
  console.log('================================================================');

  return { fileName, filePath, size: stat.size, sha256 };
}

async function applyMigration009(): Promise<{ success: boolean; message: string }> {
  if (state.status !== 'BACKUP_CREATED' && state.status !== 'MIGRATION_COMPLETE') {
    throw new Error('Refusing to migrate: Pre-migration backup has not been created and verified.');
  }

  if (state.downloadCount === 0) {
    throw new Error('Refusing to migrate: Pre-migration backup has not been downloaded for independent verification yet. Please download the backup via GET /backup/download first.');
  }

  if (!state.filePath || !fs.existsSync(state.filePath) || state.fileSizeBytes! <= 0) {
    throw new Error('Refusing to migrate: Verified backup file is missing or empty.');
  }

  state.status = 'MIGRATION_IN_PROGRESS';
  const client = await pool.connect();

  try {
    console.log('[MIGRATION] Acquiring PostgreSQL advisory lock (20261111009)...');
    await client.query('SELECT pg_advisory_lock(20261111009)');

    const checkRes = await client.query('SELECT name FROM migrations WHERE name = $1', ['009_auth_security_routing.sql']);
    if (checkRes.rows.length > 0) {
      console.log('[MIGRATION] Migration 009 is already recorded as executed. Skipping.');
      state.status = 'MIGRATION_COMPLETE';
      state.migration009Applied = true;
      return { success: true, message: 'Migration 009 already applied.' };
    }

    const possiblePaths = [
      path.join(__dirname, '../migrations/009_auth_security_routing.sql'),
      path.join(__dirname, '../../migrations/009_auth_security_routing.sql'),
      path.join(__dirname, 'migrations/009_auth_security_routing.sql'),
      path.join(process.cwd(), 'apps/api/migrations/009_auth_security_routing.sql'),
      path.join(process.cwd(), 'migrations/009_auth_security_routing.sql'),
    ];

    let sqlPath = '';
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        sqlPath = p;
        break;
      }
    }

    if (!sqlPath) {
      throw new Error(`Could not find 009_auth_security_routing.sql in: ${possiblePaths.join(', ')}`);
    }

    console.log(`[MIGRATION] Reading SQL from: ${sqlPath}`);
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('[MIGRATION] Executing 009_auth_security_routing.sql in transaction...');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO migrations (name) VALUES ($1)', ['009_auth_security_routing.sql']);
      await client.query('COMMIT');
      console.log('[MIGRATION] SQL committed successfully.');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }

    // Post-migration schema verification
    console.log('[MIGRATION VERIFICATION] Verifying schema post-conditions:');

    // 1. Column auth_version on users
    const userCol = await client.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'auth_version'
    `);
    if (userCol.rows.length === 0) throw new Error('Post-check failed: users.auth_version column missing');
    console.log('  [PASS] users.auth_version is present');

    // 2. Table auth_sessions
    const authSessions = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auth_sessions'
    `);
    if (authSessions.rows.length === 0) throw new Error('Post-check failed: auth_sessions table missing');
    console.log('  [PASS] auth_sessions table is present');

    // 3. refresh_tokens columns session_id and token_digest
    const tokenCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name IN ('session_id', 'token_digest')
    `);
    if (tokenCols.rows.length < 2) throw new Error('Post-check failed: refresh_tokens missing session_id or token_digest');
    console.log('  [PASS] refresh_tokens.session_id and token_digest are present');

    // 4. auth_action_tokens table
    const actionTokens = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auth_action_tokens'
    `);
    if (actionTokens.rows.length === 0) throw new Error('Post-check failed: auth_action_tokens table missing');
    console.log('  [PASS] auth_action_tokens table is present');

    // 5. user_write_fences table
    const writeFences = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_write_fences'
    `);
    if (writeFences.rows.length === 0) throw new Error('Post-check failed: user_write_fences table missing');
    console.log('  [PASS] user_write_fences table is present');

    // 6. job_outbox_kind_check constraint
    const kindCheck = await client.query(`
      SELECT pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE conrelid = 'job_outbox'::regclass AND conname = 'job_outbox_kind_check'
    `);
    if (!kindCheck.rows[0]?.def.includes('AUTH_EMAIL')) {
      throw new Error('Post-check failed: job_outbox_kind_check does not allow AUTH_EMAIL');
    }
    console.log('  [PASS] job_outbox_kind_check includes AUTH_EMAIL');

    // 7. Verify all existing users default to auth_version = 0
    const invalidUsers = await client.query('SELECT COUNT(*)::int as count FROM users WHERE auth_version IS NULL');
    if (invalidUsers.rows[0].count > 0) {
      throw new Error('Post-check failed: users found with null auth_version');
    }
    console.log('  [PASS] all users have valid non-null auth_version');

    state.status = 'MIGRATION_COMPLETE';
    state.migration009Applied = true;
    state.completedAt = new Date().toISOString();

    console.log('================================================================');
    console.log('[MIGRATION SUCCESS] Migration 009 successfully applied and verified!');
    console.log('Registration and login database dependencies are now satisfied.');
    console.log('You may now safely delete or disable this one-time Railway service.');
    console.log('================================================================');

    return { success: true, message: 'Migration 009 executed and verified successfully.' };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(20261111009)');
    } catch (e) {
      void e;
    }
    client.release();
  }
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = extractBearerToken(req);

    // 1. Healthcheck for Railway deployment
    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'rota-migration-backup-runner',
        backupStatus: state.status,
        migration009Applied: state.migration009Applied,
        downloadCount: state.downloadCount,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // 2. Status inspection endpoint (requires Bearer token to protect metadata)
    if (url.pathname === '/backup/status') {
      if (!token || !constantTimeEqual(token, BACKUP_AUTH_TOKEN)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid Authorization Bearer header is required' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: state.status,
        backupFile: state.fileName,
        fileSizeBytes: state.fileSizeBytes,
        sha256: state.sha256,
        tablesCount: state.tables.length,
        tableInventory: state.tables,
        appliedMigrations: state.appliedMigrations,
        migration009Applied: state.migration009Applied,
        downloadCount: state.downloadCount,
        createdAt: state.createdAt,
        completedAt: state.completedAt,
      }, null, 2));
      return;
    }

    // 3. Authenticated Download endpoint (requires Bearer token header strictly)
    if (url.pathname === '/backup/download') {
      if (!token || !constantTimeEqual(token, BACKUP_AUTH_TOKEN)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid Authorization Bearer header is required' }));
        return;
      }

      if (!state.filePath || !fs.existsSync(state.filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backup file not found or still generating' }));
        return;
      }

      state.downloadCount += 1;
      console.log(`[BACKUP] Backup downloaded successfully (total downloads: ${state.downloadCount})`);

      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${state.fileName}"`,
        'Content-Length': state.fileSizeBytes,
        'X-Backup-SHA256': state.sha256 || '',
      });

      fs.createReadStream(state.filePath).pipe(res);
      return;
    }

    // 4. Authenticated explicit migration confirmation endpoint
    if (url.pathname === '/backup/confirm-and-migrate' && req.method === 'POST') {
      if (!token || !constantTimeEqual(token, BACKUP_AUTH_TOKEN)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid Authorization Bearer header is required' }));
        return;
      }

      if (state.downloadCount === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Refusing to migrate: Pre-migration backup has not been downloaded and independently verified yet. Please download the backup via GET /backup/download with Authorization header first.',
        }));
        return;
      }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (parsed.confirm !== 'APPLY_MIGRATION_009' || parsed.backupVerified !== true) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Invalid confirmation payload. Body must be JSON: {"confirm":"APPLY_MIGRATION_009","backupVerified":true}',
            }));
            return;
          }

          const result = await applyMigration009();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          state.status = 'ERROR';
          state.errorMessage = err.message;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP SERVER] Running on port ${PORT}`);
    console.log(`[HTTP SERVER] Endpoints require HTTP header: 'Authorization: Bearer <BACKUP_AUTH_TOKEN>'`);
  });
}

async function main() {
  console.log('================================================================');
  console.log(' ROTA PRODUCTION SAFE PRE-MIGRATION BACKUP & MIGRATOR');
  console.log('================================================================');
  console.log(`Database Target: ${sanitizeDbUrl(DATABASE_URL!)}`);
  console.log('Authentication: HTTP Authorization Bearer header required for all operations');
  console.log('----------------------------------------------------------------');

  // 1. Verify native pg_dump binary is present and compatible
  verifyPgDumpBinary();

  // 2. Start HTTP server immediately for Railway health checks
  startHttpServer();

  // 3. Run database diagnostics
  const client = await pool.connect();
  try {
    await inspectDatabase(client);
  } finally {
    client.release();
  }

  // 4. Create logical backup using native pg_dump
  await createLogicalBackup();

  // 5. DO NOT auto-execute migration under any circumstances.
  // Wait for explicit authenticated HTTP request after download verification.
  console.log('----------------------------------------------------------------');
  console.log('[SAFEGUARD ACTIVE] Migration 009 is LOCKED.');
  console.log('Pre-migration backup is stored, verified, and available for download.');
  console.log('');
  console.log('Next Steps:');
  console.log('  1. Download the backup using Authorization header:');
  console.log('     curl -H "Authorization: Bearer <TOKEN>" https://<domain>/backup/download -o backup.sql.gz');
  console.log('  2. Verify restorability and integrity on your local computer.');
  console.log('  3. Authorize migration execution via authenticated POST:');
  console.log('     curl -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \\');
  console.log('       -d \'{"confirm":"APPLY_MIGRATION_009","backupVerified":true}\' \\');
  console.log('       https://<domain>/backup/confirm-and-migrate');
  console.log('----------------------------------------------------------------');
}

main().catch((err) => {
  state.status = 'ERROR';
  state.errorMessage = err.message;
  console.error('[FATAL ERROR]:', err.message);
  process.exit(1);
});
