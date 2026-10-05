# Hyperframe Runtime Engine

This folder owns the runtime that powers preview and producer parity.

## Current Direction

- Runtime source of truth is converging on `hyperframe.ts`.
- Build produces:
  - `dist/hyperframe.runtime.iife.js` (browser bootstrap)
  - `dist/hyperframe.runtime.mjs` (tooling/tests)
  - `dist/hyperframe.manifest.json` (version + sha256 + artifact map)
- FE owns iframe runtime injection.
- BE persists raw generated HTML without injecting runtime scripts.
- Producer validates pinned runtime checksum from manifest before render.

## Runtime Contract (Stable Surface)

Globals:

- `window.__player`
- `window.__playerReady`
- `window.__renderReady`
- `window.__timelines`
- `window.__clipManifest`

postMessage:

- parent -> runtime control:
  - `source: "hf-parent"`
  - `type: "control"`
  - actions: `play`, `pause`, `seek`, `set-muted`, `set-playback-rate`, `enable-pick-mode`, `disable-pick-mode`
- runtime -> parent events:
  - `source: "hf-preview"`
  - `type: "state"` carries the whole `frame`, the exact `currentTime` in seconds and
    `ended`, true once the clock has reached the film's end; a parent ends the film on
    `ended` rather than comparing times, and a pause on the last frame stays a pause
  - `type: "timeline"` carries `assetsReady` (whether the
    composition's media, images and fonts have settled) and the runtime then posts
    `type: "assets-ready"` once, so a parent that cannot read the iframe can gate playback
  - `type: "ready"` — emitted once when `installRuntimeControlBridge` registers
    the control-message listener. The parent uses it to replay current playback
    state (`set-muted`, `set-volume`, `set-playback-rate`) so any control
    message sent before the listener was installed isn't lost. Emitted again on
    every iframe reload because the new runtime instance starts with no state.

Determinism baseline:

- `renderSeek` is the producer-canonical seek path.
- 30fps quantization and readiness gates are correctness requirements.

Preview media budget (`previewMediaBudget.ts`):

- Only a page the Studio server marked as a preview (`<meta name="hyperframes-studio-preview">`)
  and that no render is driving (`__HF_EXPORT_RENDER_SEEK_CONFIG`, `__HF_RENDER_CAPTURE_MODE`)
  runs it. A render, capture, thumbnail or `check` page never does, so their frames are unchanged.
- WebKit opens an AVURLAsset (a byte stream in the GPU process) for every `<video src>` /
  `<audio src>` the parser meets, and deleting players whose asset is still opening deadlocked the
  WebContent and GPU processes. So the preview server serves its media opening nothing at parse
  (`deferPreviewMedia` in studio-server), and the runtime does the same to compositions it mounts
  itself (`importPreviewNode`, scene swaps, `deferPreviewMediaSources`) before they reach the live
  document:
  - a managed video holds no `src` (the source in `data-hf-detached-src`, `preload="none"`).
    Managed is `isPreviewManagedVideo` (studioPreviewMark.ts): a `<video src>` with an authored
    `data-duration`, no `<source>` children, no `loop`, no `data-var-src`;
  - paced audio keeps its `src` (the Web Audio transport captures and decodes it from there) with
    `preload="none"`. Paced is `isPreviewPacedAudio`: an `<audio src>` under the same conditions.
    A clip whose length comes from the decoder is left alone.
- Paced audio is never released: the budget switches it to `preload="auto"` when it sits under the
  playhead, starts within `RETAIN_AHEAD_SECONDS` or is among the next `RETAIN_UPCOMING_CLIPS`,
  sharing the load slots below with the videos; an opening one also holds back every release.
- The budget attaches a source only to videos that are playing, leased (scrub audio, grading
  preview), hold the last frame of the film, sit inside the playhead's window
  (`RETAIN_BEHIND_SECONDS` behind, `RETAIN_AHEAD_SECONDS` ahead, the next `RETAIN_UPCOMING_CLIPS`),
  capped at `MAX_ACTIVE_PREVIEW_MEDIA` by distance from the playhead; clips playing or under the
  playhead may exceed the cap. At most `MAX_IN_FLIGHT_LOADS` loads (attach until metadata, error or
  abort) are in flight (`MAX_IN_FLIGHT_URGENT_LOADS` for the clips under or about to reach the
  playhead), nearest first; a settling load plans the next attach.
- A source is released (`src` removed, `load()`) only once its load has settled and no other load is
  in flight, in batches of `DETACH_BATCH_SIZE` per `DETACH_INTERVAL_MS`, farthest first. A load that
  stalls for `LOAD_STALL_MS` stops counting toward the limit but is still never released.
- A paused playhead that keeps jumping is a scrub: sources are planned once it rests
  `SCRUB_SETTLE_MS`, not for every stop on the way.
- Everything that reads a clip's source from the preview document goes through
  `readPreviewMediaSrc`; the DOM (`data-hf-detached-src` without `src`) is the only state.

## Build

```bash
bun run --filter @hyperframes/core build:hyperframes-runtime
```

## Security Expectations

- Runtime bootstrap URL must be version-pinned and host-allowlisted.
- Iframe bridge payloads must be schema-validated.
- Unsafe URL schemes (`javascript:` and unapproved `data:`) are rejected.
- Fail closed if runtime bootstrap/handshake is not healthy.

## Product Editing Model

- Primary mode: prompt + element picking.
- Secondary mode: manual precision controls.
- Avoid timeline-first manual workflows as default product path.
