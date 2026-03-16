import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { callSocket, resolveAuthorityRoot } from './client.js';

export async function runAdminCommand(args: string[]): Promise<void> {
  const [method, sessionId = 'dev-session', ...rest] = args;
  if (!method) {
    throw new Error('usage: harness admin <method> <session-id> [...]');
  }

  const authorityRoot = resolveAuthorityRoot(sessionId);
  const socketPath = join(authorityRoot, 'admin.sock');
  let response;
  switch (method) {
    case 'create-session':
      response = await callSocket(socketPath, 'create_session', {
        session_id: sessionId,
        family: 'code-oriented',
        authority_root: authorityRoot,
      });
      break;
    case 'launch-worker':
      response = await callSocket(socketPath, 'launch_worker', {
        session_id: sessionId,
        worker_instance_id: rest[0] ?? `worker-${randomUUID()}`,
        role_label: rest[1] ?? 'general',
        memory_ref: rest[2] || undefined,
        capability_profile: {
          fs_scope: [],
          network_profile: 'deny',
          browser_access: false,
          publish_right: false,
          shared_resource_modes: [],
          secret_classes: [],
        },
      });
      break;
    case 'create-task':
      response = await callSocket(socketPath, 'create_task', {
        session_id: sessionId,
        task_id: rest[0] ?? `task-${randomUUID()}`,
        task_class: rest[1] ?? 'implement',
        subject: rest[2] ?? 'unnamed task',
        description: rest[3] ?? 'no description',
      });
      break;
    case 'assign-attempt':
      response = await callSocket(socketPath, 'assign_attempt', {
        task_id: rest[0],
        attempt_id: rest[1] ?? `attempt-${randomUUID()}`,
        worker_instance_id: rest[2],
      });
      break;
    case 'cancel-attempt':
      response = await callSocket(socketPath, 'cancel_attempt', {
        attempt_id: rest[0],
      });
      break;
    case 'recycle-worker':
      response = await callSocket(socketPath, 'recycle_worker_session', {
        worker_instance_id: rest[0],
      });
      break;
    case 'send-message':
      response = await callSocket(socketPath, 'send_message', {
        session_id: sessionId,
        to_worker_instance_id: rest[0],
        kind: rest[1] ?? 'instruction',
        payload: rest.slice(2).join(' ') || null,
      });
      break;
    case 'validate-attempt':
      response = await callSocket(socketPath, 'validate_attempt', {
        attempt_id: rest[0],
        kind: rest[1] ?? 'operator',
        decision: rest[2] ?? 'accepted',
        validator_ref: rest[3] ?? 'admin',
        notes: rest.slice(4).join(' ') || undefined,
      });
      break;
    case 'promote-artifact':
      response = await callSocket(socketPath, 'promote_artifact', {
        artifact_id: rest[0],
        status: 'promoted',
        notes: rest.slice(1).join(' ') || undefined,
      });
      break;
    case 'reject-artifact':
      response = await callSocket(socketPath, 'reject_artifact', {
        artifact_id: rest[0],
        status: 'rejected',
        notes: rest.slice(1).join(' ') || undefined,
      });
      break;
    case 'read-memory':
      response = await callSocket(socketPath, 'read_worker_memory', {
        worker_instance_id: rest[0],
      });
      break;
    case 'append-memory':
      response = await callSocket(socketPath, 'append_worker_memory', {
        worker_instance_id: rest[0],
        content: rest.slice(1).join(' '),
      });
      break;
    case 'replace-memory':
      response = await callSocket(socketPath, 'replace_worker_memory', {
        worker_instance_id: rest[0],
        content: rest.slice(1).join(' '),
      });
      break;
    case 'show-packet':
      response = await callSocket(socketPath, 'show_rehydration_packet', {
        worker_instance_id: rest[0],
      });
      break;
    case 'status':
      response = await callSocket(socketPath, 'status', { session_id: sessionId });
      break;
    default:
      throw new Error(`unknown admin method: ${method}`);
  }

  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}
