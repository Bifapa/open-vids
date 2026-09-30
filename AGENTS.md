# OpenVids

OpenVids is a standalone, agent-native desktop video editor derived from an initial HyperFrames snapshot.

## Architecture

- **Desktop Shell**: Tauri 2 (`apps/desktop`).
- **Frontend / Editor**: HyperFrames-derived Studio served from a local loopback HTTP server (`cli` launches the Studio server; SPA + `/api`; composition iframe).
- **Core Constraints**:
  - Studio and the composition iframe rely on same-origin synchronous DOM access. Never move Studio to `tauri://`, never introduce a second wrapper editor UI, and do not migrate off Tauri without a concrete blocker.
  - Project and source files on disk are the single source of truth.

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
- `core`: Types, parsers, generators, linter, runtime, frame adapters, HTML bundler, and the shared timeline-asset markup builder (`@hyperframes/core/editing/timeline-asset`) used by Studio drops and the agent editing service.
- `parsers`: HTML/CSS parser utilities and subcomposition path rewriters.
- `lint`: Static analysis and HTML composition lint rules.
- `studio-server`: Local HTTP loopback server powering preview, state, file observation, undo/redo history, the agent gateway, the agent editing service (`src/editing/`, `/api/projects/:id/editing/*`), the long-form analysis service (`src/analysis/`, `/api/projects/:id/analysis/*`: durable per-source artifacts in `<project>/.hyperframes/analysis/`, invalidated by source content hash, input versions and algorithm recipe; orphaned artifacts of deleted files and their cut plans are swept, and a plan's `applied` state is derived from the `data-ov-cut` clips on the timeline) and the Story service (`src/story/`, `/api/projects/:id/story/*`: the Story Graph in `.hyperframes/story/graph.json`, user saves with authorship, agent edits that never override locks or the user's decisions, the deterministic intent compiler (`compile.ts`) and the Story ↔ timeline sync planner (`sync.ts`) behind full Build Story and Rebuild affected sections; built clips carry `data-ov-story-node` / `data-ov-cut` / `data-ov-turn` provenance, and the sync ledger `.hyperframes/story/sync.json` records which clips each section/unit owns and their generated state, so manual edits are found by structured comparison, never by diffing HTML). Agent `edit_timeline` batches carry the turn id: changed clips get a `data-ov-ai-edit` stamp so later AI edits are told from the user's. Editing-service and agent story writes are unclaimed outside edits: Studio live-reloads timeline writes and history attributes them to the running agent turn (the graph and ledger files are history-tracked but kept out of the preview signature and reloads). Speech recognition and diarization run in CLI child processes through `adapter.transcribeMedia` / `diarizeMedia`, never in the server process.
- `agent-protocol`: OpenVids-owned Agent Runtime protocol (chats, turns, messages, events, agents/runs, plans, settings, editor context, references, chat modes `normal`/`story`, story actions `review`/`build`/`rebuild` with the user's `storyOptions`) plus the editing contract (`editing.ts`: inventory, timeline snapshot, edit operations, clip provenance, errors, `parseApplyEditsRequest`), the analysis contract (`analysis.ts`: provider-neutral transcript, speakers, silence, shots, take issues, segments, vision notes, cut plans, routes, parsers) and the Story contract (`story.ts`: Story Graph nodes/edges/attachments with stable ids and authorship, `storyOrder`, parsers, agent operations, build and rebuild requests/results, the `StorySyncReport` impact (sections, units, manual edits, unrelated clips), `captionCuesFromWords`) shared by Studio, the Studio server and the runtime. Browser-safe, no runtime deps.
- `agent-runtime`: Separate local Bun process for Agent Chat (chat store, turns, checkpoints, Director → specialist orchestration, Jev, global agent settings, editing tools under `src/editing/`, long-form analysis tools under `src/analysis/` and Story tools under `src/story/` (`read_story`, `edit_story`, `build_story`, `rebuild_story`, story-mode prompts; a rebuild turn's scope, manual-edit policy and locked-chapter permission come from the user's `storyOptions`, never from the model) that call the Studio server over loopback, HTTP API). The OMP SDK is imported only under `src/omp/`; never from Studio, `studio-server` or `cli`. Read `packages/agent-runtime/README.md`.
- `player`: Embeddable web component player for compositions.
- `studio`: Browser-based video composition editor UI, incl. the Chat panel and the Story workspace (`src/story/`: `@xyflow/react` graph canvas, inspector, local undo/redo, Review with AI / Build Story / Rebuild affected, Story ↔ timeline sync badges and impact dialog read from `StoryView.sync`) (read `packages/studio/AGENTS.md` before making changes to Studio).
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
