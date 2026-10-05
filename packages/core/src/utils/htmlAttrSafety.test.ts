import { describe, it, expect } from "vitest";
import { isSafeAttributeValue } from "./htmlAttrSafety";

describe("isSafeAttributeValue", () => {
  it("rejects javascript: and vbscript: URIs", () => {
    expect(isSafeAttributeValue("href", "javascript:alert(1)")).toBe(false);
    expect(isSafeAttributeValue("src", "JavaScript:alert(1)")).toBe(false);
    expect(isSafeAttributeValue("xlink:href", "vbscript:msgbox(1)")).toBe(false);
  });

  it.each([
    ["tab inside the scheme", "java\tscript:alert(1)"],
    ["newline inside the scheme", "java\nscript:alert(1)"],
    ["carriage return inside the scheme", "jav\rascript:alert(1)"],
    ["leading C0 control", "\x01javascript:alert(1)"],
    ["leading NUL and space", "\x00 javascript:alert(1)"],
    ["leading newline", "\n\tjavascript:alert(1)"],
  ])("rejects %s (URL parsing strips it before reading the scheme)", (_label, value) => {
    expect(isSafeAttributeValue("href", value)).toBe(false);
    expect(new URL(value).protocol).toBe("javascript:");
  });

  it("rejects text/html data URIs, including control-character obfuscation", () => {
    expect(isSafeAttributeValue("src", "data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeAttributeValue("src", "da\tta:text/html,x")).toBe(false);
    expect(isSafeAttributeValue("src", "\x02data: text/html,x")).toBe(false);
  });

  it("accepts ordinary URLs and values", () => {
    expect(isSafeAttributeValue("href", "https://example.com/a?b=javascript:1")).toBe(true);
    expect(isSafeAttributeValue("src", "assets/clip.mp4")).toBe(true);
    expect(isSafeAttributeValue("src", "data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeAttributeValue("href", "#javascript:")).toBe(true);
  });

  it("does not inspect non-URI attributes", () => {
    expect(isSafeAttributeValue("title", "javascript:alert(1)")).toBe(true);
  });
});
