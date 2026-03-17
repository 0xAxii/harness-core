import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessDatabase } from '../db/index.js';
import { failure, success, type JsonRpcResponse } from '../protocol/jsonrpc.js';
import type { AttemptRecord, AttemptTerminalStatus } from '../types/model.js';
import { callSocket, resolveAuthorityRoot } from './client.js';

const ACTIVE_ATTEMPT_STATUSES = new Set<AttemptRecord['status']>(['assigned', 'running', 'blocked']);
const TERMINAL_ATTEMPT_STATUSES = new Set<AttemptTerminalStatus>(['completed', 'failed', 'cancelled']);
const LOCAL_FALLBACK_ERROR_CODES = new Set(['EPERM', 'EACCES', 'ENOENT', 'ECONNREFUSED']);

export async function callWorkerTransport(
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const socketPath = join(authorityRoot, 'worker.sock');
  try {
    return await callSocket(socketPath, method, params);
  } catch (error) {
    if (!shouldUseLocalWorkerFallback(error)) {
      throw error;
    }
    return callWorkerLocally(sessionId, method, params);
  }
}

function shouldUseLocalWorkerFallback(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && LOCAL_FALLBACK_ERROR_CODES.has(code);
}

function callWorkerLocally(sessionId: string, method: string, params: Record<string, unknown>): JsonRpcResponse {
  const authorityRoot = resolveAuthorityRoot(sessionId);
  const db = new HarnessDatabase(join(authorityRoot, 'state.db'));
  try {
    switch (method) {
      case 'heartbeat':
        return heartbeat(db, params);
      case 'complete_attempt':
        return completeAttempt(db, params);
      case 'send_message':
        return sendWorkerMessage(db, params);
      case 'report_blocked':
        return reportBlocked(db, params);
      case 'register_artifact':
        return registerArtifact(db, authorityRoot, params);
      case 'poll_messages':
        return pollMessages(db, params);
      case 'ack_messages':
        return ackMessages(db, params);
      default:
        return failure(null, 400, `unsupported worker method: ${method}`);
    }
  } finally {
    db.close();
  }
}

function heartbeat(db: HarnessDatabase, params: Record<string, unknown>): JsonRpcResponse {
  const now = new Date().toISOString();
  const attemptId = String(params.attempt_id);
  const ok = db.updateAttemptHeartbeat(
    attemptId,
    Number(params.assignment_fence),
    String(params.activity ?? 'working'),
    Number(params.progress_counter ?? 0),
    now,
    Boolean(params.liveness_only),
  );
  if (ok && !Boolean(params.liveness_only)) {
    const attempt = db.getAttempt(attemptId);
    if (attempt) {
      db.updateWorkerBlockedReason(attempt.worker_instance_id, null, now);
    }
  }
  return ok ? success(null, { ok: true }) : failure(null, 409, 'fence rejected');
}

function reportBlocked(db: HarnessDatabase, params: Record<string, unknown>): JsonRpcResponse {
  const now = new Date().toISOString();
  const attemptId = String(params.attempt_id);
  const fence = Number(params.assignment_fence);
  const reason = String(params.reason ?? 'blocked');
  const attempt = getActiveAttempt(db, attemptId, fence);
  if (!attempt) {
    return failure(null, 409, 'fence rejected');
  }
  const worker = db.getWorker(attempt.worker_instance_id);
  if (!worker) {
    return failure(null, 404, 'worker instance not found');
  }
  const ok = db.markAttemptBlocked(attemptId, fence, reason, now);
  if (!ok) {
    return failure(null, 409, 'fence rejected');
  }
  db.updateWorkerBlockedReason(worker.worker_instance_id, reason, now);
  db.insertEvent({
    event_id: randomUUID(),
    session_id: worker.session_id,
    event_type: 'attempt_blocked',
    actor: worker.worker_instance_id,
    subject_type: 'attempt',
    subject_id: attemptId,
    mutation_id: randomUUID(),
    payload: { reason },
    created_at: now,
  });
  return success(null, { ok: true, reason });
}

function pollMessages(db: HarnessDatabase, params: Record<string, unknown>): JsonRpcResponse {
  const workerInstanceId = String(params.worker_instance_id);
  const generation = Number(params.generation ?? 0);
  const worker = db.getWorker(workerInstanceId);
  if (!worker || worker.generation !== generation) {
    return failure(null, 409, 'generation rejected');
  }
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
  const messages = db.leaseMessages(workerInstanceId, now, leaseExpiresAt);
  return success(null, { messages });
}

function ackMessages(db: HarnessDatabase, params: Record<string, unknown>): JsonRpcResponse {
  const workerInstanceId = String(params.worker_instance_id);
  const generation = Number(params.generation ?? 0);
  const worker = db.getWorker(workerInstanceId);
  if (!worker || worker.generation !== generation) {
    return failure(null, 409, 'generation rejected');
  }
  const acks = Array.isArray(params.acks)
    ? params.acks
      .filter((ack): ack is { message_id: string; lease_token: string } => {
        return !!ack
          && typeof ack === 'object'
          && typeof (ack as { message_id?: unknown }).message_id === 'string'
          && typeof (ack as { lease_token?: unknown }).lease_token === 'string';
      })
      .map((ack) => ({ message_id: ack.message_id, lease_token: ack.lease_token }))
    : [];
  const delivered = db.ackMessages(acks, new Date().toISOString());
  return success(null, { ok: true, delivered });
}

function sendWorkerMessage(db: HarnessDatabase, params: Record<string, unknown>): JsonRpcResponse {
  const now = new Date().toISOString();
  const attemptId = String(params.attempt_id);
  const attempt = getActiveAttempt(db, attemptId, Number(params.assignment_fence));
  if (!attempt) {
    return failure(null, 409, 'fence rejected');
  }
  const worker = db.getWorker(attempt.worker_instance_id);
  if (!worker) {
    return failure(null, 404, 'worker instance not found');
  }
  db.insertMessage({
    message_id: randomUUID(),
    session_id: worker.session_id,
    from_worker_instance_id: worker.worker_instance_id,
    to_worker_instance_id: String(params.to_worker_instance_id),
    attempt_id: attemptId,
    kind: String(params.kind ?? 'note'),
    payload: params.payload ?? null,
    status: 'pending',
    created_at: now,
  });
  return success(null, { ok: true });
}

function registerArtifact(
  db: HarnessDatabase,
  authorityRoot: string,
  params: Record<string, unknown>,
): JsonRpcResponse {
  const now = new Date().toISOString();
  const attemptId = String(params.attempt_id);
  const attempt = getActiveAttempt(db, attemptId, Number(params.assignment_fence));
  if (!attempt) {
    return failure(null, 409, 'fence rejected');
  }
  const worker = db.getWorker(attempt.worker_instance_id);
  if (!worker) {
    return failure(null, 404, 'worker instance not found');
  }
  const artifactRoot = join(authorityRoot, 'artifacts');
  const storageUri = String(params.storage_uri);
  let resolvedPath: string;
  try {
    resolvedPath = fileURLToPath(storageUri);
  } catch (error) {
    return failure(null, 400, 'artifact storage_uri must be a valid file:// URI', String(error));
  }
  if (!isPathWithin(artifactRoot, resolvedPath)) {
    return failure(null, 400, 'artifact storage path must stay within the authority artifact root');
  }
  let digest: string;
  let sizeBytes: number;
  try {
    const content = readFileSync(resolvedPath);
    digest = createHash('sha256').update(content).digest('hex');
    sizeBytes = statSync(resolvedPath).size;
  } catch (error) {
    return failure(null, 400, 'artifact file is unreadable', String(error));
  }
  if (params.digest && String(params.digest) !== digest) {
    return failure(null, 400, 'artifact digest mismatch');
  }
  db.insertArtifact({
    artifact_id: String(params.artifact_id),
    session_id: worker.session_id,
    attempt_id: attemptId,
    worker_instance_id: worker.worker_instance_id,
    kind: String(params.kind),
    storage_uri: storageUri,
    digest,
    size_bytes: sizeBytes,
    metadata: params.metadata ?? null,
    status: 'sealed',
    created_at: now,
  });
  db.insertEvent({
    event_id: randomUUID(),
    session_id: worker.session_id,
    event_type: 'artifact_registered',
    actor: worker.worker_instance_id,
    subject_type: 'artifact',
    subject_id: String(params.artifact_id),
    mutation_id: randomUUID(),
    payload: { attempt_id: attemptId, kind: String(params.kind) },
    created_at: now,
  });
  return success(null, { ok: true });
}

function completeAttempt(db: HarnessDatabase, params: Record<string, unknown>): JsonRpcResponse {
  const now = new Date().toISOString();
  const attemptId = String(params.attempt_id);
  const fence = Number(params.assignment_fence);
  const status = String(params.status);
  if (!isAttemptTerminalStatus(status)) {
    return failure(null, 400, 'invalid attempt completion status');
  }
  const ok = db.completeAttempt(
    attemptId,
    fence,
    status,
    typeof params.error_summary === 'string' ? params.error_summary : null,
    now,
  );
  if (!ok) {
    return failure(null, 409, 'fence rejected');
  }
  const attempt = db.getAttempt(attemptId);
  if (attempt) {
    db.updateWorkerActiveAttempt(attempt.worker_instance_id, null, now);
    db.updateWorkerBlockedReason(attempt.worker_instance_id, null, now);
    db.updateTaskStatus(attempt.task_id, status === 'completed' ? 'provisional' : 'active', now);
    const worker = db.getWorker(attempt.worker_instance_id);
    const task = db.getTask(attempt.task_id);
    if (task) {
      db.insertEvent({
        event_id: randomUUID(),
        session_id: task.session_id,
        event_type: 'attempt_completed',
        actor: worker?.worker_instance_id ?? 'worker',
        subject_type: 'attempt',
        subject_id: attemptId,
        mutation_id: randomUUID(),
        payload: { status },
        created_at: now,
      });
    }
  }
  return success(null, { ok: true });
}

function getActiveAttempt(db: HarnessDatabase, attemptId: string, fence: number): AttemptRecord | undefined {
  const attempt = db.getAttempt(attemptId);
  if (!attempt || attempt.assignment_fence !== fence || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
    return undefined;
  }
  return attempt;
}

function isAttemptTerminalStatus(value: string): value is AttemptTerminalStatus {
  return TERMINAL_ATTEMPT_STATUSES.has(value as AttemptTerminalStatus);
}

function isPathWithin(root: string, target: string): boolean {
  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    canonicalRoot = realpathSync.native(resolve(root));
    canonicalTarget = realpathSync.native(resolve(target));
  } catch {
    return false;
  }
  const escaped = relative(canonicalRoot, canonicalTarget);
  return escaped === '' || (!escaped.startsWith('..') && !isAbsolute(escaped));
}
