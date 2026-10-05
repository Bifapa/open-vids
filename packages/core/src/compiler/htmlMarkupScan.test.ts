import { describe, expect, it } from "vitest";
import { findAllStartTags, parseStartTagAttributes } from "./htmlMarkupScan.js";

describe("findAllStartTags", () => {
  const tags = (html: string) => findAllStartTags(html).map((r) => html.slice(r.start, r.end));

  it("returns whole start tags, treating '>' inside quoted values as part of the value", () => {
    expect(tags(`<div a="x>y" b='p>q'><span>t</span></div>`)).toEqual([
      `<div a="x>y" b='p>q'>`,
      "<span>",
    ]);
  });

  it("skips comments, raw text and template content", () => {
    expect(
      tags(
        `<!-- <i a> --><script>"<i b>"</script><style><i c></style><template><i d></template><i e>`,
      ),
    ).toEqual(["<script>", "<style>", "<template>", "<i e>"]);
  });
});

describe("parseStartTagAttributes", () => {
  it("reads double-quoted, single-quoted, unquoted and valueless attributes", () => {
    const attrs = parseStartTagAttributes(`<div A="1" b='2' c=3 d e = "5" f/>`);
    expect([...attrs]).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["d", ""],
      ["e", "5"],
      ["f", ""],
    ]);
  });

  it("keeps the first occurrence of a duplicated attribute, like the HTML parser", () => {
    expect(parseStartTagAttributes(`<p id="a" id="b">`).get("id")).toBe("a");
  });
});
