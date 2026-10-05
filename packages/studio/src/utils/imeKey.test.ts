import { describe, expect, it } from "vitest";
import { isImeKeyEvent } from "./imeKey";

describe("isImeKeyEvent", () => {
  it("is true while a composition is open", () => {
    expect(isImeKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("is true for the Enter that commits a composition in WebKit, where isComposing is already false", () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("is false for an ordinary Enter", () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
