import {
  DESIGN_REQUIRED_TOKENS,
  type AttachedDesign,
  type DesignManifest,
  type DesignSystemDetail,
  type DesignSystemSpec,
  type DesignSystemSummary,
  type ProjectDesignExtraction,
  type ProjectDesignState,
  type SaveDesignSystemRequest,
  type SaveDesignSystemResult,
  type VideoPalette,
} from "@hyperframes/agent-protocol";
import { DesignToolError, type DesignHost, type DesignSnapshot } from "../design/host.js";

/** A complete token set: every required token, so a spec built on it is valid. */
export function sampleTokens(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    "--bg": "#0b0b10",
    "--fg": "#f5f5f7",
    "--muted": "#9a9aa5",
    "--surface": "#15151d",
    "--border": "#2a2a36",
    "--brand": "#ff5a36",
    "--accent": "#ffb347",
    "--accent-2": "#7c5cff",
    "--font-display": '"Space Grotesk", sans-serif',
    "--font-body": '"Inter", sans-serif',
    "--font-mono": "ui-monospace, monospace",
    "--radius": "12px",
    "--space-1": "8px",
    "--space-2": "16px",
    "--space-3": "32px",
    "--dur-beat": "0.4s",
    "--ease-standard": "cubic-bezier(0.4, 0, 0.2, 1)",
    "--ease-emphasis": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  };
  for (const name of DESIGN_REQUIRED_TOKENS) if (!(name in base)) base[name] = "0";
  return { ...base, ...overrides };
}

export function sampleSpec(overrides: Partial<DesignSystemSpec> = {}): DesignSystemSpec {
  return {
    tokens: sampleTokens(),
    colorNames: { "--brand": "Sunset orange" },
    fonts: [
      {
        family: "Space Grotesk",
        role: "display",
        source: "google",
        weights: [500, 700],
        license: null,
      },
    ],
    transitions: [{ name: "Quick fade", kind: "fade", durationSec: 0.3, ease: "power2.out" }],
    motionRules: ["Cuts on the beat."],
    dos: ["Use the brand color for the focal element."],
    donts: ["Never stack two accents."],
    summary: "A bold tech look.",
    ...overrides,
  };
}

export function sampleManifest(overrides: Partial<DesignManifest> = {}): DesignManifest {
  return {
    schema: "openvids.design-system/1",
    version: 1,
    source: { kind: "scratch" },
    fonts: [],
    transitions: [],
    motionRules: [],
    dos: [],
    donts: [],
    logo: null,
    colorNames: {},
    summary: "",
    guesses: [],
    ...overrides,
  };
}

export function summaryOf(
  id: string,
  overrides: Partial<DesignSystemSummary> = {},
): DesignSystemSummary {
  return {
    id,
    name: id,
    version: 1,
    source: { kind: "scratch" },
    createdAt: 1,
    updatedAt: 1,
    palette: ["#0b0b10", "#f5f5f7", "#ff5a36"],
    displayFont: "Space Grotesk",
    unknownLicenses: [],
    nonPortableFonts: [],
    ...overrides,
  };
}

export function systemDetail(
  id: string,
  overrides: Partial<DesignSystemDetail> = {},
): DesignSystemDetail {
  const summary = summaryOf(id, overrides);
  return {
    ...summary,
    spec: sampleSpec(),
    manifest: sampleManifest({ version: summary.version }),
    versions: [{ version: summary.version, createdAt: 1, source: summary.source }],
    files: ["system.html", "tokens.css"],
    ...overrides,
  };
}

export function emptyExtraction(): ProjectDesignExtraction {
  return {
    files: ["index.html"],
    colors: [],
    fonts: [],
    easings: [],
    durations: [],
    radii: [],
    fontSizes: [],
    shadows: [],
    declaredTokens: {},
  };
}

/** The attach record of a project that carries a system (`design/design.json`). */
export function attachedDesign(overrides: Partial<AttachedDesign> = {}): AttachedDesign {
  return {
    schema: "openvids.project-design/1",
    id: "acme",
    version: 2,
    name: "Acme",
    attachedAt: 1,
    unknownLicenses: [],
    nonPortableFonts: [],
    ...overrides,
  };
}

export const NO_DESIGN: ProjectDesignState = {
  attached: null,
  library: null,
  updateAvailable: false,
  snapshotOk: false,
};

/** A recorded save: the id the request went to and the request itself. */
export interface RecordedSave {
  id: string;
  request: SaveDesignSystemRequest;
}

/** An in-memory design host for runtime tests: a library, a project's state and every call recorded. */
export class FakeDesignHost implements DesignHost {
  systems: DesignSystemDetail[] = [];
  extraction: ProjectDesignExtraction = emptyExtraction();
  palette: VideoPalette = { video: "assets/clip.mp4", durationSec: 12, samples: 8, colors: [] };
  state: ProjectDesignState = NO_DESIGN;
  snapshotResult: DesignSnapshot | null = null;
  saveNotes: string[] = [];
  /** The next save rejects with this error. */
  nextSaveError: DesignToolError | null = null;
  /** The next snapshot read rejects (the prompt must still be built). */
  snapshotFails = false;

  readonly saves: RecordedSave[] = [];
  readonly attaches: string[] = [];
  readonly reads: Array<{ id: string; version: number | undefined }> = [];
  readonly paletteCalls: Array<{ video: string; samples: number | undefined }> = [];
  readonly externalCalls: string[] = [];
  extractCalls = 0;

  async list(): Promise<DesignSystemSummary[]> {
    return this.systems.map((system) => structuredClone(system));
  }

  async get(id: string, version: number | undefined): Promise<DesignSystemDetail> {
    this.reads.push({ id, version });
    const found = this.systems.find((system) => system.id === id);
    if (!found) throw new DesignToolError("not_found", `No design system ${id}.`);
    return structuredClone(found);
  }

  async save(id: string, request: SaveDesignSystemRequest): Promise<SaveDesignSystemResult> {
    this.saves.push({ id, request: structuredClone(request) });
    if (this.nextSaveError) {
      const error = this.nextSaveError;
      this.nextSaveError = null;
      throw error;
    }
    const existing = this.systems.find((system) => system.id === id);
    if (request.baseVersion === undefined && existing)
      throw new DesignToolError("conflict", `The id ${id} is taken.`);
    if (request.baseVersion !== undefined && existing && existing.version !== request.baseVersion)
      throw new DesignToolError("conflict", `The current version is ${existing.version}.`);
    if (
      request.baseCreatedAt !== undefined &&
      existing &&
      existing.createdAt !== request.baseCreatedAt
    )
      throw new DesignToolError("conflict", `${id} was deleted and created again meanwhile.`);
    const version = (existing?.version ?? 0) + 1;
    // A change without a name keeps the current one (a rename made meanwhile is not undone).
    const name = request.name ?? existing?.name ?? id;
    const createdAt = existing?.createdAt ?? 1;
    const detail = systemDetail(id, {
      name,
      version,
      createdAt,
      source: request.source,
      spec: request.spec,
    });
    this.systems = [...this.systems.filter((system) => system.id !== id), detail];
    return {
      system: summaryOf(id, { name, version, createdAt, source: request.source }),
      notes: this.saveNotes,
    };
  }

  async extract(): Promise<ProjectDesignExtraction> {
    this.extractCalls += 1;
    return structuredClone(this.extraction);
  }

  async videoPalette(video: string, samples: number | undefined): Promise<VideoPalette> {
    this.paletteCalls.push({ video, samples });
    return { ...structuredClone(this.palette), video };
  }

  async projectState(): Promise<ProjectDesignState> {
    return structuredClone(this.state);
  }

  async snapshot(): Promise<DesignSnapshot> {
    if (this.snapshotFails) throw new DesignToolError("unavailable", "Studio is not reachable.");
    return structuredClone(
      this.snapshotResult ?? { state: this.state, tokens: null, manifest: null },
    );
  }

  async attach(id: string): Promise<ProjectDesignState> {
    this.attaches.push(id);
    const found = this.systems.find((system) => system.id === id);
    if (!found) throw new DesignToolError("not_found", `No design system ${id}.`);
    this.state = {
      attached: {
        schema: "openvids.project-design/1",
        id,
        version: found.version,
        name: found.name,
        attachedAt: 1,
        unknownLicenses: [],
        nonPortableFonts: [],
      },
      library: { name: found.name, version: found.version },
      updateAvailable: false,
      snapshotOk: true,
    };
    return structuredClone(this.state);
  }

  async externalProject(projectKey: string): Promise<ProjectDesignExtraction> {
    this.externalCalls.push(projectKey);
    throw new DesignToolError(
      "unavailable",
      "Reading another project's design is not available yet.",
    );
  }
}
