import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type {
  BackendEvent,
  BackendPromptInput,
  BackendPromptOutcome,
  BackendSession,
  HostTool,
} from "../backend.ts";
import {
  chooseBackendModel,
  toModelSelection,
  toOmpEffort,
  toProtocolEffort,
  type CatalogServices,
  type OmpModel,
  type OmpThinking,
} from "./catalog.ts";
import { humanReadableError, terminalEventResult, translateOmpEvent } from "./events.ts";
import { MaintenanceRows } from "./maintenance.ts";
import { sameModel } from "./model-mapping.ts";
import { providerFailure } from "./provider-errors.ts";
import { hostToolContent } from "./tool-content.ts";

/**
 * Exposes a runtime host tool to OMP. It is essential (always loaded), and the runtime reports its effects; progress the
 * tool reports (a render) goes out as `tool.progress` of its call.
 */
export function toOmpTool(tool: HostTool, report: (event: BackendEvent) => void): CustomTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    loadMode: "essential",
    async execute(toolCallId, params, _onUpdate, _context, signal) {
      const result = await tool.execute(
        params,
        signal ?? new AbortController().signal,
        (progress, label) =>
          report({ type: "tool.progress", toolCallId, progress, ...(label && { label }) }),
      );
      return {
        content: hostToolContent(result),
        ...(result.isError && { isError: true }),
      };
    },
  };
}

export class OmpBackendSession implements BackendSession {
  private activeTurn: {
    onEvent: BackendPromptInput["onEvent"];
    settle: (outcome: BackendPromptOutcome) => void;
    fail: (error: Error) => void;
    settled: boolean;
    aborted: boolean;
    abort: () => void;
  } | null = null;
  private disposed = false;
  private promptInProgress = false;
  private disposePromise: Promise<void> | null = null;
  private readonly unsubscribe: () => void;
  private readonly maintenance = new MaintenanceRows();

  constructor(
    private readonly session: AgentSession,
    private readonly projectDir: string,
    private readonly services: CatalogServices,
    /** The shared registry, or a session-private one when the session has its own credentials. */
    private readonly registry: ModelRegistry,
    private readonly hostTools: ReadonlyMap<string, HostTool>,
    private readonly onDispose: () => void,
  ) {
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
  }

  /** An event the runtime side produced (host tool progress) for the prompt in flight. */
  report(event: BackendEvent): void {
    const active = this.activeTurn;
    if (!active || active.settled) return;
    try {
      active.onEvent(event);
    } catch {
      // The runtime owns event persistence; a consumer callback must not break the tool.
    }
  }

  private handleEvent(event: unknown): void {
    const active = this.activeTurn;
    if (!active || active.settled) return;

    const translated = [
      ...this.maintenance.translate(event),
      ...[translateOmpEvent(event, this.projectDir, this.hostTools)].flatMap((item) =>
        item ? [this.withContext(item)] : [],
      ),
    ];
    for (const item of translated) {
      try {
        active.onEvent(item);
      } catch {
        // The runtime owns event persistence; a consumer callback must not break OMP's stream.
      }
    }

    const terminal = terminalEventResult(event);
    if (!terminal) return;
    if (active.aborted || terminal.aborted) {
      active.settle("aborted");
    } else if (terminal.error) {
      active.fail(providerFailure(terminal.error, { attempts: this.maintenance.retryCount }));
    } else {
      active.settle("completed");
    }
  }

  /** A usage report gets the context fill the session knows right after the call. */
  private withContext(event: BackendEvent): BackendEvent {
    if (event.type !== "usage") return event;
    let usage: ReturnType<AgentSession["getContextUsage"]>;
    try {
      usage = this.session.getContextUsage();
    } catch {
      return event;
    }
    if (!usage || !Number.isFinite(usage.tokens)) return event;
    const window =
      Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
    return { ...event, context: { tokens: Math.max(0, Math.round(usage.tokens)), window } };
  }

  private resolveModel(selection: BackendPromptInput["model"]): OmpModel {
    const model = selection
      ? this.registry.find(selection.provider, selection.modelId)
      : chooseBackendModel(this.registry, this.services.catalog);
    if (!model || !this.registry.hasConfiguredAuth(model)) {
      if (selection) {
        throw new Error(
          `The selected model ${selection.provider}/${selection.modelId} is not available or has no configured credentials.`,
        );
      }
      throw new Error(
        "No authenticated OMP model is available. Sign in with OMP or configure a provider API key.",
      );
    }
    return model;
  }

  private resolveThinking(input: BackendPromptInput, model: OmpModel): OmpThinking | undefined {
    const requested =
      input.thinking ??
      (sameModel(toModelSelection(model), this.services.catalog.defaultModel)
        ? this.services.catalog.defaultThinking
        : null) ??
      this.services.defaultThinking;
    if (requested === "off") return "off";
    return clampThinkingLevelForModel(model, toOmpEffort(requested));
  }

  async prompt(input: BackendPromptInput): Promise<BackendPromptOutcome> {
    if (this.disposed) throw new Error("The OMP session has been disposed.");
    if (this.promptInProgress) throw new Error("Only one OMP prompt may run per chat at a time.");
    if (input.signal.aborted) return "aborted";
    this.promptInProgress = true;
    this.maintenance.reset();

    let model: OmpModel;
    let thinking: OmpThinking | undefined;
    try {
      model = this.resolveModel(input.model);
      thinking = this.resolveThinking(input, model);
      await this.session.setModel(model, "default", {
        thinkingLevel: thinking === "off" ? undefined : thinking,
        persist: false,
      });
      if (thinking === "off") {
        this.session.agent.setDisableReasoning(true);
      } else {
        this.session.setThinkingLevel(thinking, false);
      }
    } catch (error) {
      this.promptInProgress = false;
      if (this.disposed) return "aborted";
      throw providerFailure(humanReadableError(error));
    }

    if (this.disposed || input.signal.aborted) {
      this.promptInProgress = false;
      return "aborted";
    }
    const resolvedThinking =
      thinking === "off" ? "off" : toProtocolEffort(this.session.thinkingLevel);
    try {
      input.onEvent({
        type: "model.resolved",
        model: toModelSelection(model),
        thinking: resolvedThinking,
      });
    } catch (error) {
      this.promptInProgress = false;
      throw error;
    }
    return new Promise<BackendPromptOutcome>((resolve, reject) => {
      const cleanup = (): void => {
        input.signal.removeEventListener("abort", onSignalAbort);
        if (this.activeTurn === active) this.activeTurn = null;
        this.promptInProgress = false;
      };
      const active = {
        onEvent: input.onEvent,
        settled: false,
        aborted: false,
        settle: (outcome: BackendPromptOutcome): void => {
          if (active.settled) return;
          active.settled = true;
          cleanup();
          resolve(outcome);
        },
        fail: (error: Error): void => {
          if (active.settled) return;
          active.settled = true;
          cleanup();
          reject(error);
        },
        abort: (): void => {
          if (active.settled || active.aborted) return;
          active.aborted = true;
          void this.session
            .abort()
            .catch(() => undefined)
            .finally(() => active.settle("aborted"));
        },
      };
      const onSignalAbort = (): void => active.abort();
      this.activeTurn = active;
      input.signal.addEventListener("abort", onSignalAbort, { once: true });

      if (input.signal.aborted) {
        active.abort();
        return;
      }

      this.session
        .prompt(input.text, { runCommands: false, expandPromptTemplates: false })
        .then((dispatched) => {
          if (!dispatched && !active.settled && !active.aborted && !this.disposed) {
            active.fail(new Error("The OMP session did not dispatch the prompt."));
          }
        })
        .catch((error: unknown) => {
          if (active.settled || active.aborted || this.disposed) return;
          active.fail(
            providerFailure(humanReadableError(error), { attempts: this.maintenance.retryCount }),
          );
        });
    });
  }

  /**
   * Redirects the prompt in flight. A prompt that has not started yet (the model is still being set) or has ended
   * cannot take it: that is refused, and the caller keeps the text for the next prompt instead of losing it here.
   */
  async steer(text: string): Promise<void> {
    if (this.disposed) throw new Error("The OMP session has been disposed.");
    if (!this.activeTurn) throw new Error("The agent is not working on a prompt right now.");
    try {
      await this.session.steer(text);
    } catch (error) {
      throw new Error(humanReadableError(error), { cause: error });
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.session.beginDispose();
    const active = this.activeTurn;
    if (active) active.aborted = true;
    this.disposePromise = this.session.dispose().finally(() => {
      if (active) active.settle("aborted");
      this.promptInProgress = false;
      this.unsubscribe();
      this.onDispose();
    });
    return this.disposePromise;
  }
}
