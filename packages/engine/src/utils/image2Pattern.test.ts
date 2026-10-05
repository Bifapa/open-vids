import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { image2PatternPath } from "./image2Pattern.js";

describe("image2PatternPath", () => {
  it("leaves a directory without '%' untouched", () => {
    expect(image2PatternPath(join("a", "frames"), "frame_%06d.jpg")).toBe(
      join("a", "frames", "frame_%06d.jpg"),
    );
  });

  it("escapes '%' in the directory part only", () => {
    expect(image2PatternPath(join("Promo 50% off", "frames"), "frame_%06d.jpg")).toBe(
      join("Promo 50%% off", "frames", "frame_%06d.jpg"),
    );
  });
});
