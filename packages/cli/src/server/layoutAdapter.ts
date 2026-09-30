/**
 * The Studio server's layout capability (`checkLayout`), implemented by running this CLI's own `check` command as a
 * child process: headless Chrome audits the project's main composition at the requested seconds for overlapping text,
 * captions colliding with other content and content outside the frame. Kept out of the server process like the speech
 * recognizers (see `cliChild.ts`); aborting the request kills the CLI and the browser it started.
 */

import type { LayoutCheckFinding, LayoutCheckResult } from "@hyperframes/studio-server";
import { failureMessage, runCli, type CliChildDeps } from "./cliChild.js";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The report object in the command's stdout: pretty-printed JSON, possibly after stray log lines. */
function parseReport(stdout: string): unknown {
  const text = stdout.trim();
  const candidates = [text];
  const start = text.indexOf("\n{\n");
  if (start >= 0) candidates.push(text.slice(start + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return null;
}

function dataAttributes(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

function severityOf(value: unknown): LayoutCheckFinding["severity"] | null {
  return value === "error" || value === "warning" || value === "info" ? value : null;
}

function toFinding(raw: unknown): LayoutCheckFinding | null {
  const code = field(raw, "code");
  const severity = severityOf(field(raw, "severity"));
  const time = field(raw, "time");
  const selector = field(raw, "selector");
  const message = field(raw, "message");
  if (
    typeof code !== "string" ||
    !severity ||
    !finiteNumber(time) ||
    typeof selector !== "string" ||
    typeof message !== "string"
  ) {
    return null;
  }
  const firstSeen = field(raw, "firstSeen");
  const lastSeen = field(raw, "lastSeen");
  return {
    code,
    severity,
    time,
    ...(finiteNumber(firstSeen) && { firstSeen }),
    ...(finiteNumber(lastSeen) && { lastSeen }),
    selector,
    containerSelector: optionalString(field(raw, "containerSelector")),
    text: optionalString(field(raw, "text")),
    message,
    fixHint: optionalString(field(raw, "fixHint")),
    sourceFile: optionalString(field(raw, "sourceFile")),
    dataAttributes: dataAttributes(field(raw, "dataAttributes")),
  };
}

function findingList(section: unknown): unknown[] {
  const findings = field(section, "findings");
  return Array.isArray(findings) ? findings : [];
}

export async function checkLayoutViaCli(
  opts: { project: { dir: string }; times: number[]; signal: AbortSignal },
  deps: CliChildDeps = {},
): Promise<LayoutCheckResult | { unavailable: string }> {
  const at = [...new Set(opts.times.map((time) => Math.round(time * 1000) / 1000))]
    .sort((a, b) => a - b)
    .join(",");
  const run = await runCli(
    [
      "check",
      opts.project.dir,
      "--json",
      "--no-contrast",
      ...(at ? ["--at", at] : []),
      "--frame-check",
    ],
    { signal: opts.signal },
    deps,
  );
  const report = parseReport(run.stdout);
  if (report === null) throw new Error(failureMessage("check", run));
  if (field(report, "ok") === false && typeof field(report, "error") === "string") {
    throw new Error(`Layout check failed: ${String(field(report, "error"))}`);
  }
  const layout = field(report, "layout");
  const samples = field(layout, "samples");
  if (!Array.isArray(samples) || samples.length === 0) {
    const runtime = findingList(field(report, "runtime")).find(
      (entry) => field(entry, "severity") === "error",
    );
    if (runtime) throw new Error(`Layout check failed: ${String(field(runtime, "message"))}`);
    const lintErrors = field(field(report, "lint"), "errorCount");
    if (finiteNumber(lintErrors) && lintErrors > 0) {
      return {
        unavailable: `The composition has ${lintErrors} lint error${lintErrors === 1 ? "" : "s"}, so the layout audit did not run`,
      };
    }
    return { unavailable: "The layout audit did not sample any frame" };
  }
  return {
    findings: findingList(layout).flatMap((raw) => {
      const finding = toFinding(raw);
      return finding ? [finding] : [];
    }),
    samples: samples.filter(finiteNumber),
  };
}
