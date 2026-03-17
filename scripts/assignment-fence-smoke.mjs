import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function assertSuccess(response, message) {
  assert(!('error' in response), `${message}: ${response.error?.message ?? 'unknown error'}`);
  return response.result;
}

function seedWorker(controller, authorityRoot, options) {
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
    runtime_handle: undefined,
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
    current_attempt_id: undefined,
    memory_ref: undefined,
    started_at: createdAt,
    stopped_at: undefined,
    updated_at: createdAt,
  });
}

function insertTask(controller, sessionId, taskId, subject, description) {
  const createdAt = now();
  controller.db.insertTask({
    task_id: taskId,
    session_id: sessionId,
    task_class: 'code',
    subject,
    description,
    priority: 0,
    required_capabilities: [],
    desired_outputs: [],
    status: 'open',
    created_at: createdAt,
    updated_at: createdAt,
  });
}

function listEvents(controller) {
  return controller.db.db
    .prepare('SELECT global_seq, event_type, subject_id, payload FROM events ORDER BY global_seq ASC')
    .all();
}

async function main() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'assignment-fence-smoke-'));
  const controller = buildController(authorityRoot);
  const sessionId = 'assignment-fence-smoke';
  const workerId = 'worker-pwn';
  const workerRole = 'pwnworker';

  try {
    seedWorker(controller, authorityRoot, { sessionId, workerId, roleLabel: workerRole });
    insertTask(controller, sessionId, 'task-1', 'first task', 'first assignment');
    insertTask(controller, sessionId, 'task-2', 'second task', 'second assignment');

    const firstAssignment = assertSuccess(
      controller.assignAttempt({
        jsonrpc: '2.0',
        id: 'assign-1',
        method: 'assign_attempt',
        params: {
          task_id: 'task-1',
          attempt_id: 'attempt-1',
          worker_instance_id: workerId,
        },
      }),
      'first assignment failed',
    );
    assert(firstAssignment.assignment_fence === 1, 'expected first assignment fence to start at 1');

    assertSuccess(
      controller.completeAttempt({
        jsonrpc: '2.0',
        id: 'complete-1',
        method: 'complete_attempt',
        params: {
          attempt_id: 'attempt-1',
          assignment_fence: 1,
          status: 'completed',
        },
      }),
      'first completion failed',
    );

    const secondAssignment = assertSuccess(
      controller.assignAttempt({
        jsonrpc: '2.0',
        id: 'assign-2',
        method: 'assign_attempt',
        params: {
          task_id: 'task-2',
          attempt_id: 'attempt-2',
          worker_instance_id: workerId,
        },
      }),
      'second assignment failed',
    );

    const worker = controller.db.getWorker(workerId);
    const attempt2 = controller.db.getAttempt('attempt-2');
    const task1 = controller.db.getTask('task-1');
    const task2 = controller.db.getTask('task-2');
    const packet = JSON.parse(readFileSync(join(authorityRoot, 'rehydration', `${workerId}.json`), 'utf8'));
    const events = listEvents(controller);

    assert(secondAssignment.assignment_fence === 2, 'expected second assignment fence to advance to 2');
    assert(worker?.generation === 1, 'expected worker generation to remain unchanged');
    assert(worker?.current_attempt_id === 'attempt-2', 'expected worker active attempt to move to attempt-2');
    assert(task1?.status === 'provisional', 'expected first task to move to provisional after completion');
    assert(task2?.status === 'active', 'expected second task to be active after assignment');
    assert(attempt2?.assignment_fence === 2, 'expected persisted second attempt fence to be 2');
    assert(packet.worker_generation === 1, 'expected packet generation to remain 1');
    assert(packet.active_attempt?.attempt_id === 'attempt-2', 'expected packet to point at the second attempt');
    assert(packet.active_attempt?.assignment_fence === 2, 'expected packet fence to track the second attempt');
    assert(
      events.filter((event) => event.event_type === 'attempt_assigned').map((event) => event.subject_id).join(',') === 'attempt-1,attempt-2',
      'expected two attempt_assigned events in order',
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          authority_root: authorityRoot,
          first_assignment: firstAssignment,
          second_assignment: secondAssignment,
          worker,
          attempt2,
          packet,
          events,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
