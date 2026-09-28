# Requirements & Caches

## Credential & key priority

Check what's configured and which engines a workflow will use (see the skill's **Preflight** section). Keys resolve in this order — **first match wins**:

| Provider                             | Resolution order (first non-empty wins)                                                                                                                                    | Local deps when used                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **HeyGen** (TTS + BGM/SFX retrieval) | `$HEYGEN_API_KEY` → `$HYPERFRAMES_API_KEY` → `~/.heygen/credentials` (`$HEYGEN_CONFIG_DIR` overrides the dir) | none (REST)                                      |
| **ElevenLabs** (TTS fallback)        | `$ELEVENLABS_API_KEY`                                                                                                                                                      | `pip install elevenlabs`                         |
| **Lyria** (BGM fallback)             | `$GEMINI_API_KEY` → `$GOOGLE_API_KEY`                                                                                                                                      | `pip install google-genai`                       |
| **Kokoro** (TTS, no key)             | always — final voice fallback                                                                                                                                              | `pip install kokoro-onnx soundfile`              |
| **MusicGen** (BGM, no key)           | always — final music fallback                                                                                                                                              | `pip install transformers torch soundfile numpy` |

Set `$HEYGEN_API_KEY` (or `$HYPERFRAMES_API_KEY`) — one key, every project, no per-repo `.env`. It is sent as `X-Api-Key`. With no HeyGen credential, voice/BGM run fully locally (Kokoro / MusicGen) — `hyperframes doctor` reports whether those local deps are installed.

## Model caches & system dependencies

Each command downloads its own model on first run and caches it under `~/.cache/hyperframes/`:

- **TTS (HeyGen)** — no local deps; needs a HeyGen credential + `ffmpeg` on PATH (to transcode the mp3 response to `.wav`). Set `$HEYGEN_API_KEY` (or `$HYPERFRAMES_API_KEY`). It is sent as `X-Api-Key`.
- **TTS (ElevenLabs)** — same as HeyGen: API key + `ffmpeg`.
- **TTS (Kokoro)** — Kokoro-82M (~311 MB) + voices (~27 MB) in `tts/`. Requires Python 3.8+ with `kokoro-onnx` and `soundfile` (`pip install kokoro-onnx soundfile`). Non-English text also needs `espeak-ng` system-wide.
- **BGM (Lyria)** — needs `$GEMINI_API_KEY` or `$GOOGLE_API_KEY` + `pip install google-genai`. No local model cache.
- **BGM (MusicGen)** — `pip install transformers torch soundfile`. `facebook/musicgen-small` (~300 MB) cached under `~/.cache/huggingface/` on first run.
- **Transcribe** — Whisper model size depending on choice (75 MB – 3.1 GB) in `whisper/`, downloaded from HuggingFace on first use. `whisper.cpp` itself is NOT bundled: the CLI resolves it from PATH, installs via Homebrew (macOS), or builds it from source with git+cmake on first use (`$HYPERFRAMES_WHISPER_PATH` overrides).
- **Remove-background** — `u2net_human_seg` (~168 MB ONNX) in `background-removal/models/`. Peak inference RAM ~1.5 GB.

Run `npx hyperframes doctor` if a command fails because of a missing dependency.
