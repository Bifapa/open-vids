import { dirname, join } from "node:path";
import type { AgentId, StartTurnRequest } from "@hyperframes/agent-protocol";
import type { TurnAgentSetup } from "../agents/orchestrator.js";
import type { ToolAvailability } from "../agents/tools.js";
import { TurnAnalysis } from "../analysis/executor.js";
import { TurnDesign } from "../design/executor.js";
import type { DesignHost } from "../design/host.js";
import { designInventoryLine, renderDesignSnapshotBlock } from "../design/prompt.js";
import { TurnEditing } from "../editing/executor.js";
import { TurnCrossProject } from "../crossProject/executor.js";
import type { EditingHost } from "../editing/host.js";
import { TurnFrames } from "../editing/frames.executor.js";
import { PermissionBroker } from "../permissions.js";
import { TurnQa } from "../qa/executor.js";
import { QuestionBroker } from "../questions.js";
import { TurnResearch } from "../research/executor.js";
import type { ResearchHost } from "../research/host.js";
import type { ResearchAccess } from "../research/tools.js";
import { TurnStory } from "../story/executor.js";
import type { ActiveRun, TurnContext } from "./context.js";
import { planProposalOffered, storyOfferOpen } from "./gates.js";
import { VoiceBroker } from "../voice/broker.js";
import { TurnVoice } from "../voice/executor.js";

/** What the turn's executors were opened with, for the modules that build prompts and tool lists from them. */
export interface TurnTools {
  editingHost: EditingHost | null;
  researchHost: ResearchHost | null;
  researchAccess: ResearchAccess;
  availability: ToolAvailability;
}

/** The block that states the project's attached design system; null when none is attached or Studio cannot say. */
async function designSnapshotBlock(host: DesignHost, signal: AbortSignal): Promise<string | null> {
  try {
    const snapshot = await host.snapshot(signal);
    return renderDesignSnapshotBlock(snapshot);
  } catch {
    return null;
  }
}

/** The path of a chat's derived website-resource file: the chat's own directory, beside its backend state. */
export async function websiteResourceFile(ctx: TurnContext, chatId: string): Promise<string> {
  return join(dirname(await ctx.store.stateDir(chatId)), "website-resources.json");
}

function userTexts(ctx: TurnContext, chatId: string, turnId?: string): string[] {
  const messages = ctx.chats.get(chatId)?.messages ?? [];
  return messages.flatMap((message) =>
    message.role === "user" && (turnId === undefined || message.turnId === turnId)
      ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
}

/** The model that runs an agent now (`provider/modelId`), recorded in the provenance of what it imports. */
function modelOf(run: ActiveRun, setup: TurnAgentSetup, agent: AgentId): string | null {
  if (agent === "director" || agent === "jev") {
    const model = run.turn.model;
    return model ? `${model.provider}/${model.modelId}` : null;
  }
  const running = run.orchestrator?.modelOf(agent);
  if (running) return running;
  const configured = setup.specialists[agent].model;
  return configured ? `${configured.provider}/${configured.modelId}` : null;
}

/**
 * Opens the services of the turn: the editing, frames, analysis, story, research and QA executors, the permission and
 * question brokers, and the tool availability the sessions are built from. Reads the user's Asset Search policy (fails
 * closed: research tools are offered, and the call itself says the policy could not be read).
 */
export async function openTurnTools(
  ctx: TurnContext,
  run: ActiveRun,
  setup: TurnAgentSetup,
  input: StartTurnRequest,
): Promise<TurnTools> {
  const signal = run.controller.signal;
  const scope = ctx.chats.scope;
  const { options } = ctx;
  const editingHost = options.editing ? options.editing(scope) : null;
  const researchHost = options.research ? options.research(scope) : null;
  const qa =
    options.qa && editingHost ? new TurnQa({ host: options.qa(scope), turnSignal: signal }) : null;
  run.qa = qa;
  // The user's Asset Search policy decides what Research may do and whether full access to the sites the user links is
  // offered; it is read whenever a research host exists (the Director and Motion read websites even with Research
  // off). When Studio cannot say, research calls fail closed and the website tools stay read-only.
  if (researchHost) {
    const policy = await researchHost.policy(signal).catch(() => null);
    setup.research = policy
      ? { status: "ready", policy }
      : { status: "unavailable", reason: "Studio's research service did not answer" };
  }
  const researchAccess: ResearchAccess = {
    assets: researchHost !== null,
    websites: researchHost !== null,
    websiteFiles:
      researchHost !== null &&
      setup.research?.status === "ready" &&
      setup.research.policy.websites.readLinkedPages &&
      setup.research.policy.websites.fullAccess,
  };
  const websiteSettings =
    setup.research?.status === "ready"
      ? {
          readLinkedPages: setup.research.policy.websites.readLinkedPages,
          fullAccess: setup.research.policy.websites.fullAccess,
        }
      : null;
  // A website tool whose setting is off, a download that is not approved yet and a long render ask the user from the
  // chat: the card lives in the main message of the turn, whatever agent asked.
  run.permissions = researchHost
    ? new PermissionBroker({
        turnId: run.turn.id,
        host: researchHost,
        publish: (permission) =>
          ctx.chats
            .emit(run.chatId, {
              type: "permission.updated",
              messageId: run.assistantMessage.id,
              permission,
            })
            .then(() => undefined),
        signal,
        // "Don't ask again" on a download card switches the global agent setting off.
        disableDownloadAsk: async (answerSignal) => {
          answerSignal.throwIfAborted();
          await ctx.settings.update({ autonomy: { askBeforeDownloads: false } });
        },
        now: ctx.now,
        ids: ctx.ids,
      })
    : null;
  run.questions = new QuestionBroker({
    publish: (question) =>
      ctx.chats
        .emit(run.chatId, {
          type: "question.updated",
          messageId: run.assistantMessage.id,
          question,
        })
        .then(() => undefined),
    signal,
    now: ctx.now,
    ids: ctx.ids,
  });
  const permissions = run.permissions;
  const designHost = options.design ? options.design(scope) : null;
  // The site the user chose for a website design source counts as linked in this turn (they gave it in the dialog).
  const designUrl = run.designOptions?.url;
  const withDesignUrl = (texts: string[]): string[] => (designUrl ? [...texts, designUrl] : texts);
  // Every agent that writes compositions is told about the system the project carries (see design/prompt.ts).
  setup.designBlock = designHost ? await designSnapshotBlock(designHost, signal) : null;
  run.editing =
    options.editing && editingHost
      ? new TurnEditing({
          host: editingHost,
          editorContext: setup.editorContext,
          turnSignal: signal,
          userRequests: [input.prompt],
          turnId: run.turn.id,
          leases: ctx.leases,
          runIdOf: (agent) =>
            agent === "director" ? null : (run.orchestrator?.runIdOf(agent) ?? null),
          // The canvas is set: the chat no longer needs the format decided before the next build.
          onCanvasSet: () => void ctx.chats.setCanvasAuto(run.chatId, false).catch(() => undefined),
          ...(researchHost && { research: researchHost }),
          fingerprint: qa
            ? (callSignal) => qa.fingerprint(callSignal).catch(() => null)
            : undefined,
          askLongRender: permissions
            ? async ({ composition, seconds, caller }, callSignal) => {
                const answer = await permissions.ask(
                  {
                    kind: "long_render",
                    action: "render",
                    site: null,
                    agent: caller,
                    render: { composition, seconds: Math.round(seconds) },
                  },
                  callSignal,
                );
                return answer.state === "allowed_once" || answer.state === "enabled";
              }
            : undefined,
          ...(designHost && {
            designLine: async (callSignal: AbortSignal) => {
              try {
                return designInventoryLine(await designHost.projectState(callSignal));
              } catch {
                return null;
              }
            },
          }),
        })
      : null;
  run.frames = options.frames
    ? new TurnFrames({
        host: options.frames(scope),
        turnSignal: signal,
        frameBudget: setup.execution.budget.analysisFramesPerSource,
      })
    : null;
  run.analysis = options.analysis
    ? new TurnAnalysis({
        host: options.analysis(scope),
        editing: editingHost,
        turnSignal: signal,
        turnId: run.turn.id,
        framesPerSource: setup.execution.budget.analysisFramesPerSource,
        projectDir: scope.projectDir,
        ...(options.analysisPollMs !== undefined && { pollMs: options.analysisPollMs }),
      })
    : null;
  run.story = options.story
    ? new TurnStory({
        host: options.story(scope),
        turnId: run.turn.id,
        turnSignal: signal,
        storyOptions: run.storyOptions,
      })
    : null;
  run.design = designHost
    ? new TurnDesign({
        host: designHost,
        turnSignal: signal,
        projectId: scope.projectId,
        action: run.designAction,
        options: run.designOptions,
      })
    : null;
  // Voiceover: the cards live in the main message of the turn, whatever agent asked, like questions and permissions.
  const voiceHost = options.voice ? options.voice(scope) : null;
  run.voice = voiceHost
    ? new TurnVoice({
        host: voiceHost,
        turnId: run.turn.id,
        turnSignal: signal,
        enabled: setup.enabled,
        permissions,
        broker: new VoiceBroker({
          getPreset: (id, answerSignal) => voiceHost.getPreset(id, answerSignal),
          publishSetup: (voiceSetup) =>
            ctx.chats
              .emit(run.chatId, {
                type: "voiceSetup.updated",
                messageId: run.assistantMessage.id,
                setup: voiceSetup,
              })
              .then(() => undefined),
          publishPilot: (pilot) =>
            ctx.chats
              .emit(run.chatId, {
                type: "voicePilot.updated",
                messageId: run.assistantMessage.id,
                pilot,
              })
              .then(() => undefined),
          signal,
          now: ctx.now,
          ids: ctx.ids,
        }),
      })
    : null;
  run.research = researchHost
    ? new TurnResearch({
        host: researchHost,
        turnId: run.turn.id,
        turnSignal: signal,
        enabled: setup.enabled,
        turn: { mode: run.mode, action: run.storyAction },
        storyOptions: run.storyOptions,
        intent: run.intent,
        access: researchAccess,
        websiteSettings,
        permissions: run.permissions,
        websites: { chatId: run.chatId, resources: ctx.websiteResources },
        userTexts: () => withDesignUrl(userTexts(ctx, run.chatId)),
        turnUserTexts: () => withDesignUrl(userTexts(ctx, run.chatId, run.turn.id)),
        excludedSites: () => ctx.chats.get(run.chatId)?.chat.excludedSites ?? [],
        askBeforeDownloads: setup.autonomy.askBeforeDownloads,
        storyBuilt: () => run.story?.hasBuilt() ?? false,
        model: (agent) => modelOf(run, setup, agent),
        designDraft: run.designAction === "create" && run.designOptions?.source === "website",
      })
    : null;
  run.crossProject = options.crossProject
    ? new TurnCrossProject({
        host: options.crossProject(scope),
        turnId: run.turn.id,
        turnSignal: signal,
        enabled: setup.enabled,
        turn: { mode: run.mode, action: run.storyAction },
        messages: () => ctx.chats.get(run.chatId)?.messages ?? [],
        model: (agent) => modelOf(run, setup, agent),
      })
    : null;
  // The tool is bound to a session when it opens, so it is offered only when some attached project has files by now;
  // files attached by steering later in a turn that began with none are readable in the prompt but imported from the
  // next turn on.
  run.crossProjectOffered = run.crossProject?.hasFiles() ?? false;

  // Story Mode is offered from an ordinary Edit turn while the graph is still empty and the chat has not declined it.
  // The graph is read once, here: an unreadable story means no offer (a failed accept is worse than a missed
  // suggestion), and one turn at a time means it cannot gain chapters mid-turn.
  run.storyOfferEligible = await storyOfferOpen(ctx, run, signal);
  const availability: ToolAvailability = {
    enabled: setup.enabled,
    jev: setup.jev !== null,
    editing: run.editing !== null,
    analysis: run.analysis !== null,
    frames: run.frames !== null,
    crossProject: run.crossProjectOffered,
    story: run.story !== null,
    research: researchHost !== null,
    websites: researchHost !== null,
    websiteFiles: researchAccess.websiteFiles,
    researchCandidate: (id) => ctx.active?.research?.candidate(id),
    researchSourceName: (id) =>
      setup.research?.status === "ready"
        ? setup.research.policy.sources.find((source) => source.id === id)?.name
        : undefined,
    researchCandidates: setup.execution.budget.researchCandidates,
    qa: qa !== null,
    mode: run.mode,
    intent: run.intent,
    planProposal: planProposalOffered(run),
    storyOffer: run.storyOfferEligible,
    storyAction: run.storyAction,
    designAction: run.designAction,
    design: designHost !== null,
    voice: voiceHost !== null,
    planClips: (plan) => ctx.active?.analysis?.planClips(plan),
  };
  return { editingHost, researchHost, researchAccess, availability };
}
