import { describe, expect, it } from "vitest";
import {
  boundedSites,
  isLinkedSite,
  linkedSites,
  linksIn,
  registrableDomain,
} from "./linkedSites.js";

describe("registrableDomain", () => {
  it("is the site a host belongs to", () => {
    expect(registrableDomain("linear.app")).toBe("linear.app");
    expect(registrableDomain("www.linear.app")).toBe("linear.app");
    expect(registrableDomain("docs.eu.linear.app")).toBe("linear.app");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("someone.github.io")).toBe("someone.github.io");
  });

  it("keeps a second-level ccTLD, a regional suffix and a hosting platform out of the site", () => {
    expect(registrableDomain("shop.com.ua")).toBe("shop.com.ua");
    expect(registrableDomain("www.shop.com.ua")).toBe("shop.com.ua");
    expect(registrableDomain("firm.msk.ru")).toBe("firm.msk.ru");
    expect(registrableDomain("brand.co.il")).toBe("brand.co.il");
    expect(registrableDomain("x.com.sg")).toBe("x.com.sg");
    expect(registrableDomain("mybucket.s3.amazonaws.com")).toBe("mybucket.s3.amazonaws.com");
    expect(registrableDomain("app.azurewebsites.net")).toBe("app.azurewebsites.net");
    expect(registrableDomain("a.b.site.webflow.io")).toBe("site.webflow.io");
    expect(registrableDomain("brand.framer.website")).toBe("brand.framer.website");
    expect(registrableDomain("page.notion.site")).toBe("page.notion.site");
    expect(registrableDomain("name.tilda.ws")).toBe("name.tilda.ws");
    expect(registrableDomain("blog.name.wordpress.com")).toBe("name.wordpress.com");
    expect(registrableDomain("x.workers.dev")).toBe("x.workers.dev");
  });

  it("has none for a bare shared suffix, an IP address or a local name", () => {
    for (const host of [
      "co.uk",
      "com.ua",
      "msk.ru",
      "webflow.io",
      "tilda.ws",
      "github.io",
      "127.0.0.1",
      "[::1]",
      "localhost",
      "app.local",
      "intranet",
    ]) {
      expect(registrableDomain(host)).toBeNull();
    }
  });
});

describe("linkedSites", () => {
  it("collects the sites of http(s) links in user text, www. words included", () => {
    expect(
      linkedSites([
        "вот ссылка https://linear.app — сделай моушн",
        "ещё (https://www.stripe.com/payments), и www.apple.com/mac.",
      ]),
    ).toEqual(["linear.app", "stripe.com", "apple.com"]);
  });

  it("ignores other schemes, trailing punctuation and plain words", () => {
    expect(linksIn("see https://example.org/a?b=1. Then ftp://x.test/f and file.html")).toEqual([
      "https://example.org/a?b=1",
    ]);
    expect(linkedSites(["mailto:a@b.com", "index.html", "no links here"])).toEqual([]);
  });

  it("counts a site named by its bare domain, but not a file name", () => {
    expect(
      linkedSites([
        "сделай ресерч сайта openvids.ai и сделай промушн в их стиле, трек Chrome Bounce.wav",
        "посмотри linear.app/pricing, а index.html, README.md и assets/music.mp3 не трогай",
      ]),
    ).toEqual(["openvids.ai", "linear.app"]);
    expect(isLinkedSite("https://www.openvids.ai/", linkedSites(["сайт openvids.ai."]))).toBe(true);
    expect(linkedSites(["mail me at team@openvids.ai"])).toEqual([]);
  });

  it("never counts an IP address or localhost as a linked site", () => {
    expect(linkedSites(["http://127.0.0.1:8080/x http://localhost:3000 http://10.0.0.5/"])).toEqual(
      [],
    );
  });
});

describe("a linked site of a shared suffix", () => {
  it("does not open the other tenants of the ccTLD or platform", () => {
    const shop = linkedSites(["https://www.shop.com.ua/catalog"]);
    expect(shop).toEqual(["shop.com.ua"]);
    expect(isLinkedSite("https://docs.shop.com.ua/", shop)).toBe(true);
    expect(isLinkedSite("https://attacker.com.ua/", shop)).toBe(false);

    const bucket = linkedSites(["https://mybucket.s3.amazonaws.com/index.html"]);
    expect(isLinkedSite("https://other.s3.amazonaws.com/", bucket)).toBe(false);
    expect(isLinkedSite("https://mybucket.s3.amazonaws.com/a.png", bucket)).toBe(true);

    const tilda = linkedSites(["https://name.tilda.ws"]);
    expect(isLinkedSite("https://victim.tilda.ws/", tilda)).toBe(false);
  });
});

describe("boundedSites", () => {
  it("keeps the list under the cap and adds the required site", () => {
    expect(boundedSites(["a.com", "b.com"], null, 3)).toEqual(["a.com", "b.com"]);
    expect(boundedSites(["a.com", "b.com"], "b.com", 3)).toEqual(["a.com", "b.com"]);
    expect(boundedSites(["a.com", "b.com"], "c.com", 3)).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("cuts over the cap but never drops the required site", () => {
    expect(boundedSites(["a.com", "b.com", "c.com", "d.com"], null, 2)).toEqual(["a.com", "b.com"]);
    expect(boundedSites(["a.com", "b.com", "c.com", "d.com"], "d.com", 2)).toEqual([
      "d.com",
      "a.com",
    ]);
    expect(boundedSites(["a.com", "b.com"], "z.com", 2)).toEqual(["z.com", "a.com"]);
  });
});

describe("isLinkedSite", () => {
  const sites = linkedSites(["https://www.linear.app/features"]);

  it("allows the site, www. and subdomains", () => {
    for (const url of [
      "https://linear.app",
      "https://www.linear.app/pricing",
      "http://docs.linear.app/x",
      "https://a.b.linear.app/",
    ]) {
      expect(isLinkedSite(url, sites)).toBe(true);
    }
  });

  it("refuses another site, a look-alike and non-http URLs", () => {
    for (const url of [
      "https://example.com",
      "https://notlinear.app",
      "https://linear.app.evil.com",
      "https://evil.com/?u=linear.app",
      "ftp://linear.app/file",
      "not a url",
      "http://127.0.0.1/",
    ]) {
      expect(isLinkedSite(url, sites)).toBe(false);
    }
    expect(isLinkedSite("https://linear.app", [])).toBe(false);
  });
});
