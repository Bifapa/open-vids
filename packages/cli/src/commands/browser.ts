import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { failCommand } from "../utils/commandResult.js";
import { defineCommand } from "citty";
import type { Example } from "./_examples.js";
import * as clack from "@clack/prompts";
import { c } from "../ui/colors.js";

export const examples: Example[] = [
  ["Find or download Chrome for rendering", "hyperframes browser ensure"],
  ["Purge a stale/partial download and re-download", "hyperframes browser ensure --force"],
  ["Print the Chrome executable path", "hyperframes browser path"],
  ["Remove cached Chrome download", "hyperframes browser clear"],
  ["Progress as JSON lines, for a supervising app", "hyperframes browser ensure --json"],
];
import { formatBytes } from "../ui/format.js";
import {
  ensureBrowser,
  findBrowser,
  clearBrowser,
  managedChromeVersion,
  releaseOwnedBrowserInstallLock,
  CACHE_DIR,
  isLinuxArm,
} from "../browser/manager.js";

/**
 * `browser ensure --json`: one JSON object per line on stdout, for a supervising app.
 *
 *   {"event":"start"}
 *   {"event":"progress","downloaded":123,"total":456}      (only while a download runs)
 *   {"event":"done","path":"…","source":"cache"|"download"|"env"}
 *   {"event":"error","message":"…"}                         (exit code 1)
 *
 * Resolves like a render does (the pinned managed Chrome, `preferManagedChrome`), so "done" means a render
 * can start. SIGTERM/SIGINT release the install lock before exiting, so a cancelled install does not make
 * the next one wait for the lock to go stale.
 */
async function runEnsureJson(): Promise<void> {
  const emit = (event: Record<string, unknown>) =>
    process.stdout.write(`${JSON.stringify(event)}\n`);
  const onSignal = () => {
    releaseOwnedBrowserInstallLock();
    // The unfinished archive the installer was writing; the next run would clear it as corrupt anyway.
    try {
      const archives = join(CACHE_DIR, "chrome-headless-shell");
      for (const name of readdirSync(archives)) {
        if (name.endsWith(".zip")) rmSync(join(archives, name), { force: true });
      }
    } catch {
      // Nothing was downloaded yet.
    }
    process.exit(130);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  emit({ event: "start" });
  let lastEmit = 0;
  try {
    const result = await ensureBrowser({
      preferManagedChrome: true,
      onProgress: (downloaded, total) => {
        const now = Date.now();
        // Throttled: a progress event per chunk would be thousands of lines.
        if (now - lastEmit < 200 && downloaded < total) return;
        lastEmit = now;
        emit({ event: "progress", downloaded, total });
      },
    });
    emit({ event: "done", path: result.executablePath, source: result.source });
  } catch (err) {
    emit({ event: "error", message: err instanceof Error ? err.message : String(err) });
    failCommand(1, err);
  }
}

async function runEnsure(options?: { force?: boolean }): Promise<void> {
  clack.intro(c.bold("hyperframes browser ensure"));

  // ARM64 Linux: Chrome headless shell is not available (apt-get/system-only
  // install flow, no download cache to force a purge of) — --force is a no-op here.
  if (isLinuxArm()) {
    const s = clack.spinner();
    s.start("Linux ARM64 detected — looking for system Chromium...");
    const existing = await findBrowser();
    if (existing) {
      s.stop(c.success("System Chromium found"));
      console.log();
      console.log(`   ${c.dim("Source:")}  ${c.bold(existing.source)}`);
      console.log(`   ${c.dim("Path:")}    ${c.bold(existing.executablePath)}`);
      console.log();
      clack.outro(c.success("Ready to render."));
      return;
    }

    s.stop(c.warn("No Chromium found — attempting auto-install via apt-get..."));
    console.log();

    // Delegate to ensureBrowser which handles the full ARM64 install flow.
    try {
      const result = await ensureBrowser();
      console.log();
      console.log(`   ${c.dim("Source:")}  ${c.bold(result.source)}`);
      console.log(`   ${c.dim("Path:")}    ${c.bold(result.executablePath)}`);
      console.log();
      clack.outro(c.success("Chromium ready. You can now render on ARM64."));
    } catch (err) {
      // The ARM64 auto-install failed: the browser is NOT ready, so this is a
      // real failure (exit 1), not a success. Report it and stop swallowing.
      clack.log.error(err instanceof Error ? err.message : String(err));
      clack.outro(c.warn("Manual setup required (see instructions above)."));
      failCommand(1, err);
    }
    return;
  }

  const s = clack.spinner();
  if (!options?.force) {
    // Resolve with `preferManagedChrome` so this reports what `render`
    // actually uses — a system Chrome without our pinned HF cache still
    // downloads on the next render, so it shouldn't be reported as "found".
    s.start("Looking for an existing browser...");

    let lastPct = -1;
    const existing = await ensureBrowser({
      preferManagedChrome: true,
      onProgress: (downloaded, total) => {
        if (total <= 0) return;
        const pct = Math.floor((downloaded / total) * 100);
        if (pct > lastPct) {
          lastPct = pct;
          s.message(
            `Downloading Chrome Headless Shell ${c.dim("v" + managedChromeVersion())} — ${c.progress(pct + "%")} ${c.dim("(" + formatBytes(downloaded) + " / " + formatBytes(total) + ")")}`,
          );
        }
      },
    });

    s.stop(c.success(existing.source === "download" ? "Download complete" : "Browser found"));
    console.log();
    console.log(`   ${c.dim("Source:")}  ${c.bold(existing.source)}`);
    console.log(`   ${c.dim("Path:")}    ${c.bold(existing.executablePath)}`);
    console.log();
    clack.outro(c.success("Ready to render."));
    return;
  }

  s.start("Purging cached download and re-downloading...");

  const downloadSpinner = clack.spinner();
  downloadSpinner.start(
    `Downloading Chrome Headless Shell ${c.dim("v" + managedChromeVersion())}...`,
  );

  let lastPct = -1;
  const result = await ensureBrowser({
    force: options?.force,
    onProgress: (downloaded, total) => {
      if (total <= 0) return;
      const pct = Math.floor((downloaded / total) * 100);
      if (pct > lastPct) {
        lastPct = pct;
        downloadSpinner.message(
          `Downloading Chrome Headless Shell ${c.dim("v" + managedChromeVersion())} — ${c.progress(pct + "%")} ${c.dim("(" + formatBytes(downloaded) + " / " + formatBytes(total) + ")")}`,
        );
      }
    },
  });

  downloadSpinner.stop(c.success("Download complete"));

  console.log();
  console.log(`   ${c.dim("Source:")}  ${c.bold(result.source)}`);
  console.log(`   ${c.dim("Path:")}    ${c.bold(result.executablePath)}`);
  console.log();

  clack.outro(c.success("Ready to render."));
}

async function runPath(): Promise<void> {
  const result = await findBrowser();
  if (!result) {
    // Try a full ensure (which includes download) but write only the path
    try {
      const ensured = await ensureBrowser();
      process.stdout.write(ensured.executablePath + "\n");
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : "Failed to find browser");
      failCommand(1, err);
    }
    return;
  }
  process.stdout.write(result.executablePath + "\n");
}

function runClear(): void {
  clack.intro(c.bold("hyperframes browser clear"));

  const removed = clearBrowser();
  if (removed) {
    clack.outro(c.success("Removed cached browser from ") + c.dim(CACHE_DIR));
  } else {
    clack.outro(c.dim("No cached browser to remove."));
  }
}

export default defineCommand({
  meta: { name: "browser", description: "Manage the Chrome browser used for rendering" },
  args: {
    subcommand: {
      type: "positional",
      description:
        "ensure = find or download Chrome, path = print executable path, clear = remove cached download",
      required: false,
    },
    force: {
      type: "boolean",
      description:
        "ensure only: purge any cached download (including a stale/partial one) and re-download from scratch",
      default: false,
    },
    json: {
      type: "boolean",
      description:
        "ensure only: report progress as one JSON object per line (for a supervising app)",
      default: false,
    },
  },
  async run({ args }) {
    const subcommand = args.subcommand;

    if (!subcommand || subcommand === "") {
      console.log(`
${c.bold("hyperframes browser")} ${c.dim("<subcommand>")}

Manage the Chrome browser used for rendering.

${c.bold("SUBCOMMANDS:")}
  ${c.accent("ensure")}   ${c.dim("Find or download Chrome for rendering")}
  ${c.accent("path")}     ${c.dim("Print browser executable path (for scripting)")}
  ${c.accent("clear")}    ${c.dim("Remove cached Chrome download")}

${c.bold("EXAMPLES:")}
  ${c.accent("npx hyperframes browser ensure")}           ${c.dim("Download Chrome if needed")}
  ${c.accent("npx hyperframes browser ensure --force")}   ${c.dim("Purge a stale/partial download and re-download")}
  ${c.accent("npx hyperframes browser path")}             ${c.dim("Print path for scripts")}
  ${c.accent("npx hyperframes browser clear")}            ${c.dim("Remove cached browser")}
`);
      return;
    }

    switch (subcommand) {
      case "ensure":
        return args.json ? runEnsureJson() : runEnsure({ force: args.force });
      case "path":
        return runPath();
      case "clear":
        return runClear();
      default:
        console.error(
          `${c.error("Unknown subcommand:")} ${subcommand}\n\nRun ${c.accent("hyperframes browser --help")} for usage.`,
        );
        failCommand(1, `Unknown subcommand: ${subcommand}`);
    }
  },
});
