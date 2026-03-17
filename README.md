# harness-core

Codex-first harness core.

This repository contains the current v1 runtime kernel only:
- controller daemon
- embedded supervisor
- tmux-backed interactive worker sessions as the current runtime adapter
- SQLite authority store
- worker/admin JSON-RPC transport skeleton
- fenced attempt model
- persistent worker identity with replaceable live sessions

It intentionally does not ship built-in worker personas, prompts, or domain presets.
The source of truth is the controller + database state, not tmux panes, HUD output, or exported files.

## Scope

Current implementation target:
- `code-oriented` / Codex-first session family only
- persistent interactive worker identities with replaceable live sessions
- sequential attempts per worker
- JSON-RPC over Unix sockets via CLI wrapper
- DB-only authority for events and controller commands
- stale worker mutations rejected by `assignment_fence`
- leader-first operator flow using existing worker-centric primitives
- advanced features such as secret grants, generalized leases, environment fingerprints, and effect logs are later work

## Runtime posture

- **Authority lives in the database.** `events` and `controller_commands` remain authoritative.
- **tmux is the current adapter.** It is how workers run today, but it is not the source of truth.
- **Recovery is a core feature.** Restart reconcile, cancel replay, and stale fence rejection are part of the current kernel, not optional UX extras.
- **Leader-first is enough for now.** Early operator UX is centered on leader-visible status / attach / HUD flows rather than exposing every worker pane perfectly.

## Layout

- `src/cli/` CLI entrypoints
- `src/controller/` controller daemon skeleton
- `src/db/` schema and persistence helpers
- `src/protocol/` worker/admin JSON-RPC contracts
- `src/runtime/` embedded supervisor skeleton
- `docs/` implementation notes

## CLI

Quick start:
- `harness up <session-id> [--config <path>]`
- `harness hud <session-id>`
- `harness attach-worker <session-id>` (defaults to the leader worker)

Leader/operator-facing primitives:
- `harness up <session-id> [--config <path>]`
- `harness start <session-id>`
- `harness stop <session-id>`
- `harness bootstrap <session-id>`
- `harness admin <method> <session-id> ...`
- `harness admin create-session <session-id> --config <path>`
- `harness list-workers <session-id>`
- `harness attach-worker <session-id> [worker-instance-id] [--window <n>] [--pane <n>] [--print-target]`
- `harness show-mailbox <session-id> [worker-instance-id]`
- `harness show-heartbeat <session-id> [worker-instance-id]`
- `harness tail-worker <session-id> [worker-instance-id] [--window <n>] [--pane <n>] [--lines <n>]`
- `harness worker <method> <session-id> ...`
- `harness hud <session-id> [--watch] [--interval <ms>]`
- `harness hud-pane <session-id> [--interval <ms>]`

Useful admin memory methods:
- `harness admin read-memory <session-id> <worker-instance-id>`
- `harness admin append-memory <session-id> <worker-instance-id> <text...>`
- `harness admin replace-memory <session-id> <worker-instance-id> <text...>`
- `harness admin show-packet <session-id> <worker-instance-id>`

Smoke scripts:
- `npm run smoke:auth`
- `npm run smoke:assignment-fence`
- `npm run smoke:multi-worker`
- `npm run smoke:restart-reconcile`
- `npm run smoke:cancel-replay`
- `npm run smoke:gate-fix`
- `npm run smoke:session-config`
- `npm run smoke:operator-happy-path`

## Status

Early working scaffold for the Codex-first core.

Currently verified:
- background controller start / stop with pid and socket cleanup
- bootstrap controller daemon
- create session
- launch persistent worker identity
- launch detached tmux live session through the current adapter
- create task
- assign attempt
- launch-time rehydration packet with embedded external memory excerpt
- write rehydration packet on assignment
- task status moves to `active` on assignment
- admin-to-worker message enqueue and worker poll delivery
- admin / worker socket auth token enforcement
- leased mailbox delivery with explicit ack
- worker mailbox + heartbeat sidecar snapshots
- worker blocked state and blocked_reason tracking
- worker artifact registration
- artifact promotion / rejection
- attempt completion plus admin validation decision
- heartbeat
- cancel attempt
- recycle live session while keeping worker identity
- fallback sidecar heartbeat across worker recycle
- sequential assignment gate for active worker attempts
- launch failure settles controller state cleanly instead of leaving pending zombie commands
- assignment capability mismatch rejected before attempt creation
- capability profile payload validation at worker launch
- session config validation plus config-backed worker capability defaults
- liveness-only sidecar heartbeat that preserves worker-owned progress/activity
- controller restart reconciles surviving tmux workers and restarts their runtime sidecars
- controller restart replays pending `recycle_worker_session` commands and settles them as `reconciled`
- stale completion rejected by fence/state checks
- list-workers / attach-worker target lookup
- operator debug surface for mailbox / heartbeat / tmux pane capture
- HUD shows `last_heartbeat_at` and `last_meaningful_change_at` for attempts
- startup happy path via `harness up`
- leader-first attach defaults when no worker id is provided
