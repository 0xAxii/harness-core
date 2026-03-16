import { join } from 'node:path';
import type { JsonRpcFailure } from '../protocol/jsonrpc.js';
import { callSocket, resolveAuthorityRoot } from './client.js';

interface StatusPayload {
  session: {
    session_id: string;
    family: string;
    status: string;
    authority_root: string;
    created_at: string;
    updated_at: string;
  };
  tasks?: Array<{ task_id: string; task_class: string; subject: string; status: string }>;
  workers?: Array<{ worker_instance_id: string; role_label: string; generation: number; supervisor_state: string; current_attempt_id?: string; blocked_reason?: string }>;
  attempts?: Array<{
    attempt_id: string;
    task_id: string;
    worker_instance_id: string;
    assignment_fence: number;
    status: string;
    current_activity?: string;
    progress_counter: number;
    last_heartbeat_at?: string;
    last_meaningful_change_at?: string;
  }>;
  artifacts?: Array<{ artifact_id: string; attempt_id?: string; kind: string; status: string; digest: string }>;
  validations?: Array<{ validation_id: string; attempt_id: string; kind: string; decision: string; validator_ref?: string }>;
  controller_commands?: Array<{ command_id: string; kind: string; status: string; step_state: string; created_at: string }>;
}

export async function runHudCommand(args: string[]): Promise<void> {
  const [sessionId = 'dev-session', ...rest] = args;
  const watch = rest.includes('--watch');
  const intervalMs = parseInterval(rest);

  if (!watch) {
    const payload = await fetchStatus(sessionId);
    process.stdout.write(renderHud(payload));
    return;
  }

  while (true) {
    const payload = await fetchStatus(sessionId);
    process.stdout.write('\x1bc');
    process.stdout.write(renderHud(payload));
    await sleep(intervalMs);
  }
}

async function fetchStatus(sessionId: string): Promise<StatusPayload> {
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const socketPath = join(authorityRoot, 'admin.sock');
  const response = await callSocket(socketPath, 'status', { session_id: sessionId });
  if ('error' in response) {
    throw new Error((response as JsonRpcFailure).error.message);
  }
  return response.result as StatusPayload;
}

function renderHud(payload: StatusPayload): string {
  const lines: string[] = [];
  const session = payload.session;
  const tasks = payload.tasks ?? [];
  const workers = payload.workers ?? [];
  const attempts = payload.attempts ?? [];
  const artifacts = payload.artifacts ?? [];
  const validations = payload.validations ?? [];
  const commands = payload.controller_commands ?? [];

  lines.push(`Session  ${session.session_id}`);
  lines.push(`Family   ${session.family}`);
  lines.push(`Status   ${session.status}`);
  lines.push(`Root     ${session.authority_root}`);
  lines.push('');

  lines.push(`Tasks (${tasks.length})`);
  lines.push(...renderTable(
    ['task_id', 'class', 'status', 'subject'],
    tasks.map((task) => [task.task_id, task.task_class, task.status, task.subject]),
  ));
  lines.push('');

  lines.push(`Workers (${workers.length})`);
  lines.push(...renderTable(
    ['worker_id', 'role', 'gen', 'state', 'attempt', 'blocked'],
    workers.map((worker) => [
      worker.worker_instance_id,
      worker.role_label,
      String(worker.generation),
      worker.supervisor_state,
      worker.current_attempt_id ?? '-',
      worker.blocked_reason ?? '-',
    ]),
  ));
  lines.push('');

  lines.push(`Attempts (${attempts.length})`);
  lines.push(...renderTable(
    ['attempt_id', 'task_id', 'worker', 'fence', 'status', 'activity', 'progress', 'last_hb', 'last_change'],
    attempts.map((attempt) => [
      attempt.attempt_id,
      attempt.task_id,
      attempt.worker_instance_id,
      String(attempt.assignment_fence),
      attempt.status,
      attempt.current_activity ?? '-',
      String(attempt.progress_counter),
      formatTimestamp(attempt.last_heartbeat_at),
      formatTimestamp(attempt.last_meaningful_change_at),
    ]),
  ));
  lines.push('');

  lines.push(`Artifacts (${artifacts.length})`);
  lines.push(...renderTable(
    ['artifact_id', 'attempt', 'kind', 'status', 'digest'],
    artifacts.map((artifact) => [
      artifact.artifact_id,
      artifact.attempt_id ?? '-',
      artifact.kind,
      artifact.status,
      artifact.digest.slice(0, 12),
    ]),
  ));
  lines.push('');

  lines.push(`Validations (${validations.length})`);
  lines.push(...renderTable(
    ['validation_id', 'attempt', 'kind', 'decision', 'validator'],
    validations.map((validation) => [
      validation.validation_id.slice(0, 8),
      validation.attempt_id,
      validation.kind,
      validation.decision,
      validation.validator_ref ?? '-',
    ]),
  ));
  lines.push('');

  lines.push(`Controller Commands (${commands.length})`);
  lines.push(...renderTable(
    ['command_id', 'kind', 'status', 'step', 'created_at'],
    commands.map((command) => [
      command.command_id.slice(0, 8),
      command.kind,
      command.status,
      command.step_state,
      command.created_at,
    ]),
  ));
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function renderTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) {
    return ['  (empty)'];
  }
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (columns: string[]) =>
    `  ${columns.map((column, index) => column.padEnd(widths[index] ?? 0)).join('  ')}`;
  return [
    format(headers),
    format(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => format(row)),
  ];
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

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return '-';
  }
  return value.replace('T', ' ').replace('.000Z', 'Z');
}
