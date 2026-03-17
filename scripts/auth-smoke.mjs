import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    runtimeHandle: 'tmux:auth-smoke',
    generation: 1,
  });
  return controller;
}

async function main() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'auth-smoke-'));
  const controller = buildController(authorityRoot);

  try {
    const noAdminAuth = await controller.handleAdminRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'status',
      params: { session_id: 'auth-smoke' },
    });
    assert('error' in noAdminAuth, 'expected missing admin auth to fail');
    assert(noAdminAuth.error.code === 401, `expected 401, got ${JSON.stringify(noAdminAuth)}`);

    const adminToken = readFileSync(join(authorityRoot, 'runtime', 'auth', 'admin.token'), 'utf8').trim();
    const created = await controller.handleAdminRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'create_session',
      params: {
        session_id: 'auth-smoke',
        authority_root: authorityRoot,
        auth_token: adminToken,
      },
    });
    assert('result' in created, `expected create_session success: ${JSON.stringify(created)}`);

    const launched = await controller.handleAdminRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'launch_worker',
      params: {
        session_id: 'auth-smoke',
        worker_instance_id: 'worker-pwn',
        role_label: 'pwnworker',
        capability_profile: {
          fs_scope: [],
          network_profile: 'deny',
          browser_access: false,
          publish_right: false,
          shared_resource_modes: [],
          secret_classes: [],
        },
        auth_token: adminToken,
      },
    });
    assert('result' in launched, `expected launch_worker success: ${JSON.stringify(launched)}`);

    const noWorkerAuth = await controller.handleWorkerRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'poll_messages',
      params: {
        session_id: 'auth-smoke',
        worker_instance_id: 'worker-pwn',
        generation: 1,
      },
    });
    assert('error' in noWorkerAuth, 'expected missing worker auth to fail');
    assert(noWorkerAuth.error.code === 401, `expected 401, got ${JSON.stringify(noWorkerAuth)}`);

    const workerToken = readFileSync(join(authorityRoot, 'runtime', 'auth', 'worker-pwn.token'), 'utf8').trim();
    const workerPoll = await controller.handleWorkerRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'poll_messages',
      params: {
        session_id: 'auth-smoke',
        worker_instance_id: 'worker-pwn',
        generation: 1,
        auth_token: workerToken,
      },
    });
    assert('result' in workerPoll, `expected poll_messages success: ${JSON.stringify(workerPoll)}`);

    process.stdout.write(JSON.stringify({
      ok: true,
      authority_root: authorityRoot,
      admin_auth: 'enforced',
      worker_auth: 'enforced',
    }, null, 2) + '\n');
  } finally {
    controller.db.close();
    rmSync(authorityRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
