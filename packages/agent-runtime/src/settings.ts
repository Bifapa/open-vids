import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
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
  };
}

/**
 * Global agent settings (defaults for new chats and the Jev worker) plus Jev's API key. Both files are private to the
 * user (mode 0600); the key is kept in its own file and never returned through {@link get}.
 */
export class AgentSettingsStore {
  private settings: AgentSettings = defaultAgentSettings();
  private apiKey: string | null = null;
  private loaded: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string = resolveSettingsDir()) {}

  async get(): Promise<AgentSettings> {
    await this.load();
    return structuredClone({
      ...this.settings,
      jev: { ...this.settings.jev, apiKeyConfigured: this.apiKey !== null },
    });
  }

  /** The stored Jev key, for the runtime only. */
  async jevApiKey(): Promise<string | null> {
    await this.load();
    return this.apiKey;
  }

  async update(update: UpdateAgentSettingsRequest): Promise<AgentSettings> {
    await this.serialize(async () => {
      await this.load();
      this.settings = applyUpdate(this.settings, update);
      await this.writePrivate(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
    });
    return this.get();
  }

  async setJevApiKey(apiKey: string | null): Promise<AgentSettings> {
    await this.serialize(async () => {
      await this.load();
      if (apiKey === null) await rm(join(this.dir, CREDENTIALS_FILE), { force: true });
      else await this.writePrivate(CREDENTIALS_FILE, JSON.stringify({ apiKey }));
      this.apiKey = apiKey;
    });
    return this.get();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const stored = await readJson(join(this.dir, SETTINGS_FILE));
      if (stored !== undefined) {
        // Re-validate through the public request parser so a hand-edited or older file cannot inject bad values.
        const parsed = parseUpdateAgentSettings(stored);
        if (parsed.ok) this.settings = applyUpdate(defaultAgentSettings(), parsed.value);
      }
      const credentials = await readJson(join(this.dir, CREDENTIALS_FILE));
      const key =
        typeof credentials === "object" && credentials !== null && "apiKey" in credentials
          ? credentials.apiKey
          : null;
      this.apiKey = typeof key === "string" && key.length > 0 ? key : null;
    })();
    return this.loaded;
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
