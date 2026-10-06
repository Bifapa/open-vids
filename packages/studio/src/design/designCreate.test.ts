import { describe, expect, it } from "vitest";
import {
  availableSources,
  createSpecOf,
  effectiveFields,
  websiteAddress,
  type CreateFields,
  type DesignHostCapabilities,
} from "./designCreate";

const NONE: DesignHostCapabilities = { externalProjects: null };
const LISTED: DesignHostCapabilities = {
  externalProjects: [{ key: "k-1", name: "Summer trip" }],
};
const EMPTY: CreateFields = { brief: "", notes: "", video: "", url: "", projectKey: "" };

describe("availableSources", () => {
  it("offers another project only when the host lists projects", () => {
    expect(availableSources(NONE)).toEqual(["scratch", "project", "video", "website"]);
    expect(availableSources(LISTED)).toEqual([
      "scratch",
      "project",
      "video",
      "website",
      "external_project",
    ]);
    // A host that lists no projects at all still reports the capability: the choice exists, the list is empty.
    expect(availableSources({ externalProjects: [] })).toContain("external_project");
  });
});

describe("websiteAddress", () => {
  it("accepts http(s) sites and adds https to a bare host", () => {
    expect(websiteAddress("https://example.com/brand")).toBe("https://example.com/brand");
    expect(websiteAddress("  http://example.com ")).toBe("http://example.com");
    expect(websiteAddress("example.com")).toBe("https://example.com");
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "   ",
      "not an address",
      "ftp://example.com",
      "javascript:alert(1)",
      "localhost",
    ]) {
      expect(websiteAddress(bad)).toBeNull();
    }
  });
});

describe("effectiveFields", () => {
  const LISTED_TWO: DesignHostCapabilities = {
    externalProjects: [
      { key: "k-1", name: "Summer trip" },
      { key: "k-2", name: "Winter trip" },
    ],
  };

  it("takes the first video and project on offer until the user picks one", () => {
    expect(effectiveFields(EMPTY, ["a.mp4", "b.mp4"], LISTED_TWO)).toMatchObject({
      video: "a.mp4",
      projectKey: "k-1",
    });
    expect(effectiveFields(EMPTY, [], NONE)).toMatchObject({ video: "", projectKey: "" });
  });

  it("keeps a pick that is still on offer and drops one that is not", () => {
    const picked = { ...EMPTY, video: "b.mp4", projectKey: "k-2" };
    expect(effectiveFields(picked, ["a.mp4", "b.mp4"], LISTED_TWO)).toMatchObject({
      video: "b.mp4",
      projectKey: "k-2",
    });
    expect(effectiveFields(picked, ["c.mp4"], LISTED)).toMatchObject({
      video: "c.mp4",
      projectKey: "k-1",
    });
  });

  it("leaves the other fields alone", () => {
    const typed = { ...EMPTY, brief: "Calm", notes: "Warm", url: "example.com" };
    expect(effectiveFields(typed, [], NONE)).toEqual(typed);
  });
});

describe("createSpecOf", () => {
  it("needs a brief for a brief, and nothing for this project", () => {
    expect(createSpecOf("scratch", EMPTY, NONE)).toBeNull();
    expect(createSpecOf("scratch", { ...EMPTY, brief: "  " }, NONE)).toBeNull();
    expect(createSpecOf("scratch", { ...EMPTY, brief: "Calm" }, NONE)).toEqual({
      action: "create",
      source: "scratch",
      brief: "Calm",
    });
    expect(createSpecOf("project", EMPTY, NONE)).toEqual({
      action: "create",
      source: "project",
      notes: undefined,
    });
  });

  it("needs a chosen video, a valid address, or a project the host listed", () => {
    expect(createSpecOf("video", EMPTY, NONE)).toBeNull();
    expect(createSpecOf("video", { ...EMPTY, video: "a.mp4", notes: " warm " }, NONE)).toEqual({
      action: "create",
      source: "video",
      video: "a.mp4",
      notes: "warm",
    });
    expect(createSpecOf("website", { ...EMPTY, url: "nope" }, NONE)).toBeNull();
    expect(createSpecOf("website", { ...EMPTY, url: "example.com" }, NONE)).toMatchObject({
      source: "website",
      url: "https://example.com",
    });
    expect(createSpecOf("external_project", { ...EMPTY, projectKey: "k-1" }, NONE)).toBeNull();
    expect(createSpecOf("external_project", { ...EMPTY, projectKey: "other" }, LISTED)).toBeNull();
    expect(createSpecOf("external_project", { ...EMPTY, projectKey: "k-1" }, LISTED)).toMatchObject(
      {
        source: "external_project",
        projectKey: "k-1",
        projectName: "Summer trip",
      },
    );
  });
});
