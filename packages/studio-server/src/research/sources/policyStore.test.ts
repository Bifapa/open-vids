// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isResearchFailure } from "../errors.js";
import { API_KEYS_FILE } from "./apiKeys.js";
import { BUILT_IN_IDS } from "./builtins.js";
import { normalizeDomain } from "./domains.js";
import { PolicyStore } from "./policyStore.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openvids-policy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function refused(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (isResearchFailure(error)) return error.error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the Asset Search policy", () => {
  it("starts in trusted mode with every built-in source enabled, and keeps changes across instances", () => {
    const store = new PolicyStore({ dir });
    const first = store.get();
    expect(first.mode).toBe("trusted");
    expect(first.sources.map((source) => source.id)).toEqual(BUILT_IN_IDS);
    expect(first.sources.every((source) => source.enabled && source.builtIn)).toBe(true);

    store.setMode("any");
    store.updateSource("openverse", { enabled: false, name: "Openverse (mine)" });
    const again = new PolicyStore({ dir }).get();
    expect(again.mode).toBe("any");
    expect(again.sources.find((source) => source.id === "openverse")).toMatchObject({
      enabled: false,
      name: "Openverse (mine)",
      domains: ["api.openverse.org", "openverse.org"],
    });
    // Windows ACLs have no owner-only mode bits (stat reports 0666-style
    // masks), so the privacy mode is asserted on POSIX only.
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "policy.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("adds a user website with normalized domains and lets every field but the built-ins' domains change", () => {
    const store = new PolicyStore({ dir });
    const added = store.addSource({
      name: "Unsplash",
      domains: ["https://www.Unsplash.com/s/photos/ocean", "images.unsplash.com", "unsplash.com"],
      kinds: ["video", "picture"],
    });
    const source = added.sources.find((entry) => !entry.builtIn);
    expect(source).toMatchObject({
      name: "Unsplash",
      connector: "site",
      enabled: true,
      domains: ["unsplash.com", "images.unsplash.com"],
      kinds: ["video", "picture"],
      apiKey: null,
    });
    expect(source?.id).toMatch(/^src-[0-9a-f]{8}$/);

    const updated = store.updateSource(source?.id ?? "", {
      domains: ["unsplash.com", "plus.unsplash.com"],
      enabled: false,
      kinds: ["video"],
    });
    expect(updated.sources.find((entry) => entry.id === source?.id)).toMatchObject({
      enabled: false,
      domains: ["unsplash.com", "plus.unsplash.com"],
      kinds: ["video"],
    });
    // A built-in source's domains are fixed.
    expect(
      refused(() => store.updateSource("wikimedia-commons", { domains: ["evil.example"] })),
    ).toBe("invalid_request");
    expect(refused(() => store.updateSource("src-nope", { enabled: true }))).toBe("unknown_source");
    expect(store.removeSource(source?.id ?? "").sources.some((entry) => !entry.builtIn)).toBe(
      false,
    );
  });

  it("removes a built-in source for good until the user restores the built-in sources", () => {
    const store = new PolicyStore({ dir });
    store.updateSource("nasa-images", { enabled: false });
    const removed = store.removeSource("nasa-images");
    expect(removed.sources.map((source) => source.id)).not.toContain("nasa-images");
    expect(removed.removedBuiltIns).toEqual(["nasa-images"]);
    // Other updates do not bring it back.
    store.setMode("any");
    expect(new PolicyStore({ dir }).get().removedBuiltIns).toEqual(["nasa-images"]);
    expect(refused(() => store.removeSource("nasa-images"))).toBe("unknown_source");

    const restored = store.restoreBuiltIns();
    expect(restored.removedBuiltIns).toEqual([]);
    expect(restored.sources.find((source) => source.id === "nasa-images")).toMatchObject({
      enabled: true,
      name: "NASA Image and Video Library",
    });
  });

  it("refuses domains that are not one organization's website, and a domain another source already owns", () => {
    const store = new PolicyStore({ dir });
    for (const bad of [
      "com",
      "localhost",
      "127.0.0.1",
      "192.168.1.5",
      "[::1]",
      "intranet",
      "printer.local",
      "co.uk",
      "github.io",
      "",
      "not a domain",
    ]) {
      expect(
        refused(() => normalizeDomain(bad)),
        bad,
      ).toBe("invalid_request");
    }
    expect(normalizeDomain("HTTP://WWW.Example.ORG:8080/path?q=1")).toBe("example.org");
    expect(normalizeDomain("blog.example.co.uk")).toBe("blog.example.co.uk");

    expect(refused(() => store.addSource({ name: "x", domains: ["commons.wikimedia.org"] }))).toBe(
      "conflict",
    );
    expect(refused(() => store.addSource({ name: "", domains: ["a.example"] }))).toBe(
      "invalid_request",
    );
    expect(refused(() => store.addSource({ name: "x", domains: [] }))).toBe("invalid_request");
    expect(
      refused(() =>
        store.addSource({
          name: "x",
          domains: Array.from({ length: 17 }, (_, i) => `d${i}.example`),
        }),
      ),
    ).toBe("invalid_request");
    expect(refused(() => store.addSource({ name: "x", domains: ["a.example"], kinds: [] }))).toBe(
      "invalid_request",
    );
    expect(refused(() => store.addSource({ name: "x".repeat(81), domains: ["a.example"] }))).toBe(
      "invalid_request",
    );
  });

  it("keeps a source's API key out of the policy and says only whether one is saved", () => {
    const store = new PolicyStore({ dir });
    const pexels = () => store.get().sources.find((source) => source.id === "pexels");
    expect(pexels()?.apiKey).toEqual({
      signupUrl: "https://www.pexels.com/api/new/",
      configured: false,
    });
    expect(store.apiKeyFor("pexels")).toBeNull();

    store.setMode("any");
    const saved = store.setApiKey("pexels", "  abc123XYZ  ");
    expect(saved.sources.find((source) => source.id === "pexels")?.apiKey?.configured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("abc123XYZ");
    expect(readFileSync(join(dir, "policy.json"), "utf-8")).not.toContain("abc123XYZ");
    expect(new PolicyStore({ dir }).apiKeyFor("pexels")).toBe("abc123XYZ");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, API_KEYS_FILE)).mode & 0o777).toBe(0o600);
    }

    expect(store.removeApiKey("pexels").sources.find((s) => s.id === "pexels")?.apiKey).toEqual({
      signupUrl: "https://www.pexels.com/api/new/",
      configured: false,
    });
    expect(store.apiKeyFor("pexels")).toBeNull();
  });

  it("refuses a key for a source that needs none, an unknown source, and a key that is not one word", () => {
    const store = new PolicyStore({ dir });
    expect(store.get().sources.find((source) => source.id === "openverse")?.apiKey).toBeNull();
    expect(refused(() => store.setApiKey("openverse", "abc"))).toBe("invalid_request");
    expect(refused(() => store.setApiKey("src-nope", "abc"))).toBe("unknown_source");
    for (const bad of ["", "   ", "two words", "x".repeat(257), "key\u0085", "kéy", "a\u200bb"]) {
      expect(
        refused(() => store.setApiKey("pixabay", bad)),
        bad,
      ).toBe("invalid_request");
    }
    // What `trim()` removes around a pasted key (a byte-order mark too) is not part of it.
    store.setApiKey("pixabay", "\ufeff abc-123 \n");
    expect(store.apiKeyFor("pixabay")).toBe("abc-123");
    // A key file that is not ours reads as no keys at all.
    writeFileSync(join(dir, API_KEYS_FILE), '{"keys":{"pixabay":"from-elsewhere"}}');
    expect(store.apiKeyFor("pixabay")).toBeNull();
  });

  it("falls back to the defaults, keeping the damaged file as a backup, instead of trusting a file it cannot read", () => {
    const store = new PolicyStore({ dir });
    store.setMode("any");
    writeFileSync(
      join(dir, "policy.json"),
      '{"schema":"openvids.research-policy/1","mode":"any","userSources":[{"id":"src-x","domains":["evil.example"]}]',
    );
    const policy = store.get();
    expect(policy.mode).toBe("trusted");
    expect(policy.sources).toHaveLength(BUILT_IN_IDS.length);
    expect(existsSync(join(dir, "policy.json.bak"))).toBe(true);
    expect(readFileSync(join(dir, "policy.json.bak"), "utf-8")).toContain("evil.example");

    // A structurally valid file with an unusable user source is refused as a whole too.
    writeFileSync(
      join(dir, "policy.json"),
      JSON.stringify({
        schema: "openvids.research-policy/1",
        mode: "any",
        builtIns: {},
        userSources: [
          {
            id: "src-x",
            name: "x",
            enabled: true,
            domains: [5],
            kinds: ["video"],
            description: "",
            licenseNote: "",
          },
        ],
        removedBuiltIns: [],
        updatedAt: 1,
      }),
    );
    expect(store.get().mode).toBe("trusted");
  });
});

describe("the Websites group of the policy", () => {
  const stored = (extra: object) =>
    JSON.stringify({
      schema: "openvids.research-policy/1",
      mode: "any",
      builtIns: {},
      userSources: [],
      removedBuiltIns: [],
      updatedAt: 1,
      ...extra,
    });

  it("defaults to reading linked pages, for a new file and for one written before the setting existed", () => {
    const store = new PolicyStore({ dir });
    expect(store.get().websites).toEqual({ readLinkedPages: true, fullAccess: false });
    writeFileSync(join(dir, "policy.json"), stored({}));
    const old = store.get();
    expect(old).toMatchObject({
      mode: "any",
      websites: { readLinkedPages: true, fullAccess: false },
    });

    // A file from before full access existed keeps its switch, with full access off.
    writeFileSync(join(dir, "policy.json"), stored({ websites: { readLinkedPages: false } }));
    const before = store.get();
    expect(before).toMatchObject({
      mode: "any",
      websites: { readLinkedPages: false, fullAccess: false },
    });
    expect(existsSync(join(dir, "policy.json.bak"))).toBe(false);

    // The full shape (as the home server or a newer Studio writes it) loads as-is.
    writeFileSync(
      join(dir, "policy.json"),
      stored({ websites: { readLinkedPages: true, fullAccess: true } }),
    );
    expect(store.get().websites).toEqual({ readLinkedPages: true, fullAccess: true });
  });

  it("keeps the switches across instances without touching the mode or the sources", () => {
    const store = new PolicyStore({ dir });
    store.setMode("any");
    store.setWebsites({ readLinkedPages: false, fullAccess: true });
    const again = new PolicyStore({ dir }).get();
    expect(again).toMatchObject({
      mode: "any",
      websites: { readLinkedPages: false, fullAccess: true },
    });
    expect(again.sources).toHaveLength(BUILT_IN_IDS.length);
    expect(new PolicyStore({ dir }).setWebsites({}).websites).toEqual({
      readLinkedPages: false,
      fullAccess: true,
    });
    // Changing one switch keeps the other.
    expect(store.setWebsites({ fullAccess: false }).websites).toEqual({
      readLinkedPages: false,
      fullAccess: false,
    });
    expect(store.setWebsites({ readLinkedPages: true }).websites).toEqual({
      readLinkedPages: true,
      fullAccess: false,
    });
  });

  it("does not guess at a damaged value: the whole file is replaced by the defaults and kept as a backup", () => {
    const store = new PolicyStore({ dir });
    writeFileSync(join(dir, "policy.json"), stored({ websites: { readLinkedPages: "no" } }));
    expect(store.get().mode).toBe("trusted");
    expect(existsSync(join(dir, "policy.json.bak"))).toBe(true);

    // A present-but-non-boolean fullAccess is damaged as well.
    store.setMode("any");
    expect(store.get().mode).toBe("any");
    writeFileSync(
      join(dir, "policy.json"),
      stored({ websites: { readLinkedPages: true, fullAccess: "yes" } }),
    );
    expect(store.get()).toMatchObject({
      mode: "trusted",
      websites: { readLinkedPages: true, fullAccess: false },
    });
  });
});
