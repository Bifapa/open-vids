import { parseHTML } from "linkedom";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";

export interface GsapScriptBlock {
  scriptText: string;
  document: Document;
  replaceScript: (newText: string) => string;
}

/**
 * Mint the HTML's ids (so a tween saved on a served id writes that id too), parse it with
 * linkedom, locate the inline `<script>` holding GSAP timeline code, and return its text and
 * a function that replaces that script block and serialises back to HTML.
 */
export function extractGsapScriptBlock(html: string): GsapScriptBlock | null {
  const { document } = parseHTML(ensureHfIds(html));
  const scripts = [
    ...document.querySelectorAll("script:not([src])"),
    ...Array.from(document.querySelectorAll("template")).flatMap((tmpl) =>
      Array.from(tmpl.querySelectorAll("script:not([src])")),
    ),
  ];
  for (const script of scripts) {
    const content = script.textContent || "";
    if (
      content.includes("gsap.timeline") ||
      content.includes(".set(") ||
      content.includes(".to(")
    ) {
      return {
        scriptText: content,
        document,
        replaceScript(newText: string): string {
          script.textContent = newText;
          return document.toString();
        },
      };
    }
  }
  return null;
}
