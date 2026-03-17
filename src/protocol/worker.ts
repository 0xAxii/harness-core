export interface WorkerReadyParams {
  session_id: string;
  worker_instance_id: string;
  generation: number;
}

export interface WorkerHeartbeatParams {
  attempt_id: string;
  assignment_fence: number;
  activity: string;
  progress_counter: number;
  liveness_only?: boolean;
}

export interface WorkerCompleteParams {
  attempt_id: string;
  assignment_fence: number;
  status: 'completed' | 'failed' | 'cancelled';
  error_summary?: string;
}

export interface WorkerPollParams {
  worker_instance_id: string;
  generation: number;
}

export interface WorkerAckMessagesParams {
  worker_instance_id: string;
  generation: number;
  acks: Array<{
    message_id: string;
    lease_token: string;
  }>;
}

export interface WorkerSendMessageParams {
  attempt_id: string;
  assignment_fence: number;
  to_worker_instance_id: string;
  kind: string;
  payload: unknown;
}

export interface WorkerRegisterArtifactParams {
  attempt_id: string;
  assignment_fence: number;
  artifact_id: string;
  kind: string;
  storage_uri: string;
  digest: string;
  size_bytes?: number;
  metadata?: unknown;
}

export type WorkerMethod =
  | 'ready'
  | 'heartbeat'
  | 'complete_attempt'
  | 'poll_messages'
  | 'ack_messages'
  | 'send_message'
  | 'register_artifact'
  | 'report_blocked';
