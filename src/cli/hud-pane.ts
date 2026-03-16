import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('./index.js', import.meta.url));

export async function runHudPaneCommand(args: string[]): Promise<void> {
  const [sessionId = 'dev-session', ...rest] = args;
  const intervalArg = parseIntervalArg(rest);
  const command = buildHudCommand(sessionId, intervalArg);

  if (process.env.TMUX) {
    const paneId = execFileSync(
      'tmux',
      ['split-window', '-v', '-p', '30', '-d', '-P', '-F', '#{pane_id}', command],
      { encoding: 'utf8' },
    ).trim();
    process.stdout.write(`hud pane ${paneId}\n`);
    return;
  }

  const sessionName = `harness-hud-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32)}`;
  execFileSync('tmux', ['new-session', '-d', '-s', sessionName, command], { stdio: 'ignore' });
  execFileSync('tmux', ['set-option', '-t', sessionName, 'remain-on-exit', 'on'], { stdio: 'ignore' });
  process.stdout.write(`hud session ${sessionName}\n`);
}

function buildHudCommand(sessionId: string, intervalArg: string | null): string {
  const interval = intervalArg ? ` --interval ${intervalArg}` : '';
  const envParts = [
    process.env.HARNESS_AUTHORITY_ROOT
      ? `HARNESS_AUTHORITY_ROOT=${shellQuote(process.env.HARNESS_AUTHORITY_ROOT)}`
      : null,
    process.env.XDG_STATE_HOME ? `XDG_STATE_HOME=${shellQuote(process.env.XDG_STATE_HOME)}` : null,
  ].filter((value): value is string => Boolean(value));
  const envPrefix = envParts.length > 0 ? `${envParts.join(' ')} ` : '';
  return `${envPrefix}node ${shellQuote(CLI_PATH)} hud ${shellQuote(sessionId)} --watch${interval}`;
}

function parseIntervalArg(args: string[]): string | null {
  const index = args.findIndex((arg) => arg === '--interval');
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  return value ? String(value) : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
