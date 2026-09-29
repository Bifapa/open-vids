import type { AgentModelCatalog } from "@hyperframes/agent-protocol";
import type {
  AgentBackend,
  BackendPromptInput,
  BackendPromptOutcome,
  BackendSession,
  OpenBackendSessionInput,
} from "../backend.js";

export type PromptScript = (input: BackendPromptInput) => Promise<BackendPromptOutcome>;

export class ScriptedAgentBackend implements AgentBackend {
  readonly name = "scripted";
  readonly sessions: ScriptedSession[] = [];
  disposed = false;
  promptScript: PromptScript = async () => "completed";
  steerError: Error | null = null;

  async listModels(): Promise<AgentModelCatalog> {
    return { models: [], defaultModel: null, defaultThinking: null };
  }

  async openSession(input: OpenBackendSessionInput): Promise<BackendSession> {
    const session = new ScriptedSession(input, this);
    this.sessions.push(session);
    return session;
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
    return this.backend.promptScript(input);
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text);
    if (this.backend.steerError) throw this.backend.steerError;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
