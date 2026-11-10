import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('Phase 3 fatal process privacy', () => {
  it.each(["throw new Error('secret-password-token')", "Promise.reject(new Error('secret-password-token'))"])(
    'terminates safely without printing the original exception: %s', expression => {
      const modulePath = path.resolve(__dirname, '../src/services/error-tracking.ts');
      const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e',
        `require(${JSON.stringify(modulePath)}).installFatalErrorHandlers(); ${expression}`], {
        env: { ...process.env, SENTRY_DSN: '', TS_NODE_PROJECT: path.resolve(__dirname, '../tsconfig.json') },
        encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
      expect(child.stderr + child.stdout).toContain('process.error');
      expect(child.stderr + child.stdout).not.toContain('secret-password-token');
    }, 15000,
  );
});
