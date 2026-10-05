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

  it("turns standalone timecodes into seek points, but not ports, ratios or longer numbers", () => {
    const timecodes = (text: string) =>
      parseInline(text).flatMap((node) =>
        node.kind === "timecode" ? [[node.text, node.seconds]] : [],
      );
    expect(timecodes("Cut at 0:42, hold to 1:05.5 and end 01:02:03.")).toEqual([
      ["0:42", 42],
      ["1:05.5", 65.5],
      ["01:02:03", 3723],
    ]);
    expect(timecodes("Range 0:12–0:18.")).toEqual([
      ["0:12", 12],
      ["0:18", 18],
    ]);
    expect(
      timecodes("See http://127.0.0.1:5407/a, a 16:9 frame, 1:2:3:4, 12:345 and `0:42`."),
    ).toEqual([]);
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

  describe("tables", () => {
    const text = (cells: readonly (readonly { kind: string; text?: string }[])[]) =>
      cells.map((cell) => cell.map((node) => node.text ?? "").join(""));

    it("reads a pipe table with its header, per-column alignment and rows", () => {
      const [table] = parseMarkdownLite(
        "| Chapter | Start | Length |\n| :--- | :---: | ---: |\n| Intro | 0:00 | 12 s |\n| Outro | 1:40 | 8 s |",
      );
      expect(table?.kind).toBe("table");
      if (table?.kind !== "table") return;
      expect(text(table.header)).toEqual(["Chapter", "Start", "Length"]);
      expect(table.align).toEqual(["left", "center", "right"]);
      expect(table.rows.map(text)).toEqual([
        ["Intro", "0:00", "12 s"],
        ["Outro", "1:40", "8 s"],
      ]);
      // The cells are inline Markdown: a timecode in a cell still seeks.
      expect(table.rows[0]?.[1]).toEqual([{ kind: "timecode", text: "0:00", seconds: 0 }]);
    });

    it("takes tables without outer pipes, and fills every row to the header's width", () => {
      const [table] = parseMarkdownLite("a | b\n--- | ---\n1 |\n2 | 3 | 4");
      if (table?.kind !== "table") throw new Error("not a table");
      expect(table.align).toEqual([null, null]);
      expect(table.rows.map(text)).toEqual([
        ["1", ""],
        ["2", "3"],
      ]);
    });

    it("keeps an escaped pipe inside its cell", () => {
      const [table] = parseMarkdownLite("| cmd |\n| --- |\n| a \\| b |");
      if (table?.kind !== "table") throw new Error("not a table");
      expect(table.rows.map(text)).toEqual([["a | b"]]);
    });

    it("starts right after a paragraph line and ends at a blank line or the next block", () => {
      const blocks = parseMarkdownLite(
        "Summary:\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n\n| c |\n|---|\n| 3 |\n- item",
      );
      expect(blocks.map((block) => block.kind)).toEqual([
        "paragraph",
        "table",
        "paragraph",
        "table",
        "list",
      ]);
    });

    it("leaves text with pipes alone unless a matching delimiter row follows", () => {
      for (const source of [
        "a | b | c",
        "a | b\nnot a delimiter",
        "| a | b |\n|---|\n| 1 | 2 |",
        "| a |\n| -- x |",
      ]) {
        expect(
          parseMarkdownLite(source).map((block) => block.kind),
          source,
        ).toEqual(["paragraph"]);
      }
    });

    it("shows a table whose delimiter row has not arrived yet as text, then as a table", () => {
      expect(parseMarkdownLite("| a | b |\n|--").map((block) => block.kind)).toEqual(["paragraph"]);
      expect(parseMarkdownLite("| a | b |\n|---|---|").map((block) => block.kind)).toEqual([
        "table",
      ]);
    });
  });
});
