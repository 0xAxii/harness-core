export type SessionFamily = 'code-oriented';

export type SessionStatus = 'active' | 'shutting_down' | 'terminated';

export type WorkerSupervisorState =
  | 'launch_requested'
  | 'launch_accepted'
  | 'started'
  | 'cancel_requested'
  | 'grace_timeout'
  | 'killed'
  | 'exited'
  | 'cleanup_done';

export type TaskStatus = 'open' | 'offered' | 'active' | 'provisional' | 'validated' | 'terminal';

export type AttemptStatus = 'assigned' | 'running' | 'blocked' | 'failed' | 'completed' | 'cancelled';

export type ControllerCommandStatus = 'pending' | 'acked' | 'applied' | 'aborted' | 'reconciled';
export type MessageStatus = 'pending' | 'leased' | 'delivered' | 'expired';
export type ArtifactStatus = 'sealed' | 'promoted' | 'rejected';
export type AttemptTerminalStatus = 'completed' | 'failed' | 'cancelled';
export type ValidationKind = 'inline' | 'operator';
export type ValidationDecision = 'accepted' | 'rejected';
export type RuntimeTarget = 'codex';
export type AuthorityRootPolicy = 'explicit' | 'xdg-state';
export type LeaderUxMode = 'leader-first' | 'worker-centric';
export type SessionConfigPath = string;

export interface CapabilityProfile {
  fs_scope: string[];
  network_profile: 'deny' | 'local' | 'full';
  browser_access: boolean;
  publish_right: boolean;
  shared_resource_modes: string[];
  secret_classes: string[];
}

export interface SessionConfig {
  runtime_target: RuntimeTarget;
  authority_root_policy: AuthorityRootPolicy;
  capability_defaults: CapabilityProfile;
  leader_ux_mode: LeaderUxMode;
}

export interface SessionRecord {
  session_id: string;
  family: SessionFamily;
  config_path?: SessionConfigPath;
  authority_root: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

export interface WorkerInstanceRecord {
  worker_instance_id: string;
  session_id: string;
  role_label: string;
  runtime_handle?: string;
  generation: number;
  capability_profile: CapabilityProfile;
  supervisor_state: WorkerSupervisorState;
  blocked_reason?: string;
  current_attempt_id?: string;
  memory_ref?: string;
  started_at: string;
  stopped_at?: string;
  updated_at: string;
}

export interface TaskRecord {
  task_id: string;
  session_id: string;
  task_class: string;
  subject: string;
  description: string;
  priority: number;
  required_capabilities: string[];
  desired_outputs: string[];
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface AttemptRecord {
  attempt_id: string;
  task_id: string;
  worker_instance_id: string;
  assignment_fence: number;
  status: AttemptStatus;
  current_activity?: string;
  progress_counter: number;
  error_summary?: string;
  started_at: string;
  last_heartbeat_at?: string;
  last_meaningful_change_at?: string;
  completed_at?: string;
}

export interface EventRecord {
  event_id: string;
  session_id: string;
  event_type: string;
  actor: string;
  subject_type: string;
  subject_id: string;
  mutation_id: string;
  causation_id?: string;
  correlation_id?: string;
  payload: unknown;
  created_at: string;
}

export interface ControllerCommandRecord {
  command_id: string;
  session_id: string;
  kind: string;
  status: ControllerCommandStatus;
  step_state: string;
  payload: unknown;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  message_id: string;
  session_id: string;
  from_worker_instance_id?: string;
  to_worker_instance_id?: string;
  attempt_id?: string;
  kind: string;
  payload: unknown;
  status: MessageStatus;
  lease_token?: string;
  leased_at?: string;
  lease_expires_at?: string;
  created_at: string;
  delivered_at?: string;
  expires_at?: string;
}

export interface ArtifactRecord {
  artifact_id: string;
  session_id: string;
  attempt_id?: string;
  worker_instance_id?: string;
  kind: string;
  storage_uri: string;
  digest: string;
  size_bytes?: number;
  metadata: unknown;
  status: ArtifactStatus;
  created_at: string;
}

export interface ValidationRecord {
  validation_id: string;
  session_id: string;
  attempt_id: string;
  kind: ValidationKind;
  decision: ValidationDecision;
  validator_ref?: string;
  notes?: string;
  created_at: string;
}
