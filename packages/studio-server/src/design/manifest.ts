import {
  DESIGN_LIMITS,
  isRecord,
  parseDesignSystemSource,
  parseDesignSystemSpec,
  type DesignFontFile,
  type DesignLicense,
  type DesignManifest,
  type DesignManifestFont,
  type DesignManifestLogo,
  type DesignSystemSpec,
} from "@hyperframes/agent-protocol";
import { FONT_FILE_PATH } from "./css.js";

export const MANIFEST_ELEMENT_ID = "openvids-design-manifest";
export const LOGO_FILE_PATH = /^logo\.(?:png|jpg|svg|webp)$/;

/** A license as stored: null, or a name with an optional URL. Undefined when it is neither. */
function readLicense(value: unknown): DesignLicense | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 120 ||
    (value.url !== undefined && (typeof value.url !== "string" || value.url.length > 500))
  )
    return undefined;
  return { name: value.name, ...(value.url !== undefined && { url: value.url }) };
}

function readFontFile(value: unknown): DesignFontFile | null {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !FONT_FILE_PATH.test(value.path) ||
    typeof value.weight !== "number" ||
    !Number.isInteger(value.weight) ||
    (value.style !== "normal" && value.style !== "italic")
  )
    return null;
  const range = value.unicodeRange;
  if (
    range !== undefined &&
    (typeof range !== "string" || !/^[Uu+0-9A-Fa-f?, -]{1,2000}$/.test(range))
  )
    return null;
  return {
    path: value.path,
    weight: value.weight,
    style: value.style,
    ...(range !== undefined && { unicodeRange: range }),
  };
}

function readStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > DESIGN_LIMITS.ruleChars) return null;
    out.push(entry);
  }
  return out;
}

export type ManifestRead =
  | { ok: true; manifest: DesignManifest; spec: DesignSystemSpec }
  | { ok: false; issues: string[] };

/**
 * The manifest block read back: the shape of every field checked (the spec's own parser does the fonts,
 * transitions, rules and colour names), with the `:root` `tokens` the spec is completed with.
 */
export function readDesignManifest(value: unknown, tokens: Record<string, string>): ManifestRead {
  const fail = (...issues: string[]): ManifestRead => ({ ok: false, issues });
  if (!isRecord(value)) return fail("manifest: is not a JSON object");
  if (value.schema !== "openvids.design-system/1")
    return fail('manifest: schema must be "openvids.design-system/1"');
  const version = value.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    return fail("manifest: version must be a positive integer");
  const source = parseDesignSystemSource(value.source);
  if (!source.ok) return fail(`manifest: ${source.message}`);
  const guesses = readStrings(value.guesses);
  if (guesses === null) return fail("manifest: guesses must be an array of strings");
  if (typeof value.summary !== "string" || value.summary.length > DESIGN_LIMITS.noteChars)
    return fail("manifest: summary must be a string");
  if (!isRecord(value.colorNames)) return fail("manifest: colorNames must be an object");
  if (!Array.isArray(value.fonts)) return fail("manifest: fonts must be an array");

  let logo: DesignManifestLogo | null = null;
  if (value.logo !== null) {
    const license = isRecord(value.logo) ? readLicense(value.logo.license ?? null) : undefined;
    if (
      !isRecord(value.logo) ||
      typeof value.logo.path !== "string" ||
      !LOGO_FILE_PATH.test(value.logo.path) ||
      license === undefined
    )
      return fail("manifest: logo must be null or { path: logo.<ext>, license }");
    logo = { path: value.logo.path, license };
  }

  const spec = parseDesignSystemSpec({
    tokens,
    colorNames: value.colorNames,
    fonts: value.fonts,
    transitions: value.transitions,
    motionRules: value.motionRules,
    dos: value.dos,
    donts: value.donts,
    ...(value.summary.trim() !== "" && { summary: value.summary }),
  });
  if (!spec.ok) return fail(`manifest: ${spec.message.replace(/^spec\./, "")}`);

  const fonts: DesignManifestFont[] = [];
  for (const [index, font] of spec.value.fonts.entries()) {
    const raw: unknown = value.fonts[index];
    if (!isRecord(raw) || !Array.isArray(raw.files) || typeof raw.portable !== "boolean")
      return fail(`manifest: fonts[${index}] needs files and portable`);
    const files: DesignFontFile[] = [];
    for (const entry of raw.files) {
      const file = readFontFile(entry);
      if (file === null) return fail(`manifest: fonts[${index}].files holds an invalid file`);
      files.push(file);
    }
    fonts.push({ ...font, files, portable: raw.portable });
  }
  const manifest: DesignManifest = {
    schema: "openvids.design-system/1",
    version,
    source: source.value,
    fonts,
    transitions: spec.value.transitions,
    motionRules: spec.value.motionRules,
    dos: spec.value.dos,
    donts: spec.value.donts,
    logo,
    colorNames: spec.value.colorNames ?? {},
    summary: spec.value.summary ?? "",
    guesses,
  };
  return {
    ok: true,
    manifest,
    spec: {
      ...spec.value,
      ...(logo && { logo: { projectPath: logo.path, license: logo.license } }),
    },
  };
}
