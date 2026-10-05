/**
 * A deliberately small Markdown subset for assistant text: paragraphs, headings, bullet and
 * numbered lists, tables, fenced code, and inline code, bold, links and timecodes. It produces a tree, never
 * HTML, so nothing the model writes can become markup; the renderer turns the tree into React elements.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string }
  /** `0:42`, `1:05.5`, `00:01:23`: a point in the composition the reader can jump to. */
  | { kind: "timecode"; text: string; seconds: number };

export type TableAlignment = "left" | "center" | "right" | null;

export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  /** `align` is the delimiter row's choice per column (null: none given); every row has one cell per column. */
  | {
      kind: "table";
      header: Inline[][];
      align: TableAlignment[];
      rows: Inline[][][];
    };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** The URL to put in an `href`, or null when it is not a plain web or mail link. */
export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
}

// code | bold | [text](url) | bare http(s) URL | timecode, leftmost match first. A timecode is
// [h:]m:ss[.fff] standing alone (not part of a longer number, ratio or address).
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|(?<![\w:.])(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)(?:\.(\d{1,3}))?(?![\w:]|\.\d)/g;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (end: number) => {
    if (end > last) out.push({ kind: "text", text: source.slice(last, end) });
  };
  for (const match of source.matchAll(INLINE)) {
    const [whole, code, strong, linkText, linkTarget, bareUrl, hours, minutes, secs, fraction] =
      match;
    const index = match.index ?? 0;
    if (code !== undefined) {
      pushText(index);
      out.push({ kind: "code", text: code });
    } else if (strong !== undefined) {
      pushText(index);
      out.push({ kind: "strong", text: strong });
    } else if (linkText !== undefined && linkTarget !== undefined) {
      pushText(index);
      const href = safeHref(linkTarget);
      // An unsafe target keeps its text and drops the link: never an anchor that does something else.
      out.push(href ? { kind: "link", text: linkText, href } : { kind: "text", text: linkText });
    } else if (bareUrl !== undefined) {
      const href = safeHref(bareUrl);
      if (!href) continue;
      pushText(index);
      out.push({ kind: "link", text: bareUrl, href });
    } else if (minutes !== undefined && secs !== undefined) {
      pushText(index);
      const seconds =
        Number(hours ?? 0) * 3600 +
        Number(minutes) * 60 +
        Number(secs) +
        (fraction ? Number(`0.${fraction}`) : 0);
      out.push({ kind: "timecode", text: whole, seconds });
    }
    last = index + whole.length;
  }
  pushText(source.length);
  return out;
}

const FENCE_OPEN = /^ {0,3}```\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^ {0,3}```\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^ {0,3}\d+[.)]\s+(.*)$/;

function startsBlock(line: string): boolean {
  return FENCE_OPEN.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line);
}

const TABLE_DELIMITER_CELL = /^:?-+:?$/;

/** The cells of a table row: the outer pipes are optional, and `\|` is a literal pipe. */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * A GFM table starting at `lines[index]`: a row of cells followed by a delimiter row (`| --- | :-: |`) with as many
 * cells. Anything else with pipes in it is ordinary text. Partial text that has not reached its delimiter row yet is
 * still a paragraph, and becomes the table once the delimiter row streams in.
 */
function tableHeaderAt(
  lines: readonly string[],
  index: number,
): { cells: string[]; align: TableAlignment[] } | null {
  const line = lines[index] ?? "";
  const delimiter = lines[index + 1] ?? "";
  if (!line.includes("|") || !delimiter.includes("|")) return null;
  const cells = splitTableRow(line);
  const marks = splitTableRow(delimiter);
  if (marks.length !== cells.length || !marks.every((mark) => TABLE_DELIMITER_CELL.test(mark))) {
    return null;
  }
  const align = marks.map((mark): TableAlignment => {
    if (mark.startsWith(":")) return mark.endsWith(":") ? "center" : "left";
    return mark.endsWith(":") ? "right" : null;
  });
  return { cells, align };
}

/** Parses partial text too: an unterminated fence is a code block so far, so streaming never flickers. */
export function parseMarkdownLite(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_CLOSE.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // the closing fence, when there is one
      blocks.push({ kind: "code", language: fence[1] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        inline: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    const bullet = BULLET.test(line);
    if (bullet || NUMBERED.test(line)) {
      const pattern = bullet ? BULLET : NUMBERED;
      const items: Inline[][] = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index] ?? "");
        if (!item) break;
        items.push(parseInline(item[1] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered: !bullet, items });
      continue;
    }

    const header = tableHeaderAt(lines, index);
    if (header) {
      const rows: Inline[][][] = [];
      index += 2; // the header row and its delimiter row
      while (index < lines.length) {
        const row = lines[index] ?? "";
        if (row.trim() === "" || !row.includes("|") || startsBlock(row)) break;
        // A short row is padded with empty cells and a long one loses its excess, so every row fills the header.
        const cells = splitTableRow(row);
        rows.push(header.cells.map((_, column) => parseInline(cells[column] ?? "")));
        index += 1;
      }
      blocks.push({
        kind: "table",
        header: header.cells.map((cell) => parseInline(cell)),
        align: header.align,
        rows,
      });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "") break;
      if (paragraph.length > 0 && (startsBlock(next) || tableHeaderAt(lines, index))) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}
