import type { DesignManifest, DesignSystemSpec } from "@hyperframes/agent-protocol";
import { parseHTML } from "linkedom";
import { analyseCss } from "./css.js";
import { DesignFailure } from "./errors.js";
import { MANIFEST_ELEMENT_ID, readDesignManifest, type ManifestRead } from "./manifest.js";

export interface ParsedDesignSystem {
  spec: DesignSystemSpec;
  manifest: DesignManifest;
}

/** The text of the manifest data block, null when there is none (or more than one). */
export function manifestBlockText(document: Document): string | null {
  const blocks = [...document.querySelectorAll("script")].filter(
    (script) => script.getAttribute("id") === MANIFEST_ELEMENT_ID,
  );
  const block = blocks.length === 1 ? blocks[0] : undefined;
  return block ? (block.textContent ?? "") : null;
}

/** Every `:root` token of the page's `<style>` blocks (later declarations win). */
export function rootTokens(document: Document): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const style of document.querySelectorAll("style"))
    Object.assign(tokens, analyseCss(style.textContent ?? "", "<style>").tokens);
  return tokens;
}

/** The manifest block read and shape-checked against `tokens`. */
export function readManifestBlock(
  document: Document,
  tokens: Record<string, string>,
): ManifestRead {
  const text = manifestBlockText(document);
  if (text === null)
    return {
      ok: false,
      issues: [
        `manifest: one <script type="application/json" id="${MANIFEST_ELEMENT_ID}"> is required`,
      ],
    };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: ["manifest: the data block is not valid JSON"] };
  }
  return readDesignManifest(value, tokens);
}

/**
 * Reads a saved `system.html` back into the spec an author edits (tokens from the `:root` blocks, everything else
 * from the manifest) and its manifest. Throws an `invalid_system` failure naming what is malformed.
 */
export function parseDesignSystemHtml(html: string): ParsedDesignSystem {
  const { document } = parseHTML(html);
  const tokens = rootTokens(document);
  if (Object.keys(tokens).length === 0)
    throw new DesignFailure("invalid_system", "system.html declares no :root tokens");
  const read = readManifestBlock(document, tokens);
  if (!read.ok)
    throw new DesignFailure("invalid_system", "system.html cannot be read back", read.issues);
  return { spec: read.spec, manifest: read.manifest };
}
