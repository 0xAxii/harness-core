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

function runWorkerCli(repoRoot, stateRoot, sessionId, workerInstanceId, ...args) {
  const output = execFileSync(
    process.execPath,
    [join(repoRoot, 'dist', 'cli', 'index.js'), ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateRoot,
        HARNESS_WORKER_TOKEN_FILE: join(stateRoot, 'harness', 'runs', sessionId, 'runtime', 'auth', `${workerInstanceId}.token`),
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
  const stateRoot = mkdtempSync(join(tmpdir(), 'harness-multi-worker-'));
  const sessionId = 'multi-worker-smoke';
  const artifactPath = join(stateRoot, 'critic-note.txt');
  const tmuxTargets = [];

  try {
    runCli(repoRoot, stateRoot, 'start', sessionId);
    runCli(repoRoot, stateRoot, 'admin', 'create-session', sessionId, '{"family":"code-oriented"}');

    const launchPwn = runCli(repoRoot, stateRoot, 'admin', 'launch-worker', sessionId, 'worker-pwn', 'pwnworker');
    const launchCritic = runCli(repoRoot, stateRoot, 'admin', 'launch-worker', sessionId, 'worker-critic', 'critic');
    tmuxTargets.push(
      runCli(repoRoot, stateRoot, 'attach-worker', sessionId, 'worker-pwn', '--print-target'),
      runCli(repoRoot, stateRoot, 'attach-worker', sessionId, 'worker-critic', '--print-target'),
    );

    assert(launchPwn.result?.generation === 1, 'expected worker-pwn generation 1');
    assert(launchCritic.result?.generation === 1, 'expected worker-critic generation 1');

    runCli(repoRoot, stateRoot, 'admin', 'create-task', sessionId, 'task-pwn', 'code', 'pwn task', 'find control offset');
    runCli(repoRoot, stateRoot, 'admin', 'create-task', sessionId, 'task-critic', 'code', 'critic task', 'review exploit notes');
    runCli(repoRoot, stateRoot, 'admin', 'assign-attempt', sessionId, 'task-pwn', 'attempt-pwn', 'worker-pwn');
    runCli(repoRoot, stateRoot, 'admin', 'assign-attempt', sessionId, 'task-critic', 'attempt-critic', 'worker-critic');

    runCli(repoRoot, stateRoot, 'admin', 'send-message', sessionId, 'worker-critic', 'instruction', 'review latest exploit notes');
    runWorkerCli(repoRoot, stateRoot, sessionId, 'worker-pwn', 'worker', 'report-blocked', sessionId, 'attempt-pwn', '1', 'waiting on crash triage');
    runWorkerCli(repoRoot, stateRoot, sessionId, 'worker-pwn', 'worker', 'heartbeat', sessionId, 'attempt-pwn', '1', 'triage-resumed', '2');

    writeFileSync(artifactPath, 'critic note: exploit path looks stable\n', 'utf8');
    runWorkerCli(repoRoot, stateRoot, sessionId, 'worker-critic', 'worker', 'ingest-artifact', sessionId, 'attempt-critic', '1', 'artifact-critic-note', 'note', artifactPath, 'critic note');
    runWorkerCli(repoRoot, stateRoot, sessionId, 'worker-critic', 'worker', 'complete', sessionId, 'attempt-critic', '1', 'completed');
    runCli(repoRoot, stateRoot, 'admin', 'validate-attempt', sessionId, 'attempt-critic', 'operator', 'accepted', 'smoke', 'critic accepted');

    const status = runCli(repoRoot, stateRoot, 'admin', 'status', sessionId).result;
    assert(status.workers.length === 2, 'expected two workers');
    assert(status.tasks.some((task) => task.task_id === 'task-pwn' && task.status === 'active'), 'expected pwn task to stay active');
    assert(status.tasks.some((task) => task.task_id === 'task-critic' && task.status === 'validated'), 'expected critic task to validate');
    assert(status.attempts.some((attempt) => attempt.attempt_id === 'attempt-pwn' && attempt.status === 'running'), 'expected pwn attempt running');
    assert(status.attempts.some((attempt) => attempt.attempt_id === 'attempt-critic' && attempt.status === 'completed'), 'expected critic attempt completed');
    assert(status.artifacts.some((artifact) => artifact.artifact_id === 'artifact-critic-note'), 'expected critic artifact');
    assert(status.validations.some((validation) => validation.attempt_id === 'attempt-critic' && validation.decision === 'accepted'), 'expected validation');

    process.stdout.write(`${JSON.stringify({ ok: true, session_id: sessionId, state_root: stateRoot, tmux_targets: tmuxTargets, status }, null, 2)}\n`);
  } finally {
    try {
      runCli(repoRoot, stateRoot, 'stop', sessionId);
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
