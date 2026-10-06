import {
  DESIGN_FONT_ROLES,
  DESIGN_FONT_SOURCES,
  DESIGN_LIMITS,
  DESIGN_REQUIRED_TOKENS,
  DESIGN_SOURCE_KINDS,
  DESIGN_TRANSITION_KINDS,
  VIDEO_PALETTE_LIMITS,
  designSystemIdFromName,
  isRecord,
  type AgentId,
  type DesignAction,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult, ToolActivity } from "../backend.js";

export const DESIGN_TOOL_NAMES = {
  list: "list_design_systems",
  read: "read_design_system",
  extract: "extract_project_design",
  palette: "video_palette",
  save: "save_design_system",
  attach: "attach_design_system",
} as const;

export type DesignToolName = (typeof DESIGN_TOOL_NAMES)[keyof typeof DESIGN_TOOL_NAMES];

export function isDesignToolName(name: string): name is DesignToolName {
  return Object.values<string>(DESIGN_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/** The turn the tools are built for: the Design Systems action it runs, if any. */
export interface DesignTurnMode {
  action: DesignAction | null;
}

/**
 * Design Systems tools exist only in design turns (`designAction` create or edit), and only the Director has them: it
 * builds the spec from what the other tools and the specialists (Vision's frames, Research's website reads) report. In
 * any other turn nobody has them; the project's attached system is read from the prompt and the files themselves.
 */
export function designToolsFor(agent: AgentId, turn: DesignTurnMode): DesignToolName[] {
  if (agent !== "director" || turn.action === null) return [];
  return Object.values(DESIGN_TOOL_NAMES);
}

const SYSTEM_MODEL = `A design system is saved in the user's global library as a structured spec; the server renders system.html (a showcase), tokens.css (the same tokens plus @font-face for the stored fonts) and a thumbnail from it, so you never write HTML or CSS files. The spec is: tokens (all ${DESIGN_REQUIRED_TOKENS.length} required ones: ${DESIGN_REQUIRED_TOKENS.join(", ")}; optional extended ones such as --text-sm … --text-4xl, --leading-tight, --shadow-sm/md/lg, --dur-fast, --dur-slow, and custom ones), colorNames (human names of the color tokens), fonts, transitions, motionRules, dos, donts, an optional logo and a one-or-two-sentence summary.`;

const DESCRIPTIONS: Record<DesignToolName, string> = {
  list_design_systems:
    "List the design systems saved in the user's library (id, name, version, where it came from, palette, display font, unknown licenses). Read it before saving to avoid a duplicate, and to find the id of a system to read.",
  read_design_system: `Read one design system of the library in full: its tokens with the color names, fonts (source, weights, license, which are guesses), transitions, motion rules, dos/donts, logo and the guesses its manifest records. Returns the version you must pass as baseVersion when you save a change. Pass version to read an older one. ${SYSTEM_MODEL}`,
  extract_project_design:
    "Read what this project's compositions actually use, counted by a program (no model): every color with its uses and the CSS properties it appeared in, fonts with how the project loads them, easings, durations, corner radii, font sizes, shadows and the tokens already declared. This is the only source of colors, fonts, easings and durations in a `project`-source turn: you group and name them, you never invent a value that is not in this result. In an `external project` turn the same extraction is read from the other project the user chose.",
  video_palette: `Measure the dominant colors of frames sampled across a project video (exact #rrggbb values with their share of the pixels), by a program, no model. Use it for the colors of a \`video\`-source turn; look at a few frames with the Vision tools for everything it cannot measure (fonts and transitions are only ever guesses). Pass video (a project-relative path from inspect_project) unless the user's choice for this turn already names it; samples is ${VIDEO_PALETTE_LIMITS.minSamples}–${VIDEO_PALETTE_LIMITS.maxSamples} (default ${VIDEO_PALETTE_LIMITS.defaultSamples}).`,
  save_design_system: `Save a design system into the user's library: creates it, or saves a new version of an existing one (the previous version is kept). The call is validated before it is sent; if the library refuses the spec (invalid_system) the result lists EVERY problem — fix them all and call again. The result lists what the library did that the user should know: font files downloaded, a system font that is not portable, fonts or a logo with an unknown license. In a \`create\` turn the id is made from the name (or pass id) and the source is the one the user chose; the system must be new (a taken id is a conflict: pick another name) — after your first successful save, further saves in the turn refine that same system. In an \`edit\` turn you save only to the system the user chose, and only after reading it with read_design_system in this turn (the version you read is the baseVersion). Licenses: record a font's or logo's license exactly as found; when it is unknown pass license: null — never invent one. Google Fonts families use source "google" (their files are downloaded and stored), fonts in the project source "file" with projectPath, fonts installed on a machine "system". Anything you guessed (a font or a transition read off a video) gets guess: true. ${SYSTEM_MODEL}`,
  attach_design_system:
    "Attach an existing library system to this project: copies its current version into the project's design/ folder (system.html, tokens.css, fonts, logo, design.json). It never edits a composition: compositions use the system only when they link design/tokens.css, and applying it to them is a separate step the user approves. Only the system saved in this turn (or the one the user chose to edit) may be attached, and only to a project that carries no other system.",
};

// ── Schemas ──────────────────────────────────────────────────────────────────

const str = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength !== undefined && { maxLength }),
});

const licenseSchema = {
  type: ["object", "null"],
  description:
    'The license as found ({name: "SIL OFL 1.1", url}); null when it is unknown (never invent one). A Google Fonts family may use null: the library records its default.',
  properties: {
    name: str("License name.", 120),
    url: str("License page, if known.", 500),
  },
  required: ["name"],
  additionalProperties: false,
};

const fontSchema = {
  type: "object",
  properties: {
    family: str("Plain family name, no quotes.", 80),
    role: { type: "string", enum: [...DESIGN_FONT_ROLES] },
    source: {
      type: "string",
      enum: [...DESIGN_FONT_SOURCES],
      description:
        "google: a Google Fonts family (downloaded on save); file: a font file in the project (projectPath); system: installed on the machine, not stored.",
    },
    weights: {
      type: "array",
      minItems: 1,
      maxItems: 9,
      items: { type: "integer", minimum: 100, maximum: 900 },
    },
    italic: { type: "boolean" },
    projectPath: str("`file` fonts: the project-relative font file.", 500),
    license: licenseSchema,
    guess: { type: "boolean", description: "True when the font is a guess (read off a video)." },
  },
  required: ["family", "role", "source", "weights", "license"],
  additionalProperties: false,
};

const transitionSchema = {
  type: "object",
  properties: {
    name: str("Transition name, e.g. 'Quick fade'.", 60),
    kind: { type: "string", enum: [...DESIGN_TRANSITION_KINDS] },
    durationSec: { type: "number", minimum: 0, maximum: 10 },
    ease: str(
      "A CSS timing function (cubic-bezier(…), ease-out) or a GSAP ease name (power2.out).",
      120,
    ),
    note: str("Where it is used.", DESIGN_LIMITS.ruleChars),
    guess: {
      type: "boolean",
      description: "True when the transition is a guess (read off a video).",
    },
  },
  required: ["name", "kind", "durationSec", "ease"],
  additionalProperties: false,
};

const ruleList = (description: string) => ({
  type: "array",
  maxItems: DESIGN_LIMITS.rules,
  description,
  items: str("One rule.", DESIGN_LIMITS.ruleChars),
});

const specSchema = {
  type: "object",
  description: "The design system's spec.",
  properties: {
    tokens: {
      type: "object",
      description: `CSS custom properties by name (--bg, --brand, …) to a plain CSS value: no ; { } < > url( or comments. All ${DESIGN_REQUIRED_TOKENS.length} required tokens are needed.`,
      properties: Object.fromEntries(
        DESIGN_REQUIRED_TOKENS.map((token) => [
          token,
          str("CSS value.", DESIGN_LIMITS.tokenValueChars),
        ]),
      ),
      required: [...DESIGN_REQUIRED_TOKENS],
      additionalProperties: str("CSS value.", DESIGN_LIMITS.tokenValueChars),
    },
    colorNames: {
      type: "object",
      description: 'Human names of color tokens, e.g. {"--brand": "Sunset orange"}.',
      additionalProperties: str("Plain name.", 60),
    },
    fonts: { type: "array", maxItems: DESIGN_LIMITS.fonts, items: fontSchema },
    transitions: { type: "array", maxItems: DESIGN_LIMITS.transitions, items: transitionSchema },
    motionRules: ruleList("Motion rules, e.g. 'Cuts on the beat; never longer than 0.6 s'."),
    dos: ruleList("What to do."),
    donts: ruleList("What to avoid."),
    logo: {
      type: ["object", "null"],
      description: "The logo: a project-relative image file and its license (null = unknown).",
      properties: {
        projectPath: str("Project-relative png/jpg/svg/webp.", 500),
        license: licenseSchema,
      },
      required: ["projectPath", "license"],
      additionalProperties: false,
    },
    summary: str("What the system is for, one or two sentences.", DESIGN_LIMITS.noteChars),
  },
  required: ["tokens", "fonts", "transitions", "motionRules", "dos", "donts"],
  additionalProperties: false,
};

const PARAMETERS: Record<DesignToolName, Record<string, unknown>> = {
  list_design_systems: { type: "object", properties: {}, additionalProperties: false },
  read_design_system: {
    type: "object",
    properties: {
      id: str("A system id from list_design_systems.", 48),
      version: {
        type: "integer",
        minimum: 1,
        description: "An older version; default the current.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  extract_project_design: { type: "object", properties: {}, additionalProperties: false },
  video_palette: {
    type: "object",
    properties: {
      video: str("Project-relative video path (from inspect_project).", 1_000),
      samples: {
        type: "integer",
        minimum: VIDEO_PALETTE_LIMITS.minSamples,
        maximum: VIDEO_PALETTE_LIMITS.maxSamples,
        description: "How many frames to sample.",
      },
    },
    additionalProperties: false,
  },
  save_design_system: {
    type: "object",
    properties: {
      id: str("Library id (lowercase letters, digits, dashes); default: made from the name.", 48),
      name: str("The system's name.", DESIGN_LIMITS.nameChars),
      source: {
        type: "object",
        description:
          "Where the system came from; the user's choice for the turn decides it, so it can be omitted.",
        properties: {
          kind: { type: "string", enum: [...DESIGN_SOURCE_KINDS] },
          ref: str("A project, a video file, a site's host.", 300),
        },
        required: ["kind"],
        additionalProperties: false,
      },
      baseVersion: {
        type: "integer",
        minimum: 1,
        description:
          "The version read_design_system returned; the runtime fills it in for the system you read.",
      },
      spec: specSchema,
    },
    required: ["name", "spec"],
    additionalProperties: false,
  },
  attach_design_system: {
    type: "object",
    properties: { id: str("The library id of the system to attach.", 48) },
    required: ["id"],
    additionalProperties: false,
  },
};

// ── Activity rows ────────────────────────────────────────────────────────────

const idOf = (args: unknown): string =>
  isRecord(args) && typeof args.id === "string" ? args.id.slice(0, 48) : "";

const ACTIVITIES: Record<DesignToolName, (args: unknown) => ToolActivity> = {
  list_design_systems: () => ({
    category: "inspect",
    label: "Reading the design library",
    labelCode: "listing_design_systems",
  }),
  read_design_system: (args) =>
    idOf(args)
      ? {
          category: "inspect",
          label: `Reading design system ${idOf(args)}`,
          labelCode: "reading_design_system",
          labelParams: { id: idOf(args) },
        }
      : { category: "inspect", label: "Reading a design system" },
  extract_project_design: () => ({
    category: "inspect",
    label: "Reading the project's colors, fonts and motion",
    labelCode: "extracting_project_design",
  }),
  video_palette: () => ({
    category: "inspect",
    label: "Measuring the colors of the video",
    labelCode: "reading_video_palette",
  }),
  save_design_system: (args) => {
    const name = isRecord(args) && typeof args.name === "string" ? args.name.slice(0, 80) : "";
    if (!name) return { category: "edit", label: "Saving the design system" };
    return {
      category: "edit",
      label: `Saving design system ${name}`,
      labelCode: "saving_design_system",
      labelParams: { id: idOf(args) || designSystemIdFromName(name), name },
    };
  },
  attach_design_system: (args) =>
    idOf(args)
      ? {
          category: "edit",
          label: `Attaching design system ${idOf(args)} to the project`,
          labelCode: "attaching_design_system",
          labelParams: { id: idOf(args) },
        }
      : { category: "edit", label: "Attaching a design system to the project" },
};

/** The design tools of one agent; every call goes to `execute` (the running turn's design executor). */
export function buildDesignTools(
  agent: AgentId,
  turn: DesignTurnMode,
  execute: Executor,
): HostTool[] {
  return designToolsFor(agent, turn).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    execute: (args, signal) => execute(name, args, signal),
    activity: (args) => ACTIVITIES[name](args),
  }));
}
