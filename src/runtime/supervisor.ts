import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeWorkerBootstrapScript } from './worker-bootstrap.js';
import { resolveWorkerMemoryPath } from './memory.js';

export interface LiveSessionHandle {
  runtimeHandle: string;
  generation: number;
}

export interface LaunchWorkerOptions {
  sessionId: string;
  workerInstanceId: string;
  roleLabel: string;
  generation: number;
  authorityRoot: string;
  workingDir: string;
  cliPath: string;
  memoryRef?: string;
}

export interface TerminateWorkerOptions {
  runtimeHandle: string;
}

interface RuntimeRecord {
  sessionName: string;
  workerInstanceId: string;
  generation: number;
  authorityRoot: string;
  sidecarPid?: number;
  state: 'started' | 'terminated';
}

export class EmbeddedSupervisor {
  private readonly runtimes = new Map<string, RuntimeRecord>();

  async launchWorker(options: LaunchWorkerOptions): Promise<LiveSessionHandle> {
    const sessionName = buildTmuxSessionName(options.sessionId, options.workerInstanceId, options.generation);
    const workingDir = options.workingDir;
    const memoryPath = resolveWorkerMemoryPath(options.authorityRoot, options.workerInstanceId, options.memoryRef);
    mkdirSync(join(options.authorityRoot, 'runtime'), { recursive: true });
    const launchScript = process.env.HARNESS_WORKER_COMMAND
      ?? writeWorkerBootstrapScript({
        authorityRoot: options.authorityRoot,
        sessionId: options.sessionId,
        workerInstanceId: options.workerInstanceId,
        roleLabel: options.roleLabel,
        generation: options.generation,
        workingDir,
        cliPath: options.cliPath,
        memoryRef: options.memoryRef,
        memoryPath,
      });
    execFileSync(
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        workingDir,
        '-e',
        `HARNESS_SESSION_ID=${options.sessionId}`,
        '-e',
        `HARNESS_WORKER_ID=${options.workerInstanceId}`,
        '-e',
        `HARNESS_ROLE=${options.roleLabel}`,
        '-e',
        `HARNESS_WORKER_GENERATION=${options.generation}`,
        '-e',
        `HARNESS_AUTHORITY_ROOT=${options.authorityRoot}`,
        '-e',
        `HARNESS_WORKER_CWD=${options.workingDir}`,
        '-e',
        `HARNESS_MEMORY_REF=${options.memoryRef ?? ''}`,
        '-e',
        `HARNESS_MEMORY_FILE=${memoryPath}`,
        '-e',
        `HARNESS_REHYDRATION_PACKET=${join(options.authorityRoot, 'rehydration', `${options.workerInstanceId}.json`)}`,
        '-e',
        `HARNESS_CLI_PATH=${options.cliPath}`,
        typeof process.env.HARNESS_WORKER_COMMAND === 'string' ? launchScript : `bash ${launchScript}`,
      ],
      { stdio: 'ignore' },
    );
    execFileSync('tmux', ['set-option', '-t', sessionName, 'remain-on-exit', 'on'], { stdio: 'ignore' });
    dismissTrustPromptIfPresent(sessionName);
    const sidecarPid = launchWorkerRuntimeSidecar(options);
    const handle: LiveSessionHandle = {
      runtimeHandle: `tmux:${sessionName}`,
      generation: options.generation,
    };
    this.runtimes.set(handle.runtimeHandle, {
      sessionName,
      workerInstanceId: options.workerInstanceId,
      generation: options.generation,
      authorityRoot: options.authorityRoot,
      sidecarPid,
      state: 'started',
    });
    return handle;
  }

  async adoptWorker(options: LaunchWorkerOptions, runtimeHandle: string): Promise<boolean> {
    const sessionName = parseTmuxSessionName(runtimeHandle);
    if (!sessionName || !tmuxSessionExists(sessionName)) {
      return false;
    }
    const sidecarPid = launchWorkerRuntimeSidecar(options);
    this.runtimes.set(runtimeHandle, {
      sessionName,
      workerInstanceId: options.workerInstanceId,
      generation: options.generation,
      authorityRoot: options.authorityRoot,
      sidecarPid,
      state: 'started',
    });
    return true;
  }

  async recycleWorker(options: LaunchWorkerOptions, currentRuntimeHandle?: string): Promise<LiveSessionHandle> {
    if (currentRuntimeHandle) {
      await this.terminateWorker({ runtimeHandle: currentRuntimeHandle });
    }
    return await this.launchWorker({ ...options, generation: options.generation });
  }

  async terminateWorker(options: TerminateWorkerOptions): Promise<boolean> {
    const runtime = this.runtimes.get(options.runtimeHandle);
    if (!runtime) {
      const sessionName = parseTmuxSessionName(options.runtimeHandle);
      if (!sessionName) {
        return false;
      }
      return killTmuxSession(sessionName);
    }
    killTmuxSession(runtime.sessionName);
    if (runtime.sidecarPid) {
      killSidecar(runtime.sidecarPid);
    }
    clearTrackedSidecarPid(runtime.authorityRoot, runtime.workerInstanceId);
    runtime.state = 'terminated';
    this.runtimes.delete(options.runtimeHandle);
    return true;
  }
}

function buildTmuxSessionName(sessionId: string, workerInstanceId: string, generation: number): string {
  const base = `${sessionId}-${workerInstanceId}-g${generation}`
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48);
  return `h-${base}-${randomUUID().slice(0, 8)}`;
}

function parseTmuxSessionName(runtimeHandle: string): string | null {
  return runtimeHandle.startsWith('tmux:') ? runtimeHandle.slice('tmux:'.length) : null;
}

function killTmuxSession(sessionName: string): boolean {
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function launchWorkerRuntimeSidecar(options: LaunchWorkerOptions): number | undefined {
  killTrackedSidecarPid(options.authorityRoot, options.workerInstanceId);
  const child = spawn(
    process.execPath,
    [
      options.cliPath,
      'sidecar',
      'worker-runtime',
      options.sessionId,
      options.workerInstanceId,
      String(options.generation),
      '--interval',
      process.env.HARNESS_SIDECAR_INTERVAL_MS ?? '2000',
    ],
    {
      cwd: options.workingDir,
      env: {
        ...process.env,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      },
      stdio: 'ignore',
      detached: true,
    },
  );
  child.unref();
  trackSidecarPid(options.authorityRoot, options.workerInstanceId, child.pid);
  return child.pid;
}

function killSidecar(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // ignore missing child
  }
}

function tmuxSessionExists(sessionName: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sidecarPidPath(authorityRoot: string, workerInstanceId: string): string {
  return join(authorityRoot, 'runtime', 'sidecar', `${workerInstanceId}.pid`);
}

function trackSidecarPid(authorityRoot: string, workerInstanceId: string, pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  const pidPath = sidecarPidPath(authorityRoot, workerInstanceId);
  mkdirSync(join(authorityRoot, 'runtime', 'sidecar'), { recursive: true });
  writeFileSync(pidPath, `${pid}\n`, 'utf8');
}

function readTrackedSidecarPid(authorityRoot: string, workerInstanceId: string): number | null {
  const pidPath = sidecarPidPath(authorityRoot, workerInstanceId);
  if (!existsSync(pidPath)) {
    return null;
  }
  try {
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearTrackedSidecarPid(authorityRoot: string, workerInstanceId: string): void {
  try {
    rmSync(sidecarPidPath(authorityRoot, workerInstanceId), { force: true });
  } catch {
    // ignore cleanup failures
  }
}

function killTrackedSidecarPid(authorityRoot: string, workerInstanceId: string): void {
  const pid = readTrackedSidecarPid(authorityRoot, workerInstanceId);
  if (pid !== null) {
    killSidecar(pid);
  }
  clearTrackedSidecarPid(authorityRoot, workerInstanceId);
}

function dismissTrustPromptIfPresent(sessionName: string): void {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pane = execFileSync('tmux', ['capture-pane', '-pt', `${sessionName}:0.0`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (pane.includes('Do you trust the contents of this directory?') || pane.includes('Press enter to continue')) {
        execFileSync('tmux', ['send-keys', '-t', `${sessionName}:0.0`, 'C-m'], { stdio: 'ignore' });
        execFileSync('sleep', ['0.1'], { stdio: 'ignore' });
        execFileSync('tmux', ['send-keys', '-t', `${sessionName}:0.0`, 'C-m'], { stdio: 'ignore' });
        return;
      }
    } catch {
      return;
    }
    execFileSync('sleep', ['0.2'], { stdio: 'ignore' });
  }
}
