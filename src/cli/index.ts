import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessController } from '../controller/index.js';
import { runAdminCommand } from './admin.js';
import { runStartCommand, runStopCommand } from './daemon.js';
import { runHudCommand } from './hud.js';
import { runHudPaneCommand } from './hud-pane.js';
import {
  runAttachWorkerCommand,
  runListWorkersCommand,
  runShowHeartbeatCommand,
  runShowMailboxCommand,
  runTailWorkerCommand,
} from './operators.js';
import { runSidecarCommand } from './sidecar.js';
import { resolveAuthorityRoot } from './client.js';
import { runWorkerCommand } from './worker.js';

async function bootstrap(sessionId: string): Promise<void> {
  const authorityRoot = resolveAuthorityRoot(sessionId);
  mkdirSync(authorityRoot, { recursive: true });
  const controller = new HarnessController({
    dbPath: join(authorityRoot, 'state.db'),
    workerSocketPath: join(authorityRoot, 'worker.sock'),
    adminSocketPath: join(authorityRoot, 'admin.sock'),
  });
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await controller.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  await controller.listen();
  process.stdout.write(`controller listening for session ${sessionId}\n`);
}

function printHelp(): void {
  process.stdout.write(
    [
      'usage: harness <command> ...',
      '',
      'commands:',
      '  bootstrap <session-id>',
      '  start <session-id>',
      '  stop <session-id>',
      '  admin <method> <session-id> ...',
      '  list-workers <session-id>',
      '  attach-worker <session-id> <worker-instance-id> [--window <n>] [--pane <n>] [--print-target]',
      '  show-mailbox <session-id> <worker-instance-id>',
      '  show-heartbeat <session-id> <worker-instance-id>',
      '  tail-worker <session-id> <worker-instance-id> [--window <n>] [--pane <n>] [--lines <n>]',
      '  hud <session-id> [--watch] [--interval <ms>]',
      '  hud-pane <session-id> [--interval <ms>]',
      '  sidecar worker-runtime <session-id> <worker-instance-id> <generation> [--interval <ms>]',
      '  worker <method> <session-id> ...',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  switch (command) {
    case 'bootstrap':
      await bootstrap(rest[0] ?? 'dev-session');
      return;
    case 'admin':
      await runAdminCommand(rest);
      return;
    case 'start':
      await runStartCommand(rest);
      return;
    case 'stop':
      await runStopCommand(rest);
      return;
    case 'list-workers':
      await runListWorkersCommand(rest);
      return;
    case 'attach-worker':
      await runAttachWorkerCommand(rest);
      return;
    case 'show-mailbox':
      await runShowMailboxCommand(rest);
      return;
    case 'show-heartbeat':
      await runShowHeartbeatCommand(rest);
      return;
    case 'tail-worker':
      await runTailWorkerCommand(rest);
      return;
    case 'hud':
      await runHudCommand(rest);
      return;
    case 'hud-pane':
      await runHudPaneCommand(rest);
      return;
    case 'sidecar':
      await runSidecarCommand(rest);
      return;
    case 'worker':
      await runWorkerCommand(rest);
      return;
    case 'help':
      printHelp();
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
