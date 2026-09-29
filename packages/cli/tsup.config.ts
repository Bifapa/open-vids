import { defineConfig } from "tsup";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { sourceAliases } from "../../scripts/package-subpaths.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
  version: string;
};
const producerPkg = JSON.parse(
  readFileSync(new URL("../producer/package.json", import.meta.url), "utf-8"),
) as { version: string };

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    fontLocalizeCli: "src/fontLocalizeCli.ts",
    runtimeVersion: "src/runtimeVersion.ts",
    renderSetupWorker: "src/renderSetupWorker.ts",
    sherpaWorker: "src/whisper/sherpaWorker.ts",
    shaderTransitionWorker: "../producer/src/services/shaderTransitionWorker.ts",
    "registry/localSemantic": "src/registry/localSemantic.ts",
  },
  format: ["esm"],
  outDir: "dist",
  target: "node22",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  banner: {
    js: `import { createRequire as __hf_createRequire } from "node:module";
import { fileURLToPath as __hf_fileURLToPath } from "node:url";
import { dirname as __hf_dirname } from "node:path";
var require = __hf_createRequire(import.meta.url);
var __filename = __hf_fileURLToPath(import.meta.url);
var __dirname = __hf_dirname(__filename);`,
  },
  external: [
    "puppeteer-core",
    "puppeteer",
    "@puppeteer/browsers",
    // Native module — its platform binary (@img/sharp-<os>-<arch>) must be
    // resolved from node_modules at runtime, never bundled. Loaded lazily by
    // the capture pipeline; runtime resolution comes from the `dependencies`
    // entry in package.json.
    "sharp",
    "open",
    "hono",
    "hono/*",
    "@hono/node-server",
    "postcss",
  ],
  noExternal: [
    "@hyperframes/core",
    "@hyperframes/parsers",
    "@hyperframes/studio-server",
    "@hyperframes/lint",
    "@hyperframes/producer",
    "@hyperframes/engine",
    "@clack/prompts",
    "@clack/core",
    "picocolors",
    "linkedom",
    "sisteransi",
    "is-unicode-supported",
    "citty",
  ],
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    __PRODUCER_VERSION__: JSON.stringify(producerPkg.version),
  },
  esbuildOptions(options) {
    options.alias = {
      // Exact subpaths are generated from the same contracts as package
      // exports, avoiding esbuild's root-alias prefix substitution trap.
      ...sourceAliases(resolve(__dirname, "../producer"), ["."]),
      ...sourceAliases(resolve(__dirname, "../engine"), [
        ".",
        "./chrome-host-ceiling",
        "./shader-transitions",
      ]),
    };
    options.loader = { ...options.loader, ".browser.js": "text" };
  },
});
