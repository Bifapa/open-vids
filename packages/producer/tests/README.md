# Producer regression test fixtures

Each subdirectory under this folder is a **regression fixture** for the
HTML-to-video pipeline. The harness at
`packages/producer/src/regression-harness.ts` walks every subdirectory,
runs the composition, and PSNR-compares the rendered output against a
checked-in golden baseline.

## Fixture layout

```
<fixture-name>/
├── meta.json           # name, tags, PSNR threshold, renderConfig
├── src/
│   ├── index.html      # composition entry point
│   └── assets/...      # any locally-referenced media
└── output/
    ├── compiled.html   # golden compiled HTML (validated as a snapshot)
    └── output.mp4      # golden rendered video
```

`meta.json` is validated by `validateMetadata` in
`src/regression-harness.ts`. The required fields are:

- `name` (string), `description` (string), `tags` (string[])
- `minPsnr` (number, dB)
- `maxFrameFailures` (integer)
- `minAudioCorrelation` (0..1), `maxAudioLagWindows` (integer ≥1)
- `renderConfig.fps` (integer like `30` or a rational string like `"30000/1001"`)

Optional `renderConfig` fields:

- `format` — `"mp4"` (default) or `"webm"`
- `workers` — integer ≥ 1
- `hdr` — boolean (default `false`)
- `variables` — JSON object of render-time variable overrides

## Generating / updating a baseline

Host Chrome / FFmpeg versions drift across distros, so a baseline
captured on one machine may not match the bytes another renders.
Generate baselines in the same environment that runs the harness.

```bash
# Generate a baseline (single fixture):
bun run --cwd packages/producer test:regression:update <fixture-name>

# Generate all baselines (rarely needed):
bun run --cwd packages/producer test:regression:update
```

The `--update` flag writes `output/compiled.html` and `output/output.mp4`
from the current render. Without `--update`, the harness compares against
those baselines.

## Running the harness locally

```bash
# Run every fixture (parallel).
bun run --cwd packages/producer test:regression

# Run a single fixture:
bun run --cwd packages/producer test:regression font-variant-numeric

# Run sequentially (lower memory):
bun run --cwd packages/producer test:regression -- --sequential
```

## Tags

Common `tags` values control which fixtures the default `bun test`
invocation runs. `--exclude-tags transparency` (the default for
`bun test`) skips webm/png-sequence alpha fixtures that need a working
chrome-headless-shell alpha pipeline.
