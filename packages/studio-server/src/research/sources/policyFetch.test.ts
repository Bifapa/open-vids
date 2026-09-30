// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AssetSearchMode, AssetSearchPolicy } from "@hyperframes/agent-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isResearchFailure } from "../errors.js";
import {
  FakeNet,
  html,
  json,
  media,
  redirect,
  resolver,
  httpStatus,
  type Answer,
} from "../testSupport.js";
import { PolicyFetcher } from "./policyFetch.js";
import { PolicyStore } from "./policyStore.js";
import { UrlGuard, isPrivateAddress } from "./urlPolicy.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openvids-fetch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(mode: AssetSearchMode, dns: Record<string, string> = {}) {
  const store = new PolicyStore({ dir: join(dir, "policy") });
  store.setMode(mode);
  const net = new FakeNet();
  const fetcher = new PolicyFetcher({
    transport: net.transport,
    guard: new UrlGuard(resolver(dns)),
  });
  return { net, fetcher, policy: store.get(), store };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isResearchFailure(error)) return `${error.error.code}: ${error.error.message}`;
    throw error;
  }
  throw new Error("expected a failure");
}

const page = (
  policy: AssetSearchPolicy,
  fetcher: PolicyFetcher,
  url: string,
  grants: string[] = [],
) => fetcher.getPage(url, { policy, grants });

describe("trusted mode", () => {
  it("reads only enabled trusted sources, and says which host and mode refused the rest without a request", async () => {
    const { net, fetcher, policy } = setup("trusted");
    net.when("https://commons.wikimedia.org/wiki/File:X.jpg", html("<title>ok</title>"));
    expect(
      await page(policy, fetcher, "https://commons.wikimedia.org/wiki/File:X.jpg"),
    ).toMatchObject({
      kind: "html",
    });
    // A subdomain of a trusted domain belongs to it, a look-alike does not.
    net.when("https://upload.wikimedia.org/a.jpg", media("JPEG", "image/jpeg"));
    expect(await page(policy, fetcher, "https://upload.wikimedia.org/a.jpg")).toMatchObject({
      kind: "media",
    });
    const before = net.calls.length;
    for (const url of [
      "https://evil-wikimedia.org/a",
      "https://wikimedia.org.evil.example/a",
      "https://example.com/",
    ]) {
      const message = await codeOf(page(policy, fetcher, url));
      expect(message).toContain("blocked_by_policy");
      expect(message).toContain("trusted mode");
    }
    expect(await codeOf(page(policy, fetcher, "https://example.com/"))).toContain("example.com");
    expect(net.calls.length).toBe(before);
  });

  it("does not read a source the user disabled, nor one they removed", async () => {
    const { net, fetcher, store } = setup("trusted");
    net.when(() => true, json({}));
    store.updateSource("nasa-images", { enabled: false });
    expect(
      await codeOf(fetcher.getJson("https://images-api.nasa.gov/search", { policy: store.get() })),
    ).toContain("blocked_by_policy");
    store.removeSource("openverse");
    expect(
      await codeOf(
        fetcher.getJson("https://api.openverse.org/v1/images/", { policy: store.get() }),
      ),
    ).toContain("blocked_by_policy");
    expect(net.calls).toEqual([]);
  });

  it("checks every redirect hop: a trusted host that redirects elsewhere is stopped before the second request", async () => {
    const { net, fetcher, policy } = setup("trusted");
    net.when("https://commons.wikimedia.org/go", redirect("https://upload.wikimedia.org/ok.jpg"));
    net.when("https://upload.wikimedia.org/ok.jpg", media("JPEG", "image/jpeg"));
    expect(await page(policy, fetcher, "https://commons.wikimedia.org/go")).toMatchObject({
      kind: "media",
      finalUrl: "https://upload.wikimedia.org/ok.jpg",
    });

    net.when("https://commons.wikimedia.org/bounce", redirect("https://cdn.tracker.example/x.jpg"));
    net.when("https://cdn.tracker.example/x.jpg", media("JPEG", "image/jpeg"));
    const message = await codeOf(page(policy, fetcher, "https://commons.wikimedia.org/bounce"));
    expect(message).toContain("blocked_by_policy");
    expect(message).toContain("cdn.tracker.example");
    expect(net.calls).not.toContain("https://cdn.tracker.example/x.jpg");
  });

  it("lets a candidate's grant open its exact host only, on every hop", async () => {
    const { net, fetcher, policy } = setup("trusted");
    net.when("https://live.staticflickr.com/1/a.jpg", media("JPEG", "image/jpeg"));
    net.when("https://farm.staticflickr.com/1/a.jpg", media("JPEG", "image/jpeg"));
    net.when(
      "https://live.staticflickr.com/moved.jpg",
      redirect("https://farm.staticflickr.com/1/a.jpg"),
    );
    const grants = ["live.staticflickr.com"];
    expect(
      await page(policy, fetcher, "https://live.staticflickr.com/1/a.jpg", grants),
    ).toMatchObject({
      kind: "media",
    });
    expect(
      await codeOf(page(policy, fetcher, "https://farm.staticflickr.com/1/a.jpg", grants)),
    ).toContain("blocked_by_policy");
    expect(await codeOf(page(policy, fetcher, "https://live.staticflickr.com/1/a.jpg"))).toContain(
      "blocked_by_policy",
    );
    expect(
      await codeOf(page(policy, fetcher, "https://live.staticflickr.com/moved.jpg", grants)),
    ).toContain("farm.staticflickr.com");
  });

  it("refuses non-standard ports even on a trusted host", async () => {
    const { fetcher, policy } = setup("trusted");
    expect(await codeOf(page(policy, fetcher, "https://commons.wikimedia.org:8443/x"))).toContain(
      "blocked_by_policy",
    );
  });
});

describe("any mode", () => {
  it("reads any public host", async () => {
    const { net, fetcher, policy } = setup("any");
    net.when("https://example.com/", html("<title>hi</title>"));
    expect(await page(policy, fetcher, "https://example.com/")).toMatchObject({ kind: "html" });
    net.when("https://example.com:8443/", html("<title>other port</title>"));
    expect(await page(policy, fetcher, "https://example.com:8443/")).toMatchObject({
      kind: "html",
    });
  });
});

describe("the private network (both modes)", () => {
  it.each(["trusted", "any"] as const)(
    "is never reached in %s mode: literals, local names and hosts that resolve there",
    async (mode) => {
      const { net, fetcher, policy } = setup(mode, {
        "commons.wikimedia.org": "10.0.0.5",
        "sneaky.example.com": "127.0.0.1",
        "v6.example.com": "::ffff:192.168.1.1",
      });
      net.when(() => true, html("secret"));
      for (const url of [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/",
        "http://[fd00::1]/",
        "http://2130706433/",
        "http://localhost/",
        "http://printer.local/",
        "http://intranet/",
        "https://commons.wikimedia.org/wiki/File:X.jpg",
        "https://sneaky.example.com/",
        "https://v6.example.com/",
      ]) {
        expect(await codeOf(page(policy, fetcher, url)), url).toContain("blocked_by_policy");
      }
      expect(net.calls).toEqual([]);
    },
  );

  it("stops a redirect into the private network and refuses credentials in a URL", async () => {
    const { net, fetcher, policy } = setup("any");
    net.when("https://example.com/r", redirect("http://10.1.2.3/secret"));
    net.when("http://10.1.2.3/secret", html("secret"));
    expect(await codeOf(page(policy, fetcher, "https://example.com/r"))).toContain(
      "blocked_by_policy",
    );
    expect(net.calls).toEqual(["https://example.com/r"]);
    expect(await codeOf(page(policy, fetcher, "https://user:pw@example.com/"))).toContain(
      "blocked_by_policy",
    );
  });

  it("classifies address ranges", () => {
    for (const address of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "0.0.0.0",
      "169.254.1.1",
      "224.0.0.1",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:10.0.0.1",
      "64:ff9b::7f00:1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      "93.184.216.34",
      "8.8.8.8",
      "172.32.0.1",
      "100.63.0.1",
      "2606:2800:220:1:248:1893:25c8:1946",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("what an answer may be", () => {
  it("maps 404/410 to unavailable and other failures to provider/network errors", async () => {
    const { net, fetcher, policy } = setup("any");
    net.when("https://example.com/gone", httpStatus(410));
    net.when("https://example.com/missing", httpStatus(404));
    net.when("https://example.com/down", httpStatus(503));
    expect(
      await codeOf(
        fetcher.download("https://example.com/gone", { policy }, join(dir, "x"), { maxBytes: 100 }),
      ),
    ).toContain("unavailable");
    expect(await codeOf(page(policy, fetcher, "https://example.com/missing"))).toContain(
      "unavailable",
    );
    expect(await codeOf(page(policy, fetcher, "https://example.com/down"))).toContain("network");
    expect(await codeOf(fetcher.getJson("https://example.com/down", { policy }))).toContain(
      "provider_error",
    );
    expect(await codeOf(fetcher.getJson("https://example.com/missing", { policy }))).toContain(
      "unavailable",
    );
  });

  it("downloads to a file with its sha256, and leaves nothing behind when it refuses", async () => {
    const { net, fetcher, policy } = setup("any");
    const file = join(dir, "clip.bin");
    net.when("https://example.com/clip.mp4", media("H264 bytes", "video/mp4"));
    const result = await fetcher.download("https://example.com/clip.mp4", { policy }, file, {
      maxBytes: 1000,
      expect: "video",
    });
    expect(result).toMatchObject({ contentType: "video/mp4", mediaKind: "video", bytes: 10 });
    expect(result.sha256).toBe(createHash("sha256").update("H264 bytes").digest("hex"));
    expect(readFileSync(file, "utf-8")).toBe("H264 bytes");

    const refusals: Array<[string, Answer, string]> = [
      ["https://example.com/page", html("<p>hi</p>"), "not_media"],
      ["https://example.com/doc", media("{}", "application/json"), "not_media"],
      ["https://example.com/pic.jpg", media("JPEG", "image/jpeg"), "not_media"],
      [
        "https://example.com/live.m3u8",
        media("#EXTM3U", "application/vnd.apple.mpegurl"),
        "unsupported",
      ],
      ["https://example.com/stream", media("<MPD/>", "application/dash+xml"), "unsupported"],
      ["https://example.com/big.mp4", media("x".repeat(2000), "video/mp4"), "too_large"],
      ["https://example.com/empty.mp4", media("", "video/mp4"), "not_media"],
    ];
    for (const [url, response, code] of refusals) {
      net.when(url, response);
      const out = join(dir, "refused.bin");
      expect(
        await codeOf(fetcher.download(url, { policy }, out, { maxBytes: 1000, expect: "video" })),
        url,
      ).toContain(code);
      expect(existsSync(out), url).toBe(false);
    }
    const stream = await codeOf(
      fetcher.download("https://example.com/live.m3u8", { policy }, join(dir, "s"), {
        maxBytes: 10,
      }),
    );
    expect(stream).toContain("not downloaded");
  });

  it("recognizes a media file from a page read without downloading it, and truncates huge pages", async () => {
    const { net, fetcher, policy } = setup("any");
    net.when("https://example.com/v", media("H264", "application/octet-stream"));
    expect(await page(policy, fetcher, "https://example.com/v")).toMatchObject({ kind: "other" });
    net.when("https://example.com/v.mp4", media("H264", "application/octet-stream"));
    expect(await page(policy, fetcher, "https://example.com/v.mp4")).toMatchObject({
      kind: "media",
      mediaKind: "video",
    });
    net.when("https://example.com/big", html(`<title>${"x".repeat(4 * 1024 * 1024)}</title>`));
    const big = await page(policy, fetcher, "https://example.com/big");
    expect(big.kind).toBe("html");
    if (big.kind === "html") expect(big.html.length).toBe(3 * 1024 * 1024);
    net.when("https://example.com/manifest.m3u8", media("#EXTM3U", "text/plain"));
    expect(await codeOf(page(policy, fetcher, "https://example.com/manifest.m3u8"))).toContain(
      "unsupported",
    );
  });

  it("gives up after five redirects", async () => {
    const { net, fetcher, policy } = setup("any");
    for (let hop = 0; hop < 8; hop += 1) {
      net.when(`https://example.com/${hop}`, redirect(`https://example.com/${hop + 1}`));
    }
    expect(await codeOf(page(policy, fetcher, "https://example.com/0"))).toContain(
      "Too many redirects",
    );
  });
});
