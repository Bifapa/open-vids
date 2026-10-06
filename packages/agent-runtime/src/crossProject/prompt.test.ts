import { PROJECT_MANIFEST_LIMITS, type ProjectManifest } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { ResearchToolError } from "../research/host.js";
import { manifestFile } from "../testing/crossProject.js";
import type { AttachedProject } from "./access.js";
import { renderAttachedProjects, renderAttachedProjectsBlock } from "./prompt.js";

const reel: AttachedProject = {
  key: "aaaaaaaaaaaaaaaa",
  name: "Summer reel",
  parts: ["renders", "music"],
};

function manifestOf(
  project: AttachedProject,
  overrides: Partial<ProjectManifest> = {},
): ProjectManifest {
  return {
    key: project.key,
    name: project.name,
    parts: project.parts,
    files: [
      manifestFile("renders/final.mp4", "renders", { bytes: 12_400_000 }),
      manifestFile("assets/theme.mp3", "music", { bytes: 3_100_000, license: "CC BY 4.0" }),
    ],
    truncated: false,
    story: null,
    ...overrides,
  };
}

const render = (
  projects: AttachedProject[],
  manifests: (project: AttachedProject) => Promise<ProjectManifest>,
  options: { offered?: boolean } = {},
) =>
  renderAttachedProjects({
    projects,
    holders: ["director", "editor"],
    offered: options.offered ?? true,
    manifestOf: manifests,
    signal: new AbortController().signal,
  });

describe("the <attached-projects> block", () => {
  it("names each project with its key and parts, lists its files with size and known license, and states the rules and tools", async () => {
    const block = await render([reel], async (project) => manifestOf(project));
    expect(block.startsWith("<attached-projects>")).toBe(true);
    expect(block.endsWith("</attached-projects>")).toBe(true);
    expect(block).toContain(
      'Project "Summer reel" (key aaaaaaaaaaaaaaaa) — attached: renders, music',
    );
    expect(block).toContain("- renders/final.mp4 · renders · 12.4 MB");
    expect(block).toContain("- assets/theme.mp3 · music · 3.1 MB · license CC BY 4.0");
    expect(block).toContain("An attachment is a link, not a copy");
    expect(block).toContain("import_from_project");
    expect(block).toContain("Copy only what you will actually use");
    expect(block).toContain("never use a file you did not import");
    expect(block).toContain("Tools: import_from_project is yours; Editor can use it too");
    // The block lists no project the chat did not attach.
    expect(block.match(/^Project "/gm)).toHaveLength(1);
  });

  it("shows only files of the attached parts, even if Studio sends more", async () => {
    const block = await render([reel], async (project) =>
      manifestOf(project, {
        files: [
          manifestFile("renders/final.mp4", "renders"),
          manifestFile("assets/voice.wav", "audio"),
          manifestFile("assets/logo.png", "images"),
        ],
      }),
    );
    expect(block).toContain("renders/final.mp4");
    expect(block).not.toContain("voice.wav");
    expect(block).not.toContain("logo.png");
  });

  it("says when the list is cut: by the prompt's budget and by Studio's own limit", async () => {
    const many = Array.from({ length: 150 }, (_, index) =>
      manifestFile(`renders/clip-${index}.mp4`, "renders"),
    );
    const block = await render([{ ...reel, parts: ["renders"] }], async (project) =>
      manifestOf(project, { files: many, truncated: true }),
    );
    expect(block).toContain("Files (120 of 150):");
    expect(block).toContain("30 more files are listed by Studio but not shown here");
    expect(block).toContain(`cut at ${PROJECT_MANIFEST_LIMITS.files} files`);
    expect(block).toContain("clip-119.mp4");
    expect(block).not.toContain("clip-120.mp4");
  });

  it("carries the story synopsis only with the story part", async () => {
    const story = "1. Opening on the beach\n2. The party";
    const without = await render([reel], async (project) => manifestOf(project, { story }));
    expect(without).not.toContain("Opening on the beach");
    expect(without).not.toContain("Story outline");

    const withStory = await render([{ ...reel, parts: ["music", "story"] }], async (project) =>
      manifestOf(project, { story }),
    );
    expect(withStory).toContain("Story outline");
    expect(withStory).toContain("1. Opening on the beach");
    // The renders the user did not tick are not listed.
    expect(withStory).not.toContain("renders/final.mp4");

    const empty = await render([{ ...reel, parts: ["story"] }], async (project) =>
      manifestOf(project, { story: null }),
    );
    expect(empty).toContain("Story: this project has no story.");
    expect(empty).not.toContain("Files");
  });

  it("says Studio could not list a project instead of failing, and still lists the others", async () => {
    const promo: AttachedProject = { key: "bbbbbbbbbbbbbbbb", name: "Promo", parts: ["images"] };
    const block = await render([reel, promo], async (project) => {
      if (project.key === reel.key)
        throw new ResearchToolError("studio_unavailable", "Studio is down.");
      return manifestOf(project, { files: [manifestFile("assets/logo.png", "images")] });
    });
    expect(block).toContain("Studio could not list this project now (Studio is down.)");
    expect(block).toContain("- assets/logo.png · images");
  });

  it("lists a bounded number of projects and names the rest", async () => {
    const projects = Array.from(
      { length: 8 },
      (_, index): AttachedProject => ({
        key: `${index}`.repeat(16),
        name: `Project ${index}`,
        parts: ["music"],
      }),
    );
    const asked: string[] = [];
    const block = await render(projects, async (project) => {
      asked.push(project.key);
      return manifestOf(project, { files: [] });
    });
    expect(asked).toHaveLength(6);
    expect(block).toContain(
      '2 more attached projects are not listed here ("Project 6" key 6666666666666666; "Project 7" key 7777777777777777)',
    );
  });

  it("with only stories attached says there is nothing to copy and offers no import rules", async () => {
    const stories: AttachedProject[] = [{ ...reel, parts: ["story"] }];
    const block = await render(stories, async (project) =>
      manifestOf(project, { story: "1. Opening" }),
    );
    expect(block).toContain("there are no files to copy");
    expect(block).toContain("1. Opening");
    expect(block).not.toContain("Tools:");
    expect(block).not.toContain("Copy only what you will actually use");
    const down = await render(stories, async () => {
      throw new ResearchToolError("studio_unavailable", "Studio is down.");
    });
    expect(down).toContain("Studio could not read this project's story now (Studio is down.)");
  });

  it("tells a turn that began with nothing attached that the tool comes next turn", () => {
    const block = renderAttachedProjectsBlock(
      [{ project: reel, manifest: manifestOf(reel), problem: null }],
      ["director"],
      false,
    );
    expect(block).toContain("import_from_project is NOT in your tool list this turn");
    expect(block).toContain("renders/final.mp4");
  });
});
