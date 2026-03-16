# harness-core

Minimal universal multi-agent harness core.

This repository contains the runtime kernel only:
- controller daemon
- embedded supervisor
- tmux-backed interactive worker sessions
- SQLite authority store
- worker/admin JSON-RPC transport skeleton
- fenced attempt model
- persistent worker identity with replaceable live sessions

It intentionally does not ship built-in worker personas, prompts, or domain presets.

## Scope

Initial implementation target:
- `code-oriented` session family only
- persistent interactive worker identities with replaceable live sessions
- sequential attempts per worker
- JSON-RPC over Unix sockets via CLI wrapper
- DB-only authority for events and controller commands
- stale worker mutations rejected by `assignment_fence`

## Layout

- `src/cli/` CLI entrypoints
- `src/controller/` controller daemon skeleton
- `src/db/` schema and persistence helpers
- `src/protocol/` worker/admin JSON-RPC contracts
- `src/runtime/` embedded supervisor skeleton
- `docs/` implementation notes

## CLI

- `harness start <session-id>`
- `harness stop <session-id>`
- `harness bootstrap <session-id>`
- `harness admin <method> <session-id> ...`
- `harness list-workers <session-id>`
- `harness attach-worker <session-id> <worker-instance-id> [--window <n>] [--pane <n>] [--print-target]`
- `harness show-mailbox <session-id> <worker-instance-id>`
- `harness show-heartbeat <session-id> <worker-instance-id>`
- `harness tail-worker <session-id> <worker-instance-id> [--window <n>] [--pane <n>] [--lines <n>]`
- `harness worker <method> <session-id> ...`
- `harness hud <session-id> [--watch] [--interval <ms>]`
- `harness hud-pane <session-id> [--interval <ms>]`

Useful admin memory methods:
- `harness admin read-memory <session-id> <worker-instance-id>`
- `harness admin append-memory <session-id> <worker-instance-id> <text...>`
- `harness admin replace-memory <session-id> <worker-instance-id> <text...>`
- `harness admin show-packet <session-id> <worker-instance-id>`

Smoke scripts:
- `npm run smoke:multi-worker`
- `npm run smoke:restart-reconcile`
- `npm run smoke:cancel-replay`

## Status

Early working scaffold.

Currently verified:
- background controller start / stop with pid and socket cleanup
- bootstrap controller daemon
- create session
- launch persistent worker identity
- launch detached tmux live session
- create task
- assign attempt
- launch-time rehydration packet with embedded external memory excerpt
- write rehydration packet on assignment
- task status moves to `active` on assignment
- admin-to-worker message enqueue and worker poll delivery
- worker mailbox + heartbeat sidecar snapshots
- worker blocked state and blocked_reason tracking
- worker artifact registration
- artifact promotion / rejection
- attempt completion plus admin validation decision
- heartbeat
- cancel attempt
- recycle live session while keeping worker identity
- fallback sidecar heartbeat across worker recycle
- controller restart reconciles surviving tmux workers and restarts their runtime sidecars
- controller restart replays pending `recycle_worker_session` commands and settles them as `reconciled`
- stale completion rejected by fence/state checks
- list-workers / attach-worker target lookup
- operator debug surface for mailbox / heartbeat / tmux pane capture
- HUD shows `last_heartbeat_at` and `last_meaningful_change_at` for attempts
