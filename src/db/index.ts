import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AttemptRecord,
  ArtifactRecord,
  CapabilityProfile,
  ControllerCommandRecord,
  EventRecord,
  MessageRecord,
  SessionRecord,
  TaskRecord,
  ValidationRecord,
  WorkerInstanceRecord,
} from '../types/model.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(
  existsSync(resolve(MODULE_DIR, 'schema.sql'))
    ? resolve(MODULE_DIR, 'schema.sql')
    : resolve(process.cwd(), 'src', 'db', 'schema.sql'),
);

function parseJson<T>(value: string | null): T {
  return JSON.parse(value ?? 'null') as T;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

export class HarnessDatabase {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createSession(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, family, config_path, authority_root, status, created_at, updated_at)
         VALUES (@session_id, @family, @config_path, @authority_root, @status, @created_at, @updated_at)`,
      )
      .run(record);
  }

  insertWorker(record: WorkerInstanceRecord): void {
    this.db
      .prepare(
        `INSERT INTO worker_instances (
          worker_instance_id, session_id, role_label, runtime_handle, generation, capability_profile,
          supervisor_state, blocked_reason, current_attempt_id, memory_ref, started_at, stopped_at, updated_at
        ) VALUES (
          @worker_instance_id, @session_id, @role_label, @runtime_handle, @generation, @capability_profile,
          @supervisor_state, @blocked_reason, @current_attempt_id, @memory_ref, @started_at, @stopped_at, @updated_at
        )`,
      )
      .run({
        ...record,
        capability_profile: stringify(record.capability_profile),
      });
  }

  insertTask(record: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          task_id, session_id, task_class, subject, description, priority,
          required_capabilities, desired_outputs, status, created_at, updated_at
        ) VALUES (
          @task_id, @session_id, @task_class, @subject, @description, @priority,
          @required_capabilities, @desired_outputs, @status, @created_at, @updated_at
        )`,
      )
      .run({
        ...record,
        required_capabilities: stringify(record.required_capabilities),
        desired_outputs: stringify(record.desired_outputs),
      });
  }

  insertAttempt(record: AttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO attempts (
          attempt_id, task_id, worker_instance_id, assignment_fence, status, current_activity,
          progress_counter, error_summary, started_at, last_heartbeat_at, last_meaningful_change_at, completed_at
        ) VALUES (
          @attempt_id, @task_id, @worker_instance_id, @assignment_fence, @status, @current_activity,
          @progress_counter, @error_summary, @started_at, @last_heartbeat_at, @last_meaningful_change_at, @completed_at
        )`,
      )
      .run(record);
  }

  insertEvent(record: EventRecord): void {
    this.db
      .prepare(
        `INSERT INTO events (
          event_id, session_id, event_type, actor, subject_type, subject_id,
          mutation_id, causation_id, correlation_id, payload, created_at
        ) VALUES (
          @event_id, @session_id, @event_type, @actor, @subject_type, @subject_id,
          @mutation_id, @causation_id, @correlation_id, @payload, @created_at
        )`,
      )
      .run({
        ...record,
        causation_id: record.causation_id ?? null,
        correlation_id: record.correlation_id ?? null,
        payload: stringify(record.payload),
      });
  }

  insertControllerCommand(record: ControllerCommandRecord): void {
    this.db
      .prepare(
        `INSERT INTO controller_commands (
          command_id, session_id, kind, status, step_state, payload, created_at, updated_at
        ) VALUES (
          @command_id, @session_id, @kind, @status, @step_state, @payload, @created_at, @updated_at
        )`,
      )
      .run({ ...record, payload: stringify(record.payload) });
  }

  listUnsettledControllerCommands(): ControllerCommandRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM controller_commands
         WHERE status IN ('pending', 'acked')
         ORDER BY created_at ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(decodeControllerCommand);
  }

  listSessionControllerCommands(sessionId: string, limit = 20): ControllerCommandRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM controller_commands
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(decodeControllerCommand);
  }

  insertMessage(record: MessageRecord): void {
    this.db
      .prepare(
        `INSERT INTO messages (
          message_id, session_id, from_worker_instance_id, to_worker_instance_id, attempt_id,
          kind, payload, status, lease_token, leased_at, lease_expires_at, created_at, delivered_at, expires_at
        ) VALUES (
          @message_id, @session_id, @from_worker_instance_id, @to_worker_instance_id, @attempt_id,
          @kind, @payload, @status, @lease_token, @leased_at, @lease_expires_at, @created_at, @delivered_at, @expires_at
        )`,
      )
      .run({
        ...record,
        from_worker_instance_id: record.from_worker_instance_id ?? null,
        to_worker_instance_id: record.to_worker_instance_id ?? null,
        attempt_id: record.attempt_id ?? null,
        payload: stringify(record.payload),
        lease_token: record.lease_token ?? null,
        leased_at: record.leased_at ?? null,
        lease_expires_at: record.lease_expires_at ?? null,
        delivered_at: record.delivered_at ?? null,
        expires_at: record.expires_at ?? null,
      });
  }

  insertArtifact(record: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (
          artifact_id, session_id, attempt_id, worker_instance_id, kind, storage_uri,
          digest, size_bytes, metadata, status, created_at
        ) VALUES (
          @artifact_id, @session_id, @attempt_id, @worker_instance_id, @kind, @storage_uri,
          @digest, @size_bytes, @metadata, @status, @created_at
        )`,
      )
      .run({
        ...record,
        attempt_id: record.attempt_id ?? null,
        worker_instance_id: record.worker_instance_id ?? null,
        size_bytes: record.size_bytes ?? null,
        metadata: stringify(record.metadata),
      });
  }

  getArtifact(artifactId: string): ArtifactRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE artifact_id = ?')
      .get(artifactId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return decodeArtifact(row);
  }

  insertValidation(record: ValidationRecord): void {
    this.db
      .prepare(
        `INSERT INTO validations (
          validation_id, session_id, attempt_id, kind, decision, validator_ref, notes, created_at
        ) VALUES (
          @validation_id, @session_id, @attempt_id, @kind, @decision, @validator_ref, @notes, @created_at
        )`,
      )
      .run({
        ...record,
        validator_ref: record.validator_ref ?? null,
        notes: record.notes ?? null,
      });
  }

  updateControllerCommand(commandId: string, status: ControllerCommandRecord['status'], stepState: string, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE controller_commands
         SET status = ?, step_state = ?, updated_at = ?
         WHERE command_id = ?`,
      )
      .run(status, stepState, updatedAt, commandId);
  }

  getWorker(workerInstanceId: string): WorkerInstanceRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM worker_instances WHERE worker_instance_id = ?')
      .get(workerInstanceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return decodeWorker(row);
  }

  getAttempt(attemptId: string): AttemptRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM attempts WHERE attempt_id = ?')
      .get(attemptId) as AttemptRecord | undefined;
    return row;
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE task_id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return decodeTask(row);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as SessionRecord | undefined;
    return row;
  }

  listSessionWorkers(sessionId: string): WorkerInstanceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM worker_instances WHERE session_id = ? ORDER BY started_at ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(decodeWorker);
  }

  listWorkersWithRuntimeHandles(): WorkerInstanceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM worker_instances WHERE runtime_handle IS NOT NULL ORDER BY started_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map(decodeWorker);
  }

  listSessionTasks(sessionId: string): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(decodeTask);
  }

  listSessionAttempts(sessionId: string): AttemptRecord[] {
    return this.db
      .prepare(
        `SELECT a.* FROM attempts a
         JOIN tasks t ON t.task_id = a.task_id
         WHERE t.session_id = ?
         ORDER BY a.started_at ASC`,
      )
      .all(sessionId) as AttemptRecord[];
  }

  leaseMessages(workerInstanceId: string, leasedAt: string, leaseExpiresAt: string): MessageRecord[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE to_worker_instance_id = ?
             AND (
               status = 'pending'
               OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
           ORDER BY created_at ASC`,
        )
        .all(workerInstanceId, leasedAt) as Record<string, unknown>[];
      const update = this.db.prepare(
        `UPDATE messages
         SET status = 'leased',
             lease_token = ?,
             leased_at = ?,
             lease_expires_at = ?
         WHERE message_id = ?`,
      );
      return rows.map((row) => {
        const decoded = decodeMessage(row);
        const leaseToken = randomUUID();
        update.run(leaseToken, leasedAt, leaseExpiresAt, decoded.message_id);
        return {
          ...decoded,
          status: 'leased' as const,
          lease_token: leaseToken,
          leased_at: leasedAt,
          lease_expires_at: leaseExpiresAt,
        };
      });
    });
  }

  ackMessages(acks: Array<{ message_id: string; lease_token: string }>, deliveredAt: string): number {
    if (acks.length === 0) {
      return 0;
    }
    return this.transaction(() => {
      const update = this.db.prepare(
        `UPDATE messages
         SET status = 'delivered',
             delivered_at = ?,
             lease_token = NULL,
             leased_at = NULL,
             lease_expires_at = NULL
         WHERE message_id = ? AND status = 'leased' AND lease_token = ?`,
      );
      let changed = 0;
      for (const ack of acks) {
        changed += Number(update.run(deliveredAt, ack.message_id, ack.lease_token).changes);
      }
      return changed;
    });
  }

  listSessionArtifacts(sessionId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM artifacts
         WHERE session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(decodeArtifact);
  }

  updateArtifactStatus(artifactId: string, status: ArtifactRecord['status']): boolean {
    const result = this.db
      .prepare(
        `UPDATE artifacts
         SET status = ?
         WHERE artifact_id = ? AND status = 'sealed'`,
      )
      .run(status, artifactId);
    return result.changes === 1;
  }

  allocateNextAssignmentFence(workerInstanceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(assignment_fence), 0) AS max_fence
         FROM attempts
         WHERE worker_instance_id = ?`,
      )
      .get(workerInstanceId) as { max_fence: number };
    return Number(row.max_fence ?? 0) + 1;
  }

  listSessionValidations(sessionId: string): ValidationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM validations
         WHERE session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(decodeValidation);
  }

  listRecentWorkerAttempts(workerInstanceId: string, limit: number): AttemptRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM attempts
         WHERE worker_instance_id = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(workerInstanceId, limit) as AttemptRecord[];
  }

  updateWorkerActiveAttempt(workerInstanceId: string, attemptId: string | null, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE worker_instances
         SET current_attempt_id = ?, updated_at = ?
         WHERE worker_instance_id = ?`,
      )
      .run(attemptId, updatedAt, workerInstanceId);
  }

  updateWorkerBlockedReason(workerInstanceId: string, blockedReason: string | null, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE worker_instances
         SET blocked_reason = ?, updated_at = ?
         WHERE worker_instance_id = ?`,
      )
      .run(blockedReason, updatedAt, workerInstanceId);
  }

  updateTaskStatus(taskId: string, status: TaskRecord['status'], updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(status, updatedAt, taskId);
  }

  advanceWorkerGeneration(workerInstanceId: string, runtimeHandle: string | null, updatedAt: string): number {
    this.db
      .prepare(
        `UPDATE worker_instances
         SET generation = generation + 1, runtime_handle = ?, updated_at = ?
         WHERE worker_instance_id = ?`,
      )
      .run(runtimeHandle, updatedAt, workerInstanceId);
    const row = this.db
      .prepare('SELECT generation FROM worker_instances WHERE worker_instance_id = ?')
      .get(workerInstanceId) as { generation: number };
    return row.generation;
  }

  reassignAttemptFence(attemptId: string, nextFence: number, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE attempts
         SET assignment_fence = ?, last_meaningful_change_at = ?
         WHERE attempt_id = ? AND status IN ('assigned', 'running', 'blocked')`,
      )
      .run(nextFence, now, attemptId);
    return result.changes === 1;
  }

  bindWorkerRuntime(
    workerInstanceId: string,
    runtimeHandle: string | null,
    supervisorState: WorkerInstanceRecord['supervisor_state'],
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE worker_instances
         SET runtime_handle = ?, supervisor_state = ?, updated_at = ?
         WHERE worker_instance_id = ?`,
      )
      .run(runtimeHandle, supervisorState, updatedAt, workerInstanceId);
  }

  updateAttemptHeartbeat(
    attemptId: string,
    expectedFence: number,
    activity: string,
    progressCounter: number,
    now: string,
    livenessOnly = false,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE attempts
         SET current_activity = CASE
               WHEN ? THEN current_activity
               ELSE ?
             END,
             progress_counter = CASE
               WHEN ? THEN progress_counter
               ELSE ?
             END,
             last_heartbeat_at = ?,
             last_meaningful_change_at = CASE
               WHEN ? THEN last_meaningful_change_at
               WHEN progress_counter <> ? OR current_activity <> ? THEN ?
               ELSE last_meaningful_change_at
             END,
             status = CASE
               WHEN ? THEN status
               WHEN status IN ('assigned', 'blocked') THEN 'running'
               ELSE status
             END
         WHERE attempt_id = ? AND assignment_fence = ? AND status IN ('assigned', 'running', 'blocked')`,
      )
      .run(
        livenessOnly ? 1 : 0,
        activity,
        livenessOnly ? 1 : 0,
        progressCounter,
        now,
        livenessOnly ? 1 : 0,
        progressCounter,
        activity,
        now,
        livenessOnly ? 1 : 0,
        attemptId,
        expectedFence,
      );
    return result.changes === 1;
  }

  markAttemptBlocked(attemptId: string, expectedFence: number, blockedReason: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE attempts
         SET status = 'blocked',
             current_activity = ?,
             last_heartbeat_at = ?,
             last_meaningful_change_at = ?
         WHERE attempt_id = ? AND assignment_fence = ? AND status IN ('assigned', 'running', 'blocked')`,
      )
      .run(`blocked: ${blockedReason}`, now, now, attemptId, expectedFence);
    return result.changes === 1;
  }

  completeAttempt(attemptId: string, expectedFence: number, status: 'completed' | 'failed' | 'cancelled', errorSummary: string | null, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE attempts
         SET status = ?, error_summary = ?, completed_at = ?, last_meaningful_change_at = ?
         WHERE attempt_id = ? AND assignment_fence = ? AND status IN ('assigned', 'running', 'blocked')`,
      )
      .run(status, errorSummary, now, now, attemptId, expectedFence);
    return result.changes === 1;
  }

  getCurrentAttemptForWorker(workerInstanceId: string): AttemptRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT a.* FROM attempts a
         JOIN worker_instances w ON w.current_attempt_id = a.attempt_id
         WHERE w.worker_instance_id = ?`,
      )
      .get(workerInstanceId) as AttemptRecord | undefined;
    return row;
  }

  close(): void {
    this.db.close();
  }
}

function decodeWorker(row: Record<string, unknown>): WorkerInstanceRecord {
  return {
    worker_instance_id: String(row.worker_instance_id),
    session_id: String(row.session_id),
    role_label: String(row.role_label),
    runtime_handle: row.runtime_handle ? String(row.runtime_handle) : undefined,
    generation: Number(row.generation),
    capability_profile: parseJson<CapabilityProfile>(String(row.capability_profile ?? '{}')),
    supervisor_state: row.supervisor_state as WorkerInstanceRecord['supervisor_state'],
    blocked_reason: row.blocked_reason ? String(row.blocked_reason) : undefined,
    current_attempt_id: row.current_attempt_id ? String(row.current_attempt_id) : undefined,
    memory_ref: row.memory_ref ? String(row.memory_ref) : undefined,
    started_at: String(row.started_at),
    stopped_at: row.stopped_at ? String(row.stopped_at) : undefined,
    updated_at: String(row.updated_at),
  };
}

function decodeTask(row: Record<string, unknown>): TaskRecord {
  return {
    task_id: String(row.task_id),
    session_id: String(row.session_id),
    task_class: String(row.task_class),
    subject: String(row.subject),
    description: String(row.description),
    priority: Number(row.priority),
    required_capabilities: parseJson<string[]>(String(row.required_capabilities ?? '[]')),
    desired_outputs: parseJson<string[]>(String(row.desired_outputs ?? '[]')),
    status: row.status as TaskRecord['status'],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function decodeMessage(row: Record<string, unknown>): MessageRecord {
  return {
    message_id: String(row.message_id),
    session_id: String(row.session_id),
    from_worker_instance_id: row.from_worker_instance_id ? String(row.from_worker_instance_id) : undefined,
    to_worker_instance_id: row.to_worker_instance_id ? String(row.to_worker_instance_id) : undefined,
    attempt_id: row.attempt_id ? String(row.attempt_id) : undefined,
    kind: String(row.kind),
    payload: parseJson<unknown>(String(row.payload ?? 'null')),
    status: row.status as MessageRecord['status'],
    lease_token: row.lease_token ? String(row.lease_token) : undefined,
    leased_at: row.leased_at ? String(row.leased_at) : undefined,
    lease_expires_at: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
    created_at: String(row.created_at),
    delivered_at: row.delivered_at ? String(row.delivered_at) : undefined,
    expires_at: row.expires_at ? String(row.expires_at) : undefined,
  };
}

function decodeArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    artifact_id: String(row.artifact_id),
    session_id: String(row.session_id),
    attempt_id: row.attempt_id ? String(row.attempt_id) : undefined,
    worker_instance_id: row.worker_instance_id ? String(row.worker_instance_id) : undefined,
    kind: String(row.kind),
    storage_uri: String(row.storage_uri),
    digest: String(row.digest),
    size_bytes: row.size_bytes === null || row.size_bytes === undefined ? undefined : Number(row.size_bytes),
    metadata: parseJson<unknown>(String(row.metadata ?? 'null')),
    status: row.status as ArtifactRecord['status'],
    created_at: String(row.created_at),
  };
}

function decodeValidation(row: Record<string, unknown>): ValidationRecord {
  return {
    validation_id: String(row.validation_id),
    session_id: String(row.session_id),
    attempt_id: String(row.attempt_id),
    kind: row.kind as ValidationRecord['kind'],
    decision: row.decision as ValidationRecord['decision'],
    validator_ref: row.validator_ref ? String(row.validator_ref) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    created_at: String(row.created_at),
  };
}

function decodeControllerCommand(row: Record<string, unknown>): ControllerCommandRecord {
  return {
    command_id: String(row.command_id),
    session_id: String(row.session_id),
    kind: String(row.kind),
    status: row.status as ControllerCommandRecord['status'],
    step_state: String(row.step_state),
    payload: parseJson<unknown>(String(row.payload ?? 'null')),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
