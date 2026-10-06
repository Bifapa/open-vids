import {
  DESIGN_EXTENDED_TOKENS,
  DESIGN_REQUIRED_TOKENS,
  type DesignLicense,
  type DesignSystemDetail,
  type DesignSystemSummary,
  type ProjectDesignExtraction,
  type ProjectDesignState,
  type SaveDesignSystemResult,
  type VideoPalette,
} from "@hyperframes/agent-protocol";
import { DesignToolError } from "./host.js";

/** How many entries of each extracted list the model sees (the rest is only counted). */
const LIST_LIMIT = 24;
const COLOR_LIMIT = 40;

const license = (value: DesignLicense | null): string =>
  value ? `${value.name}${value.url ? ` (${value.url})` : ""}` : "unknown";

function capped<T>(items: readonly T[], limit: number, line: (item: T) => string): string[] {
  const shown = items.slice(0, limit).map(line);
  if (items.length > limit) shown.push(`- … and ${items.length - limit} more (not listed)`);
  return shown;
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length > 0 ? [`${title}:`, ...lines] : [];
}

function sourceText(source: DesignSystemSummary["source"]): string {
  return source.ref ? `${source.kind} (${source.ref})` : source.kind;
}

/** One line per library system: enough to pick the one to read or edit. */
export function formatSystemList(systems: readonly DesignSystemSummary[]): string {
  if (systems.length === 0)
    return "The design library is empty: no system has been saved yet (save_design_system creates one).";
  const lines = systems.map(
    (system) =>
      `- ${system.id} · "${system.name}" · version ${system.version} · from ${sourceText(system.source)} · palette ${system.palette.join(" ") || "none"} · display font ${system.displayFont ?? "none"}${system.unknownLicenses.length > 0 ? ` · unknown licenses: ${system.unknownLicenses.join(", ")}` : ""}${system.nonPortableFonts.length > 0 ? ` · system fonts (not portable): ${system.nonPortableFonts.join(", ")}` : ""}`,
  );
  return [`Design systems in the library (${systems.length}, newest first):`, ...lines].join("\n");
}

function tokenLines(tokens: Record<string, string>, colorNames: Record<string, string>): string[] {
  const known = new Set<string>([...DESIGN_REQUIRED_TOKENS, ...DESIGN_EXTENDED_TOKENS]);
  const order = [
    ...DESIGN_REQUIRED_TOKENS,
    ...DESIGN_EXTENDED_TOKENS,
    ...Object.keys(tokens).filter((name) => !known.has(name)),
  ];
  return order.flatMap((name) => {
    const value = tokens[name];
    if (value === undefined) return [];
    const label = colorNames[name];
    return [`- ${name}: ${value}${label ? ` (${label})` : ""}`];
  });
}

/** A saved system as readable text: the spec (what `save_design_system` takes back) plus the manifest's guesses. */
export function formatSystemDetail(detail: DesignSystemDetail): string {
  const { spec, manifest } = detail;
  const colorNames = { ...manifest.colorNames, ...spec.colorNames };
  const lines: string[] = [
    `Design system ${detail.id} — "${detail.name}", version ${detail.version} (from ${sourceText(detail.source)}; baseVersion for an edit: ${detail.version}).`,
  ];
  if (spec.summary) lines.push(`Summary: ${spec.summary}`);
  lines.push(...section("Tokens", tokenLines(spec.tokens, colorNames)));
  lines.push(
    ...section(
      "Fonts",
      spec.fonts.map((font) => {
        const stored = manifest.fonts.find(
          (candidate) => candidate.family === font.family && candidate.role === font.role,
        );
        const where =
          font.source === "file"
            ? ` · file ${font.projectPath ?? "?"}`
            : font.source === "system"
              ? " · installed on the author's machine, not stored (not portable)"
              : stored
                ? ` · ${stored.files.length} stored font files`
                : "";
        return `- ${font.family} · ${font.role} · ${font.source} · weights ${font.weights.join("/")}${font.italic ? " + italic" : ""} · license ${license(font.license)}${font.guess ? " · GUESS (similar font, not exact)" : ""}${where}`;
      }),
    ),
  );
  lines.push(
    ...section(
      "Transitions",
      spec.transitions.map(
        (transition) =>
          `- ${transition.name} · ${transition.kind} · ${transition.durationSec}s · ${transition.ease}${transition.guess ? " · GUESS" : ""}${transition.note ? ` · ${transition.note}` : ""}`,
      ),
    ),
  );
  lines.push(
    ...section(
      "Motion rules",
      spec.motionRules.map((rule) => `- ${rule}`),
    ),
  );
  lines.push(
    ...section(
      "Do",
      spec.dos.map((rule) => `- ${rule}`),
    ),
  );
  lines.push(
    ...section(
      "Don't",
      spec.donts.map((rule) => `- ${rule}`),
    ),
  );
  if (spec.logo)
    lines.push(`Logo: ${spec.logo.projectPath} · license ${license(spec.logo.license)}`);
  else if (manifest.logo)
    lines.push(`Logo: ${manifest.logo.path} · license ${license(manifest.logo.license)}`);
  lines.push(
    ...section(
      "Guesses recorded in the manifest",
      manifest.guesses.map((g) => `- ${g}`),
    ),
  );
  if (detail.unknownLicenses.length > 0)
    lines.push(`Unknown licenses: ${detail.unknownLicenses.join(", ")}`);
  if (detail.nonPortableFonts.length > 0)
    lines.push(`Non-portable system fonts: ${detail.nonPortableFonts.join(", ")}`);
  lines.push(`Versions kept: ${detail.versions.map((entry) => entry.version).join(", ")}`);
  return lines.join("\n");
}

/** The deterministic extraction of a project, compact: every value is exact and counted. */
export function formatExtraction(extraction: ProjectDesignExtraction, title: string): string {
  const lines: string[] = [
    `${title} — ${extraction.files.length} ${extraction.files.length === 1 ? "composition" : "compositions"} scanned${extraction.files.length > 0 ? `: ${extraction.files.slice(0, 6).join(", ")}${extraction.files.length > 6 ? ", …" : ""}` : ""}. Counted by a program; these are the only colors, fonts, easings and durations the project uses.`,
  ];
  lines.push(
    ...section(
      "Colors (hex · uses · where)",
      capped(
        extraction.colors,
        COLOR_LIMIT,
        (color) => `- ${color.value} · ×${color.count} · ${color.roles.join("+") || "other"}`,
      ),
    ),
    ...section(
      "Fonts",
      capped(
        extraction.fonts,
        LIST_LIMIT,
        (font) =>
          `- "${font.family}" · ×${font.count} · weights ${font.weights.join("/") || "default"} · ${font.loading}${font.projectPath ? ` (${font.projectPath})` : ""}`,
      ),
    ),
    ...section(
      "Easings",
      capped(extraction.easings, LIST_LIMIT, (entry) => `- ${entry.value} · ×${entry.count}`),
    ),
    ...section(
      "Durations",
      capped(extraction.durations, LIST_LIMIT, (entry) => `- ${entry.seconds}s · ×${entry.count}`),
    ),
  );
  if (extraction.radii.length > 0)
    lines.push(
      `Corner radii: ${extraction.radii.map((entry) => `${entry.value}×${entry.count}`).join(", ")}`,
    );
  if (extraction.fontSizes.length > 0)
    lines.push(
      `Font sizes: ${extraction.fontSizes
        .slice(0, LIST_LIMIT)
        .map((entry) => `${entry.value}×${entry.count}`)
        .join(", ")}`,
    );
  if (extraction.shadows.length > 0)
    lines.push(`Shadows: ${extraction.shadows.map((entry) => entry.value).join(" | ")}`);
  const declared = Object.entries(extraction.declaredTokens);
  if (declared.length > 0)
    lines.push(
      `Tokens the project already declares: ${declared.map(([name, value]) => `${name}: ${value}`).join("; ")}`,
    );
  return lines.join("\n");
}

export function formatVideoPalette(palette: VideoPalette): string {
  const colors = palette.colors.map(
    (color) => `- ${color.value} · ${Math.round(color.share * 1000) / 10}%`,
  );
  return [
    `Measured palette of ${palette.video} — ${palette.samples} frames sampled across ${Math.round(palette.durationSec * 10) / 10}s, dominant colors most frequent first (exact values, measured from the pixels). Fonts and transitions cannot be measured: they are only guesses from what you see.`,
    ...colors,
  ].join("\n");
}

export function formatSaveResult(result: SaveDesignSystemResult): string {
  const { system } = result;
  const lines = [
    `Saved design system ${system.id} — "${system.name}" as version ${system.version} in the library (palette ${system.palette.join(" ") || "none"}; display font ${system.displayFont ?? "none"}).`,
  ];
  if (result.notes.length > 0)
    lines.push("Notes from the library:", ...result.notes.map((n) => `- ${n}`));
  if (system.unknownLicenses.length > 0)
    lines.push(
      `Unknown licenses (the pre-export check will warn): ${system.unknownLicenses.join(", ")}.`,
    );
  if (system.nonPortableFonts.length > 0)
    lines.push(
      `System fonts that are not stored and may be missing on another machine: ${system.nonPortableFonts.join(", ")}.`,
    );
  return lines.join("\n");
}

export function formatProjectState(state: ProjectDesignState): string {
  const { attached } = state;
  if (!attached) return "This project has no design system attached.";
  return `This project carries design system ${attached.id} — "${attached.name}", version ${attached.version}${state.library ? `; the library holds version ${state.library.version}${state.updateAvailable ? " (an update is available; the user applies it explicitly)" : " (up to date)"}` : "; the system no longer exists in the library"}${state.snapshotOk ? "" : "; its design/ files are damaged or incomplete"}.`;
}

/** A failed design call as the model reads it: the code, the message and, for an invalid system, every issue found. */
export function formatDesignError(error: DesignToolError): string {
  const issues =
    error.issues.length > 0
      ? `\nIssues:\n${error.issues.map((issue) => `- ${issue}`).join("\n")}`
      : "";
  return `${error.code}: ${error.message}${issues}`;
}
