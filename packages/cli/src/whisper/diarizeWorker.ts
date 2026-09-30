import { loadInstalled } from "../utils/optionalPackages.js";
import { SHERPA_ERROR_PREFIX, SHERPA_RESULT_PREFIX } from "./parakeet.js";

interface Wave {
  samples: Float32Array;
  sampleRate: number;
}

interface SherpaOnnx {
  readWave(path: string): Wave;
  OfflineSpeakerDiarization: new (config: object) => {
    sampleRate: number;
    process(samples: Float32Array): Array<{ start: number; end: number; speaker: number }>;
  };
}

const { wavPath, runtimeDir, config } = JSON.parse(process.env.HYPERFRAMES_DIARIZE_INPUT ?? "{}");

try {
  const sherpa = loadInstalled(runtimeDir, "sherpa-onnx-node") as SherpaOnnx | null;
  if (!sherpa) throw new Error(`sherpa-onnx-node is not installed in ${runtimeDir}`);
  const diarization = new sherpa.OfflineSpeakerDiarization(config);
  const wave = sherpa.readWave(wavPath);
  if (wave.sampleRate !== diarization.sampleRate) {
    throw new Error(
      `the audio is ${wave.sampleRate} Hz but the diarization models need ${diarization.sampleRate} Hz`,
    );
  }
  const segments = diarization.process(wave.samples);
  process.stdout.write(`${SHERPA_RESULT_PREFIX}${JSON.stringify(segments)}\n`);
} catch (err) {
  // One line: the reader takes the prefixed line, and the loader's error spans several.
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  // Rethrow after the flush: a pipe write is asynchronous on macOS and a crash would drop it.
  process.stderr.write(`${SHERPA_ERROR_PREFIX}${message}\n`, () => {
    throw err;
  });
}
