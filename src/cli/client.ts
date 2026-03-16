import { createConnection } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { JsonRpcRequest, JsonRpcResponse } from '../protocol/jsonrpc.js';

export function resolveAuthorityRoot(sessionId: string): string {
  const harnessAuthorityRoot = process.env.HARNESS_AUTHORITY_ROOT;
  if (harnessAuthorityRoot) {
    const resolvedHarnessAuthorityRoot = resolve(harnessAuthorityRoot);
    if (basename(resolvedHarnessAuthorityRoot) === sessionId) {
      return resolvedHarnessAuthorityRoot;
    }
  }
  const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return resolve(xdgState, 'harness', 'runs', sessionId);
}

export async function callSocket(socketPath: string, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  };

  return await new Promise<JsonRpcResponse>((resolvePromise, reject) => {
    const socket = createConnection(socketPath, () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index !== -1) {
        const line = buffer.slice(0, index).trim();
        socket.end();
        try {
          resolvePromise(JSON.parse(line) as JsonRpcResponse);
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.on('error', reject);
  });
}
