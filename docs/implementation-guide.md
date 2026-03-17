# Implementation Guide

## Scope

This guide tracks the current Codex-first v1 slice.

Priority order:
1. control-plane truth in the database
2. fenced worker mutation and durable state
3. restart/reconcile recovery
4. leader-first operator flow
5. advanced features later

Out of current v1 scope:
- secret grants
- generalized lease framework
- environment fingerprint / effect log
- broader multi-runtime generalization

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

## Adapter contract

Current reality:
- worker runtime is currently backed by detached tmux sessions
- Codex bootstrap is the primary runtime path today

Required v1 contract:
- authority remains in controller + database state
- `assignment_fence` remains the mutation guard
- restart/reconcile remains valid even if pane visibility is lost
- tmux visibility is operator convenience, not runtime truth

## Minimal typed config

Keep correctness-critical config small in v1:
- `runtime_target`
- `authority_root_policy`
- `capability_defaults`
- `leader_ux_mode`

Do not expand this into a plugin ABI or generalized platform surface yet.
Current implementation now validates `config_path` for `create_session` and uses `capability_defaults` as the launch-time fallback profile when `launch_worker` omits an explicit capability payload.

## Operator surface

Leader-first means composing the existing worker-centric primitives into an operator flow:
- `harness up <session-id> [--config <path>]`
- `harness hud <session-id>`
- `harness attach-worker <session-id>` (defaults to the leader worker)
- `harness start <session-id>`
- `harness stop <session-id>`
- `harness bootstrap <session-id>`
- `harness admin <method> <session-id> ...`
- `harness list-workers <session-id>`
- `harness attach-worker <session-id> [worker-instance-id] [--window <n>] [--pane <n>] [--print-target]`
- `harness show-mailbox <session-id> [worker-instance-id]`
- `harness show-heartbeat <session-id> [worker-instance-id]`
- `harness tail-worker <session-id> [worker-instance-id] [--window <n>] [--pane <n>] [--lines <n>]`
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
- launch failure settles `launch_worker` as `aborted/launch_failed` instead of leaving a zombie pending command
- worker bootstrap prompt generated into `runtime/*.prompt.txt`
- current adapter auto-dismisses the Codex workspace trust prompt
- admin and worker RPC calls require auth tokens carried by the CLI wrapper
- mailbox sidecar writes `runtime/mailbox/<worker>.json`
- mailbox delivery uses `poll_messages -> leased` followed by `ack_messages -> delivered`
- sidecar heartbeat writes `runtime/heartbeat/<worker>.json`
- worker memory lives under `memory/<worker>.md` by default and is embedded into the rehydration packet as an excerpt
- workers can explicitly enter `blocked` state and clear it by sending a later heartbeat
- assignment checks task `required_capabilities` against the worker capability profile before creating a new attempt
- worker launch validates and normalizes `capability_profile` before persisting it and mapping it into runtime env
- session config is validated through a narrow JSON loader and can provide default worker capabilities

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
