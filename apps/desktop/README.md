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
bun run desktop:version  # set/verify the app version (see Releasing)
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

## Menus

**File > Open Project Folder…** (`⌘O`) switches projects and records the
choice in recents. **File > Show All Projects** (`⌘⇧O`) stops the Studio
sidecar and returns to the Projects home screen — so does the **Projects**
back button in Studio's header (top-left, where the logo sits when Studio
runs inside OpenVids). Both take the same path: the button is a plain
document navigation to the home origin (the webview has no IPC by design),
and an `on_navigation` hook on the main window runs the shared cleanup
(stop sidecar, forget the project, idle the open phase) when that
navigation lands. Outside OpenVids the logo renders exactly as before.
**Edit** supplies macOS text-field Undo/Redo, Cut/Copy/Paste and Select All;
**Window** owns Minimize, Full Screen and Close Window. **View > Reload**
(`⌘R`) reloads the current window without dropping the open project.

For a Code-tab edit that has saved to disk but has not appeared in the preview,
use **View > Reload**; see the limitation below.

## Updates

OpenVids updates itself with `tauri-plugin-updater`. It is a Rust-only path: the webview holds no
capability for the plugin, and the pages only see the token-gated home API:

- `GET /api/update/status` — the current phase (`checking`, `available`, `downloading`, `ready`,
  `failed`, …) plus the version, release notes, download progress or the failure.
- `POST /api/update/check` — ask the release feed (GitHub Releases `latest.json`) for a newer
  version.
- `POST /api/update/install` `{ "force"?: boolean }` — download, verify the signature, install and
  restart. Nothing is downloaded without this call.

**Check for Updates…** in the app menu runs the same check: with the Projects page open it opens
Settings › General, where the page shows progress and the install button; with a project open Rust
shows native dialogs instead. When `updates.autoCheck` (Settings › General, default on) is set,
release builds also do one quiet check about 15 seconds after launch and the Projects page shows an
unobtrusive mark — still nothing is downloaded or installed until the user asks for it.

A downloaded archive is authenticated with a minisign signature checked against the updater key in
`tauri.conf.json` (`plugins.updater.pubkey`); the private key exists only as a GitHub Actions
secret. `requireSignedVersion` is on: the signature's trusted comment carries the version the
archive was built for, so a tampered `latest.json` cannot pair a new version number with an older
signed archive. A failed check leaves the installed bundle untouched. See [Releasing](#releasing).

Installing first stops what the app runs — the Studio sidecar's process group, the agent runtimes
and running install jobs — the same way quitting does (`stop_owned_processes` in `lib.rs`), and
moves the window back to the Projects page. If the open project is mid-render or an agent turn is
running, the app asks for confirmation first ("Update and Restart" / "Restart Anyway"); a download
that finishes while the project is busy waits in `ready` and asks again. The plugin then replaces
the installed bundle (`/Applications/OpenVids.app`) and the app quits; a detached `/bin/sh` waits
for the old pid to exit and opens the new bundle with `/usr/bin/open`, as Finder would. It does not
use Tauri's in-place restart: that execs the new binary as a child of the old process, and in the
manual run the new window stayed behind the other apps and the new binary read the Documents folder
under the old binary's permission instead of asking for its own (see below). Each update downloads
the full `.app.tar.gz` archive; layered or delta updates are a separate future task.

### macOS permissions and Gatekeeper after an update

Measured with an ad-hoc-signed 0.1.0 installed in `/Applications` and updated to 0.1.1 through the
button:

- **TCC.** An ad-hoc signature's designated requirement is its code hash
  (`codesign -d -r-` prints `designated => cdhash H"…"`), and every build has a different one. TCC
  grants are bound to that requirement, so the updated app is a new client: the first launch of
  0.1.1 through LaunchServices asked again for access to the Documents folder (where the recent
  projects live), although 0.1.0 had been allowed. Every update repeats this for every protected
  location the app touches
  (Documents, Desktop, Downloads, removable volumes); the stale grants stay in System Settings ›
  Privacy & Security. Only a stable signing identity (Developer ID) keeps grants across updates.
- **Gatekeeper.** The plugin unpacks the archive itself, so the new bundle carries no
  `com.apple.quarantine` attribute (`xattr` shows only `com.apple.provenance`); Gatekeeper does
  not assess it and the app opens without a prompt. `codesign --verify --deep --strict` passes;
  `spctl -a` still says `rejected`, as it does for every ad-hoc build. Only the first install from a
  downloaded `.dmg` meets Gatekeeper (System Settings › Privacy & Security › Open Anyway, or
  `xattr -dr com.apple.quarantine /Applications/OpenVids.app`).

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
    src/home.rs            Projects home screen: lifetime-owned loopback server
    src/home_page/         The Projects page + Settings window (HTML/CSS/JS, compiled in;
                           ported from the OpenDesign prototype, both themes)
    src/home_routes.rs     Home HTTP plumbing: routing, pages/assets, open/pick/thumbs
    src/home_api.rs        Preferences, metadata, duplicate/reveal/locate, recents undo,
                           composer files, start-from-chat, agent-runtime proxy routes
    src/home_create.rs     POST /api/create (scaffold, then open)
    src/home_project.rs    Rename (folder + meta.json) and Trash handlers
    src/home_auth.rs       Per-launch token + Host/Origin checks
    src/prefs.rs           ~/.openvids/app/preferences.json (shared with Studio)
    src/project_meta.rs    Duration + clip count from index.html (cached by mtime)
    src/intake.rs          Start-from-chat: folder name, file import, intake.json
    src/drop_paths.rs      Real paths of an OS drop (macOS drag pasteboard)
    src/agent_proxy.rs     Lazy project-less agent runtime for models/settings
    src/recents.rs         recents.json persistence (dedupe, sort, rename, undo, relink)
    src/structure.rs       index.html + data-composition-id validation, patching
    src/create.rs          Blank-template scaffold (fps/size/duration, meta.json)
    src/thumbnails.rs      Background thumbnail refresh from Studio
    src/project.rs         Directory -> Studio project id
    src/updater.rs         In-app updates: check, download + install, restart
    capabilities/main.json Window dragging for the loopback pages, nothing else
  sidecar/
    serve.mjs              Parent-death watch; see "Teardown" below
```

### Development

`beforeDevCommand` runs `serve-studio-dev.mjs`, which builds the workspace deps,
registers `OPENVIDS_PROJECT`, and starts Studio's Vite dev server on a fixed
strict port. The window then loads `devUrl` from `tauri.conf.json`. No sidecar,
no bundling, full HMR.

The base Tauri config deliberately has no bundled runtime resources: a fresh
clone can start dev mode or run `cargo check` before the production payload is
staged. Tauri generates `gen/schemas` as needed.

The icons are tracked. Their source is `src-tauri/icons/app-icon.svg` (the
design's app icon, inset to the macOS icon grid: an 824 px tile centered on a
1024 px canvas). To regenerate after changing it, run
`bun run tauri icon src-tauri/icons/app-icon.svg -o /tmp/ov-icons` and copy the
files that `bundle.icon` in `tauri.conf.json` lists, plus `icon.png`, into
`src-tauri/icons/`.

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

`tauri.prod.conf.json` supplies the runtime resource paths only to
`desktop:build`, after staging has created them. They are bundled into the app;
nothing in the shipped app refers to the monorepo. `scripts/tauri-build.mjs` runs
`tauri build --config src-tauri/tauri.prod.conf.json`; when no
`TAURI_SIGNING_PRIVATE_KEY` is set it adds a second `--config` that turns
`bundle.createUpdaterArtifacts` off, so local builds do not need the release key
(see [Releasing](#releasing)).

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

Before a project is chosen, the window shows the Projects home screen
served by a small loopback listener that lives for the whole app lifetime
(never dropped on project open, so File > Show All Projects is a plain
navigation back). The embedded server is single-project by construction
(`createStudioServer` takes one `projectDir`), so there is nothing to serve
until the user picks something. Opening a different project restarts the
sidecar rather than re-pointing at it; the home server is untouched.

## Releasing

The app version has one source of truth: `[package] version` in
`src-tauri/Cargo.toml`. Tauri reads it from there because `tauri.conf.json` sets
no `version`; two files mirror it — `apps/desktop/package.json` and the
`openvids-desktop` entry in `src-tauri/Cargo.lock`. `bun run desktop:version
0.1.1` writes all three, prints what changed, and `bun run desktop:version
--check` (also part of `bun run lint`) prints the mismatch and exits 1. The
version is bare semver — the tag is `v0.1.1`, the version is `0.1.1`; a leading
`v` is rejected.

To cut a release:

1. `bun run desktop:version 0.1.1`, commit the change.
2. Tag it with the release notes and push the tag:

   ```bash
   git tag -a v0.1.1 -m "OpenVids 0.1.1 — what changed…"
   git push origin v0.1.1
   ```

   The annotated tag's message becomes the release notes (`latest.json` and the
   GitHub Release).

3. `.github/workflows/release.yml` checks that the tag and the app version
   agree, builds with the release key, writes `latest.json` and creates a
   **draft** GitHub Release holding `OpenVids_<v>_aarch64.dmg`,
   `OpenVids_<v>_aarch64.app.tar.gz` (+ `.sig`) and `latest.json`.
4. Check the draft and publish it. The updater endpoint
   `releases/latest/download/latest.json` only resolves once the release is
   published — GitHub serves “latest” from published, non-prerelease releases,
   never from drafts.

The build signs updates with the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. In the workflow
`OPENVIDS_RELEASE=1` makes a missing key a hard error; on a development machine
`bun run desktop:build` without the key skips updater artifacts instead
(`scripts/tauri-build.mjs` adds a `--config` that turns them off) and says so.

To exercise an update locally, build with the updater pointed at a loopback feed
and sign with a throwaway key. The extra `--config` is appended last, so it wins
over `tauri.conf.json`; keep any of this out of the committed configs:

```bash
# A throwaway key pair (its public key goes into the --config below).
bun run --cwd apps/desktop tauri signer generate -w /tmp/openvids-test.key -p test

# Build the app as usual, with the updater pointed at a local feed.
TAURI_SIGNING_PRIVATE_KEY=/tmp/openvids-test.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test \
bun run --cwd apps/desktop build -- \
  --config '{"plugins":{"updater":{"endpoints":["http://127.0.0.1:8000/latest.json"],"dangerousInsecureTransportProtocol":true,"pubkey":"<the test public key>"}}}'

# Serve the feed: latest.json (version, notes, pub_date, darwin-aarch64.signature/url)
# plus the OpenVids.app.tar.gz from the bundle. The signature is the .sig file's contents.
cd /tmp/ov-feed && python3 -m http.server 8000
```

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

## Agent runtime

Agent Chat is backed by a **separate local Bun process**, not the Studio sidecar and not the
browser bundle. `packages/studio-server` (inside the Studio sidecar) owns a gateway at
`/api/projects/:id/agent/*` that lazily spawns `runtime/agent-runtime/main.ts` with the staged `bun`,
proxies to it over loopback with a per-launch bearer token (never exposed to the webview), restarts
it with back-off if it dies, and kills it on shutdown; the runtime also exits when its parent pid
disappears. If the runtime is missing or crashes the editor keeps working and the Chat panel shows
"Agent unavailable". See `packages/agent-runtime/README.md` for the process contract.

The runtime runs the Director, the per-chat specialists (Editor, Vision, Motion Designer, Research,
Audio) and the Jev worker. Chat state stays in each project (`.hyperframes/agent/`); per-user agent
settings live outside the app bundle in `~/.openvids/agent/` (override with
`OPENVIDS_AGENT_SETTINGS_DIR`): `settings.json` and `jev-credentials.json`, which holds a user secret
(Jev API key). Both are mode 0600, are never staged or bundled, and survive app updates.

`stage-runtime.mjs` stages it as `runtime/agent-runtime/` (sources, the vendored protocol package and
its own `bun install` of the OMP SDK), bundled through `tauri.prod.conf.json`. **Size:** the OMP SDK
brings native and onnx packages; unused voice/memory engines are pruned at staging, leaving about 500 MB
(mostly `@oh-my-pi/*` natives, 277 MB; before pruning `onnxruntime-node` and `onnxruntime-web` added
434 MB) against 194 MB for the Studio runtime. Override discovery with `OPENVIDS_AGENT_RUNTIME_ENTRY` (absolute path to `main.ts`)
and `OPENVIDS_AGENT_BUN`. `OPENVIDS_SKIP_AGENT_RUNTIME=1` stages an empty `agent-runtime/` (so the
Tauri resource mapping still resolves) without sources or dependencies; Chat then reports "Agent unavailable".

## Security

The webview gets no native access beyond moving its own window.

- `withGlobalTauri` is `false`, so there is no `window.__TAURI__`.
- The window uses an overlay titlebar (traffic lights over the pages' own 52 px
  titlebar). `capabilities/main.json` grants the loopback pages
  (`remote.urls`: `http://127.0.0.1:*`, `http://localhost:*`) exactly
  `core:window:allow-start-dragging` and `allow-internal-toggle-maximize`, so
  `data-tauri-drag-region` titlebars drag and double-click-zoom the window.
  No other IPC command is reachable.
- The Projects page's own agent runtime (`agent_proxy.rs`): the model catalog
  and agent defaults are needed before any Studio sidecar exists, so the home
  server lazily spawns the same runtime with a per-launch bearer token that
  never reaches the webview, and proxies only `/v1/models` and `/v1/settings`
  behind the home token.
- OS file drops on the Projects page still arrive as HTML5 drops (see below);
  the page posts the dropped _names_ and Rust reads the real paths off the
  macOS drag pasteboard (`drop_paths.rs`), keeping only matching names. Files
  are copied (APFS clones) into `<project>/assets/` on Start — nothing is
  streamed through JavaScript.
- No `fs`, `shell`, `process`, `http` or `dialog` plugin is installed. The
  folder picker is `rfd`, called from Rust — a Tauri dialog plugin would have
  put a dialog capability in the bundle, and picking a folder is the one
  privileged action the app performs.
- Trash uses the `trash` crate's `NsFileManager` backend
  (`trashItemAtURL`), not its default Finder AppleScript: the script path
  shells out to `osascript` and never returns without a GUI session to
  answer it (observed live: every `/api/trash` request hung until the
  client timed out), while `trashItemAtURL` completes synchronously. The
  trade-off is no Finder "Put Back" undo entry.
- The servers bind `127.0.0.1` only.
- The Studio project URL carries an `openvidsHome` query parameter naming
  the home origin, so the header can offer its back button. Studio validates
  it before navigating: only `http://127.0.0.1:<port>` and
  `http://localhost:<port>` origins are accepted — remote hosts, `file:`,
  `javascript:`, credentials, paths and query strings are rejected and the
  logo stays. The value is built by Rust from a bound loopback port, and the
  query survives View > Reload; the prod Hono server ignores it via its SPA
  fallback.
- The home-screen API is token-gated: a 128-bit per-launch token
  (`home_auth::HomeToken`, OS randomness) is injected into the served HTML
  and required as `X-OpenVids-Token` on every `/api` request; `Host` must
  name the server and a present `Origin` must match it, so a foreign website
  that guesses the port still cannot trigger pickers or deletes. Plain
  page/thumbnail GETs stay open so `<img>` tags load without scripting.
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

`frontendDist` stays: Tauri's release codegen checks that it names a real
directory. Debug `cargo check` uses `devUrl` and skips embedding those assets,
so it does not prove this check. The tracked `dist/index.html` placeholder makes
a fresh clone buildable without a separate frontend build; the webview never
displays it.

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

so the group _is_ signalable from the running app and the graceful-then-fatal
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

## Known limitation: Code-tab preview can remain stale

Studio autosaves Code-tab edits to the project file, but its embedded-mode
preview does not reliably live-reload the changed source. The same behaviour
reproduces in upstream Chrome without OpenVids. **View > Reload** shows the
saved change; it does not perform an additional save.

## Known limitation: the Studio loopback API is unauthenticated

The Studio server on `127.0.0.1` exposes project file read/write/delete, render
spawning and media proxy transcoding with no authentication — this is upstream
HyperFrames behaviour, and OpenVids does not change it. Any other local process,
and any web page the user visits, can reach that port while OpenVids is running.
The port is chosen per-launch and is not guessable in advance, but it is
discoverable (it is in the window's own origin, and on macOS `lsof` lists it).

The Projects home-screen API does not share this limitation: it mints a
per-launch token (see Security above). Only the Studio server itself is
reported, not redesigned — the fix belongs in `@hyperframes/studio-server`.

## Rendering and thumbnails

Both need a real Chrome. OpenVids ships none: the Studio runtime resolves one
through the existing `findSystemChrome()` probe, which honours
`PRODUCER_HEADLESS_SHELL_PATH` and otherwise looks in the puppeteer cache and
at well-known system paths. On a machine with Chrome installed, thumbnails and
renders work. Bundling a headless shell is a packaging decision that was left
out of this change; `ffmpeg` is likewise still expected on the host.
