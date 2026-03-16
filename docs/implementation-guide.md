# Implementation Guide

## Initial slice

Build and verify in this order:
1. SQLite schema bootstrap
2. controller daemon startup
3. worker/admin Unix socket listeners
4. worker registration and heartbeat
5. attempt assignment with fence verification
6. complete/fail flow
7. admin-driven cancel flow with stale mutation rejection
8. tmux adapter and live-session recycling
9. rehydration packet write on assignment and recycle
10. validation decision recording after attempt completion
11. operator-facing HUD rendering
12. tmux HUD pane launcher
13. worker mailbox + heartbeat sidecar snapshot

## Operator surface

- `harness start <session-id>`
- `harness stop <session-id>`
- `harness bootstrap <session-id>`
- `harness admin <method> <session-id> ...`
- `harness list-workers <session-id>`
- `harness attach-worker <session-id> <worker-instance-id> [--window <n>] [--pane <n>] [--print-target]`
- `harness show-mailbox <session-id> <worker-instance-id>`
- `harness show-heartbeat <session-id> <worker-instance-id>`
- `harness tail-worker <session-id> <worker-instance-id> [--window <n>] [--pane <n>] [--lines <n>]`
- `harness hud <session-id> [--watch] [--interval <ms>]`
- `harness hud-pane <session-id> [--interval <ms>]`
- `harness sidecar worker-runtime <session-id> <worker-instance-id> <generation> [--interval <ms>]`
- `harness admin read-memory <session-id> <worker-instance-id>`
- `harness admin append-memory <session-id> <worker-instance-id> <text...>`
- `harness admin replace-memory <session-id> <worker-instance-id> <text...>`
- `harness admin show-packet <session-id> <worker-instance-id>`

## Current runtime model

- persistent worker identity
- replaceable live session handle
- sequential attempts per worker
- controller-driven assignment
- no worker-side pull claim flow
- detached tmux session per live worker session in the current adapter
- controller restart reconciles surviving tmux runtimes and reattaches runtime sidecars
- controller restart also settles pending `launch_worker` / `cancel_attempt` / `recycle_worker_session` commands through conservative replay or reconcile
- worker bootstrap prompt generated into `runtime/*.prompt.txt`
- current adapter auto-dismisses the Codex workspace trust prompt
- mailbox sidecar writes `runtime/mailbox/<worker>.json`
- sidecar heartbeat writes `runtime/heartbeat/<worker>.json`
- worker memory lives under `memory/<worker>.md` by default and is embedded into the rehydration packet as an excerpt
- workers can explicitly enter `blocked` state and clear it by sending a later heartbeat

## Tier 0 tables

- sessions
- worker_instances
- tasks
- attempts
- events
- controller_commands

## Tier 1 tables

- messages
- artifacts
- validations

## Later tables

- secret_grants
- effect_log
