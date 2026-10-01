/**
 * The Studio server's website reader capability (`inspectWebsite`), implemented by running this CLI's own
 * `inspect-site` command as a child process: headless Chrome renders the page and extracts its visual identity, kept
 * out of the server process like the layout check (see `cliChild.ts`). Aborting the request kills the CLI, and Chrome
 * with it (it is started over a pipe and exits when the pipe closes).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseWebsiteStyle } from "@hyperframes/agent-protocol";
import type { WebsiteInspection, WebsiteInspectionResult } from "@hyperframes/studio-server";
import { failureMessage, runCli, type CliChildDeps } from "./cliChild.js";

type FailureCode = Extract<WebsiteInspectionResult, { error: unknown }>["error"]["code"];

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

const FAILURE_CODES: readonly FailureCode[] = [
  "blocked_by_policy",
  "unavailable",
  "network",
  "unsupported",
];

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`inspect-site: bad ${what}`);
  return value;
}

function number(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`inspect-site: bad ${what}`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`inspect-site: bad ${what}`);
  return value;
}

export async function inspectWebsiteViaCli(
  opts: { url: string; signal: AbortSignal },
  deps: CliChildDeps = {},
): Promise<WebsiteInspectionResult> {
  const dir = mkdtempSync(join(tmpdir(), "openvids-site-out-"));
  try {
    const run = await runCli(
      ["inspect-site", opts.url, "--json", "--out", dir, "--timeout", "30"],
      { signal: opts.signal },
      deps,
    );
    const report = run.json;
    if (report?.ok === false) {
      const code = FAILURE_CODES.find((candidate) => candidate === report.code);
      if (code && typeof report.error === "string")
        return { error: { code, message: report.error } };
    }
    if (run.code !== 0 || report?.ok !== true) throw new Error(failureMessage("inspect-site", run));

    const site = parseWebsiteStyle(report.site);
    if (!site) throw new Error("inspect-site: the style it reported is not usable");
    const read = (name: unknown, what: string): Uint8Array => {
      const file = resolve(dir, text(name, what));
      if (!file.startsWith(`${resolve(dir)}${sep}`))
        throw new Error(`inspect-site: ${what} escapes its folder`);
      return readFileSync(file);
    };

    const screenshots = list(report.screenshots, "screenshots").map((entry) => ({
      name: text(field(entry, "name"), "screenshot name"),
      mimeType: "image/jpeg",
      data: read(field(entry, "file"), "screenshot file"),
      width: number(field(entry, "width"), "screenshot width"),
      height: number(field(entry, "height"), "screenshot height"),
    }));
    const logoEntry = report.logo;
    const logo: WebsiteInspection["logo"] = logoEntry
      ? {
          name: text(field(logoEntry, "file"), "logo file").split("/").at(-1) ?? "logo",
          mimeType: text(field(logoEntry, "mimeType"), "logo type"),
          data: read(field(logoEntry, "file"), "logo file"),
          url: text(field(logoEntry, "url"), "logo url"),
        }
      : null;
    const fonts = list(report.fonts, "fonts").map((entry): WebsiteInspection["fonts"][number] => {
      const style = field(entry, "style");
      return {
        name: text(field(entry, "file"), "font file").split("/").at(-1) ?? "font",
        mimeType: text(field(entry, "mimeType"), "font type"),
        data: read(field(entry, "file"), "font file"),
        family: text(field(entry, "family"), "font family"),
        weight: number(field(entry, "weight"), "font weight"),
        style: style === "italic" ? "italic" : "normal",
        url: text(field(entry, "url"), "font url"),
      };
    });
    return { site, screenshots, logo, fonts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
