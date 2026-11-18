import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';

export interface SupervisorOptions {
  apiScript?: string;
  workerScript?: string;
  env?: NodeJS.ProcessEnv;
  killTimeoutMs?: number;
  silent?: boolean;
}

export interface SupervisorHandle {
  apiProcess: ChildProcess;
  workerProcess: ChildProcess;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
}

function forwardStream(stream: NodeJS.ReadableStream | null, prefix: string, target: NodeJS.WriteStream): void {
  if (!stream) return;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on('line', (line) => {
    target.write(`${prefix} ${line}\n`);
  });
}

export function startSupervisor(options: SupervisorOptions = {}): SupervisorHandle {
  const rootDist = __dirname;
  const apiScript = options.apiScript ?? path.join(rootDist, 'index.js');
  const workerScript = options.workerScript ?? path.join(rootDist, 'worker.js');
  const childEnv = options.env ?? { ...process.env };
  const killTimeoutMs = options.killTimeoutMs ?? 5000;
  const isSilent = options.silent ?? false;

  if (!fs.existsSync(apiScript)) {
    throw new Error(`[supervisor] API entrypoint not found at: ${apiScript}`);
  }
  if (!fs.existsSync(workerScript)) {
    throw new Error(`[supervisor] Worker entrypoint not found at: ${workerScript}`);
  }

  const log = (msg: string): void => {
    if (!isSilent) console.log(msg);
  };
  const logErr = (msg: string): void => {
    if (!isSilent) console.error(msg);
  };

  log(`[supervisor] Starting Rota combined runtime (API: ${path.basename(apiScript)}, Worker: ${path.basename(workerScript)})...`);

  const apiProcess = spawn(process.execPath, [apiScript], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const workerProcess = spawn(process.execPath, [workerScript], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!isSilent) {
    forwardStream(apiProcess.stdout, '[api]', process.stdout);
    forwardStream(apiProcess.stderr, '[api]', process.stderr);
    forwardStream(workerProcess.stdout, '[worker]', process.stdout);
    forwardStream(workerProcess.stderr, '[worker]', process.stderr);
  }

  log(`[supervisor] Spawned API (PID ${apiProcess.pid}) and Worker (PID ${workerProcess.pid}).`);

  let isStopping = false;

  const terminateChild = (proc: ChildProcess, name: string): Promise<void> => {
    return new Promise((resolve) => {
      if (proc.killed || proc.exitCode !== null || proc.signalCode !== null) {
        return resolve();
      }
      let resolved = false;
      const done = (): void => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      proc.once('exit', done);
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        void err;
        done();
      }
      setTimeout(() => {
        if (!resolved && proc.exitCode === null && proc.signalCode === null) {
          log(`[supervisor] Force-killing ${name} (PID ${proc.pid}) with SIGKILL after ${killTimeoutMs}ms`);
          try {
            proc.kill('SIGKILL');
          } catch (err) {
            void err;
          }
          done();
        }
      }, killTimeoutMs).unref();
    });
  };

  const handleChildFailure = async (
    failedName: string,
    failedProc: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> => {
    if (isStopping) return;
    isStopping = true;
    logErr(`[supervisor] CRITICAL: ${failedName} (PID ${failedProc.pid}) exited unexpectedly (code: ${code}, signal: ${signal}).`);
    logErr('[supervisor] Terminating surviving processes to trigger container fail-fast restart...');

    const surviving = failedName === 'API'
      ? { proc: workerProcess, name: 'Worker' }
      : { proc: apiProcess, name: 'API' };
    await terminateChild(surviving.proc, surviving.name);

    const exitCode = code !== null && code !== 0 ? code : 1;
    logErr(`[supervisor] Container supervision exiting with code ${exitCode}.`);
    process.exit(exitCode);
  };

  apiProcess.on('exit', (code, signal) => {
    void handleChildFailure('API', apiProcess, code, signal);
  });

  workerProcess.on('exit', (code, signal) => {
    void handleChildFailure('Worker', workerProcess, code, signal);
  });

  apiProcess.on('error', (err) => {
    logErr(`[supervisor] API process spawn error: ${err.message}`);
    void handleChildFailure('API', apiProcess, 1, null);
  });

  workerProcess.on('error', (err) => {
    logErr(`[supervisor] Worker process spawn error: ${err.message}`);
    void handleChildFailure('Worker', workerProcess, 1, null);
  });

  const stop = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    if (isStopping) return;
    isStopping = true;
    log(`[supervisor] Received shutdown request (${signal}). Stopping API and Worker...`);
    await Promise.all([
      terminateChild(apiProcess, 'API'),
      terminateChild(workerProcess, 'Worker'),
    ]);
    log('[supervisor] Both processes terminated cleanly.');
  };

  return {
    apiProcess,
    workerProcess,
    stop,
  };
}

if (require.main === module) {
  const supervisor = startSupervisor();

  const handleSignal = async (sig: NodeJS.Signals): Promise<void> => {
    console.log(`[supervisor] Received ${sig}. Initiating graceful container shutdown...`);
    await supervisor.stop(sig);
    process.exit(0);
  };

  process.once('SIGTERM', () => void handleSignal('SIGTERM'));
  process.once('SIGINT', () => void handleSignal('SIGINT'));
}
