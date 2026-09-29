# Rendering

Render compositions to MP4 with `npx hyperframes render`.

Renders locally with Puppeteer (bundled Chromium) + system FFmpeg.
Requires: FFmpeg installed (`brew install ffmpeg` or `apt install ffmpeg`).

## Options

- `-f, --fps` — 24, 30, or 60 (default: 30)
- `-q, --quality` — draft, standard, high (default: standard)
- `-w, --workers` — Parallel workers 1-8 (default: auto)
- `--crf` — Override encoder CRF (mutually exclusive with `--video-bitrate`)
- `--video-bitrate` — Target video bitrate such as `10M` (mutually exclusive with `--crf`)
- `--vp9-cpu-used` — WebM VP9 speed/quality tradeoff (`-8` to `8`, default: `4`). Higher values encode faster with larger output / quality tradeoff.
- `--video-frame-format` — Source video frame extraction format: `auto`, `jpg`, or `png` (default: `auto`). Use `png` for UI recordings, screen captures, and color-sensitive source videos.
- `--gpu` — Use GPU encoding (NVENC, VideoToolbox, AMF, VAAPI, QSV)
- `--browser-gpu` / `--no-browser-gpu` — Force host GPU or software (SwiftShader) for Chrome/WebGL capture. Default is `auto` — probe WebGL availability on first launch and fall back to software if no GPU is reachable.
- `-o, --output` — Custom output path

## Tips

- Use `draft` quality for fast previews during development
- Local renders auto-detect GPU on first launch; use `--browser-gpu` to force hardware (errors if no GPU) or `--no-browser-gpu` to force SwiftShader
- Use `--gpu` when a local render also benefits from hardware FFmpeg encoding
- Use `--video-frame-format png` when source videos contain saturated UI colors that should avoid JPEG extraction
- Use `npx hyperframes benchmark` to find optimal settings
- 4 workers is usually the sweet spot for most compositions
