# OpenVids

OpenVids is a standalone, agent-native desktop video editor: write HTML, render video. It began as an initial HyperFrames snapshot and is developed here as its own app — no npm distribution, no cloud backend.

## Architecture

```text
OpenVids.app
  └─ Tauri 2 (apps/desktop/src-tauri)
       └─ sidecar: bun serve.mjs hyperframes/cli.js preview --json --no-open --foreground
            └─ local loopback Studio server (packages/cli embedded server)
                 ├─ Studio SPA (prebuilt packages/studio dist), incl. the Chat panel
                 ├─ /api (project files, render, media, history — full OS access)
                 ├─ /api/projects/:id/editing/*  editing capabilities for agents
                 ├─ /api/projects/:id/story/*    Story Graph, Review/Build compiler, card frames
                 ├─ /api/projects/:id/agent/*    gateway ─► agent runtime (separate Bun process,
                 │                                          127.0.0.1 + per-launch token) ─► OMP ─► providers
                 └─ composition iframe, same-origin with the editor
```

The window loads Studio from the sidecar; the composition iframe stays same-origin with the editor so it can reach `contentDocument` directly. The sidecar is per-project and is reaped on quit (SIGTERM grace, then SIGKILL of the process group).

## Agent

The Chat panel talks to the OpenVids Agent Runtime (`packages/agent-runtime`), which is started lazily by the Studio server and never loaded into the browser. Its wire model is `packages/agent-protocol`.

- **Director + specialists** — the Director plans, delegates to enabled specialists (Editor, Vision, Motion Designer, Research, Audio) and can hand micro-tasks to Jev. Models and thinking are set per agent (globally in `~/.openvids/agent`, or per chat).
- **Editing tools** — agents build the video through OpenVids capabilities served by the Studio server: `inspect_project`, `inspect_timeline`, `edit_timeline` (atomic batches: add/remove/move/trim/split clips, arrange tracks, text, registry components, caption presets, audio levels/fades), `browse_presets`, `render_video`. The Editor owns timeline edits. Edits land in the project files, so the live timeline and preview update while the agent works.
- **Long-form analysis** — for long recordings the Studio server keeps durable, per-file analysis in `.hyperframes/analysis/`: transcript with word timestamps (local whisper.cpp or Parakeet), speaker map (sherpa-onnx diarization), pauses, shots with black/frozen-picture detection, take issues (retakes, false starts, fillers), draft segments, Vision notes and cut plans. Agents use it through `analyze_media`, `read_analysis`, `read_transcript`, `save_segments`, `inspect_frames` (Vision looks only at selected frames), `save_vision_notes`, `plan_cut` and `build_rough_cut`; the analysis is reused across turns and recomputed only when the source file (or the analysis method) changes.
- **One prompt = one checkpoint** — every file an agent changes during a turn is recorded in project history as that turn; **Revert this turn**, Stop and crash recovery undo the whole edit. Renders in `renders/` are kept.

Details: `packages/agent-runtime/README.md`; product docs and roadmap live in [aiezq/docs_open_vids](https://github.com/aiezq/docs_open_vids).

## Requirements

- [Bun](https://bun.sh) (package manager and the sidecar JS runtime)
- Rust stable toolchain (Tauri builds; `desktop:check` runs `cargo check`)
- Node.js 22+, FFmpeg + ffprobe on PATH, and a Chrome the CLI can drive (`npx hyperframes doctor` reports all of these; see `packages/cli/src/commands/doctor.ts` and `packages/cli/src/browser/preflight.ts`)
- Long-form analysis: `whisper-cli` (e.g. `brew install whisper-cpp`; the CLI installs it when possible) and its model are fetched on first use; the diarization runtime and models download into `~/.cache/hyperframes/` on first use

## Commands

```bash
bun install              # install workspace dependencies
bun run build            # build all packages (CLI bundle embeds the Studio SPA)
bun run desktop:dev      # Tauri dev window (Studio via Vite, no sidecar)
bun run desktop:stage    # assemble apps/desktop/runtime (gitignored)
bun run desktop:build    # build + stage + tauri build (.app + .dmg)
bun run desktop:check    # cargo check for the Tauri shell
bun run lint             # workspace checks + oxlint + skills lint
bun run typecheck        # typecheck every workspace
bun run test             # unit tests across workspaces
```

## Repo layout

- `apps/desktop/` — Tauri shell (`src-tauri/`), staging scripts, `sidecar/serve.mjs` launcher
- `packages/cli/` — CLI incl. `preview` (the embedded Studio server), local `render`, media, browser
- `packages/producer/`, `packages/engine/` — local render pipeline (Chrome capture + FFmpeg encode + audio mix)
- `packages/studio/`, `packages/studio-server/` — editor UI (incl. Chat panel) and its HTTP API (incl. the agent gateway and the editing service)
- `packages/agent-protocol/`, `packages/agent-runtime/` — agent wire model; agent runtime process (chats, turns, checkpoints, orchestration, editing tools, OMP adapter)
- `packages/core/`, `packages/parsers/`, `packages/lint/`, `packages/player/`, `packages/sdk/`, `packages/shader-transitions/` — composition contract, adapters, web component
- `registry/` — installable blocks, components, examples
- `skills/` + `skills-manifest.json` — agent skill definitions and their content hashes
- `themes/` — shared design tokens

## Conventions

Read `AGENTS.md` before making changes: Bun (never pnpm/npm), oxlint/oxfmt, no `any`/`as T`, deterministic rendering.

## License

Apache-2.0 — see [LICENSE](LICENSE). Derived from an initial HyperFrames snapshot (HeyGen); prior-art and third-party attributions live in [CREDITS.md](CREDITS.md).
