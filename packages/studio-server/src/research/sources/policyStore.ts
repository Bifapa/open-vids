import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ASSET_SEARCH_MODES,
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  isRecord,
  type AddTrustedSourceRequest,
  type AssetSearchMode,
  type AssetSearchPolicy,
  type ResearchMediaKind,
  type TrustedSource,
  type UpdateTrustedSourceRequest,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../../helpers/atomicFile.js";
import { ResearchFailure } from "../errors.js";
import { BUILT_IN_IDS, BUILT_IN_SOURCES } from "./builtins.js";
import { hostMatchesDomains, normalizeDomain } from "./domains.js";

const POLICY_SCHEMA = "openvids.research-policy/1";
const POLICY_FILE = "policy.json";

/** What the user changed about a built-in source (its domains and connector are fixed). */
interface BuiltInOverride {
  enabled: boolean;
  name: string | null;
}

interface StoredPolicy {
  schema: typeof POLICY_SCHEMA;
  mode: AssetSearchMode;
  builtIns: Record<string, BuiltInOverride>;
  userSources: TrustedSource[];
  removedBuiltIns: string[];
  updatedAt: number;
}

export interface PolicyStoreOptions {
  /** Directory of `policy.json`; default `$OPENVIDS_RESEARCH_DIR`, else `~/.openvids/research`. */
  dir?: string;
  now?: () => number;
}

export function defaultResearchDir(): string {
  return process.env.OPENVIDS_RESEARCH_DIR || join(homedir(), ".openvids", "research");
}

const isMode = (value: unknown): value is AssetSearchMode =>
  ASSET_SEARCH_MODES.some((mode) => mode === value);

function kindsOf(value: unknown): ResearchMediaKind[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const kinds: ResearchMediaKind[] = [];
  for (const entry of value) {
    const kind = RESEARCH_MEDIA_KINDS.find((candidate) => candidate === entry);
    if (kind === undefined) return null;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function userSourceOf(value: unknown): TrustedSource | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.startsWith("src-")) return null;
  const kinds = kindsOf(value.kinds);
  if (
    typeof value.name !== "string" ||
    typeof value.enabled !== "boolean" ||
    typeof value.description !== "string" ||
    typeof value.licenseNote !== "string" ||
    !Array.isArray(value.domains) ||
    value.domains.some((domain) => typeof domain !== "string") ||
    kinds === null
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    builtIn: false,
    enabled: value.enabled,
    connector: "site",
    domains: value.domains.filter((domain): domain is string => typeof domain === "string"),
    kinds,
    description: value.description,
    licenseNote: value.licenseNote,
    homepage: typeof value.homepage === "string" ? value.homepage : null,
  };
}

function storedPolicyOf(raw: unknown): StoredPolicy | null {
  if (!isRecord(raw) || raw.schema !== POLICY_SCHEMA || !isMode(raw.mode)) return null;
  if (!isRecord(raw.builtIns) || !Array.isArray(raw.userSources)) return null;
  if (!Array.isArray(raw.removedBuiltIns) || typeof raw.updatedAt !== "number") return null;
  const builtIns: Record<string, BuiltInOverride> = {};
  for (const [id, entry] of Object.entries(raw.builtIns)) {
    if (!BUILT_IN_IDS.includes(id)) continue;
    if (!isRecord(entry) || typeof entry.enabled !== "boolean") return null;
    builtIns[id] = {
      enabled: entry.enabled,
      name: typeof entry.name === "string" ? entry.name : null,
    };
  }
  const userSources: TrustedSource[] = [];
  for (const entry of raw.userSources) {
    const source = userSourceOf(entry);
    if (source === null) return null;
    userSources.push(source);
  }
  return {
    schema: POLICY_SCHEMA,
    mode: raw.mode,
    builtIns,
    userSources,
    removedBuiltIns: raw.removedBuiltIns.filter(
      (id): id is string => typeof id === "string" && BUILT_IN_IDS.includes(id),
    ),
    updatedAt: raw.updatedAt,
  };
}

const textOf = (value: unknown, field: string, max: number, required: boolean): string => {
  if (typeof value !== "string")
    throw new ResearchFailure("invalid_request", `${field} must be text`);
  const text = value.trim();
  if (required && text === "")
    throw new ResearchFailure("invalid_request", `${field} must not be empty`);
  if (text.length > max) {
    throw new ResearchFailure("invalid_request", `${field} exceeds ${max} characters`);
  }
  return text;
};

function domainsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ResearchFailure("invalid_request", "domains must be a non-empty list");
  }
  if (value.length > RESEARCH_LIMITS.domainsPerSource) {
    throw new ResearchFailure(
      "invalid_request",
      `A source has at most ${RESEARCH_LIMITS.domainsPerSource} domains`,
    );
  }
  const domains = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ResearchFailure("invalid_request", "domains must be a list of text");
    }
    domains.add(normalizeDomain(entry));
  }
  return [...domains];
}

function homepageOf(value: unknown): string | null {
  if (value === null) return null;
  const text = textOf(value, "homepage", RESEARCH_LIMITS.urlChars, true);
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    // Fall through to the refusal.
  }
  throw new ResearchFailure("invalid_request", "homepage must be an http(s) address");
}

/**
 * The user's global Asset Search policy: the mode and the list of trusted sources (built-in ones, with what the user
 * enabled/renamed/removed, and their own websites). One small file, replaced atomically; a file that cannot be read is
 * kept as `policy.json.bak` and replaced by the defaults, so a damaged policy can never widen what is allowed.
 */
export class PolicyStore {
  private readonly file: string;
  private readonly now: () => number;

  constructor(options: PolicyStoreOptions = {}) {
    this.file = join(options.dir ?? defaultResearchDir(), POLICY_FILE);
    this.now = options.now ?? Date.now;
  }

  private defaults(): StoredPolicy {
    return {
      schema: POLICY_SCHEMA,
      mode: "trusted",
      builtIns: {},
      userSources: [],
      removedBuiltIns: [],
      updatedAt: 0,
    };
  }

  private load(): StoredPolicy {
    if (!existsSync(this.file)) return this.defaults();
    let parsed: StoredPolicy | null = null;
    try {
      parsed = storedPolicyOf(JSON.parse(readFileSync(this.file, "utf-8")));
    } catch {
      parsed = null;
    }
    if (parsed) return parsed;
    try {
      copyFileSync(this.file, `${this.file}.bak`);
    } catch {
      // Best effort: the defaults are still safe.
    }
    return this.defaults();
  }

  private save(stored: StoredPolicy): AssetSearchPolicy {
    const next: StoredPolicy = { ...stored, updatedAt: this.now() };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    replaceFileAtomically(this.file, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    return this.view(next);
  }

  private view(stored: StoredPolicy): AssetSearchPolicy {
    const builtIns = BUILT_IN_SOURCES.filter(
      (source) => !stored.removedBuiltIns.includes(source.id),
    ).map((source): TrustedSource => {
      const override = stored.builtIns[source.id];
      return {
        ...source,
        domains: [...source.domains],
        kinds: [...source.kinds],
        enabled: override?.enabled ?? source.enabled,
        name: override?.name ?? source.name,
      };
    });
    return {
      mode: stored.mode,
      sources: [...builtIns, ...stored.userSources.map((source) => ({ ...source }))],
      removedBuiltIns: [...stored.removedBuiltIns],
      updatedAt: stored.updatedAt,
    };
  }

  get(): AssetSearchPolicy {
    return this.view(this.load());
  }

  setMode(mode: AssetSearchMode): AssetSearchPolicy {
    if (!isMode(mode)) {
      throw new ResearchFailure(
        "invalid_request",
        `mode must be ${ASSET_SEARCH_MODES.join(" or ")}`,
      );
    }
    return this.save({ ...this.load(), mode });
  }

  addSource(request: AddTrustedSourceRequest): AssetSearchPolicy {
    const stored = this.load();
    const current = this.view(stored);
    if (current.sources.length >= RESEARCH_LIMITS.sources) {
      throw new ResearchFailure(
        "invalid_request",
        `There can be at most ${RESEARCH_LIMITS.sources} trusted sources`,
      );
    }
    const name = textOf(request.name, "name", RESEARCH_LIMITS.nameChars, true);
    const domains = domainsOf(request.domains);
    this.assertFree(current, domains, null);
    const kinds = request.kinds === undefined ? [...RESEARCH_MEDIA_KINDS] : kindsOf(request.kinds);
    if (kinds === null) {
      throw new ResearchFailure(
        "invalid_request",
        `kinds must be a non-empty list of ${RESEARCH_MEDIA_KINDS.join(", ")}`,
      );
    }
    const source: TrustedSource = {
      id: `src-${randomBytes(4).toString("hex")}`,
      name,
      builtIn: false,
      enabled: true,
      connector: "site",
      domains,
      kinds,
      description: `Website ${domains.join(", ")}, searched through the web and read page by page.`,
      licenseNote:
        request.licenseNote === undefined
          ? ""
          : textOf(request.licenseNote, "licenseNote", RESEARCH_LIMITS.noteChars, false),
      homepage:
        request.homepage === undefined
          ? `https://${domains[0] ?? ""}`
          : homepageOf(request.homepage),
    };
    return this.save({ ...stored, userSources: [...stored.userSources, source] });
  }

  updateSource(id: string, request: UpdateTrustedSourceRequest): AssetSearchPolicy {
    const stored = this.load();
    const current = this.view(stored);
    const source = current.sources.find((entry) => entry.id === id);
    if (!source) throw new ResearchFailure("unknown_source", `No trusted source "${id}"`);
    const name =
      request.name === undefined
        ? undefined
        : textOf(request.name, "name", RESEARCH_LIMITS.nameChars, true);
    if (source.builtIn) {
      if (
        request.domains !== undefined ||
        request.kinds !== undefined ||
        request.licenseNote !== undefined
      ) {
        throw new ResearchFailure(
          "invalid_request",
          `${source.name} is a built-in source: only enabled and name can change`,
        );
      }
      const before = stored.builtIns[id];
      const override: BuiltInOverride = {
        enabled: request.enabled ?? before?.enabled ?? source.enabled,
        name: name ?? before?.name ?? null,
      };
      return this.save({ ...stored, builtIns: { ...stored.builtIns, [id]: override } });
    }
    const domains = request.domains === undefined ? undefined : domainsOf(request.domains);
    if (domains) this.assertFree(current, domains, id);
    const kinds = request.kinds === undefined ? undefined : kindsOf(request.kinds);
    if (kinds === null) {
      throw new ResearchFailure(
        "invalid_request",
        `kinds must be a non-empty list of ${RESEARCH_MEDIA_KINDS.join(", ")}`,
      );
    }
    const userSources = stored.userSources.map((entry) =>
      entry.id !== id
        ? entry
        : {
            ...entry,
            enabled: request.enabled ?? entry.enabled,
            name: name ?? entry.name,
            domains: domains ?? entry.domains,
            kinds: kinds ?? entry.kinds,
            licenseNote:
              request.licenseNote === undefined
                ? entry.licenseNote
                : textOf(request.licenseNote, "licenseNote", RESEARCH_LIMITS.noteChars, false),
          },
    );
    return this.save({ ...stored, userSources });
  }

  removeSource(id: string): AssetSearchPolicy {
    const stored = this.load();
    if (BUILT_IN_IDS.includes(id)) {
      if (stored.removedBuiltIns.includes(id)) {
        throw new ResearchFailure("unknown_source", `No trusted source "${id}"`);
      }
      const { [id]: _dropped, ...builtIns } = stored.builtIns;
      return this.save({ ...stored, builtIns, removedBuiltIns: [...stored.removedBuiltIns, id] });
    }
    if (!stored.userSources.some((source) => source.id === id)) {
      throw new ResearchFailure("unknown_source", `No trusted source "${id}"`);
    }
    return this.save({
      ...stored,
      userSources: stored.userSources.filter((source) => source.id !== id),
    });
  }

  /** Brings every removed built-in source back, enabled and under its own name. */
  restoreBuiltIns(): AssetSearchPolicy {
    const stored = this.load();
    const builtIns = { ...stored.builtIns };
    for (const id of stored.removedBuiltIns) delete builtIns[id];
    return this.save({ ...stored, builtIns, removedBuiltIns: [] });
  }

  /** A domain belongs to one source at a time (otherwise the list says nothing about who vouches for a host). */
  private assertFree(policy: AssetSearchPolicy, domains: string[], ignoring: string | null): void {
    for (const source of policy.sources) {
      if (source.id === ignoring) continue;
      const taken = domains.find((domain) => hostMatchesDomains(domain, source.domains));
      if (taken) {
        throw new ResearchFailure(
          "conflict",
          `${taken} already belongs to the source "${source.name}"`,
        );
      }
    }
  }
}
