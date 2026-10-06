import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  DesignManifestFont,
  DesignSystemSpec,
  SaveDesignSystemRequest,
} from "@hyperframes/agent-protocol";
import type { GoogleFontFace } from "./googleFonts.js";
import type { RenderDesignInput } from "./render.js";

export const REQUIRED_TOKEN_VALUES: Record<string, string> = {
  "--bg": "#0b0b0f",
  "--fg": "#f4f1ea",
  "--muted": "#9a968c",
  "--surface": "#16161d",
  "--border": "#2a2a35",
  "--brand": "#ff6a3d",
  "--accent": "#ffd166",
  "--accent-2": "#4ecdc4",
  "--font-display": '"Space Grotesk", sans-serif',
  "--font-body": '"Inter", sans-serif',
  "--font-mono": "ui-monospace, monospace",
  "--radius": "12px",
  "--space-1": "8px",
  "--space-2": "16px",
  "--space-3": "32px",
  "--dur-beat": "0.5s",
  "--ease-standard": "cubic-bezier(0.4, 0, 0.2, 1)",
  "--ease-emphasis": "cubic-bezier(0.2, 0.8, 0.2, 1)",
};

export function sampleSpec(overrides: Partial<DesignSystemSpec> = {}): DesignSystemSpec {
  return {
    tokens: { ...REQUIRED_TOKEN_VALUES, "--text-base": "16px" },
    colorNames: { "--brand": "Sunset orange", "--bg": "Ink" },
    fonts: [
      {
        family: "Space Grotesk",
        role: "display",
        source: "google",
        weights: [400, 700],
        license: null,
      },
      { family: "Helvetica Neue", role: "body", source: "system", weights: [400], license: null },
    ],
    transitions: [
      { name: "Quick fade", kind: "fade", durationSec: 0.4, ease: "power2.out" },
      {
        name: "Slide in",
        kind: "slide",
        durationSec: 0.6,
        ease: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        note: "From the left",
        guess: true,
      },
      { name: "Hard cut", kind: "cut", durationSec: 0, ease: "linear" },
    ],
    motionRules: ["Cuts on the beat", "Never longer than 0.6 s"],
    dos: ["Use the brand colour for one thing per scene"],
    donts: ["Don't stack two transitions"],
    summary: "A bold, warm system for talks.",
    ...overrides,
  };
}

export function sampleRequest(
  overrides: Partial<SaveDesignSystemRequest> = {},
): SaveDesignSystemRequest {
  return { name: "Sunset Talks", source: { kind: "scratch" }, spec: sampleSpec(), ...overrides };
}

export const OFL = { name: "SIL Open Font License 1.1", url: "https://openfontlicense.org" };

/** A manifest font as the library stores it, with one stored file. */
export function storedFont(family = "Inter", role: DesignManifestFont["role"] = "display") {
  return {
    family,
    role,
    source: "google",
    weights: [400],
    license: OFL,
    files: [
      {
        path: `fonts/${family.toLowerCase()}-400-normal-latin-abcd1234.woff2`,
        weight: 400,
        style: "normal",
      },
    ],
    portable: true,
  } satisfies DesignManifestFont;
}

export function renderInput(overrides: Partial<RenderDesignInput> = {}): RenderDesignInput {
  return {
    spec: sampleSpec({ fonts: [] }),
    fonts: [
      storedFont("Inter"),
      {
        ...storedFont("Mono", "mono"),
        source: "file",
        projectPath: "assets/Mono.ttf",
        license: null,
      },
    ],
    logo: { path: "logo.svg", license: OFL },
    version: 3,
    source: { kind: "video", ref: "clip.mp4" },
    ...overrides,
  };
}

/** woff2 bytes as far as the library checks them (the magic tag), made distinct by `seed`. */
export function fakeWoff2(seed: string): Uint8Array {
  return Buffer.concat([Buffer.from("wOF2"), Buffer.from(seed)]);
}

export function fakeFaces(family: string, weights: number[]): GoogleFontFace[] {
  return weights.flatMap((weight) =>
    ["latin", "latin-ext"].map((subset) => ({
      weight,
      style: "normal" as const,
      subset,
      unicodeRange: subset === "latin" ? "U+0000-00FF" : "U+0100-02AF",
      data: fakeWoff2(`${family}-${weight}-${subset}`),
    })),
  );
}

export function makeTempDir(prefix = "openvids-design-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeProjectFile(
  projectDir: string,
  path: string,
  data: string | Uint8Array,
): void {
  const target = join(projectDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}
