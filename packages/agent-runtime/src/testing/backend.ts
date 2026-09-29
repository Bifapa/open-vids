import type { AgentModelCatalog, AgentModelInfo, ProviderInfo } from "@hyperframes/agent-protocol";
import type {
  AgentBackend,
  BackendPromptInput,
  BackendPromptOutcome,
  BackendSession,
  HostToolResult,
  OpenBackendSessionInput,
} from "../backend.js";

/** Scripts one prompt; `session.input.agent` says which agent (director, a specialist, jev) is being prompted. */
export type PromptScript = (
  input: BackendPromptInput,
  session: ScriptedSession,
) => Promise<BackendPromptOutcome>;

export class ScriptedAgentBackend implements AgentBackend {
  readonly name = "scripted";
  readonly sessions: ScriptedSession[] = [];
  disposed = false;
  promptScript: PromptScript = async () => "completed";
  steerError: Error | null = null;
  catalog: AgentModelCatalog = { models: [], defaultModel: null, defaultThinking: null };
  providers: ProviderInfo[] = [];
  providerModels: AgentModelInfo[] = [];

  async listModels(): Promise<AgentModelCatalog> {
    return structuredClone(this.catalog);
  }

  async listProviders(): Promise<ProviderInfo[]> {
    return structuredClone(this.providers);
  }

  async listProviderModels(provider: string): Promise<AgentModelInfo[]> {
    return this.providerModels.filter((model) => model.provider === provider);
  }

  async openSession(input: OpenBackendSessionInput): Promise<BackendSession> {
    const session = new ScriptedSession(input, this);
    this.sessions.push(session);
    return session;
  }

  /** Sessions opened for one agent, oldest first. */
  sessionsOf(agent: OpenBackendSessionInput["agent"]): ScriptedSession[] {
    return this.sessions.filter((session) => session.input.agent === agent);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export class ScriptedSession implements BackendSession {
  readonly prompts: BackendPromptInput[] = [];
  readonly steering: string[] = [];
  disposed = false;

  constructor(
    readonly input: OpenBackendSessionInput,
    private readonly backend: ScriptedAgentBackend,
  ) {}

  prompt(input: BackendPromptInput): Promise<BackendPromptOutcome> {
    this.prompts.push(input);
    return this.backend.promptScript(input, this);
  }

  /** Calls one of the session's host tools the way the model would. */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<HostToolResult> {
    const tool = this.input.hostTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${this.input.agent} has no ${name} tool`);
    return tool.execute(args, signal ?? new AbortController().signal);
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text);
    if (this.backend.steerError) throw this.backend.steerError;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
