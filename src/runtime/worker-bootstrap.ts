import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CapabilityProfile } from '../types/model.js';

export interface WorkerBootstrapOptions {
  authorityRoot: string;
  sessionId: string;
  workerInstanceId: string;
  roleLabel: string;
  generation: number;
  workingDir: string;
  cliPath: string;
  memoryRef?: string;
  memoryPath: string;
  capabilityProfile: CapabilityProfile;
}

export function writeWorkerBootstrapScript(options: WorkerBootstrapOptions): string {
  const runtimeDir = join(options.authorityRoot, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });

  const scriptPath = join(runtimeDir, `${options.workerInstanceId}-g${options.generation}.sh`);
  const promptPath = join(runtimeDir, `${options.workerInstanceId}-g${options.generation}.prompt.txt`);
  const helperPath = join(runtimeDir, `${options.workerInstanceId}-g${options.generation}.helpers.sh`);

  writeFileSync(promptPath, buildWorkerPrompt(options), 'utf8');
  writeFileSync(helperPath, buildWorkerHelpers(options), 'utf8');
  chmodSync(helperPath, 0o755);
  writeFileSync(scriptPath, buildWorkerScript(promptPath, helperPath), 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function buildWorkerPrompt(options: WorkerBootstrapOptions): string {
  return [
    `You are worker ${options.workerInstanceId} for harness session ${options.sessionId}.`,
    `Your role label is ${options.roleLabel}.`,
    '',
    'Bootstrap rules:',
    `1. Read the rehydration packet at ${join(options.authorityRoot, 'rehydration', `${options.workerInstanceId}.json`)}.`,
    '   That packet includes a memory excerpt and the current memory file path.',
    '2. Use the active_attempt inside that packet as the current assignment if present.',
    '3. Do not invent a different task. Stay on the assigned attempt until completed, failed, or replaced.',
    '4. Send progress heartbeats with the harness CLI while you work.',
    '5. Complete the attempt through the harness CLI when finished.',
    '6. Poll directed messages if you need fresh operator instructions.',
    '7. Register important files or notes as artifacts before claiming success.',
    '8. The sidecar sends fallback heartbeats automatically; still send explicit heartbeats when progress meaningfully changes.',
    `9. Use the durable worker memory file at ${options.memoryPath} for stable findings you want to survive session recycle.`,
    '',
    'Heartbeat form:',
    `node ${options.cliPath} worker heartbeat ${options.sessionId} <attempt_id> <assignment_fence> <activity> <progress_counter>`,
    '',
    'Completion form:',
    `node ${options.cliPath} worker complete ${options.sessionId} <attempt_id> <assignment_fence> completed`,
    '',
    'Failure form:',
    `node ${options.cliPath} worker complete ${options.sessionId} <attempt_id> <assignment_fence> failed "<error_summary>"`,
    '',
    'Blocked form:',
    `node ${options.cliPath} worker report-blocked ${options.sessionId} <attempt_id> <assignment_fence> "<reason>"`,
    '',
    'Poll messages form:',
    `node ${options.cliPath} worker poll ${options.sessionId} ${options.workerInstanceId} ${options.generation}`,
    '',
    'Artifact form:',
    `node ${options.cliPath} worker ingest-artifact ${options.sessionId} <attempt_id> <assignment_fence> <artifact_id> <kind> <source_path> [note...]`,
    '',
    `External memory reference: ${options.memoryRef ?? 'none'}`,
    `Working directory: ${options.workingDir}`,
    `Capability profile: ${JSON.stringify(options.capabilityProfile)}`,
    'Treat the capability profile as a hard runtime boundary. Do not assume network, browser, shared-write, or publish access beyond what it grants.',
    '',
    'Shell helpers are preloaded in the session:',
    '- harness_attempt_id',
    '- harness_fence',
    '- harness_poll',
    '- harness_mailbox',
    '- harness_memory',
    '- harness_heartbeat <activity> <progress>',
    '- harness_blocked "<reason>"',
    '- harness_complete',
    '- harness_fail "<reason>"',
    '- harness_send <target-worker> <kind> <payload...>',
    '- harness_artifact <artifact-id> <kind> <path> [note...]',
    '',
    'Start by reading the rehydration packet and summarizing the active attempt before acting.',
  ].join('\n');
}

function buildWorkerScript(promptPath: string, helperPath: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

cd "$HARNESS_WORKER_CWD"

source "${helperPath}"

if ! command -v codex >/dev/null 2>&1; then
  printf '[harness] codex not found; falling back to interactive shell\\n'
  exec bash -i
fi

PROMPT_CONTENT="$(cat "${promptPath}")"
SANDBOX_MODE="\${HARNESS_CODEX_SANDBOX:-workspace-write}"
APPROVAL_POLICY="\${HARNESS_CODEX_APPROVAL:-never}"
EXTRA_ARGS="\${HARNESS_CODEX_EXTRA_ARGS:-}"

printf '[harness] launching codex for %s generation=%s\\n' "$HARNESS_WORKER_ID" "$HARNESS_WORKER_GENERATION"

if [ -n "$EXTRA_ARGS" ]; then
  # shellcheck disable=SC2086
  exec codex --no-alt-screen -a "$APPROVAL_POLICY" -s "$SANDBOX_MODE" -C "$HARNESS_WORKER_CWD" $EXTRA_ARGS "$PROMPT_CONTENT"
fi

exec codex --no-alt-screen -a "$APPROVAL_POLICY" -s "$SANDBOX_MODE" -C "$HARNESS_WORKER_CWD" "$PROMPT_CONTENT"
`;
}

function buildWorkerHelpers(options: WorkerBootstrapOptions): string {
  return `#!/usr/bin/env bash
set -euo pipefail

harness_packet() {
  cat "$HARNESS_REHYDRATION_PACKET"
}

harness_attempt_id() {
  node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (p.active_attempt?.attempt_id) console.log(p.active_attempt.attempt_id);' "$HARNESS_REHYDRATION_PACKET"
}

harness_fence() {
  node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (p.active_attempt?.assignment_fence !== undefined) console.log(p.active_attempt.assignment_fence);' "$HARNESS_REHYDRATION_PACKET"
}

harness_poll() {
  node "${options.cliPath}" worker poll "${options.sessionId}" "${options.workerInstanceId}" "$HARNESS_WORKER_GENERATION"
}

harness_mailbox() {
  cat "$HARNESS_AUTHORITY_ROOT/runtime/mailbox/$HARNESS_WORKER_ID.json"
}

harness_memory() {
  cat "$HARNESS_MEMORY_FILE"
}

harness_heartbeat() {
  local activity="\${1:-working}"
  local progress="\${2:-0}"
  local attempt_id
  local fence
  attempt_id="$(harness_attempt_id)"
  fence="$(harness_fence)"
  node "${options.cliPath}" worker heartbeat "${options.sessionId}" "$attempt_id" "$fence" "$activity" "$progress"
}

harness_blocked() {
  local reason="\${1:-blocked}"
  local attempt_id
  local fence
  attempt_id="$(harness_attempt_id)"
  fence="$(harness_fence)"
  node "${options.cliPath}" worker report-blocked "${options.sessionId}" "$attempt_id" "$fence" "$reason"
}

harness_complete() {
  local attempt_id
  local fence
  attempt_id="$(harness_attempt_id)"
  fence="$(harness_fence)"
  node "${options.cliPath}" worker complete "${options.sessionId}" "$attempt_id" "$fence" completed
}

harness_fail() {
  local reason="\${1:-unknown failure}"
  local attempt_id
  local fence
  attempt_id="$(harness_attempt_id)"
  fence="$(harness_fence)"
  node "${options.cliPath}" worker complete "${options.sessionId}" "$attempt_id" "$fence" failed "$reason"
}

harness_send() {
  local target="\${1:?target worker required}"
  local kind="\${2:-note}"
  shift 2 || true
  local payload="$*"
  local attempt_id
  local fence
  attempt_id="$(harness_attempt_id)"
  fence="$(harness_fence)"
  node "${options.cliPath}" worker send-message "${options.sessionId}" "$attempt_id" "$fence" "$target" "$kind" "$payload"
}

harness_artifact() {
  local artifact_id="\${1:?artifact id required}"
  local kind="\${2:?artifact kind required}"
  local source_path="\${3:?source path required}"
  shift 3 || true
  local attempt_id
  local fence
  attempt_id="$(harness_attempt_id)"
  fence="$(harness_fence)"
  node "${options.cliPath}" worker ingest-artifact "${options.sessionId}" "$attempt_id" "$fence" "$artifact_id" "$kind" "$source_path" "$*"
}
`;
}
