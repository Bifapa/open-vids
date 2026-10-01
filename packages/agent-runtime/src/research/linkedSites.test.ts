import { describe, expect, it } from "vitest";
import { isLinkedSite, linkedSites, linksIn, registrableDomain } from "./linkedSites.js";

describe("registrableDomain", () => {
  it("is the site a host belongs to", () => {
    expect(registrableDomain("linear.app")).toBe("linear.app");
    expect(registrableDomain("www.linear.app")).toBe("linear.app");
    expect(registrableDomain("docs.eu.linear.app")).toBe("linear.app");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("someone.github.io")).toBe("someone.github.io");
  });

  it("has none for a bare shared suffix, an IP address or a local name", () => {
    for (const host of [
      "co.uk",
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

  it("never counts an IP address or localhost as a linked site", () => {
    expect(linkedSites(["http://127.0.0.1:8080/x http://localhost:3000 http://10.0.0.5/"])).toEqual(
      [],
    );
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
