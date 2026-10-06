import { vi, type Mock } from "vitest";
import type {
  AttachedDesign,
  DesignSystemSummary,
  ProjectDesignState,
} from "@hyperframes/agent-protocol";
import { DesignApiError, type DesignClient } from "./designClient";

/** The snapshot's `tokens.css` as the library writes it: the `:root` tokens, then the font faces. */
// The fixture colours are written without their `#`: the colour-literal ratchet only counts real literals.
const [BG, FG, MUTED, BRAND, ACCENT, ACCENT_2] = [
  "0b0b0f",
  "f4f1ea",
  "9a968c",
  "ff6a3d",
  "ffb347",
  "4dd0e1",
].map((digits) => `#${digits}`);

export const TOKENS_CSS = `:root{--bg:${BG};--fg:${FG};--muted:${MUTED};--brand:${BRAND};--accent:${ACCENT};--accent-2:${ACCENT_2};--font-display:"Fraunces", Georgia, serif;--font-body:"Inter", sans-serif;}
@font-face{font-family:"Fraunces";src:url("fonts/fraunces-700-normal-latin-ab12cd34.woff2") format("woff2");}`;

export function designSummary(overrides: Partial<DesignSystemSummary> = {}): DesignSystemSummary {
  return {
    id: "sunset",
    name: "Sunset",
    version: 2,
    source: { kind: "scratch" },
    createdAt: 1000,
    updatedAt: 2000,
    palette: [BG, FG, BRAND, ACCENT, ACCENT_2],
    displayFont: "Fraunces",
    unknownLicenses: [],
    nonPortableFonts: [],
    ...overrides,
  };
}

export function attachedDesign(overrides: Partial<AttachedDesign> = {}): AttachedDesign {
  return {
    schema: "openvids.project-design/1",
    id: "sunset",
    version: 2,
    name: "Sunset",
    attachedAt: 3000,
    unknownLicenses: [],
    nonPortableFonts: [],
    ...overrides,
  };
}

export const NOTHING_ATTACHED: ProjectDesignState = {
  attached: null,
  library: null,
  updateAvailable: false,
  snapshotOk: false,
};

export function attachedState(overrides: Partial<ProjectDesignState> = {}): ProjectDesignState {
  const attached = overrides.attached ?? attachedDesign();
  return {
    attached,
    library: { name: attached.name, version: attached.version },
    updateAvailable: false,
    snapshotOk: true,
    ...overrides,
  };
}

export interface FakeDesignData {
  systems?: DesignSystemSummary[];
  state?: ProjectDesignState;
  tokens?: string;
}

type DesignClientMocks = { [K in keyof DesignClient]: Mock<DesignClient[K]> };

export interface FakeDesign {
  client: DesignClientMocks;
  /** What the server holds changes behind the client's back (another window, an agent turn). */
  serverNow(next: { systems?: DesignSystemSummary[]; state?: ProjectDesignState }): void;
}

/**
 * A design service that remembers what was done to it: attaching, updating and detaching change what the next read
 * answers, as the server's routes do, so a test sees the state the store reads back after a mutation.
 */
export function createFakeDesignClient(data: FakeDesignData = {}): FakeDesign {
  let systems = data.systems ?? [designSummary()];
  let state = data.state ?? NOTHING_ATTACHED;
  const entry = (id: string) => systems.find((system) => system.id === id);
  const client: DesignClientMocks = {
    listLibrary: vi.fn(async (_signal?: AbortSignal) => systems),
    getProject: vi.fn(async (_projectId: string, _signal?: AbortSignal) => state),
    attach: vi.fn(async (_projectId: string, id: string) => {
      const system = entry(id);
      if (!system) throw new DesignApiError("not_found", "That system is gone.", 404);
      state = attachedState({
        attached: attachedDesign({
          id,
          name: system.name,
          version: system.version,
          unknownLicenses: system.unknownLicenses,
          nonPortableFonts: system.nonPortableFonts,
        }),
      });
      return state;
    }),
    update: vi.fn(async (_projectId: string) => {
      const system = state.attached ? entry(state.attached.id) : undefined;
      if (!state.attached || !system) throw new DesignApiError("conflict", "Nothing newer.", 409);
      state = attachedState({ attached: { ...state.attached, version: system.version } });
      return state;
    }),
    detach: vi.fn(async (_projectId: string) => {
      state = NOTHING_ATTACHED;
      return state;
    }),
    snapshotTokens: vi.fn(
      async (_projectId: string, _signal?: AbortSignal) => data.tokens ?? TOKENS_CSS,
    ),
  };
  return {
    client,
    serverNow(next) {
      systems = next.systems ?? systems;
      state = next.state ?? state;
    },
  };
}
