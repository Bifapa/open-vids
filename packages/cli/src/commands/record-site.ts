import { defineCommand } from "citty";
import { resolve } from "node:path";
import { WEBSITE_LIMITS } from "@hyperframes/agent-protocol";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";
import { failCommand, setCommandExitCode } from "../utils/commandResult.js";
import { normalizeErrorMessage } from "../utils/errorMessage.js";
import { createRenderCancellationScope } from "../utils/renderCancellation.js";
import { recordSite, type RecordSiteResult } from "../siteInspect/recordSite.js";
import { SiteInspectError } from "../siteInspect/siteSession.js";

export const examples: Example[] = [
  [
    "Record a page as an MP4",
    "hyperframes record-site https://linear.app --out ./linear.mp4 --seconds 5",
  ],
  [
    "Record one element, scrolling nothing",
    "hyperframes record-site https://stripe.com --out hero.mp4 --seconds 6 --selector .hero",
  ],
  [
    "Record a page while it scrolls top to bottom",
    "hyperframes record-site https://openvids.ai --out page.mp4 --seconds 10 --scroll",
  ],
];

function describe(result: RecordSiteResult): string {
  const lines = [
    `${c.accent(result.finalUrl)} — ${result.width}×${result.height}, ${result.duration}s, ${(result.bytes / 1_000_000).toFixed(1)} MB`,
    ...result.notes.map((note) => c.warn(`Note: ${note}`)),
  ];
  return lines.join("\n");
}

export default defineCommand({
  meta: {
    name: "record-site",
    description:
      "Open a public web page in headless Chrome and record it, in real time, as an H.264 MP4: the whole viewport, one element, optionally scrolling top to bottom. Only public http(s) addresses are opened.",
  },
  args: {
    url: {
      type: "positional",
      description: "The page to record (http or https)",
      required: true,
    },
    out: {
      type: "string",
      description: "Where to write the MP4",
      required: true,
    },
    seconds: {
      type: "string",
      description: `Recording length in seconds (${WEBSITE_LIMITS.recordMinSeconds}-${WEBSITE_LIMITS.recordMaxSeconds})`,
      default: "5",
    },
    selector: {
      type: "string",
      description: "Record only this element (CSS selector); default the whole viewport",
    },
    scroll: {
      type: "boolean",
      description: "Scroll smoothly from the top to the bottom of the page while recording",
      default: false,
    },
    width: {
      type: "string",
      description: `Viewport width in even pixels (2-${WEBSITE_LIMITS.recordMaxSide})`,
      default: "1920",
    },
    height: {
      type: "string",
      description: `Viewport height in even pixels (2-${WEBSITE_LIMITS.recordMaxSide})`,
      default: "1080",
    },
    timeout: {
      type: "string",
      description: "Total time budget in seconds (default: recording length + 40)",
    },
    json: {
      type: "boolean",
      description: "Print one JSON result; progress goes to stderr",
      default: false,
    },
  },
  async run({ args }) {
    const json = args.json;
    const invalid = (message: string): never => {
      if (json) console.log(JSON.stringify({ ok: false, code: "invalid_request", error: message }));
      else console.error(c.error(message));
      failCommand(1, message);
    };

    const seconds = Number(args.seconds);
    if (
      !Number.isInteger(seconds) ||
      seconds < WEBSITE_LIMITS.recordMinSeconds ||
      seconds > WEBSITE_LIMITS.recordMaxSeconds
    ) {
      invalid(
        `--seconds must be a whole number between ${WEBSITE_LIMITS.recordMinSeconds} and ${WEBSITE_LIMITS.recordMaxSeconds}`,
      );
    }
    const viewportSide = (value: string, flag: string): number => {
      const side = Number(value);
      if (!Number.isInteger(side) || side < 2 || side > WEBSITE_LIMITS.recordMaxSide || side % 2) {
        invalid(
          `${flag} must be an even whole number between 2 and ${WEBSITE_LIMITS.recordMaxSide}`,
        );
      }
      return side;
    };
    const width = viewportSide(args.width, "--width");
    const height = viewportSide(args.height, "--height");
    if (args.selector !== undefined && args.selector.length > WEBSITE_LIMITS.selectorChars) {
      invalid(`--selector must be at most ${WEBSITE_LIMITS.selectorChars} characters`);
    }
    const timeout = args.timeout === undefined ? seconds + 40 : Number(args.timeout);
    if (!Number.isFinite(timeout) || timeout < 5 || timeout > 180) {
      invalid("--timeout must be between 5 and 180 seconds");
    }

    const cancellation = createRenderCancellationScope();
    try {
      const result = await recordSite({
        url: args.url,
        outFile: resolve(args.out),
        seconds,
        ...(args.selector === undefined ? {} : { selector: args.selector }),
        scroll: args.scroll,
        width,
        height,
        budgetMs: timeout * 1000,
        signal: cancellation.signal,
        onProgress: (message) => console.error(message),
      });
      if (json) {
        console.log(
          JSON.stringify({
            ok: true,
            finalUrl: result.finalUrl,
            width: result.width,
            height: result.height,
            duration: result.duration,
            bytes: result.bytes,
            notes: result.notes,
          }),
        );
      } else {
        console.log(describe(result));
      }
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
