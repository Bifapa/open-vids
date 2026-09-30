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
- `render_video` refuses a composition longer than 180 s unless the turn's user messages (prompt and steering) explicitly
  ask for a render, an export or a video file (English or Russian; "don't render" does not count): the Director offers
  the render instead of starting a long one on its own (`src/editing/renderGuard.ts`). Short renders are unchanged.
- Lifecycle guarantee (`src/editing/executor.ts`, `TurnRunner.finalize`): editing calls go to a
  per-turn executor bound to the turn's scope, editor context and abort signal. They are refused when
  no turn is running or it is finalizing. Before the checkpoint closes, the turn stops accepting
  calls, cancels running renders (`POST /render/:jobId/cancel`) and awaits every started call — an
  `apply` already sent is atomic on the service and is awaited, not cut off — so no editing write can
  land after the checkpoint transaction ends. Aborting the turn aborts in-flight edits and renders.
- `FakeEditingHost` (`src/testing`) is the in-memory host for tests; the runtime fixture wires it.

## Long-form analysis tools

Long raw footage becomes durable, cached analysis artifacts and then a rough cut on the real timeline. The runtime talks
to Studio's analysis service over loopback HTTP
(`src/analysis/host.http.ts`, base `${studioOrigin}/api/projects/:id/analysis`): `jobs` (start/join,
poll, cancel), `overview`, `transcript`, `artifact`, `segments`, `vision`, `frames`, `cuts`
(plan/list/get). The wire contract is `packages/agent-protocol/src/analysis.ts`; artifacts live
in `<project>/.hyperframes/analysis` outside project history, so Revert never touches the cache.

| tool                                                                                    | Director                          | Editor | Vision | Motion/Audio/Research |
| --------------------------------------------------------------------------------------- | --------------------------------- | ------ | ------ | --------------------- |
| `analyze_media` (starts/joins the job, waits, returns the compact overview)             | yes                               | yes    | yes    | no                    |
| `read_analysis` (overview or one section), `read_transcript` (paged; marks take issues) | yes                               | yes    | yes    | yes                   |
| `save_segments`                                                                         | yes                               | yes    | no     | no                    |
| `inspect_frames` (JPEGs to the model), `save_vision_notes`                              | only if Vision is not enabled     | no     | yes    | no                    |
| `plan_cut`, `build_rough_cut`                                                           | only if the Editor is not enabled | yes    | no     | no                    |

- `build_rough_cut` reads the plan and the timeline, then sends ONE atomic `editing/apply` batch with
  `baseVersion`: `remove_clip {clips}` for the clips **of the target track** that play the plan's source (the previous
  cut; clips on other tracks — cutaways, B-roll, graphics, manual additions — are kept and reported as "kept N clips on
  other tracks; their positions refer to the previous cut"), `add_sequence` of the plan's ranges (`edgeFade` 0.02,
  stamped with provenance `{cut: plan.id, turn}`) and `set_composition` to the cut length. With the optional
  `captions` (a caption preset name) the cues come from the transcript's words through the plan's placed ranges
  (`captionCuesFromWords`) and an `apply_captions` joins the same batch. It reports the clip count, the length and the
  timeline ranges where kept material overlaps black/frozen picture. Whether a plan is on the timeline is derived from
  the clips stamped with its id (`CutPlanSummary.applied = {composition, clips}`), so a reverted cut is never shown as
  applied. Because it goes through the editing service inside the turn's transaction, Revert undoes it.
- `inspect_frames` returns `HostToolResult.images` (base64 JPEG). The OMP adapter maps them to OMP image
  content after the text part (`src/omp/tool-content.ts`); nothing outside `src/omp/` knows OMP.
- A job is awaited by polling `GET jobs/:id` (750 ms); aborting the call cancels the job on the service so
  ffmpeg and the recognizer never outlive the turn. Analysis is cached per file, so a follow-up turn's
  `analyze_media` returns immediately.
- Lifecycle guarantee (`src/analysis/executor.ts`, `TurnRunner.finalize`): like editing, analysis calls go
  to a per-turn executor bound to the turn's abort signal. They are refused when no turn is running or it
  is finalizing. Before the checkpoint closes, the turn stops accepting calls, cancels running jobs and
  awaits every started call — a rough-cut batch already sent is awaited to its end.
- Failures come back as `code: message` tool errors (`AnalysisToolError`; service codes plus `aborted` and
  `unavailable` for transport failures). A stage the machine cannot run (no speech recognizer) is reported
  in the overview as `unavailable` with its reason, not as a failure.
- Role instructions (`src/agents/roles.ts`) hold the pipeline: the Director runs `analyze_media`, delegates
  Vision (only the not-yet-inspected targets) and Editor (semantic segmentation) in parallel, then the
  Editor plans, builds, checks the timeline, runs a pacing pass and rebuilds. Follow-up turns reuse the
  cached segments, vision notes and cut plans.
- Each analysis tool declares an `activity` label ("Analyzing raw-talk.mp4", "Reading the transcript",
  "Saving 14 segments", "Looking at 8 frames", "Saving 3 visual notes", "Planning the cut · rough cut",
  "Building the rough cut · 143 clips").
- `FakeAnalysisHost` (`src/testing`) is the in-memory host for tests (jobs that stay running until a gate
  opens, recorded requests); the runtime fixture wires it.

## Story Mode

The project's plan of the video is the Story Graph (`<project>/.hyperframes/story/graph.json`; contract in
`packages/agent-protocol/src/story.ts`): chapters in a narrative sequence, material nodes (video, picture, music,
motion preset, missing asset) attached to them, locks, and authorship (what the user set by hand, created or removed).
The user reshapes it in Studio's Story workspace; agents change it only through Studio's story service (validated,
locks and user decisions enforced), never with file tools (the path guard forbids `.hyperframes/`). The runtime talks
to it over loopback HTTP (`src/story/host.http.ts`, base `${studioOrigin}/api/projects/:id/story`): `GET` (view),
`POST edit` (an agent's atomic `StoryOperation` batch), `POST build` (compile the graph into the timeline).

- **Modes.** A chat has a persisted `activeMode` (`normal` | `story`, `PATCH` chat). A turn's mode is `story` when it
  runs a `storyAction` (`review`, `build`; sent by Studio's "Review with AI" / "Build Story"), else the request's
  `mode`, else the chat's `activeMode`. `TurnSummary.mode` / `storyAction` record it. Review and Build are ordinary
  checkpointed turns, so "Revert this turn" restores the graph file and the timeline together.
- **Prompt.** Every story-mode turn prompt carries a `<story-graph>` block (the `read_story` rendering as of the
  turn's start, including "User decisions" and locks) and a `<story-mode action="plan|review|build">` block with the
  rules of the action (`src/story/prompt.ts`). The Director's role text holds the standing rules (user decisions
  outrank the AI's earlier plan, locked nodes never change, never restore the previous variant on review).
- **Tools** (`src/story/tools.ts`): `read_story` (Director and every specialist, any mode), `edit_story` (Director, story
  plan/review turns only), `build_story` (build turns only: the Editor when enabled, else the Director). Service
  refusals (`locked`, `user_decision`, `conflict`, `unknown_node`, …) come back as tool errors `code (operations[N]): message`.
- **No timeline writes outside a build.** In a story-mode turn without `build`, nobody gets `edit_timeline`,
  `render_video` or `build_rough_cut` (analysis tools stay). A build turn keeps the normal editing tools plus `build_story`;
  the graph is frozen while it compiles (no `edit_story`).
- **Lifecycle.** Like editing and analysis, story calls go to a per-turn executor (`src/story/executor.ts`): refused
  when no turn is running or it is finalizing; `TurnRunner.finalize` awaits every started edit/build (atomic on the
  service) before the checkpoint closes, so no story write can escape Revert.
- `FakeStoryHost` (`src/testing`) is the in-memory host for tests (gates to hold an edit/build in flight, recorded
  requests and signals); the runtime fixture wires it.

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
