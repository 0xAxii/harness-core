import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function seedScenario(controller, authorityRoot, options) {
  const createdAt = now();
  controller.db.createSession({
    session_id: options.sessionId,
    family: 'code-oriented',
    config_path: undefined,
    authority_root: authorityRoot,
    status: 'active',
    created_at: createdAt,
    updated_at: createdAt,
  });
  ensureWorkerMemoryFile(authorityRoot, options.workerId, options.sessionId, options.roleLabel);
  controller.db.insertWorker({
    worker_instance_id: options.workerId,
    session_id: options.sessionId,
    role_label: options.roleLabel,
    runtime_handle: options.runtimeHandle,
    generation: options.generation,
    capability_profile: {
      fs_scope: [],
      network_profile: 'deny',
      browser_access: false,
      publish_right: false,
      shared_resource_modes: [],
      secret_classes: [],
    },
    supervisor_state: 'exited',
    blocked_reason: undefined,
    current_attempt_id: options.attemptId,
    memory_ref: undefined,
    started_at: createdAt,
    stopped_at: undefined,
    updated_at: createdAt,
  });
  controller.db.insertTask({
    task_id: options.taskId,
    session_id: options.sessionId,
    task_class: 'code',
    subject: 'reconcile smoke',
    description: 'verify restart reconcile',
    priority: 0,
    required_capabilities: [],
    desired_outputs: [],
    status: 'active',
    created_at: createdAt,
    updated_at: createdAt,
  });
  controller.db.insertAttempt({
    attempt_id: options.attemptId,
    task_id: options.taskId,
    worker_instance_id: options.workerId,
    assignment_fence: options.generation,
    status: 'running',
    current_activity: 'assigned',
    progress_counter: 0,
    error_summary: undefined,
    started_at: createdAt,
    last_heartbeat_at: undefined,
    last_meaningful_change_at: createdAt,
    completed_at: undefined,
  });
}

function listEvents(controller) {
  return controller.db.db
    .prepare('SELECT event_type, subject_id, payload FROM events ORDER BY created_at ASC')
    .all();
}

async function runSuccessScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'restart-reconcile-success-'));
  const controller = buildController(authorityRoot);
  const workerId = 'worker-pwn';
  const attemptId = 'attempt-1';
  const sessionId = 'reconcile-success';
  const generation = 1;
  const runtimeHandle = `tmux:h-reconcile-${randomUUID().slice(0, 8)}`;
  const observedCalls = [];

  try {
    seedScenario(controller, authorityRoot, {
      sessionId,
      workerId,
      taskId: 'task-1',
      attemptId,
      roleLabel: 'pwnworker',
      runtimeHandle,
      generation,
    });

    controller.supervisor.adoptWorker = async (options, handle) => {
      observedCalls.push({ options, handle });
      return true;
    };

    await controller.reconcileWorkers();

    const worker = controller.db.getWorker(workerId);
    const packet = JSON.parse(readFileSync(join(authorityRoot, 'rehydration', `${workerId}.json`), 'utf8'));
    const events = listEvents(controller);

    assert(observedCalls.length === 1, 'expected one supervisor adoption call');
    assert(observedCalls[0].handle === runtimeHandle, 'expected reconcile to reuse existing runtime handle');
    assert(worker?.runtime_handle === runtimeHandle, 'expected runtime handle to remain bound after reconcile');
    assert(worker?.supervisor_state === 'started', 'expected worker supervisor state to return to started');
    assert(packet.worker_generation === generation, 'expected worker packet generation to match active generation');
    assert(packet.active_attempt?.attempt_id === attemptId, 'expected active attempt to be preserved in packet');
    assert(packet.active_attempt?.assignment_fence === generation, 'expected packet fence to match active attempt fence');
    assert(events.some((event) => event.event_type === 'worker_reconciled'), 'expected worker_reconciled event');

    return {
      scenario: 'adopt-existing-runtime',
      authority_root: authorityRoot,
      runtime_handle: runtimeHandle,
      observed_calls: observedCalls.length,
      worker_state: worker,
      packet,
      events,
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function runMissingRuntimeScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'restart-reconcile-missing-'));
  const controller = buildController(authorityRoot);
  const workerId = 'worker-pwn';
  const sessionId = 'reconcile-missing';
  const runtimeHandle = `tmux:h-missing-${randomUUID().slice(0, 8)}`;

  try {
    seedScenario(controller, authorityRoot, {
      sessionId,
      workerId,
      taskId: 'task-1',
      attemptId: 'attempt-1',
      roleLabel: 'pwnworker',
      runtimeHandle,
      generation: 1,
    });

    controller.supervisor.adoptWorker = async () => false;

    await controller.reconcileWorkers();

    const worker = controller.db.getWorker(workerId);
    const events = listEvents(controller);

    assert(worker?.runtime_handle === undefined, 'expected missing runtime to be unbound');
    assert(worker?.supervisor_state === 'exited', 'expected missing runtime to transition to exited');
    assert(events.some((event) => event.event_type === 'worker_runtime_missing'), 'expected worker_runtime_missing event');

    return {
      scenario: 'drop-missing-runtime',
      authority_root: authorityRoot,
      worker_state: worker,
      events,
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function main() {
  const results = [
    await runSuccessScenario(),
    await runMissingRuntimeScenario(),
  ];
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
