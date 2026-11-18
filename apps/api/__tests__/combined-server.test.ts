import path from 'path';
import fs from 'fs';
import { startSupervisor } from '../src/combined-server';

describe('Combined Server Supervisor', () => {
  const tmpDir = path.join(__dirname, 'tmp-supervisor-test');
  const dummyApiScript = path.join(tmpDir, 'dummy-api.js');
  const dummyWorkerScript = path.join(tmpDir, 'dummy-worker.js');
  const failingWorkerScript = path.join(tmpDir, 'failing-worker.js');
  const failingApiScript = path.join(tmpDir, 'failing-api.js');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Long-running dummy processes that respond to SIGTERM
    fs.writeFileSync(
      dummyApiScript,
      `
      console.log('Dummy API running');
      process.on('SIGTERM', () => {
        console.log('Dummy API received SIGTERM');
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      `
    );

    fs.writeFileSync(
      dummyWorkerScript,
      `
      console.log('Dummy Worker running');
      process.on('SIGTERM', () => {
        console.log('Dummy Worker received SIGTERM');
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      `
    );

    // Fast-failing scripts to test fail-fast supervisor termination
    fs.writeFileSync(
      failingWorkerScript,
      `
      console.log('Worker crashing immediately');
      setTimeout(() => process.exit(42), 200);
      `
    );

    fs.writeFileSync(
      failingApiScript,
      `
      console.log('API crashing immediately');
      setTimeout(() => process.exit(99), 200);
      `
    );
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('successfully spawns both API and Worker processes and shuts down gracefully', async () => {
    const handle = startSupervisor({
      apiScript: dummyApiScript,
      workerScript: dummyWorkerScript,
      silent: true,
      killTimeoutMs: 1000,
    });

    expect(handle.apiProcess.pid).toBeDefined();
    expect(handle.workerProcess.pid).toBeDefined();
    expect(handle.apiProcess.exitCode).toBeNull();
    expect(handle.workerProcess.exitCode).toBeNull();

    await handle.stop('SIGTERM');

    expect(handle.apiProcess.killed || handle.apiProcess.exitCode !== null).toBe(true);
    expect(handle.workerProcess.killed || handle.workerProcess.exitCode !== null).toBe(true);
  });

  test('kills API process when Worker crashes unexpectedly (fail-fast supervision)', async () => {
    const originalExit = process.exit;
    let supervisorExitCode: number | null = null;
    const exitPromise = new Promise<number>((resolve) => {
      process.exit = ((code?: number) => {
        supervisorExitCode = code ?? 0;
        resolve(supervisorExitCode);
        return undefined as never;
      }) as typeof process.exit;
    });

    const handle = startSupervisor({
      apiScript: dummyApiScript,
      workerScript: failingWorkerScript,
      silent: true,
      killTimeoutMs: 1000,
    });

    const code = await exitPromise;
    process.exit = originalExit;

    expect(code).toBe(42);
    // API process must have been terminated
    expect(handle.apiProcess.killed || handle.apiProcess.exitCode !== null).toBe(true);
  });

  test('kills Worker process when API crashes unexpectedly (fail-fast supervision)', async () => {
    const originalExit = process.exit;
    let supervisorExitCode: number | null = null;
    const exitPromise = new Promise<number>((resolve) => {
      process.exit = ((code?: number) => {
        supervisorExitCode = code ?? 0;
        resolve(supervisorExitCode);
        return undefined as never;
      }) as typeof process.exit;
    });

    const handle = startSupervisor({
      apiScript: failingApiScript,
      workerScript: dummyWorkerScript,
      silent: true,
      killTimeoutMs: 1000,
    });

    const code = await exitPromise;
    process.exit = originalExit;

    expect(code).toBe(99);
    // Worker process must have been terminated
    expect(handle.workerProcess.killed || handle.workerProcess.exitCode !== null).toBe(true);
  });

  test('throws error if entrypoint script is missing', () => {
    expect(() =>
      startSupervisor({
        apiScript: path.join(tmpDir, 'nonexistent-api.js'),
        workerScript: dummyWorkerScript,
        silent: true,
      })
    ).toThrow('API entrypoint not found');

    expect(() =>
      startSupervisor({
        apiScript: dummyApiScript,
        workerScript: path.join(tmpDir, 'nonexistent-worker.js'),
        silent: true,
      })
    ).toThrow('Worker entrypoint not found');
  });
});
