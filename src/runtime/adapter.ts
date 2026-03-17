import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { writeWorkerBootstrapScript } from './worker-bootstrap.js';
import { resolveWorkerMemoryPath } from './memory.js';
import type { CapabilityProfile } from '../types/model.js';

export interface RuntimeAdapterContract {
  kind: 'tmux-codex';
  authority_source: 'controller-db';
  session_truth: 'database-events-and-controller-commands';
  visibility_model: 'leader-first-observability';
  description: string;
}

export interface RuntimeAdapterLaunchOptions {
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

export interface RuntimeAdapterLaunchResult {
  runtimeHandle: string;
  sessionName: string;
}

export const TMUX_CODEX_RUNTIME_ADAPTER: RuntimeAdapterContract = {
  kind: 'tmux-codex',
  authority_source: 'controller-db',
  session_truth: 'database-events-and-controller-commands',
  visibility_model: 'leader-first-observability',
  description:
    'tmux hosts the current live Codex worker session, while authoritative task, fence, and recovery state remain in the controller/database.',
};

export function launchTmuxCodexRuntime(options: RuntimeAdapterLaunchOptions): RuntimeAdapterLaunchResult {
  const sessionName = buildTmuxSessionName(options.sessionId, options.workerInstanceId, options.generation);
  const memoryPath = resolveWorkerMemoryPath(options.authorityRoot, options.workerInstanceId, options.memoryRef);
  mkdirSync(join(options.authorityRoot, 'runtime'), { recursive: true });
  const launchScript = process.env.HARNESS_WORKER_COMMAND
    ?? writeWorkerBootstrapScript({
      authorityRoot: options.authorityRoot,
      sessionId: options.sessionId,
      workerInstanceId: options.workerInstanceId,
      roleLabel: options.roleLabel,
      generation: options.generation,
      workingDir: options.workingDir,
      cliPath: options.cliPath,
      memoryRef: options.memoryRef,
      memoryPath,
      capabilityProfile: options.capabilityProfile,
      runtimeAdapter: TMUX_CODEX_RUNTIME_ADAPTER,
    });
  execFileSync(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      options.workingDir,
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
      '-e',
      `HARNESS_WORKER_TOKEN_FILE=${options.workerTokenPath}`,
      '-e',
      `HARNESS_CAPABILITY_PROFILE=${JSON.stringify(options.capabilityProfile)}`,
      '-e',
      `HARNESS_NETWORK_PROFILE=${options.capabilityProfile.network_profile}`,
      '-e',
      `HARNESS_BROWSER_ACCESS=${options.capabilityProfile.browser_access ? '1' : '0'}`,
      '-e',
      `HARNESS_PUBLISH_RIGHT=${options.capabilityProfile.publish_right ? '1' : '0'}`,
      '-e',
      `HARNESS_CODEX_SANDBOX=${process.env.HARNESS_CODEX_SANDBOX ?? defaultSandboxMode(options.capabilityProfile)}`,
      '-e',
      `HARNESS_RUNTIME_ADAPTER_KIND=${TMUX_CODEX_RUNTIME_ADAPTER.kind}`,
      '-e',
      `HARNESS_RUNTIME_AUTHORITY_SOURCE=${TMUX_CODEX_RUNTIME_ADAPTER.authority_source}`,
      typeof process.env.HARNESS_WORKER_COMMAND === 'string' ? launchScript : `bash ${launchScript}`,
    ],
    { stdio: 'ignore' },
  );
  execFileSync('tmux', ['set-option', '-t', sessionName, 'remain-on-exit', 'on'], { stdio: 'ignore' });
  dismissTrustPromptIfPresent(sessionName);
  return {
    runtimeHandle: buildTmuxRuntimeHandle(sessionName),
    sessionName,
  };
}

export function buildTmuxRuntimeHandle(sessionName: string): string {
  return `tmux:${sessionName}`;
}

export function parseTmuxRuntimeHandle(runtimeHandle: string): string | null {
  return runtimeHandle.startsWith('tmux:') ? runtimeHandle.slice('tmux:'.length) : null;
}

export function tmuxRuntimeSessionExists(sessionName: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function terminateTmuxRuntime(runtimeHandle: string): boolean {
  const sessionName = parseTmuxRuntimeHandle(runtimeHandle);
  if (!sessionName) {
    return false;
  }
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildTmuxSessionName(sessionId: string, workerInstanceId: string, generation: number): string {
  const base = `${sessionId}-${workerInstanceId}-g${generation}`
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48);
  return `h-${base}-${randomUUID().slice(0, 8)}`;
}

function dismissTrustPromptIfPresent(sessionName: string): void {
  try {
    execFileSync('tmux', ['send-keys', '-t', sessionName, 'y', 'Enter'], { stdio: 'ignore' });
  } catch {
    // ignore missing/closed session
  }
}

function defaultSandboxMode(capabilityProfile: CapabilityProfile): string {
  if (
    capabilityProfile.publish_right
    || capabilityProfile.fs_scope.length > 0
    || capabilityProfile.shared_resource_modes.length > 0
  ) {
    return 'workspace-write';
  }
  return 'read-only';
}
