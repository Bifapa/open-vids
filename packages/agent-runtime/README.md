# @hyperframes/agent-runtime

The OpenVids Agent Runtime: a **separate local Bun process** that owns project-scoped chats,
turns, checkpoints and the OMP-backed Director. It is never imported by the Studio browser bundle
or by `studio-server`/`cli`; those reach it over loopback HTTP through the gateway in
`packages/studio-server/src/agent/`.

```
Studio UI ──▶ /api/projects/:id/agent/*  (studio-server gateway, same origin)
          ──▶ http://127.0.0.1:<port>/v1/*  (this process, bearer token per launch)
          ──▶ AgentBackend port (src/backend.ts)
          ──▶ OMP adapter (src/omp/**)  ──▶ OMP SDK ──▶ providers
```

The wire model (chats, turns, messages, events, editor context, references) is owned by
`@hyperframes/agent-protocol`. Nothing outside `src/omp/` may import `@oh-my-pi/*`.

## Process and security

- Spawned lazily by the gateway on the first agent request; restarted lazily (with back-off) if it
  dies. Editing never depends on it: an unavailable runtime yields `503 runtime_unavailable` and the
  Studio chat panel shows "Agent unavailable".
- Binds `127.0.0.1` only. Every request needs `Authorization: Bearer <OPENVIDS_AGENT_TOKEN>`; the
  token is generated per launch and known only to the gateway and this process. The browser never
  sees the token or the port.
- The project is selected per request by gateway-set headers (`x-openvids-project-id`,
  `-project-dir`, `-studio-origin`). The runtime only ever touches the directory it is handed.
- Env: `OPENVIDS_AGENT_TOKEN` (required), `OPENVIDS_AGENT_PORT` (default `0`),
  `OPENVIDS_AGENT_PARENT_PID` (exit when that process disappears).
- Prints one stdout line, `{"openvids-agent":"listening","port":N,"protocolVersion":1}`.

## Persistence

`<projectDir>/.hyperframes/agent/chats/<chatId>/events.jsonl` is an append-only log of protocol
events; chat state is `foldChatEvents(log)`. It holds the main conversation and every delegated
run's thread (task message + reply, keyed by `runId`), so specialist views reopen after a restart.
`backend/` beside it is the Director's OMP session directory and `agents/<specialist>/` each
specialist's (resume keeps model context per agent); Jev sessions are ephemeral. `.hyperframes/` is
already excluded from project history, the file watcher and the project signature, so chat files are
never part of a checkpoint; the path guard also forbids it. A crash leaves a running turn (and its
runs) in the log; on load the runs and the turn are closed as `interrupted` and the checkpoint is
recovered from project history.

Global (per-user) agent settings — Director defaults, per-specialist defaults, Jev — live in
`OPENVIDS_AGENT_SETTINGS_DIR` (default `~/.openvids/agent`): `settings.json` and
`jev-credentials.json`, both mode 0600. The Jev API key is never returned by the API
(`apiKeyConfigured` only) and is handed to one ephemeral backend session at a time, in a private
in-memory credential store, so it never replaces the credentials other agents use.

## Multi-agent orchestration

- Fixed specialists (`editor`, `vision`, `motion`, `research`, `audio`), enabled per chat
  (`enabledAgents`, seeded from the global `enabledByDefault`). Per-chat `agentOverrides` replace the
  global model/thinking/allowed-models of one specialist.
- The Director gets runtime-implemented host tools (`src/agents/tools.ts`): `update_plan`
  (`plan.updated`), `delegate` / `wait_for_agents` / `message_agent` / `cancel_agent` (only when at
  least one specialist is enabled; `agent` is an enum of the enabled ones and is re-checked), and
  `jev` when Jev is usable. Specialists get only the tools below plus `jev`; Jev gets none — the
  hierarchy is one level and OMP's own task/subagent tools are never enabled.
- Routing (`src/agents/routing.ts`): a delegated task runs on the specialist's model unless the
  Director names one of its `allowedModels` (and it is authenticated); thinking may be lowered for a
  task, never raised. Violations are returned to the Director as tool errors.
- `src/agents/orchestrator.ts` runs one turn's delegated work: specialist runs are async (parallel
  across specialists, queued per specialist), Jev calls are synchronous for the caller. Every run
  shares the turn's abort signal and checkpoint. Steering goes to the Director; a pending
  `wait_for_agents` returns early so it can react. If the Director stops without collecting its
  runs it is re-prompted with their reports (at most 3 times). Before the checkpoint closes,
  `shutdown()` aborts unfinished runs and force-closes a session that does not stop within the grace
  period, so no run outlives its turn.

## Editing tools

Agents assemble and change videos through an OpenVids-owned capability layer, not by hand-editing
composition HTML. The runtime talks to Studio's editing service over loopback HTTP
(`src/editing/host.http.ts`, base `${studioOrigin}/api/projects/:id`): `editing/project`,
`editing/timeline`, `editing/apply` (atomic batch of `EditOperation`s), `editing/presets`,
`editing/probe`, plus the existing render routes (POST render → progress SSE → renders list →
probe). The wire contract is `packages/agent-protocol/src/editing.ts`. The service writes project
files; Studio's watcher reloads the timeline/preview live, and because the write happens while the
Director's transaction is open the history engine attributes it to the turn.

| Tool               | Director                     | Editor | Motion | Audio | Vision / Research | Jev |
| ------------------ | ---------------------------- | ------ | ------ | ----- | ----------------- | --- |
| `inspect_project`  | yes                          | yes    | yes    | yes   | yes               | no  |
| `inspect_timeline` | yes                          | yes    | yes    | yes   | yes               | no  |
| `browse_presets`   | yes                          | yes    | yes    | no    | yes               | no  |
| `edit_timeline`    | only if no Editor is enabled | yes    | yes    | yes   | no                | no  |
| `render_video`     | yes                          | yes    | no     | no    | no                | no  |

- `inspect_timeline` also reports the playhead, selection and active composition from the turn's
  `EditorContext` (captured when the user sent the message). A service refusal (`EditError`) or a
  malformed batch comes back as a tool error with its code, message and `operations[N]`.
- Each editing tool declares an `activity` label ("Inspecting the timeline", "Editing the timeline ·
  4 changes (add clip ×3, split)", "Browsing caption presets", "Rendering video"); the OMP adapter
  reports these as `tool.start` with a `label`, and `TurnEventWriter` shows each as its own row.
- Lifecycle guarantee (`src/editing/executor.ts`, `TurnRunner.finalize`): editing calls go to a
  per-turn executor bound to the turn's scope, editor context and abort signal. They are refused when
  no turn is running or it is finalizing. Before the checkpoint closes, the turn stops accepting
  calls, cancels running renders (`POST /render/:jobId/cancel`) and awaits every started call — an
  `apply` already sent is atomic on the service and is awaited, not cut off — so no editing write can
  land after the checkpoint transaction ends. Aborting the turn aborts in-flight edits and renders.
- `FakeEditingHost` (`src/testing`) is the in-memory host for tests; the runtime fixture wires it.

## Turns, checkpoints, concurrency

- One project-modifying turn at a time across all chats of a project (`chat_busy` / `project_busy`).
- One prompt = one turn = one checkpoint. A checkpoint is a project-history window attributed to the
  `Director` agent (existing engine behind Undo); revert undoes the turn's entries newest first with
  `keep-later-edits` or `just-this`. If no checkpoint can be opened the turn does not start.
- Checkpoint lifecycle: the transaction opens before the prompt reaches the Director and stays open
  for the whole turn. The runtime renews its lease (`POST …/history/window/:id/renew`) every 20 s;
  the lease is 2 min, so pauses of any length between writes stay in the same transaction, while a
  dead runtime's transaction ends by itself within 2 min instead of absorbing later edits. It closes
  only when the turn completes, fails, is aborted or is found interrupted. If a renewal reports the
  transaction gone, the turn is stopped (failed) so no write escapes Revert. If closing fails (Studio
  unreachable), the checkpoint stays `active` with its `transactionId`, and `recoverCheckpoints()`
  closes it and collects its entries before the next turn or on the next project load; a turn left
  `running` by a crash becomes `interrupted` the same way.
- Edits Studio itself makes during a turn stay the user's own history entries; edits from other
  apps during a turn are attributed to the turn (existing history-engine semantics).
- Tests import `@hyperframes/studio-server` through its `node` (dist) condition: rebuild it
  (`bun run build`) before running this package's tests after history-engine changes.

## Agents (OMP adapter)

Every agent (Director, specialists, Jev) is a restricted OMP session, not the user's personal OMP
environment: project file tools `read`, `grep`, `glob`/`find`, `edit`, `write` plus the runtime's
host tools for that agent (no bash/eval/web/MCP/LSP/task); host tools are passed as SDK custom tools
(`allowRestrictedCustomTools`); orchestration calls are not reported as project activity (the runtime
emits its own events), editing tools report labelled activity rows. Role
instructions (system prompts) come from the runtime (`src/agents/roles.ts`). Edit mode is pinned to
path-based `replace`; skills and rules are empty; only `<project>/AGENTS.md` (or `CLAUDE.md`) is
loaded as context. Providers, auth and model catalog come from the user's existing OMP setup
(`~/.omp/agent`); the runtime never writes to it. A `tool_call` guard (`src/omp/path-guard.ts`)
blocks every path outside the project or inside `.hyperframes/`, checks each target of OMP's `a;b` /
`a,b` / `a b` / brace path fan-out, and fails closed for `edit`/`write` calls whose target it cannot
read. The guard is bound through `preloadedPreparedExtensions`: OMP silently drops `extensions` when
`restrictToolNames` is set, so an inline `extensions` hook would not run.

## Develop

```bash
bun run --cwd packages/agent-runtime typecheck
bun run --cwd packages/agent-runtime test        # fake backend + fake checkpoint host, no network
OPENVIDS_AGENT_TOKEN=dev bun packages/agent-runtime/src/main.ts
```

Vitest resolves `@hyperframes/agent-protocol` through its `node` export condition, so build it first
(`bun run --cwd packages/agent-protocol build`; the root `bun run build` does).
