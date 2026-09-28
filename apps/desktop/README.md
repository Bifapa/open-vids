# OpenVids — desktop

A Tauri 2 shell around [HyperFrames Studio](../../packages/studio). The window
_is_ Studio: OpenVids starts the real HyperFrames server on `127.0.0.1` and
points the webview at it.

## Why it works this way

Studio is not a static site. Every API call it makes is a root-relative
`/api/...` path, and the composition being edited lives in an iframe that Studio
reaches into with `contentDocument` / `contentWindow` —
`packages/studio/AGENTS.md` says so explicitly. The API is mounted in the _same
process_ that serves the SPA (Vite middleware in development, a Hono server in
production), so the document's origin and the API's origin are the same thing.

Therefore:

- The webview loads `http://127.0.0.1:<port>`, not a `tauri://` asset. A custom
  scheme would put the API on a different origin and break every cross-document
  read the editor depends on.
- There is no `postMessage` bridge and no second editing path.
- The iframe `sandbox` is untouched (`allow-scripts allow-same-origin` —
  `allow-same-origin` is what makes `contentDocument` readable).

## Commands

Run from the repository root:

```bash
bun run desktop:dev      # Studio dev server + Tauri window, one terminal
bun run desktop:build    # HyperFrames build -> staged runtime -> OpenVids.app (+ .dmg)
bun run desktop:stage    # Stage the production runtime only
bun run desktop:check    # cargo check for src-tauri
```

Open a specific project at launch:

```bash
OPENVIDS_PROJECT=/abs/path/to/project bun run desktop:dev
```

In dev, Studio's own project list in `packages/studio/data/projects` works
as-is. `OPENVIDS_PROJECT` (or a bare path argument) additionally symlinks that
directory into it — the same `linkProjectIntoStudioData()` mechanism the
HyperFrames CLI uses — so it appears in the list with no other change.

`desktop:dev` always rebuilds the workspace packages Studio's `vite.config.ts`
resolves through their `node` export condition (`parsers`, `lint`,
`studio-server`, `core`). It is a few seconds, and a stale `dist` there fails in
a way that looks like a Studio bug.

## Architecture

```
apps/desktop/
  scripts/
    serve-studio-dev.mjs   Tauri's beforeDevCommand: build deps, link the
                           project, start Vite on a fixed strict port (5190)
    stage-runtime.mjs      Assemble the production payload under runtime/
  src-tauri/
    src/lib.rs             Window, menu, mode selection, project opening
    src/sidecar.rs         Spawn + readiness-poll + teardown the Studio server
    src/placeholder.rs     The "no project open" page
    src/project.rs         Directory -> Studio project id
    capabilities/main.json The webview's permissions (none)
  sidecar/
    serve.mjs              Parent-death watch; see "Teardown" below
```

### Development

`beforeDevCommand` runs `serve-studio-dev.mjs`, which builds the workspace deps,
registers `OPENVIDS_PROJECT`, and starts Studio's Vite dev server on a fixed
strict port. The window then loads `devUrl` from `tauri.conf.json`. No sidecar,
no bundling, full HMR.

### Production

`desktop:build` runs the HyperFrames build first (`bun run build`), which
produces `packages/cli/dist` — including `dist/studio`, the prebuilt Studio SPA
that the CLI's `build:copy` step places there. `stage-runtime.mjs` then assembles
`apps/desktop/runtime/`:

| Path                   | What it is                                                     |
| ---------------------- | -------------------------------------------------------------- |
| `runtime/bun`          | The JS runtime.                                                |
| `runtime/hyperframes/` | A copy of `packages/cli/dist` plus its published dependencies. |
| `runtime/runtime.json` | The layout manifest.                                           |

Those three are bundled as app resources. Nothing in the shipped app refers to
the monorepo.

At runtime the Rust side:

1. reserves a loopback port (the Studio runtime takes a starting port and scans
   upward; it does not accept port 0),
2. spawns `bun hyperframes/cli.js preview --json --no-open --port <p> <dir>`,
3. reads the CLI's machine-readable lifecycle line from stdout for the port it
   actually bound,
4. polls `GET /api/projects` until the server answers — a bound socket is not a
   ready server,
5. navigates the window to `http://127.0.0.1:<port>/#project/<id>`.

The child is placed in its own process group and terminated as a group, so the
Chrome instances the render pipeline spawns go with it. `StudioServer::drop`
reaps it on every exit path, and the `ExitRequested`/`Exit` handler does it
explicitly.

Before a project is chosen, the window shows a placeholder page served by a
small loopback listener. The embedded server is single-project by construction
(`createStudioServer` takes one `projectDir`), so there is nothing to serve
until the user picks something. Opening a different project restarts the
sidecar rather than re-pointing at it.

## Choosing the runtime: bun, not Node

The sidecar runs on **bun**, not Node.

- Homebrew's `node` is a dylib-linked shim over `/opt/homebrew/Cellar`, so
  copying the binary into a `.app` drags a Cellar of dylibs with it or fails to
  launch. `otool -L` shows 14 non-system dylibs.
- A Node.js.org macOS tarball _is_ self-contained, but that adds a network
  download to every build.
- `bun` is a single self-contained Mach-O linking only against stock macOS
  system libraries (`libicucore`, `libresolv`, `libc++`, `libSystem`). It is
  also already this repo's package manager, so dev and production run identical
  JavaScript and the build needs no new download.
- The one native dependency that could have ruled this out — `sharp`, used for
  thumbnails — is a prebuilt N-API addon and loads fine under bun from a
  `node_modules` staged exactly as it is in the bundle. Verified: `sharp`
  produced a PNG from the staged tree.

## The runtime dependency set

`stage-runtime.mjs` derives it from `packages/cli/package.json`, filtering out
`workspace:*`. It does not hand-maintain a list, so it cannot drift. The CLI
bundles every `@hyperframes/*` workspace package into `dist/cli.js` (tsup
`noExternal`), so only its npm dependencies stay external. That comes to about
86 MB, against 1.5 GB for the repository's own `node_modules`.

A `package.json` named `hyperframes` is written beside the bundle. Two reasons:
the render pipeline stamps provenance by walking up from its own module URL
looking for a package.json whose name matches
`/^(?:hyperframes|@hyperframes\/[^/]+)$/`, and `cli.js` is ESM, so the nearest
`package.json` needs `"type": "module"`.

The staged `bun` is chmod'ed `0755` explicitly. `tauri-build` copies resources
with `fs::copy`, which propagates the mode and then re-copies on the next
build; overwriting a `0555` destination fails with `EACCES` on macOS and
surfaces as an opaque `Permission denied` from the build script.

## Security

The webview gets no native access at all.

- `withGlobalTauri` is `false`, so there is no `window.__TAURI__`.
- `capabilities/main.json` declares **no permissions and no `remote` block**.
  Tauri treats `http://127.0.0.1` as a remote origin, so that document is
  denied every IPC command. The list stays empty unless a specific need
  appears.
- No `fs`, `shell`, `process`, `http` or `dialog` plugin is installed. The
  folder picker is `rfd`, called from Rust — a Tauri dialog plugin would have
  put a dialog capability in the bundle, and picking a folder is the one
  privileged action the app performs.
- The server binds `127.0.0.1` only.
- `dragDropEnabled` is **off**. Tauri otherwise intercepts OS file drops and
  re-emits them as its own drag-drop event, so the webview never sees the HTML5
  drop — and Studio imports assets through exactly that
  (`e.dataTransfer.files` in `AssetsTab`, `FileTree`, `useStudioContextValue`).
  With the default, Finder/Explorer → Studio media import silently stops
  working.
- Devtools are on in debug builds and off in release.
- `127.0.0.1` is a secure context, so the `navigator.clipboard` calls Studio
  makes in six components keep working. Another reason not to use a custom
  scheme.

`app.security.csp` was removed. Tauri only applies it to documents it serves
itself — it is baked into the embedded asset map at build time
(`tauri-codegen`'s `EmbeddedAssets`) and applied as a response header by the
`tauri://localhost` protocol handler (`tauri/src/protocol/tauri.rs`) and the
isolation pattern. The window here loads `WebviewUrl::External`, so the
document is fetched straight from the Studio server and Tauri is not in the
response path. Verified in the running webview: `document.querySelectorAll
('meta[http-equiv]')` is empty and Chrome reports the same for the same build,
so the policy was never applied. Keeping it would have been a security
guarantee the app did not actually provide.

`frontendDist` stays: `tauri-build` requires it to be a real directory. It
holds only `dist/index.html`, a comment explaining that nothing is ever served
from it, and is never displayed.

## Teardown

Two mechanisms reap the sidecar, and they cover different failures.

**`sidecar::terminate` is the normal path.** The child is put in its own
process group, and on every exit path — window close, Cmd+Q, a panic on the
main thread — `StudioServer::drop` sends `SIGTERM` to the group, waits three
seconds, then sends `SIGKILL` to whatever is left. The `ExitRequested`/`Exit`
handler also drops the state explicitly, while the child can still be waited on.

Re-measured in the ad-hoc-signed `OpenVids.app` with `--foreground` in place:

```text
[openvids] killpg(<pgid>, SIGTERM) -> 0
```

so the group *is* signalable from the running app and the graceful-then-fatal
sequence runs to completion. After quitting through the app menu, no
`serve.mjs`, no `hyperframes/cli.js`, no Chrome, and no listener on the port
remain. An earlier note in this file claimed `EPERM` here; that was measured
before `--foreground` was added, when the CLI re-exec'd itself detached, so the
pid the app held was not the process group the app believed it owned. With
`--foreground` the child is the CLI itself, in the app's group, and the signal
works.

**`sidecar/serve.mjs` is the backstop.** The app can only reap what it owns
while its own shutdown code runs. A `SIGKILL` of OpenVids, a crash, or a
logout never reaches `Drop` at all. The launcher therefore records
OpenVids' pid and, while `process.kill(pid, 0)` — a permission probe, not a
signal — keeps succeeding, leaves the server alone; when the probe starts
failing the app is gone and the server is killed outright. The launcher does
not exit until the server has actually been reaped.

**`--foreground` is load-bearing for both.** Without it the CLI reads a
non-TTY stdin as "run this in the background", re-execs itself detached, and
the original process exits — leaving a server the app cannot signal and the
launcher cannot supervise. `--foreground` is the CLI's own documented flag for
exactly this.
The loopback port is chosen per-launch, so a reaped server releases it
immediately.

## Known limitation: the loopback API is unauthenticated

The Studio server on `127.0.0.1` exposes project file read/write/delete, render
spawning and media proxy transcoding with no authentication — this is upstream
HyperFrames behaviour, and OpenVids does not change it. Any other local process,
and any web page the user visits, can reach that port while OpenVids is running.
The port is chosen per-launch and is not guessable in advance, but it is
discoverable (it is in the window's own origin, and on macOS `lsof` lists it).

This is reported, not redesigned. If it ever needs addressing, the fix belongs
in `@hyperframes/studio-server`: an unguessable token that the CLI injects into
the served page and requires on every `/api` request. Doing it in the Tauri
shell instead would mean patching served HTML, which is the kind of second
convention this app exists to avoid.

## Rendering and thumbnails

Both need a real Chrome. OpenVids ships none: the Studio runtime resolves one
through the existing `findSystemChrome()` probe, which honours
`PRODUCER_HEADLESS_SHELL_PATH` and otherwise looks in the puppeteer cache and
at well-known system paths. On a machine with Chrome installed, thumbnails and
renders work. Bundling a headless shell is a packaging decision that was left
out of this change; `ffmpeg` is likewise still expected on the host.
