import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (not URL.pathname): on Windows .pathname yields "/D:/..." with a
// leading slash, which breaks resolve() and the alias below.
const coreRoot = resolve(fileURLToPath(new URL("../core/src", import.meta.url)));

export default defineConfig({
  resolve: {
    alias: {
      "@hyperframes/core/composition-contract": resolve(coreRoot, "compositionContract.ts"),
      "@hyperframes/parsers/composition-contract": resolve(
        coreRoot,
        "../../parsers/src/compositionContract.ts",
      ),
      "@hyperframes/core/slideshow": resolve(coreRoot, "slideshow/index.ts"),
      "@hyperframes/core/runtime/protocol": resolve(coreRoot, "runtime/protocol.ts"),
    },
  },
  test: {
    environment: "happy-dom",
    // Node 25+ exposes a localStorage global that is not a working Storage without
    // --localstorage-file and shadows happy-dom's. Node < 22.4 has no such flag and
    // refuses to start with it.
    execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage")
      ? ["--no-experimental-webstorage"]
      : [],
    setupFiles: ["./src/slideshow/test-setup.ts"],
  },
});
