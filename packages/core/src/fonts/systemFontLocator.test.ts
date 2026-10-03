import { describe, it, expect, beforeAll } from "vitest";
import { locateSystemFont, clearSystemFontCache } from "./systemFontLocator";

describe("systemFontLocator", { timeout: 15_000 }, () => {
  beforeAll(() => {
    clearSystemFontCache();
  });

  it("returns null for nonexistent fonts", async () => {
    expect(await locateSystemFont("nonexistent-font-xyz-12345")).toBeNull();
  });

  it("normalizes case when looking up fonts", async () => {
    const lower = await locateSystemFont("helvetica");
    const upper = await locateSystemFont("HELVETICA");
    if (lower === null) {
      expect(upper).toBeNull();
    } else {
      expect(upper).not.toBeNull();
      expect(upper!.path).toBe(lower.path);
    }
  });

  it("returns a valid format field when a font is found", async () => {
    const result =
      (await locateSystemFont("Helvetica")) ??
      (await locateSystemFont("Arial")) ??
      (await locateSystemFont("DejaVu Sans"));
    if (result) {
      expect(["ttf", "otf", "woff2", "woff", "ttc"]).toContain(result.format);
      expect(result.path).toBeTruthy();
    }
  });

  it("strips quotes from family name input", async () => {
    expect(await locateSystemFont('"nonexistent-font-xyz-12345"')).toBeNull();
  });

  it("returns null for empty string", async () => {
    expect(await locateSystemFont("")).toBeNull();
    expect(await locateSystemFont("  ")).toBeNull();
  });

  if (process.platform === "darwin") {
    it("finds Helvetica on macOS", async () => {
      const result = await locateSystemFont("Helvetica");
      expect(result).not.toBeNull();
      expect(result!.path).toMatch(/\.(ttf|ttc|otf)$/i);
    });

    it("finds Courier on macOS", async () => {
      expect(await locateSystemFont("Courier")).not.toBeNull();
    });

    // system_profiler takes seconds; a server waiting on a font must keep answering requests.
    // Real timers on purpose: the assertion is about wall-clock event-loop stalls, which fake
    // timers cannot observe. The test waits on the lookup itself, not on a fixed delay.
    it("keeps the event loop free while the font index is built", async () => {
      clearSystemFontCache();
      let longestStallMs = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        longestStallMs = Math.max(longestStallMs, now - last);
        last = now;
      }, 20);
      try {
        await locateSystemFont("Helvetica");
      } finally {
        clearInterval(ticker);
      }
      expect(longestStallMs).toBeLessThan(1_000);
    });
  }
});
