import { isRecord, type DesignManifest } from "@hyperframes/agent-protocol";

/** The id of the data block `system.html` embeds its manifest in. */
export const MANIFEST_BLOCK_ID = "openvids-design-manifest";

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFontRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.family === "string" &&
    typeof value.role === "string" &&
    typeof value.source === "string" &&
    Array.isArray(value.files)
  );
}

function isTransitionRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    typeof value.durationSec === "number" &&
    typeof value.ease === "string"
  );
}

/** Shape check of a manifest read back from a `system.html` (the service validates the real thing on write). */
export function isDesignManifest(value: unknown): value is DesignManifest {
  return (
    isRecord(value) &&
    value.schema === "openvids.design-system/1" &&
    typeof value.version === "number" &&
    isRecord(value.source) &&
    Array.isArray(value.fonts) &&
    value.fonts.every(isFontRecord) &&
    Array.isArray(value.transitions) &&
    value.transitions.every(isTransitionRecord) &&
    isStringList(value.motionRules) &&
    isStringList(value.dos) &&
    isStringList(value.donts) &&
    isRecord(value.colorNames) &&
    typeof value.summary === "string" &&
    isStringList(value.guesses)
  );
}

/** The manifest embedded in a `system.html`, or null when the block is missing or not a manifest. */
export function parseManifestHtml(html: string): DesignManifest | null {
  const open = new RegExp(
    `<script[^>]*\\bid=["']${MANIFEST_BLOCK_ID}["'][^>]*>([\\s\\S]*?)</script>`,
    "i",
  ).exec(html);
  if (!open?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(open[1]);
    return isDesignManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The custom properties declared in the first `:root { … }` block of a stylesheet (`--name: value`), in order. */
export function parseRootTokens(css: string): Record<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css);
  const tokens: Record<string, string> = {};
  if (!root?.[1]) return tokens;
  for (const declaration of root[1].split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (/^--[a-z][a-z0-9-]*$/.test(name) && value.length > 0) tokens[name] = value;
  }
  return tokens;
}
