import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { callSocket, resolveAuthorityRoot } from './client.js';

const READY_TIMEOUT_MS = 5_000;

export async function runStartCommand(args: string[]): Promise<void> {
  const [sessionId = 'dev-session'] = args;
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const runtimeDir = join(authorityRoot, 'runtime');
  const logDir = join(runtimeDir, 'logs');
  const pidPath = join(runtimeDir, 'controller.pid');
  const logPath = join(logDir, 'controller.log');

  mkdirSync(logDir, { recursive: true });
  ensureNotRunning(pidPath);

  const out = openSync(logPath, 'a');
  const err = openSync(logPath, 'a');
  const child = spawn(process.execPath, [process.argv[1]!, 'bootstrap', sessionId], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: ['ignore', out, err],
  });
  if (child.pid === undefined) {
    throw new Error('failed to spawn controller process');
  }
  child.unref();
  writeFileSync(pidPath, `${child.pid}\n`, 'utf8');

  try {
    await waitForReady(sessionId, child.pid);
  } catch (error) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // ignore dead child
    }
    throw error;
  }

  process.stdout.write(
    JSON.stringify(
      {
        session_id: sessionId,
        pid: child.pid,
        pid_path: pidPath,
        log_path: logPath,
      },
      null,
      2,
    ) + '\n',
  );
}

export async function runStopCommand(args: string[]): Promise<void> {
  const [sessionId = 'dev-session'] = args;
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const pidPath = join(authorityRoot, 'runtime', 'controller.pid');
  const pid = readPid(pidPath);
  if (pid === null) {
    process.stdout.write(`controller not running for session ${sessionId}\n`);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isPidAlive(pid)) {
      break;
    }
    await delay(100);
  }

  try {
    unlinkSync(pidPath);
  } catch {
    // ignore missing pidfile
  }

  process.stdout.write(
    JSON.stringify(
      {
        session_id: sessionId,
        pid,
        stopped: true,
      },
      null,
      2,
    ) + '\n',
  );
}

function ensureNotRunning(pidPath: string): void {
  const pid = readPid(pidPath);
  if (pid === null) {
    return;
  }
  if (isPidAlive(pid)) {
    throw new Error(`controller already running with pid ${pid}`);
  }
  try {
    unlinkSync(pidPath);
  } catch {
    // ignore missing pidfile
  }
}

async function waitForReady(sessionId: string, pid: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    const authorityRoot = resolveAuthorityRoot(sessionId);
    const adminSocketPath = join(authorityRoot, 'admin.sock');
    try {
      await callSocket(adminSocketPath, 'status', { session_id: sessionId });
      return;
    } catch {
      if (!isPidAlive(pid)) {
        throw new Error(`controller exited before ready (pid ${pid})`);
      }
      await delay(100);
    }
  }
  throw new Error(`controller did not become ready within ${READY_TIMEOUT_MS}ms`);
}

function readPid(pidPath: string): number | null {
  try {
    const value = readFileSync(pidPath, 'utf8').trim();
    const pid = Number(value);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
