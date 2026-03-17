import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonRpcFailure } from '../protocol/jsonrpc.js';
import { callSocket, resolveAuthorityRoot } from './client.js';
import { isLeaderWorker, resolveLeaderWorker } from './leader.js';

interface WorkerSummary {
  worker_instance_id: string;
  role_label: string;
  generation: number;
  supervisor_state: string;
  current_attempt_id?: string;
  runtime_handle?: string;
}

interface StatusPayload {
  workers?: WorkerSummary[];
}

export async function runListWorkersCommand(args: string[]): Promise<void> {
  const [sessionId = 'dev-session'] = args;
  const payload = await fetchStatus(sessionId);
  const workers = payload.workers ?? [];
  if (workers.length === 0) {
    process.stdout.write('(no workers)\n');
    return;
  }

  const leader = resolveLeaderWorker(workers);
  const rows = workers.map((worker) => [
    isLeaderWorker(worker, leader?.worker_instance_id) ? 'leader' : '-',
    worker.worker_instance_id,
    worker.role_label,
    String(worker.generation),
    worker.supervisor_state,
    worker.current_attempt_id ?? '-',
    worker.runtime_handle ?? '-',
  ]).sort((a, b) => Number(b[0] === 'leader') - Number(a[0] === 'leader'));
  process.stdout.write(renderTable(
    ['default', 'worker_id', 'role', 'gen', 'state', 'attempt', 'runtime'],
    rows,
  ));
}

export async function runAttachWorkerCommand(args: string[]): Promise<void> {
  const printOnly = args.includes('--print-target');
  const { filteredArgs, target } = parseTmuxTargetArgs(args.filter((arg) => arg !== '--print-target'));
  const [sessionId = 'dev-session', workerId] = filteredArgs;
  const worker = await fetchWorker(sessionId, workerId);
  if (!worker.runtime_handle?.startsWith('tmux:')) {
    throw new Error(`worker ${worker.worker_instance_id} has no tmux runtime handle`);
  }
  const tmuxSession = worker.runtime_handle.slice('tmux:'.length);
  const tmuxTarget = `${tmuxSession}:${target.window}.${target.pane}`;
  const tmuxWindow = `${tmuxSession}:${target.window}`;

  if (printOnly || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${tmuxTarget}\n`);
    return;
  }

  if (process.env.TMUX) {
    execFileSync('tmux', ['switch-client', '-t', tmuxWindow], { stdio: 'inherit' });
    execFileSync('tmux', ['select-pane', '-t', tmuxTarget], { stdio: 'inherit' });
    return;
  }

  execFileSync('tmux', ['select-pane', '-t', tmuxTarget], { stdio: 'ignore' });
  execFileSync('tmux', ['attach-session', '-t', tmuxWindow], { stdio: 'inherit' });
}

export async function runShowMailboxCommand(args: string[]): Promise<void> {
  const [sessionId = 'dev-session', workerId] = args;
  const worker = await fetchWorker(sessionId, workerId);
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const mailboxPath = join(authorityRoot, 'runtime', 'mailbox', `${worker.worker_instance_id}.json`);
  process.stdout.write(readRuntimeJsonFile(mailboxPath));
}

export async function runShowHeartbeatCommand(args: string[]): Promise<void> {
  const [sessionId = 'dev-session', workerId] = args;
  const worker = await fetchWorker(sessionId, workerId);
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const heartbeatPath = join(authorityRoot, 'runtime', 'heartbeat', `${worker.worker_instance_id}.json`);
  process.stdout.write(readRuntimeJsonFile(heartbeatPath));
}

export async function runTailWorkerCommand(args: string[]): Promise<void> {
  const linesArgIndex = args.findIndex((arg) => arg === '--lines');
  const lines = linesArgIndex === -1 ? 80 : parseLineCount(args[linesArgIndex + 1]);
  const withoutLines = args.filter((_, index) => index !== linesArgIndex && index !== linesArgIndex + 1);
  const { filteredArgs, target } = parseTmuxTargetArgs(withoutLines);
  const [sessionId = 'dev-session', workerId] = filteredArgs;
  const worker = await fetchWorker(sessionId, workerId);
  if (!worker.runtime_handle?.startsWith('tmux:')) {
    throw new Error(`worker ${worker.worker_instance_id} has no tmux runtime handle`);
  }
  const tmuxSession = worker.runtime_handle.slice('tmux:'.length);
  const tmuxTarget = `${tmuxSession}:${target.window}.${target.pane}`;
  const output = execFileSync('tmux', ['capture-pane', '-pt', tmuxTarget, '-S', `-${lines}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output);
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

async function fetchWorker(sessionId: string, workerId?: string): Promise<WorkerSummary> {
  const payload = await fetchStatus(sessionId);
  const workers = payload.workers ?? [];
  const worker = workerId
    ? workers.find((entry) => entry.worker_instance_id === workerId)
    : resolveLeaderWorker(workers);
  if (!worker) {
    throw new Error(workerId ? `worker not found: ${workerId}` : `no worker available for session ${sessionId}`);
  }
  return worker;
}

function readRuntimeJsonFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return raw.endsWith('\n') ? raw : `${raw}\n`;
  }
}

function parseLineCount(value: string | undefined): number {
  const parsed = Number(value ?? 80);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
}

function parseTmuxTargetArgs(args: string[]): { filteredArgs: string[]; target: { window: number; pane: number } } {
  let window = 0;
  let pane = 0;
  const filteredArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--window') {
      window = parseNonNegativeInt(args[index + 1], '--window');
      index += 1;
      continue;
    }
    if (arg === '--pane') {
      pane = parseNonNegativeInt(args[index + 1], '--pane');
      index += 1;
      continue;
    }
    filteredArgs.push(arg);
  }
  return { filteredArgs, target: { window, pane } };
}

function parseNonNegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (columns: string[]) =>
    `${columns.map((column, index) => column.padEnd(widths[index] ?? 0)).join('  ')}`;
  return [
    format(headers),
    format(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => format(row)),
  ].join('\n') + '\n';
}
