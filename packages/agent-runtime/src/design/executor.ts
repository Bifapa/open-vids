import {
  VIDEO_PALETTE_LIMITS,
  designSystemIdFromName,
  isDesignSystemId,
  isRecord,
  parseSaveDesignSystemRequest,
  type DesignAction,
  type DesignActionOptions,
  type DesignSourceKind,
  type DesignSystemSource,
  type ProjectDesignExtraction,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { errorMessage } from "../errors.js";
import {
  formatDesignError,
  formatExtraction,
  formatProjectState,
  formatSaveResult,
  formatSystemDetail,
  formatSystemList,
  formatVideoPalette,
} from "./format.js";
import { DesignToolError, type DesignHost } from "./host.js";
import { DESIGN_TOOL_NAMES, isDesignToolName, type DesignToolName } from "./tools.js";

export interface TurnDesignOptions {
  host: DesignHost;
  /** The turn's abort signal: aborting the turn aborts every in-flight read. */
  turnSignal: AbortSignal;
  /** The project the turn works in: named on every save so a `file` font or the logo resolves in it. */
  projectId: string;
  /** The design action of the turn; null in an ordinary turn ("free mode": the user asked for a system in words). */
  action: DesignAction | null;
  /** The user's choices for the turn; the tools apply them and the model cannot widen them. */
  options: DesignActionOptions | null;
}

const refuse = (text: string): HostToolResult => ({ text, isError: true });

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args))
    throw new DesignToolError("invalid_request", "arguments must be a JSON object");
  return args;
}

/** Fields where `null` is a real value (an unknown license, no logo); everywhere else models send `null` for "not given". */
const MEANINGFUL_NULL = new Set(["license", "logo"]);

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => entry !== null || MEANINGFUL_NULL.has(key))
      .map(([key, entry]) => [key, withoutNulls(entry)]),
  );
}

function optionalInteger(record: Record<string, unknown>, field: string, min: number, max: number) {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new DesignToolError(
      "invalid_request",
      `${field} must be a whole number from ${min} to ${max}`,
    );
  return value;
}

/** `#rgb`/`#rrggbb`/`#rrggbbaa` written in a token value, normalised to lowercase `#rrggbb[aa]`. */
export function hexColorsIn(value: string): string[] {
  return [...value.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/gi)].map(
    (match) => {
      const digits = (match[1] ?? "").toLowerCase();
      const full =
        digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
      return `#${full}`;
    },
  );
}

/** The host of a website URL without `www.`, for `source.ref`; the URL itself when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The system the turn has saved so far: what `hasSaved` and the plan gate look at. */
interface SavedSystem {
  id: string;
  version: number;
}

/** The current version of a system the turn read or saved: what a change's `baseVersion` and `baseCreatedAt` are. */
interface ReadSystem {
  version: number;
  /** The library entry's `createdAt`: an id deleted and recreated meanwhile is a different lineage. */
  createdAt: number;
  name: string;
  source: DesignSystemSource;
}

/** What a save is made with — decided by the user's choices and the turn's rules, not by the model. */
interface SaveTarget {
  id: string;
  baseVersion: number | undefined;
  baseCreatedAt: number | undefined;
  /** Left to the parser: a change sends it only when it differs from the name that was read. */
  name: unknown;
  source: DesignSystemSource;
  /** A new system (or a refinement of one this turn created): its colors must come from the project's extraction. */
  fromProject: boolean;
  /** A change of a system that already existed. */
  change: boolean;
}

/**
 * The design tools of one running turn, bound to that turn's project, action and the user's choices. Like the story
 * executor it tracks its in-flight calls so {@link shutdown} can stop the turn's design work before the checkpoint
 * transaction closes: a save that already reached the service is awaited to its end, and no new call is accepted
 * afterwards. The user's choices (the source, the system an edit changes, the video, the site, the other project) are
 * enforced here: whatever the model sends for them is checked against, or replaced by, the choice.
 */
export class TurnDesign {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly reads = new Map<string, ReadSystem>();
  private saved: SavedSystem | null = null;
  /** Systems this turn created: refining them keeps the creation's rules. */
  private readonly createdIds = new Set<string>();
  /** Hex colors the turn's extraction listed: a `project` or `external_project` save may only use these. */
  private extractedColors: Set<string> | null = null;
  /** The same colors without alpha: a listed `#rrggbbaa` stands for its opaque `#rrggbb` too. */
  private extractedBases: Set<string> = new Set();

  constructor(private readonly config: TurnDesignOptions) {}

  /** A save succeeded in this turn. */
  hasSaved(): boolean {
    return this.saved !== null;
  }

  /** The library system the turn saved last, if any. */
  savedSystem(): SavedSystem | null {
    return this.saved;
  }

  execute(name: string, args: unknown, callSignal: AbortSignal): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; the design library is closed."));
    if (!isDesignToolName(name)) return Promise.resolve(refuse(`Unknown design tool ${name}.`));
    const signal = AbortSignal.any([callSignal, this.config.turnSignal, this.stop.signal]);
    const call = this.run(name, args, signal).catch((error: unknown): HostToolResult => {
      if (error instanceof DesignToolError) return refuse(formatDesignError(error));
      return refuse(`internal: ${errorMessage(error, "The design call failed")}`);
    });
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /** Stops accepting calls, cancels running reads, and waits for every started call to end. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private source(): DesignSourceKind {
    return this.config.options?.source ?? "scratch";
  }

  private async run(
    name: DesignToolName,
    args: unknown,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    const { host } = this.config;
    switch (name) {
      case DESIGN_TOOL_NAMES.list:
        return { text: formatSystemList(await host.list(signal)) };
      case DESIGN_TOOL_NAMES.read:
        return this.read(args, signal);
      case DESIGN_TOOL_NAMES.extract:
        return this.extract(signal);
      case DESIGN_TOOL_NAMES.palette:
        return this.palette(args, signal);
      case DESIGN_TOOL_NAMES.save:
        return this.save(args, signal);
      case DESIGN_TOOL_NAMES.attach:
        return this.attach(args, signal);
    }
  }

  private async read(args: unknown, signal: AbortSignal): Promise<HostToolResult> {
    const record = argsRecord(withoutNulls(args));
    const id = record.id;
    if (!isDesignSystemId(id))
      throw new DesignToolError(
        "invalid_request",
        "id must be a design system id from list_design_systems",
      );
    const version = optionalInteger(record, "version", 1, 100_000);
    const detail = await this.config.host.get(id, version, signal);
    // Only the current version is what a save builds on: reading an older one leaves the recorded version alone.
    if (version === undefined)
      this.reads.set(id, {
        version: detail.version,
        createdAt: detail.createdAt,
        name: detail.name,
        source: detail.source,
      });
    return { text: formatSystemDetail(detail) };
  }

  private async extract(signal: AbortSignal): Promise<HostToolResult> {
    const { host, options } = this.config;
    let extraction: ProjectDesignExtraction;
    let title: string;
    if (this.source() === "external_project" && options?.projectKey) {
      extraction = await host.externalProject(options.projectKey, signal);
      title = `Design of the project you chose (${options.projectKey})`;
    } else {
      extraction = await host.extract(signal);
      title = "Design of this project";
    }
    this.extractedColors = new Set(extraction.colors.map((color) => color.value.toLowerCase()));
    for (const value of Object.values(extraction.declaredTokens))
      for (const hex of hexColorsIn(value)) this.extractedColors.add(hex);
    this.extractedBases = new Set([...this.extractedColors].map((hex) => hex.slice(0, 7)));
    return { text: formatExtraction(extraction, title) };
  }

  private async palette(args: unknown, signal: AbortSignal): Promise<HostToolResult> {
    if (this.config.action === null)
      return refuse(
        "A system from a video starts from the Design button (Design → Create → From a video): tell the user to use it. In an ordinary message you can build one from the brief or from this project.",
      );
    const record = argsRecord(withoutNulls(args));
    const chosen = this.config.options?.video;
    const asked = typeof record.video === "string" ? record.video.trim() : undefined;
    if (this.source() === "video" && chosen && asked && asked !== chosen)
      return refuse(
        `The user chose ${chosen} as the source of this design system: measure that file (omit video), not ${asked}.`,
      );
    const video = asked ?? chosen;
    if (!video)
      return refuse(
        "Pass video: a project-relative video path (inspect_project lists the project's videos).",
      );
    const samples = optionalInteger(
      record,
      "samples",
      VIDEO_PALETTE_LIMITS.minSamples,
      VIDEO_PALETTE_LIMITS.maxSamples,
    );
    return {
      text: formatVideoPalette(await this.config.host.videoPalette(video, samples, signal)),
    };
  }

  /** A change of a system whose current version the turn read (or saved): on that version, name only if renamed. */
  private changeTarget(
    id: string,
    record: Record<string, unknown>,
    givenBase: unknown,
  ): SaveTarget | HostToolResult {
    const read = this.reads.get(id);
    if (!read)
      return refuse(
        `Read ${id} with read_design_system first: a change is saved on top of the version you read.`,
      );
    if (givenBase !== undefined && givenBase !== read.version)
      return refuse(
        `baseVersion must be ${read.version}, the version of ${id} you read in this turn (omit it to use that). To build on a newer version read the system again.`,
      );
    // A rename made meanwhile must survive: the name goes with the save only when the model changed it.
    const renamed = typeof record.name === "string" && record.name.trim() === read.name;
    return {
      id,
      baseVersion: read.version,
      baseCreatedAt: read.createdAt,
      name: renamed ? undefined : record.name,
      source: read.source,
      fromProject: this.createdIds.has(id),
      change: true,
    };
  }

  private saveTarget(record: Record<string, unknown>): SaveTarget | HostToolResult {
    const { action, options } = this.config;
    const givenId = typeof record.id === "string" ? record.id : undefined;
    const givenBase = record.baseVersion;
    if (givenBase !== undefined && (typeof givenBase !== "number" || !Number.isInteger(givenBase)))
      return refuse(
        "baseVersion must be a whole number (the version read_design_system returned).",
      );
    const given = record.source;
    const named = typeof record.name === "string" ? designSystemIdFromName(record.name) : undefined;
    if (action === "edit") {
      const systemId = options?.systemId;
      if (!systemId) return refuse("This edit turn names no system to change.");
      if (givenId !== undefined && givenId !== systemId)
        return refuse(
          `This turn edits the system ${systemId} the user chose: save to that id (or omit id), not ${givenId}. Saving under another id is a create action the user starts themselves.`,
        );
      return this.changeTarget(systemId, record, givenBase);
    }
    if (action === "create") {
      const kind = this.source();
      if (isRecord(given) && given.kind !== kind)
        return refuse(
          `The user chose "${kind}" as the source of this design system: the source is ${kind}, not ${String(given.kind)}. Omit source or pass kind "${kind}".`,
        );
      if (this.saved) {
        if (givenId !== undefined && givenId !== this.saved.id)
          return refuse(
            `This turn already created ${this.saved.id}: refine that system (omit id) rather than creating another one.`,
          );
        return this.changeTarget(this.saved.id, record, givenBase);
      }
      if (givenBase !== undefined)
        return refuse(
          "A create turn makes a new system: omit baseVersion. Changing an existing system is an edit action the user starts on that system.",
        );
      const ref =
        kind === "video"
          ? options?.video
          : kind === "website"
            ? options?.url && hostOf(options.url)
            : kind === "external_project"
              ? options?.projectKey
              : kind === "project" && isRecord(given) && typeof given.ref === "string"
                ? given.ref
                : undefined;
      return this.newTarget(givenId ?? named ?? "", record, { kind, ...(ref && { ref }) });
    }
    // Free mode: an ordinary turn. A system this turn read (or created) is changed on the version read; anything else
    // is new, from the brief or from this project only.
    const id = givenId ?? named ?? this.saved?.id;
    if (id === undefined) return refuse("Pass id (or name): which system is this?");
    if (this.reads.has(id)) return this.changeTarget(id, record, givenBase);
    if (givenBase !== undefined)
      return refuse(
        `Read ${id} with read_design_system first: a change is saved on top of the version you read. Omit baseVersion to create a new system.`,
      );
    const kind = isRecord(given) ? given.kind : "scratch";
    if (kind !== "scratch" && kind !== "project")
      return refuse(
        `A system from ${typeof kind === "string" ? kind : "that source"} starts from the Design button (Design → Create): tell the user to use it. In an ordinary message you can create a system from the brief (source scratch) or from this project (source project, after extract_project_design).`,
      );
    const ref =
      kind === "project" && isRecord(given) && typeof given.ref === "string"
        ? given.ref
        : undefined;
    return this.newTarget(id, record, { kind, ...(ref && { ref }) });
  }

  private newTarget(
    id: string,
    record: Record<string, unknown>,
    source: DesignSystemSource,
  ): SaveTarget {
    return {
      id,
      baseVersion: undefined,
      baseCreatedAt: undefined,
      name: record.name,
      source,
      fromProject: true,
      change: false,
    };
  }

  /** The colors a `project`/`external_project` save invented: hexes in the spec that its extraction does not hold. */
  private inventedColors(tokens: Record<string, string>): string[] {
    const known = this.extractedColors;
    if (!known) return [];
    const invented = new Set<string>();
    for (const value of Object.values(tokens)) {
      for (const hex of hexColorsIn(value)) {
        // An alpha variant of a color is the same hue, whichever of the two the extraction lists.
        if (!known.has(hex) && !this.extractedBases.has(hex.slice(0, 7))) invented.add(hex);
      }
    }
    return [...invented];
  }

  private async save(args: unknown, signal: AbortSignal): Promise<HostToolResult> {
    const { host, projectId } = this.config;
    const record = argsRecord(withoutNulls(args));
    const target = this.saveTarget(record);
    if ("text" in target) return target;
    const kind = target.source.kind;
    const projectBased = target.fromProject && (kind === "project" || kind === "external_project");
    if (projectBased && this.extractedColors === null)
      return refuse(
        "The colors, fonts, easings and durations of a project-based system come from extract_project_design: call it first and build the spec from its result.",
      );
    const parsed = parseSaveDesignSystemRequest({
      name: target.name,
      source: target.source,
      spec: record.spec,
      ...(target.baseVersion !== undefined && { baseVersion: target.baseVersion }),
      ...(target.baseCreatedAt !== undefined && { baseCreatedAt: target.baseCreatedAt }),
      projectId,
    });
    if (!parsed.ok)
      throw new DesignToolError(parsed.error.code, parsed.error.message, parsed.error.issues);
    if (!isDesignSystemId(target.id))
      return refuse(
        "id must be lowercase letters, digits and dashes (at most 48 characters), or omit it.",
      );
    const invented = projectBased ? this.inventedColors(parsed.value.spec.tokens) : [];
    if (invented.length > 0)
      return refuse(
        `These colors are not in the project's extraction: ${invented.join(", ")}. A system made from a project uses only the colors the project uses — group and name them, never invent one. Replace them with colors from extract_project_design and save again.`,
      );
    let result;
    try {
      result = await host.save(target.id, parsed.value, signal);
    } catch (error) {
      if (error instanceof DesignToolError && error.code === "conflict" && !target.change)
        throw new DesignToolError(
          "conflict",
          `${error.message} If you meant to change the existing system ${target.id}, read it with read_design_system first and save on the version you read; otherwise choose another name.`,
          error.issues,
        );
      throw error;
    }
    this.saved = { id: result.system.id, version: result.system.version };
    if (!target.change) this.createdIds.add(result.system.id);
    this.reads.set(result.system.id, {
      version: result.system.version,
      createdAt: result.system.createdAt,
      name: result.system.name,
      source: result.system.source,
    });
    return { text: formatSaveResult(result) };
  }

  private async attach(args: unknown, signal: AbortSignal): Promise<HostToolResult> {
    const { host, options } = this.config;
    const record = argsRecord(withoutNulls(args));
    const id = record.id;
    if (!isDesignSystemId(id))
      throw new DesignToolError("invalid_request", "id must be a design system id");
    // A design turn attaches only the system it made or edited; in an ordinary turn the user asked for it in words.
    const allowed = [this.saved?.id, options?.systemId].filter(
      (candidate): candidate is string => candidate !== undefined,
    );
    if (this.config.action !== null && !allowed.includes(id))
      return refuse(
        allowed.length === 0
          ? "Save the design system first: only the system this turn saved (or the one the user chose to edit) can be attached. The user picks any other system themselves."
          : `Only ${allowed.join(" or ")} can be attached in this turn; the user picks any other system themselves.`,
      );
    const state = await host.projectState(signal);
    if (state.attached && state.attached.id !== id)
      return refuse(
        `This project already carries "${state.attached.name}" (${state.attached.id}). Switching to another system is the user's decision: tell them it is saved and that they can attach it to the project themselves.`,
      );
    const after = await host.attach(id, signal);
    return {
      text: `${formatProjectState(after)} Nothing in the compositions or the timeline was changed: they use the system only through <link rel="stylesheet" href="design/tokens.css"> in the root index.html, and applying it to existing compositions is a separate step the user approves.`,
    };
  }
}
