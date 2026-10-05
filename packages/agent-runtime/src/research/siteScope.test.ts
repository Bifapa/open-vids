import { describe, expect, it } from "vitest";
import { sampleWebsiteStyle } from "../testing/research.js";
import { SiteScope } from "./siteScope.js";
import { WebsiteResourceLog } from "./websiteResources.js";

const FONT = "https://linear.app/fonts/brand.woff2";
const CDN_FILE = "https://cdn.example-cdn.com/lottie/loader.json";

async function scopeOf(excluded: string[]) {
  const resources = new WebsiteResourceLog();
  await resources.rememberRead("chat-1", {
    site: sampleWebsiteStyle("https://linear.app/"),
    screenshots: [],
  });
  const scope = new SiteScope({
    userTexts: () => ["make it look like https://linear.app/"],
    turnUserTexts: () => [],
    excludedSites: () => excluded,
    websites: { chatId: "chat-1", resources },
    permissions: null,
  });
  return scope;
}

describe("a site the user removed from the linked list", () => {
  it("is fetched through its page or through a file an earlier read listed while it is linked", async () => {
    const scope = await scopeOf([]);
    expect(await scope.fileScope("https://linear.app/pricing")).toBeNull();
    expect(await scope.fileScope(FONT)).toBeNull();
    expect(await scope.fileScope(CDN_FILE)).toBeNull();
    expect(scope.allowedSitesFor(FONT, "website_full_access", true)).toEqual(["linear.app"]);
  });

  it("is refused on the resource-log path too, and no longer named as an allowed site", async () => {
    const scope = await scopeOf(["linear.app"]);
    expect(scope.linked()).toEqual([]);
    for (const url of [
      "https://linear.app/pricing",
      FONT,
      "https://app.linear.app/fonts/brand.woff2",
    ]) {
      const refusal = await scope.fileScope(url);
      expect(refusal?.isError, url).toBe(true);
      expect(refusal?.text, url).toContain("removed from the linked sites");
    }
    expect(scope.allowedSitesFor(FONT, "website_full_access", true)).toEqual([]);
    // A host the user did not remove keeps working: only the removed site is cut off.
    expect(await scope.fileScope(CDN_FILE)).toBeNull();
    expect(scope.allowedSitesFor(CDN_FILE, "website_full_access", true)).toEqual([
      "example-cdn.com",
    ]);
  });
});
