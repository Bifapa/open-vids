import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  outDir: "dist",
  target: "node22",
  platform: "neutral",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
});
