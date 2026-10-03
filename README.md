# OpenVids

**Website: [openvids.ai](https://openvids.ai)**

OpenVids is an open-source desktop video editor for macOS that you work in together with AI agents. You describe the video in chat; the agents cut footage, build the timeline, add captions and motion graphics, then render the result and check it. Everything runs on your machine, and the project is a folder of plain files you can open and edit by hand.

It began as a snapshot of [HyperFrames](https://github.com/heygen-com/hyperframes) (HeyGen, Apache-2.0) and is developed here as its own app, with no npm distribution and no cloud backend.

## What it does

- **Edit by chat.** A Director agent plans the work and hands it to specialists (Editor, Vision, Motion Designer, Research, Audio). Their edits land in the project files, so the timeline and preview update while they work.
- **Long recordings.** Transcription with word timestamps, speaker detection, pauses, shots and retakes are analysed locally and reused across turns to build a rough cut.
- **Story mode.** Lay the video out as a graph of sections, review it with AI, and build or rebuild the affected parts of the timeline.
- **Research with licenses.** Agents can find and import outside material from trusted sources, and every import keeps its origin, author and license.
- **Render QA.** After a turn the result is rendered and checked for black or frozen picture, audio holes, layout problems and wrong footage, and the agents correct what they find.
- **One prompt, one checkpoint.** Every turn can be reverted as a whole.
- **A full manual editor.** Timeline, preview, inspector and code view work without the agents.

## Status

OpenVids is at an early stage.

- macOS 11 or later on Apple Silicon. There is no Intel build.
- Prebuilt downloads are on [GitHub Releases](https://github.com/bazodev/open-vids/releases/latest); you can also build from source.
- The app checks GitHub Releases for updates and installs them on a button press; updates are verified with the project's updater signing key, not by Apple code signing.
- Builds are ad-hoc signed and not notarized, so macOS blocks the first launch (see [Install](#install)).
- Rendering and thumbnails need Chrome and FFmpeg installed on the machine; OpenVids does not ship them.
- The local Studio server is unauthenticated on loopback while a project is open. See [SECURITY.md](SECURITY.md).

## Install

1. Download `OpenVids_<version>_aarch64.dmg` from the [latest release](https://github.com/bazodev/open-vids/releases/latest), open it and drag OpenVids to Applications.
2. Open OpenVids once. macOS says it cannot verify the developer: the app is not notarized. Open **System Settings → Privacy & Security**, scroll to Security and click **Open Anyway** next to OpenVids, then confirm. Alternatively, in Terminal: `xattr -dr com.apple.quarantine /Applications/OpenVids.app`.
3. Install [Google Chrome](https://www.google.com/chrome/) and FFmpeg (`brew install ffmpeg`, or the button OpenVids shows when FFmpeg is missing).

Later versions install from inside the app (the update button), without these steps.

## Build from source

Install the tools listed under [Requirements](#requirements), then:

```bash
git clone https://github.com/bazodev/open-vids.git
cd open-vids
bun install
bun run desktop:dev      # run the app in development mode
```

To build the application bundle (`OpenVids.app` and a `.dmg`):

```bash
bun run desktop:build
```

### Models for the agents

Connect a model provider in **Settings → Models & Providers** by adding an API key; OpenVids keeps it in a private file in `~/.openvids/agent`. If you already use [oh-my-pi](https://github.com/can1357/oh-my-pi), Agent Chat also picks up the providers and sign-ins of your setup in `~/.omp/agent`; OpenVids reads it and never writes to it. Which model each agent uses is chosen in OpenVids settings. The manual editor works without any of this.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems are reported privately, as described in [SECURITY.md](SECURITY.md).

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
                 ├─ /api/research/*, /api/projects/:id/research/*
                 │                               Asset Search policy, search/import with provenance
                 ├─ /api/projects/:id/qa/*       render QA: checks of rendered files, frames, reports
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
- **Research, sources and licensing** — only the Research specialist searches outside the project (`search_assets`, `inspect_url`, `import_asset`, `resolve_missing_asset`), and only through the Studio server, which enforces the global Asset Search policy (`Trusted sources only` — Wikimedia Commons, Openverse, NASA Image and Video Library, Internet Archive and the user's own websites — or `Any source`). Imports land in `assets/research/` with provenance (original URL, source, author, license, license URL and confidence, retrieval time and agent) in `.hyperframes/research/provenance.json`; the Sources & Licenses panel shows it, unknown or restricted licenses are warned about on export (never blocked), and Story Missing Asset nodes are resolved with what Research imports ("Find missing material").
- **Render QA and Execution Quality** — after an agent turn changes the project, the runtime renders a preview and checks the rendered file: deterministic checks on the Studio server (black/frozen picture, audio holes and silence, flash clips, gaps, clips past their media, cuts inside a word, caption/text collisions and out-of-frame layout) plus Vision's review of rendered frames (content fit, wrong B-roll). While fixable issues remain the Director delegates corrections and the next pass re-renders and re-checks — at most the chat's pass limit (Execution Quality Fast / Balanced / Best / Custom, default 2 passes, 0–5). Each pass is a durable report in `.hyperframes/qa/reports/`; the chat shows a Render QA card with fixed / persisting / new issues.
- **One prompt = one checkpoint** — every file an agent changes during a turn is recorded in project history as that turn; **Revert this turn**, Stop and crash recovery undo the whole edit (QA corrections and imported assets with their provenance included; the download cache stays). Renders in `renders/` and QA reports are kept; a report of a reverted state reads "outdated".

Details: `packages/agent-runtime/README.md`.

## Usage statistics

The desktop app sends anonymous usage statistics so we can see how many people use OpenVids, and on which versions and systems. They go to OpenVids' own [Umami](https://umami.is) at `https://analytics.openvids.ai` (`POST /api/send`), from the Tauri shell only (`apps/desktop/src-tauri/src/telemetry.rs`): Studio, the Studio server, the agent runtime and the CLI never send them.

- **Events** — `app_start` at launch (and when statistics are turned back on), `heartbeat` every 5 minutes while the app is open, `app_end` on a normal quit, and `telemetry_disabled` once at the moment you turn statistics off.
- **Fields** — every event carries the event name, the UI language and `version` (app version), `os`, `arch` and `active` (whether the main window has focus). Every event except `telemetry_disabled` also carries an installation id: a random UUID created on the first send and stored in `~/.openvids/app/installation-id` (`OPENVIDS_APP_DIR` moves it). The request's User-Agent is `OpenVids/<version> (<os>; <arch>)`. Nothing else.
- **Never sent** — names or paths of files and projects, project content, chat or prompt text, URLs, provider keys, error messages.
- **Turning it off** — Settings › General › **Share anonymous usage statistics** (`telemetry.enabled` in `~/.openvids/app/preferences.json`); after the one `telemetry_disabled` nothing is sent. `DO_NOT_TRACK=1` or `OPENVIDS_TELEMETRY=0` in the environment stops every request, whatever the setting, and no installation id is created. Development builds (`bun run desktop:dev`) send nothing unless `OPENVIDS_TELEMETRY_URL` points them at an address (for testing against a local receiver).

Failed requests are dropped: no retries, nothing queued on disk.

## Bug reports

Help › **Report a Problem…** (`apps/desktop/src-tauri/src/report.rs` plus the home server's `/report` page) opens a separate window that never blocks the editor: the user can keep working, move the window anywhere, and attach screenshots — taken with the native capture tool (region or window, the report window hides itself first) or picked from disk (up to 5, PNG/JPEG/WebP, 8 MB each). Sending is an explicit action, so the telemetry preference and `DO_NOT_TRACK` do not apply to reports. They go to `https://openvids.ai/api/reports` (rate limit, a proof-of-work challenge and a kill switch), which either publishes the report immediately as a public issue in [bazodev/open-vids](https://github.com/bazodev/open-vids/issues) or holds it for moderation.

- **Sent** — the text the user wrote, optionally their email, the screenshots, the last ~1 MB of the app log (`~/Library/Logs/<bundle id>/openvids.log`, where the shell, the Studio server and the agent runtime all write; rotated at 5 MB into `.1`/`.2`) and diagnostics: app version, macOS version, architecture, UI language, the FFmpeg version the CLI's own check reports, and the provider and model names selected in the agent settings — names only, never a key. A random reporter id (rate limiting) is created on the first send in the app's data directory (`~/Library/Application Support/<bundle id>/reporter-id`); it is separate from the statistics installation id.
- **Private** — the email and the log tail are for triage only: they are never part of the public issue and never sent to the moderation model. The log is redacted on the machine before it leaves (API keys, bearer tokens, JWTs, `key`/`token`/`secret`/`password` values, email addresses, and the home directory shown as `~`) and redacted again on the server.
- **Public** — the report text and the screenshots become a public GitHub issue when the report is classified as clean, so a screenshot may show anything visible on screen. Draft text and screenshots live in the app's data directory under `report-draft/` until the report is sent.

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

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 The OpenVids Authors. OpenVids is derived from an initial HyperFrames snapshot (Copyright 2026 HeyGen, Inc., Apache-2.0) and is not affiliated with HeyGen; prior-art and third-party attributions live in [CREDITS.md](CREDITS.md).
