# hyperframes

CLI for creating, previewing, and rendering HTML video compositions.

## Install

This package is private and is not published to npm. From a source checkout, link the `hyperframes` binary once:

```bash
bun install
cd packages/cli && bun link
```

or run the entry directly: `bun packages/cli/src/cli.ts <command>`.

**Requirements:** Node.js >= 22, FFmpeg

## Commands

### `init`

Scaffold a new Hyperframes project from a template:

```bash
hyperframes init my-video
cd my-video
```

### `preview`

Start the live preview studio in your browser:

```bash
hyperframes preview
# Studio: http://localhost:3002/#project/my-video
# Server: http://localhost:3002

hyperframes preview --port 4567
```

In an interactive terminal, the preview stays attached until you press
Ctrl+C. In a non-interactive shell such as a coding-agent session, the same
command starts a managed preview that survives after the command returns. Use
`--background` or `--foreground` to choose explicitly, and manage persistent
previews with `--status`, `--stop`, `--list`, and `--kill-all`. Add `--json` to
managed lifecycle commands for machine-readable output. `--foreground --json`
prints the ready-session envelope once, then remains attached until stopped.

### `normalize-audio`

Measure two local authored audio clips with integrated LUFS and match the target
to the unchanged reference. The command is a dry run unless `--write` is passed:

```bash
hyperframes normalize-audio --reference target-audio --target user-audio
hyperframes normalize-audio --reference target-audio --target user-audio --write
```

It updates only the target element's `data-volume` and refuses unsafe boosts
that exceed Studio's +12 dB ceiling or would clip.

### `render`

Render a composition to MP4. Run from the project directory; the positional
argument is the project directory (not a file), so render the project's
`index.html` directly, or point at a specific composition file with `-c`:

```bash
hyperframes render -o output.mp4
hyperframes render -c ./my-composition.html -o output.mp4
```

Set `HYPERFRAMES_RENDER_DETACHED=1` when starting a render with `nohup` or
`disown` so it keeps running after the invoking shell exits.

### `lint`

Validate your Hyperframes HTML:

```bash
hyperframes lint ./my-composition
hyperframes lint ./my-composition --json      # JSON output for CI/tooling
hyperframes lint ./my-composition --verbose   # Include info-level findings
```

By default only errors and warnings are shown. Use `--verbose` to also display informational findings (e.g., external script dependency notices). Use `--json` for machine-readable output with `errorCount`, `warningCount`, `infoCount`, and a `findings` array.

### `compositions`

List compositions found in the current project:

```bash
hyperframes compositions
```

### `benchmark`

Run rendering benchmarks:

```bash
hyperframes benchmark ./my-composition.html
```

### `doctor`

Check your environment for required dependencies (Chrome, FFmpeg, Node.js):

```bash
hyperframes doctor
```

### `browser`

Manage the bundled Chrome/Chromium installation:

```bash
hyperframes browser
```

### `info`

Print version and environment info:

```bash
hyperframes info
```

### `docs`

Open the documentation in your browser:

```bash
hyperframes docs
```

## Documentation

Full documentation: see `packages/cli` in this repo (no hosted docs site).

## Related packages

- [`@hyperframes/core`](../core) — types, parsers, frame adapters
- [`@hyperframes/engine`](../engine) — rendering engine
- [`@hyperframes/producer`](../producer) — render pipeline
- [`@hyperframes/studio`](../studio) — composition editor UI
