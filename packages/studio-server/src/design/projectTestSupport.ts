import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DesignSystemSpec, SaveDesignSystemResult } from "@hyperframes/agent-protocol";
import { DesignLibrary } from "./library.js";

const TOKENS: Record<string, string> = {
  "--bg": "#0b0b0f",
  "--fg": "#ffffff",
  "--muted": "#9a9aa5",
  "--surface": "#16161d",
  "--border": "#2a2a35",
  "--brand": "#ff3366",
  "--accent": "#00ccff",
  "--accent-2": "#ffcc00",
  "--font-display": '"Space Grotesk", sans-serif',
  "--font-body": '"Inter", sans-serif',
  "--font-mono": "monospace",
  "--radius": "12px",
  "--space-1": "4px",
  "--space-2": "8px",
  "--space-3": "16px",
  "--dur-beat": "0.4s",
  "--ease-standard": "cubic-bezier(0.4, 0, 0.2, 1)",
  "--ease-emphasis": "cubic-bezier(0.2, 0.8, 0.2, 1)",
};

/** A valid spec: a Google display font, a Google body font and one machine-only font whose license is unknown. */
export function projectSpec(brand = "#ff3366"): DesignSystemSpec {
  return {
    tokens: { ...TOKENS, "--brand": brand },
    fonts: [
      { family: "Space Grotesk", role: "display", source: "google", weights: [700], license: null },
      { family: "Inter", role: "body", source: "google", weights: [400], license: null },
      { family: "Helvetica Neue", role: "mono", source: "system", weights: [400], license: null },
    ],
    transitions: [{ name: "Beat", kind: "fade", durationSec: 0.4, ease: "ease-out" }],
    motionRules: ["Cuts on the beat"],
    dos: ["Use the brand colour for one thing per scene"],
    donts: ["No more than two fonts"],
    summary: "A test system",
  };
}

/** A library over its own temp folder whose font fetcher answers from memory (no network). */
export function tempLibrary(): { library: DesignLibrary; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "openvids-design-lib-"));
  const library = new DesignLibrary(join(root, "library"), {
    fetchFont: async (_family, weights, italic) =>
      weights.map((weight) => ({
        weight,
        style: italic ? ("italic" as const) : ("normal" as const),
        subset: "latin",
        data: new Uint8Array([0x77, 0x4f, 0x46, 0x32, weight % 256]),
      })),
  });
  return { library, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

export function seedSystem(
  library: DesignLibrary,
  id: string,
  options: { name?: string; brand?: string; baseVersion?: number } = {},
): Promise<SaveDesignSystemResult> {
  return library.save(id, {
    name: options.name ?? "Midnight",
    source: { kind: "scratch" },
    spec: projectSpec(options.brand),
    ...(options.baseVersion !== undefined && { baseVersion: options.baseVersion }),
  });
}

/** A project folder with a root composition, one sub-composition and a stylesheet. */
export function tempProject(files: Record<string, string> = {}): {
  dir: string;
  dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "openvids-design-project-"));
  const all: Record<string, string> = {
    "index.html": `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="5" style="background:#111"></div></body></html>`,
    "compositions/outro.html": `<div data-composition-id="outro" style="color:#fff"></div>`,
    "styles.css": `body { color: #eee; }`,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
