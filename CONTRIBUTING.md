# Contributing to OpenVids

Thanks for your interest. Bug reports, fixes and focused improvements are welcome. For a larger
change, open an issue first so the approach can be agreed before you write the code.

## Setup

You need macOS, [Bun](https://bun.sh), a Rust stable toolchain, Node.js 22+, FFmpeg with ffprobe on
`PATH`, a Chrome the CLI can drive, and [Git LFS](https://git-lfs.com) (render test fixtures are
stored in LFS).

```bash
git lfs install
git clone https://github.com/bazodev/open-vids.git
cd open-vids
bun install
bun run desktop:dev
```

OpenVids uses Bun. Do not use npm or pnpm, and do not commit their lockfiles.

## Before you open a pull request

Read [AGENTS.md](AGENTS.md) first: it is the canonical description of the architecture and its
constraints. `packages/studio/AGENTS.md` and `packages/agent-runtime/README.md` cover those two
packages in more detail.

Run the checks that CI runs, plus the ones that cover what you changed:

```bash
bun run build            # build all packages
bun run desktop:check    # cargo check for the Tauri shell
bun run lint             # workspace checks + oxlint + skills lint
bun run format:check     # oxfmt
bun run typecheck        # typecheck every workspace
bun run test             # unit tests across workspaces
```

Format with `bunx oxfmt <files>` and lint with `bunx oxlint <files>`. The repository does not use
eslint, prettier or biome.

## Conventions

- TypeScript: no `any` and no `as T` assertions. Use type guards and narrowing.
- Rendering must stay deterministic: no `Date.now()`, no unseeded `Math.random()`, no network
  fetches at render time.
- Studio stays on a loopback HTTP origin, same-origin with the composition iframe. Do not move it
  to `tauri://` or add a second editor UI.
- Project and source files on disk are the single source of truth. New long-lived state must be
  recoverable after a hard kill.
- The webview gets no native access beyond moving its window. Privileged work goes through the home
  or Studio HTTP APIs, not through new Tauri capabilities.
- Add or update tests next to the code you change.

## Commits and pull requests

- Keep a pull request to one topic and describe what changed and how you checked it.
- Commit subjects follow `type(scope): summary`, for example `fix(studio): keep playhead on trim`.
- Do not commit secrets, personal media or generated output (`renders/`, `dist/`,
  `apps/desktop/runtime/`).
- Media and other third-party assets need a license that allows redistribution; record the source in
  [CREDITS.md](CREDITS.md).

## Security issues

Do not file them as public issues. See [SECURITY.md](SECURITY.md).

## License

OpenVids is licensed under [Apache-2.0](LICENSE). By contributing you agree that your contribution
is licensed under the same terms.
