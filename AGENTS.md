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
- `core`: Types, parsers, generators, linter, runtime, frame adapters, and HTML bundler.
- `parsers`: HTML/CSS parser utilities and subcomposition path rewriters.
- `lint`: Static analysis and HTML composition lint rules.
- `studio-server`: Local HTTP loopback server powering preview, state, file observation, and undo/redo history.
- `agent-protocol`: OpenVids-owned Agent Runtime protocol (chats, turns, messages, events, editor context, references) shared by Studio, the gateway and the runtime. Browser-safe, no runtime deps.
- `agent-runtime`: Separate local Bun process for Agent Chat (chat store, turns, checkpoints, HTTP API). The OMP SDK is imported only under `src/omp/`; never from Studio, `studio-server` or `cli`. Read `packages/agent-runtime/README.md`.
- `player`: Embeddable web component player for compositions.
- `studio`: Browser-based video composition editor UI (read `packages/studio/AGENTS.md` before making changes to Studio).
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
