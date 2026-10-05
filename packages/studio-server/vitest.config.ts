import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
    // Tests here spawn real node, ffmpeg and ffprobe processes, which a loaded or slow CI runner (efficiency cores,
    // Windows) starts in seconds, not the 5 s / 10 s vitest allows by default. A genuine hang still fails.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
