import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdownLite, safeHref } from "./markdownParse";

describe("safeHref", () => {
  it("allows web and mail links", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    expect(safeHref("mailto:hi@example.com")).toBe("mailto:hi@example.com");
  });

  it("refuses script-capable and relative targets, including obfuscated ones", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "//evil.example",
      "/relative/path",
      "file:///etc/passwd",
    ]) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });
});

describe("parseInline", () => {
  it("turns an unsafe markdown link into plain text, never an anchor", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ kind: "text", text: "click" }]);
  });

  it("keeps markup-looking text as text", () => {
    const nodes = parseInline('<img src=x onerror="alert(1)"> and <script>alert(1)</script>');
    expect(nodes).toEqual([
      { kind: "text", text: '<img src=x onerror="alert(1)"> and <script>alert(1)</script>' },
    ]);
  });

  it("finds code, bold, links and bare urls in order", () => {
    expect(parseInline("run `bun x` **now** at [docs](https://a.dev) or https://b.dev.")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "bun x" },
      { kind: "text", text: " " },
      { kind: "strong", text: "now" },
      { kind: "text", text: " at " },
      { kind: "link", text: "docs", href: "https://a.dev/" },
      { kind: "text", text: " or " },
      { kind: "link", text: "https://b.dev", href: "https://b.dev/" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves an unfinished marker literal while a message is still streaming", () => {
    expect(parseInline("half **bold and `code")).toEqual([
      { kind: "text", text: "half **bold and `code" },
    ]);
  });
});

describe("parseMarkdownLite", () => {
  it("splits paragraphs, lists and headings", () => {
    const blocks = parseMarkdownLite(
      "# Title\n\nFirst line\nsecond line\n\n- a\n- b\n\n1. one\n2. two",
    );
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "list"]);
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: "a" }], [{ text: "b" }]] });
    expect(blocks[3]).toMatchObject({ ordered: true });
  });

  it("keeps a fenced block verbatim, even when it holds markup or markdown", () => {
    const blocks = parseMarkdownLite(
      "```html\n<script>alert(1)</script>\n- not a list\n```\nafter",
    );
    expect(blocks[0]).toEqual({
      kind: "code",
      language: "html",
      text: "<script>alert(1)</script>\n- not a list",
    });
    expect(blocks[1]).toMatchObject({ kind: "paragraph" });
  });

  it("treats an unterminated fence as code so far", () => {
    expect(parseMarkdownLite("```ts\nconst a = 1;")).toEqual([
      { kind: "code", language: "ts", text: "const a = 1;" },
    ]);
  });
});
