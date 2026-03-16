import type { CapabilityProfile, SessionFamily } from '../types/model.js';

export interface CreateSessionParams {
  session_id: string;
  family: SessionFamily;
  authority_root: string;
  config_path?: string;
}

export interface LaunchWorkerParams {
  session_id: string;
  worker_instance_id: string;
  role_label: string;
  capability_profile: CapabilityProfile;
  memory_ref?: string;
}

export interface CreateTaskParams {
  session_id: string;
  task_id: string;
  task_class: string;
  subject: string;
  description: string;
  priority?: number;
  required_capabilities?: string[];
  desired_outputs?: string[];
}

export interface AssignAttemptParams {
  task_id: string;
  attempt_id: string;
  worker_instance_id: string;
}

export interface CancelAttemptParams {
  attempt_id: string;
}

export interface RecycleWorkerParams {
  worker_instance_id: string;
}

export interface SendMessageParams {
  session_id: string;
  to_worker_instance_id: string;
  kind: string;
  payload: unknown;
}

export interface ValidateAttemptParams {
  attempt_id: string;
  kind: 'inline' | 'operator';
  decision: 'accepted' | 'rejected';
  validator_ref?: string;
  notes?: string;
}

export interface UpdateArtifactStatusParams {
  artifact_id: string;
  status: 'promoted' | 'rejected';
  notes?: string;
}

export interface WorkerMemoryParams {
  worker_instance_id: string;
  content?: string;
}

export type AdminMethod =
  | 'create_session'
  | 'launch_worker'
  | 'create_task'
  | 'assign_attempt'
  | 'cancel_attempt'
  | 'recycle_worker_session'
  | 'send_message'
  | 'validate_attempt'
  | 'promote_artifact'
  | 'reject_artifact'
  | 'read_worker_memory'
  | 'append_worker_memory'
  | 'replace_worker_memory'
  | 'show_rehydration_packet'
  | 'status';
