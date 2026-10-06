import { describe, expect, it } from "vitest";
import {
  DESIGN_REQUIRED_TOKENS,
  designSystemIdFromName,
  isSafeDesignTokenValue,
  parseAttachDesignRequest,
  parseDesignSystemSpec,
  parseSaveDesignSystemRequest,
} from "./design.js";
import { DESIGN_SYSTEM_ID_PATTERN } from "./types.js";
import { parseDesignActionOptions, parseStartTurn } from "./validate.js";

function spec(): Record<string, unknown> {
  return {
    tokens: Object.fromEntries(DESIGN_REQUIRED_TOKENS.map((token) => [token, "#123456"])),
    fonts: [
      {
        family: "Inter",
        role: "display",
        source: "google",
        weights: [700, 400, 400],
        license: null,
      },
    ],
    transitions: [{ name: "Fade", kind: "fade", durationSec: 0.4, ease: "ease-out" }],
    motionRules: ["Cut on the beat"],
    dos: [],
    donts: [],
  };
}

describe("design token values", () => {
  it("accepts plain CSS values and refuses anything that could leave its declaration", () => {
    for (const value of [
      "#fff",
      "2.4cqmin",
      'Inter, "Helvetica Neue", sans-serif',
      "cubic-bezier(0.2, 1, 0.2, 1)",
    ])
      expect(isSafeDesignTokenValue(value)).toBe(true);
    for (const value of [
      "red; } body { background: url(//evil) }",
      "url(https://x.test/a.png)",
      "@import 'x'",
      "a /* c */",
      "a\\62",
      "<b>",
      "expression(alert(1))",
      "",
      "   ",
    ])
      expect(isSafeDesignTokenValue(value), value).toBe(false);
  });
});

describe("parseDesignSystemSpec", () => {
  it("normalises weights and keeps only declared fields", () => {
    const parsed = parseDesignSystemSpec(spec());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.fonts[0]?.weights).toEqual([400, 700]);
  });

  it("refuses unsafe tokens, odd family names and file fonts without a path", () => {
    const unsafe = spec();
    Object.assign(unsafe.tokens as object, { "--bg": "red; color: blue" });
    expect(parseDesignSystemSpec(unsafe).ok).toBe(false);

    const family = spec();
    family.fonts = [
      { family: 'Inter"; }', role: "body", source: "system", weights: [400], license: null },
    ];
    expect(parseDesignSystemSpec(family).ok).toBe(false);

    const file = spec();
    file.fonts = [{ family: "Own", role: "body", source: "file", weights: [400], license: null }];
    expect(parseDesignSystemSpec(file).ok).toBe(false);
  });
});

describe("parseSaveDesignSystemRequest", () => {
  it("needs a plain name, a source and a spec, and a positive integer baseVersion", () => {
    const body = { name: "Acme", source: { kind: "scratch" }, spec: spec() };
    expect(parseSaveDesignSystemRequest(body).ok).toBe(true);
    expect(parseSaveDesignSystemRequest({ ...body, name: "<b>Acme</b>" }).ok).toBe(false);
    expect(parseSaveDesignSystemRequest({ ...body, source: { kind: "dream" } }).ok).toBe(false);
    expect(parseSaveDesignSystemRequest({ ...body, baseVersion: 0 }).ok).toBe(false);
    expect(parseSaveDesignSystemRequest({ ...body, baseVersion: 2 }).ok).toBe(true);
  });
});

describe("ids", () => {
  it("derives a library id from any name", () => {
    for (const name of [
      "Acme Corp!",
      "Дизайн система",
      "  ---  ",
      "Café Déjà-vu",
      "x".repeat(200),
    ]) {
      expect(designSystemIdFromName(name)).toMatch(DESIGN_SYSTEM_ID_PATTERN);
    }
    expect(designSystemIdFromName("Café Déjà-vu")).toBe("cafe-deja-vu");
    expect(designSystemIdFromName("Дизайн")).toBe("system");
  });

  it("refuses an attach request whose id is not a library id", () => {
    expect(parseAttachDesignRequest({ id: "acme" }).ok).toBe(true);
    expect(parseAttachDesignRequest({ id: "../acme" }).ok).toBe(false);
    expect(parseAttachDesignRequest({ id: "Acme" }).ok).toBe(false);
  });
});

describe("design actions in a start-turn request", () => {
  it("accepts an edit with its system, and refuses what the action cannot carry", () => {
    const edit = parseStartTurn({
      prompt: "make the accent warmer",
      designAction: "edit",
      designOptions: { systemId: "acme" },
    });
    expect(edit.ok).toBe(true);
    expect(parseStartTurn({ prompt: "x", designAction: "edit" }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", designAction: "create" }).ok).toBe(true);
    expect(parseStartTurn({ prompt: "x", designAction: "edit", designOptions: {} }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", designOptions: { source: "scratch" } }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", designAction: "create", storyAction: "review" }).ok).toBe(
      false,
    );
    expect(parseStartTurn({ prompt: "x", designAction: "create", intent: "ask" }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", designAction: "remove" }).ok).toBe(false);
  });

  it("needs the field each source reads", () => {
    expect(parseDesignActionOptions({ source: "video" }, "create").ok).toBe(false);
    expect(parseDesignActionOptions({ source: "video", video: "assets/a.mp4" }, "create").ok).toBe(
      true,
    );
    expect(parseDesignActionOptions({ source: "website" }, "create").ok).toBe(false);
    expect(parseDesignActionOptions({ source: "external_project" }, "create").ok).toBe(false);
    expect(
      parseDesignActionOptions({ source: "external_project", projectKey: "k" }, "create").ok,
    ).toBe(true);
    expect(parseDesignActionOptions({ systemId: "acme", source: "scratch" }, "edit").ok).toBe(
      false,
    );
    expect(parseDesignActionOptions({ source: "scratch", extra: 1 }, "create").ok).toBe(false);
  });
});

describe("reserved device names", () => {
  it("never become library ids, so a folder of that name can be made on Windows", () => {
    for (const name of ["Con", "NUL", "com1", "LPT9", "aux"]) {
      const id = designSystemIdFromName(name);
      expect(id).toBe(`${name.toLowerCase()}-system`);
      expect(parseAttachDesignRequest({ id }).ok).toBe(true);
      expect(parseAttachDesignRequest({ id: name.toLowerCase() }).ok).toBe(false);
    }
    expect(parseDesignActionOptions({ systemId: "con" }, "edit").ok).toBe(false);
  });
});

describe("saving an edit", () => {
  const body = { source: { kind: "scratch" }, spec: spec() };
  it("may leave the name out only with a baseVersion, and the lineage only with one too", () => {
    expect(parseSaveDesignSystemRequest(body).ok).toBe(false);
    const edit = parseSaveDesignSystemRequest({ ...body, baseVersion: 2, baseCreatedAt: 5 });
    expect(edit.ok && edit.value.name).toBeUndefined();
    expect(edit.ok && edit.value.baseCreatedAt).toBe(5);
    expect(parseSaveDesignSystemRequest({ ...body, name: "A", baseCreatedAt: 5 }).ok).toBe(false);
  });
});
