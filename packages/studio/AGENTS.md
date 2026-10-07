# Working on Studio

Read this before your first change in `packages/studio`. It is the handful of
things that are not visible from the source, and that cost real time to
rediscover.

## The shape of the thing

Studio renders the user's composition in an **iframe**, and draws its own
chrome — selection box, handles, dashed outlines, toolbars — in **Studio's own
document**, positioned over the iframe. Nothing Studio draws lives inside the
composition, because a render would capture it and the composition's styling
would inherit into it.

Two consequences you will meet immediately:

- Reaching a preview element from a driver or a test means going through the
  iframe: `iframe.contentDocument.getElementById(...)`. Studio's own panels may
  be inside shadow roots, so a plain `document.querySelector` finds neither.
- Every overlay box is a _measurement_ of an element, not the element. When
  chrome disagrees with the pixels underneath it, the bug is almost always in
  the measurement, in `components/editor/domEditOverlayGeometry.ts`.

## Driving Studio for verification

A pixel-precise click inside the preview is not something an automated driver
can reliably land, and some gestures cannot be synthesised at all: the canvas
overlay takes pointer capture and recognises a double press itself, so
`page.mouse` click pairs do not open a text edit no matter how they are timed.

Use the dev-only hook instead. In a dev build `window.__studioTest` exposes:

```js
await window.__studioTest.selectByDomId("headline"); // selects, reveals the inspector
```

That is the same selection a click produces. The general lesson: from a settled
selection, keyboard paths are dependable where pointer paths are not. Prefer a
key over a synthesised gesture whenever the feature offers one.

`useStudioTestHooks` also carries the timeline performance fixtures. The hook is
gated on `STUDIO_TEST_HOOKS_ENABLED` (dev or development mode only), so
`window.__studioTest` is absent in production builds — feature-detect it.

## Tracing decisions

The interesting failures here are decisions, not crashes: a preview that
reloads when it should not, a shift-click that selects the wrong element.
Nothing throws, so a trace of the decision is the only way to avoid guessing.

Channels are off by default. Turn one on and reload:

```js
localStorage.setItem("hf-drag-debug", "1"); // then grep the console for [hf-drag]
```

Live channels: `reload`, `select`, `drag`, `resize`, `commit`. Add one with
`makeStudioDebugLogger("<name>")` in `utils/studioDebug.ts`.

## Running the tests

Studio's tests are **vitest**, not `bun test`. Running bare `bun test` in this
package collects the files with the wrong runner and reports failures that are
not real:

```bash
bun run --cwd packages/studio test                       # all of them
bun run --cwd packages/studio test src/components/editor # one directory
```

happy-dom is not a browser. It does not reflect the individual transform
properties (`rotate`, `scale`, `translate`) into computed style, and it has no
`DOMMatrix` — the geometry tests carry their own stand-in. When a behaviour
depends on real layout or real computed style, prove it in a browser and keep
the unit test on the pure function underneath.

## Gates that will fail your PR

- **oxlint and oxfmt**, not eslint or prettier.

## Conventions no check enforces

- **Keep files under about 600 lines.** No CI step measures it; a file that grows
  past it is split in the same PR that grew it.

## Traps worth knowing

- **`rotate` is not `transform`.** Studio's rotate handle writes the CSS
  `rotate` property, which is an individual transform property and does not
  appear in `getComputedStyle(el).transform`. Anything measuring an angle has to
  read both and compose them the way CSS does, individual properties first.
- **A seek re-renders the whole timeline**, not the tween you patched. Patching
  several elements one at a time and seeking after each repaints the ones still
  queued from their un-patched tweens. Batch, then render once.
- **Studio's own writes must not reload the preview.** Writes carry a token so
  the file-watcher event can be recognised as ours; a new write path that
  forgets it makes the preview flash on every edit.
- **Preserving a selection set that does not contain the id empties it.** Check
  `preserveSet` semantics before reusing it.
- **Hand edits stop while an agent turn runs.** The timeline refuses edits
  (`timelineEditLockReason`, the "AI is editing" badge), and the same mirror
  (`agent/agentTurnLock.ts`) locks files: `fileEditLockReason` makes the code
  editor read-only (a CodeMirror compartment, so the view and its undo history
  survive), disables the file tree's create / rename / move / duplicate / delete,
  and `useFileManager` refuses the same calls with a toast for every other caller
  (Assets, Media). Importing files stays open — it only adds files, and the chat
  attaches files mid-turn through it. A new surface that rewrites an existing
  project file by hand must check the lock too.
- **Render QA reports are immutable; the user's "mark intentional" is not.** The
  card reads `acceptedIssueIds` (derived when the report is read) and the report
  view re-reads after every mark or undo. A pass's render link shows only for
  renders that survive the session (`isPassRenderLinked`).
- **Design systems are a beta surface in `src/design/`** (`isBetaFeatureEnabled("designSystems")`;
  with the flag off nothing renders, reads or touches the address). The header's `DesignButton`
  popover and the chat's `DesignSavedCards` read one store (`studioDesignStore`, `/api/design-systems`
  and `/api/projects/:id/design*`; reads abort and are dropped when superseded, no polling: it
  re-reads when the popover opens and when any agent turn ends). Dialogs (create, edit, preview) live
  in `DesignHost`, mounted beside Settings in `StudioRightPanels` because starting a turn
  (`agentStore.runDesignAction`, request built by `agent/designTurn.ts`, carried by `retryTurnRequest`)
  needs the project's agent store. The preview iframe is `sandbox="allow-same-origin"` on purpose
  (the design routes answer with a CSP of `sandbox allow-same-origin` and `default-src 'none'`, and
  with no CORS grant, so the page's font requests must be same-origin); never add
  `allow-scripts`. The palette and display font shown for the attached system come from the
  project's own `design/tokens.css`, not the library (which may be newer). The popover's one repair
  button calls `update()` and reads Update (library newer), Replace (the library's system of that
  id is a different one: `updateAvailable` without a newer version) or Restore (the project's copy
  is damaged, nothing newer); it is absent when the system left the library. A store `notice`
  carries the mutation that failed, and a chat card shows it only when it came from that card's
  button. The create dialog resolves the picked video/project at render time (`effectiveFields`):
  both lists arrive after it opens, and "no videos" shows only once the file tree has loaded. Retry
  is hidden for a design turn when the beta flag is off. "From another project" appears only when
  `useDesignHostCapabilities(projectId, enabled)` finds other projects (the `#` mentions'
  `cross-project` list, asked only while the create dialog is open; none or a failure means the
  option is hidden). The shell opens the create dialog with
  `openvidsDesign=create[&openvidsDesignSource=…]`, read once and stripped (`designParam.ts`).
- **Voiceover is a beta surface in `src/voice/`** (`isBetaFeatureEnabled("voiceover")`; with the flag off the
  `voiceover` dock tab is not registered or offered in Window, the media nav's Voice group and the inspector's
  module are absent). One script store (`voice/script/voiceScriptStore.ts`, in `VoiceProvider`) feeds the tab
  (`voice/panel/VoiceoverPanel`) and the clip's inspector module (`components/editor/propertyPanelVoiceGroup`); a
  clip is a voice clip by `data-ov-voice-line` (`TimelineElement.voiceLine`). Changing a take rewrites every clip of
  the line (`voice/clip/voiceClipOps.ts`: file, in-point, length) and, with ripple on, shifts the later clips of the
  track (`player/components/timelineDurationRipple.ts`) in ONE undo entry (shared `coalesceKey`; with ripple on, a
  locked later clip refuses the whole take change, like delete-ripple). "Add to timeline" and the music carve go
  through Studio's own history writes, never the editing route. Every write control reads `useVoiceEditLock()` and is
  off while an agent turn runs. Paid generation is always estimate → confirm → progress/cancel
  (`voice/panel/VoiceGenerate`); Regenerate sends `force: true` (a new reading past the cache). The setup window is
  drawn only from the server's `VoiceProviderControls` (a missing capability is a missing control, never a disabled
  one), and Studio never sends a custom server address (`desktop_only`: the Projects page sets it).
