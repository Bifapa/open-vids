// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import dns from "node:dns";
import { createServer, type Server } from "node:http";
import type { AssetSearchMode, AssetSearchPolicy } from "@hyperframes/agent-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { PolicyFetcher, globalTransport, type Transport } from "./policyFetch.js";
import { pinnedTransport } from "./pinnedTransport.js";
import { PolicyStore } from "./policyStore.js";
import { isPrivateAddress } from "./address.js";
import { UrlGuard } from "./urlPolicy.js";

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

describe("address pinning (DNS rebinding)", () => {
  /** A resolver that answers public the first time a host is asked and loopback ever after. */
  function rebinding() {
    const asked: string[] = [];
    const dns = async (host: string): Promise<string[]> => {
      asked.push(host);
      return [asked.filter((entry) => entry === host).length === 1 ? "93.184.216.34" : "127.0.0.1"];
    };
    return { asked, dns };
  }

  function recording(answer: (url: string) => Response): {
    calls: Array<{ url: string; addresses: readonly string[] }>;
  } & {
    transport: Transport;
  } {
    const calls: Array<{ url: string; addresses: readonly string[] }> = [];
    const transport: Transport = async (url, init) => {
      calls.push({ url, addresses: init.addresses });
      return answer(url);
    };
    return { calls, transport };
  }

  it("hands the transport the addresses it vetted, so a later private answer is never connected to", async () => {
    const store = new PolicyStore({ dir: join(dir, "policy") });
    store.setMode("any");
    const { asked, dns } = rebinding();
    const net = recording(
      () => new Response("<title>ok</title>", { headers: { "content-type": "text/html" } }),
    );
    const fetcher = new PolicyFetcher({ transport: net.transport, guard: new UrlGuard(dns) });
    await fetcher.getPage("https://rebind.example/a", { policy: store.get() });
    // One lookup, made by the guard; the connection uses its (public) answer, not a second lookup.
    expect(asked).toEqual(["rebind.example"]);
    expect(net.calls).toEqual([{ url: "https://rebind.example/a", addresses: ["93.184.216.34"] }]);
    // The host now answers loopback: the next request is refused before any connection.
    const message = await codeOf(
      fetcher.getPage("https://rebind.example/b", { policy: store.get() }),
    );
    expect(message).toContain("blocked_by_policy");
    expect(net.calls).toHaveLength(1);
  });

  it("pins every redirect hop to that hop's own vetted addresses, and stops a hop that resolves private", async () => {
    const store = new PolicyStore({ dir: join(dir, "policy") });
    store.setMode("any");
    const dns = async (host: string) => [host === "inner.example" ? "10.1.2.3" : "93.184.216.34"];
    const net = recording((url) =>
      url.startsWith("https://start.example")
        ? new Response(null, { status: 302, headers: { location: "https://inner.example/x" } })
        : new Response("never reached"),
    );
    const fetcher = new PolicyFetcher({ transport: net.transport, guard: new UrlGuard(dns) });
    const message = await codeOf(
      fetcher.getPage("https://start.example/go", { policy: store.get() }),
    );
    expect(message).toContain("blocked_by_policy");
    expect(message).toContain("inner.example");
    expect(net.calls).toEqual([{ url: "https://start.example/go", addresses: ["93.184.216.34"] }]);
  });

  it("pins a public IP literal to itself", async () => {
    const store = new PolicyStore({ dir: join(dir, "policy") });
    store.setMode("any");
    const net = recording(
      () => new Response("<title>ok</title>", { headers: { "content-type": "text/html" } }),
    );
    const fetcher = new PolicyFetcher({
      transport: net.transport,
      guard: new UrlGuard(resolver()),
    });
    await fetcher.getPage("http://93.184.216.34/x", { policy: store.get() });
    expect(net.calls).toEqual([{ url: "http://93.184.216.34/x", addresses: ["93.184.216.34"] }]);
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

describe("a rate-limited host", () => {
  function limited() {
    const store = new PolicyStore({ dir: join(dir, "policy") });
    store.setMode("any");
    const net = new FakeNet();
    const waits: number[] = [];
    const fetcher = new PolicyFetcher({
      transport: net.transport,
      guard: new UrlGuard(resolver()),
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    return { net, fetcher, policy: store.get(), waits };
  }
  const tooMany =
    (headers: Record<string, string> = {}): Answer =>
    () =>
      new Response("", { status: 429, headers });

  const jsonBody = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  it("waits with growing, jittered pauses and succeeds when the host recovers", async () => {
    const { net, fetcher, policy, waits } = limited();
    let answers = 0;
    net.when("https://example.com/data", () => {
      answers += 1;
      return answers < 3 ? new Response("", { status: 429 }) : jsonBody({ ok: true });
    });
    expect(await fetcher.getJson("https://example.com/data", { policy })).toEqual({ ok: true });
    expect(net.calls).toHaveLength(3);
    // 1 s then 2 s, each stretched by the jitter (0.5 * 50 %).
    expect(waits).toEqual([1250, 2500]);
  });

  it("follows Retry-After (seconds or a date) instead of guessing", async () => {
    const { net, fetcher, policy, waits } = limited();
    let answers = 0;
    net.when("https://example.com/a", () => {
      answers += 1;
      return answers === 1
        ? new Response("", { status: 429, headers: { "retry-after": "4" } })
        : jsonBody([]);
    });
    await fetcher.getJson("https://example.com/a", { policy });
    let dated = 0;
    net.when("https://example.com/b", () => {
      dated += 1;
      return dated === 1
        ? new Response("", {
            status: 429,
            headers: { "retry-after": "Thu, 01 Jan 2026 00:00:07 GMT" },
          })
        : jsonBody([]);
    });
    await fetcher.getJson("https://example.com/b", { policy });
    expect(waits).toEqual([4000, 7000]);
  });

  it("fails rate_limited after the retries, naming the host and the wait it asked for", async () => {
    const { net, fetcher, policy, waits } = limited();
    net.when("https://example.com/data", tooMany({ "retry-after": "9" }));
    const failure = await codeOf(fetcher.getJson("https://example.com/data", { policy }));
    expect(failure).toContain("rate_limited: example.com answered 429");
    expect(failure).toContain("wait 9 s");
    // First attempt plus two retries.
    expect(net.calls).toHaveLength(3);
    expect(waits).toEqual([9000, 9000]);
  });

  it("does not wait for a host that asks for longer than the cap", async () => {
    const { net, fetcher, policy, waits } = limited();
    net.when("https://example.com/data", tooMany({ "retry-after": "600" }));
    expect(await codeOf(fetcher.getJson("https://example.com/data", { policy }))).toContain(
      "rate_limited",
    );
    expect(net.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("also limits downloads", async () => {
    const { net, fetcher, policy } = limited();
    net.when("https://example.com/clip.mp4", tooMany());
    expect(
      await codeOf(
        fetcher.download("https://example.com/clip.mp4", { policy }, join(dir, "clip.bin"), {
          maxBytes: 1_000_000,
        }),
      ),
    ).toContain("rate_limited");
  });
});

describe("the production transport", () => {
  /** A service on loopback that no research request may ever reach. */
  let internal: Server | undefined;
  let hits = 0;
  afterEach(() => {
    vi.restoreAllMocks();
    internal?.closeAllConnections();
    internal?.close();
    internal = undefined;
  });
  async function startInternal(): Promise<number> {
    hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/plain" }).end("internal");
    });
    internal = server;
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  }

  it("is the pinned transport, the only one that connects to the vetted addresses", () => {
    expect(globalTransport).toBe(pinnedTransport);
  });

  it("refuses a host that resolves to a loopback service without connecting to it", async () => {
    const port = await startInternal();
    const fetcher = new PolicyFetcher({ guard: new UrlGuard(async () => ["127.0.0.1"]) });

    const message = await codeOf(
      fetcher.openPublic(`http://internal.example.test:${port}/`, {}, AbortSignal.timeout(2_000)),
    );

    expect(message).toContain("blocked_by_policy");
    expect(hits).toBe(0);
  });

  it("connects to the address it vetted and never asks DNS again, so a rebinding answer reaches nothing", async () => {
    const port = await startInternal();
    // The guard's one lookup answers a public address (TEST-NET-1, never routed); every later one would answer loopback.
    let answers = 0;
    const rebinding = async () => (answers++ === 0 ? ["192.0.2.10"] : ["127.0.0.1"]);
    const systemLookup = vi.spyOn(dns, "lookup");
    const fetcher = new PolicyFetcher({ guard: new UrlGuard(rebinding) });

    const message = await codeOf(
      fetcher.openPublic(`http://rebind.example.test:${port}/`, {}, AbortSignal.timeout(600)),
    );

    expect(message).toContain("network");
    expect(answers).toBe(1);
    expect(hits).toBe(0);
    expect(systemLookup.mock.calls.filter(([host]) => host === "rebind.example.test")).toEqual([]);
  });
});
