import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { resolveAuthorityRoot } from './client.js';
import { callWorkerTransport } from './worker-transport.js';

export async function runWorkerCommand(args: string[]): Promise<void> {
  const [method, sessionId, attemptId, fenceString, ...rest] = args;
  if (!method || !sessionId) {
    throw new Error('usage: harness worker <method> <session-id> [...]');
  }

  let response;
  switch (method) {
    case 'heartbeat':
      response = await callWorkerTransport(sessionId, 'heartbeat', {
        attempt_id: String(attemptId),
        assignment_fence: Number(fenceString),
        activity: rest[0] ?? 'working',
        progress_counter: Number(rest[1] ?? 0),
      });
      break;
    case 'complete':
      response = await callWorkerTransport(sessionId, 'complete_attempt', {
        attempt_id: String(attemptId),
        assignment_fence: Number(fenceString),
        status: rest[0] ?? 'completed',
        error_summary: rest[1],
      });
      break;
    case 'send-message':
      response = await callWorkerTransport(sessionId, 'send_message', {
        attempt_id: String(attemptId),
        assignment_fence: Number(fenceString),
        to_worker_instance_id: rest[0],
        kind: rest[1] ?? 'note',
        payload: rest.slice(2).join(' ') || null,
      });
      break;
    case 'report-blocked':
      response = await callWorkerTransport(sessionId, 'report_blocked', {
        attempt_id: String(attemptId),
        assignment_fence: Number(fenceString),
        reason: rest.join(' ') || 'blocked',
      });
      break;
    case 'register-artifact':
      response = await callWorkerTransport(sessionId, 'register_artifact', {
        attempt_id: String(attemptId),
        assignment_fence: Number(fenceString),
        artifact_id: rest[0],
        kind: rest[1] ?? 'file',
        storage_uri: rest[2],
        digest: rest[3] ?? 'unknown',
        size_bytes: rest[4] ? Number(rest[4]) : undefined,
        metadata: rest[5] ? { note: rest.slice(5).join(' ') } : null,
      });
      break;
    case 'ingest-artifact': {
      const sourcePath = rest[2];
      if (!sourcePath) {
        throw new Error('usage: harness worker ingest-artifact <session-id> <attempt-id> <fence> <artifact-id> <kind> <source-path> [note...]');
      }
      const authorityRoot = resolveAuthorityRoot(sessionId);
      const info = ingestArtifactFile(authorityRoot, sourcePath);
      response = await callWorkerTransport(sessionId, 'register_artifact', {
        attempt_id: String(attemptId),
        assignment_fence: Number(fenceString),
        artifact_id: rest[0] ?? `artifact-${randomUUID()}`,
        kind: rest[1] ?? 'file',
        storage_uri: info.storageUri,
        digest: info.digest,
        size_bytes: info.sizeBytes,
        metadata: {
          note: rest.slice(3).join(' ') || null,
          source_basename: basename(sourcePath),
        },
      });
      break;
    }
    case 'poll':
      response = await callWorkerTransport(sessionId, 'poll_messages', {
        worker_instance_id: String(attemptId),
        generation: Number(fenceString ?? 1),
      });
      break;
    default:
      throw new Error(`unknown worker method: ${method}`);
  }

  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

function ingestArtifactFile(authorityRoot: string, sourcePath: string): { storageUri: string; digest: string; sizeBytes: number } {
  const resolvedSource = resolve(sourcePath);
  const digest = createHash('sha256').update(readFileSync(resolvedSource)).digest('hex');
  const blobDir = join(authorityRoot, 'artifacts', digest.slice(0, 2));
  mkdirSync(blobDir, { recursive: true });
  const targetPath = join(blobDir, digest);
  copyFileSync(resolvedSource, targetPath);
  const sizeBytes = statSync(targetPath).size;
  return {
    storageUri: `file://${targetPath}`,
    digest,
    sizeBytes,
  };
}
