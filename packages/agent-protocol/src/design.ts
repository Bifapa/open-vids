/**
 * Design systems: the OpenVids-owned contract for the app-wide library of design systems and the snapshot a project
 * carries.
 *
 * - The **library** is global (per user): `~/.openvids/design-systems/<id>/` (override `$OPENVIDS_DESIGN_SYSTEMS_DIR`).
 *   The current version lives at the top of the folder — `system.html` (a showcase for people and the source for
 *   agents: the `:root` tokens, an embedded JSON manifest, live samples), `tokens.css` (the same tokens plus the
 *   `@font-face` rules for the local `fonts/`), `fonts/`, the logo, `thumbnail.svg` and `meta.json`. Every version is
 *   also kept under `versions/<n>/`. Several processes write the library: every write runs under one cross-process
 *   lock (`<root>/.lock`), and a version is complete under `versions/<n>/` before the top level shows it.
 * - A **project** carries a copy of one version in `design/` (`system.html`, `tokens.css`, `fonts/`, the logo) plus the
 *   record `design/design.json` ({@link AttachedDesign}). The project's files are the single source of truth: agents
 *   read only `design/`, a fork or a moved project keeps working. Attaching never changes a composition; a newer
 *   library version reaches the project only through an explicit update.
 * - Renders never touch the network for an attached system: its fonts are files, `tokens.css` declares their
 *   `@font-face` with relative URLs, and a composition that links `design/tokens.css` gets them inlined by the
 *   bundler (the font localizer then finds a face for every family and fetches nothing).
 * - The structured {@link DesignSystemSpec} is the only thing agents write; the server renders `system.html`,
 *   `tokens.css` and the thumbnail from it, so the format is always valid. Reading a saved system back gives the same
 *   spec (parsed from `system.html`).
 */

import type { DesignSourceKind } from "./types.js";
import { DESIGN_SOURCE_KINDS, isDesignSystemIdText } from "./types.js";
import { isRecord, type Parsed } from "./validate.js";

// ── Tokens ───────────────────────────────────────────────────────────────────

/** The 18 tokens of the `themes/` contract; a design system defines every one of them. */
export const DESIGN_REQUIRED_TOKENS = [
  "--bg",
  "--fg",
  "--muted",
  "--surface",
  "--border",
  "--brand",
  "--accent",
  "--accent-2",
  "--font-display",
  "--font-body",
  "--font-mono",
  "--radius",
  "--space-1",
  "--space-2",
  "--space-3",
  "--dur-beat",
  "--ease-standard",
  "--ease-emphasis",
] as const;

/** Tokens a system should add on top of the contract (type scale, shadows, transitions); optional, others are allowed. */
export const DESIGN_EXTENDED_TOKENS = [
  "--text-sm",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--text-3xl",
  "--text-4xl",
  "--leading-tight",
  "--leading-normal",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--dur-fast",
  "--dur-slow",
] as const;

export const DESIGN_TOKEN_NAME = /^--[a-z][a-z0-9-]{0,47}$/;
export const DESIGN_LIMITS = {
  tokens: 80,
  tokenValueChars: 300,
  fonts: 8,
  transitions: 16,
  rules: 40,
  ruleChars: 300,
  nameChars: 80,
  noteChars: 1000,
} as const;

/**
 * Whether a token value is safe to bake into a stylesheet and a `<style>` block: no declaration or block break
 * (`; { } < >`), no backslash escapes, comments, `url(`, `@import` or `expression(`.
 */
export function isSafeDesignTokenValue(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= DESIGN_LIMITS.tokenValueChars &&
    !/[;{}<>\\\p{Cc}]/u.test(value) &&
    !/\/\*|\*\/|url\s*\(|@import|expression\s*\(/i.test(value)
  );
}

// ── Spec (what agents write) ─────────────────────────────────────────────────

export const DESIGN_FONT_SOURCES = [
  /** A Google Fonts family: the library downloads its files when the version is saved. */
  "google",
  /** A font file already in the project (`projectPath`, e.g. one `read_website` saved): copied into the library. */
  "file",
  /** A font installed on the machine: nothing is stored, the system is flagged non-portable. */
  "system",
] as const;
export type DesignFontSource = (typeof DESIGN_FONT_SOURCES)[number];

export const DESIGN_FONT_ROLES = ["display", "body", "mono", "other"] as const;
export type DesignFontRole = (typeof DESIGN_FONT_ROLES)[number];

/** A font or logo license as recorded; `null` (unknown) goes into the pre-export license check. */
export interface DesignLicense {
  /** "SIL OFL 1.1", "Apache 2.0", "Commercial (Acme Fonts)". */
  name: string;
  url?: string;
}

export interface DesignFontSpec {
  family: string;
  role: DesignFontRole;
  source: DesignFontSource;
  weights: number[];
  italic?: boolean;
  /** `file` only: the project-relative font file; the save request names its `projectId`. */
  projectPath?: string;
  /** Google fonts: `OFL 1.1` by default (the library fills it in); anything else: as found, `null` = unknown. */
  license: DesignLicense | null;
  /** A guess (a font read off a video): shown as "similar" and replaceable, never as the exact font. */
  guess?: boolean;
}

export const DESIGN_TRANSITION_KINDS = [
  "cut",
  "fade",
  "slide",
  "push",
  "wipe",
  "zoom",
  "blur",
  "custom",
] as const;
export type DesignTransitionKind = (typeof DESIGN_TRANSITION_KINDS)[number];

export interface DesignTransition {
  name: string;
  kind: DesignTransitionKind;
  durationSec: number;
  /** A CSS timing function (`cubic-bezier(…)`, `ease-out`) or a GSAP ease name (`power2.out`). */
  ease: string;
  note?: string;
  /** A guess (read off a video): marked in the showcase and the manifest. */
  guess?: boolean;
}

export interface DesignLogoSpec {
  /** The project-relative logo file (`png`, `jpg`, `svg`, `webp`); the save request names its `projectId`. */
  projectPath: string;
  license: DesignLicense | null;
}

export interface DesignSystemSpec {
  /** Every {@link DESIGN_REQUIRED_TOKENS} entry, plus any extended or custom ones. */
  tokens: Record<string, string>;
  /** Human names of colour tokens (`--brand`: "Sunset orange"); the showcase labels its palette with them. */
  colorNames?: Record<string, string>;
  fonts: DesignFontSpec[];
  transitions: DesignTransition[];
  /** Motion rules ("Cuts on the beat; never longer than 0.6 s"). */
  motionRules: string[];
  dos: string[];
  donts: string[];
  logo?: DesignLogoSpec | null;
  /** What the system is for, one or two sentences (the brief in short). */
  summary?: string;
}

/** Where a system came from; `ref` names it (a project, a video file, a site's host). */
export interface DesignSystemSource {
  kind: DesignSourceKind;
  ref?: string;
}

// ── Library ──────────────────────────────────────────────────────────────────

export interface DesignFontFile {
  /** Relative to the system folder: `fonts/inter-400-normal-latin-ab12cd34.woff2`. */
  path: string;
  weight: number;
  style: "normal" | "italic";
  unicodeRange?: string;
}

/** A font as stored in a version: the spec's font plus the files the library resolved it to. */
export interface DesignManifestFont extends DesignFontSpec {
  files: DesignFontFile[];
  /** False for a system font: it is not in `fonts/` and a render machine may not have it. */
  portable: boolean;
}

export interface DesignManifestLogo {
  /** Relative to the system folder: `logo.svg`. */
  path: string;
  license: DesignLicense | null;
}

/** The JSON block embedded in `system.html` (`<script type="application/json" id="openvids-design-manifest">`). */
export interface DesignManifest {
  schema: "openvids.design-system/1";
  version: number;
  source: DesignSystemSource;
  fonts: DesignManifestFont[];
  transitions: DesignTransition[];
  motionRules: string[];
  dos: string[];
  donts: string[];
  logo: DesignManifestLogo | null;
  colorNames: Record<string, string>;
  summary: string;
  /** Everything in the system that was guessed, in words (fonts and transitions read off a video, …). */
  guesses: string[];
}

/** What the pre-export license check reads from a system: names of fonts/logo without a known license. */
export interface DesignLicenseFacts {
  unknownLicenses: string[];
  /** Families that are installed on the author's machine but not stored (not portable to another machine). */
  nonPortableFonts: string[];
}

/** A library card: what the Projects page and the pickers list. */
export interface DesignSystemSummary extends DesignLicenseFacts {
  id: string;
  name: string;
  version: number;
  source: DesignSystemSource;
  createdAt: number;
  updatedAt: number;
  /** The palette of the current version, for a quick swatch row (`--bg`, `--fg`, `--brand`, `--accent`, `--accent-2`). */
  palette: string[];
  /** The display font family. */
  displayFont: string | null;
}

/**
 * `<id>/meta.json` — the library entry: a {@link DesignSystemSummary} plus its schema tag; `version` is the current
 * one. A rename changes only `name` and `updatedAt` (no new version). The list reads only these files.
 */
export interface DesignSystemMeta extends DesignSystemSummary {
  schema: "openvids.design-system-meta/1";
}

export interface DesignVersionInfo {
  version: number;
  createdAt: number;
  source: DesignSystemSource;
}

/** `GET /api/design-systems/:id` */
export interface DesignSystemDetail extends DesignSystemSummary {
  spec: DesignSystemSpec;
  manifest: DesignManifest;
  /** Every kept version, newest first. */
  versions: DesignVersionInfo[];
  /** Library-relative files of the current version (`system.html`, `tokens.css`, `fonts/…`). */
  files: string[];
}

// ── Project ──────────────────────────────────────────────────────────────────

/** `<project>/design/design.json` — which version the project's snapshot is. The shell writes the same file. */
export interface AttachedDesign extends DesignLicenseFacts {
  schema: "openvids.project-design/1";
  id: string;
  version: number;
  /** The system's name when it was attached. */
  name: string;
  attachedAt: number;
  /**
   * The library entry's `createdAt` when it was attached: which system the id meant. A deleted and recreated id has a
   * new one, so version numbers that started over are not mistaken for "no update". Absent in older snapshots.
   */
  createdAt?: number;
}

/** `GET /api/projects/:id/design` */
export interface ProjectDesignState {
  attached: AttachedDesign | null;
  /** The library's current entry for the attached id; null when none is attached or the system was deleted. */
  library: { name: string; version: number } | null;
  /** The library holds a newer version than the snapshot; nothing changes until the user updates. */
  updateAvailable: boolean;
  /** Whether the project's own `design/` snapshot is readable and valid (`system.html` + `tokens.css`). */
  snapshotOk: boolean;
}

// ── Extraction from a project ────────────────────────────────────────────────

/** `GET /api/projects/:id/design/extract` — what the project's compositions use, counted; no model involved. */
export interface ProjectDesignExtraction {
  /** Compositions scanned (project-relative). */
  files: string[];
  colors: ExtractedColor[];
  fonts: ExtractedFont[];
  easings: ExtractedValue[];
  durations: ExtractedDuration[];
  radii: ExtractedValue[];
  /** Font sizes in px/rem/cqmin as written, most used first. */
  fontSizes: ExtractedValue[];
  shadows: ExtractedValue[];
  /** Tokens the project already declares in `:root` / an attached `design/tokens.css` (name → value). */
  declaredTokens: Record<string, string>;
}

export interface ExtractedValue {
  value: string;
  count: number;
}

export const EXTRACTED_COLOR_ROLES = ["background", "text", "border", "fill", "other"] as const;
export type ExtractedColorRole = (typeof EXTRACTED_COLOR_ROLES)[number];

export interface ExtractedColor {
  /** Normalised: `#rrggbb` (lowercase) or `#rrggbbaa`. */
  value: string;
  count: number;
  /** The CSS properties the colour appeared in, grouped. */
  roles: ExtractedColorRole[];
}

export interface ExtractedFont {
  family: string;
  count: number;
  weights: number[];
  /** How the project loads it: a `@font-face` file in the project, a Google Fonts link/stylesheet, or nothing (a system font or a name only). */
  loading: "project_file" | "google" | "unresolved";
  /** `project_file`: the project-relative file of one face. */
  projectPath?: string;
}

export interface ExtractedDuration {
  seconds: number;
  count: number;
}

/**
 * `GET /api/projects/:id/design/video-palette?video=<project path>[&samples=<n>]` — the dominant colours of frames
 * sampled across a project video, measured (ffmpeg/pixel quantisation), no model involved. The `video` source of a
 * design action reads its exact colours from here; fonts and motion in a video are only ever guessed by looking.
 */
export interface VideoPalette {
  /** The project-relative video that was sampled. */
  video: string;
  durationSec: number;
  /** How many frames were sampled (evenly across the video). */
  samples: number;
  /** Dominant colours, most frequent first, `#rrggbb` lowercase. */
  colors: VideoPaletteColor[];
}

export interface VideoPaletteColor {
  value: string;
  /** Share of the sampled pixels, 0–1. */
  share: number;
}

export const VIDEO_PALETTE_LIMITS = { minSamples: 1, maxSamples: 24, defaultSamples: 8 } as const;

// ── Requests and errors ──────────────────────────────────────────────────────

/**
 * `PUT /api/design-systems/:id` — create the system or save a new version of it. `baseVersion` is the version the
 * author started from: absent when creating (the id must be free), the current version when editing — a different
 * current version is a `conflict`. `projectId` names the project that `projectPath`s resolve in.
 */
export interface SaveDesignSystemRequest {
  /** Required when creating; an edit (`baseVersion`) may leave it out and keeps the current name (a rename made meanwhile is not undone). */
  name?: string;
  source: DesignSystemSource;
  spec: DesignSystemSpec;
  baseVersion?: number;
  /** With `baseVersion`: the `createdAt` of the system the author read, so an id deleted and recreated meanwhile is a `conflict`. */
  baseCreatedAt?: number;
  projectId?: string;
}

export interface SaveDesignSystemResult {
  system: DesignSystemSummary;
  /** What the save did that the author should know: fonts downloaded, a system font left out, a license defaulted. */
  notes: string[];
}

/** `PATCH /api/design-systems/:id` — rename only (no new version). */
export interface RenameDesignSystemRequest {
  name: string;
}

/** `PUT /api/projects/:id/design` — attach (or switch to) a library system. */
export interface AttachDesignRequest {
  id: string;
}

export const DESIGN_ERROR_CODES = [
  "invalid_request",
  /** The spec or a stored system.html breaks the format (missing token, script, external URL, unresolved font). */
  "invalid_system",
  "not_found",
  /** `baseVersion` is not the current version, or a new id is taken. */
  "conflict",
  /** Another process holds the library lock. */
  "busy",
  /** A font or logo could not be fetched or read. */
  "asset_unavailable",
  "unavailable",
] as const;
export type DesignErrorCode = (typeof DESIGN_ERROR_CODES)[number];

export interface DesignError {
  code: DesignErrorCode;
  message: string;
  /** `invalid_system`: every problem found, not just the first. */
  issues?: string[];
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export type ParsedDesign<T> = { ok: true; value: T } | { ok: false; error: DesignError };

function bad(message: string, issues?: string[]): { ok: false; error: DesignError } {
  return { ok: false, error: { code: "invalid_request", message, ...(issues && { issues }) } };
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : null;
}

function strings(value: unknown, field: string, max: number): Parsed<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > DESIGN_LIMITS.rules)
    return {
      ok: false,
      message: `${field} must be an array of at most ${DESIGN_LIMITS.rules} strings`,
    };
  const out: string[] = [];
  for (const entry of value) {
    const line = text(entry, max);
    if (line === null)
      return { ok: false, message: `${field} holds a string that is empty or too long` };
    out.push(line);
  }
  return { ok: true, value: out };
}

function parseLicense(value: unknown, field: string): Parsed<DesignLicense | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false, message: `${field} must be an object or null` };
  const name = text(value.name, 120);
  if (name === null) return { ok: false, message: `${field}.name must be a non-empty string` };
  const url = value.url === undefined ? undefined : text(value.url, 500);
  if (url === null) return { ok: false, message: `${field}.url must be a string` };
  return { ok: true, value: { name, ...(url && { url }) } };
}

function parseFont(value: unknown, index: number): Parsed<DesignFontSpec> {
  const field = `spec.fonts[${index}]`;
  if (!isRecord(value)) return { ok: false, message: `${field} must be an object` };
  const family = text(value.family, 80);
  if (family === null || /["'\\;{}<>]/.test(family))
    return { ok: false, message: `${field}.family must be a plain family name` };
  const role = DESIGN_FONT_ROLES.find((known) => known === value.role);
  if (!role)
    return { ok: false, message: `${field}.role must be one of: ${DESIGN_FONT_ROLES.join(", ")}` };
  const source = DESIGN_FONT_SOURCES.find((known) => known === value.source);
  if (!source)
    return {
      ok: false,
      message: `${field}.source must be one of: ${DESIGN_FONT_SOURCES.join(", ")}`,
    };
  const weightsRaw = value.weights;
  if (!Array.isArray(weightsRaw) || weightsRaw.length === 0 || weightsRaw.length > 9)
    return { ok: false, message: `${field}.weights must list 1 to 9 weights` };
  const weights: number[] = [];
  for (const weight of weightsRaw) {
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 100 || weight > 900)
      return { ok: false, message: `${field}.weights must be integers from 100 to 900` };
    if (!weights.includes(weight)) weights.push(weight);
  }
  const license = parseLicense(value.license, `${field}.license`);
  if (!license.ok) return license;
  let projectPath: string | undefined;
  if (value.projectPath !== undefined) {
    const path = text(value.projectPath, 500);
    if (path === null) return { ok: false, message: `${field}.projectPath must be a string` };
    projectPath = path;
  }
  if (source === "file" && !projectPath)
    return { ok: false, message: `${field}: a "file" font needs projectPath` };
  return {
    ok: true,
    value: {
      family,
      role,
      source,
      weights: weights.sort((a, b) => a - b),
      ...(value.italic === true && { italic: true }),
      ...(projectPath && { projectPath }),
      license: license.value,
      ...(value.guess === true && { guess: true }),
    },
  };
}

function parseTransition(value: unknown, index: number): Parsed<DesignTransition> {
  const field = `spec.transitions[${index}]`;
  if (!isRecord(value)) return { ok: false, message: `${field} must be an object` };
  const name = text(value.name, 60);
  if (name === null) return { ok: false, message: `${field}.name must be a non-empty string` };
  const kind = DESIGN_TRANSITION_KINDS.find((known) => known === value.kind);
  if (!kind)
    return {
      ok: false,
      message: `${field}.kind must be one of: ${DESIGN_TRANSITION_KINDS.join(", ")}`,
    };
  const durationSec = value.durationSec;
  if (
    typeof durationSec !== "number" ||
    !Number.isFinite(durationSec) ||
    durationSec < 0 ||
    durationSec > 10
  )
    return { ok: false, message: `${field}.durationSec must be a number of seconds from 0 to 10` };
  const ease = text(value.ease, 120);
  if (ease === null || !isSafeDesignTokenValue(ease))
    return {
      ok: false,
      message: `${field}.ease must be a CSS timing function or a GSAP ease name`,
    };
  const note = value.note === undefined ? undefined : text(value.note, DESIGN_LIMITS.ruleChars);
  if (note === null) return { ok: false, message: `${field}.note must be a string` };
  return {
    ok: true,
    value: {
      name,
      kind,
      durationSec,
      ease,
      ...(note && { note }),
      ...(value.guess === true && { guess: true }),
    },
  };
}

/** Shape-checks a spec; the library's own validation (fonts resolve to files, the rendered HTML is clean) runs on save. */
export function parseDesignSystemSpec(value: unknown): Parsed<DesignSystemSpec> {
  if (!isRecord(value)) return { ok: false, message: "spec must be an object" };
  if (!isRecord(value.tokens)) return { ok: false, message: "spec.tokens must be an object" };
  const entries = Object.entries(value.tokens);
  if (entries.length > DESIGN_LIMITS.tokens)
    return { ok: false, message: `spec.tokens holds more than ${DESIGN_LIMITS.tokens} tokens` };
  const tokens: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!DESIGN_TOKEN_NAME.test(name))
      return { ok: false, message: `spec.tokens: "${name}" is not a token name (--lower-case)` };
    if (typeof raw !== "string" || !isSafeDesignTokenValue(raw))
      return { ok: false, message: `spec.tokens["${name}"] is not a safe CSS value` };
    tokens[name] = raw.trim();
  }
  const colorNames: Record<string, string> = {};
  if (value.colorNames !== undefined) {
    if (!isRecord(value.colorNames))
      return { ok: false, message: "spec.colorNames must be an object" };
    for (const [name, label] of Object.entries(value.colorNames)) {
      const clean = text(label, 60);
      if (!DESIGN_TOKEN_NAME.test(name) || clean === null || /[<>]/.test(clean))
        return { ok: false, message: `spec.colorNames["${name}"] must be a plain name` };
      colorNames[name] = clean;
    }
  }
  if (!Array.isArray(value.fonts) || value.fonts.length > DESIGN_LIMITS.fonts)
    return {
      ok: false,
      message: `spec.fonts must be an array of at most ${DESIGN_LIMITS.fonts} fonts`,
    };
  const fonts: DesignFontSpec[] = [];
  for (const [index, entry] of value.fonts.entries()) {
    const font = parseFont(entry, index);
    if (!font.ok) return font;
    fonts.push(font.value);
  }
  const transitionsRaw = value.transitions ?? [];
  if (!Array.isArray(transitionsRaw) || transitionsRaw.length > DESIGN_LIMITS.transitions)
    return {
      ok: false,
      message: `spec.transitions must be an array of at most ${DESIGN_LIMITS.transitions} transitions`,
    };
  const transitions: DesignTransition[] = [];
  for (const [index, entry] of transitionsRaw.entries()) {
    const transition = parseTransition(entry, index);
    if (!transition.ok) return transition;
    transitions.push(transition.value);
  }
  const motionRules = strings(value.motionRules, "spec.motionRules", DESIGN_LIMITS.ruleChars);
  if (!motionRules.ok) return motionRules;
  const dos = strings(value.dos, "spec.dos", DESIGN_LIMITS.ruleChars);
  if (!dos.ok) return dos;
  const donts = strings(value.donts, "spec.donts", DESIGN_LIMITS.ruleChars);
  if (!donts.ok) return donts;
  let logo: DesignLogoSpec | null = null;
  if (value.logo !== undefined && value.logo !== null) {
    if (!isRecord(value.logo)) return { ok: false, message: "spec.logo must be an object or null" };
    const projectPath = text(value.logo.projectPath, 500);
    if (projectPath === null)
      return { ok: false, message: "spec.logo.projectPath must be a project-relative file" };
    const license = parseLicense(value.logo.license, "spec.logo.license");
    if (!license.ok) return license;
    logo = { projectPath, license: license.value };
  }
  const summary =
    value.summary === undefined ? undefined : text(value.summary, DESIGN_LIMITS.noteChars);
  if (summary === null) return { ok: false, message: "spec.summary must be a string" };
  return {
    ok: true,
    value: {
      tokens,
      ...(Object.keys(colorNames).length > 0 && { colorNames }),
      fonts,
      transitions,
      motionRules: motionRules.value,
      dos: dos.value,
      donts: donts.value,
      ...(logo && { logo }),
      ...(summary && { summary }),
    },
  };
}

export function parseDesignSystemSource(value: unknown): Parsed<DesignSystemSource> {
  if (!isRecord(value)) return { ok: false, message: "source must be an object" };
  const kind = DESIGN_SOURCE_KINDS.find((known) => known === value.kind);
  if (!kind)
    return { ok: false, message: `source.kind must be one of: ${DESIGN_SOURCE_KINDS.join(", ")}` };
  const ref = value.ref === undefined ? undefined : text(value.ref, 300);
  if (ref === null) return { ok: false, message: "source.ref must be a string" };
  return { ok: true, value: { kind, ...(ref && { ref }) } };
}

export function parseDesignSystemName(value: unknown): string | null {
  const name = text(value, DESIGN_LIMITS.nameChars);
  return name !== null && !/[<>\p{Cc}]/u.test(name) ? name.trim() : null;
}

/** The library id for a name: lowercase ASCII words joined by dashes; "system" when nothing is left. */
export function designSystemIdFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const id = slug.length > 0 ? slug : "system";
  // A name Windows reserves for a device cannot be a folder there: "Con" becomes "con-system".
  return isDesignSystemIdText(id) ? id : `${id}-system`;
}

export function isDesignSystemId(value: unknown): value is string {
  return typeof value === "string" && isDesignSystemIdText(value);
}

export function parseSaveDesignSystemRequest(body: unknown): ParsedDesign<SaveDesignSystemRequest> {
  if (!isRecord(body)) return bad("body must be an object");
  let name: string | undefined;
  if (body.name !== undefined || body.baseVersion === undefined) {
    const parsedName = parseDesignSystemName(body.name);
    if (parsedName === null)
      return bad(`name must be 1 to ${DESIGN_LIMITS.nameChars} plain characters`);
    name = parsedName;
  }
  const source = parseDesignSystemSource(body.source);
  if (!source.ok) return bad(source.message);
  const spec = parseDesignSystemSpec(body.spec);
  if (!spec.ok) return bad(spec.message);
  let baseVersion: number | undefined;
  if (body.baseVersion !== undefined) {
    if (
      typeof body.baseVersion !== "number" ||
      !Number.isInteger(body.baseVersion) ||
      body.baseVersion < 1
    )
      return bad("baseVersion must be a positive integer");
    baseVersion = body.baseVersion;
  }
  let baseCreatedAt: number | undefined;
  if (body.baseCreatedAt !== undefined) {
    if (
      baseVersion === undefined ||
      typeof body.baseCreatedAt !== "number" ||
      !Number.isFinite(body.baseCreatedAt)
    )
      return bad("baseCreatedAt must be a number and needs baseVersion");
    baseCreatedAt = body.baseCreatedAt;
  }
  let projectId: string | undefined;
  if (body.projectId !== undefined) {
    const id = text(body.projectId, 300);
    if (id === null) return bad("projectId must be a string");
    projectId = id;
  }
  return {
    ok: true,
    value: {
      ...(name !== undefined && { name }),
      source: source.value,
      spec: spec.value,
      ...(baseVersion !== undefined && { baseVersion }),
      ...(baseCreatedAt !== undefined && { baseCreatedAt }),
      ...(projectId && { projectId }),
    },
  };
}

export function parseRenameDesignSystemRequest(
  body: unknown,
): ParsedDesign<RenameDesignSystemRequest> {
  if (!isRecord(body)) return bad("body must be an object");
  const name = parseDesignSystemName(body.name);
  if (name === null) return bad(`name must be 1 to ${DESIGN_LIMITS.nameChars} plain characters`);
  return { ok: true, value: { name } };
}

export function parseAttachDesignRequest(body: unknown): ParsedDesign<AttachDesignRequest> {
  if (!isRecord(body) || !isDesignSystemId(body.id)) return bad("id must be a design system id");
  return { ok: true, value: { id: body.id } };
}

// ── Guards (answers read back by the runtime and Studio) ─────────────────────

export function isDesignSystemSummary(value: unknown): value is DesignSystemSummary {
  return (
    isRecord(value) &&
    isDesignSystemId(value.id) &&
    typeof value.name === "string" &&
    typeof value.version === "number" &&
    isRecord(value.source) &&
    Array.isArray(value.palette) &&
    Array.isArray(value.unknownLicenses) &&
    Array.isArray(value.nonPortableFonts)
  );
}

export function isDesignSystemDetail(value: unknown): value is DesignSystemDetail {
  return (
    isDesignSystemSummary(value) &&
    isRecord(Reflect.get(value, "spec")) &&
    isRecord(Reflect.get(value, "manifest")) &&
    Array.isArray(Reflect.get(value, "versions"))
  );
}

export function isProjectDesignState(value: unknown): value is ProjectDesignState {
  return (
    isRecord(value) &&
    typeof value.updateAvailable === "boolean" &&
    typeof value.snapshotOk === "boolean" &&
    (value.attached === null || isRecord(value.attached))
  );
}

export function isProjectDesignExtraction(value: unknown): value is ProjectDesignExtraction {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    Array.isArray(value.colors) &&
    Array.isArray(value.fonts) &&
    Array.isArray(value.easings) &&
    Array.isArray(value.durations)
  );
}

export function isVideoPalette(value: unknown): value is VideoPalette {
  return (
    isRecord(value) &&
    typeof value.video === "string" &&
    typeof value.durationSec === "number" &&
    typeof value.samples === "number" &&
    Array.isArray(value.colors) &&
    value.colors.every(
      (color) =>
        isRecord(color) && typeof color.value === "string" && typeof color.share === "number",
    )
  );
}

export function isSaveDesignSystemResult(value: unknown): value is SaveDesignSystemResult {
  return isRecord(value) && isDesignSystemSummary(value.system) && Array.isArray(value.notes);
}

export function isDesignError(value: unknown): value is DesignError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    DESIGN_ERROR_CODES.some((code) => code === value.code)
  );
}
