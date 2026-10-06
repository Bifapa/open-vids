import { describe, expect, it } from "vitest";
import type { DesignSourceKind } from "@hyperframes/agent-protocol";
import { attachedDesign, sampleManifest, sampleTokens, NO_DESIGN } from "../testing/design.js";
import type { DesignSnapshot } from "./host.js";
import {
  DESIGN_DIRECTOR,
  DESIGN_SPECIALIST,
  TOKENS_LINK,
  designInventoryLine,
  renderDesignSnapshotBlock,
  renderDesignTurnBlock,
} from "./prompt.js";
import { directorInstructions, specialistInstructions } from "../agents/roles.js";

const base = {
  visionEnabled: true,
  websitesAvailable: true,
  planProposal: true,
};

const turnBlock = (source: DesignSourceKind, extra = {}) =>
  renderDesignTurnBlock({
    ...base,
    action: "create",
    options: { source },
    ...extra,
  });

describe("design-turn block", () => {
  it("states the shared rules: library only, no composition writes, null licenses, guesses flagged", () => {
    const block = turnBlock("scratch");
    expect(block).toContain('<design-turn action="create" source="scratch">');
    expect(block).toContain("Do NOT change compositions or the timeline");
    expect(block).toContain("Never recolor a composition");
    expect(block).toContain("pass license: null — never invent one");
    expect(block).toContain('source "google"');
    expect(block).toContain('source "system"');
    expect(block).toContain("guess: true");
    expect(block).toContain("the result lists every problem");
    expect(block).toContain("Source: the brief");
  });

  it("limits a project source to what the extraction holds", () => {
    const block = turnBlock("project");
    expect(block).toContain(
      "extract_project_design is the ONLY source of colors, fonts, easings and durations",
    );
    expect(block).toContain("You only GROUP and NAME");
    expect(block).toContain("may not use a hex color that is not in the extraction");
    expect(block).toContain('"project_file" → source file with its projectPath');
    expect(block).toContain("license read_sources records for it (null when unknown)");
  });

  it("takes a video's colors from the measurement and marks fonts and transitions as guesses", () => {
    const block = renderDesignTurnBlock({
      ...base,
      action: "create",
      options: { source: "video", video: "assets/reel.mp4" },
    });
    expect(block).toContain("Source: the video assets/reel.mp4");
    expect(block).toContain("video_palette (measured from the pixels, exact)");
    expect(block).toContain("never eyeball a color from a frame");
    expect(block).toContain("is a GUESS");
    expect(block).toContain("closest Google Fonts family with guess: true");
    expect(block).toContain("transitions you estimate (kind, duration, ease) with guess: true");
    expect(block).toContain("delegate Vision");
    expect(
      renderDesignTurnBlock({
        ...base,
        visionEnabled: false,
        action: "create",
        options: { source: "video", video: "assets/reel.mp4" },
      }),
    ).toContain("yourself with inspect_frames");
  });

  it("starts a website source from the deterministic draft, and stops when sites cannot be read", () => {
    const block = renderDesignTurnBlock({
      ...base,
      action: "create",
      options: { source: "website", url: "https://acme.test/" },
    });
    expect(block).toContain("Source: the website https://acme.test/");
    expect(block).toContain("DRAFT SPEC");
    expect(block).toContain("keep every hex, font family, duration and easing exact");
    expect(block).toContain("its trademark: license null unless stated");
    expect(
      renderDesignTurnBlock({
        ...base,
        websitesAvailable: false,
        action: "create",
        options: { source: "website", url: "https://acme.test/" },
      }),
    ).toContain("reading websites is not available in this turn");
  });

  it("reads another project's extraction and never guesses it", () => {
    const block = turnBlock("external_project");
    expect(block).toContain("another project the user chose");
    expect(block).toContain("do not guess the other project's design");
  });

  it("an edit reads the system first, changes only what was asked and saves a new version to that system", () => {
    const block = renderDesignTurnBlock({
      ...base,
      action: "edit",
      options: { systemId: "acme" },
    });
    expect(block).toContain('<design-turn action="edit">');
    expect(block).toContain("edit the design system acme");
    expect(block).toContain("read_design_system on it first");
    expect(block).toContain('"make the accent warmer" moves --accent and --accent-2 together');
    expect(block).toContain("Everything the user did not mention stays exactly as you read it");
    expect(block).toContain("saves a NEW version");
    expect(block).toContain("only to acme");
    expect(block).toContain(
      "Choices of the user for this turn (fixed: you cannot change them): system acme.",
    );
  });

  it("allows a plan proposal only to apply the saved system, and only when plans are offered", () => {
    expect(turnBlock("scratch")).toContain("then call propose_plan with the steps of applying it");
    const off = turnBlock("scratch", { planProposal: false });
    expect(off).toContain("applying it is a separate step");
    expect(off).not.toContain("call propose_plan");
  });
});

describe("project design snapshot block", () => {
  const attached = attachedDesign({ version: 4 });
  const state = {
    attached,
    library: { name: "Acme", version: 4 },
    updateAvailable: false,
    snapshotOk: true,
  };
  const snapshot = (overrides: Partial<DesignSnapshot> = {}): DesignSnapshot => ({
    state,
    tokens: sampleTokens(),
    manifest: sampleManifest({ version: 4 }),
    ...overrides,
  });

  it("is absent when the project carries no system", () => {
    expect(
      renderDesignSnapshotBlock({ state: NO_DESIGN, tokens: null, manifest: null }),
    ).toBeNull();
    expect(designInventoryLine(NO_DESIGN)).toBeNull();
  });

  it("carries the link rule, the token rules and the tokens, as the first source of design truth", () => {
    const block = renderDesignSnapshotBlock(snapshot()) ?? "";
    expect(block.startsWith('<project-design system="acme" version="4">')).toBe(true);
    expect(block).toContain("first source of design truth, above frame.md and design.md");
    expect(block).toContain(`Link ${TOKENS_LINK} in the <head> of the root index.html`);
    expect(block).toContain("one link in the root document is enough");
    expect(block).toContain("resolve offline");
    expect(block).toContain("Never hard-code a color the system already has");
    expect(block).toContain(
      "do not restyle or recolor existing compositions unless the request asks for it",
    );
    expect(block).toContain("--bg: #0b0b10");
    expect(block).toContain("--ease-emphasis: cubic-bezier(0.2, 0.8, 0.2, 1)");
    expect(block).not.toContain("update-available");
  });

  it("stays compact: long values are clipped and long rule lists are counted, never dumped", () => {
    const rules = Array.from(
      { length: 30 },
      (_, index) => `Rule number ${index} ${"x".repeat(400)}`,
    );
    const block =
      renderDesignSnapshotBlock(
        snapshot({
          tokens: sampleTokens({ "--shadow-lg": `0 0 ${"9".repeat(500)}px #000` }),
          manifest: sampleManifest({ motionRules: rules, dos: rules, donts: rules }),
        }),
      ) ?? "";
    expect(block.length).toBeLessThan(6_000);
    expect(block).toContain("… 24 more in design/system.html");
    expect(block).not.toContain("Rule number 7");
    expect(block).toContain("…");
  });

  it("flags guesses, an available update and a damaged snapshot", () => {
    const withUpdate =
      renderDesignSnapshotBlock(
        snapshot({
          state: { ...state, library: { name: "Acme", version: 5 }, updateAvailable: true },
          manifest: sampleManifest({
            guesses: ["font Lora is a guess"],
            fonts: [
              {
                family: "Lora",
                role: "display",
                source: "system",
                weights: [400],
                license: null,
                files: [],
                portable: false,
                guess: true,
              },
            ],
          }),
        }),
      ) ?? "";
    expect(withUpdate).toContain('<project-design system="acme" version="4" update-available>');
    expect(withUpdate).toContain("Lora (display, system, 400, GUESS, system font: not portable)");
    expect(withUpdate).toContain("Guessed (not exact): font Lora is a guess");
    expect(withUpdate).toContain("The library holds version 5");
    expect(
      designInventoryLine({
        ...state,
        library: { name: "Acme", version: 5 },
        updateAvailable: true,
      }),
    ).toBe(
      'Design system: acme — "Acme", version 4 (the library has version 5; the user updates it). Its files are in design/ (system.html, tokens.css).',
    );

    const damaged =
      renderDesignSnapshotBlock({
        state: { ...state, snapshotOk: false },
        tokens: null,
        manifest: null,
      }) ?? "";
    expect(damaged).toContain("damaged or incomplete");
    expect(damaged).not.toContain("--bg");
  });
});

describe("role instructions", () => {
  it("tell the Director and the specialists that write compositions about the system and the link when the feature is on", () => {
    expect(directorInstructions([], { design: true })).toContain(DESIGN_DIRECTOR);
    expect(DESIGN_DIRECTOR).toContain(
      "applying a system to existing compositions is a separate step the user approves",
    );
    for (const id of ["editor", "motion"] as const) {
      expect(specialistInstructions(id, { design: true })).toContain(DESIGN_SPECIALIST);
    }
    for (const id of ["vision", "research", "audio"] as const) {
      expect(specialistInstructions(id, { design: true })).not.toContain(DESIGN_SPECIALIST);
    }
    expect(DESIGN_SPECIALIST).toContain(TOKENS_LINK);
    expect(DESIGN_SPECIALIST).toContain("before frame.md or design.md");
  });

  it("say nothing about design systems when the feature is off", () => {
    for (const options of [undefined, { design: false }]) {
      expect(directorInstructions([], options)).not.toContain("Design systems:");
      expect(directorInstructions([], options)).not.toContain("save_design_system");
      for (const id of ["editor", "motion", "vision", "research", "audio"] as const) {
        expect(specialistInstructions(id, options)).not.toContain("design/tokens.css");
      }
    }
  });

  it("tell the Director how a typed request works, and that video, website and other-project systems start from the Design button", () => {
    expect(DESIGN_DIRECTOR).toContain("In an ordinary turn the same tools answer a typed request");
    expect(DESIGN_DIRECTOR).toContain(
      "call extract_project_design first and use only the colors it lists",
    );
    expect(DESIGN_DIRECTOR).toContain("on the version you read");
    expect(DESIGN_DIRECTOR).toContain("started by the user from the Design button");
    expect(DESIGN_DIRECTOR).toContain(
      "never switching a project that already carries another system",
    );
  });
});
