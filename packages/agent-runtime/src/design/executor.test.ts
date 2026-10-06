import { describe, expect, it } from "vitest";
import type { DesignAction, DesignActionOptions } from "@hyperframes/agent-protocol";
import {
  FakeDesignHost,
  emptyExtraction,
  sampleSpec,
  sampleTokens,
  systemDetail,
} from "../testing/design.js";
import { TurnDesign, hexColorsIn } from "./executor.js";
import { DesignToolError } from "./host.js";

function setup(action: DesignAction | null, options: DesignActionOptions | null = null) {
  const host = new FakeDesignHost();
  const turnAbort = new AbortController();
  const design = new TurnDesign({
    host,
    turnSignal: turnAbort.signal,
    projectId: "project-one",
    action,
    options,
  });
  const call = (name: string, args: unknown) =>
    design.execute(name, args, new AbortController().signal);
  return { host, design, call };
}

const PALETTE = [
  "#0b0b10",
  "#f5f5f7",
  "#9a9aa5",
  "#15151d",
  "#2a2a36",
  "#ff5a36",
  "#ffb347",
  "#7c5cff",
];

describe("save_design_system in a create turn", () => {
  it("saves with the user's source, a name-derived id and the project, and echoes the library's notes", async () => {
    const { host, call, design } = setup("create", { source: "video", video: "assets/clip.mp4" });
    host.saveNotes = ["Downloaded Space Grotesk (4 files).", "Unknown license: font:Mystery"];
    const result = await call("save_design_system", { name: "Night Drive", spec: sampleSpec() });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain('Saved design system night-drive — "Night Drive" as version 1');
    expect(result.text).toContain("Downloaded Space Grotesk (4 files).");
    expect(result.text).toContain("Unknown license: font:Mystery");
    expect(host.saves).toHaveLength(1);
    expect(host.saves[0]).toMatchObject({
      id: "night-drive",
      request: {
        name: "Night Drive",
        source: { kind: "video", ref: "assets/clip.mp4" },
        projectId: "project-one",
      },
    });
    expect(host.saves[0]?.request.baseVersion).toBeUndefined();
    expect(design.hasSaved()).toBe(true);
  });

  it("refines the same system on a later save and refuses another id, a base version or another source", async () => {
    const { host, call } = setup("create", {
      source: "website",
      url: "https://www.acme.com/about",
    });
    await call("save_design_system", { name: "Acme", spec: sampleSpec() });
    expect(host.saves[0]?.request.source).toEqual({ kind: "website", ref: "acme.com" });

    const again = await call("save_design_system", { name: "Acme", spec: sampleSpec() });
    expect(again.isError).not.toBe(true);
    expect(host.saves[1]).toMatchObject({ id: "acme", request: { baseVersion: 1 } });

    const other = await call("save_design_system", {
      id: "other",
      name: "Other",
      spec: sampleSpec(),
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("already created acme");

    const wrongSource = await call("save_design_system", {
      name: "Acme",
      source: { kind: "scratch" },
      spec: sampleSpec(),
    });
    expect(wrongSource.isError).toBe(true);
    expect(wrongSource.text).toContain('The user chose "website"');
    expect(host.saves).toHaveLength(2);
  });

  it("refuses a baseVersion on a new system, and a taken id is the library's conflict", async () => {
    const { host, call } = setup("create");
    const withBase = await call("save_design_system", {
      name: "Fresh",
      baseVersion: 3,
      spec: sampleSpec(),
    });
    expect(withBase.isError).toBe(true);
    expect(withBase.text).toContain("omit baseVersion");
    expect(host.saves).toHaveLength(0);

    host.systems = [systemDetail("taken")];
    const taken = await call("save_design_system", { name: "Taken", spec: sampleSpec() });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("conflict");
  });

  it("validates the request before calling the library", async () => {
    const { host, call } = setup("create");
    const noName = await call("save_design_system", { spec: sampleSpec() });
    const unsafe = await call("save_design_system", {
      name: "Unsafe",
      spec: sampleSpec({ tokens: sampleTokens({ "--bg": "url(https://evil.test/x.png)" }) }),
    });
    const badFont = await call("save_design_system", {
      name: "Bad font",
      spec: sampleSpec({
        fonts: [{ family: "Inter", role: "body", source: "file", weights: [400], license: null }],
      }),
    });
    for (const result of [noName, unsafe, badFont]) {
      expect(result.isError).toBe(true);
      expect(result.text).toContain("invalid_request");
    }
    expect(noName.text).toContain("name must be");
    expect(unsafe.text).toContain("--bg");
    expect(badFont.text).toContain("needs projectPath");
    expect(host.saves).toHaveLength(0);
  });

  it("returns the library's invalid_system issues verbatim so the model can fix them all", async () => {
    const { host, call, design } = setup("create");
    host.nextSaveError = new DesignToolError("invalid_system", "The system is not valid.", [
      "--font-mono is missing",
      "font Inter: no files could be resolved",
    ]);
    const result = await call("save_design_system", { name: "Broken", spec: sampleSpec() });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "invalid_system: The system is not valid.\nIssues:\n- --font-mono is missing\n- font Inter: no files could be resolved",
    );
    expect(design.hasSaved()).toBe(false);
    // A failed save leaves the id free: the corrected spec creates the system.
    const fixed = await call("save_design_system", { name: "Broken", spec: sampleSpec() });
    expect(fixed.isError).not.toBe(true);
    expect(host.saves[1]?.request.baseVersion).toBeUndefined();
  });

  it("drops nulls the model sends for omitted fields but keeps an unknown license", async () => {
    const { host, call } = setup("create");
    await call("save_design_system", {
      name: "Nulls",
      id: null,
      baseVersion: null,
      spec: sampleSpec({
        fonts: [
          {
            family: "Mystery Sans",
            role: "display",
            source: "system",
            weights: [400],
            license: null,
          },
        ],
        logo: null,
      }),
    });
    const request = host.saves[0]?.request;
    expect(request?.spec.fonts[0]?.license).toBeNull();
    expect(request?.baseVersion).toBeUndefined();
  });
});

describe("save_design_system in an edit turn", () => {
  const options = { systemId: "acme" };

  it("needs the system read first and saves on the version that was read", async () => {
    const { host, call } = setup("edit", options);
    host.systems = [systemDetail("acme", { name: "Acme", version: 4 })];
    const early = await call("save_design_system", { name: "Acme", spec: sampleSpec() });
    expect(early.isError).toBe(true);
    expect(early.text).toContain("Read acme with read_design_system first");

    const read = await call("read_design_system", { id: "acme" });
    expect(read.text).toContain("baseVersion for an edit: 4");
    const saved = await call("save_design_system", { spec: sampleSpec() });
    expect(saved.isError).not.toBe(true);
    expect(host.saves[0]).toMatchObject({
      id: "acme",
      request: { baseVersion: 4, baseCreatedAt: 1, source: { kind: "scratch" } },
    });
    // The name the model read goes back only if it changed: a rename made meanwhile survives.
    expect(host.saves[0]?.request.name).toBeUndefined();
    // The next save builds on the version just saved.
    await call("save_design_system", { spec: sampleSpec() });
    expect(host.saves[1]?.request.baseVersion).toBe(5);
  });

  it("cannot save to another system or on another version", async () => {
    const { host, call } = setup("edit", options);
    host.systems = [systemDetail("acme", { version: 2 }), systemDetail("beta", { version: 1 })];
    await call("read_design_system", { id: "acme" });
    const other = await call("save_design_system", {
      id: "beta",
      name: "Beta",
      spec: sampleSpec(),
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("edits the system acme");
    const stale = await call("save_design_system", { baseVersion: 1, spec: sampleSpec() });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("baseVersion must be 2");
    expect(host.saves).toHaveLength(0);
  });

  it("does not count the read of another system or of an older version as the base", async () => {
    const { host, call } = setup("edit", options);
    host.systems = [systemDetail("acme", { version: 3 }), systemDetail("beta")];
    await call("read_design_system", { id: "beta" });
    await call("read_design_system", { id: "acme", version: 1 });
    const result = await call("save_design_system", { spec: sampleSpec() });
    expect(result.isError).toBe(true);
    expect(host.saves).toHaveLength(0);
  });

  it("returns the library's conflict when the system moved on", async () => {
    const { host, call } = setup("edit", options);
    host.systems = [systemDetail("acme", { version: 2 })];
    await call("read_design_system", { id: "acme" });
    host.systems = [systemDetail("acme", { version: 3 })];
    const result = await call("save_design_system", { spec: sampleSpec() });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("conflict");
  });
});

describe("a project-based system", () => {
  it("is built only from the extraction: save needs it first and refuses an invented color", async () => {
    const { host, call } = setup("create", { source: "project" });
    host.extraction = {
      ...emptyExtraction(),
      colors: PALETTE.map((value, index) => ({ value, count: 10 - index, roles: ["fill"] })),
    };
    const early = await call("save_design_system", { name: "From project", spec: sampleSpec() });
    expect(early.isError).toBe(true);
    expect(early.text).toContain("extract_project_design");

    const extraction = await call("extract_project_design", {});
    expect(extraction.text).toContain("#ff5a36 · ×5");

    const invented = await call("save_design_system", {
      name: "From project",
      spec: sampleSpec({ tokens: sampleTokens({ "--accent": "#12ab34", "--muted": "#ABC" }) }),
    });
    expect(invented.isError).toBe(true);
    expect(invented.text).toContain("#12ab34");
    expect(invented.text).toContain("#aabbcc");
    expect(invented.text).toContain("never invent one");
    expect(host.saves).toHaveLength(0);

    const fine = await call("save_design_system", {
      name: "From project",
      spec: sampleSpec({ tokens: sampleTokens({ "--accent": "#ffb347cc" }) }),
    });
    expect(fine.isError).not.toBe(true);
    expect(host.saves[0]?.request.source).toEqual({ kind: "project" });
  });

  it("counts a color the project already declares as a token", async () => {
    const { host, call } = setup("create", { source: "project" });
    host.extraction = {
      ...emptyExtraction(),
      colors: PALETTE.slice(1).map((value) => ({ value, count: 1, roles: ["fill"] })),
      declaredTokens: { "--bg": "#0b0b10" },
    };
    await call("extract_project_design", {});
    const result = await call("save_design_system", { name: "Declared", spec: sampleSpec() });
    expect(result.isError).not.toBe(true);
  });

  it("reads the other project's extraction for an external_project source and says when it is unavailable", async () => {
    const { host, call } = setup("create", { source: "external_project", projectKey: "proj-9" });
    const result = await call("extract_project_design", {});
    expect(host.externalCalls).toEqual(["proj-9"]);
    expect(host.extractCalls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("unavailable");
    const save = await call("save_design_system", { name: "Other", spec: sampleSpec() });
    expect(save.isError).toBe(true);
    expect(host.saves).toHaveLength(0);
  });
});

describe("video_palette", () => {
  it("measures the video the user chose and refuses another one in a video turn", async () => {
    const { host, call } = setup("create", { source: "video", video: "assets/clip.mp4" });
    host.palette = {
      video: "assets/clip.mp4",
      durationSec: 20,
      samples: 8,
      colors: [
        { value: "#101820", share: 0.55 },
        { value: "#ff6b35", share: 0.12 },
      ],
    };
    const fixed = await call("video_palette", {});
    expect(fixed.text).toContain("#101820 · 55%");
    expect(fixed.text).toContain("#ff6b35 · 12%");
    expect(host.paletteCalls[0]).toEqual({ video: "assets/clip.mp4", samples: undefined });

    const other = await call("video_palette", { video: "assets/other.mp4" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("assets/clip.mp4");
    expect(host.paletteCalls).toHaveLength(1);
  });

  it("needs a path when the user chose none and bounds the sample count", async () => {
    const { host, call } = setup("edit", { systemId: "acme" });
    const missing = await call("video_palette", {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Pass video");
    const tooMany = await call("video_palette", { video: "assets/a.mp4", samples: 99 });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain("samples must be a whole number from 1 to 24");
    await call("video_palette", { video: "assets/a.mp4", samples: 4 });
    expect(host.paletteCalls).toEqual([{ video: "assets/a.mp4", samples: 4 }]);
  });
});

describe("attach_design_system", () => {
  it("attaches only the system this turn saved, never touching compositions", async () => {
    const { host, call } = setup("create");
    const early = await call("attach_design_system", { id: "acme" });
    expect(early.isError).toBe(true);
    expect(early.text).toContain("Save the design system first");

    await call("save_design_system", { name: "Acme", spec: sampleSpec() });
    const other = await call("attach_design_system", { id: "someone-else" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("Only acme");

    const attached = await call("attach_design_system", { id: "acme" });
    expect(attached.isError).not.toBe(true);
    expect(attached.text).toContain("carries design system acme");
    expect(attached.text).toContain("Nothing in the compositions or the timeline was changed");
    expect(host.attaches).toEqual(["acme"]);
  });

  it("refuses to switch a project that carries another system", async () => {
    const { host, call } = setup("create");
    await call("save_design_system", { name: "Acme", spec: sampleSpec() });
    host.state = {
      attached: {
        schema: "openvids.project-design/1",
        id: "legacy",
        version: 2,
        name: "Legacy",
        attachedAt: 1,
        unknownLicenses: [],
        nonPortableFonts: [],
      },
      library: { name: "Legacy", version: 2 },
      updateAvailable: false,
      snapshotOk: true,
    };
    const result = await call("attach_design_system", { id: "acme" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('already carries "Legacy"');
    expect(host.attaches).toEqual([]);
  });
});

describe("TurnDesign lifecycle", () => {
  it("refuses new calls after shutdown and unknown tools", async () => {
    const { design, call } = setup("create");
    expect((await call("write_everything", {})).text).toContain("Unknown design tool");
    await design.shutdown();
    const result = await call("list_design_systems", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("finishing");
  });

  it("lists the library", async () => {
    const { host, call } = setup("create");
    expect((await call("list_design_systems", {})).text).toContain("library is empty");
    host.systems = [systemDetail("acme", { name: "Acme", version: 2, unknownLicenses: ["logo"] })];
    const listed = await call("list_design_systems", {});
    expect(listed.text).toContain('acme · "Acme" · version 2');
    expect(listed.text).toContain("unknown licenses: logo");
  });
});

describe("hexColorsIn", () => {
  it("normalises short and long hex colors and ignores everything else", () => {
    expect(hexColorsIn("linear-gradient(#FFF, #0a0b0c80) #12345g rgb(1,2,3)")).toEqual([
      "#ffffff",
      "#0a0b0c80",
    ]);
  });
});

describe("an edit does not undo a rename or a recreated system", () => {
  it("sends the name only when the model changed it from the one it read", async () => {
    const { host, call } = setup("edit", { systemId: "acme" });
    host.systems = [systemDetail("acme", { name: "Acme", version: 2 })];
    await call("read_design_system", { id: "acme" });
    // The user renames the system while the agent works; the agent sends back the name it read.
    host.systems = host.systems.map((system) => ({ ...system, name: "Acme Studio" }));
    await call("save_design_system", { name: "Acme", spec: sampleSpec() });
    expect(host.saves[0]?.request.name).toBeUndefined();
    expect(host.systems[0]?.name).toBe("Acme Studio");
    // A real rename goes through.
    await call("save_design_system", { name: "Acme Reborn", spec: sampleSpec() });
    expect(host.saves[1]?.request.name).toBe("Acme Reborn");
    expect(host.systems[0]?.name).toBe("Acme Reborn");
  });

  it("sends the lineage it read and gets the library's conflict when the id was recreated", async () => {
    const { host, call } = setup("edit", { systemId: "acme" });
    host.systems = [systemDetail("acme", { version: 2, createdAt: 500 })];
    await call("read_design_system", { id: "acme" });
    // Deleted and created again: the same id at version 2, another entry.
    host.systems = [systemDetail("acme", { version: 2, createdAt: 900 })];
    const result = await call("save_design_system", { spec: sampleSpec() });
    expect(host.saves[0]?.request).toMatchObject({ baseVersion: 2, baseCreatedAt: 500 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("conflict");
  });

  it("refines a system it created on that entry's lineage", async () => {
    const { host, call } = setup("create");
    await call("save_design_system", { name: "Fresh", spec: sampleSpec() });
    await call("save_design_system", { spec: sampleSpec() });
    expect(host.saves[1]?.request).toMatchObject({ baseVersion: 1, baseCreatedAt: 1 });
    expect(host.saves[1]?.request.name).toBeUndefined();
  });
});

describe("an edit of a system that came from a project", () => {
  it("may use colors the extraction does not list: the guard is for new systems", async () => {
    const { host, call } = setup("edit", { systemId: "acme" });
    host.systems = [systemDetail("acme", { source: { kind: "project" } })];
    await call("read_design_system", { id: "acme" });
    const result = await call("save_design_system", {
      spec: sampleSpec({ tokens: sampleTokens({ "--accent": "#ff9d3a" }) }),
    });
    expect(result.isError).not.toBe(true);
    expect(host.saves[0]?.request.source).toEqual({ kind: "project" });
  });
});

describe("the invented-color guard sees alpha in both directions", () => {
  it("accepts an opaque color whose only extracted form has alpha, and the other way round", async () => {
    const { host, call } = setup("create", { source: "project" });
    host.extraction = {
      ...emptyExtraction(),
      colors: PALETTE.map((value, index) => ({
        value: index === 0 ? `${value}99` : value,
        count: 3,
        roles: ["fill"],
      })),
    };
    await call("extract_project_design", {});
    const result = await call("save_design_system", {
      name: "Alpha",
      spec: sampleSpec({ tokens: sampleTokens({ "--bg": "#0b0b10", "--accent": "#ffb34780" }) }),
    });
    expect(result.isError).not.toBe(true);
    const invented = await call("save_design_system", {
      spec: sampleSpec({ tokens: sampleTokens({ "--bg": "#0b0b11" }) }),
    });
    expect(invented.isError).toBe(true);
    expect(invented.text).toContain("#0b0b11");
  });
});

describe("free mode (an ordinary turn: the user asked for a system in words)", () => {
  it("creates from the brief and refuses a video, website or external-project source", async () => {
    const { host, call, design } = setup(null);
    for (const kind of ["video", "website", "external_project"] as const) {
      const refused = await call("save_design_system", {
        name: "From elsewhere",
        source: { kind, ref: "x" },
        spec: sampleSpec(),
      });
      expect(refused.isError, kind).toBe(true);
      expect(refused.text).toContain("starts from the Design button");
    }
    expect(host.saves).toHaveLength(0);

    const brief = await call("save_design_system", { name: "Night Drive", spec: sampleSpec() });
    expect(brief.isError).not.toBe(true);
    expect(host.saves[0]).toMatchObject({
      id: "night-drive",
      request: { name: "Night Drive", source: { kind: "scratch" }, projectId: "project-one" },
    });
    expect(host.saves[0]?.request.baseVersion).toBeUndefined();
    expect(design.hasSaved()).toBe(true);
  });

  it("refuses the video palette: a video source starts from the dialog", async () => {
    const { host, call } = setup(null);
    const result = await call("video_palette", { video: "assets/clip.mp4" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Design button");
    expect(host.paletteCalls).toEqual([]);
  });

  it("creates from the project only after the extraction and only with its colors", async () => {
    const { host, call } = setup(null);
    host.extraction = {
      ...emptyExtraction(),
      colors: PALETTE.map((value) => ({ value, count: 2, roles: ["fill"] })),
    };
    const early = await call("save_design_system", {
      name: "Mine",
      source: { kind: "project" },
      spec: sampleSpec(),
    });
    expect(early.isError).toBe(true);
    expect(early.text).toContain("extract_project_design");
    await call("extract_project_design", {});
    const invented = await call("save_design_system", {
      name: "Mine",
      source: { kind: "project" },
      spec: sampleSpec({ tokens: sampleTokens({ "--brand": "#00ff00" }) }),
    });
    expect(invented.isError).toBe(true);
    expect(invented.text).toContain("#00ff00");
    const fine = await call("save_design_system", {
      name: "Mine",
      source: { kind: "project" },
      spec: sampleSpec(),
    });
    expect(fine.isError).not.toBe(true);
    expect(host.saves[0]?.request.source).toEqual({ kind: "project" });
    // Refining the system it created keeps the creation's rules.
    const refined = await call("save_design_system", {
      spec: sampleSpec({ tokens: sampleTokens({ "--brand": "#00ff00" }) }),
    });
    expect(refined.isError).toBe(true);
    expect(host.saves).toHaveLength(1);
  });

  it("changes an existing system only after reading it, on the version read, never creating by accident", async () => {
    const { host, call } = setup(null);
    host.systems = [systemDetail("acme", { name: "Acme", version: 3, createdAt: 77 })];
    const unread = await call("save_design_system", { id: "acme", spec: sampleSpec() });
    expect(unread.isError).toBe(true);
    expect(unread.text).toContain("name must be");

    const withBase = await call("save_design_system", {
      id: "acme",
      baseVersion: 3,
      spec: sampleSpec(),
    });
    expect(withBase.isError).toBe(true);
    expect(withBase.text).toContain("Read acme with read_design_system first");

    // Creating over a taken id is the library's conflict, with the way out spelled out.
    const taken = await call("save_design_system", { name: "Acme", spec: sampleSpec() });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("conflict");
    expect(taken.text).toContain("read it with read_design_system first");
    expect(host.saves).toHaveLength(1);

    await call("read_design_system", { id: "acme" });
    const stale = await call("save_design_system", {
      id: "acme",
      baseVersion: 2,
      spec: sampleSpec(),
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("baseVersion must be 3");
    const changed = await call("save_design_system", {
      id: "acme",
      spec: sampleSpec({ tokens: sampleTokens({ "--accent": "#ff9d3a" }) }),
    });
    expect(changed.isError).not.toBe(true);
    expect(host.saves[1]).toMatchObject({
      id: "acme",
      request: { baseVersion: 3, baseCreatedAt: 77 },
    });
    expect(host.saves[1]?.request.name).toBeUndefined();
  });

  it("attaches any system of the library, but never switches a project that carries another", async () => {
    const { host, call } = setup(null);
    host.systems = [systemDetail("sunset"), systemDetail("other")];
    const attached = await call("attach_design_system", { id: "sunset" });
    expect(attached.isError).not.toBe(true);
    expect(host.attaches).toEqual(["sunset"]);
    const switched = await call("attach_design_system", { id: "other" });
    expect(switched.isError).toBe(true);
    expect(switched.text).toContain("already carries");
    expect(host.attaches).toEqual(["sunset"]);
  });
});
