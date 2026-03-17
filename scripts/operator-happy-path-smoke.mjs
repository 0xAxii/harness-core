import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCli(repoRoot, stateRoot, ...args) {
  const output = execFileSync(
    process.execPath,
    [join(repoRoot, 'dist', 'cli', 'index.js'), ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateRoot,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    return JSON.parse(output);
  } catch {
    return output.trim();
  }
}

function runCliExpectError(repoRoot, stateRoot, ...args) {
  try {
    runCli(repoRoot, stateRoot, ...args);
    throw new Error('expected command to fail');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function killTmuxTarget(target) {
  try {
    execFileSync('tmux', ['kill-session', '-t', target.split(':')[0]], { stdio: 'ignore' });
  } catch {
    // ignore missing sessions during cleanup
  }
}

function main() {
  const repoRoot = process.cwd();
  const stateRoot = mkdtempSync(join(tmpdir(), 'harness-operator-happy-path-'));
  const sessionId = 'operator-happy-path-smoke';
  const configPath = join(stateRoot, 'phase2-config.json');
  const tmuxTargets = [];

  writeFileSync(configPath, JSON.stringify({
    runtime_target: 'codex',
    authority_root_policy: 'explicit',
    capability_defaults: {
      fs_scope: [],
      network_profile: 'deny',
      browser_access: false,
      publish_right: false,
      shared_resource_modes: [],
      secret_classes: [],
    },
    leader_ux_mode: 'leader-first',
  }, null, 2));

  try {
    const up = runCli(repoRoot, stateRoot, 'up', sessionId, '--config', configPath);
    assert(up.session_id === sessionId, 'expected up to return session id');
    assert(up.leader_worker_instance_id === 'worker-leader', 'expected default leader worker id');

    const help = runCli(repoRoot, stateRoot, 'help');
    assert(typeof help === 'string' && help.includes('quick start:'), 'expected help to show quick start');
    assert(help.includes('up <session-id> [--config <path>]'), 'expected help to show up command');

    const hud = runCli(repoRoot, stateRoot, 'hud', sessionId);
    assert(typeof hud === 'string' && hud.includes(`Leader   worker-leader (leader)`), 'expected hud to highlight leader');

    const attachLeader = runCli(repoRoot, stateRoot, 'attach-worker', sessionId, '--print-target');
    assert(typeof attachLeader === 'string' && attachLeader.includes('worker-leader'), 'expected attach-worker default to target leader');
    tmuxTargets.push(attachLeader);

    const listWorkers = runCli(repoRoot, stateRoot, 'list-workers', sessionId);
    assert(typeof listWorkers === 'string' && listWorkers.includes('leader'), 'expected list-workers to mark default leader');

    const ambiguousSessionId = 'operator-happy-path-ambiguous';
    runCli(repoRoot, stateRoot, 'start', ambiguousSessionId);
    runCli(repoRoot, stateRoot, 'admin', 'create-session', ambiguousSessionId);
    runCli(repoRoot, stateRoot, 'admin', 'launch-worker', ambiguousSessionId, 'worker-alpha', 'general');
    runCli(repoRoot, stateRoot, 'admin', 'launch-worker', ambiguousSessionId, 'worker-beta', 'general');
    const ambiguousAttach = runCliExpectError(repoRoot, stateRoot, 'attach-worker', ambiguousSessionId, '--print-target');
    assert(ambiguousAttach.includes('no worker available') || ambiguousAttach.includes('worker not found'), 'expected ambiguous leader attach to fail safely');

    process.stdout.write(JSON.stringify({
      ok: true,
      session_id: sessionId,
      state_root: stateRoot,
      leader_target: attachLeader,
      ambiguous_session_id: ambiguousSessionId,
      config_path: configPath,
    }, null, 2) + '\n');
  } finally {
    try {
      runCli(repoRoot, stateRoot, 'stop', sessionId);
    } catch {
      // ignore stop failures during cleanup
    }
    try {
      runCli(repoRoot, stateRoot, 'stop', 'operator-happy-path-ambiguous');
    } catch {
      // ignore stop failures during cleanup
    }
    for (const target of tmuxTargets) {
      if (typeof target === 'string' && target.length > 0) {
        killTmuxTarget(target);
      }
    }
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

main();
