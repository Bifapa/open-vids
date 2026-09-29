/**
 * A deliberately small Markdown subset for assistant text: paragraphs, headings, bullet and
 * numbered lists, fenced code, and inline code, bold and links. It produces a tree, never HTML,
 * so nothing the model writes can become markup; the renderer turns the tree into React elements.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

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

// code | bold | [text](url) | bare http(s) URL, leftmost match first.
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (end: number) => {
    if (end > last) out.push({ kind: "text", text: source.slice(last, end) });
  };
  for (const match of source.matchAll(INLINE)) {
    const [whole, code, strong, linkText, linkTarget, bareUrl] = match;
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

    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "" || (paragraph.length > 0 && startsBlock(next))) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}
