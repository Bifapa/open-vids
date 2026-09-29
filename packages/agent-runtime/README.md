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
  `jev` when Jev is usable. Specialists get only `jev`; Jev gets none — the hierarchy is one level
  and OMP's own task/subagent tools are never enabled.
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
(`allowRestrictedCustomTools`) and their calls are not reported as project activity. Role
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
