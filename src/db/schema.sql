PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('code-oriented')),
  config_path TEXT,
  authority_root TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'shutting_down', 'terminated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_instances (
  worker_instance_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  role_label TEXT NOT NULL,
  runtime_handle TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  capability_profile TEXT NOT NULL,
  supervisor_state TEXT NOT NULL CHECK (
    supervisor_state IN (
      'launch_requested',
      'launch_accepted',
      'started',
      'cancel_requested',
      'grace_timeout',
      'killed',
      'exited',
      'cleanup_done'
    )
  ),
  blocked_reason TEXT,
  current_attempt_id TEXT,
  memory_ref TEXT,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  task_class TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  required_capabilities TEXT NOT NULL,
  desired_outputs TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'offered', 'active', 'provisional', 'validated', 'terminal')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  worker_instance_id TEXT NOT NULL REFERENCES worker_instances(worker_instance_id) ON DELETE CASCADE,
  assignment_fence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('assigned', 'running', 'blocked', 'failed', 'completed', 'cancelled')),
  current_activity TEXT,
  progress_counter INTEGER NOT NULL DEFAULT 0 CHECK (progress_counter >= 0),
  error_summary TEXT,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  last_meaningful_change_at TEXT,
  completed_at TEXT,
  UNIQUE(worker_instance_id, assignment_fence)
);

CREATE TABLE IF NOT EXISTS events (
  global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS controller_commands (
  command_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'acked', 'applied', 'aborted', 'reconciled')),
  step_state TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  from_worker_instance_id TEXT REFERENCES worker_instances(worker_instance_id) ON DELETE SET NULL,
  to_worker_instance_id TEXT REFERENCES worker_instances(worker_instance_id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'expired')),
  lease_token TEXT,
  leased_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE SET NULL,
  worker_instance_id TEXT REFERENCES worker_instances(worker_instance_id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  storage_uri TEXT NOT NULL,
  digest TEXT NOT NULL,
  size_bytes INTEGER,
  metadata TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sealed', 'promoted', 'rejected')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS validations (
  validation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inline', 'operator')),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  validator_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_instances_session ON worker_instances(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_attempts_worker ON attempts(worker_instance_id);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, global_seq);
CREATE INDEX IF NOT EXISTS idx_controller_commands_session ON controller_commands(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_worker ON messages(to_worker_instance_id, status);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON artifacts(attempt_id);
CREATE INDEX IF NOT EXISTS idx_validations_session ON validations(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_validations_attempt ON validations(attempt_id, created_at);
