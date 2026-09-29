import { describe, expect, it } from "vitest";
import {
  augmentPageNavigationTimeoutError,
  isPageNavigationTimeoutError,
} from "./pageNavigationTimeoutErrorHint.js";

describe("augmentPageNavigationTimeoutError", () => {
  it("passes non-Navigation-timeout errors through unchanged (same instance)", () => {
    const original = new Error("Runtime.callFunctionOn timed out");
    const result = augmentPageNavigationTimeoutError(original, 60_000);
    expect(result).toBe(original);
    expect(result.message).toBe("Runtime.callFunctionOn timed out");
  });

  it("augments 'Navigation timeout of Xms exceeded' with the effective timeout", () => {
    const original = new Error("Navigation timeout of 60000 ms exceeded");
    const result = augmentPageNavigationTimeoutError(original, 60_000);
    expect(result).not.toBe(original);
    expect(result.message).toContain(original.message);
    expect(result.message).toContain(
      "HyperFrames effective page.goto navigation timeout: 60000 ms",
    );
  });

  it("includes the env + CLI + browser-path hints in the generic augmentation", () => {
    const original = new Error("Navigation timeout of 60000 ms exceeded");
    const result = augmentPageNavigationTimeoutError(original, 60_000);
    expect(result.message).toContain("PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS");
    expect(result.message).toContain("--browser-timeout");
    expect(result.message).toContain("HYPERFRAMES_BROWSER_PATH");
  });

  it("preserves err.cause on the augmented error", () => {
    const original = new Error("Navigation timeout of 60000 ms exceeded");
    const result = augmentPageNavigationTimeoutError(original, 60_000);
    expect(result.cause).toBe(original);
  });

  it("augments net::ERR_TIMED_OUT errors as well", () => {
    const original = new Error("net::ERR_TIMED_OUT at http://127.0.0.1:4173/index.html");
    const result = augmentPageNavigationTimeoutError(original, 120_000);
    expect(result).not.toBe(original);
    expect(result.message).toContain("HyperFrames effective page.goto navigation timeout: 120000");
  });

  it("coerces non-Error thrown values into Error without augmenting", () => {
    const result = augmentPageNavigationTimeoutError("plain string failure", 60_000);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("plain string failure");
    // Not augmented: coerced string doesn't match the Nav-timeout regex.
    expect(result.message).not.toContain("HyperFrames effective page.goto navigation timeout");
  });

  it("fires the generic augmentation on the former darwin/arm64 + CSS 3D + audio compound (container hint removed)", () => {
    const original = new Error("Navigation timeout of 60000 ms exceeded");
    const result = augmentPageNavigationTimeoutError(original, 60_000);
    expect(result.message).toContain("HYPERFRAMES_BROWSER_PATH");
    expect(result.message).toContain("--browser-timeout");
    expect(result.message).not.toContain("docker");
  });

  it("fires the generic augmentation for a linux composition with CSS 3D + audio signals present", () => {
    const original = new Error("Navigation timeout of 90000 ms exceeded");
    const result = augmentPageNavigationTimeoutError(original, 90_000);
    expect(result.message).toContain(
      "HyperFrames effective page.goto navigation timeout: 90000 ms",
    );
    expect(result.message).not.toContain("docker");
    // Generic hints still fire.
    expect(result.message).toContain("PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS");
    expect(result.message).toContain("HYPERFRAMES_BROWSER_PATH");
  });

  it("fires the generic augmentation for an Intel-mac composition with CSS 3D + audio signals present", () => {
    const original = new Error("net::ERR_TIMED_OUT at http://127.0.0.1:4173/index.html");
    const result = augmentPageNavigationTimeoutError(original, 120_000);
    expect(result.message).toContain("PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS");
    expect(result.message).toContain("--browser-timeout");
    expect(result.message).not.toContain("docker");
  });

  it("fires the generic augmentation for a darwin/arm64 composition without CSS 3D", () => {
    const original = new Error("Navigation timeout of 30000 ms exceeded");
    const result = augmentPageNavigationTimeoutError(original, 30_000);
    expect(result.message).toContain(
      "HyperFrames effective page.goto navigation timeout: 30000 ms",
    );
    expect(result.message).toContain("HYPERFRAMES_BROWSER_PATH");
    expect(result.message).toContain("--browser-timeout");
    expect(result.message).not.toContain("docker");
  });

  it("fires the generic augmentation for a darwin/arm64 composition without audio", () => {
    const original = new Error("Navigation timeout of 60000 ms exceeded");
    const result = augmentPageNavigationTimeoutError(original, 180_000);
    expect(result.message).toContain(
      "HyperFrames effective page.goto navigation timeout: 180000 ms",
    );
    expect(result.message).toContain("HYPERFRAMES_BROWSER_PATH");
    expect(result.message).toContain("--browser-timeout");
    expect(result.message).not.toContain("docker");
  });

  it("fires the generic augmentation when composition signals are unknown (compound fallback removed)", () => {
    // The renderOrchestrator wire-up never threaded compile-time CSS-3D /
    // audio signals into this helper; with the container render mode deleted
    // there is no compound gate left, so every matching error receives the
    // generic env/flag/browser-path augmentation.
    const original = new Error("net::ERR_TIMED_OUT at http://127.0.0.1:4173/index.html");
    const result = augmentPageNavigationTimeoutError(original, 60_000);
    expect(result.message).not.toContain("docker");
    // Generic hints still fire.
    expect(result.message).toContain("PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS");
    expect(result.message).toContain("HYPERFRAMES_BROWSER_PATH");
  });

  it("augments with generic hints when no context is passed", () => {
    // Regression: earlier drafts required an explicit platform/arch context.
    // Make sure the helper still augments (with generic hints) with defaults.
    const original = new Error("Navigation timeout of 60000 ms exceeded");
    const result = augmentPageNavigationTimeoutError(original, 60_000);
    expect(result).not.toBe(original);
    expect(result.message).toContain("PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS");
    expect(result.message).toContain("HYPERFRAMES_BROWSER_PATH");
  });
});

describe("isPageNavigationTimeoutError", () => {
  it("returns true for matching messages", () => {
    expect(isPageNavigationTimeoutError(new Error("Navigation timeout of 60000 ms exceeded"))).toBe(
      true,
    );
    expect(isPageNavigationTimeoutError("net::ERR_TIMED_OUT")).toBe(true);
  });

  it("returns false for non-matching messages", () => {
    expect(isPageNavigationTimeoutError(new Error("Runtime.callFunctionOn timed out"))).toBe(false);
    expect(isPageNavigationTimeoutError(new Error("Target closed"))).toBe(false);
    expect(isPageNavigationTimeoutError(null)).toBe(false);
    expect(isPageNavigationTimeoutError(undefined)).toBe(false);
    expect(isPageNavigationTimeoutError(42)).toBe(false);
  });
});
