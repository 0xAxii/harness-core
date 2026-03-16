import { createServer, type Server, type Socket } from 'node:net';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HarnessDatabase } from '../db/index.js';
import { failure, success, type JsonRpcRequest, type JsonRpcResponse } from '../protocol/jsonrpc.js';
import type { CapabilityProfile, SessionRecord, TaskRecord, WorkerInstanceRecord } from '../types/model.js';
import { ensureWorkerMemoryFile, readWorkerMemory } from '../runtime/memory.js';
import { EmbeddedSupervisor } from '../runtime/supervisor.js';

export interface ControllerPaths {
  dbPath: string;
  workerSocketPath: string;
  adminSocketPath: string;
}

const DEFAULT_CLI_PATH = fileURLToPath(new URL('../cli/index.js', import.meta.url));

export class HarnessController {
  readonly db: HarnessDatabase;
  readonly supervisor: EmbeddedSupervisor;
  private readonly servers = new Map<string, Server>();

  constructor(readonly paths: ControllerPaths) {
    this.db = new HarnessDatabase(paths.dbPath);
    this.supervisor = new EmbeddedSupervisor();
  }

  async listen(): Promise<void> {
    await Promise.all([
      this.startSocketServer(this.paths.workerSocketPath, (request) => this.handleWorkerRequest(request)),
      this.startSocketServer(this.paths.adminSocketPath, (request) => this.handleAdminRequest(request)),
    ]);
    await this.reconcileWorkers();
    await this.reconcileControllerCommands();
  }

  async close(): Promise<void> {
    for (const [socketPath, server] of this.servers.entries()) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      try {
        rmSync(socketPath, { force: true });
      } catch {
        // ignore missing sockets
      }
    }
    this.servers.clear();
    this.db.close();
  }

  private async startSocketServer(socketPath: string, handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse>): Promise<void> {
    mkdirSync(dirname(socketPath), { recursive: true });
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // ignore missing sockets
    }

    const server = createServer((socket) => this.handleSocket(socket, handler));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    this.servers.set(socketPath, server);
  }

  private handleSocket(socket: Socket, handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse>): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          const response = await this.dispatchLine(line, handler);
          socket.write(`${JSON.stringify(response)}\n`);
        }
        index = buffer.indexOf('\n');
      }
    });
  }

  private async dispatchLine(line: string, handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse>): Promise<JsonRpcResponse> {
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      return await handler(request);
    } catch (error) {
      return failure(null, -32700, 'invalid request', String(error));
    }
  }

  private async handleAdminRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'create_session':
        return this.createSession(request);
      case 'launch_worker':
        return this.launchWorker(request);
      case 'create_task':
        return this.createTask(request);
      case 'assign_attempt':
        return this.assignAttempt(request);
      case 'cancel_attempt':
        return this.cancelAttempt(request);
      case 'recycle_worker_session':
        return this.recycleWorkerSession(request);
      case 'send_message':
        return this.sendMessage(request);
      case 'validate_attempt':
        return this.validateAttempt(request);
      case 'promote_artifact':
      case 'reject_artifact':
        return this.updateArtifactStatus(request);
      case 'read_worker_memory':
        return this.readWorkerMemory(request);
      case 'append_worker_memory':
        return this.appendWorkerMemory(request);
      case 'replace_worker_memory':
        return this.replaceWorkerMemory(request);
      case 'show_rehydration_packet':
        return this.showRehydrationPacket(request);
      case 'status':
        return this.status(request);
      default:
        return failure(request.id, -32601, `unknown admin method: ${request.method}`);
    }
  }

  private async handleWorkerRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'ready':
        return success(request.id, { ok: true });
      case 'heartbeat':
        return this.heartbeat(request);
      case 'complete_attempt':
        return this.completeAttempt(request);
      case 'poll_messages':
        return this.pollMessages(request);
      case 'send_message':
        return this.sendWorkerMessage(request);
      case 'register_artifact':
        return this.registerArtifact(request);
      case 'report_blocked':
        return this.reportBlocked(request);
      default:
        return failure(request.id, -32601, `unknown worker method: ${request.method}`);
    }
  }

  private createSession(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const record: SessionRecord = {
      session_id: String(params.session_id),
      family: 'code-oriented',
      config_path: typeof params.config_path === 'string' ? params.config_path : undefined,
      authority_root: String(params.authority_root),
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    this.db.createSession(record);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: record.session_id,
      event_type: 'session_created',
      actor: 'admin',
      subject_type: 'session',
      subject_id: record.session_id,
      mutation_id: randomUUID(),
      payload: { family: record.family },
      created_at: now,
    });
    return success(request.id, { session_id: record.session_id });
  }

  private async launchWorker(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params ?? {};
    const sessionId = String(params.session_id);
    const now = new Date().toISOString();
    const capabilityProfile = (params.capability_profile ?? {}) as CapabilityProfile;
    const memoryRef = typeof params.memory_ref === 'string' && params.memory_ref.length > 0
      ? params.memory_ref
      : undefined;
    const record: WorkerInstanceRecord = {
      worker_instance_id: String(params.worker_instance_id),
      session_id: sessionId,
      role_label: String(params.role_label),
      generation: 1,
      runtime_handle: undefined,
      capability_profile: capabilityProfile,
      supervisor_state: 'launch_requested',
      blocked_reason: undefined,
      current_attempt_id: undefined,
      memory_ref: memoryRef,
      started_at: now,
      stopped_at: undefined,
      updated_at: now,
    };
    this.db.insertWorker(record);
    ensureWorkerMemoryFile(
      this.resolveAuthorityRoot(sessionId),
      record.worker_instance_id,
      sessionId,
      record.role_label,
      record.memory_ref,
    );
    const commandId = randomUUID();
    this.db.insertControllerCommand({
      command_id: commandId,
      session_id: sessionId,
      kind: 'launch_worker',
      status: 'pending',
      step_state: 'launch_requested',
      payload: { worker_instance_id: record.worker_instance_id },
      created_at: now,
      updated_at: now,
    });
    const handle = await this.supervisor.launchWorker({
      sessionId,
      workerInstanceId: record.worker_instance_id,
      roleLabel: record.role_label,
      generation: record.generation,
      authorityRoot: this.resolveAuthorityRoot(sessionId),
      workingDir: process.env.HARNESS_WORKER_CWD ?? process.cwd(),
      cliPath: process.env.HARNESS_CLI_PATH ?? DEFAULT_CLI_PATH,
      memoryRef: record.memory_ref,
    });
    this.db.bindWorkerRuntime(record.worker_instance_id, handle.runtimeHandle, 'started', now);
    this.db.updateControllerCommand(commandId, 'applied', 'started', now);
    this.writeWorkerPacket(sessionId, record.worker_instance_id, record.generation, record.role_label, record.memory_ref ?? null);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: sessionId,
      event_type: 'worker_launched',
      actor: 'controller',
      subject_type: 'worker_instance',
      subject_id: record.worker_instance_id,
      mutation_id: randomUUID(),
      payload: handle,
      created_at: now,
    });
    return success(request.id, handle);
  }

  private createTask(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const record: TaskRecord = {
      task_id: String(params.task_id),
      session_id: String(params.session_id),
      task_class: String(params.task_class),
      subject: String(params.subject),
      description: String(params.description),
      priority: typeof params.priority === 'number' ? params.priority : 0,
      required_capabilities: Array.isArray(params.required_capabilities)
        ? params.required_capabilities.map(String)
        : [],
      desired_outputs: Array.isArray(params.desired_outputs) ? params.desired_outputs.map(String) : [],
      status: 'open',
      created_at: now,
      updated_at: now,
    };
    this.db.insertTask(record);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: record.session_id,
      event_type: 'task_created',
      actor: 'admin',
      subject_type: 'task',
      subject_id: record.task_id,
      mutation_id: randomUUID(),
      payload: { task_class: record.task_class },
      created_at: now,
    });
    return success(request.id, { task_id: record.task_id });
  }

  private sendMessage(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const sessionId = String(params.session_id);
    this.db.insertMessage({
      message_id: randomUUID(),
      session_id: sessionId,
      to_worker_instance_id: String(params.to_worker_instance_id),
      kind: String(params.kind ?? 'instruction'),
      payload: params.payload ?? null,
      status: 'pending',
      created_at: now,
    });
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: sessionId,
      event_type: 'message_enqueued',
      actor: 'admin',
      subject_type: 'worker_instance',
      subject_id: String(params.to_worker_instance_id),
      mutation_id: randomUUID(),
      payload: { kind: params.kind ?? 'instruction' },
      created_at: now,
    });
    return success(request.id, { ok: true });
  }

  private validateAttempt(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const attemptId = String(params.attempt_id);
    const attempt = this.db.getAttempt(attemptId);
    if (!attempt) {
      return failure(request.id, 404, 'attempt not found');
    }
    const task = this.db.getTask(attempt.task_id);
    if (!task) {
      return failure(request.id, 404, 'task not found');
    }
    const decision = String(params.decision) as 'accepted' | 'rejected';
    this.db.insertValidation({
      validation_id: randomUUID(),
      session_id: task.session_id,
      attempt_id: attemptId,
      kind: String(params.kind ?? 'operator') as 'inline' | 'operator',
      decision,
      validator_ref: typeof params.validator_ref === 'string' ? params.validator_ref : undefined,
      notes: typeof params.notes === 'string' ? params.notes : undefined,
      created_at: now,
    });
    this.db.updateTaskStatus(task.task_id, decision === 'accepted' ? 'validated' : 'active', now);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: task.session_id,
      event_type: 'attempt_validated',
      actor: typeof params.validator_ref === 'string' ? params.validator_ref : 'admin',
      subject_type: 'attempt',
      subject_id: attemptId,
      mutation_id: randomUUID(),
      payload: { decision, kind: params.kind ?? 'operator' },
      created_at: now,
    });
    return success(request.id, { ok: true, decision });
  }

  private updateArtifactStatus(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const artifactId = String(params.artifact_id);
    const status = String(params.status) as 'promoted' | 'rejected';
    const artifact = this.db.getArtifact(artifactId);
    if (!artifact) {
      return failure(request.id, 404, 'artifact not found');
    }
    const updated = this.db.updateArtifactStatus(artifactId, status);
    if (!updated) {
      return failure(request.id, 409, 'artifact update rejected');
    }
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: artifact.session_id,
      event_type: status === 'promoted' ? 'artifact_promoted' : 'artifact_rejected',
      actor: 'admin',
      subject_type: 'artifact',
      subject_id: artifactId,
      mutation_id: randomUUID(),
      payload: { notes: typeof params.notes === 'string' ? params.notes : null },
      created_at: new Date().toISOString(),
    });
    return success(request.id, { ok: true, status });
  }

  private readWorkerMemory(request: JsonRpcRequest): JsonRpcResponse {
    const worker = this.db.getWorker(String(request.params?.worker_instance_id ?? ''));
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }
    const memory = readWorkerMemory(this.resolveAuthorityRoot(worker.session_id), worker.worker_instance_id, worker.memory_ref);
    return success(request.id, memory);
  }

  private appendWorkerMemory(request: JsonRpcRequest): JsonRpcResponse {
    const worker = this.db.getWorker(String(request.params?.worker_instance_id ?? ''));
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }
    const content = String(request.params?.content ?? '');
    const memoryPath = ensureWorkerMemoryFile(
      this.resolveAuthorityRoot(worker.session_id),
      worker.worker_instance_id,
      worker.session_id,
      worker.role_label,
      worker.memory_ref,
    );
    appendFileSync(memoryPath, `${content}${content.endsWith('\n') ? '' : '\n'}`, 'utf8');
    this.writeWorkerPacket(worker.session_id, worker.worker_instance_id, worker.generation, worker.role_label, worker.memory_ref ?? null);
    return success(request.id, readWorkerMemory(this.resolveAuthorityRoot(worker.session_id), worker.worker_instance_id, worker.memory_ref));
  }

  private replaceWorkerMemory(request: JsonRpcRequest): JsonRpcResponse {
    const worker = this.db.getWorker(String(request.params?.worker_instance_id ?? ''));
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }
    const content = String(request.params?.content ?? '');
    const memoryPath = ensureWorkerMemoryFile(
      this.resolveAuthorityRoot(worker.session_id),
      worker.worker_instance_id,
      worker.session_id,
      worker.role_label,
      worker.memory_ref,
    );
    writeFileSync(memoryPath, content, 'utf8');
    this.writeWorkerPacket(worker.session_id, worker.worker_instance_id, worker.generation, worker.role_label, worker.memory_ref ?? null);
    return success(request.id, readWorkerMemory(this.resolveAuthorityRoot(worker.session_id), worker.worker_instance_id, worker.memory_ref));
  }

  private showRehydrationPacket(request: JsonRpcRequest): JsonRpcResponse {
    const worker = this.db.getWorker(String(request.params?.worker_instance_id ?? ''));
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }
    const authorityRoot = this.resolveAuthorityRoot(worker.session_id);
    const packetPath = join(authorityRoot, 'rehydration', `${worker.worker_instance_id}.json`);
    try {
      return success(request.id, {
        worker_instance_id: worker.worker_instance_id,
        packet_path: packetPath,
        packet: JSON.parse(readFileSync(packetPath, 'utf8')),
      });
    } catch (error) {
      return failure(request.id, 404, 'rehydration packet not found', String(error));
    }
  }

  private assignAttempt(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const worker = this.db.getWorker(String(params.worker_instance_id));
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }
    const taskId = String(params.task_id);
    const task = this.db.getTask(taskId);
    if (!task) {
      return failure(request.id, 404, 'task not found');
    }
    const nextFence = worker.generation;
    const attemptId = String(params.attempt_id);
    this.db.insertAttempt({
      attempt_id: attemptId,
      task_id: taskId,
      worker_instance_id: worker.worker_instance_id,
      assignment_fence: nextFence,
      status: 'assigned',
      current_activity: 'assigned',
      progress_counter: 0,
      started_at: now,
      last_heartbeat_at: undefined,
      last_meaningful_change_at: now,
      completed_at: undefined,
      error_summary: undefined,
    });
    this.db.updateWorkerActiveAttempt(worker.worker_instance_id, attemptId, now);
    this.db.updateWorkerBlockedReason(worker.worker_instance_id, null, now);
    this.db.updateTaskStatus(taskId, 'active', now);
    this.writeWorkerPacket(worker.session_id, worker.worker_instance_id, worker.generation, worker.role_label, worker.memory_ref ?? null);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: worker.session_id,
      event_type: 'attempt_assigned',
      actor: 'controller',
      subject_type: 'attempt',
      subject_id: attemptId,
      mutation_id: randomUUID(),
      payload: { assignment_fence: nextFence, worker_instance_id: worker.worker_instance_id },
      created_at: now,
    });
    return success(request.id, { attempt_id: attemptId, assignment_fence: nextFence });
  }

  private async cancelAttempt(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const attemptId = String(params.attempt_id);
    const attempt = this.db.getAttempt(attemptId);
    if (!attempt) {
      return failure(request.id, 404, 'attempt not found');
    }

    const worker = this.db.getWorker(attempt.worker_instance_id);
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }

    const commandId = randomUUID();
    this.db.insertControllerCommand({
      command_id: commandId,
      session_id: worker.session_id,
      kind: 'cancel_attempt',
      status: 'pending',
      step_state: 'cancel_requested',
      payload: { attempt_id: attemptId, worker_instance_id: worker.worker_instance_id },
      created_at: now,
      updated_at: now,
    });

    if (worker.runtime_handle) {
      await this.supervisor.terminateWorker({ runtimeHandle: worker.runtime_handle });
    }

    const cancelled = this.db.completeAttempt(attemptId, attempt.assignment_fence, 'cancelled', 'cancelled by admin', now);
    if (!cancelled) {
      this.db.updateControllerCommand(commandId, 'aborted', 'fence_rejected', now);
      return failure(request.id, 409, 'fence rejected');
    }

    const nextGeneration = this.db.advanceWorkerGeneration(worker.worker_instance_id, null, now);
    this.db.bindWorkerRuntime(worker.worker_instance_id, null, 'killed', now);
    this.db.updateWorkerActiveAttempt(worker.worker_instance_id, null, now);
    this.db.updateWorkerBlockedReason(worker.worker_instance_id, null, now);
    this.db.updateControllerCommand(commandId, 'applied', 'cleanup_done', now);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: worker.session_id,
      event_type: 'attempt_cancelled',
      actor: 'admin',
      subject_type: 'attempt',
      subject_id: attemptId,
      mutation_id: randomUUID(),
      payload: { worker_instance_id: worker.worker_instance_id, next_generation: nextGeneration },
      created_at: now,
    });
    return success(request.id, { ok: true, next_generation: nextGeneration });
  }

  private async recycleWorkerSession(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const worker = this.db.getWorker(String(params.worker_instance_id));
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }

    const nextGeneration = this.db.advanceWorkerGeneration(worker.worker_instance_id, null, now);
    const activeAttempt = this.db.getCurrentAttemptForWorker(worker.worker_instance_id);
    if (activeAttempt) {
      this.db.reassignAttemptFence(activeAttempt.attempt_id, nextGeneration, now);
    }

    const commandId = randomUUID();
    this.db.insertControllerCommand({
      command_id: commandId,
      session_id: worker.session_id,
      kind: 'recycle_worker_session',
      status: 'pending',
      step_state: 'recycle_requested',
      payload: {
        worker_instance_id: worker.worker_instance_id,
        previous_runtime_handle: worker.runtime_handle ?? null,
        next_generation: nextGeneration,
      },
      created_at: now,
      updated_at: now,
    });

    const handle = await this.supervisor.recycleWorker(
      {
        sessionId: worker.session_id,
        workerInstanceId: worker.worker_instance_id,
        roleLabel: worker.role_label,
        generation: nextGeneration,
        authorityRoot: this.resolveAuthorityRoot(worker.session_id),
        workingDir: process.env.HARNESS_WORKER_CWD ?? process.cwd(),
        cliPath: process.env.HARNESS_CLI_PATH ?? DEFAULT_CLI_PATH,
        memoryRef: worker.memory_ref,
      },
      worker.runtime_handle,
    );

    this.db.bindWorkerRuntime(worker.worker_instance_id, handle.runtimeHandle, 'started', now);
    this.db.updateWorkerBlockedReason(worker.worker_instance_id, null, now);
    this.db.updateControllerCommand(commandId, 'applied', 'started', now);
    this.writeWorkerPacket(worker.session_id, worker.worker_instance_id, nextGeneration, worker.role_label, worker.memory_ref ?? null);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: worker.session_id,
      event_type: 'worker_session_recycled',
      actor: 'controller',
      subject_type: 'worker_instance',
      subject_id: worker.worker_instance_id,
      mutation_id: randomUUID(),
      payload: {
        runtime_handle: handle.runtimeHandle,
        generation: nextGeneration,
        active_attempt_id: activeAttempt?.attempt_id ?? null,
      },
      created_at: now,
    });
    return success(request.id, handle);
  }

  private heartbeat(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const attemptId = String(params.attempt_id);
    const ok = this.db.updateAttemptHeartbeat(
      attemptId,
      Number(params.assignment_fence),
      String(params.activity),
      Number(params.progress_counter),
      now,
    );
    if (ok) {
      const attempt = this.db.getAttempt(attemptId);
      if (attempt) {
        this.db.updateWorkerBlockedReason(attempt.worker_instance_id, null, now);
      }
    }
    return ok ? success(request.id, { ok: true }) : failure(request.id, 409, 'fence rejected');
  }

  private reportBlocked(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const attemptId = String(params.attempt_id);
    const fence = Number(params.assignment_fence);
    const reason = String(params.reason ?? 'blocked');
    const attempt = this.db.getAttempt(attemptId);
    if (!attempt || attempt.assignment_fence !== fence || !['assigned', 'running', 'blocked'].includes(attempt.status)) {
      return failure(request.id, 409, 'fence rejected');
    }
    const worker = this.db.getWorker(attempt.worker_instance_id);
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }
    const ok = this.db.markAttemptBlocked(attemptId, fence, reason, now);
    if (!ok) {
      return failure(request.id, 409, 'fence rejected');
    }
    this.db.updateWorkerBlockedReason(worker.worker_instance_id, reason, now);
    this.db.insertEvent({
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
    return success(request.id, { ok: true, reason });
  }

  private pollMessages(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const workerInstanceId = String(params.worker_instance_id);
    const generation = Number(params.generation ?? 0);
    const worker = this.db.getWorker(workerInstanceId);
    if (!worker || worker.generation !== generation) {
      return failure(request.id, 409, 'generation rejected');
    }
    const messages = this.db.listPendingMessages(workerInstanceId);
    const now = new Date().toISOString();
    this.db.markMessagesDelivered(
      messages.map((message) => message.message_id),
      now,
    );
    return success(request.id, { messages });
  }

  private sendWorkerMessage(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const attemptId = String(params.attempt_id);
    const attempt = this.db.getAttempt(attemptId);
    if (!attempt || attempt.assignment_fence !== Number(params.assignment_fence) || !['assigned', 'running', 'blocked'].includes(attempt.status)) {
      return failure(request.id, 409, 'fence rejected');
    }
    const worker = this.db.getWorker(attempt.worker_instance_id);
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }
    this.db.insertMessage({
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
    return success(request.id, { ok: true });
  }

  private registerArtifact(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const attemptId = String(params.attempt_id);
    const attempt = this.db.getAttempt(attemptId);
    if (!attempt || attempt.assignment_fence !== Number(params.assignment_fence) || !['assigned', 'running', 'blocked'].includes(attempt.status)) {
      return failure(request.id, 409, 'fence rejected');
    }
    const worker = this.db.getWorker(attempt.worker_instance_id);
    if (!worker) {
      return failure(request.id, 404, 'worker instance not found');
    }
    this.db.insertArtifact({
      artifact_id: String(params.artifact_id),
      session_id: worker.session_id,
      attempt_id: attemptId,
      worker_instance_id: worker.worker_instance_id,
      kind: String(params.kind),
      storage_uri: String(params.storage_uri),
      digest: String(params.digest),
      size_bytes: typeof params.size_bytes === 'number' ? params.size_bytes : undefined,
      metadata: params.metadata ?? null,
      status: 'sealed',
      created_at: now,
    });
    this.db.insertEvent({
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
    return success(request.id, { ok: true });
  }

  private completeAttempt(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params ?? {};
    const now = new Date().toISOString();
    const attemptId = String(params.attempt_id);
    const fence = Number(params.assignment_fence);
    const status = String(params.status) as 'completed' | 'failed' | 'cancelled';
    const ok = this.db.completeAttempt(
      attemptId,
      fence,
      status,
      typeof params.error_summary === 'string' ? params.error_summary : null,
      now,
    );
    if (!ok) {
      return failure(request.id, 409, 'fence rejected');
    }
    const attempt = this.db.getAttempt(attemptId);
    if (attempt) {
      this.db.updateWorkerActiveAttempt(attempt.worker_instance_id, null, now);
      this.db.updateWorkerBlockedReason(attempt.worker_instance_id, null, now);
      this.db.updateTaskStatus(attempt.task_id, status === 'completed' ? 'provisional' : 'active', now);
      const worker = this.db.getWorker(attempt.worker_instance_id);
      const task = this.db.getTask(attempt.task_id);
      if (task) {
        this.db.insertEvent({
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
    return success(request.id, { ok: true });
  }

  private status(request: JsonRpcRequest): JsonRpcResponse {
    const sessionId = String(request.params?.session_id ?? '');
    const session = this.db.getSession(sessionId);
    if (!session) {
      return failure(request.id, 404, 'session not found');
    }
    return success(request.id, {
      session,
      tasks: this.db.listSessionTasks(sessionId),
      workers: this.db.listSessionWorkers(sessionId),
      attempts: this.db.listSessionAttempts(sessionId),
      artifacts: this.db.listSessionArtifacts(sessionId),
      validations: this.db.listSessionValidations(sessionId),
      controller_commands: this.db.listSessionControllerCommands(sessionId),
    });
  }

  private resolveAuthorityRoot(sessionId: string): string {
    const session = this.db.getSession(sessionId);
    if (session) {
      return session.authority_root;
    }
    return dirname(this.paths.dbPath);
  }

  private writeRehydrationPacket(sessionId: string, workerInstanceId: string, packet: unknown): void {
    const authorityRoot = this.resolveAuthorityRoot(sessionId);
    const dir = join(authorityRoot, 'rehydration');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${workerInstanceId}.json`), `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  }

  private writeWorkerPacket(
    sessionId: string,
    workerInstanceId: string,
    workerGeneration: number,
    roleLabel: string,
    memoryRef: string | null,
  ): void {
    const activeAttempt = this.db.getCurrentAttemptForWorker(workerInstanceId);
    const task = activeAttempt ? this.db.getTask(activeAttempt.task_id) : undefined;
    const authorityRoot = this.resolveAuthorityRoot(sessionId);
    const memory = readWorkerMemory(authorityRoot, workerInstanceId, memoryRef);
    this.writeRehydrationPacket(sessionId, workerInstanceId, {
      generated_at: new Date().toISOString(),
      session_id: sessionId,
      worker_instance_id: workerInstanceId,
      worker_generation: workerGeneration,
      role_label: roleLabel,
      memory_ref: memoryRef,
      memory,
      active_attempt: activeAttempt && task
        ? {
            attempt_id: activeAttempt.attempt_id,
            assignment_fence: activeAttempt.assignment_fence,
            status: activeAttempt.status,
            current_activity: activeAttempt.current_activity,
            progress_counter: activeAttempt.progress_counter,
            task_id: task.task_id,
            task_class: task.task_class,
            subject: task.subject,
            description: task.description,
          }
        : null,
      recent_attempts: this.db.listRecentWorkerAttempts(workerInstanceId, 5),
    });
  }

  private async reconcileWorkers(): Promise<void> {
    const workers = this.db.listWorkersWithRuntimeHandles();
    const now = new Date().toISOString();
    for (const worker of workers) {
      if (!worker.runtime_handle) {
        continue;
      }
      const adopted = await this.supervisor.adoptWorker(
        {
          sessionId: worker.session_id,
          workerInstanceId: worker.worker_instance_id,
          roleLabel: worker.role_label,
          generation: worker.generation,
          authorityRoot: this.resolveAuthorityRoot(worker.session_id),
          workingDir: process.env.HARNESS_WORKER_CWD ?? process.cwd(),
          cliPath: process.env.HARNESS_CLI_PATH ?? DEFAULT_CLI_PATH,
          memoryRef: worker.memory_ref,
        },
        worker.runtime_handle,
      );
      if (adopted) {
        this.db.bindWorkerRuntime(worker.worker_instance_id, worker.runtime_handle, 'started', now);
        this.writeWorkerPacket(worker.session_id, worker.worker_instance_id, worker.generation, worker.role_label, worker.memory_ref ?? null);
        this.db.insertEvent({
          event_id: randomUUID(),
          session_id: worker.session_id,
          event_type: 'worker_reconciled',
          actor: 'controller',
          subject_type: 'worker_instance',
          subject_id: worker.worker_instance_id,
          mutation_id: randomUUID(),
          payload: { runtime_handle: worker.runtime_handle, generation: worker.generation },
          created_at: now,
        });
        continue;
      }

      this.db.bindWorkerRuntime(worker.worker_instance_id, null, 'exited', now);
      this.db.insertEvent({
        event_id: randomUUID(),
        session_id: worker.session_id,
        event_type: 'worker_runtime_missing',
        actor: 'controller',
        subject_type: 'worker_instance',
        subject_id: worker.worker_instance_id,
        mutation_id: randomUUID(),
        payload: { previous_runtime_handle: worker.runtime_handle, generation: worker.generation },
        created_at: now,
      });
    }
  }

  private async reconcileControllerCommands(): Promise<void> {
    const commands = this.db.listUnsettledControllerCommands();
    for (const command of commands) {
      switch (command.kind) {
        case 'launch_worker':
          this.reconcileLaunchWorkerCommand(command);
          break;
        case 'cancel_attempt':
          await this.replayCancelAttemptCommand(command);
          break;
        case 'recycle_worker_session':
          await this.replayRecycleWorkerCommand(command);
          break;
        default:
          this.db.updateControllerCommand(command.command_id, 'aborted', 'unsupported_reconcile', new Date().toISOString());
          break;
      }
    }
  }

  private reconcileLaunchWorkerCommand(command: { command_id: string; payload: unknown }): void {
    const payload = (command.payload ?? {}) as { worker_instance_id?: string };
    const workerId = typeof payload.worker_instance_id === 'string' ? payload.worker_instance_id : '';
    const worker = this.db.getWorker(workerId);
    const now = new Date().toISOString();
    if (worker?.runtime_handle) {
      this.db.updateControllerCommand(command.command_id, 'reconciled', 'started', now);
      return;
    }
    this.db.updateControllerCommand(command.command_id, 'aborted', 'runtime_missing', now);
  }

  private async replayCancelAttemptCommand(command: { command_id: string; payload: unknown }): Promise<void> {
    const payload = (command.payload ?? {}) as { attempt_id?: string; worker_instance_id?: string };
    const attemptId = typeof payload.attempt_id === 'string' ? payload.attempt_id : '';
    const attempt = this.db.getAttempt(attemptId);
    const now = new Date().toISOString();
    if (!attempt) {
      this.db.updateControllerCommand(command.command_id, 'aborted', 'attempt_missing', now);
      return;
    }
    if (['completed', 'failed', 'cancelled'].includes(attempt.status)) {
      this.db.updateControllerCommand(command.command_id, 'reconciled', 'cleanup_done', now);
      return;
    }
    const worker = this.db.getWorker(attempt.worker_instance_id);
    if (!worker) {
      this.db.updateControllerCommand(command.command_id, 'aborted', 'worker_missing', now);
      return;
    }
    if (worker.runtime_handle) {
      await this.supervisor.terminateWorker({ runtimeHandle: worker.runtime_handle });
    }
    const cancelled = this.db.completeAttempt(attemptId, attempt.assignment_fence, 'cancelled', 'cancel replay after controller restart', now);
    if (!cancelled) {
      this.db.updateControllerCommand(command.command_id, 'aborted', 'fence_rejected', now);
      return;
    }
    const nextGeneration = this.db.advanceWorkerGeneration(worker.worker_instance_id, null, now);
    this.db.bindWorkerRuntime(worker.worker_instance_id, null, 'killed', now);
    this.db.updateWorkerActiveAttempt(worker.worker_instance_id, null, now);
    this.db.updateWorkerBlockedReason(worker.worker_instance_id, null, now);
    this.db.updateControllerCommand(command.command_id, 'reconciled', 'cleanup_done', now);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: worker.session_id,
      event_type: 'attempt_cancelled_replayed',
      actor: 'controller',
      subject_type: 'attempt',
      subject_id: attemptId,
      mutation_id: randomUUID(),
      payload: { worker_instance_id: worker.worker_instance_id, next_generation: nextGeneration },
      created_at: now,
    });
  }

  private async replayRecycleWorkerCommand(command: { command_id: string; payload: unknown }): Promise<void> {
    const payload = (command.payload ?? {}) as { worker_instance_id?: string };
    const workerId = typeof payload.worker_instance_id === 'string' ? payload.worker_instance_id : '';
    const worker = this.db.getWorker(workerId);
    const now = new Date().toISOString();
    if (!worker) {
      this.db.updateControllerCommand(command.command_id, 'aborted', 'worker_missing', now);
      return;
    }
    const handle = await this.supervisor.recycleWorker(
      {
        sessionId: worker.session_id,
        workerInstanceId: worker.worker_instance_id,
        roleLabel: worker.role_label,
        generation: worker.generation,
        authorityRoot: this.resolveAuthorityRoot(worker.session_id),
        workingDir: process.env.HARNESS_WORKER_CWD ?? process.cwd(),
        cliPath: process.env.HARNESS_CLI_PATH ?? DEFAULT_CLI_PATH,
        memoryRef: worker.memory_ref,
      },
      worker.runtime_handle,
    );
    this.db.bindWorkerRuntime(worker.worker_instance_id, handle.runtimeHandle, 'started', now);
    this.db.updateWorkerBlockedReason(worker.worker_instance_id, null, now);
    this.writeWorkerPacket(worker.session_id, worker.worker_instance_id, worker.generation, worker.role_label, worker.memory_ref ?? null);
    this.db.updateControllerCommand(command.command_id, 'reconciled', 'started', now);
    this.db.insertEvent({
      event_id: randomUUID(),
      session_id: worker.session_id,
      event_type: 'worker_session_recycled_replayed',
      actor: 'controller',
      subject_type: 'worker_instance',
      subject_id: worker.worker_instance_id,
      mutation_id: randomUUID(),
      payload: { runtime_handle: handle.runtimeHandle, generation: worker.generation },
      created_at: now,
    });
  }
}
