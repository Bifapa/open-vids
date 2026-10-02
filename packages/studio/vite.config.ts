import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readNodeRequestBody } from "./vite.request-body.js";
import { watch } from "chokidar";
import { createProjectSignatureCache, createViteAdapter } from "./vite.adapter";
import { previewConfigPayload } from "./vite.preview-config";
import { loadStudioServerDevModule } from "./vite.studio-server-module";
import type {
  AgentGateway,
  AgentRuntimeLaunch,
  StudioApiAdapter,
  openProjectHistory,
} from "@hyperframes/studio-server";
import { previewChangeOwner } from "./vite.preview-watch";
interface StudioApiFetch {
  fetch(request: Request): Promise<Response>;
}

interface StudioServerDevModule {
  createStudioApi(adapter: StudioApiAdapter): StudioApiFetch;
  createAgentGateway(options: { launch: () => AgentRuntimeLaunch | null }): AgentGateway;
  resolveAgentRuntimeLaunch(cliFileDir?: string): AgentRuntimeLaunch | null;
  identifyFileWrite(
    path: string,
    expectedVersion: string,
  ): { path: string; version: string; writeToken: string } | null;
  fileContentVersion(content: string): string;
  affectsPreview(projectDir: string, changedPath: string): boolean;
  DELETED_VERSION: string;
  openProjectHistory: typeof openProjectHistory;
}

function isStudioServerDevModule(value: unknown): value is StudioServerDevModule {
  if (typeof value !== "object" || value === null) return false;
  return (
    "createStudioApi" in value &&
    typeof value.createStudioApi === "function" &&
    "createAgentGateway" in value &&
    typeof value.createAgentGateway === "function" &&
    "resolveAgentRuntimeLaunch" in value &&
    typeof value.resolveAgentRuntimeLaunch === "function" &&
    "identifyFileWrite" in value &&
    typeof value.identifyFileWrite === "function" &&
    "fileContentVersion" in value &&
    typeof value.fileContentVersion === "function" &&
    "affectsPreview" in value &&
    typeof value.affectsPreview === "function" &&
    "DELETED_VERSION" in value &&
    typeof value.DELETED_VERSION === "string" &&
    "openProjectHistory" in value &&
    typeof value.openProjectHistory === "function"
  );
}

async function loadRuntimeSourceForDev(
  server: import("vite").ViteDevServer,
): Promise<string | null> {
  try {
    const mod = await server.ssrLoadModule(
      resolve(__dirname, "../core/src/inline-scripts/hyperframe.ts"),
    );
    if (typeof mod.loadHyperframeRuntimeSource === "function") {
      return mod.loadHyperframeRuntimeSource();
    }
  } catch (err) {
    console.warn("[Studio] Failed to load runtime source from core:", err);
  }
  return null;
}

const studioPkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

/**
 * Copies the build's one CSS asset, unhashed, to `dist/styles.css` for the
 * `./styles.css` export. Throws if the build ever emits more than one.
 */
export function stableStylesCssPlugin(): Plugin {
  return {
    name: "studio-stable-styles-css",
    writeBundle(options, bundle) {
      const cssAssets = Object.values(bundle).filter(
        (item) => item.type === "asset" && item.fileName.endsWith(".css"),
      );
      if (cssAssets.length !== 1) {
        throw new Error(
          `stableStylesCssPlugin: expected exactly one CSS asset for the ./styles.css ` +
            `export, found ${cssAssets.length} (${cssAssets.map((a) => a.fileName).join(", ") || "none"}). ` +
            `Scope this plugin to the entry stylesheet instead of assuming a single emit.`,
        );
      }
      const outDir = options.dir ?? "dist";
      copyFileSync(join(outDir, cssAssets[0]!.fileName), join(outDir, "styles.css"));
    },
  };
}

// ── Bridge Hono fetch → Node http response ───────────────────────────────────

async function bridgeHonoResponse(
  honoResponse: Response,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const headers: Record<string, string> = {};
  honoResponse.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(honoResponse.status, headers);

  if (!honoResponse.body) {
    res.end();
    return;
  }
  const reader = honoResponse.body.getReader();

  const onClientClose = (): void => {
    if (!res.writableEnded) void reader.cancel().catch(() => {});
  };
  res.on("close", onClientClose);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    /* client disconnected */
  } finally {
    res.off("close", onClientClose);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

// ── Vite plugin ──────────────────────────────────────────────────────────────

function devProjectApi(): Plugin {
  const dataDir = resolve(__dirname, "data/projects");
  const runtimePath = resolve(__dirname, "../core/dist/hyperframe.runtime.iife.js");

  return {
    name: "studio-dev-api",
    configureServer(server): void {
      // Watch project directories on a watcher of our own. Vite's is told to
      // ignore them (see `server.watch.ignored`), because it answers an html
      // change with a full page reload; this one only announces the change and
      // lets Studio decide what to do with it.
      const watchedProjects = new Map<string, string>();
      try {
        for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
          const full = join(dataDir, entry.name);
          try {
            watchedProjects.set(
              lstatSync(full).isSymbolicLink() ? realpathSync(full) : full,
              entry.name,
            );
          } catch {
            /* skip broken symlinks */
          }
        }
      } catch {
        /* dataDir doesn't exist yet */
      }

      const watchedRoots = new Set(watchedProjects.keys());
      const projectWatcher = watch([...watchedRoots], {
        ignoreInitial: true,
        // Render output and its frame work dirs live in `<project>/renders` (as in the CLI host); a render
        // writes thousands of frames there that are neither composition edits nor history.
        ignored: (path: string) => {
          for (const root of watchedRoots) {
            const rel = relative(root, path);
            if (rel && !rel.startsWith("..") && !isAbsolute(rel))
              return rel.split(sep)[0] === "renders";
          }
          return false;
        },
        // A project write is a whole-file replace; wait for it to settle so a
        // half-written composition is never announced.
        awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
      });

      // This watcher, and not Vite's, is what clears the preview signature.
      // Vite's ignores `data/projects/**`, so subscribing the cache to it left
      // the ETag frozen for the life of the dev server: the preview answered
      // every revalidation with 304 and thumbnails regenerated after an edit
      // still rendered the pre-edit composition. Every event type counts, since
      // an added or deleted asset changes the signature as surely as an edit.
      const signatureCache = createProjectSignatureCache({
        watch: (projectDir) => {
          watchedRoots.add(projectDir);
          projectWatcher.add(projectDir);
        },
      });
      for (const event of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) {
        projectWatcher.on(event, (filePath: string) => signatureCache.invalidate(filePath));
      }

      let _api: StudioApiFetch | null = null;
      let _apiPromise: Promise<StudioApiFetch> | null = null;
      let _studioServerModule: StudioServerDevModule | null = null;
      const getApi = async (): Promise<StudioApiFetch> => {
        if (_api) return _api;
        const pending =
          _apiPromise ??
          (_apiPromise = (async (): Promise<StudioApiFetch> => {
            // The package's `node` condition resolves to ignored dist output,
            // which may predate the source under test. Studio dev owns a source
            // workspace, so load that producer explicitly.
            const loaded = await loadStudioServerDevModule(server, __dirname);
            if (!isStudioServerDevModule(loaded)) {
              throw new Error("@hyperframes/studio-server dev module is missing required exports");
            }
            const mod = loaded;
            _studioServerModule = mod;
            const agentGateway = mod.createAgentGateway({
              launch: () =>
                mod.resolveAgentRuntimeLaunch(
                  process.argv[1] ? dirname(process.argv[1]) : process.cwd(),
                ),
            });
            const adapter = createViteAdapter(dataDir, server, signatureCache, {
              openHistory: mod.openProjectHistory,
              // Projects can be created or imported after startup. Keep the canonical
              // id and real root before the signature cache starts watching them.
              onResolveProject: (project) => watchedProjects.set(project.dir, project.id),
            });
            adapter.agent = agentGateway;
            server.httpServer?.once("close", () => {
              void agentGateway.dispose().catch((error: unknown) => {
                console.error("[Studio] Failed to stop Agent Runtime", error);
              });
            });
            return mod.createStudioApi(adapter);
          })());
        try {
          _api = await pending;
          return _api;
        } finally {
          if (_apiPromise === pending) _apiPromise = null;
        }
      };

      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__hyperframes_config") return next();
        const payload = previewConfigPayload(process.env, process.pid, studioPkg.version);
        if (!payload) return next();
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(payload));
      });

      // Runtime endpoint — prefer source build over dist artifact
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/runtime.js") return next();
        const serve = async () => {
          let runtimeSource = await loadRuntimeSourceForDev(server);
          if (!runtimeSource && existsSync(runtimePath)) {
            runtimeSource = readFileSync(runtimePath, "utf-8");
          }
          if (!runtimeSource) {
            res.writeHead(404);
            res.end("runtime not available — build packages/core or load runtime source");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/javascript",
            "Cache-Control": "no-store",
          });
          res.end(runtimeSource);
        };
        void serve().catch((err) => {
          console.error("[Studio runtime] Failed to serve runtime", err);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("failed to serve runtime");
          }
        });
      });

      // API middleware
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        try {
          const api = await getApi();
          const url = new URL(req.url, `http://${req.headers.host}`);
          url.pathname = url.pathname.slice(4);
          let body: Buffer | undefined;
          if (req.method !== "GET" && req.method !== "HEAD") {
            const bytes = await readNodeRequestBody(req);
            body = bytes.byteLength > 0 ? bytes : undefined;
          }
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (value != null) headers[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          const fetchReq = new Request(url.toString(), {
            method: req.method,
            headers,
            body,
          });
          const response = await api.fetch(fetchReq);
          await bridgeHonoResponse(response, res);
        } catch (err) {
          console.error("[Studio API] Error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
      });

      projectWatcher.on("change", (filePath: string) => {
        const owner = previewChangeOwner(watchedProjects, filePath);
        if (!owner) return;
        if (
          !filePath.endsWith(".html") &&
          !filePath.endsWith(".css") &&
          !filePath.endsWith(".js") &&
          !filePath.endsWith(".json")
        )
          return;
        console.log(`[Studio] File changed: ${filePath}`);
        // The receipt is matched on the file's current bytes, not just its path,
        // so a write is only recognised as ours when the version agrees. Calling
        // this without the version could never match, which left every Studio
        // write looking external and reloaded the preview on each edit.
        const studioServer = _studioServerModule;
        let version: string | null = null;
        try {
          version = studioServer?.fileContentVersion(readFileSync(filePath, "utf-8")) ?? null;
        } catch {
          // A deletion has no current bytes to match a write receipt against.
        }
        const receipt = studioServer
          ? studioServer.identifyFileWrite(filePath, version ?? studioServer.DELETED_VERSION)
          : null;
        // The API records what the preview loaded in this same module, so ask it here.
        const reloads = studioServer?.affectsPreview(owner.projectDir, filePath) ?? true;
        server.ws.send({
          type: "custom",
          event: "hf:file-change",
          data: {
            path: filePath,
            version,
            projectId: owner.projectId,
            affectsPreview: reloads,
            ...(reloads ? {} : { affectedCompositions: [] }),
            ...receipt,
          },
        });
      });
      server.httpServer?.on("close", () => void projectWatcher.close());
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devProjectApi()],
  define: {
    __STUDIO_VERSION__: JSON.stringify(studioPkg.version),
  },
  resolve: {
    alias: {
      // linkedom's HTMLCanvasElement constructor calls createCanvas(300, 150)
      // from the Node-only `canvas` package, behind a
      // `try { require('canvas') } catch { shim }` guard. A bundler resolves
      // that require statically, so the catch never fires and createCanvas is
      // undefined — every composition containing a <canvas> then throws inside
      // openComposition and silently loses its SDK session. See the stub.
      canvas: resolve(__dirname, "src/shims/canvasBrowserStub.js"),
      "@hyperframes/player": resolve(__dirname, "../player/src/hyperframes-player.ts"),
      "@hyperframes/studio-server/source-mutation": resolve(
        __dirname,
        "../studio-server/src/helpers/sourceMutation.ts",
      ),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // /assets/* caches by filename alone, immutably, for a year
      // (studioServer.ts). Keep every hash; copy one CSS file, unhashed,
      // to the dist ROOT instead for the ./styles.css export.
      plugins: [stableStylesCssPlugin()],
    },
  },
  optimizeDeps: {
    include: ["bpm-detective"],
  },
  server: {
    port: 5190,
    watch: {
      // A composition lives under this package's root, so Vite's HMR sees a
      // write to one as an html page dependency changing and full-reloads the
      // browser. That reload is the flash after every edit in the canvas, and
      // it is not Studio's to make: the app already decides whether a write of
      // its own needs the preview refreshed, and the plugin below announces
      // project writes as `hf:file-change` off its own watcher.
      ignored: ["**/data/projects/**"],
    },
  },
  ssr: {
    // recast / @babel/parser are CommonJS and call `require("fs")`. They are
    // reachable only server-side via the Node-only `@hyperframes/parsers/gsap-parser`
    // subpath (studio-api GSAP mutations + the linter), which the dev server loads
    // through Vite SSR. Externalizing them makes SSR load the native Node modules
    // instead of esbuild-transforming the `require` into a shim that throws
    // "Dynamic require of fs is not supported". Browser bundles never reach them.
    external: ["recast", "@babel/parser", "ast-types"],
  },
  test: {
    exclude: ["data/**", "node_modules/**"],
    setupFiles: ["src/test-setup.ts"],
  },
});
