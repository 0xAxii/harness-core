import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { callSocket, resolveAuthorityRoot } from './client.js';
import { startController } from './daemon.js';
import { resolveLeaderWorker } from './leader.js';
import type { JsonRpcFailure } from '../protocol/jsonrpc.js';

interface WorkerSummary {
  worker_instance_id: string;
  role_label: string;
  generation: number;
  supervisor_state: string;
  current_attempt_id?: string;
  runtime_handle?: string;
}

interface StatusPayload {
  session: {
    session_id: string;
  };
  workers?: WorkerSummary[];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRunningPid(authorityRoot: string): number | null {
  try {
    const pidPath = join(authorityRoot, 'runtime', 'controller.pid');
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 && isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function fetchStatus(sessionId: string): Promise<StatusPayload | undefined> {
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const socketPath = join(authorityRoot, 'admin.sock');
  const response = await callSocket(socketPath, 'status', { session_id: sessionId });
  if ('error' in response) {
    const error = response as JsonRpcFailure;
    if (error.error.message === 'session not found') {
      return undefined;
    }
    throw new Error(error.error.message);
  }
  return response.result as StatusPayload;
}

export async function runUpCommand(args: string[]): Promise<void> {
  const [sessionId = 'dev-session', ...rest] = args;
  const configPath = parseConfigPath(rest);
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const socketPath = join(authorityRoot, 'admin.sock');

  const controllerStarted = readRunningPid(authorityRoot) === null;
  if (controllerStarted) {
    await startController(sessionId, { quiet: true });
  }

  let status = await fetchStatus(sessionId);
  let sessionCreated = false;
  if (!status) {
    const created = await callSocket(socketPath, 'create_session', {
      session_id: sessionId,
      family: 'code-oriented',
      authority_root: authorityRoot,
      config_path: configPath,
    });
    if ('error' in created) {
      throw new Error((created as JsonRpcFailure).error.message);
    }
    sessionCreated = true;
    status = await fetchStatus(sessionId);
  }

  const workers = status?.workers ?? [];
  const leaderWorker = resolveLeaderWorker(workers);
  let leaderWorkerId = leaderWorker?.worker_instance_id ?? 'worker-leader';
  let leaderWorkerLaunched = false;
  if (!leaderWorker) {
    const launched = await callSocket(socketPath, 'launch_worker', {
      session_id: sessionId,
      worker_instance_id: leaderWorkerId,
      role_label: 'leader',
    });
    if ('error' in launched) {
      throw new Error((launched as JsonRpcFailure).error.message);
    }
    leaderWorkerLaunched = true;
  }

  process.stdout.write(
    JSON.stringify(
      {
        session_id: sessionId,
        controller_started: controllerStarted,
        session_created: sessionCreated,
        leader_worker_instance_id: leaderWorkerId,
        leader_worker_launched: leaderWorkerLaunched,
        config_path: configPath ?? null,
        next_steps: {
          status: `harness hud ${sessionId}`,
          attach_leader: `harness attach-worker ${sessionId}`,
        },
      },
      null,
      2,
    ) + '\n',
  );
}

function parseConfigPath(args: string[]): string | undefined {
  const configFlagIndex = args.findIndex((arg) => arg === '--config');
  if (configFlagIndex === -1) {
    return undefined;
  }
  const value = args[configFlagIndex + 1];
  if (!value) {
    throw new Error('usage: harness up <session-id> [--config <path>]');
  }
  return value;
}
