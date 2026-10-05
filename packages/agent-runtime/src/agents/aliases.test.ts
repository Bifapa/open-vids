import { describe, expect, it } from "vitest";
import { parseSpecialistName } from "./aliases.js";

describe("parseSpecialistName", () => {
  it("reads the specialist the way models write it", () => {
    expect(parseSpecialistName("Editor")).toBe("editor");
    expect(parseSpecialistName("_vision")).toBe("vision");
    expect(parseSpecialistName("delegate_to_audio")).toBe("audio");
    expect(parseSpecialistName("Motion Designer")).toBe("motion");
    expect(parseSpecialistName("director")).toBeNull();
    expect(parseSpecialistName(7)).toBeNull();
  });
});
