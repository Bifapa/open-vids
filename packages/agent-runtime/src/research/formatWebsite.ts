import type {
  ReadWebsiteResult,
  RecordWebsiteResult,
  SavedWebsiteFont,
  WebsiteFileResult,
  WebsiteFont,
  WebsiteResource,
  WebsiteResourceKind,
  WebsiteStyle,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";

const quote = (family: string): string => `"${family.replaceAll('"', "")}"`;

const px = (value: number | null): string =>
  value === null ? "?" : `${Math.round(value * 10) / 10}px`;

const megabytes = (bytes: number): string =>
  bytes >= 100_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1_000))} kB`;

const seconds = (value: number): string => `${Number(value.toFixed(1))} s`;

/** Files the page loads, media the user may actually cut into the video first. */
const RESOURCE_ORDER: Record<WebsiteResourceKind, number> = {
  video: 0,
  audio: 1,
  image: 2,
  svg: 3,
  animation: 4,
  font: 5,
  stylesheet: 6,
  script: 7,
  document: 8,
  data: 9,
  other: 10,
};

/** How many resource lines one read_website result shows (the rest is only counted). */
const RESOURCE_LINES = 40;
/** Short display of a resource URL: no scheme, clipped. */
const shortUrl = (url: string): string => {
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > 90 ? `${bare.slice(0, 89)}…` : bare;
};

function resourceLine(resource: WebsiteResource): string {
  const facts = [
    resource.kind,
    resource.width && resource.height ? `${resource.width}×${resource.height}` : null,
    resource.duration !== null ? seconds(resource.duration) : null,
    resource.bytes !== null ? megabytes(resource.bytes) : null,
    shortUrl(resource.url),
    resource.usage || null,
  ].filter((fact): fact is string => fact !== null);
  return `- ${facts.join(" · ")}`;
}

function resourceLines(site: WebsiteStyle, fullAccess: boolean): string[] {
  const { resources } = site;
  if (resources.length === 0) return [];
  const ordered = [...resources].sort((a, b) => RESOURCE_ORDER[a.kind] - RESOURCE_ORDER[b.kind]);
  const shown = ordered.slice(0, RESOURCE_LINES).map(resourceLine);
  const more = ordered.length - RESOURCE_LINES;
  const lines = [`Files the page uses (${resources.length}, media first):`, ...shown];
  if (more > 0) lines.push(`- … and ${more} more (not listed).`);
  lines.push(
    fullAccess
      ? 'Fetch one with get_website_file (mode "save" downloads it into assets/web/<host>/files/, mode "read" returns its raw text); record_website can capture an animation that has no file (canvas, WebGL, CSS-only) as an MP4.'
      : 'Fetch one with get_website_file (mode "save" downloads it into assets/web/<host>/files/, mode "read" returns its raw text); if full access to linked sites is off, the call asks the user in chat to allow it. record_website can capture an animation that has no file (canvas, WebGL, CSS-only) as an MP4.',
  );
  return lines;
}

function fontLine(font: WebsiteFont, saved: readonly SavedWebsiteFont[]): string {
  const weights = font.weights.length > 0 ? font.weights.join("/") : "default";
  const uses = font.usedFor.length > 0 ? font.usedFor.join("+") : "other";
  const head = `- ${quote(font.family)} · ${uses} · weights ${weights}`;
  const files = saved.filter((entry) => entry.family.toLowerCase() === font.family.toLowerCase());
  if (font.source === "google") {
    return `${head} · Google Fonts: use font-family: ${quote(font.family)} in the composition (the renderer resolves Google Fonts by family name).`;
  }
  if (font.source === "system") {
    return `${head} · system font: nothing to load; pick the closest Google Fonts family if the exact one is not on the render machine.`;
  }
  if (files.length > 0) {
    const faces = files
      .map(
        (entry) =>
          `@font-face { font-family: ${quote(font.family)}; src: url("${entry.path}"); font-weight: ${entry.weight}; font-style: ${entry.style}; }`,
      )
      .join(" ");
    return `${head} · self-hosted, saved: ${faces}`;
  }
  return `${head} · self-hosted by the site and NOT saved (call read_website again with save: true to keep the file, or use the closest Google Fonts family and say so).`;
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length > 0 ? [`${title}:`, ...lines] : [];
}

function styleLines(
  site: WebsiteStyle,
  saved: readonly SavedWebsiteFont[],
  fullAccess: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(
    `Website style of ${site.host} — "${site.title}"${site.finalUrl !== site.url ? ` (${site.url} → ${site.finalUrl})` : ` (${site.finalUrl})`}`,
  );
  if (site.description) lines.push(`Description: ${site.description}`);
  if (site.themeColor) lines.push(`theme-color: ${site.themeColor}`);
  lines.push(
    ...section(
      "Palette (hex · role · how many sampled elements)",
      site.colors.map((color) => `- ${color.hex} · ${color.role} · ${color.count}`),
    ),
    ...section(
      "Fonts",
      site.fonts.map((font) => fontLine(font, saved)),
    ),
    ...section(
      "Type scale",
      site.textStyles.map(
        (style) =>
          `- ${style.element} · ${quote(style.fontFamily)} ${px(style.fontSizePx)} / weight ${style.fontWeight} / line ${px(style.lineHeightPx)} / tracking ${px(style.letterSpacingPx)}${style.color ? ` · ${style.color}` : ""}${style.sample ? ` · "${style.sample}"` : ""}`,
      ),
    ),
  );
  if (site.radii.length > 0) {
    lines.push(
      `Corner radii (most used first): ${site.radii.map((r) => `${r.px}px×${r.count}`).join(", ")}`,
    );
  }
  if (site.shadows.length > 0) lines.push(`Shadows: ${site.shadows.join(" | ")}`);
  lines.push(
    ...section(
      "Buttons",
      site.buttons.map(
        (button) =>
          `- "${button.label}" · bg ${button.background ?? "none"} · text ${button.color ?? "?"} · border ${button.border ?? "none"} · radius ${px(button.radiusPx)} · ${px(button.fontSizePx)}/${button.fontWeight} · padding ${button.padding}${button.shadow ? ` · shadow ${button.shadow}` : ""}`,
      ),
    ),
  );
  if (site.tokens.length > 0) {
    lines.push(
      `Design tokens: ${site.tokens.map((token) => `${token.name}: ${token.value}`).join("; ")}`,
    );
  }
  const { motion } = site;
  const motionBits = [
    motion.durationsMs.length > 0 && `durations ${motion.durationsMs.join("/")}ms`,
    motion.easings.length > 0 && `easing ${motion.easings.join(", ")}`,
    motion.properties.length > 0 && `animates ${motion.properties.join(", ")}`,
    motion.keyframes.length > 0 && `keyframes ${motion.keyframes.join(", ")}`,
  ].filter((bit): bit is string => typeof bit === "string");
  if (motionBits.length > 0) lines.push(`Motion character: ${motionBits.join(" · ")}`);
  if (site.headings.length > 0)
    lines.push(`Headings: ${site.headings.map((h) => `"${h}"`).join(" · ")}`);
  if (site.navLabels.length > 0) lines.push(`Navigation: ${site.navLabels.join(" · ")}`);
  if (site.logos.length > 0) {
    lines.push(
      `Logo candidates: ${site.logos.map((logo) => `${logo.source}${logo.captured ? "" : " (not captured)"}${logo.alt ? ` "${logo.alt}"` : ""}`).join("; ")}`,
    );
  }
  lines.push(...resourceLines(site, fullAccess));
  for (const note of site.notes) lines.push(`Note: ${note}`);
  return lines;
}

/** What the model sees after reading a website: the extracted style as compact text, the saved files, and the screenshots as images. */
export function formatWebsite(
  result: ReadWebsiteResult,
  options: { fullAccess?: boolean } = {},
): HostToolResult {
  const { site, saved, screenshots } = result;
  const lines = styleLines(site, saved?.fonts ?? [], options.fullAccess === true);
  if (saved) {
    lines.push(
      `Saved to the project (website references, license unknown — tell the user): ${saved.dir}/`,
      ...saved.files.map((file) => `- ${file}`),
      saved.logo
        ? `Logo file: ${saved.logo} (use it by this project path).`
        : "No logo file could be captured; build a wordmark from the brand font and colors instead.",
    );
  } else {
    lines.push(
      "Nothing was saved. To use the logo, fonts or screenshots in the video, call read_website again with save: true.",
    );
  }
  lines.push(
    screenshots.length > 0
      ? `Screenshots attached: ${screenshots.map((shot) => `${shot.name} (${shot.width}×${shot.height})`).join(", ")}.`
      : "No screenshots were captured.",
  );
  return {
    text: lines.join("\n"),
    ...(screenshots.length > 0 && {
      images: screenshots.map((shot) => ({ mimeType: shot.mimeType, data: shot.data })),
    }),
  };
}

/** Longest text of a file shown to the model (the server cuts at 200,000 characters; the model needs less). */
const MODEL_TEXT_CHARS = 60_000;

/** How a kind of saved file is used in the project: the model is told instead of guessing. */
function fileUsage(result: WebsiteFileResult): string {
  const path = result.path ?? "";
  const name = result.url.toLowerCase();
  switch (result.kind) {
    case "video":
      return `Use it as video footage: place it on the timeline with edit_timeline (add_clip) at the time it is needed and trim it to the moment.`;
    case "audio":
      return `Use it as an audio clip with edit_timeline (add_clip; set_clip for volume and fades).`;
    case "image":
      return `Use it as a picture clip or inside a composition (${path}).`;
    case "svg":
      return `Use the SVG inline in a composition or as a picture clip (${path}) — it stays sharp at any size.`;
    case "animation":
      return /\.riv(?:$|\?)/.test(name)
        ? `A Rive animation: load it with its runtime in a composition and expose the player so the preview and render can seek it (${path}).`
        : `A Lottie animation: load it with lottie-web in a composition (the file is ${path}), register the player as window.__hfLottie and drive it from the paused GSAP timeline so preview and render seek it.`;
    case "font":
      return `Load it with @font-face in the composition: src: url("${path}").`;
    case "stylesheet":
      return `A style sheet from the site: read it (mode "read") to study its rules, or keep it as a reference for recreating the look.`;
    case "script":
      return `A script from the site: read its text (mode "read") to study how an animation is driven, then recreate it in GSAP; do not ship site scripts in a composition.`;
    default:
      return `A file from the site, saved at ${path}.`;
  }
}

/** What the model sees after `get_website_file`: the file and where it landed, or its raw text. */
export function formatWebsiteFile(result: WebsiteFileResult): string {
  const where = result.finalUrl === result.url ? result.url : `${result.url} → ${result.finalUrl}`;
  const facts = [result.kind, result.mimeType, megabytes(result.bytes)].filter(
    (fact): fact is string => typeof fact === "string" && fact !== "",
  );
  if (result.path !== undefined) {
    return [
      `Downloaded ${result.path} from ${where} (${facts.join(" · ")}).`,
      fileUsage(result),
      "It is a website reference (license unknown — the site's owner keeps the rights; the Sources panel lists it). Never claim a license; tell the user where it came from.",
    ].join("\n");
  }
  const raw = result.text ?? "";
  const cut =
    raw.length > MODEL_TEXT_CHARS
      ? `${raw.slice(0, MODEL_TEXT_CHARS)}\n… (the first ${MODEL_TEXT_CHARS} of ${raw.length} characters are shown${result.truncated ? "; the server cut the file at its read limit" : ""})`
      : raw;
  return [
    `Read ${where} (${facts.join(" · ")})${result.truncated ? " — the server cut the text at its read limit" : ""}:`,
    cut,
    "Use it to study how the page or its animation is built; recreate the motion in the composition with GSAP.",
  ].join("\n");
}

/** What the model sees after `record_website`: the MP4 in the project and how to use it. */
export function formatRecordWebsite(result: RecordWebsiteResult): string {
  const lines = [
    `Recorded ${result.finalUrl} to ${result.path} (${result.width}×${result.height} · ${seconds(result.duration)} · ${megabytes(result.bytes)}).`,
    `It is a video asset in the project (assets/web/<host>/recordings/); place it with edit_timeline as a clip and trim it to the animation you need. License unknown — website content belongs to the site's owner; never claim otherwise, and tell the user where it came from.`,
  ];
  for (const note of result.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
