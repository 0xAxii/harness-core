import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessController } from '../dist/controller/index.js';
import { ensureWorkerMemoryFile } from '../dist/runtime/memory.js';

function now() {
  return new Date().toISOString();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildController(authorityRoot) {
  return new HarnessController({
    dbPath: join(authorityRoot, 'state.db'),
    workerSocketPath: join(authorityRoot, 'worker.sock'),
    adminSocketPath: join(authorityRoot, 'admin.sock'),
  });
}

async function main() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'cancel-replay-smoke-'));
  const controller = buildController(authorityRoot);
  const sessionId = 'cancel-replay-smoke';
  const workerId = 'worker-pwn';
  const taskId = 'task-1';
  const attemptId = 'attempt-1';
  const runtimeHandle = `tmux:h-cancel-${randomUUID().slice(0, 8)}`;
  const createdAt = now();
  const terminated = [];

  try {
    controller.db.createSession({
      session_id: sessionId,
      family: 'code-oriented',
      config_path: undefined,
      authority_root: authorityRoot,
      status: 'active',
      created_at: createdAt,
      updated_at: createdAt,
    });
    ensureWorkerMemoryFile(authorityRoot, workerId, sessionId, 'pwnworker');
    controller.db.insertWorker({
      worker_instance_id: workerId,
      session_id: sessionId,
      role_label: 'pwnworker',
      runtime_handle: runtimeHandle,
      generation: 1,
      capability_profile: {
        fs_scope: [],
        network_profile: 'deny',
        browser_access: false,
        publish_right: false,
        shared_resource_modes: [],
        secret_classes: [],
      },
      supervisor_state: 'started',
      blocked_reason: undefined,
      current_attempt_id: attemptId,
      memory_ref: undefined,
      started_at: createdAt,
      stopped_at: undefined,
      updated_at: createdAt,
    });
    controller.db.insertTask({
      task_id: taskId,
      session_id: sessionId,
      task_class: 'code',
      subject: 'cancel replay',
      description: 'verify pending cancel replay',
      priority: 0,
      required_capabilities: [],
      desired_outputs: [],
      status: 'active',
      created_at: createdAt,
      updated_at: createdAt,
    });
    controller.db.insertAttempt({
      attempt_id: attemptId,
      task_id: taskId,
      worker_instance_id: workerId,
      assignment_fence: 1,
      status: 'running',
      current_activity: 'working',
      progress_counter: 3,
      error_summary: undefined,
      started_at: createdAt,
      last_heartbeat_at: createdAt,
      last_meaningful_change_at: createdAt,
      completed_at: undefined,
    });
    controller.db.insertControllerCommand({
      command_id: 'cmd-cancel-1',
      session_id: sessionId,
      kind: 'cancel_attempt',
      status: 'pending',
      step_state: 'cancel_requested',
      payload: {
        attempt_id: attemptId,
        worker_instance_id: workerId,
      },
      created_at: createdAt,
      updated_at: createdAt,
    });

    controller.supervisor.terminateWorker = async (options) => {
      terminated.push(options.runtimeHandle);
      return true;
    };

    await controller.reconcileControllerCommands();

    const worker = controller.db.getWorker(workerId);
    const attempt = controller.db.getAttempt(attemptId);
    const commands = controller.db.listSessionControllerCommands(sessionId, 10);

    assert(terminated.includes(runtimeHandle), 'expected terminateWorker to be called with current runtime handle');
    assert(worker?.generation === 2, 'expected cancel replay to advance worker generation');
    assert(worker?.runtime_handle === undefined, 'expected worker runtime to be cleared after cancel replay');
    assert(worker?.current_attempt_id === undefined, 'expected worker active attempt to be cleared');
    assert(attempt?.status === 'cancelled', 'expected attempt to be cancelled');
    assert(commands[0]?.status === 'reconciled', 'expected cancel command to reconcile');
    assert(commands[0]?.step_state === 'cleanup_done', 'expected cancel command cleanup_done');

    process.stdout.write(`${JSON.stringify({ ok: true, worker, attempt, commands }, null, 2)}\n`);
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
