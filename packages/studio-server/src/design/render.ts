import {
  type DesignLicense,
  type DesignManifest,
  type DesignManifestFont,
  type DesignManifestLogo,
  type DesignSystemSource,
  type DesignSystemSpec,
} from "@hyperframes/agent-protocol";
import { MANIFEST_ELEMENT_ID } from "./manifest.js";
import { fontFaceCss, rootBlock, showcaseCss, tokensCssFile } from "./renderCss.js";
import { renderThumbnail } from "./thumbnail.js";

export interface RenderDesignInput {
  /** The author's tokens, colour names, transitions, rules and summary; its `fonts` are replaced by `fonts` below. */
  spec: DesignSystemSpec;
  /** The fonts as the library resolved them (files, portable). */
  fonts: DesignManifestFont[];
  logo: DesignManifestLogo | null;
  version: number;
  source: DesignSystemSource;
}

export interface RenderedDesignSystem {
  systemHtml: string;
  tokensCss: string;
  thumbnailSvg: string;
}

/** Text in an HTML text node or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The manifest as stored: everything the showcase and the agents need that is not a token. */
export function buildDesignManifest(input: RenderDesignInput): DesignManifest {
  const { spec } = input;
  const guesses = [
    ...input.fonts
      .filter((font) => font.guess)
      .map(
        (font) =>
          `Font "${font.family}" (${font.role}) is a guess: a similar font, not a confirmed one.`,
      ),
    ...spec.transitions
      .filter((transition) => transition.guess)
      .map((transition) => `Transition "${transition.name}" is a guess read off a video.`),
  ];
  return {
    schema: "openvids.design-system/1",
    version: input.version,
    source: input.source,
    fonts: input.fonts,
    transitions: spec.transitions,
    motionRules: spec.motionRules,
    dos: spec.dos,
    donts: spec.donts,
    logo: input.logo,
    colorNames: spec.colorNames ?? {},
    summary: spec.summary ?? "",
    guesses,
  };
}

/** JSON that can sit inside a `<script>` block: `<` and friends never appear raw, so nothing can close it. */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const COLOR_TOKENS = [
  "--bg",
  "--fg",
  "--muted",
  "--surface",
  "--border",
  "--brand",
  "--accent",
  "--accent-2",
];

function licenseText(license: DesignLicense | null): string {
  if (license === null) return "License unknown";
  return license.url ? `${license.name} (${license.url})` : license.name;
}

function palette(spec: DesignSystemSpec, colorNames: Record<string, string>): string {
  const names = [
    ...COLOR_TOKENS,
    ...Object.keys(colorNames).filter((name) => !COLOR_TOKENS.includes(name)),
  ].filter((name) => spec.tokens[name] !== undefined);
  return names
    .map((name) => {
      const label = colorNames[name];
      return `<div class="ov-swatch"><div class="ov-swatch-chip" style="background: var(${name})"></div><div class="ov-swatch-meta">${
        label ? `<strong>${escapeHtml(label)}</strong>` : ""
      }<code>${escapeHtml(name)}</code><code>${escapeHtml(spec.tokens[name] ?? "")}</code></div></div>`;
    })
    .join("\n");
}

function list(items: string[], empty: string): string {
  if (items.length === 0) return `<p class="ov-muted">${escapeHtml(empty)}</p>`;
  return `<ul class="ov-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function fontSection(fonts: DesignManifestFont[]): string {
  if (fonts.length === 0) return `<p class="ov-muted">No fonts are defined.</p>`;
  return fonts
    .map((font, index) => {
      const tags = [
        `<span class="ov-tag">${escapeHtml(font.role)}</span>`,
        font.guess ? `<span class="ov-tag ov-warn">similar (guess)</span>` : "",
        font.portable ? "" : `<span class="ov-tag ov-warn">system font: not portable</span>`,
        font.license === null ? `<span class="ov-tag ov-warn">license unknown</span>` : "",
      ].join(" ");
      const samples = font.weights
        .map(
          (weight) =>
            `<div class="ov-font-sample ov-font-${index}" style="font-weight: ${weight}${
              font.italic ? "; font-style: italic" : ""
            }">Aa ${weight} — The quick brown fox jumps over the lazy dog</div>`,
        )
        .join("\n");
      return `<div class="ov-font">${samples}<div><strong>${escapeHtml(font.family)}</strong> ${tags}</div><div class="ov-muted"><code>${escapeHtml(
        font.source,
      )}</code> · weights ${escapeHtml(font.weights.join(", "))}${font.italic ? " · italic" : ""} · ${escapeHtml(
        licenseText(font.license),
      )}${font.projectPath ? ` · from ${escapeHtml(font.projectPath)}` : ""}</div></div>`;
    })
    .join("\n");
}

function transitionSection(manifest: DesignManifest): string {
  if (manifest.transitions.length === 0)
    return `<p class="ov-muted">No transitions are defined.</p>`;
  return manifest.transitions
    .map(
      (transition, index) =>
        `<div class="ov-trans"><div class="ov-stage"><div class="ov-mover ov-anim-${index}"></div></div><div><strong>${escapeHtml(
          transition.name,
        )}</strong> <span class="ov-tag">${escapeHtml(transition.kind)}</span>${
          transition.guess ? ` <span class="ov-tag ov-warn">guess</span>` : ""
        }<div class="ov-muted">${escapeHtml(String(transition.durationSec))} s · ease <code>${escapeHtml(
          transition.ease,
        )}</code></div>${transition.note ? `<p>${escapeHtml(transition.note)}</p>` : ""}</div></div>`,
    )
    .join("\n");
}

/**
 * Renders the three generated files of a version. The showcase is plain HTML + CSS (no script besides the data block);
 * every text is escaped and every token value re-checked, so the output passes `validateDesignSystemHtml`.
 */
export function renderDesignSystem(input: RenderDesignInput): RenderedDesignSystem {
  const manifest = buildDesignManifest(input);
  const { spec } = input;
  const faces = fontFaceCss(input.fonts);
  const sourceText = `${manifest.source.kind}${manifest.source.ref ? `: ${manifest.source.ref}` : ""}`;
  const logo = manifest.logo
    ? `<div class="ov-section"><h2>Logo</h2><img class="ov-logo" src="${escapeHtml(manifest.logo.path)}" alt="Logo"><p class="ov-muted">${escapeHtml(
        licenseText(manifest.logo.license),
      )}</p></div>`
    : "";
  const guesses =
    manifest.guesses.length > 0
      ? `<div class="ov-section"><h2>Guessed, not confirmed</h2>${list(manifest.guesses, "")}</div>`
      : "";

  const systemHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design system</title>
<style id="openvids-tokens">
${rootBlock(spec.tokens)}${faces ? `\n${faces}` : ""}
</style>
<style id="openvids-showcase">
${showcaseCss(
  manifest.transitions,
  manifest.fonts.map((font) => font.family),
)}
</style>
</head>
<body>
<main class="ov-page">
<header>
<h1>Design system</h1>
<p class="ov-muted">Version ${manifest.version} · source ${escapeHtml(sourceText)}</p>
${manifest.summary ? `<p>${escapeHtml(manifest.summary)}</p>` : ""}
</header>
<section class="ov-section"><h2>Palette</h2><div class="ov-palette">
${palette(spec, manifest.colorNames)}
</div></section>
<section class="ov-section"><h2>Type</h2><div class="ov-scale">
<div class="ov-s4">Display heading</div>
<div class="ov-s3">Section heading</div>
<div class="ov-s2">Subheading</div>
<div class="ov-s1">Small heading</div>
<p class="ov-body-lg">Large body: the quick brown fox jumps over the lazy dog.</p>
<p class="ov-body">Body text: the quick brown fox jumps over the lazy dog. 0123456789</p>
<p class="ov-body-sm">Caption: the quick brown fox jumps over the lazy dog.</p>
<p class="ov-mono">Mono: const beat = 0.5; // 120 bpm</p>
</div></section>
<section class="ov-section"><h2>Samples</h2><div class="ov-cards">
<div class="ov-card ov-title-card"><span class="ov-kicker">Chapter one</span><div class="ov-bar"></div><div class="ov-big">Your title goes here</div><div class="ov-sub">A supporting line in the body font</div></div>
<div class="ov-card ov-stage-card"><div class="ov-lower"><div class="ov-lower-name">Name Surname</div><div class="ov-lower-role">Role · Company</div></div></div>
</div></section>
<section class="ov-section"><h2>Shape and spacing</h2><div class="ov-shapes">
<div class="ov-shape"></div><div style="width: var(--space-1); height: var(--space-1); background: var(--accent)"></div><div style="width: var(--space-2); height: var(--space-2); background: var(--accent)"></div><div style="width: var(--space-3); height: var(--space-3); background: var(--accent)"></div>
</div></section>
<section class="ov-section"><h2>Fonts</h2>
${fontSection(manifest.fonts)}
</section>
<section class="ov-section"><h2>Transitions</h2>
${transitionSection(manifest)}
</section>
<section class="ov-section"><h2>Motion rules</h2>
${list(manifest.motionRules, "No motion rules are defined.")}
</section>
<section class="ov-section ov-cols"><div><h2>Do</h2>${list(manifest.dos, "Nothing listed.")}</div><div><h2>Don't</h2>${list(
    manifest.donts,
    "Nothing listed.",
  )}</div></section>
${logo}
${guesses}
</main>
<script type="application/json" id="${MANIFEST_ELEMENT_ID}">
${embeddedJson(manifest)}
</script>
</body>
</html>
`;

  return {
    systemHtml,
    tokensCss: tokensCssFile(spec.tokens, input.fonts, input.version),
    thumbnailSvg: renderThumbnail(spec.tokens, input.fonts),
  };
}
