import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXECUTION_QUALITY,
  SPECIALIST_IDS,
  parseUpdateAgentSettings,
  type AgentSettings,
  type SpecialistDefaults,
  type SpecialistId,
  type UpdateAgentSettingsRequest,
} from "@hyperframes/agent-protocol";

const SETTINGS_FILE = "settings.json";
const CREDENTIALS_FILE = "jev-credentials.json";

export function defaultAgentSettings(): AgentSettings {
  const specialist = (): SpecialistDefaults => ({
    model: null,
    thinking: null,
    allowedModels: [],
    enabledByDefault: true,
  });
  return {
    director: { model: null, thinking: null },
    specialists: {
      editor: specialist(),
      vision: specialist(),
      motion: specialist(),
      research: specialist(),
      audio: specialist(),
    },
    jev: {
      enabled: false,
      provider: null,
      modelId: null,
      thinking: null,
      credentials: "provider-login",
      apiKeyConfigured: false,
    },
    executionQuality: structuredClone(DEFAULT_EXECUTION_QUALITY),
  };
}

/** The specialists a new chat starts with. */
export function defaultEnabledAgents(settings: AgentSettings): SpecialistId[] {
  return SPECIALIST_IDS.filter((id) => settings.specialists[id].enabledByDefault);
}

/** Where global (per-user) agent settings live: `OPENVIDS_AGENT_SETTINGS_DIR`, else `~/.openvids/agent`. */
export function resolveSettingsDir(): string {
  const configured = process.env.OPENVIDS_AGENT_SETTINGS_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".openvids", "agent");
}

function applyUpdate(current: AgentSettings, update: UpdateAgentSettingsRequest): AgentSettings {
  const specialists = { ...current.specialists };
  for (const id of SPECIALIST_IDS) {
    const next = update.specialists?.[id];
    if (next) specialists[id] = next;
  }
  return {
    director: update.director ?? current.director,
    specialists,
    jev: { ...current.jev, ...update.jev },
    executionQuality: update.executionQuality ?? current.executionQuality,
  };
}

/**
 * Global agent settings (defaults for new chats and the Jev worker) plus Jev's API key. Both files are private to the
 * user (mode 0600); the key is kept in its own file and never returned through {@link get}. The files are tiny and
 * are read from disk on every access, so several runtimes on one machine (desktop app, dev shell) never overwrite
 * each other's changes with a stale copy.
 */
export class AgentSettingsStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string = resolveSettingsDir()) {}

  async get(): Promise<AgentSettings> {
    const [settings, apiKey] = await Promise.all([this.readSettings(), this.jevApiKey()]);
    return { ...settings, jev: { ...settings.jev, apiKeyConfigured: apiKey !== null } };
  }

  /** The stored Jev key, for the runtime only. */
  async jevApiKey(): Promise<string | null> {
    const credentials = await readJson(join(this.dir, CREDENTIALS_FILE));
    const key =
      typeof credentials === "object" && credentials !== null && "apiKey" in credentials
        ? credentials.apiKey
        : null;
    return typeof key === "string" && key.length > 0 ? key : null;
  }

  async update(update: UpdateAgentSettingsRequest): Promise<AgentSettings> {
    await this.serialize(async () => {
      const next = applyUpdate(await this.readSettings(), update);
      await this.writePrivate(SETTINGS_FILE, JSON.stringify(next, null, 2));
    });
    return this.get();
  }

  async setJevApiKey(apiKey: string | null): Promise<AgentSettings> {
    await this.serialize(async () => {
      if (apiKey === null) await rm(join(this.dir, CREDENTIALS_FILE), { force: true });
      else await this.writePrivate(CREDENTIALS_FILE, JSON.stringify({ apiKey }));
    });
    return this.get();
  }

  private async readSettings(): Promise<AgentSettings> {
    const stored = await readJson(join(this.dir, SETTINGS_FILE));
    if (stored === undefined) return defaultAgentSettings();
    // Re-validate through the public request parser so a hand-edited or older file cannot inject bad values.
    const parsed = parseUpdateAgentSettings(stored);
    if (parsed.ok) return applyUpdate(defaultAgentSettings(), parsed.value);
    console.error(`[openvids-agent] ignoring invalid ${SETTINGS_FILE}: ${parsed.message}`);
    return defaultAgentSettings();
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.catch(() => undefined).then(operation);
    this.tail = next;
    return next;
  }

  private async writePrivate(name: string, contents: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, name);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}
