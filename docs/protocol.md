# Protocol Notes

## Scope

This protocol describes the current Codex-first local runtime.
It documents the current control-plane truth, fence rules, and worker/admin transport expectations.
Advanced features such as secret grants, generalized leases, environment fingerprints, and broader runtime generalization are later work.

## Transport

Initial transport:
- JSON-RPC 2.0
- Unix domain sockets
- newline-delimited request/response frames
- separate sockets for worker and admin
- CLI wrapper as the first client transport
- auth token carried in request params by the CLI wrapper

## Admin methods

- `create_session`
- `launch_worker`
- `create_task`
- `assign_attempt`
- `cancel_attempt`
- `recycle_worker_session`
- `send_message`
- `validate_attempt`
- `promote_artifact`
- `reject_artifact`
- `status`

## Worker methods

- `ready`
- `heartbeat`
- `complete_attempt`
- `poll_messages`
- `ack_messages`
- `send_message`
- `register_artifact`
- `report_blocked`

## Authority vs adapter

- Controller + database state are authoritative.
- tmux is the current worker runtime adapter.
- HUD, pane visibility, and exported files are observability tools, not truth.
- Loss of pane visibility must not invalidate authority, fences, or recovery.

## Fence rule

Every mutable worker call must include:
- `attempt_id`
- `assignment_fence`

If the fence does not match the currently assigned attempt fence, the controller rejects the mutation.
Terminal attempts also reject further heartbeat or completion updates even when the stale fence matches.

## Minimal typed config

Keep correctness-critical config narrow in the current slice:
- `runtime_target`
- `authority_root_policy`
- `capability_defaults`
- `leader_ux_mode`

Current use in the protocol surface:
- `create_session` may include `config_path`
- the referenced config is validated before session creation succeeds
- `launch_worker` may omit `capability_profile`, in which case the session config's `capability_defaults` are used
- the Phase 2 operator happy path may use a thin CLI wrapper, but it still resolves down to the same admin/worker RPC methods

## Initial runtime model

- persistent worker identity
- replaceable live session handle
- sequential attempts per worker
- controller-driven assignment
- no worker-side pull claim flow
- live session currently backed by detached tmux session
- assignment and recycle rewrite the worker rehydration packet
- controller restart performs conservative runtime reconcile against surviving tmux sessions
- controller restart also replays or settles pending controller commands into `reconciled` / `aborted`
- worker launch writes an initial rehydration packet even before the first active attempt
- worker memory is externalized to a durable file and embedded into the rehydration packet as a bounded excerpt
- admin may enqueue directed messages; worker poll now leases them and worker/sidecar acknowledges them separately
- worker runtime sidecar mirrors recent leased messages into a runtime mailbox file and then acknowledges them
- worker runtime sidecar also sends fallback heartbeats for the current active attempt
- worker may register sealed artifacts against the active attempt
- admin may transition artifacts from `sealed` to `promoted` or `rejected`
- completed attempts are validated separately through admin-side inline/operator decisions
- assign rejects workers whose capability profile does not satisfy task `required_capabilities`
- worker launch normalizes `capability_profile` before persisting it and projecting runtime env vars
