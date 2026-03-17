import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HarnessController } from '../dist/controller/index.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildController(authorityRoot) {
  const controller = new HarnessController({
    dbPath: join(authorityRoot, 'state.db'),
    workerSocketPath: join(authorityRoot, 'worker.sock'),
    adminSocketPath: join(authorityRoot, 'admin.sock'),
  });
  controller.ensureAdminToken(dirname(controller.paths.dbPath));
  controller.supervisor.launchWorker = async () => ({
    runtimeHandle: `tmux:${randomUUID().slice(0, 8)}`,
    generation: 1,
  });
  controller.supervisor.recycleWorker = async (options) => ({
    runtimeHandle: `tmux:${options.workerInstanceId}-g${options.generation}`,
    generation: options.generation,
  });
  return controller;
}

function workerProfile() {
  return {
    fs_scope: [],
    network_profile: 'deny',
    browser_access: false,
    publish_right: false,
    shared_resource_modes: [],
    secret_classes: [],
  };
}

async function admin(controller, id, method, params) {
  const authToken = readAdminToken(controller.paths.dbPath);
  return controller.handleAdminRequest({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      auth_token: authToken,
    },
  });
}

async function worker(controller, id, method, params) {
  const authToken = params?.worker_instance_id
    ? readWorkerToken(controller.paths.dbPath, params.worker_instance_id)
    : readWorkerTokenForAttempt(controller, params?.attempt_id);
  return controller.handleWorkerRequest({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      auth_token: authToken,
    },
  });
}

function readAdminToken(dbPath) {
  const tokenPath = join(authorityRootForDb(dbPath), 'runtime', 'auth', 'admin.token');
  return readFileSync(tokenPath, 'utf8').trim();
}

function readWorkerToken(dbPath, workerInstanceId) {
  const tokenPath = join(authorityRootForDb(dbPath), 'runtime', 'auth', `${workerInstanceId}.token`);
  return readFileSync(tokenPath, 'utf8').trim();
}

function readWorkerTokenForAttempt(controller, attemptId) {
  const attempt = controller.db.getAttempt(attemptId);
  assert(attempt, `missing attempt for token lookup: ${attemptId}`);
  return readWorkerToken(controller.paths.dbPath, attempt.worker_instance_id);
}

function authorityRootForDb(dbPath) {
  return dirname(dbPath);
}

function expectResult(response, message) {
  assert(response && 'result' in response, `${message}: ${JSON.stringify(response)}`);
  return response.result;
}

function expectError(response, code, messageFragment) {
  assert(response && 'error' in response, `expected error response: ${JSON.stringify(response)}`);
  assert(response.error.code === code, `expected error code ${code}, got ${response.error.code}`);
  if (messageFragment) {
    assert(
      String(response.error.message).includes(messageFragment),
      `expected error message to include "${messageFragment}", got "${response.error.message}"`,
    );
  }
}

async function seedWorker(controller, authorityRoot, sessionId) {
  expectResult(
    await admin(controller, 1, 'create_session', {
      session_id: sessionId,
      authority_root: authorityRoot,
    }),
    'create_session failed',
  );
  expectResult(
    await admin(controller, 2, 'launch_worker', {
      session_id: sessionId,
      worker_instance_id: 'worker-pwn',
      role_label: 'pwnworker',
      capability_profile: workerProfile(),
    }),
    'launch_worker failed',
  );
}

async function runSequentialAssignmentScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'gate-fix-sequential-'));
  const controller = buildController(authorityRoot);

  try {
    await seedWorker(controller, authorityRoot, 'gate-fix-sequential');
    expectResult(await admin(controller, 3, 'create_task', {
      session_id: 'gate-fix-sequential',
      task_id: 'task-1',
      task_class: 'code',
      subject: 'task one',
      description: 'first attempt',
    }), 'create task-1 failed');
    expectResult(await admin(controller, 4, 'create_task', {
      session_id: 'gate-fix-sequential',
      task_id: 'task-2',
      task_class: 'code',
      subject: 'task two',
      description: 'second attempt',
    }), 'create task-2 failed');

    const first = expectResult(await admin(controller, 5, 'assign_attempt', {
      task_id: 'task-1',
      attempt_id: 'attempt-1',
      worker_instance_id: 'worker-pwn',
    }), 'first assign failed');
    const second = await admin(controller, 6, 'assign_attempt', {
      task_id: 'task-2',
      attempt_id: 'attempt-2',
      worker_instance_id: 'worker-pwn',
    });

    expectError(second, 409, 'worker already has active attempt');

    const attempts = controller.db.listSessionAttempts('gate-fix-sequential');
    const workerState = controller.db.getWorker('worker-pwn');
    assert(first.assignment_fence === 1, 'expected first assignment fence 1');
    assert(attempts.length === 1, 'expected only one attempt for sequential worker');
    assert(workerState?.current_attempt_id === 'attempt-1', 'expected worker to retain first active attempt');

    return {
      scenario: 'sequential-assignment-gate',
      attempts,
      worker_state: workerState,
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function runLivenessHeartbeatScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'gate-fix-liveness-'));
  const controller = buildController(authorityRoot);

  try {
    await seedWorker(controller, authorityRoot, 'gate-fix-liveness');
    expectResult(await admin(controller, 3, 'create_task', {
      session_id: 'gate-fix-liveness',
      task_id: 'task-1',
      task_class: 'code',
      subject: 'task',
      description: 'heartbeat gate',
    }), 'create task failed');
    expectResult(await admin(controller, 4, 'assign_attempt', {
      task_id: 'task-1',
      attempt_id: 'attempt-1',
      worker_instance_id: 'worker-pwn',
    }), 'assign failed');

    const before = controller.db.getAttempt('attempt-1');
    const response = await worker(controller, 5, 'heartbeat', {
      attempt_id: 'attempt-1',
      assignment_fence: 1,
      activity: 'sidecar-watchdog',
      progress_counter: 0,
      liveness_only: true,
    });
    const after = controller.db.getAttempt('attempt-1');

    expectResult(response, 'liveness heartbeat failed');
    assert(before, 'expected attempt before heartbeat');
    assert(after, 'expected attempt after heartbeat');
    assert(after.status === 'assigned', 'expected liveness heartbeat to preserve assigned status');
    assert(after.current_activity === before.current_activity, 'expected liveness heartbeat to preserve activity');
    assert(after.progress_counter === before.progress_counter, 'expected liveness heartbeat to preserve progress');
    assert(
      after.last_meaningful_change_at === before.last_meaningful_change_at,
      'expected liveness heartbeat to preserve last meaningful change timestamp',
    );
    assert(after.last_heartbeat_at, 'expected liveness heartbeat to refresh last heartbeat timestamp');

    return {
      scenario: 'liveness-heartbeat-gate',
      before,
      after,
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function runValidationAndArtifactScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'gate-fix-validation-'));
  const controller = buildController(authorityRoot);

  try {
    await seedWorker(controller, authorityRoot, 'gate-fix-validation');
    expectResult(await admin(controller, 3, 'create_task', {
      session_id: 'gate-fix-validation',
      task_id: 'task-1',
      task_class: 'code',
      subject: 'task',
      description: 'validation gate',
    }), 'create task-1 failed');
    expectResult(await admin(controller, 4, 'assign_attempt', {
      task_id: 'task-1',
      attempt_id: 'attempt-1',
      worker_instance_id: 'worker-pwn',
    }), 'assign attempt-1 failed');

    expectError(
      await admin(controller, 5, 'validate_attempt', {
        attempt_id: 'attempt-1',
        kind: 'operator',
        decision: 'accepted',
        validator_ref: 'smoke',
      }),
      409,
      'attempt is not terminal',
    );

    expectResult(await worker(controller, 6, 'complete_attempt', {
      attempt_id: 'attempt-1',
      assignment_fence: 1,
      status: 'failed',
      error_summary: 'boom',
    }), 'complete attempt-1 failed');

    expectError(
      await admin(controller, 7, 'validate_attempt', {
        attempt_id: 'attempt-1',
        kind: 'operator',
        decision: 'accepted',
        validator_ref: 'smoke',
      }),
      409,
      'only completed attempts can be accepted',
    );

    expectResult(await admin(controller, 8, 'validate_attempt', {
      attempt_id: 'attempt-1',
      kind: 'operator',
      decision: 'rejected',
      validator_ref: 'smoke',
      notes: 'expected rejection path',
    }), 'reject validation failed');

    expectResult(await admin(controller, 9, 'create_task', {
      session_id: 'gate-fix-validation',
      task_id: 'task-2',
      task_class: 'code',
      subject: 'artifact task',
      description: 'artifact gate',
    }), 'create task-2 failed');
    const secondAssign = expectResult(await admin(controller, 10, 'assign_attempt', {
      task_id: 'task-2',
      attempt_id: 'attempt-2',
      worker_instance_id: 'worker-pwn',
    }), 'assign attempt-2 failed');

    const artifactDir = join(authorityRoot, 'artifacts');
    const artifactPath = join(artifactDir, 'note.txt');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, 'artifact gate smoke\n', 'utf8');

    expectResult(await worker(controller, 11, 'register_artifact', {
      attempt_id: 'attempt-2',
      assignment_fence: secondAssign.assignment_fence,
      artifact_id: 'artifact-1',
      kind: 'note',
      storage_uri: pathToFileURL(artifactPath).href,
      metadata: { source: 'smoke' },
    }), 'register artifact failed');

    expectResult(await admin(controller, 12, 'promote_artifact', {
      artifact_id: 'artifact-1',
      status: 'promoted',
      notes: 'first transition',
    }), 'promote artifact failed');
    expectError(
      await admin(controller, 13, 'reject_artifact', {
        artifact_id: 'artifact-1',
        status: 'rejected',
        notes: 'second transition should fail',
      }),
      409,
      'artifact update rejected',
    );

    return {
      scenario: 'validation-and-artifact-gates',
      task_status: controller.db.getTask('task-1')?.status,
      artifact: controller.db.getArtifact('artifact-1'),
      validations: controller.db.listSessionValidations('gate-fix-validation'),
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function runFenceMonotonicityScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'gate-fix-fence-'));
  const controller = buildController(authorityRoot);

  try {
    await seedWorker(controller, authorityRoot, 'gate-fix-fence');
    expectResult(await admin(controller, 3, 'create_task', {
      session_id: 'gate-fix-fence',
      task_id: 'task-1',
      task_class: 'code',
      subject: 'first task',
      description: 'first fence',
    }), 'create task-1 failed');
    expectResult(await admin(controller, 4, 'create_task', {
      session_id: 'gate-fix-fence',
      task_id: 'task-2',
      task_class: 'code',
      subject: 'second task',
      description: 'second fence',
    }), 'create task-2 failed');

    const firstAssign = expectResult(await admin(controller, 5, 'assign_attempt', {
      task_id: 'task-1',
      attempt_id: 'attempt-1',
      worker_instance_id: 'worker-pwn',
    }), 'assign attempt-1 failed');
    expectResult(await worker(controller, 6, 'complete_attempt', {
      attempt_id: 'attempt-1',
      assignment_fence: firstAssign.assignment_fence,
      status: 'completed',
    }), 'complete attempt-1 failed');

    const secondAssign = expectResult(await admin(controller, 7, 'assign_attempt', {
      task_id: 'task-2',
      attempt_id: 'attempt-2',
      worker_instance_id: 'worker-pwn',
    }), 'assign attempt-2 failed');
    const recycled = expectResult(await admin(controller, 8, 'recycle_worker_session', {
      worker_instance_id: 'worker-pwn',
    }), 'recycle worker failed');

    const attempt = controller.db.getAttempt('attempt-2');
    const workerState = controller.db.getWorker('worker-pwn');
    const packet = JSON.parse(readFileSync(join(authorityRoot, 'rehydration', 'worker-pwn.json'), 'utf8'));

    assert(firstAssign.assignment_fence === 1, 'expected first fence 1');
    assert(secondAssign.assignment_fence === 2, 'expected second fence 2');
    assert(recycled.generation === 2, 'expected recycled worker generation 2');
    assert(attempt?.assignment_fence === 3, 'expected recycled active attempt fence to advance past prior max');
    assert(packet.active_attempt?.assignment_fence === 3, 'expected packet to carry recycled attempt fence');
    assert(workerState?.generation === 2, 'expected worker generation to advance on recycle');

    return {
      scenario: 'monotonic-assignment-fence',
      worker_state: workerState,
      attempt,
      packet,
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function runMemoryRefGateScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'gate-fix-memory-ref-'));
  const controller = buildController(authorityRoot);
  const escapeName = `memory-escape-${randomUUID().slice(0, 8)}.md`;

  try {
    expectResult(await admin(controller, 1, 'create_session', {
      session_id: 'gate-fix-memory-ref',
      authority_root: authorityRoot,
    }), 'create_session failed');

    expectError(
      await admin(controller, 2, 'launch_worker', {
        session_id: 'gate-fix-memory-ref',
        worker_instance_id: 'worker-pwn',
        role_label: 'pwnworker',
        capability_profile: workerProfile(),
        memory_ref: `../${escapeName}`,
      }),
      400,
      'invalid memory_ref',
    );

    assert(!controller.db.getWorker('worker-pwn'), 'expected invalid memory_ref launch to avoid inserting worker state');
    assert(
      !existsSync(join(authorityRoot, '..', escapeName)),
      'expected invalid memory_ref launch not to create files outside the authority root',
    );
    assert(
      controller.db.listSessionControllerCommands('gate-fix-memory-ref').length === 0,
      'expected invalid memory_ref launch not to enqueue controller commands',
    );

    return {
      scenario: 'memory-ref-gate',
      authority_root: authorityRoot,
      escaped_path_created: existsSync(join(authorityRoot, '..', escapeName)),
      workers: controller.db.listSessionWorkers('gate-fix-memory-ref'),
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function main() {
  const results = [
    await runSequentialAssignmentScenario(),
    await runLivenessHeartbeatScenario(),
    await runValidationAndArtifactScenario(),
    await runFenceMonotonicityScenario(),
    await runMemoryRefGateScenario(),
  ];
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
