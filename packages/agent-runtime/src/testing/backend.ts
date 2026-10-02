import type {
  AgentModelCatalog,
  AgentModelInfo,
  ListProvidersResponse,
  OAuthFlow,
  OAuthLoginState,
  ProjectTitleRequest,
  ProviderInfo,
} from "@hyperframes/agent-protocol";
import type {
  AgentBackend,
  BackendPromptInput,
  BackendPromptOutcome,
  BackendSession,
  HostToolResult,
  OpenBackendSessionInput,
  RefreshProvidersOptions,
} from "../backend.js";
import { RuntimeError } from "../errors.js";
import { OAuthLogins, type LoginRunner } from "../oauthLogins.js";

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
  providersSyncedAt: number | null = null;
  /** What each `refreshProviders` call asked for, oldest first. */
  readonly refreshes: RefreshProvidersOptions[] = [];
  /** Runs inside `refreshProviders` (a test changes `providers` as the real backend would after a key change). */
  onRefresh: (options: RefreshProvidersOptions) => void | Promise<void> = () => {};
  providerModels: AgentModelInfo[] = [];
  /** Providers that offer an in-app sign-in; any other is refused the way the real backend refuses it. */
  oauthProviders = new Set<string>();
  /** Runs inside each sign-in the way the SDK's login would (calls `onAuth`, awaits a prompt, resolves or throws). */
  loginRunner: LoginRunner = async () => {};
  /** Runs after a sign-in succeeded (a test updates `providers` as the real backend would). */
  onSignedIn: (provider: string) => void | Promise<void> = () => {};
  /** Runs inside `signOutOAuth`. */
  onSignOut: (provider: string) => void | Promise<void> = () => {};
  readonly logins = new OAuthLogins({
    run: (loginId, controller) => this.loginRunner(loginId, controller),
    onSucceeded: async (provider) => {
      await this.onSignedIn(provider);
    },
    firstStateWaitMs: 50,
  });

  async listModels(): Promise<AgentModelCatalog> {
    return structuredClone(this.catalog);
  }

  /** What `generateProjectTitle` answers: a fixed title, or a script per request (may throw). */
  projectTitle: string | ((input: ProjectTitleRequest) => Promise<string>) = "Scripted Project";
  /** Every title request this backend saw, oldest first. */
  readonly titleRequests: ProjectTitleRequest[] = [];

  async generateProjectTitle(input: ProjectTitleRequest): Promise<string> {
    this.titleRequests.push(structuredClone(input));
    if (typeof this.projectTitle === "string") return this.projectTitle;
    return this.projectTitle(input);
  }

  async listProviders(): Promise<ListProvidersResponse> {
    return { providers: structuredClone(this.providers), syncedAt: this.providersSyncedAt };
  }

  async refreshProviders(options: RefreshProvidersOptions = {}): Promise<ListProvidersResponse> {
    this.refreshes.push(options);
    await this.onRefresh(options);
    return this.listProviders();
  }

  async startOAuthLogin(provider: string, flow?: OAuthFlow): Promise<OAuthLoginState> {
    if (!this.oauthProviders.has(provider))
      throw new RuntimeError("invalid_request", `${provider} has no in-app sign-in.`, 400);
    return this.logins.start({ provider, loginId: `${provider}-login`, flow: flow ?? "browser" });
  }

  getOAuthLogin(id: string): OAuthLoginState {
    return this.logins.get(id);
  }

  submitOAuthLoginInput(id: string, text: string): OAuthLoginState {
    return this.logins.submit(id, text);
  }

  cancelOAuthLogin(id: string): Promise<OAuthLoginState> {
    return this.logins.cancel(id);
  }

  async signOutOAuth(provider: string): Promise<ListProvidersResponse> {
    await this.onSignOut(provider);
    return this.listProviders();
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
    await this.logins.dispose();
  }
}

export class ScriptedSession implements BackendSession {
  readonly prompts: BackendPromptInput[] = [];
  readonly steering: string[] = [];
  disposed = false;
  private toolCalls = 0;

  constructor(
    readonly input: OpenBackendSessionInput,
    private readonly backend: ScriptedAgentBackend,
  ) {}

  prompt(input: BackendPromptInput): Promise<BackendPromptOutcome> {
    this.prompts.push(input);
    return this.backend.promptScript(input, this);
  }

  /**
   * Calls one of the session's host tools the way the model would; a tool that declares an activity also reports
   * tool.start/tool.end on the running prompt, exactly like a real backend adapter.
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<HostToolResult> {
    const tool = this.input.hostTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${this.input.agent} has no ${name} tool`);
    const activity = tool.activity?.(args) ?? null;
    const onEvent = this.prompts.at(-1)?.onEvent;
    const toolCallId = `scripted-call-${(this.toolCalls += 1)}`;
    if (activity && onEvent) {
      onEvent({
        type: "tool.start",
        toolCallId,
        kind: activity.category,
        targets: [],
        label: activity.label,
      });
    }
    let ok = false;
    try {
      const result = await tool.execute(args, signal ?? new AbortController().signal);
      ok = !result.isError;
      return result;
    } finally {
      if (activity && onEvent) onEvent({ type: "tool.end", toolCallId, ok });
    }
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text);
    if (this.backend.steerError) throw this.backend.steerError;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
