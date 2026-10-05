import { describe, expect, it } from "vitest";
import { isResearchFailure } from "./errors.js";
import {
  parseRecordWebsiteRequest,
  parseWebsiteFileRequest,
  parseWebsiteRequest,
} from "./requests.js";

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isResearchFailure(error)) return error.error.code;
    throw error;
  }
  return "none";
}

describe("allowedSites on the website requests", () => {
  it("is kept, lower-cased, by the read, file and record parsers", () => {
    const allowedSites = ["Linear.App", "docs.example.co.uk"];
    const expected = ["linear.app", "docs.example.co.uk"];
    expect(parseWebsiteRequest({ url: "https://linear.app", allowedSites }).allowedSites).toEqual(
      expected,
    );
    expect(
      parseWebsiteFileRequest({ url: "https://linear.app/a.css", mode: "read", allowedSites })
        .allowedSites,
    ).toEqual(expected);
    expect(
      parseRecordWebsiteRequest({ url: "https://linear.app", seconds: 4, allowedSites })
        .allowedSites,
    ).toEqual(expected);
  });

  it("is optional, and an empty list stays an (empty) scope", () => {
    expect(parseWebsiteRequest({ url: "https://linear.app" })).not.toHaveProperty("allowedSites");
    expect(
      parseWebsiteRequest({ url: "https://linear.app", allowedSites: [] }).allowedSites,
    ).toEqual([]);
  });

  it("refuses anything that is not a list of domains", () => {
    for (const allowedSites of ["linear.app", [1], ["not a domain"], ["localhost"], [""]]) {
      expect(code(() => parseWebsiteRequest({ url: "https://linear.app", allowedSites }))).toBe(
        "invalid_request",
      );
    }
    expect(
      code(() =>
        parseWebsiteRequest({
          url: "https://linear.app",
          allowedSites: Array.from({ length: 51 }, (_, i) => `site${i}.com`),
        }),
      ),
    ).toBe("invalid_request");
  });
});
