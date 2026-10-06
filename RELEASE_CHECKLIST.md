# OpenVids release checklist

Run for every release candidate. A release is not ready until every **gate** passes on the commit being shipped.
Record the results (commit, numbers, timings) in the release notes.

## 1. Build and static checks (gate)

```bash
bun install
bun run build
bun run typecheck          # every workspace
bun run lint               # workspace contracts, package cycles, subpaths, oxlint, skills
bunx oxfmt --check $(git diff --name-only <last-release>..HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.md' '*.json')
bun run desktop:check      # desktop typecheck + cargo check
```

## 2. Test suites (gate)

Build first: several packages test against the built `dist` of `agent-protocol` and `studio-server`.

```bash
for p in agent-protocol agent-runtime studio-server studio cli core engine producer; do
  bun run --cwd packages/$p test
done
```

Studio's vitest prints a "close timed out" notice on exit; that is not a failure. A test that fails only under
heavy load must be re-run alone and investigated before it is waived.

## 3. Real end-to-end scenarios (gate)

Use real material (public-domain / CC0 test media, never private user files) and the models configured in
`~/.openvids/agent/settings.json`. Drive headless first (`bun packages/cli/dist/cli.js preview <project> --port N
--no-open --foreground` + the agent API), then repeat the key steps in the packaged app.

**Short-form** — a new project (blank template) with 4–6 real clips, 2 pictures and a music track; prompt
"Make me a polished 25-second video about … from these assets."

- [ ] Director delegates; the timeline is built; text/captions, music.
- [ ] The Director's reply before render QA is shown as an interim note; the final report comes after QA.
- [ ] Render QA runs (render → checks → Vision), a correction is made if issues are found, the re-render is checked.
- [ ] A follow-up that needs outside material uses Research (trusted sources) with provenance; the export license
      check is clean or warns.
- [ ] Export (high) produces a valid MP4: `ffprobe` shows H.264 High + AAC, `ffmpeg -f null` decodes without error,
      duration as requested.

**Long-form** — a real 20–30 min talk with several speakers.

- [ ] Analysis: transcript without hallucination loops (check `transcript.json` for repeated sentences), speakers,
      silence, shots, takes; cached (a second job returns immediately, also after a server restart).
- [ ] Story plan; a manual Story edit (reorder, lock, user durations, a Missing Asset node); Review with AI keeps
      every user decision.
- [ ] Build Story with captions; no template placeholder left on the timeline.
- [ ] Manual timeline edit + Story edit; the sync report shows the manual edit and the affected sections;
      Rebuild affected keeps the manual edit.
- [ ] Find missing material resolves the Missing Asset from a trusted source; Rebuild places it.
- [ ] Without a render request, QA is skipped for compositions over 3 minutes and the Director's final answer says
      so (no promised check that never comes).
- [ ] "Render the final video" renders, Render QA checks that render, corrections are re-rendered in the same
      quality, the final file is valid.

## 4. Reliability (gate)

- [ ] Stop during an edit, a render, an analysis job, an import and render QA: the turn ends `aborted`, the
      checkpoint closes after every write, nothing lands in the next turn.
- [ ] SIGKILL the agent runtime mid-turn (macOS/Linux; on Windows kill the runtime tree from Task Manager): the turn becomes `interrupted`, its checkpoint is recovered, Revert works.
- [ ] SIGKILL the Studio server mid-render / mid-analysis (macOS/Linux; on Windows kill the sidecar tree from Task Manager): after restart no `renders/work-*` or transaction temp
      files, no orphan Chrome/ffmpeg/whisper, history intact.
- [ ] Revert a turn: files restored; QA reports kept and marked outdated; analysis cache still fresh; story
      graph/sync/provenance consistent.
- [ ] Full app restart: chats, turns (incl. Render QA cards and interim notes), reports, story and analysis intact.
- [ ] Damaged `.hyperframes` files (chat log tail, story graph, QA report, provenance, `hyperframes.json`) do not
      crash the server or the runtime.
- [ ] After quitting the app (menu and ⌘Q / Alt+F4), no OpenVids, Studio server, agent runtime, Chrome, ffmpeg or whisper
      process is left (macOS/Linux: `ps -axo pid,ppid,command`; Windows: Task Manager / `tasklist`).

## 5. Security (gate)

- [ ] `Host: evil.example` → 403 on `/`, `/__hyperframes_config`, `/api/*`.
- [ ] Cross-site `POST` (text/plain, foreign `Origin`) → 403; same-origin and no-Origin (runtime) requests work.
- [ ] Research: private/loopback/link-local targets and redirects to them are refused; DNS answers are pinned.
- [ ] The agent runtime only listens on 127.0.0.1 and refuses requests without the bearer token.
- [ ] No API key or token in chat logs, QA reports, provenance, stdout/stderr of the app, or child process
      arguments (`grep -r` the project's `.hyperframes` and the app log for the key).
- [ ] Agent file tools cannot leave the project, touch `.hyperframes/`, or change a clip locked on the timeline.

## 6. Stress (gate)

- [ ] A project with 100+ clips (150+ `<video>` elements, 8+ sources incl. a multi-GB file) with Story, captions,
      B-roll and motion opens in the packaged app, plays and scrubs for 2 minutes, under memory pressure
      (`memory_pressure`, swap > 80 % used) without a WKWebView stall. If WebContent hangs, `sample` the WebContent
      and GPU processes and compare with the known deadlock signature
      (`RemoteAudioSession::tryToSetActive` ↔ `AVAssetResourceLoader dealloc`).

## 7. Packaged app: DMG + NSIS installer (gate)

```bash
bun run desktop:build
# macOS:
hdiutil attach apps/desktop/src-tauri/target/release/bundle/dmg/OpenVids_*_aarch64.dmg
# Windows (from the release job or a Windows build machine):
# apps/desktop/src-tauri/target/release/bundle/nsis/OpenVids_*_x64-setup.exe
```

- [ ] macOS: the DMG mounts, contains `OpenVids.app` and the Applications link; the app copied from it launches.
- [ ] macOS: `codesign --verify --deep --strict OpenVids.app` passes (the bundle is ad-hoc signed by default,
      `signingIdentity: "-"`). A public download additionally needs a Developer ID build
      (`APPLE_SIGNING_IDENTITY`) and notarization (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`); record
      `spctl -a -vv` (`rejected` for ad-hoc builds, `accepted … Notarized Developer ID` for a public one).
- [ ] Windows: the NSIS `OpenVids_<v>_x64-setup.exe` installs per-user, bootstraps WebView2 if needed, and the installed app launches (accept the SmartScreen unknown-publisher warning: the build is not code-signed).
- First Windows release: publish the draft so `latest.json` exists at the updater's `latest/download` URL, then check Settings → General → Check for updates from an older installed build.
- [ ] Windows: `latest.json` carries the `windows-x86_64` platform entry (signature + URL) next to `darwin-aarch64`; the in-app update downloads the setup, verifies the signature, and runs the passive install.
- [ ] Windows clean-machine checks: install → launch → System check finds Chrome/FFmpeg (or the FFmpeg download button installs the gyan.dev build into `%USERPROFILE%\.openvids\ffmpeg` with byte progress) → Home → create a new project → open it → chat turn → Render QA card → Export → quit leaves no `bun.exe`, Chrome or ffmpeg behind in Task Manager.
- [ ] macOS clean-machine check: Home → create a new project → open it → chat turn → Render QA card → Export → quit.

## 8. Beta channel (gate for a beta tag, e.g. `v0.5.0-beta.1`)

A beta is a tag on `main` with a pre-release version (`bun run desktop:version 0.5.0-beta.1`); the stable run of
this checklist applies to it too. Beta-only features (`BETA_FEATURES`, `OV.betaFeatures()`) are on in it and
off in every stable build.

- [ ] The tag, `desktop:version --check` and the app version agree; the version is `x.y.z-<pre-release>`.
- [ ] The release workflow produced a draft that is a **pre-release** with `beta.json` (not `latest.json`),
      `OpenVids_<v>_aarch64.{dmg,app.tar.gz,app.tar.gz.sig}` and `OpenVids_<v>_x64-setup.exe(.sig)`; `beta.json` lists
      `darwin-aarch64` and `windows-x86_64` with URLs inside that release and signatures equal to the `.sig` files.
      Verify both signatures with `minisign -Vm` against the updater key.
- [ ] Stable is untouched: `https://github.com/bazodev/open-vids/releases/latest/download/latest.json` still answers
      the previous stable version (a draft or a pre-release never becomes "latest").
- [ ] Publish the draft (not before: a draft must not move the channel). The Beta manifest workflow succeeds and
      `https://github.com/bazodev/open-vids/releases/download/channel-beta/beta.json` carries the new version; the
      `channel-beta` release is a pre-release and not marked latest.
- [ ] Data safety: a project and the settings written by this beta open in the previous stable build (or the beta
      migration made a backup); the beta changed no file format irreversibly.
- [ ] Packaged app, stable build with **Get beta versions off**: Settings › General › Check for Updates does not
      offer the beta. Turn it **on**: a check starts at once and offers the beta; "Update and Restart" installs it
      (macOS and Windows), the version row shows the **Beta** badge, beta-only features appear.
- [ ] From a beta: the next beta is offered (`0.5.0-beta.1` → `0.5.0-beta.2`); when the matching stable release is
      published it is offered next (`0.5.0-beta.N` → `0.5.0`) and installs over the beta.
- [ ] Turning the switch off on a beta does not roll back: the app stays on the beta, the stable-download link opens
      the latest stable release, and only a newer stable version is offered.
- [ ] Windows: the NSIS installer of a beta shows `0.5.0-beta.N` in Apps & features and updates in place (passive
      install over a previous beta/stable).
- [ ] Release notes (the tag message) say that it is a beta and what is experimental.

## 9. Documentation

- [ ] Release notes: commit, test counts, E2E results, timings, known limitations.
- [ ] Roadmap/status updated; `AGENTS.md` and package READMEs describe any changed contract.
