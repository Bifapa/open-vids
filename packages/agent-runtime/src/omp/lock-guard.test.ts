import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardLockedClips } from "./lock-guard.ts";
import { projectToolCallGuard } from "./tool-guard.ts";

const LOCKED_HTML = `<div id="root" data-composition-id="main">
  <div id="title" class="clip" data-hf-id="hf-title" data-start="0" data-duration="4" data-timeline-locked="" style="color: white">Hello</div>
  <div id="sub" class="clip" data-hf-id="hf-sub" data-start="4" data-duration="3" style="color: red">World</div>
</div>
`;

const UNLOCKED_HTML = LOCKED_HTML.replace(' data-timeline-locked=""', "");

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "omp-lock-guard-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function edit(oldString: string, newString: string, extra: Record<string, unknown> = {}) {
  return { path: "index.html", old_string: oldString, new_string: newString, ...extra };
}

describe("locked timeline clips vs edit/write", () => {
  beforeEach(async () => {
    await writeFile(path.join(projectDir, "index.html"), LOCKED_HTML);
  });

  it("blocks an edit that changes a locked clip's style, text or attributes", async () => {
    for (const input of [
      edit("color: white", "color: hotpink"),
      edit(">Hello<", ">Bye<"),
      edit('data-duration="4"', 'data-duration="9"'),
    ]) {
      const reason = await guardLockedClips(projectDir, input, "edit");
      expect(reason).toContain('"#title"');
      expect(reason).toContain("change");
      expect(reason).toContain("unlock");
    }
  });

  it("blocks removing a locked clip by edit and by write", async () => {
    const line = `  <div id="title" class="clip" data-hf-id="hf-title" data-start="0" data-duration="4" data-timeline-locked="" style="color: white">Hello</div>\n`;
    expect(await guardLockedClips(projectDir, edit(line, ""), "edit")).toContain("remove");
    expect(
      await guardLockedClips(
        projectDir,
        { path: "index.html", content: LOCKED_HTML.replace(line, "") },
        "write",
      ),
    ).toContain('"#title"');
  });

  it("blocks an agent unlocking a clip", async () => {
    const reason = await guardLockedClips(projectDir, edit(' data-timeline-locked=""', ""), "edit");
    expect(reason).toContain("unlock");
    expect(
      await guardLockedClips(projectDir, { path: "index.html", content: UNLOCKED_HTML }, "write"),
    ).toContain("unlock");
  });

  it("identifies a locked clip by data-hf-id, falling back to id, and still catches a renamed id", async () => {
    await writeFile(
      path.join(projectDir, "ids.html"),
      `<div id="a" data-timeline-locked>A</div><div data-hf-id="hf-b" data-timeline-locked>B</div><p>x</p>`,
    );
    const target = { path: "ids.html" };
    expect(
      await guardLockedClips(
        projectDir,
        { ...target, old_string: ">A<", new_string: ">Z<" },
        "edit",
      ),
    ).toContain('"#a"');
    expect(
      await guardLockedClips(
        projectDir,
        { ...target, old_string: ">B<", new_string: ">Z<" },
        "edit",
      ),
    ).toContain("hf-b");
    expect(
      await guardLockedClips(
        projectDir,
        { ...target, old_string: 'id="a"', new_string: 'id="z"' },
        "edit",
      ),
    ).toContain("remove");
    expect(
      await guardLockedClips(
        projectDir,
        { ...target, old_string: "<p>x</p>", new_string: "<p>y</p>" },
        "edit",
      ),
    ).toBeNull();
  });

  it("treats a lock attribute written in another case as a lock", async () => {
    await writeFile(
      path.join(projectDir, "upper.html"),
      `<div id="a" DATA-TIMELINE-LOCKED>A</div><p>x</p>`,
    );
    expect(
      await guardLockedClips(
        projectDir,
        { path: "upper.html", old_string: ">A<", new_string: ">B<" },
        "edit",
      ),
    ).toContain('"#a"');
  });

  it("allows edits and writes that leave every locked clip untouched", async () => {
    expect(
      await guardLockedClips(projectDir, edit("color: red", "color: blue"), "edit"),
    ).toBeNull();
    expect(await guardLockedClips(projectDir, edit(">World<", ">All<"), "edit")).toBeNull();
    expect(
      await guardLockedClips(
        projectDir,
        { path: "index.html", content: LOCKED_HTML.replace("World", "Earth") + "<!-- end -->\n" },
        "write",
      ),
    ).toBeNull();
    // a brand-new clip next to the locked one is fine
    expect(
      await guardLockedClips(
        projectDir,
        edit("World</div>\n</div>\n", 'World</div>\n<div id="extra" class="clip"></div></div>\n'),
        "edit",
      ),
    ).toBeNull();
  });

  it("follows replace_all: every occurrence is replaced, not just the first", async () => {
    await writeFile(
      path.join(projectDir, "all.html"),
      `<p class="x">a</p><p class="x">b</p><div id="t" data-timeline-locked><span class="x">k</span></div>`,
    );
    const input = { path: "all.html", old_string: 'class="x"', new_string: 'class="y"' };
    expect(await guardLockedClips(projectDir, input, "edit")).toContain("matches 3 places");
    expect(await guardLockedClips(projectDir, { ...input, replace_all: true }, "edit")).toContain(
      '"#t"',
    );
    const outside = { path: "all.html", old_string: '<p class="x">a</p>', new_string: "<p>a</p>" };
    expect(await guardLockedClips(projectDir, outside, "edit")).toBeNull();
  });

  it("fails closed when the call cannot be interpreted for a file with locked clips", async () => {
    for (const input of [
      { path: "index.html" },
      { path: "index.html", old_string: "Hello" },
      edit("not in the file", "x"),
      edit("", "x"),
      edit("color", "x", { replace_all: "yes" }),
      { path: "index.html", edits: [{ op: "update", diff: "x" }] },
      { path: "index.html", input: "*** Begin Patch" },
      { path: "index.html", old_string: "a", new_string: "b", rename: "other.html" },
    ]) {
      expect(await guardLockedClips(projectDir, input, "edit")).toContain("cannot be checked");
    }
    expect(await guardLockedClips(projectDir, { path: "index.html" }, "write")).toContain(
      "cannot be checked",
    );
  });

  it("ignores a directory named like an HTML file: the tool itself refuses it", async () => {
    await mkdir(path.join(projectDir, "dir.html"));
    expect(
      await guardLockedClips(projectDir, edit("a", "b", { path: "dir.html" }), "edit"),
    ).toBeNull();
  });

  it("checks sub-compositions wrapped in a template", async () => {
    await mkdir(path.join(projectDir, "compositions"));
    await writeFile(
      path.join(projectDir, "compositions", "captions.html"),
      `<template id="captions-template"><div id="captions" data-composition-id="captions" data-timeline-locked><p class="c">Hi</p></div></template>`,
    );
    const input = {
      path: "compositions/captions.html",
      old_string: 'class="c"',
      new_string: 'class="d"',
    };
    expect(await guardLockedClips(projectDir, input, "edit")).toContain('"#captions"');
  });

  it("keeps CRLF files workable", async () => {
    await writeFile(path.join(projectDir, "crlf.html"), LOCKED_HTML.replaceAll("\n", "\r\n"));
    expect(
      await guardLockedClips(
        projectDir,
        { path: "crlf.html", old_string: "color: red", new_string: "color: blue" },
        "edit",
      ),
    ).toBeNull();
    expect(
      await guardLockedClips(
        projectDir,
        { path: "crlf.html", old_string: "color: white", new_string: "color: blue" },
        "edit",
      ),
    ).toContain('"#title"');
  });
});

describe("files without locked clips", () => {
  it("are never restricted, whatever the arguments", async () => {
    await writeFile(path.join(projectDir, "index.html"), UNLOCKED_HTML);
    await writeFile(path.join(projectDir, "notes.txt"), "data-timeline-locked");
    expect(
      await guardLockedClips(projectDir, edit("color: white", "color: blue"), "edit"),
    ).toBeNull();
    expect(await guardLockedClips(projectDir, edit("no match at all", "x"), "edit")).toBeNull();
    expect(await guardLockedClips(projectDir, { path: "index.html" }, "edit")).toBeNull();
    expect(
      await guardLockedClips(projectDir, { path: "index.html", content: "<div></div>" }, "write"),
    ).toBeNull();
    // new file, non-HTML file, and read-only tools
    expect(
      await guardLockedClips(projectDir, { path: "new.html", content: "<div></div>" }, "write"),
    ).toBeNull();
    expect(
      await guardLockedClips(projectDir, { path: "notes.txt", content: "x" }, "write"),
    ).toBeNull();
    await writeFile(path.join(projectDir, "locked.html"), LOCKED_HTML);
    expect(await guardLockedClips(projectDir, { path: "locked.html" }, "read")).toBeNull();
  });
});

describe("the tool_call guard bound to a session", () => {
  it("blocks a locked-clip rewrite, still blocks boundary escapes, and lets safe edits through", async () => {
    await writeFile(path.join(projectDir, "index.html"), LOCKED_HTML);
    const guard = projectToolCallGuard(projectDir);

    const blocked = await guard({
      toolName: "edit",
      input: edit("color: white", "color: hotpink"),
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("locked clip");

    expect(
      await guard({ toolName: "write", input: { path: "index.html", content: UNLOCKED_HTML } }),
    ).toMatchObject({ block: true });
    expect(
      await guard({ toolName: "edit", input: edit("color: red", "color: blue") }),
    ).toBeUndefined();
    expect(await guard({ toolName: "read", input: { path: "index.html" } })).toBeUndefined();
    expect(
      (await guard({ toolName: "write", input: { path: "../escape.html", content: "x" } }))?.reason,
    ).toContain("resolves outside this project");
  });

  it("tells the agent to stop and ask, or to leave the clip and carry on, by the user's autonomy setting", async () => {
    await writeFile(path.join(projectDir, "index.html"), LOCKED_HTML);
    const input = edit("color: white", "color: hotpink");
    const ask = projectToolCallGuard(projectDir, undefined, () => true);
    const leave = projectToolCallGuard(projectDir, undefined, () => false);

    const asked = (await ask({ toolName: "edit", input }))?.reason ?? "";
    const left = (await leave({ toolName: "edit", input }))?.reason ?? "";
    expect(asked).toContain("wait for their answer");
    expect(asked).not.toContain("do not stop to ask");
    expect(left).toContain("do not stop to ask");
    expect(left).not.toContain("wait for their answer");
    // The lock holds either way: both refuse the call.
    expect(asked).toContain('"#title"');
    expect(left).toContain('"#title"');
    // With no setting at all the agent is told to ask.
    expect((await projectToolCallGuard(projectDir)({ toolName: "edit", input }))?.reason).toContain(
      "wait for their answer",
    );
  });
});
