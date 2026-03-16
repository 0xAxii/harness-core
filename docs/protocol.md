# Protocol Notes

## Transport

Initial transport:
- JSON-RPC 2.0
- Unix domain sockets
- newline-delimited request/response frames
- separate sockets for worker and admin
- CLI wrapper as the first client transport

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
- `send_message`
- `register_artifact`
- `report_blocked`

## Fence rule

Every mutable worker call must include:
- `attempt_id`
- `assignment_fence`

If the fence does not match the currently assigned attempt fence, the controller rejects the mutation.
Terminal attempts also reject further heartbeat or completion updates even when the stale fence matches.

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
- admin may enqueue directed messages; worker poll marks them delivered
- worker runtime sidecar mirrors recent delivered messages into a runtime mailbox file
- worker runtime sidecar also sends fallback heartbeats for the current active attempt
- worker may register sealed artifacts against the active attempt
- admin may transition artifacts from `sealed` to `promoted` or `rejected`
- completed attempts are validated separately through admin-side inline/operator decisions
