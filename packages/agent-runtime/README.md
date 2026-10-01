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

Global (per-user) agent settings — Director defaults, per-specialist defaults, Jev, Autonomy — live in
`OPENVIDS_AGENT_SETTINGS_DIR` (default `~/.openvids/agent`): `settings.json`, `jev-credentials.json` and
`provider-credentials.json`, all mode 0600 (the directory 0700), re-read from disk on every access so several runtime
processes share them. The Jev API key is never returned by the API
(`apiKeyConfigured` only) and is handed to one ephemeral backend session at a time, in a private
in-memory credential store, so it never replaces the credentials other agents use. The global Execution Quality default
(see Render QA and Execution Quality) and the Autonomy group (see Autonomy) are part of `settings.json`; a file
from before either existed reads with its defaults and gains it on the next write. The per-provider API keys in
`provider-credentials.json` are described under Providers and credentials.

## Providers and credentials

The model catalog and the credentials come from the user's OMP setup (`~/.omp/agent`, read-only for OpenVids) **plus the
API keys the user enters in OpenVids**, so a user with no OMP login can still use the agents.

- **Storage.** `provider-credentials.json` in the settings directory: `{"version":1,"apiKeys":{"<provider>":"<key>"}}`,
  mode 0600. A key is never returned by any route, never logged and never put into an error message.
- **Applying.** The OMP adapter applies the stored keys as the SDK's _runtime key overrides_
  (`AuthStorage.keys.setRuntime`). That is an in-memory `Map` in the SDK: nothing is written to `~/.omp/agent` (checked in
  the SDK source and by scanning a scratch home after setting a key). The override wins over every OMP credential of the
  same provider, so a key saved here replaces the OMP login for that provider until it is removed. The catalog, every
  agent session and Jev's provider-login mode use it (their credential layer is the shared one), and a key change takes
  effect without a restart: the backend re-reads the file on every catalog/provider/session access (one small file),
  applies the difference and rebuilds the catalog, so a key saved by the desktop's runtime reaches a project runtime too.
  (Jev's own API-key mode still uses a private per-session store.) The SDK keeps its own files in the OMP agent
  directory as it always did (`agent.db`, the `models.db` catalog cache, logs) — they hold no OpenVids key.
- **Provider list** (`ProviderInfo`): `id`, `name` (plain display name), `authenticated`, `status`
  (`connected` | `not_configured` | `error` | `signin_required`), `credentialSource` (`omp` | `api-key` | `oauth` | null), `error`
  (a one-line reason), `modelCount`, `keyless` (a local provider that needs no credential) and `verified` (a live model
  list was fetched with the credential in this process). Status is derived in `src/omp/provider-status.ts` from what the
  SDK can tell: the winning layer of its credential cascade (`keys.source`), the registry's per-provider discovery state,
  and the tombstones of torn-down OAuth credentials (`credentials.listDisabled`). `signin_required` is reported only
  when such a tombstone exists (an OAuth refresh failed definitively) and nothing else authenticates the provider; a
  logout (`deleted by user`) is not one, and an expired token that has not been refreshed yet is invisible. `error` means
  the credential exists but the provider's live model list failed: the SDK swallows HTTP errors of built-in providers, so
  a rejected key, no network and an outage look alike, which is why it is raised for OMP's own credentials only with an
  explicit message or a 401/403 from a models.yml provider, and also for a key stored in OpenVids (the key the user just
  typed) when the listing failed silently. While a refresh is running nothing is concluded. The models of an `error`
  provider stay usable.
- **Routes** (all global: token only, no project): `GET /v1/providers` → `{providers, syncedAt}`;
  `POST /v1/providers/refresh` re-reads OMP's credentials and the stored keys and re-fetches every provider's live model
  list; `POST /v1/providers/:provider/api-key` with `{"apiKey": string | null}` saves or removes the key, then refreshes
  that provider (a new key is checked live — it can take up to the SDK's discovery timeout when the provider is
  unreachable; a removal does not touch the network). Both answer with the fresh provider list. An unknown provider
  (setting) or an invalid id is `400 invalid_request`. `POST /v1/settings/jev/test` is global too: it runs in an empty
  scratch directory, so it needs no project.

### In-app OAuth sign-in

A provider that offers a sign-in (`ProviderInfo.oauth`, not null) can be signed in to from the app. The runtime drives the
SDK's own login (`AuthStorage.oauth.login`) and **never opens a browser**: the UI or the desktop shell opens the URL the
state carries.

- **Where it is stored.** OpenVids' own `auth.db` (SQLite, `<settings dir>/auth.db`, directory 0700, files 0600, same
  schema as OMP's), never `~/.omp/agent`. The SDK's `AuthStorage` takes one credential store, so `src/omp/layered-auth-store.ts`
  presents two as one: OMP's `agent.db` and OpenVids' `auth.db`. Reads show both (a provider with an OpenVids sign-in is
  shown with its OpenVids credentials only, so the sign-in replaces OMP's login for that provider until it is signed out).
  New credentials, sign-out and everything about an OpenVids row — **token refresh**, disabling after a failed refresh,
  refresh leases, rate-limit blocks — go to `auth.db` (ids of OpenVids rows are shifted by 10^12 so the two never collide).
  The SDK's cache rows also live there. `credentialSource: "oauth"` marks a provider whose credential is such a sign-in
  (an API key stored in OpenVids still wins over it). Sign-out blanks the tokens in the row and retires it; closing the
  runtime checkpoints the write-ahead log. Providers are not told: a grant is revoked at the provider's account page.
- **What still writes to OMP's database.** The layering never writes an OpenVids sign-in there. But a credential **OMP**
  owns is still refreshed by the SDK in OMP's database, as it was before OpenVids layered anything (and as the SDK's
  startup housekeeping does): OAuth refresh tokens rotate, so a refresh OMP's database never saw would invalidate the user's
  OMP login. That is the one remaining write, and only for a login the user made with OMP.
- **Both runtimes.** The home and project runtimes open the same `auth.db`; each polls both databases for another process's
  commit (`pollExternalChanges`) when providers are listed and when a key is resolved, so a sign-in done in one is used by
  the other without a restart. A sign-in's state (the polling surface) lives in the runtime that started it. Refresh of the
  same credential by two runtimes is fenced by the SDK's refresh leases, which live in `auth.db` for OpenVids rows.
- **When it is off.** `oauth` is null for every provider, and the start route answers 400, when OMP keeps its credentials in an
  auth broker (`OMP_AUTH_BROKER_URL` or a `broker` entry in OMP's `config.yml`), when `XDG_DATA_HOME` is set (OMP's database
  location is then not derivable), or when the layering could not be set up. OMP's credentials are then used exactly as before.
- **Routes** (global, token only; start + poll, nothing is held open):
  `POST /v1/providers/:provider/oauth/login` (optional body `{"flow":"browser"|"device"|"paste"}`) starts a sign-in, or returns
  the one already running for that provider, and answers within 8 s with an `OAuthLoginState` (as soon as there is a URL or a
  prompt to show; otherwise `pending` with `authUrl: null` and the UI polls). `GET /v1/oauth/logins/:id` polls.
  `POST /v1/oauth/logins/:id/input` with `{"text"}` answers the prompt (a pasted code or redirect URL; never echoed).
  `POST /v1/oauth/logins/:id/cancel` stops it (idempotent). `POST /v1/providers/:provider/oauth/logout` removes the OpenVids
  sign-in and answers with the provider list (409 when OpenVids holds none: what OMP holds cannot be removed here).
  Errors: 400 `invalid_request` (bad id or body, no sign-in for that provider, unsupported setup), 404 `login_not_found`,
  409 `invalid_request` (nothing is waiting for an answer, nothing to sign out, too many sign-ins).
- **States** (`OAuthLoginState.status`): `pending` (the user must act, or the runtime is working; an optional paste prompt
  may be present), `needs_input` (a required prompt, e.g. GitHub Enterprise domain), `succeeded`, `failed` (`error`, one
  line, tokens and query strings removed), `cancelled`, `expired`. A sign-in not finished in 10 minutes expires; a finished one
  stays pollable for 10 minutes. Cancel, expiry and shutdown abort the SDK flow, whose `finally` closes the callback
  listener; they wait at most 3 s for it. `dispose()` cancels every sign-in.
- **Flows** (`ProviderOAuthInfo.flows`, the first is the default; read from the SDK's auth policies in
  `src/omp/oauth-support.ts`). `browser`: the SDK listens on loopback (`127.0.0.1` and `::1` only) on the provider's port and
  the user approves in the browser; if that port is taken it falls back to a random one, except where the provider insists
  on its registered redirect (`fixedPort`; then a taken port is a failure with a clear message). Ports: `anthropic` 54545,
  `openai-codex` 1455 (fixed; the Codex CLI uses the same port, hence its `device` alternative), `openrouter` 54549,
  `google-gemini-cli` 8085, `google-antigravity` 51121, `devin` 59653, `gitlab-duo` 8080, `stencil` 54547. `device`: the user
  opens `authUrl` and enters `deviceCode` (also in `instructions`) while the runtime polls: `github-copilot` (asks the
  Enterprise domain first), `kimi-code`, `xai-oauth`, `muse-code`, `kilo`, `cursor`, `openai-codex` (second flow). `paste`:
  `gitlab-duo-agent`, the user pastes the code or redirect URL back. Providers whose login is a pasted key, a prompt-driven
  account/e-mail flow, needs a host-owned browser session or an OS URL-scheme handler (`zai`, `perplexity`, the Alibaba,
  Xiaomi and Cloudflare logins) are not offered.

## Autonomy

`AgentSettings.autonomy` (`PATCH /v1/settings` with a partial `autonomy` group) holds three values, defaults `plan`, `true`,
`true`:

- `defaultIntent` (`plan` | `edit` | `ask`): the Mode chip a new chat's composer starts with. The runtime only stores it;
  turns still use the intent the request or chat carries.
- `askBeforeLockedEdits`: locks are never overridden — the editing and story services refuse a change to a locked or
  hand-set item (and the file-tool guard refuses to rewrite a locked clip) whatever this says. The setting decides what the
  agent does about it. On: the Director's `<team>` block, every delegated task (`<autonomy>`) and every such refusal
  (`dispatchTool`: `locked` / `user_decision` tool errors; the OMP guard's refusal for `edit`/`write` of a locked clip) tell
  it to stop work on that item, say what it wanted to change and why, and wait for the user. Off: the same places tell it to
  leave the item alone, carry on and list what it left untouched in the final reply. It is an instruction to the model (the
  refusal itself is enforced); it is read at the start of the turn.
- `askBeforeDownloads`: **enforced** in the research executor. On: `import_asset` and `read_website` with `save` are refused
  (before Studio is asked) until the user approved in the turn — the Story workspace's "Find missing material"
  (`storyAction: "resolve"`), or a message of that turn (prompt or steering; never assistant text or tool results) that
  tells the agents to download/import/fetch/grab, says yes/ok/go ahead, or says add/use/take it (English and Russian, a
  negation such as "don't download" cancels it: `approvesDownload` in `src/autonomy.ts`, a deterministic text rule like the
  long-render guard). Approval does not carry over to later turns. Searching, inspecting pages and reading a site's style
  stay free. Research's task and the Director's brief state the rule and ask Research to report what it found and wait. Off:
  imports run as before.

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
`POST edit` (an agent's atomic `StoryOperation` batch), `POST build` (compile the whole graph into the timeline),
`POST rebuild` (Rebuild affected sections: only what the graph changed since the last build, against the service's
sync ledger).

- **Modes.** A chat has a persisted `activeMode` (`normal` | `story`, `PATCH` chat). A turn's mode is `story` when it
  runs a `storyAction` (`review`, `build`, `rebuild`, `resolve`; sent by Studio's "Review with AI" / "Build Story" /
  "Rebuild affected" / "Find missing material"), else the request's `mode`, else the chat's `activeMode`.
  `TurnSummary.mode` / `storyAction` /
  `storyOptions` record it. All are ordinary checkpointed turns, so "Revert this turn" restores the graph, the sync
  ledger and the timeline together.
- **User options.** `StartTurnRequest.storyOptions` carries the user's choices from the Story workspace: for `rebuild`
  `chapters` (scope), `manualEdits` (`keep` | `replace`) and `allowLocked`; for `build` only `allowLocked`. The executor
  merges them into the service request; the model passes only `baseVersion` / `dryRun`, so it can never unlock a
  chapter or replace the user's edited material on its own. For `resolve`, `missing` limits the Missing Asset nodes the
  turn may resolve (enforced by the research executor, see Research).
- **Prompt.** Every story-mode turn prompt carries a `<story-graph>` block (the `read_story` rendering as of the
  turn's start, including "User decisions", locks and the "Timeline sync" section) and a
  `<story-mode action="plan|review|build|rebuild|resolve">` block with the rules of the action and the user's options
  (`src/story/prompt.ts`). The Director's role text holds the standing rules (user decisions outrank the AI's earlier
  plan, locked nodes never change, never restore the previous variant on review).
- **Tools** (`src/story/tools.ts`): `read_story` (Director and every specialist, any mode), `edit_story` (Director, story
  plan/review turns only), `build_story` (build turns only: the Editor when enabled, else the Director),
  `rebuild_story` (rebuild turns only, the Director). Service refusals (`locked`, `user_decision`, `conflict`,
  `unknown_node`, `unsupported`, …) come back as tool errors `code (operations[N]): message`.
- **No timeline writes outside a build.** In a story-mode turn without `build`, nobody gets `edit_timeline`,
  `render_video` or `build_rough_cut` (analysis tools stay); a rebuild turn's only write is `rebuild_story`. A build turn
  keeps the normal editing tools plus `build_story`; the graph is frozen while it compiles (no `edit_story`).
- **Edit attribution.** `edit_timeline` requests carry the turn id (set by the executor, never the model), so the
  editing service stamps the clips an agent changes (`data-ov-ai-edit`) and Story sync can tell a later AI edit of
  generated material from the user's.
- **Lifecycle.** Like editing and analysis, story calls go to a per-turn executor (`src/story/executor.ts`): refused
  when no turn is running or it is finalizing; `TurnRunner.finalize` awaits every started edit/build (atomic on the
  service) before the checkpoint closes, so no story write can escape Revert.
- `FakeStoryHost` (`src/testing`) is the in-memory host for tests (gates to hold an edit/build in flight, recorded
  requests and signals); the runtime fixture wires it.

## Research

Research is the only specialist that can look for material outside the project. The Studio server (Milestone 7; contract
in `packages/agent-protocol/src/research.ts`) performs every search, page read and download, keeps the user's global
Asset Search policy (`trusted` = only the enabled trusted sources, `any` = any public page, trusted sources first) and
records a provenance entry for every import; the runtime reaches it over loopback HTTP (`src/research/host.http.ts`:
`${studioOrigin}/api/research/policy` for the global policy and `${studioOrigin}/api/projects/:id/research/{search,
inspect,import,resolve,sources,export-check}` for the project). Agents have no network tools of their own (the OMP path
guard rejects URLs), so the **policy enforcement point is the Studio server**: a request the policy does not allow is
refused there with `blocked_by_policy`, and no request the runtime sends carries a policy mode. Provenance fields
(URL, source, author, license and its confidence, retrieval time, agent, model) come from the source and the server,
never from model-supplied text.

| Tool                                                      | Who                        | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_assets {query, mediaKind, sources?, limit?}`      | Research                   | Candidates from the allowed sources: id, title, source (trusted or web), license name + status + confidence, author, size, page URL, `inProject`; per-source errors and `blocked` entries.                                                                                                                                                                                                                                                                                                                                     |
| `inspect_url {url, mediaKind?}`                           | Research                   | Reads one page or media URL and lists the media it offers (HLS/DASH and protected streams are refused by the server).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `import_asset {candidate \| url, name?, resolveMissing?}` | Research                   | Downloads into `assets/research/`, records provenance, detects duplicates (same URL or same content: reused, not downloaded again), optionally resolves a Missing Asset node in the same step.                                                                                                                                                                                                                                                                                                                                 |
| `resolve_missing_asset {missing, asset}`                  | Research                   | Resolves a Missing Asset node with a file already in the project.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `read_sources {}`                                         | Research, Director         | The project's Sources/Licenses: records, where they are used, issues, credits owed.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `read_website {url, save?}`                               | Director, Motion, Research | Opens one page of a website **the user linked in this chat** and extracts its visual style (palette with roles, fonts and how to load them, type scale, radii, shadows, buttons, design tokens, motion character, logo, headings) as a compact text summary plus two screenshots as images (`HostToolImage`). With `save: true` the screenshots, logo and self-hosted fonts the page uses are written to `assets/web/<host>/` with provenance (origin "website", license unknown). Activity row: `inspect` · "Reading <host>". |

- **Websites** (`read_website`, `src/research/{tools,executor,linkedSites,formatWebsite}.ts`; Studio route
  `POST /api/projects/:id/research/website`, rendered by a headless-Chrome CLI child in the server). The runtime owns the
  **scope**: a URL is allowed only when its registrable domain (`www.` and subdomains included, `linkedSites`/
  `isLinkedSite`) was linked by the user — in the chat's first prompt, a later message or a steering message (`TurnRunner.userTexts`
  reads user-role messages only; assistant text, search results and page contents never count). Anything else is refused
  before Studio is asked, with the instruction to ask the user for the link. The server enforces the user's switch
  (Settings → Asset Search → Websites, `policy.websites.readLinkedPages`, refusal `blocked_by_policy`, surfaced to the model as
  a clear tool result), http(s) only and public addresses only. `save` is a write (cancellable request id, awaited before the
  checkpoint closes like an import) and is refused in Plan and Ask turns; a plain read is allowed there. `turnId`, `agent`
  and `model` are set by the executor. Unlike the asset tools, `read_website` does not need Research to be enabled or the
  policy to be readable: the Director, and Motion/Research when they are in the chat's team, get it whenever a research host
  exists (`ToolAvailability.websites`); a Story build/rebuild turn offers none.
- **Availability** (`researchToolsFor`, `src/research/tools.ts`): nobody gets the other research tools when Research is not
  enabled in the chat or when the policy could not be read at the start of the turn (the runtime then fails closed and
  the Director says so); a Story build or rebuild turn offers none; Jev and the other specialists never do; the Director
  only has `read_sources`. `TurnResearch.execute` re-checks the caller against the same function, so the Director
  cannot reach the search/import tools under any name.
- **What the runtime owns.** `turnId`, `agent: "research"` and `model` (the model of the Research run, `provider/modelId`)
  are set by `src/research/executor.ts` on every import; whatever the model sends for them, or for a policy mode, is
  dropped. In a `resolve` turn with `storyOptions.missing`, `resolveMissing` / `resolve_missing_asset.missing` outside
  that list are refused by the executor.
- **Prompt.** At the start of a turn (when Research is enabled) the runtime reads the policy: the Director's `<team>` block
  states the mode and the number of enabled trusted sources (or that Research is disabled/unavailable and the user has to
  enable it), and every task delegated to Research carries an `<asset-search-policy>` block with the mode, the enabled
  sources (id, name, kinds, license note) and the rules (stay within the policy, prefer clear > attribution > unknown
  licenses, match the node's need/kind/`neededDuration`, import only what will be used, resolve with `resolveMissing`,
  report source + license per asset, never invent license information) (`src/research/prompt.ts`).
- **Resolve turns** (`storyAction: "resolve"`, Studio's "Find missing material"; `storyOptions.missing` limits the nodes):
  a checkpointed story-mode turn whose `<story-mode action="resolve">` block lists the unlocked Missing Asset nodes in
  scope. The Director delegates Research (batches of up to 4 nodes), nobody edits the story, builds or writes the
  timeline; Research has `read_story` plus the research tools. Without Research the Director does nothing and says why.
  Afterwards the Director tells the user to Build Story / Rebuild affected sections.
- **Export licenses.** After a successful `render_video`, `TurnEditing` calls `export-check` for the composition and appends
  the license warnings and credits to the tool result; the check never blocks, and a failed check is only noted.
- **Lifecycle.** Like the other executors, research calls go to a per-turn `TurnResearch` (refused when no turn is running
  or it is finalizing); `TurnRunner.finalize` awaits every started import/resolution (they write project files) before the
  checkpoint closes, so a turn's asset, provenance record and Story resolution are one revertable unit. The download
  cache sits outside history, so re-importing after a revert does not hit the network. Imports may take long (download +
  transcode): the HTTP host waits up to 15 minutes.
- **Stop during a write.** Every import/resolve carries a runtime-generated `requestId`. On abort (Stop, finalize) or
  timeout the host does not drop the connection: it sends `POST …/research/requests/:requestId/cancel` and keeps
  awaiting the original answer for up to 30 s. Studio decides at one synchronous commit point — cancelled before it, the
  request answers `cancelled` and nothing is written; once the commit started it finishes, and the result is returned
  because the write happened. A write that neither answers nor was acknowledged as cancelled fails `write_unsettled`;
  `TurnResearch.shutdown()` returns those as `unsettledWrites` and the turn's final message tells the user that such a
  file is not part of the checkpoint.
- `FakeResearchHost` (`src/testing`) is the in-memory host for tests (`importGate` holds an import in flight, recorded
  requests and signals); the runtime fixture wires it.

## Render QA and Execution Quality

The agent does not treat a job as done after its first render. When a turn changed the project, the runtime renders a
preview, checks the **rendered file**, has Vision review frames of it, stores a durable report, and lets the Director
delegate corrections — within a bounded number of passes. The Studio server (contract in
`packages/agent-protocol/src/qa.ts`) owns everything that needs the project or the render (the project fingerprint, the
deterministic checks, frame extraction, the reports in `<project>/.hyperframes/qa/`); the runtime reaches it over loopback
HTTP (`src/qa/host.http.ts`: `${studioOrigin}/api/projects/:id/qa/{state,check,frames,reports}`) and owns the loop and
Vision's review.

**Execution Quality** is the orchestration budget of a turn: `fast` | `balanced` (default) | `best` | `custom`
(`ExecutionBudget`: `qaPasses` 0–5, `qaFramesPerMinute`, `qaMaxFrames`, `critiqueRounds`, `analysisFramesPerSource`,
`researchCandidates`, `specialistThinking`). The global default lives in `settings.json` (`executionQuality`; a file from
before it existed reads as Balanced and gains it on the next write), a chat may override it (`PATCH` chat
`executionQuality`, `null` returns to the global default), and the turn records what it ran with
(`TurnSummary.execution = {preset, budget}`, resolved once at turn start by `resolveExecutionBudget`, custom budgets
clamped to their ranges). The Director's `<team>` block states the preset and the QA budget. Every field is **enforced**,
not suggested:

- `specialistThinking` → `applyThinkingPolicy` on every delegated specialist run (after routing) and on the Vision QA run:
  `economy` caps at `low`, `thorough` raises to at least `high`, `configured` leaves it alone.
- `researchCandidates` → `search_assets.limit` defaults to it and is clamped to it (`src/research/tools.ts`); the
  `<asset-search-policy>` block tells Research.
- `analysisFramesPerSource` → `TurnAnalysis` refuses `inspect_frames` calls that would extract more distinct frames per
  source in the turn (the refusal names the budget and what is left; a time already inspected is free).
- `qaMaxFrames`, `critiqueRounds`, 12 frames per call → `TurnQa` (`src/qa/executor.ts`) on Vision's `inspect_render`;
  `qaFramesPerMinute` / `qaMaxFrames` also go to the service to plan the frames Vision gets.

**The loop** (`src/qa/loop.ts`, run by `TurnRunner` after the Director and its follow-ups finished). QA runs only when the
Director's work completed, the turn may write the timeline (normal turns and story `build` turns; a story `rebuild` turn
is checked but report-only — no correction: only `rebuild_story` may write there; story review/resolve turns are never
checked) and either the project fingerprint differs from the one at turn start (`QaHost.state`) or the turn rendered the
main composition (an export request on an unchanged project still gets its render checked). With `qaPasses` 0 the turn
records `skipped` ("Render QA is off") when the project changed. A composition over 180 s is not rendered unless the user
asked for a render in this turn (→ `skipped` with the reason). Pass _k_ of _N_:

1. **Render** a preview (`draft`; when the user asked for a render, the quality of the Director's last `render_video`, else
   `standard`, so the last QA render is the deliverable; a re-render after a correction keeps the quality of the render it
   replaces). Pass 1 reuses the Director's own render of the same composition when the project had the same fingerprint
   before that render started as when QA starts (`TurnEditing.lastRender`). A failed render is stored as a report
   (`renderError` + a fixable `render_failed` issue owned by the Editor) and counts as a pass.
2. **Check** the render (`QaHost.check`: black/frozen frames, audio gaps, flash clips, missing files, layout) and get the
   frames to review.
3. **Vision review**: a runtime-started Vision run "Render QA · pass _k_" (`Orchestrator.runInternal`; an ordinary run in
   the chat, counted as reported so it never re-prompts the Director) with `inspect_render {times}` and
   `report_render_findings {findings}` — tools only Vision has, refused outside an open review. Findings are forced to
   source `vision` and deduplicated against the deterministic issues with `sameQaIssue`. Vision not enabled, the run
   failed, or no findings reported → `vision.status` `unavailable` / `failed` with a reason; the deterministic result
   stands and the Director is told.
4. **Compare** with the previous pass (`compareQaPass`: new / persisting / reappeared / fixed), **store** the report
   (`QaHost.saveReport`), emit `qa.updated` on every phase change and keep `turn.qa` current.
5. If fixable issues remain and _k_ < _N_: the Director gets a `<render-qa pass=… limit=…>` prompt (open issues by owner
   with ids, times, clips and suggestions; what was fixed, persists, reappeared, and what is new after its last correction
   — a regression; instruction to delegate to Editor/Motion/Audio/Research with self-contained tasks) and its delegated runs
   are collected like after its first reply. `render_video` is refused during a correction (the runtime re-renders). A
   correction that leaves the project fingerprint unchanged ends the loop (`issues_remain`); the loop never exceeds _N_
   renders (at most *N*−1 corrections).

**The Director does not announce "done" before QA.** When QA can apply to a turn (QA host available, `qaPasses` > 0,
`qaApplies(mode, action)`), the Director's first prompt and its follow-up prompts before QA end with a
`<render-qa-pending>` block: the reply is an interim progress note, not the answer. The guarantee does not depend on the
model obeying: when QA really starts, and again before the final prompt (so correction replies count too), the loop calls
`TurnEventWriter.markTextInterim()`, which emits `assistant.parts.interim {messageId, partIds}` for the Director's text
parts written so far (folded to `interim: true` on the text part; Studio labels them "Before render QA"). The
`<render-qa-final>` prompt's reply is the final answer. When QA is skipped after the Director was told a check follows
(the project did not change, or the composition is too long to render unasked), its reply is marked interim and a
`<render-qa-skipped>` prompt asks for the real answer with the reason.

**Reverted turns.** The Director's session keeps the messages of a turn the user reverted; the next turn's first prompt
carries a `<reverted-turns>` block (`src/revertedTurns.ts`) listing the turns reverted since the previous turn started,
so the Director does not describe their edits as present.

Afterwards the Director gets one `<render-qa-final>` prompt (outcome, last render, fixed vs remaining issues) to report; in
it `edit_timeline`, `build_rough_cut`, `build_story`, `rebuild_story`, `edit_story`, `render_video`, `delegate`, `jev`,
`import_asset` and `resolve_missing_asset` are refused (`src/qa/phase.ts`). Steering sent during QA opens the next Director
prompt. Aborting anywhere in QA cancels the render/check/frames/Vision run, marks the pass `aborted`, stores no report for
it and finalizes the turn `aborted`; `TurnQa.shutdown` is awaited in `finalize` before the checkpoint closes.

**Cleanup.** Every QA pass that renders leaves a preview in `renders/`. When the QA session ends (any status: `passed`,
`issues_remain`, `failed`, or `aborted`) the loop calls `QaHost.finishSession` (`POST …/qa/sessions/:turnId/finish
{keep, produced?}`): `keep` is the latest render that succeeded (the file the final report names), `produced` lists the
previews QA itself rendered (so one a stopped pass made before its report was stored is not left behind). The Studio
server deletes the session's intermediate QA previews with their job sidecar and frame cache, never the kept one and
never a render a report records as the turn's own (`QaRenderInfo.origin: "turn"`, the Director's render pass 1 reuses),
then applies its report retention (`studio-server/src/qa/retention.ts`: the reports of the 20 most recent sessions, of
anything younger than 3 days and of a running session stay; older reports and orphaned frame caches go). The call uses
its own signal (not the turn's, so it runs after an abort), is bounded by the host's timeout, and its failure is
swallowed (`TurnQa.finishSession`): cleanup never fails a turn.

`FakeQaHost` (`src/testing`) is the in-memory host for tests (the project's `fingerprint` and `bump()`, queued check
results, `checkGate` / `framesGate` / `cancelDelay`, stored `reports`); the runtime fixture wires it.

## Turns, checkpoints, concurrency

- One project-modifying turn at a time across all chats of a project (`chat_busy` / `project_busy`).
- The user's UI language rides with every start and steer request as `userLanguage` (a BCP-47 tag
  Studio takes from its i18n instance). `renderPromptContext` appends a `<user-language>` block
  with one English instruction ("Reply to the user in Russian; keep tool calls, file contents, code
  and identifiers unchanged") to the Director's prompt and to every specialist task; English or an
  unknown tag adds nothing, so the prompt is byte-identical to before. System prompts stay English.
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
(`~/.omp/agent`; the runtime never writes to it) plus the API keys stored in OpenVids (see Providers and credentials). A `tool_call` guard (`src/omp/path-guard.ts`)
blocks every path outside the project or inside `.hyperframes/`, checks each target of OMP's `a;b` /
`a,b` / `a b` / brace path fan-out, and fails closed for `edit`/`write` calls whose target it cannot
read. The guard is bound through `preloadedPreparedExtensions`: OMP silently drops `extensions` when
`restrictToolNames` is set, so an inline `extensions` hook would not run. The same hook
(`src/omp/tool-guard.ts`) also keeps `edit`/`write` away from timeline-locked clips: for a project
HTML file that contains `data-timeline-locked` elements it computes the content the call would leave
(replace-mode `old_string`/`new_string`/`replace_all`, or the `write` content), and blocks the call if
any locked element (matched by `data-hf-id`, else `id`) would be removed, changed or unlocked, or if
the call cannot be interpreted (`src/omp/lock-guard.ts`).

## Develop

```bash
bun run --cwd packages/agent-runtime typecheck
bun run --cwd packages/agent-runtime test        # fake backend + fake checkpoint host, no network
OPENVIDS_AGENT_TOKEN=dev bun packages/agent-runtime/src/main.ts
```

Vitest resolves `@hyperframes/agent-protocol` through its `node` export condition, so build it first
(`bun run --cwd packages/agent-protocol build`; the root `bun run build` does).
