import { describe, expect, it } from "vitest";
import type {
  ExternalProjectEntry,
  ProjectPart,
  ProjectPartsSummary,
} from "@hyperframes/agent-protocol";
import {
  chosenParts,
  isPartChecked,
  matchMentionProjects,
  projectPartRows,
  projectSlug,
  projectSlugs,
  toggleProjectPart,
} from "./projectMentions";

describe("projectSlug", () => {
  it("lower-cases and turns every run of non-alphanumerics into one dash", () => {
    expect(projectSlug("My Promo")).toBe("my-promo");
    expect(projectSlug("  Spring  Sale!! (final)  ")).toBe("spring-sale-final");
    expect(projectSlug("a_b.c/d")).toBe("a-b-c-d");
  });

  it("keeps letters of every script and digits", () => {
    expect(projectSlug("Мой проект")).toBe("мой-проект");
    expect(projectSlug("Café 2024")).toBe("café-2024");
    expect(projectSlug("東京 vlog")).toBe("東京-vlog");
  });

  it("falls back to a word for a name with no letters at all", () => {
    expect(projectSlug("🎬🎬")).toBe("project");
    expect(projectSlug("---")).toBe("project");
  });
});

const project = (key: string, name: string, openedAt?: number): ExternalProjectEntry => ({
  key,
  name,
  ...(openedAt !== undefined && { openedAt }),
});

describe("projectSlugs", () => {
  it("gives colliding names a numbered suffix, in key order, and keeps unique ones plain", () => {
    const slugs = projectSlugs([
      project("c", "Promo"),
      project("a", "Promo"),
      project("b", "promo!"),
      project("d", "Other"),
    ]);
    expect(slugs.get("a")).toBe("promo");
    expect(slugs.get("b")).toBe("promo-2");
    expect(slugs.get("c")).toBe("promo-3");
    expect(slugs.get("d")).toBe("other");
  });

  it("stays unique when a suffixed slug is also a real name", () => {
    const slugs = projectSlugs([
      project("a", "Promo"),
      project("b", "Promo"),
      project("c", "Promo 2"),
    ]);
    expect(new Set(slugs.values()).size).toBe(3);
    expect(slugs.get("a")).toBe("promo");
    expect(slugs.get("b")).toBe("promo-2");
    expect(slugs.get("c")).toBe("promo-2-2");
  });

  it("does not depend on the order of the list", () => {
    const list = [project("a", "Promo"), project("b", "Promo"), project("c", "Promo")];
    expect([...projectSlugs(list)]).toEqual([...projectSlugs([...list].reverse())]);
  });
});

describe("matchMentionProjects", () => {
  const projects = [
    project("old", "Old Promo", 100),
    project("new", "Brand promo", 900),
    project("mid", "Promo reel", 500),
    project("none", "Interview", undefined),
    project("spaced", "My Showreel", 300),
  ];
  const slugs = projectSlugs(projects);
  const names = (query: string) =>
    matchMentionProjects(projects, slugs, query).map((match) => match.name);

  it("lists every project, most recently opened first, for an empty query", () => {
    expect(names("")).toEqual([
      "Brand promo",
      "Promo reel",
      "My Showreel",
      "Old Promo",
      "Interview",
    ]);
  });

  it("ranks a name prefix before a contains, each by recency, ignoring case", () => {
    expect(names("PROMO")).toEqual(["Promo reel", "Brand promo", "Old Promo"]);
  });

  it("matches the slug as well as the name, so a typed #my-show finds a name with a space", () => {
    expect(names("my-show")).toEqual(["My Showreel"]);
    expect(names("my-showreel")).toEqual(["My Showreel"]);
  });

  it("matches nothing for a colour or a number, so no popup opens", () => {
    for (const query of ["ff0000", "fff", "1", "12", "zzz"]) {
      expect(names(query), query).toEqual([]);
    }
  });

  it("honours the limit", () => {
    expect(matchMentionProjects(projects, slugs, "", 2)).toHaveLength(2);
  });
});

function summary(counts: Partial<ProjectPartsSummary["counts"]>): ProjectPartsSummary {
  return {
    key: "k",
    name: "Promo",
    counts: { renders: 0, music: 0, audio: 0, images: 0, video: 0, story: 0, ...counts },
  };
}

describe("projectPartRows", () => {
  it("lists All first, then every part with its count; a part with nothing is disabled", () => {
    const rows = projectPartRows(summary({ renders: 3, music: 2, story: 5 }));
    expect(rows.map((row) => [row.part, row.count, row.disabled])).toEqual([
      ["all", null, false],
      ["renders", 3, false],
      ["music", 2, false],
      ["audio", 0, true],
      ["images", 0, true],
      ["video", 0, true],
      ["story", 5, false],
    ]);
  });

  it("disables All too when the project has nothing to attach", () => {
    expect(projectPartRows(summary({})).every((row) => row.disabled)).toBe(true);
  });
});

describe("the parts checklist", () => {
  const rows = projectPartRows(summary({ renders: 3, music: 2, story: 5 }));
  const allRow = rows.find((row) => row.part === "all");
  const tick = (selected: ReadonlySet<ProjectPart>, part: ProjectPart) =>
    toggleProjectPart(selected, part, rows);

  it("ticks and unticks one part", () => {
    const one = tick(new Set(), "renders");
    expect([...one]).toEqual(["renders"]);
    expect(chosenParts(one)).toEqual(["renders"]);
    expect(tick(one, "renders").size).toBe(0);
  });

  it("refuses a part with nothing in it", () => {
    expect(tick(new Set(), "images").size).toBe(0);
  });

  it("returns the chosen parts in the checklist's order, whatever order they were ticked in", () => {
    const selected = tick(tick(tick(new Set(), "story"), "music"), "renders");
    expect(chosenParts(selected)).toEqual(["renders", "music", "story"]);
  });

  it("All ticks everything at once and clears it again", () => {
    const all = tick(new Set<ProjectPart>(["renders"]), "all");
    expect(chosenParts(all)).toEqual(["all"]);
    expect(rows.filter((row) => isPartChecked(all, row)).map((row) => row.part)).toEqual([
      "all",
      "renders",
      "music",
      "story",
    ]);
    expect(tick(all, "all").size).toBe(0);
  });

  it("unticking one part while All is ticked leaves the other parts ticked", () => {
    const withoutMusic = tick(tick(new Set(), "all"), "music");
    expect(chosenParts(withoutMusic)).toEqual(["renders", "story"]);
    expect(allRow && isPartChecked(withoutMusic, allRow)).toBe(false);
  });

  it("nothing ticked chooses nothing, so the dialog cannot confirm", () => {
    expect(chosenParts(new Set())).toEqual([]);
  });
});
