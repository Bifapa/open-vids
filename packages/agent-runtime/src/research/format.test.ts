import { describe, expect, it } from "vitest";
import { WEB_SOURCE_ID } from "@hyperframes/agent-protocol";
import { sampleCandidate, sampleSearchResult } from "../testing/research.js";
import { formatSearch } from "./format.js";

const request = { query: "ocean waves", mediaKind: "video" } as const;

describe("formatSearch", () => {
  it("says the web backend is down, and what that means for the result, when it failed", () => {
    const result = sampleSearchResult(request, [sampleCandidate("c1")]);
    result.mode = "any";
    result.searched.push({
      source: { id: WEB_SOURCE_ID, name: "Web", trusted: false },
      results: 0,
      error: "search backend returned 503",
    });
    const text = formatSearch(result);
    expect(text).toContain("- Web: FAILED — search backend returned 503");
    expect(text).toContain(
      "The web search backend is temporarily unavailable (search backend returned 503)",
    );
    expect(text).toContain("trusted sources only");
    expect(text).toContain("the open web could not be searched");
  });

  it("does not claim the web is down when another source failed or the web answered", () => {
    const failed = sampleSearchResult(request, []);
    failed.searched.push({
      source: { id: "nasa-images", name: "NASA Images", trusted: true },
      results: 0,
      error: "timeout",
    });
    expect(formatSearch(failed)).toContain("- NASA Images: FAILED — timeout");
    expect(formatSearch(failed)).not.toContain("temporarily unavailable");

    const answered = sampleSearchResult(request, [sampleCandidate("c1")]);
    answered.searched.push({
      source: { id: WEB_SOURCE_ID, name: "Web", trusted: false },
      results: 3,
      error: null,
    });
    expect(formatSearch(answered)).not.toContain("temporarily unavailable");
  });
});
