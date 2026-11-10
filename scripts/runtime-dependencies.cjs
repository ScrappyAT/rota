// Execute inside the final image. Imports only: no migrations, provider calls,
// listeners, Redis connections or database connections are started here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const sharedRequire = createRequire(path.join(root, 'packages/shared/package.json'));
const api = apiRequire('./package.json');
const shared = sharedRequire('./package.json');
const failures = [];

function check(name, action) {
  try {
    const evidence = action();
    console.log(`PASS ${name}${evidence ? ': ' + evidence : ''}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

// Anchor resolution to each workspace, not the working directory or smoke file.
for (const dependency of Object.keys(api.dependencies).sort()) {
  check(`api dependency ${dependency}`, () => {
    const resolved = apiRequire.resolve(dependency);
    apiRequire(dependency);
    return resolved;
  });
}
for (const dependency of Object.keys(shared.dependencies).sort()) {
  check(`shared dependency ${dependency}`, () => {
    sharedRequire(dependency);
    return sharedRequire.resolve(dependency);
  });
}
check('native bcrypt round trip', () => {
  const bcrypt = apiRequire('bcrypt');
  const hash = bcrypt.hashSync('runtime-smoke-only', 4);
  assert(bcrypt.compareSync('runtime-smoke-only', hash));
  assert(!bcrypt.compareSync('wrong-smoke-password', hash));
});
check('compiled shared schema', () => {
  assert(apiRequire('@rota/shared').EmailActionSchema.safeParse({ email: 'smoke@example.invalid' }).success);
});
check('compiled API/worker/migrator artifacts', () => {
  for (const file of ['index.js', 'worker.js', 'migrate.js', 'jobs-cli.js']) {
    assert(fs.statSync(path.join(root, 'apps/api/dist', file)).isFile());
  }
  assert.equal(fs.readdirSync(path.join(root, 'apps/api/migrations')).filter(f => f.endsWith('.sql')).length, 9);
});

async function main() {
  if (!failures.length) {
    // Force dummy, non-serving values even if this smoke is run with extra env.
    Object.assign(process.env, {
      NODE_ENV: 'production', PORT: '8080', SENTRY_DSN: '', EXPO_PUBLIC_SENTRY_DSN: '', SENTRY_AUTH_TOKEN: '',
      DATABASE_URL: 'postgres://dummy:dummy@127.0.0.1:9/runtime_smoke',
      REDIS_URL: 'redis://127.0.0.1:9',
      JWT_SECRET: 'runtime-smoke-dummy-jwt-only',
      FLW_SECRET_KEY: 'runtime-smoke-dummy-only',
      FLW_SECRET_HASH: 'runtime-smoke-dummy-only', FLW_ENV: 'sandbox',
      FLW_BASE_URL: 'http://127.0.0.1:9',
      CORS_ORIGIN: 'https://rota.invalid',
      AUTH_MAIL_KEY: '1'.repeat(64), MAIL_API_KEY: 'runtime-smoke-dummy-only',
      MAIL_FROM: 'smoke@example.invalid', MAIL_API_URL: 'https://127.0.0.1:9',
      AUTH_LINK_BASE: 'rota://action',
      EXPO_PUSH_URL: 'http://127.0.0.1:9', EXPO_PUSH_RECEIPTS_URL: 'http://127.0.0.1:9',
    });
    delete process.env.READ_DATABASE_URL;
    check('compiled API import (no startup)', () => {
      assert.equal(typeof apiRequire('./dist/index.js').app, 'function');
    });
    check('compiled worker import (no startup)', () => {
      assert.equal(typeof apiRequire('./dist/worker.js').runWorker, 'function');
    });
    const { redisClient } = apiRequire('./dist/redis.js');
    assert.equal(redisClient.isOpen, false);
    await apiRequire('./dist/db.js').pool.end();
  }
  if (failures.length) throw new Error(`${failures.length} runtime checks failed: ${failures.join(', ')}`);
  console.log('Runtime dependency smoke passed; no services or providers contacted.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
