import type {
  DesignAction,
  DesignActionOptions,
  DesignManifest,
  DesignSourceKind,
  ProjectDesignState,
} from "@hyperframes/agent-protocol";
import type { DesignSnapshot } from "./host.js";

/** What the design-turn block needs to know about the turn's team and tools. */
export interface DesignTurnInput {
  action: DesignAction;
  /** The user's choices for the turn (the source, the system an edit changes, the video, the site, the other project). */
  options: DesignActionOptions | null;
  /** Vision is on in this chat: it looks at frames. Otherwise the Director looks itself (it inherits inspect_frames). */
  visionEnabled: boolean;
  /** The runtime has a research host: `read_website` can be called. */
  websitesAvailable: boolean;
  /** `propose_plan` is offered this turn (the user's plan-approval setting is not `never`). */
  planProposal: boolean;
}

/** Where a design system is applied to compositions: the one rule every agent that writes compositions follows. */
export const TOKENS_LINK = '<link rel="stylesheet" href="design/tokens.css">';

/** The Director's role text when Design Systems is on: design turns, typed requests in ordinary turns, projects that carry a system. */
export const DESIGN_DIRECTOR = `Design systems: the user keeps a global library of design systems (palette, fonts, transitions, rules). A system is saved as a structured spec with save_design_system; the server renders the showcase and tokens.css, you never write them. Saving writes only the library (and attach_design_system, the project's design/ folder): never compositions or the timeline, and applying a system to existing compositions is a separate step the user approves (propose it, never do it silently). Colors come from the source (an extraction or a measurement), never from imagination unless the source is the brief; a font or logo license you do not know is null, never invented; anything read off a video by eye is marked guess: true.
In a design turn (a <design-turn> block, started from the Design dialog) you create a system from the chosen source or edit the chosen one with list_design_systems, read_design_system, extract_project_design (what this project's compositions use, counted by a program), video_palette (measured colors of a video), save_design_system and attach_design_system, under the rules of that block.
In an ordinary turn the same tools answer a typed request such as "make a design system from this project", "attach Sunset to this project" or "make the accent warmer": list_design_systems and read_design_system to find and read systems, attach_design_system for an existing one (never switching a project that already carries another system: that is the user's own action in the Design popover), save_design_system to create from the brief (source scratch) or from this project (source project: call extract_project_design first and use only the colors it lists), or to change a system you read in this turn (on the version you read; leave the name out unless the user renamed it). A system from a video, a website or another project is started by the user from the Design button (Design → Create), never by you: say so instead of building it from memory.
When a project carries a system (a <project-design> block), it is the first source of design truth: use its tokens and fonts in everything you create or delegate, and keep the link to design/tokens.css in the root index.html head.`;

/** The same, for the specialists that write compositions. */
export const DESIGN_SPECIALIST = `Design system: when your task carries a <project-design> block, the project has a design system in design/. Follow it before frame.md or design.md: make sure the root index.html head has ${TOKENS_LINK} (one link in the root document is enough; it also supplies the @font-face rules, so fonts resolve offline), use var(--bg), var(--fg), var(--brand), var(--font-display), var(--dur-beat), var(--ease-standard) and the other tokens instead of hard-coding what the system has, and use the system's transitions. Never recolor or restyle a composition the task does not ask you to change.`;

const COMMON = `This is a Design Systems turn: you make or change a design system of the user's global library and save it with save_design_system as a structured spec (tokens, fonts, transitions, rules). The server renders system.html, tokens.css and the thumbnail from it; you never write those files or any HTML.
- Writes: the library only (save_design_system) and, if useful, the project's design/ folder (attach_design_system). Do NOT change compositions or the timeline in this turn: no edit_timeline, render_video or build_rough_cut, and file writes (edit/write) are refused. Never recolor a composition.
- The 18 required tokens: --bg (page background), --fg (main text), --muted (secondary text), --surface (cards, panels), --border (lines), --brand (the main brand color), --accent and --accent-2 (highlights), --font-display, --font-body, --font-mono (font-family stacks such as "Inter", sans-serif), --radius, --space-1/--space-2/--space-3, --dur-beat (a typical beat, e.g. 0.4s), --ease-standard and --ease-emphasis (CSS timing functions). Add extended tokens (--text-sm … --text-4xl, --leading-*, --shadow-*, --dur-fast, --dur-slow) when the source has them. Token values are plain CSS: no ; { } < > url( or comments.
- colorNames: give every color token a short human name ("Sunset orange"). Transitions get a kind (cut, fade, slide, push, wipe, zoom, blur, custom), a duration in seconds and an ease.
- Licenses: a font's or logo's license is what the source states; when you do not know it, pass license: null — never invent one. Google Fonts families use source "google" (the library downloads and stores them), a font file of the project source "file" with its projectPath, a font installed on a machine source "system" (not stored, not portable). Anything you only guessed gets guess: true.
- If save_design_system is refused (invalid_system), the result lists every problem: fix them all and save again.
- Finish with a short report: the name, id and version saved; anything that is a guess; the notes the save returned (fonts downloaded, system fonts that are not portable, unknown licenses); and that nothing in the compositions changed.`;

const APPLY_OFFERED = `If the user's request also asks to apply the system to the existing compositions: save it (and attach it when they asked) first, and then call propose_plan with the steps of applying it (link design/tokens.css in the root index.html, then replace hard-coded colors, fonts and durations with var(--…) tokens composition by composition) and stop — the user approves it, and it runs as a separate turn.`;

const APPLY_NOT_OFFERED = `If the user's request also asks to apply the system to the existing compositions: save it (and attach it when they asked), say plainly that applying it is a separate step and that they should ask for it in their next message; do not touch the compositions.`;

const SOURCE_RULES: Record<DesignSourceKind, (input: DesignTurnInput) => string> = {
  scratch: () =>
    `Source: the brief. Build from the user's message (mood, industry, references in words): choose a coherent palette, a Google Fonts pairing (a display and a body family, optionally a mono), a motion character and rules. Nothing is measured here, so every choice is a design decision — say it comes from the brief, not from the project. Check list_design_systems first so you do not duplicate a name.`,
  project: () =>
    `Source: this project. extract_project_design is the ONLY source of colors, fonts, easings and durations: call it first. You only GROUP and NAME: assign the extracted colors to the 18 tokens by role (background → --bg, text → --fg, borders → --border, fills/accents → --brand/--accent/--accent-2), name them in colorNames, group easings and durations into named transitions and --dur-beat/--ease-*, and give each font a role. You may not use a hex color that is not in the extraction (a save with one is refused) and you may not invent a font or an easing. Fonts by how the project loads them: "google" → source google; "project_file" → source file with its projectPath; "unresolved" → source system (not portable) unless it is a Google Fonts family. Values the project never uses (spacing, radius) may take sensible defaults — say which. The project's logo file (inspect_project) goes in spec.logo with the license read_sources records for it (null when unknown).`,
  video: (input) =>
    `Source: the video ${input.options?.video ?? "the user chose"}. Colors come from video_palette (measured from the pixels, exact): call it first and use those hexes — never eyeball a color from a frame. Fonts and transitions cannot be measured: ${
      input.visionEnabled
        ? "delegate Vision to look at 4–8 frames of the video with inspect_frames (spread over the video: the opening seconds, a title card if there is one, a mid scene, the end) and to report the lettering it sees (serif or sans, weight, case, spacing) and how scenes change (cut, fade, slide, wipe, zoom) and how long it takes, then wait_for_agents"
        : "look at 4–8 frames of the video yourself with inspect_frames (spread over the video: the opening seconds, a title card if there is one, a mid scene, the end) and judge the lettering and how scenes change"
    }. What you read off frames is a GUESS: give the closest Google Fonts family with guess: true and the transitions you estimate (kind, duration, ease) with guess: true, and tell the user they are guesses they can replace. Never present a guessed font as the video's own.`,
  website: (input) =>
    input.websitesAvailable
      ? `Source: the website ${input.options?.url ?? "the user chose"}. Call read_website with that URL (the user chose it; pass save: true to keep its logo and its self-hosted font files in the project so the library can copy them — a download may ask the user's approval first). The result ends with a DRAFT SPEC mapped by fixed rules from the site's own colors, font families and motion: start from it and keep every hex, font family, duration and easing exact; refine only — name the colors (colorNames), fix roles, write motion rules, dos and donts, and choose the tokens the draft lists as missing from the site's palette. Fonts: Google families → google, saved self-hosted files → file with the saved path, anything else → system. Licenses are what the site states about a font; the site's logo is its trademark: license null unless stated. The site's files are reference material of unknown license: tell the user.`
      : `Source: the website ${input.options?.url ?? "the user chose"}, but reading websites is not available in this turn (Studio's research service did not answer). Say so and stop: do not describe the site from memory.`,
  external_project: () =>
    `Source: another project the user chose. extract_project_design returns THAT project's colors, fonts, easings and durations; the rules of a project source apply (group and name only, no invented hex, font or easing). If the tool says the project is not found or unavailable, tell the user and stop: do not guess the other project's design. Fonts of that project that are files in its folder come back as unresolved (a file of another project cannot be copied into the library): choose the Google family or a system font for them, with license null unless you know it.`,
};

const EDIT_RULES = (options: DesignActionOptions | null): string =>
  `Action: edit the design system ${options?.systemId ?? ""}. Call read_design_system on it first (its version becomes your baseVersion), then apply exactly the user's change coherently: "make the accent warmer" moves --accent and --accent-2 together (and --brand only if asked) and renames their colorNames to match; "bigger titles" changes the --text-* scale. Everything the user did not mention stays exactly as you read it — copy the spec you read (tokens, fonts with their licenses and guess flags, transitions, rules, logo). save_design_system saves a NEW version (the previous one is kept; the user can go back) and only to ${options?.systemId ?? "that system"}. Say what you changed (old → new). A project that carries this system keeps its own copy until the user updates it: say so if the project does.`;

function optionsText(options: DesignActionOptions | null): string {
  if (!options) return "";
  const parts = [
    options.source && `source ${options.source}`,
    options.systemId && `system ${options.systemId}`,
    options.video && `video ${options.video}`,
    options.url && `site ${options.url}`,
    options.projectKey && `project ${options.projectKey}`,
  ].filter((part): part is string => typeof part === "string");
  return parts.length > 0
    ? `Choices of the user for this turn (fixed: you cannot change them): ${parts.join("; ")}.`
    : "";
}

/** The `<design-turn>` block of a turn that runs a design action. */
export function renderDesignTurnBlock(input: DesignTurnInput): string {
  const { action, options } = input;
  const source = options?.source ?? "scratch";
  const body = action === "edit" ? EDIT_RULES(options) : SOURCE_RULES[source](input);
  const apply = input.planProposal ? APPLY_OFFERED : APPLY_NOT_OFFERED;
  const chosen = optionsText(options);
  return `<design-turn action="${action}"${action === "create" ? ` source="${source}"` : ""}>\n${COMMON}\n${body}\n${apply}${chosen ? `\n${chosen}` : ""}\n</design-turn>`;
}

// ── The project's attached system ────────────────────────────────────────────

const VALUE_CHARS = 80;
const RULE_CHARS = 160;
const RULES_SHOWN = 6;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function manifestLines(manifest: DesignManifest): string[] {
  const lines: string[] = [];
  if (manifest.fonts.length > 0)
    lines.push(
      `Fonts: ${manifest.fonts
        .map(
          (font) =>
            `${font.family} (${font.role}, ${font.source}, ${font.weights.join("/")}${font.guess ? ", GUESS" : ""}${font.portable ? "" : ", system font: not portable"})`,
        )
        .join("; ")}`,
    );
  if (manifest.transitions.length > 0)
    lines.push(
      `Transitions: ${manifest.transitions
        .map(
          (transition) =>
            `${transition.name} (${transition.kind}, ${transition.durationSec}s, ${transition.ease}${transition.guess ? ", GUESS" : ""})`,
        )
        .join("; ")}`,
    );
  const rule = (title: string, items: readonly string[]) => {
    if (items.length === 0) return;
    const shown = items.slice(0, RULES_SHOWN).map((item) => clip(item, RULE_CHARS));
    lines.push(
      `${title}: ${shown.join(" | ")}${items.length > RULES_SHOWN ? ` | … ${items.length - RULES_SHOWN} more in design/system.html` : ""}`,
    );
  };
  rule("Motion rules", manifest.motionRules);
  rule("Do", manifest.dos);
  rule("Don't", manifest.donts);
  if (manifest.guesses.length > 0)
    lines.push(`Guessed (not exact): ${manifest.guesses.join("; ")}`);
  return lines;
}

/**
 * The block of a project that carries a design system: the rules every agent that writes compositions follows, plus
 * the tokens and a manifest summary (not the whole showcase; design/system.html is the full source). Null when no
 * system is attached.
 */
export function renderDesignSnapshotBlock(snapshot: DesignSnapshot): string | null {
  const { attached, library, updateAvailable, snapshotOk } = snapshot.state;
  if (!attached) return null;
  const head = `<project-design system="${attached.id}" version="${attached.version}"${updateAvailable ? " update-available" : ""}>`;
  const title = `This project carries the design system "${attached.name}" (${attached.id}, version ${attached.version}) in design/ — the project's first source of design truth, above frame.md and design.md.`;
  if (!snapshotOk)
    return `${head}\n${title} Its files in design/ are damaged or incomplete: do not rely on them, and tell the user the system needs to be attached again.\n</project-design>`;
  const rules = [
    `Link ${TOKENS_LINK} in the <head> of the root index.html (check it; add it when missing — one link in the root document is enough). It also declares the @font-face rules for design/fonts, which is what makes the fonts resolve offline and keeps renders from fetching them; a composition that lacks the link does not see the system.`,
    "Use var(--bg), var(--fg), var(--muted), var(--surface), var(--border), var(--brand), var(--accent), var(--accent-2), var(--font-display), var(--font-body), var(--font-mono), var(--radius), var(--space-1…3), var(--dur-beat) and var(--ease-standard/--ease-emphasis) (and the extended tokens below) instead of hard-coding what the system has; use its fonts and transitions. Never hard-code a color the system already has.",
    "Applying the system to compositions that already exist is the user's call: do not restyle or recolor existing compositions unless the request asks for it.",
  ];
  const tokens = snapshot.tokens
    ? Object.entries(snapshot.tokens)
        .slice(0, 48)
        .map(([name, value]) => `${name}: ${clip(value, VALUE_CHARS)}`)
        .join("; ")
    : null;
  const lines = [
    title,
    ...rules.map((rule) => `- ${rule}`),
    tokens
      ? `Tokens (design/tokens.css): ${tokens}`
      : "Its tokens could not be read: read design/tokens.css.",
    ...(snapshot.manifest ? manifestLines(snapshot.manifest) : []),
  ];
  if (updateAvailable && library)
    lines.push(
      `The library holds version ${library.version}: the user updates the project explicitly (never copy library files yourself).`,
    );
  return `${head}\n${lines.join("\n")}\n</project-design>`;
}

/** One line for `inspect_project`: which system the project carries and whether the library has a newer one. */
export function designInventoryLine(state: ProjectDesignState): string | null {
  const { attached, library, updateAvailable, snapshotOk } = state;
  if (!attached) return null;
  return `Design system: ${attached.id} — "${attached.name}", version ${attached.version}${updateAvailable && library ? ` (the library has version ${library.version}; the user updates it)` : ""}${snapshotOk ? "" : " — design/ is damaged or incomplete"}. Its files are in design/ (system.html, tokens.css).`;
}
