import { defineCommand } from "citty";
import { resolve } from "node:path";
import type { WebsiteStyle } from "@hyperframes/agent-protocol";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";
import { failCommand, setCommandExitCode } from "../utils/commandResult.js";
import { normalizeErrorMessage } from "../utils/errorMessage.js";
import { createRenderCancellationScope } from "../utils/renderCancellation.js";
import { inspectSite, type InspectSiteResult } from "../siteInspect/inspectSite.js";
import { SiteInspectError } from "../siteInspect/siteSession.js";

export const examples: Example[] = [
  ["Read a site's visual identity", "hyperframes inspect-site https://linear.app"],
  ["Machine-readable result", "hyperframes inspect-site https://stripe.com --json --out ./stripe"],
];

function describe(site: WebsiteStyle, result: InspectSiteResult): string[] {
  const lines = [
    `${c.accent(site.host)} — ${site.title || "(no title)"}`,
    site.description ? `  ${site.description}` : "",
    "",
    "Colors",
    ...site.colors.map((color) => `  ${color.hex}  ${color.role} (${color.count})`),
    "",
    "Fonts",
    ...site.fonts.map(
      (font) =>
        `  ${font.family}  ${font.weights.join("/")}  ${font.source}${font.usedFor.length ? `  for ${font.usedFor.join(", ")}` : ""}${font.url ? `  ${font.url}` : ""}`,
    ),
    "",
    "Type scale",
    ...site.textStyles.map(
      (style) =>
        `  ${style.element}  ${style.fontSizePx}px / ${style.fontWeight}  ${style.fontFamily}  "${style.sample}"`,
    ),
    "",
    `Radii ${site.radii.map((r) => `${r.px}px`).join(", ") || "-"}   Shadows ${site.shadows.length}   Buttons ${site.buttons.length}   Tokens ${site.tokens.length}`,
    `Motion ${site.motion.durationsMs.map((d) => `${d}ms`).join(", ") || "-"}  ${site.motion.easings.join(", ")}`,
    `Logo ${result.logo ? `${result.logo.file} (${result.logo.mimeType}) from ${result.logo.url}` : "not captured"}`,
    `Headings ${site.headings.slice(0, 3).join(" | ")}`,
    ...(site.resources.length > 0
      ? [
          "",
          `Files (${site.resources.length})`,
          ...site.resources
            .slice(0, 12)
            .map((resource) => `  ${resource.kind.padEnd(10)} ${resource.url}`),
        ]
      : []),
    ...site.notes.map((note) => c.warn(`Note: ${note}`)),
    "",
    `Files in ${result.screenshots.map((shot) => shot.file).join(", ")}${result.logo ? `, ${result.logo.file}` : ""}${result.fonts.length ? `, ${result.fonts.map((font) => font.file).join(", ")}` : ""}`,
  ];
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "");
}

export default defineCommand({
  meta: {
    name: "inspect-site",
    description:
      "Open a public web page in headless Chrome and read its visual identity: palette, fonts, logo, type scale, radii, buttons, motion character, screenshots. Only public http(s) addresses are opened.",
  },
  args: {
    url: {
      type: "positional",
      description: "The page to read (http or https)",
      required: true,
    },
    out: {
      type: "string",
      description: "Directory for the screenshots, logo and font files",
      default: "./site-inspect",
    },
    timeout: {
      type: "string",
      description: "Total time budget in seconds",
      default: "30",
    },
    json: {
      type: "boolean",
      description: "Print one JSON result; progress goes to stderr",
      default: false,
    },
  },
  async run({ args }) {
    const json = args.json;
    const seconds = Number(args.timeout);
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) {
      const message = "--timeout must be between 5 and 120 seconds";
      if (json) console.log(JSON.stringify({ ok: false, code: "invalid_request", error: message }));
      else console.error(c.error(message));
      failCommand(1, message);
    }

    const cancellation = createRenderCancellationScope();
    try {
      const result = await inspectSite({
        url: args.url,
        outDir: resolve(args.out),
        signal: cancellation.signal,
        budgetMs: seconds * 1000,
        onProgress: (message) => console.error(message),
      });
      if (json) console.log(JSON.stringify({ ok: true, ...result }));
      else console.log(describe(result.site, result).join("\n"));
    } catch (error) {
      if (cancellation.signal.aborted) {
        if (json) console.log(JSON.stringify({ ok: false, code: "cancelled", error: "Cancelled" }));
        setCommandExitCode(130);
        return;
      }
      const code = error instanceof SiteInspectError ? error.code : "network";
      const message = normalizeErrorMessage(error);
      if (json) console.log(JSON.stringify({ ok: false, code, error: message }));
      else console.error(c.error(message));
      failCommand(1, error);
    } finally {
      cancellation.dispose();
    }
  },
});
