import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type {
  DesignFontFile,
  DesignLicense,
  DesignManifest,
  DesignManifestFont,
  DesignManifestLogo,
  DesignSystemSpec,
} from "@hyperframes/agent-protocol";
import { DesignFailure } from "./errors.js";
import type { GoogleFontFace } from "./googleFonts.js";
import { svgRefusal } from "./logoSvg.js";

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const GOOGLE_LICENSE: DesignLicense = {
  name: "SIL Open Font License 1.1",
  url: "https://openfontlicense.org",
};

export type FetchFont = (
  family: string,
  weights: number[],
  italic: boolean,
) => Promise<GoogleFontFace[]>;
export type ResolveProjectFile = (
  projectId: string,
  path: string,
) => Promise<{ absPath: string } | null>;

/** A file the version will hold: its bytes, or `null` to carry the same path over from the version it is based on. */
export interface ResolvedBlob {
  path: string;
  data: Uint8Array | null;
}

export interface ResolvedAssets {
  fonts: DesignManifestFont[];
  logo: DesignManifestLogo | null;
  blobs: ResolvedBlob[];
  notes: string[];
}

export interface ResolveContext {
  fetchFont: FetchFont;
  resolveProjectFile: ResolveProjectFile | undefined;
  projectId: string | undefined;
  /** The manifest of `baseVersion`, whose files an unchanged font or logo may keep. */
  base: DesignManifest | null;
}

function slug(value: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return out || "font";
}

function hash8(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 8);
}

function unavailable(message: string): DesignFailure {
  return new DesignFailure("asset_unavailable", message);
}

/** A project-relative path that stays inside the project: no root, no `..`, no NUL or backslash. */
function isSafeProjectPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part !== ".." && part !== "")
  );
}

type FontKind = "woff2" | "woff" | "ttf" | "otf";
const FONT_EXTENSIONS: Record<string, FontKind> = {
  ".woff2": "woff2",
  ".woff": "woff",
  ".ttf": "ttf",
  ".otf": "otf",
};

function fontKindOf(data: Uint8Array): FontKind | null {
  const tag = Buffer.from(data.subarray(0, 4)).toString("latin1");
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || (data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0))
    return "ttf";
  return null;
}

function imageKindOf(data: Uint8Array): "png" | "jpg" | "webp" | null {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  const head = Buffer.from(data.subarray(0, 12)).toString("latin1");
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "webp";
  return null;
}

/**
 * Reads a file the project resolver named: a regular file (not a link), at most 8 MB; `null` when it is not there,
 * so an edit can keep the stored copy of a logo or font it names by its library path.
 */
async function readProjectFile(
  context: ResolveContext,
  path: string,
  what: string,
): Promise<Buffer | null> {
  if (!isSafeProjectPath(path))
    throw unavailable(`${what}: "${path}" is not a project-relative path`);
  if (!context.projectId || !context.resolveProjectFile) return null;
  const resolved = await context.resolveProjectFile(context.projectId, path);
  if (resolved === null) return null;
  try {
    const info = lstatSync(resolved.absPath);
    if (!info.isFile()) throw unavailable(`${what}: "${path}" is not a regular file`);
    if (info.size > MAX_ASSET_BYTES) throw unavailable(`${what}: "${path}" is larger than 8 MB`);
    return readFileSync(resolved.absPath);
  } catch (error) {
    if (error instanceof DesignFailure) throw error;
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    // Not there (any more): the caller keeps a stored copy or reports the file as missing.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw unavailable(`${what}: "${path}" cannot be read`);
  }
}

function sameFont(a: DesignManifestFont, b: DesignSystemSpec["fonts"][number]): boolean {
  return (
    a.family === b.family &&
    a.source === b.source &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.projectPath ?? "") === (b.projectPath ?? "") &&
    a.weights.join(",") === b.weights.join(",")
  );
}

async function resolveFont(
  font: DesignSystemSpec["fonts"][number],
  context: ResolveContext,
  assets: ResolvedAssets,
): Promise<void> {
  const label = `Font "${font.family}"`;
  const italic = font.italic === true;
  const style = italic ? "italic" : "normal";
  const kept = context.base?.fonts.find((candidate) => sameFont(candidate, font));
  const license = font.license ?? (font.source === "google" ? GOOGLE_LICENSE : null);
  if (font.source === "google" && font.license === null)
    assets.notes.push(
      `${label}: license set to ${GOOGLE_LICENSE.name} (the Google Fonts default).`,
    );
  const manifest = (files: DesignFontFile[], portable: boolean): DesignManifestFont => ({
    ...font,
    license,
    files,
    portable,
  });
  if (font.source === "system") {
    assets.fonts.push(manifest([], false));
    assets.notes.push(
      `${label} is a system font: nothing is stored and the system is flagged as not portable to other machines.`,
    );
    return;
  }
  if (font.source === "google") {
    if (kept && kept.files.length > 0) {
      assets.fonts.push(manifest(kept.files, true));
      assets.blobs.push(...kept.files.map((file) => ({ path: file.path, data: null })));
      return;
    }
    const faces = await context.fetchFont(font.family, font.weights, italic);
    const files: DesignFontFile[] = [];
    let bytes = 0;
    for (const face of faces) {
      const path = `fonts/${slug(font.family)}-${face.weight}-${face.style}-${face.subset.replace(/[^a-z0-9-]/g, "")}-${hash8(face.data)}.woff2`;
      if (files.some((file) => file.path === path)) continue;
      files.push({
        path,
        weight: face.weight,
        style: face.style,
        ...(face.unicodeRange && { unicodeRange: face.unicodeRange }),
      });
      assets.blobs.push({ path, data: face.data });
      bytes += face.data.byteLength;
    }
    assets.fonts.push(manifest(files, true));
    assets.notes.push(
      `${label}: downloaded ${files.length} files (${Math.round(bytes / 1024)} KB) from Google Fonts.`,
    );
    return;
  }
  // A font file of the project.
  const projectPath = font.projectPath ?? "";
  const data = await readProjectFile(context, projectPath, label);
  if (data === null) {
    if (kept && kept.files.length > 0) {
      assets.fonts.push(manifest(kept.files, true));
      assets.blobs.push(...kept.files.map((file) => ({ path: file.path, data: null })));
      return;
    }
    throw unavailable(
      context.projectId
        ? `${label}: "${projectPath}" was not found in the project`
        : `${label}: copying "${projectPath}" needs a projectId`,
    );
  }
  const kind = fontKindOf(data);
  const extension = FONT_EXTENSIONS[extname(projectPath).toLowerCase()];
  if (kind === null || extension === undefined || kind !== extension)
    throw unavailable(`${label}: "${projectPath}" is not a woff2, woff, ttf or otf font file`);
  const path = `fonts/${slug(font.family)}-${style}-${hash8(data)}.${kind}`;
  assets.blobs.push({ path, data });
  assets.fonts.push(
    manifest(
      font.weights.map((weight) => ({ path, weight, style })),
      true,
    ),
  );
  assets.notes.push(`${label}: copied ${projectPath} into the library.`);
}

async function resolveLogo(
  logo: NonNullable<DesignSystemSpec["logo"]>,
  context: ResolveContext,
  assets: ResolvedAssets,
): Promise<void> {
  const keptPath = context.base?.logo?.path;
  const data = await readProjectFile(context, logo.projectPath, "Logo");
  if (data === null) {
    if (keptPath !== undefined && logo.projectPath === keptPath) {
      assets.logo = { path: keptPath, license: logo.license };
      assets.blobs.push({ path: keptPath, data: null });
      return;
    }
    throw unavailable(
      context.projectId
        ? `Logo: "${logo.projectPath}" was not found in the project`
        : `Logo: copying "${logo.projectPath}" needs a projectId`,
    );
  }
  const extension = extname(logo.projectPath).toLowerCase().replace(".jpeg", ".jpg");
  let kind: "png" | "jpg" | "webp" | "svg" | null = null;
  if (extension === ".svg") {
    const refusal = svgRefusal(data.toString("utf-8"));
    if (refusal !== null) throw unavailable(`Logo: "${logo.projectPath}" is refused: ${refusal}`);
    kind = "svg";
  } else if (extension === ".png" || extension === ".jpg" || extension === ".webp") {
    const sniffed = imageKindOf(data);
    kind = sniffed === extension.slice(1) ? sniffed : null;
  }
  if (kind === null)
    throw unavailable(`Logo: "${logo.projectPath}" is not a png, jpg, svg or webp image`);
  const path = `logo.${kind}`;
  assets.blobs.push({ path, data });
  assets.logo = { path, license: logo.license };
}

/**
 * Turns a spec's fonts and logo into stored files (in memory; the network and the project are read here, before the
 * library lock is taken): Google families downloaded, project files read and checked (extension allow-list, magic
 * bytes, 8 MB, no links, SVG logos refused if they script or reach out), system fonts recorded as not portable. An
 * unchanged font or logo of `base` keeps its files without being fetched again.
 */
export async function resolveAssets(
  spec: DesignSystemSpec,
  context: ResolveContext,
): Promise<ResolvedAssets> {
  const assets: ResolvedAssets = { fonts: [], logo: null, blobs: [], notes: [] };
  for (const font of spec.fonts) await resolveFont(font, context, assets);
  if (spec.logo) await resolveLogo(spec.logo, context, assets);
  return assets;
}

/** The names of the fonts and the logo without a known license, for the pre-export check. */
export function unknownLicenses(
  fonts: DesignManifestFont[],
  logo: DesignManifestLogo | null,
): string[] {
  return [
    ...fonts.filter((font) => font.license === null).map((font) => `font:${font.family}`),
    ...(logo && logo.license === null ? ["logo"] : []),
  ];
}
