import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TMUX_CODEX_RUNTIME_ADAPTER,
  launchTmuxCodexRuntime,
  parseTmuxRuntimeHandle,
  terminateTmuxRuntime,
  tmuxRuntimeSessionExists,
} from './adapter.js';
import type { CapabilityProfile } from '../types/model.js';

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
  capabilityProfile: CapabilityProfile;
  workerTokenPath: string;
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
  runtimeAdapterKind: typeof TMUX_CODEX_RUNTIME_ADAPTER.kind;
}

export class EmbeddedSupervisor {
  private readonly runtimes = new Map<string, RuntimeRecord>();

  async launchWorker(options: LaunchWorkerOptions): Promise<LiveSessionHandle> {
    const launchedRuntime = launchTmuxCodexRuntime(options);
    const sidecarPid = launchWorkerRuntimeSidecar(options);
    const handle: LiveSessionHandle = {
      runtimeHandle: launchedRuntime.runtimeHandle,
      generation: options.generation,
    };
    this.runtimes.set(handle.runtimeHandle, {
      sessionName: launchedRuntime.sessionName,
      workerInstanceId: options.workerInstanceId,
      generation: options.generation,
      authorityRoot: options.authorityRoot,
      sidecarPid,
      state: 'started',
      runtimeAdapterKind: TMUX_CODEX_RUNTIME_ADAPTER.kind,
    });
    return handle;
  }

  async adoptWorker(options: LaunchWorkerOptions, runtimeHandle: string): Promise<boolean> {
    const sessionName = parseTmuxRuntimeHandle(runtimeHandle);
    if (!sessionName || !tmuxRuntimeSessionExists(sessionName)) {
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
      runtimeAdapterKind: TMUX_CODEX_RUNTIME_ADAPTER.kind,
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
      return terminateTmuxRuntime(options.runtimeHandle);
    }
    terminateTmuxRuntime(options.runtimeHandle);
    if (runtime.sidecarPid) {
      killSidecar(runtime.sidecarPid);
    }
    clearTrackedSidecarPid(runtime.authorityRoot, runtime.workerInstanceId);
    runtime.state = 'terminated';
    this.runtimes.delete(options.runtimeHandle);
    return true;
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
        HARNESS_WORKER_TOKEN_FILE: options.workerTokenPath,
        HARNESS_CAPABILITY_PROFILE: JSON.stringify(options.capabilityProfile),
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

