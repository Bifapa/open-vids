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
  runs it. A render, capture or `check` page never does, so their frames are unchanged.
- A preview document with many `<video>` clips would keep one decoder per element alive. The budget
  keeps a source only on videos that are playing, leased (scrub audio, grading preview), hold the
  last frame of the film, sit inside the playhead's window (`RETAIN_BEHIND_SECONDS` behind,
  `RETAIN_AHEAD_SECONDS` ahead, the next `RETAIN_UPCOMING_CLIPS`), capped at
  `MAX_ACTIVE_PREVIEW_MEDIA` by distance from the playhead. Clips playing or under the playhead may
  exceed the cap.
- A released video loses its `src` (`load()` with no source; the authored value moves to
  `data-hf-detached-src`, read back through `readPreviewMediaSrc`) and gets it back, with its
  muted/volume/rate state, before it is needed. Loaded videos are released in batches of
  `DETACH_BATCH_SIZE` per `DETACH_INTERVAL_MS`, farthest first, so a scrub never tears down a storm
  of players; restores for clips that are playing or about to start are never deferred.
- Only a `<video src>` with an authored `data-duration` is managed: a clip whose window comes from
  the decoder's `duration`, `<source>` children and `<audio>` (owned by the Web Audio transport)
  are left alone.

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
