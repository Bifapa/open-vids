import type {
  ReadWebsiteResult,
  SavedWebsiteFont,
  WebsiteFont,
  WebsiteStyle,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";

const quote = (family: string): string => `"${family.replaceAll('"', "")}"`;

const px = (value: number | null): string =>
  value === null ? "?" : `${Math.round(value * 10) / 10}px`;

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

function styleLines(site: WebsiteStyle, saved: readonly SavedWebsiteFont[]): string[] {
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
  for (const note of site.notes) lines.push(`Note: ${note}`);
  return lines;
}

/** What the model sees after reading a website: the extracted style as compact text, the saved files, and the screenshots as images. */
export function formatWebsite(result: ReadWebsiteResult): HostToolResult {
  const { site, saved, screenshots } = result;
  const lines = styleLines(site, saved?.fonts ?? []);
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
