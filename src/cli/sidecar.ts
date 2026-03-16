import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonRpcFailure } from '../protocol/jsonrpc.js';
import { callSocket, resolveAuthorityRoot } from './client.js';

interface SidecarMailboxPayload {
  messages?: Array<{ message_id?: string } & Record<string, unknown>>;
}

interface SidecarPacket {
  worker_generation?: number;
  active_attempt?: {
    attempt_id?: string;
    assignment_fence?: number;
    current_activity?: string;
    progress_counter?: number;
  } | null;
}

export async function runSidecarCommand(args: string[]): Promise<void> {
  const [mode, sessionId, workerInstanceId, generationArg, ...rest] = args;
  if (!mode || !sessionId || !workerInstanceId || !generationArg) {
    throw new Error('usage: harness sidecar worker-runtime <session-id> <worker-instance-id> <generation> [--interval <ms>]');
  }
  if (mode !== 'worker-runtime' && mode !== 'worker-mailbox') {
    throw new Error(`unknown sidecar mode: ${mode}`);
  }

  const generation = Number(generationArg);
  const intervalMs = parseInterval(rest);
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const runtimeDir = join(authorityRoot, 'runtime');
  const mailboxDir = join(runtimeDir, 'mailbox');
  const heartbeatDir = join(runtimeDir, 'heartbeat');
  const mailboxPath = join(mailboxDir, `${workerInstanceId}.json`);
  const heartbeatPath = join(heartbeatDir, `${workerInstanceId}.json`);
  mkdirSync(mailboxDir, { recursive: true });
  mkdirSync(heartbeatDir, { recursive: true });

  while (true) {
    const pollResult = await pollMessages(sessionId, workerInstanceId, generation);
    if (pollResult.exit) {
      return;
    }

    const packet = readRehydrationPacket(authorityRoot, workerInstanceId);
    const heartbeatResult = await sendHeartbeat(sessionId, workerInstanceId, generation, packet);
    if (heartbeatResult.exit) {
      return;
    }

    const existing = readMailbox(mailboxPath);
    const mergedMessages = mergeMessages(existing.messages, pollResult.messages);
    writeFileSync(
      mailboxPath,
      `${JSON.stringify(
        {
          session_id: sessionId,
          worker_instance_id: workerInstanceId,
          generation,
          updated_at: new Date().toISOString(),
          messages: mergedMessages,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    writeFileSync(
      heartbeatPath,
      `${JSON.stringify(
        {
          session_id: sessionId,
          worker_instance_id: workerInstanceId,
          generation,
          updated_at: new Date().toISOString(),
          attempt_id: packet.active_attempt?.attempt_id ?? null,
          assignment_fence: packet.active_attempt?.assignment_fence ?? null,
          status: heartbeatResult.status,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await sleep(intervalMs);
  }
}

async function pollMessages(sessionId: string, workerInstanceId: string, generation: number): Promise<{ exit: boolean; messages: unknown[] }> {
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const socketPath = join(authorityRoot, 'worker.sock');
  try {
    const response = await callSocket(socketPath, 'poll_messages', {
      worker_instance_id: workerInstanceId,
      generation,
    });
    if ('error' in response) {
      const failure = response as JsonRpcFailure;
      if (failure.error.code === 409) {
        return { exit: true, messages: [] };
      }
      return { exit: false, messages: [] };
    }
    const payload = response.result as SidecarMailboxPayload;
    return { exit: false, messages: Array.isArray(payload.messages) ? payload.messages : [] };
  } catch {
    return { exit: false, messages: [] };
  }
}

async function sendHeartbeat(
  sessionId: string,
  workerInstanceId: string,
  generation: number,
  packet: SidecarPacket,
): Promise<{ exit: boolean; status: string }> {
  const activeAttempt = packet.active_attempt;
  if (!activeAttempt?.attempt_id || typeof activeAttempt.assignment_fence !== 'number') {
    return { exit: false, status: 'idle' };
  }
  if (packet.worker_generation !== undefined && packet.worker_generation !== generation) {
    return { exit: true, status: 'generation_rejected' };
  }

  const authorityRoot = resolveAuthorityRoot(sessionId);
  const socketPath = join(authorityRoot, 'worker.sock');
  try {
    const response = await callSocket(socketPath, 'heartbeat', {
      attempt_id: activeAttempt.attempt_id,
      assignment_fence: activeAttempt.assignment_fence,
      activity: activeAttempt.current_activity ?? 'sidecar-watchdog',
      progress_counter: typeof activeAttempt.progress_counter === 'number' ? activeAttempt.progress_counter : 0,
    });
    if ('error' in response) {
      const failure = response as JsonRpcFailure;
      if (failure.error.code === 409) {
        return { exit: true, status: 'fence_rejected' };
      }
      return { exit: false, status: `error:${failure.error.code}` };
    }
    return { exit: false, status: 'ok' };
  } catch {
    return { exit: false, status: 'socket_error' };
  }
}

function readRehydrationPacket(authorityRoot: string, workerInstanceId: string): SidecarPacket {
  const packetPath = join(authorityRoot, 'rehydration', `${workerInstanceId}.json`);
  if (!existsSync(packetPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(packetPath, 'utf8')) as SidecarPacket;
  } catch {
    return {};
  }
}

function readMailbox(mailboxPath: string): { messages: Array<Record<string, unknown>> } {
  if (!existsSync(mailboxPath)) {
    return { messages: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(mailboxPath, 'utf8')) as { messages?: Array<Record<string, unknown>> };
    return { messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
  } catch {
    return { messages: [] };
  }
}

function mergeMessages(
  existing: Array<Record<string, unknown>>,
  next: unknown[],
): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const message of existing) {
    const key = typeof message.message_id === 'string' ? message.message_id : JSON.stringify(message);
    merged.set(key, message);
  }
  for (const message of next) {
    if (message && typeof message === 'object') {
      const record = message as Record<string, unknown>;
      const key = typeof record.message_id === 'string' ? record.message_id : JSON.stringify(record);
      merged.set(key, record);
    }
  }
  return Array.from(merged.values()).slice(-50);
}

function parseInterval(args: string[]): number {
  const index = args.findIndex((arg) => arg === '--interval');
  if (index === -1) {
    return 2000;
  }
  const value = Number(args[index + 1] ?? 2000);
  return Number.isFinite(value) && value > 0 ? value : 2000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
