import { describe, expect, it } from "vitest";
import { DESIGN_REQUIRED_TOKENS, parseDesignSystemSpec } from "@hyperframes/agent-protocol";
import { FakeResearchHost, sampleWebsiteStyle } from "../testing/research.js";
import { TurnResearch } from "../research/executor.js";
import { WebsiteResourceLog } from "../research/websiteResources.js";
import { formatSpecDraft, websiteStyleToSpecDraft } from "./website.js";

const site = () => sampleWebsiteStyle("https://www.acme.test/");

describe("websiteStyleToSpecDraft", () => {
  it("maps the site's colors to the tokens by role, exactly, and names what it could not derive", () => {
    const draft = websiteStyleToSpecDraft(site());
    expect(draft.tokens).toMatchObject({
      "--bg": "#0b0b0f",
      "--fg": "#f4f4f5",
      "--surface": "#16161d",
      "--brand": "#5e6ad2",
    });
    // One accent on the site: the other two accent tokens reuse it, and the model is told.
    expect(draft.tokens["--accent"]).toBe("#5e6ad2");
    expect(draft.tokens["--accent-2"]).toBe("#5e6ad2");
    expect(draft.notes.join(" ")).toContain("1 accent color");
    // The site never used a muted or a border color: they are left to the model, not invented.
    expect(draft.missingTokens).toEqual(["--muted", "--border"]);
    expect(draft.tokens).not.toHaveProperty("--muted");
    for (const hex of Object.values(draft.tokens).filter((value) => value.startsWith("#")))
      expect(site().colors.map((color) => color.hex)).toContain(hex);
  });

  it("maps fonts to google, saved file and system sources and gives each family one role", () => {
    const unsaved = websiteStyleToSpecDraft(site());
    expect(unsaved.fonts).toEqual([
      { family: "Inter", role: "display", source: "google", weights: [400, 600], license: null },
      { family: "Brand Display", role: "other", source: "system", weights: [700], license: null },
    ]);
    expect(unsaved.notes.join(" ")).toContain(
      "Brand Display is self-hosted by the site and was NOT saved",
    );
    expect(unsaved.tokens["--font-display"]).toBe('"Inter", sans-serif');
    expect(unsaved.tokens["--font-body"]).toBe('"Inter", sans-serif');
    expect(unsaved.defaultedTokens).toContain("--font-mono");

    const saved = websiteStyleToSpecDraft(site(), {
      dir: "assets/web/acme.test",
      files: [],
      logo: "assets/web/acme.test/logo.svg",
      screenshots: [],
      fonts: [
        {
          family: "Brand Display",
          weight: 700,
          style: "normal",
          path: "assets/web/acme.test/fonts/brand-700.woff2",
        },
        {
          family: "Brand Display",
          weight: 400,
          style: "normal",
          path: "assets/web/acme.test/fonts/brand-400.woff2",
        },
      ],
    });
    expect(saved.fonts[1]).toEqual({
      family: "Brand Display",
      role: "other",
      source: "file",
      weights: [400],
      projectPath: "assets/web/acme.test/fonts/brand-400.woff2",
      license: null,
    });
    expect(saved.logo).toEqual({ projectPath: "assets/web/acme.test/logo.svg", license: null });
  });

  it("takes the beat, easings and transitions from the site's own CSS", () => {
    const draft = websiteStyleToSpecDraft(site());
    expect(draft.tokens["--dur-beat"]).toBe("0.3s");
    expect(draft.tokens["--dur-fast"]).toBe("0.15s");
    expect(draft.tokens).not.toHaveProperty("--dur-slow");
    expect(draft.tokens["--ease-standard"]).toBe("cubic-bezier(0.16, 1, 0.3, 1)");
    expect(draft.defaultedTokens).toContain("--ease-emphasis");
    expect(draft.transitions).toEqual([
      expect.objectContaining({
        name: "Fade 1",
        kind: "fade",
        durationSec: 0.15,
        ease: "cubic-bezier(0.16, 1, 0.3, 1)",
      }),
    ]);
    expect(draft.motionRules[0]).toContain("150–300 ms");
    expect(draft.tokens["--radius"]).toBe("8px");
    expect(draft.tokens["--text-4xl"]).toBe("64px");
  });

  it("is deterministic: the same style gives the same draft, whatever order the colors came in", () => {
    const style = site();
    const shuffled = { ...style, colors: [...style.colors].reverse() };
    expect(websiteStyleToSpecDraft(shuffled)).toEqual(websiteStyleToSpecDraft(style));
    expect(JSON.stringify(websiteStyleToSpecDraft(style))).toBe(
      JSON.stringify(websiteStyleToSpecDraft(style)),
    );
  });

  it("produces a spec the protocol accepts once the model fills the missing tokens", () => {
    const draft = websiteStyleToSpecDraft(site());
    const tokens = { ...draft.tokens, "--muted": "#a1a1aa", "--border": "#27272a" };
    expect(DESIGN_REQUIRED_TOKENS.filter((name) => !(name in tokens))).toEqual([]);
    const parsed = parseDesignSystemSpec({
      tokens,
      fonts: draft.fonts,
      transitions: draft.transitions,
      motionRules: draft.motionRules,
      dos: [],
      donts: [],
      summary: draft.summary,
    });
    expect(parsed.ok).toBe(true);
  });

  it("fills a color-less site with nothing it cannot know", () => {
    const draft = websiteStyleToSpecDraft({ ...site(), colors: [], themeColor: null, fonts: [] });
    expect(draft.missingTokens).toEqual([
      "--bg",
      "--fg",
      "--muted",
      "--surface",
      "--border",
      "--brand",
      "--accent",
      "--accent-2",
    ]);
    expect(draft.tokens["--font-display"]).toBe("system-ui, sans-serif");
    expect(draft.fonts).toEqual([]);
  });
});

describe("the draft in a design turn's read_website result", () => {
  const turn = (designDraft: boolean) => {
    const host = new FakeResearchHost();
    const research = new TurnResearch({
      host,
      turnId: "turn-1",
      turnSignal: new AbortController().signal,
      enabled: ["motion"],
      turn: { mode: "normal", action: null },
      storyOptions: null,
      intent: "edit",
      websites: { chatId: "chat-1", resources: new WebsiteResourceLog() },
      userTexts: () => ["https://www.acme.test/"],
      turnUserTexts: () => ["https://www.acme.test/"],
      askBeforeDownloads: false,
      model: () => null,
      designDraft,
    });
    return research.execute(
      "director",
      "read_website",
      { url: "https://www.acme.test/" },
      new AbortController().signal,
    );
  };

  it("ends the site's style with the draft only in a website design turn", async () => {
    const withDraft = await turn(true);
    expect(withDraft.text).toContain("Website style of acme.test");
    expect(withDraft.text).toContain("Design system draft from this site");
    expect(withDraft.text).toContain('"--brand":"#5e6ad2"');
    expect(withDraft.text).toContain("Required tokens the site did not reveal");
    expect((await turn(false)).text).not.toContain("Design system draft");
  });

  it("formats the draft with what is missing and defaulted", () => {
    const text = formatSpecDraft(websiteStyleToSpecDraft(site()));
    expect(text).toContain("keep them exact and only refine");
    expect(text).toContain("--muted, --border");
    expect(text).toContain("Tokens filled with a generic default");
  });
});
