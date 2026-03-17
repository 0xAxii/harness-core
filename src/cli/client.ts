import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { HarnessController } from '../controller/index.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../protocol/jsonrpc.js';

const LOCAL_RPC_ERRNO_CODES = new Set(['EACCES', 'ECONNREFUSED', 'ENOENT', 'EPERM']);

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
  const authToken = resolveSocketAuthToken(socketPath);
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params: authToken ? { ...params, auth_token: authToken } : params,
  };

  try {
    return await callSocketOverNet(socketPath, request);
  } catch (error) {
    if (!shouldFallbackToDirectDispatch(socketPath, error)) {
      throw error;
    }
    return await callControllerDirect(socketPath, request);
  }
}

function resolveSocketAuthToken(socketPath: string): string | null {
  const authorityRoot = dirname(socketPath);
  switch (basename(socketPath)) {
    case 'admin.sock':
      return readTokenFile(process.env.HARNESS_ADMIN_TOKEN_FILE ?? join(authorityRoot, 'runtime', 'auth', 'admin.token'))
        ?? (typeof process.env.HARNESS_ADMIN_TOKEN === 'string' ? process.env.HARNESS_ADMIN_TOKEN : null);
    case 'worker.sock':
      return readTokenFile(process.env.HARNESS_WORKER_TOKEN_FILE ?? '')
        ?? (typeof process.env.HARNESS_WORKER_TOKEN === 'string' ? process.env.HARNESS_WORKER_TOKEN : null);
    default:
      return null;
  }
}

function readTokenFile(tokenPath: string): string | null {
  if (!tokenPath || !existsSync(tokenPath)) {
    return null;
  }
  try {
    return readFileSync(tokenPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function callSocketOverNet(socketPath: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
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

function shouldFallbackToDirectDispatch(socketPath: string, error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (!LOCAL_RPC_ERRNO_CODES.has(code)) {
    return false;
  }
  return existsSync(join(dirname(socketPath), 'state.db'));
}

async function callControllerDirect(socketPath: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const authorityRoot = dirname(socketPath);
  const controller = new HarnessController({
    dbPath: join(authorityRoot, 'state.db'),
    workerSocketPath: join(authorityRoot, 'worker.sock'),
    adminSocketPath: join(authorityRoot, 'admin.sock'),
  });

  try {
    // Sandboxed workers cannot bind or dial local sockets, so dispatch the same RPC directly.
    switch (basename(socketPath)) {
      case 'worker.sock':
        return await controller.dispatchWorkerRequest(request);
      case 'admin.sock':
        return await controller.dispatchAdminRequest(request);
      default:
        throw new Error(`unsupported socket path: ${socketPath}`);
    }
  } finally {
    await controller.close();
  }
}
