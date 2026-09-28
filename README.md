# OpenVids

OpenVids is a standalone, agent-native desktop video editor: write HTML, render video. It began as an initial HyperFrames snapshot and is developed here as its own app — no npm distribution, no cloud backend.

## Architecture

```text
OpenVids.app
  └─ Tauri 2 (apps/desktop/src-tauri)
       └─ sidecar: bun serve.mjs hyperframes/cli.js preview --json --no-open --foreground
            └─ local loopback Studio server (packages/cli embedded server)
                 ├─ Studio SPA (prebuilt packages/studio dist)
                 ├─ /api (project files, render, media — full OS access)
                 └─ composition iframe, same-origin with the editor
```

The window loads Studio from the sidecar; the composition iframe stays same-origin with the editor so it can reach `contentDocument` directly. The sidecar is per-project and is reaped on quit (SIGTERM grace, then SIGKILL of the process group).

## Requirements

- [Bun](https://bun.sh) (package manager and the sidecar JS runtime)
- Rust stable toolchain (Tauri builds; `desktop:check` runs `cargo check`)
- Node.js 22+, FFmpeg + ffprobe on PATH, and a Chrome the CLI can drive (`npx hyperframes doctor` reports all of these; see `packages/cli/src/commands/doctor.ts` and `packages/cli/src/browser/preflight.ts`)

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
- `packages/studio/`, `packages/studio-server/` — editor UI and its HTTP API
- `packages/core/`, `packages/parsers/`, `packages/lint/`, `packages/player/`, `packages/sdk/`, `packages/shader-transitions/` — composition contract, adapters, web component
- `registry/` — installable blocks, components, examples
- `skills/` + `skills-manifest.json` — agent skill definitions and their content hashes
- `themes/` — shared design tokens

## Conventions

Read `AGENTS.md` before making changes: Bun (never pnpm/npm), oxlint/oxfmt, no `any`/`as T`, deterministic rendering.

## License

Apache-2.0 — see [LICENSE](LICENSE). Derived from an initial HyperFrames snapshot (HeyGen); prior-art and third-party attributions live in [CREDITS.md](CREDITS.md).
