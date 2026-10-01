# OpenVids

OpenVids is a standalone, agent-native desktop video editor derived from an initial HyperFrames snapshot.

## Architecture

- **Desktop Shell**: Tauri 2 (`apps/desktop`).
- **Frontend / Editor**: HyperFrames-derived Studio served from a local loopback HTTP server (`cli` launches the Studio server; SPA + `/api`; composition iframe).
- **Core Constraints**:
  - Studio and the composition iframe rely on same-origin synchronous DOM access. Never move Studio to `tauri://`, never introduce a second wrapper editor UI, and do not migrate off Tauri without a concrete blocker.
  - Project and source files on disk are the single source of truth.
  - Hard kills (SIGKILL, crash) are recovered, never cleaned up by handlers: history keeps open agent windows in `<history home>/open-windows.json` and files a dead owner's writes to the turn's own entry on the next start (so `Revert this turn` still works); the Studio server sweeps `renders/work-*` and `.*.hf-transaction-*` at start and the engine kills Chrome whose owner died (`<tmp>/hyperframes-browsers/<pid>.json`, `sweepOrphanBrowsers`). Keep new long-lived state recoverable the same way.

## Package Manager & Commands

OpenVids uses **Bun** (not pnpm or npm).

```bash
bun install               # Install dependencies
bun run desktop:dev       # Launch desktop application in development mode
bun run desktop:build     # Build desktop application release bundle
bun run desktop:check     # Run desktop typecheck and cargo checks
bun run build             # Build workspace packages
```

### Linting & Formatting

Uses **oxlint** and **oxfmt** (not eslint, not prettier, not biome):

```bash
bunx oxlint <files>        # Lint
bunx oxfmt <files>         # Format
bunx oxfmt --check <files> # Check formatting
```

## Packages & Directories

### Packages (`packages/`)

- `core`: Types, parsers, generators, linter, runtime, frame adapters, HTML bundler, and the shared timeline-asset markup builder (`@hyperframes/core/editing/timeline-asset`) used by Studio drops and the agent editing service. The runtime's preview media budget (`src/runtime/previewMediaBudget.ts`) keeps at most 16 `<video>` elements with a loaded source around the playhead in Studio preview documents only (never in render/capture); code that reads a preview video's `src` must use `readPreviewMediaSrc`.
- `parsers`: HTML/CSS parser utilities and subcomposition path rewriters.
- `lint`: Static analysis and HTML composition lint rules.
- `studio-server`: Local HTTP loopback server powering preview, state, file observation, undo/redo history, the agent gateway, the agent editing service (`src/editing/`, `/api/projects/:id/editing/*`), the long-form analysis service (`src/analysis/`, `/api/projects/:id/analysis/*`: durable per-source artifacts in `<project>/.hyperframes/analysis/`, invalidated by source content hash, input versions and algorithm recipe; orphaned artifacts of deleted files and their cut plans are swept, and a plan's `applied` state is derived from the `data-ov-cut` clips on the timeline), the Story service (`src/story/`, `/api/projects/:id/story/*`: the Story Graph in `.hyperframes/story/graph.json`, user saves with authorship, agent edits that never override locks or the user's decisions, the deterministic intent compiler (`compile.ts`) and the Story ↔ timeline sync planner (`sync.ts`) behind full Build Story and Rebuild affected sections; built clips carry `data-ov-story-node` / `data-ov-cut` / `data-ov-turn` provenance, and the sync ledger `.hyperframes/story/sync.json` records which clips each section/unit owns and their generated state, so manual edits are found by structured comparison, never by diffing HTML), the Research service (`src/research/`: the global Asset Search policy at `/api/research/*` in `~/.openvids/research/policy.json` (`OPENVIDS_RESEARCH_DIR`), and per project `/api/projects/:id/research/*` search/inspect/import/resolve/sources/export-check, plus the website style reader `POST /api/projects/:id/research/website` (`src/research/website.ts`): for a public http(s) page the user linked, headless Chrome renders it inside the CLI child `cli inspect-site <url> --json --out <dir>` (`packages/cli/src/siteInspect/`, adapter `inspectWebsite` in `server/siteAdapter.ts`; never in the server process, Chrome runs over a pipe with an isolated temp profile, no downloads, a 30 s budget; aborting the HTTP request or `requestId` cancel kills the child and its Chrome) and the answer is a `WebsiteStyle` (palette by role, fonts with source Google/self-hosted/system, type scale, radii, shadows, buttons, design tokens, motion hints, logo, headings) plus a 1440×900 and a ≤1440×3000 JPEG screenshot. The setting `websites.readLinkedPages` (default on, in the same `policy.json`, served and changed through `GET`/`PUT /api/research/policy`) must be on or the route answers 403 `blocked_by_policy`; the address rules (public hosts only, shared with Asset Search through the `@hyperframes/studio-server/public-address` subpath: `src/research/sources/address.ts`) are applied to the URL and, in the child, to EVERY request Chrome makes (redirect hops, CSS, fonts, images from any host) and to the address each connection really used, and the sandbox, sockets and service workers stay off. Which sites an agent may ask for (only those the user linked in the chat) is enforced by the agent runtime, not here. `save: true` writes the screenshots, the logo (SVG sanitized) and the self-hosted font files the page loaded into `assets/web/<host>/`, each with an `AssetProvenance` record (source `website`, mediaKind `picture`/`font`, license unknown) in `.hyperframes/research/provenance.json`, through the same cancel commit point as imports) and the render QA service (`src/qa/`, `/api/projects/:id/qa/*`: project fingerprint, deterministic checks of a RENDERED file — ffmpeg black/freeze (only where the source moves)/audio holes and silence, timeline flash clips/gaps/clips past their media/missing files/cuts inside a word, layout through the CLI `check` child via `adapter.checkLayout` — Vision sample planning with what is on screen and said, frames of renders, immutable reports in `.hyperframes/qa/reports/` whose `current` flag is derived from the fingerprint; outside history). The Research service is the only place OpenVids touches the network for assets: every search, page read and download goes through `sources/policyFetch.ts`, which checks the policy (trusted mode: enabled trusted sources only) and SSRF rules on every redirect hop; sources are data (connector + domains) served by connectors under `sources/connectors/`; imports land in `assets/research/` with a provenance record in the history-tracked `.hyperframes/research/provenance.json` and bytes in the download cache `.hyperframes/research/cache/` (outside history); imports/resolutions carry a `requestId` and are cancelled at one commit point (`requestRegistry.ts`, `POST …/research/requests/:requestId/cancel`), so Stop never lets a write land after the turn's checkpoint. Agent `edit_timeline` batches carry the turn id: changed clips get a `data-ov-ai-edit` stamp so later AI edits are told from the user's. Editing-service, agent story and research writes are unclaimed outside edits: Studio live-reloads timeline writes and history attributes them to the running agent turn (the graph, ledger and provenance files are history-tracked but kept out of the preview signature and reloads). Speech recognition, diarization and the layout check run in CLI child processes (`adapter.transcribeMedia` / `diarizeMedia` / `checkLayout`, `cli/src/server/cliChild.ts`), never in the server process; the embedded CLI server forwards each request's abort signal, so a disconnect cancels the work.
- `agent-protocol`: OpenVids-owned Agent Runtime protocol (chats, turns, messages, events, agents/runs, plans, settings, editor context, references, chat modes `normal`/`story`, story actions `review`/`build`/`rebuild`/`resolve` with the user's `storyOptions`) plus the editing contract (`editing.ts`: inventory, timeline snapshot, edit operations, clip provenance, errors, `parseApplyEditsRequest`), the analysis contract (`analysis.ts`: provider-neutral transcript, speakers, silence, shots, take issues, segments, vision notes, cut plans, routes, parsers), the Story contract (`story.ts`: Story Graph nodes/edges/attachments with stable ids and authorship, `storyOrder`, parsers, agent operations incl. `resolve_missing`, `resolvedFrom` on material nodes, build and rebuild requests/results, the `StorySyncReport` impact (sections, units, manual edits, unrelated clips), `captionCuesFromWords`), the research contract (`research.ts`: Asset Search policy and trusted sources, its `websites` group, `ProvenanceMediaKind`; `website.ts`: `WebsiteStyle`, `ReadWebsiteRequest`/`Result`, `parseWebsiteStyle`, candidates, import/resolve, `AssetProvenance`, `normalizeLicense` with confidence and status, sources view, export license check) and the QA contract (`qa.ts`: Execution Quality presets and the enforced `ExecutionBudget`, provider-neutral QA issues, `compareQaPass` (new/persisting/reappeared/fixed), check/frames/report wire types, `TurnQaState` and the `qa.updated` event) shared by Studio, the Studio server and the runtime. Browser-safe, no runtime deps.
- `agent-runtime`: Separate local Bun process for Agent Chat (chat store, turns, checkpoints, Director → specialist orchestration, Jev, global agent settings incl. the Execution Quality default, editing tools under `src/editing/`, long-form analysis tools under `src/analysis/`, Story tools under `src/story/` (`read_story`, `edit_story`, `build_story`, `rebuild_story`, story-mode prompts; a rebuild turn's scope, manual-edit policy and locked-chapter permission come from the user's `storyOptions`, never from the model), Research tools under `src/research/` (`search_assets`, `inspect_url`, `import_asset`, `resolve_missing_asset` for the Research specialist only, `read_sources` also for the Director; the runtime sets turn/agent/model on imports, the Studio server enforces the policy) and render QA under `src/qa/` (the runtime-owned `QaLoop`: render → server checks + a runtime-started Vision review (`inspect_render`, `report_render_findings`, Vision only) → compare → report → Director correction prompt → re-render, never beyond the chat's pass limit; tools refused per QA phase in `qa/phase.ts`) that call the Studio server over loopback, HTTP API). The OMP SDK is imported only under `src/omp/`; never from Studio, `studio-server` or `cli`. Read `packages/agent-runtime/README.md`.
- `player`: Embeddable web component player for compositions.
- `studio`: Browser-based video composition editor UI, incl. the Chat panel (Execution Quality control, Render QA card and report view: `ExecutionQualityMenu`, `RenderQaCard`, `QaReportView`, labels in `qaLabels.ts`), the Story workspace (`src/story/`: `@xyflow/react` graph canvas, inspector, local undo/redo, Review with AI / Build Story / Rebuild affected / Find missing material, Story ↔ timeline sync badges and impact dialog read from `StoryView.sync`, "Found by Research" provenance on resolved nodes) and the Sources & Licenses panel (`src/research/`: project provenance, the global Asset Search policy and trusted sources, the export license check that every export passes through in `useRenderQueue.startRender` — it warns, never blocks) (read `packages/studio/AGENTS.md` before making changes to Studio).
- `sdk`: Headless, framework-neutral composition editing engine.
- `engine`: Seekable web page to video rendering engine (Puppeteer + FFmpeg).
- `producer`: HTML-to-video rendering engine using Chrome's BeginFrame API.
- `shader-transitions`: WebGL shader transitions for compositions.
- `cli`: Command-line interface and daemon commands to create, preview, and render compositions.

### Directories

- `apps/desktop`: Tauri 2 desktop shell wrapping the loopback Studio editor.
- `registry/`: Built-in blocks, components, and templates library.
- `skills/` + `skills-manifest.json`: Agent skills for composition workflows and authoring.
- `themes/`: Curated styling, palette, and typography themes.
- `packages/studio/src/webmcp`: WebMCP integration for in-editor agent interaction and tool execution.

## Composition Conventions

- **HTML Structure**: Compositions are HTML files with `data-*` timing attributes.
- **Clips**: Clips need `class="clip"`.
- **GSAP Timelines**: Register one paused GSAP root timeline per composition on `window.__timelines`. Scene timelines manually added to that root must not be paused, or they will not advance when the root is seeked.
- **Deterministic Rendering**: No `Date.now()`, no unseeded `Math.random()`, no render-time network fetches.
- **TypeScript**: Avoid `any` and `as T` type assertions. Prefer type guards, predicates, and proper narrowing.
