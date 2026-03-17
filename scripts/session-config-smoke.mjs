import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  return controller;
}

function readAdminToken(dbPath) {
  return readFileSync(join(dirname(dbPath), 'runtime', 'auth', 'admin.token'), 'utf8').trim();
}

async function admin(controller, id, method, params) {
  return controller.handleAdminRequest({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      auth_token: readAdminToken(controller.paths.dbPath),
    },
  });
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

function writeConfig(authorityRoot, name, config) {
  const path = join(authorityRoot, `${name}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

async function runExplicitAuthorityScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'session-config-explicit-'));
  const controller = buildController(authorityRoot);

  try {
    const configPath = writeConfig(authorityRoot, 'explicit-config', {
      runtime_target: 'codex',
      authority_root_policy: 'explicit',
      capability_defaults: {
        fs_scope: ['workspace'],
        network_profile: 'local',
        browser_access: true,
        publish_right: false,
        shared_resource_modes: ['shared-cache'],
        secret_classes: ['repo'],
      },
      leader_ux_mode: 'leader-first',
    });

    const missingAuthorityRoot = await admin(controller, 1, 'create_session', {
      session_id: 'session-config-explicit',
      config_path: configPath,
    });
    expectError(missingAuthorityRoot, 400, 'authority_root required');

    return {
      scenario: 'explicit-authority-root-required',
      config_path: configPath,
      rejected: true,
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function runConfigDefaultsScenario() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'session-config-defaults-'));
  const controller = buildController(authorityRoot);

  try {
    const configPath = writeConfig(authorityRoot, 'defaults-config', {
      runtime_target: 'codex',
      authority_root_policy: 'explicit',
      capability_defaults: {
        fs_scope: ['workspace'],
        network_profile: 'local',
        browser_access: true,
        publish_right: false,
        shared_resource_modes: ['shared-cache'],
        secret_classes: ['repo'],
      },
      leader_ux_mode: 'leader-first',
    });

    expectResult(await admin(controller, 2, 'create_session', {
      session_id: 'session-config-defaults',
      authority_root: authorityRoot,
      config_path: configPath,
    }), 'create_session failed');

    expectResult(await admin(controller, 3, 'launch_worker', {
      session_id: 'session-config-defaults',
      worker_instance_id: 'worker-config',
      role_label: 'general',
    }), 'launch_worker failed');

    expectResult(await admin(controller, 4, 'create_task', {
      session_id: 'session-config-defaults',
      task_id: 'task-config',
      task_class: 'code',
      subject: 'config default capability task',
      description: 'requires config-backed defaults',
      required_capabilities: ['browser_access', 'network:local'],
    }), 'create_task failed');

    const assignment = expectResult(await admin(controller, 5, 'assign_attempt', {
      task_id: 'task-config',
      attempt_id: 'attempt-config',
      worker_instance_id: 'worker-config',
    }), 'assign_attempt failed');

    const session = controller.db.getSession('session-config-defaults');
    const worker = controller.db.getWorker('worker-config');
    const events = controller.db.db
      .prepare(
        `SELECT event_type, payload
         FROM events
         WHERE session_id = ?
         ORDER BY global_seq ASC`,
      )
      .all('session-config-defaults')
      .map((row) => ({
        event_type: String(row.event_type),
        payload: JSON.parse(String(row.payload)),
      }));

    assert(session, 'expected session to exist');
    assert(worker, 'expected worker to exist');
    assert(session.config_path === resolve(configPath), `expected resolved config path, got ${session.config_path}`);
    assert(worker.capability_profile.network_profile === 'local', 'expected network profile from config defaults');
    assert(worker.capability_profile.browser_access === true, 'expected browser_access from config defaults');
    assert(worker.capability_profile.fs_scope.includes('workspace'), 'expected fs_scope from config defaults');

    const createdEvent = events.find((event) => event.event_type === 'session_created');
    assert(createdEvent, 'expected session_created event');

    return {
      scenario: 'config-defaults-applied',
      config_path: configPath,
      session,
      worker,
      assignment,
      session_created_event: createdEvent,
    };
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

async function main() {
  const results = [];
  results.push(await runExplicitAuthorityScenario());
  results.push(await runConfigDefaultsScenario());

  process.stdout.write(JSON.stringify({
    ok: true,
    results,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
