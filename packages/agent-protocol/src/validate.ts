import type {
  AgentIntake,
  AgentIntakeFile,
  CreateChatRequest,
  RevertTurnRequest,
  SetJevApiKeyRequest,
  SetProviderApiKeyRequest,
  StartOAuthLoginRequest,
  StartTurnRequest,
  SteerTurnRequest,
  SubmitOAuthLoginInputRequest,
  UpdateAgentSettingsRequest,
  UpdateChatRequest,
} from "./api.js";
import { INTAKE_FILE_KINDS, REVERT_MODES } from "./api.js";
import {
  CHAT_INTENTS,
  CHAT_MODES,
  JEV_CREDENTIAL_MODES,
  MANUAL_EDIT_POLICIES,
  OAUTH_FLOWS,
  OAUTH_LOGIN_STATUSES,
  SPECIALIST_IDS,
  STORY_ACTIONS,
  THINKING_EFFORTS,
  isChatIntent,
  isSpecialistId,
  type EditorClipSummary,
  type EditorContext,
  type EditorPreviewElement,
  type AutonomySettings,
  type MediaSource,
  type MessageReference,
  type ModelConfig,
  type ModelSelection,
  type OAuthLoginState,
  type SpecialistConfig,
  type SpecialistDefaults,
  type SpecialistId,
  type StoryActionOptions,
  type ThinkingEffort,
} from "./types.js";
import { parseExecutionQuality } from "./qa.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export const LIMITS = {
  promptChars: 100_000,
  titleChars: 200,
  references: 32,
  contextElements: 200,
  contextSelectedClips: 64,
  allowedModels: 32,
  providerChars: 200,
  apiKeyChars: 4_096,
  oauthInputChars: 8_192,
} as const;

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === "string" && (THINKING_EFFORTS as readonly string[]).includes(value);
}

export function parseModelSelection(value: unknown): ModelSelection | null {
  if (!isRecord(value)) return null;
  const provider = nonEmpty(value.provider);
  const modelId = nonEmpty(value.modelId);
  return provider && modelId ? { provider, modelId } : null;
}

// ── Editor context ───────────────────────────────────────────────────────────

function parseClip(value: unknown): EditorClipSummary | null {
  if (!isRecord(value)) return null;
  const id = nonEmpty(value.id);
  const tag = str(value.tag);
  const start = num(value.start);
  const duration = num(value.duration);
  const track = num(value.track);
  if (!id || tag === undefined || start === undefined || duration === undefined) return null;
  if (track === undefined) return null;
  return {
    id,
    tag,
    start,
    duration,
    track,
    ...(str(value.label) !== undefined && { label: str(value.label) }),
    ...(str(value.hfId) !== undefined && { hfId: str(value.hfId) }),
    ...(str(value.domId) !== undefined && { domId: str(value.domId) }),
    ...(str(value.sourceFile) !== undefined && { sourceFile: str(value.sourceFile) }),
    ...(str(value.src) !== undefined && { src: str(value.src) }),
  };
}

function parseClips(value: unknown, cap: number): EditorClipSummary[] {
  if (!Array.isArray(value)) return [];
  const clips: EditorClipSummary[] = [];
  for (const item of value) {
    const clip = parseClip(item);
    if (clip) clips.push(clip);
    if (clips.length >= cap) break;
  }
  return clips;
}

function parsePreviewElement(value: unknown): EditorPreviewElement | null {
  if (!isRecord(value)) return null;
  const element: EditorPreviewElement = {};
  for (const key of ["hfId", "domId", "selector", "label", "tagName", "sourceFile"] as const) {
    const field = str(value[key]);
    if (field !== undefined) element[key] = field;
  }
  return Object.keys(element).length > 0 ? element : null;
}

function parseStoryGraphContext(value: unknown): EditorContext["storyGraph"] {
  if (!isRecord(value)) return null;
  return {
    version: nonEmpty(value.version) ?? null,
    selectedNode: nonEmpty(value.selectedNode) ?? null,
  };
}

export function parseEditorContext(value: unknown): Parsed<EditorContext> {
  if (!isRecord(value) || value.schemaVersion !== 1)
    return fail("editorContext: unsupported shape");
  const project = isRecord(value.project) ? value.project : null;
  const projectId = nonEmpty(project?.id);
  if (!projectId) return fail("editorContext.project.id is required");
  const timeline = isRecord(value.timeline) ? value.timeline : {};
  const playhead = isRecord(value.playhead) ? value.playhead : {};
  const selection = isRecord(value.selection) ? value.selection : {};
  const composition = isRecord(value.activeComposition) ? value.activeComposition : null;
  const compositionPath = nonEmpty(composition?.path);
  const range = isRecord(selection.range) ? selection.range : null;
  const rangeStart = num(range?.start);
  const rangeEnd = num(range?.end);
  const render = isRecord(value.renderSettings) ? value.renderSettings : null;
  const elements = parseClips(timeline.elements, LIMITS.contextElements);
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      capturedAt: num(value.capturedAt) ?? Date.now(),
      project: {
        id: projectId,
        ...(str(project?.title) !== undefined && { title: str(project?.title) }),
      },
      activeComposition:
        composition && compositionPath
          ? {
              path: compositionPath,
              ...(num(composition.width) !== undefined && { width: num(composition.width) }),
              ...(num(composition.height) !== undefined && { height: num(composition.height) }),
              ...(num(composition.fps) !== undefined && { fps: num(composition.fps) }),
              ...(num(composition.duration) !== undefined && {
                duration: num(composition.duration),
              }),
            }
          : null,
      timeline: {
        duration: num(timeline.duration) ?? 0,
        elementCount: Math.max(num(timeline.elementCount) ?? 0, elements.length),
        elements,
      },
      playhead: { time: num(playhead.time) ?? 0, playing: playhead.playing === true },
      selection: {
        clips: parseClips(selection.clips, LIMITS.contextSelectedClips),
        assetPath: nonEmpty(selection.assetPath) ?? null,
        previewElement: parsePreviewElement(selection.previewElement),
        range:
          rangeStart !== undefined && rangeEnd !== undefined
            ? { start: rangeStart, end: rangeEnd }
            : null,
      },
      renderSettings: render
        ? {
            ...(str(render.format) !== undefined && { format: str(render.format) }),
            ...(num(render.fps) !== undefined && { fps: num(render.fps) }),
            ...(str(render.quality) !== undefined && { quality: str(render.quality) }),
            ...(str(render.resolution) !== undefined && { resolution: str(render.resolution) }),
          }
        : null,
      storyGraph: parseStoryGraphContext(value.storyGraph),
    },
  };
}

// ── References ───────────────────────────────────────────────────────────────

function parseMediaSource(value: unknown): MediaSource | null {
  if (!isRecord(value)) return null;
  if (value.type === "project-path") {
    const path = nonEmpty(value.path);
    return path ? { type: "project-path", path } : null;
  }
  if (value.type === "url") {
    const url = nonEmpty(value.url);
    return url ? { type: "url", url } : null;
  }
  if (value.type === "upload") {
    const uploadId = nonEmpty(value.uploadId);
    return uploadId ? { type: "upload", uploadId } : null;
  }
  return null;
}

export function parseReference(value: unknown): Parsed<MessageReference> {
  if (!isRecord(value)) return fail("reference must be an object");
  const id = nonEmpty(value.id);
  if (!id) return fail("reference.id is required");
  const label = str(value.label);
  const common = { id, ...(label !== undefined && { label }) };

  switch (value.kind) {
    case "image":
    case "video":
    case "audio":
    case "file": {
      const source = parseMediaSource(value.source);
      if (!source) return fail(`${value.kind} reference needs a valid source`);
      const mimeType = str(value.mimeType);
      return {
        ok: true,
        value: { ...common, kind: value.kind, source, ...(mimeType !== undefined && { mimeType }) },
      };
    }
    case "url": {
      const url = nonEmpty(value.url);
      if (!url) return fail("url reference needs a url");
      const title = str(value.title);
      return {
        ok: true,
        value: { ...common, kind: "url", url, ...(title !== undefined && { title }) },
      };
    }
    case "asset": {
      const path = nonEmpty(value.path);
      return path
        ? { ok: true, value: { ...common, kind: "asset", path } }
        : fail("asset reference needs a path");
    }
    case "timeline-range": {
      const start = num(value.start);
      const end = num(value.end);
      if (start === undefined || end === undefined || end < start) {
        return fail("timeline-range reference needs start <= end");
      }
      const compositionPath = nonEmpty(value.compositionPath);
      const elementIds = Array.isArray(value.elementIds)
        ? value.elementIds.filter((item): item is string => typeof item === "string")
        : undefined;
      return {
        ok: true,
        value: {
          ...common,
          kind: "timeline-range",
          start,
          end,
          ...(compositionPath && { compositionPath }),
          ...(elementIds && { elementIds }),
        },
      };
    }
    case "editor-selection": {
      const context = parseEditorContext(value.context);
      return context.ok
        ? { ok: true, value: { ...common, kind: "editor-selection", context: context.value } }
        : context;
    }
    default:
      return fail("unknown reference kind");
  }
}

// ── Requests ─────────────────────────────────────────────────────────────────

function parseOptionalModel(value: unknown): Parsed<ModelSelection | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  const model = parseModelSelection(value);
  return model ? { ok: true, value: model } : fail("model must be {provider, modelId}");
}

function parseOptionalThinking(value: unknown): Parsed<ThinkingEffort | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  return isThinkingEffort(value) ? { ok: true, value } : fail("unknown thinking effort");
}

function parseTitle(value: unknown): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const title = nonEmpty(value)?.trim();
  if (!title) return fail("title must be a non-empty string");
  return { ok: true, value: title.slice(0, LIMITS.titleChars) };
}

export function parseCreateChat(body: unknown): Parsed<CreateChatRequest> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isRecord(body)) return fail("body must be an object");
  const title = parseTitle(body.title);
  if (!title.ok) return title;
  const model = parseOptionalModel(body.model);
  if (!model.ok) return model;
  const thinking = parseOptionalThinking(body.thinking);
  if (!thinking.ok) return thinking;
  return {
    ok: true,
    value: {
      ...(title.value !== undefined && { title: title.value }),
      ...(model.value !== undefined && { model: model.value }),
      ...(thinking.value !== undefined && { thinking: thinking.value }),
    },
  };
}

export function parseUpdateChat(body: unknown): Parsed<UpdateChatRequest> {
  const parsed = parseCreateChat(body);
  if (!parsed.ok) return parsed;
  if (!isRecord(body)) return fail("nothing to update");
  const value: UpdateChatRequest = { ...parsed.value };
  const enabled = body.enabledAgents;
  if (enabled !== undefined) {
    if (!Array.isArray(enabled) || !enabled.every(isSpecialistId))
      return fail(`enabledAgents must list specialists from: ${SPECIALIST_IDS.join(", ")}`);
    value.enabledAgents = SPECIALIST_IDS.filter((id) => enabled.includes(id));
  }
  if (body.agentOverrides !== undefined) {
    if (!isRecord(body.agentOverrides)) return fail("agentOverrides must be an object");
    const overrides: Partial<Record<SpecialistId, SpecialistConfig | null>> = {};
    for (const [id, raw] of Object.entries(body.agentOverrides)) {
      if (!isSpecialistId(id)) return fail(`unknown specialist: ${id}`);
      if (raw === null) {
        overrides[id] = null;
        continue;
      }
      const config = parseSpecialistConfig(raw, `agentOverrides.${id}`);
      if (!config.ok) return config;
      overrides[id] = config.value;
    }
    value.agentOverrides = overrides;
  }
  if (body.activeMode !== undefined) {
    const activeMode = CHAT_MODES.find((known) => known === body.activeMode);
    if (!activeMode) return fail(`activeMode must be one of: ${CHAT_MODES.join(", ")}`);
    value.activeMode = activeMode;
  }
  if (body.intent !== undefined) {
    if (!isChatIntent(body.intent))
      return fail(`intent must be one of: ${CHAT_INTENTS.join(", ")}`);
    value.intent = body.intent;
  }
  if (body.executionQuality !== undefined) {
    if (body.executionQuality === null) value.executionQuality = null;
    else {
      const quality = parseExecutionQuality(body.executionQuality);
      if (!quality.ok) return quality;
      value.executionQuality = quality.value;
    }
  }
  return Object.keys(value).length > 0 ? { ok: true, value } : fail("nothing to update");
}

// ── Agent settings ───────────────────────────────────────────────────────────

function parseModelConfig(value: unknown, field: string): Parsed<ModelConfig> {
  if (!isRecord(value)) return fail(`${field} must be an object`);
  const model = parseOptionalModel(value.model);
  if (!model.ok) return fail(`${field}.${model.message}`);
  const thinking = parseOptionalThinking(value.thinking);
  if (!thinking.ok) return fail(`${field}: ${thinking.message}`);
  return { ok: true, value: { model: model.value ?? null, thinking: thinking.value ?? null } };
}

function parseSpecialistConfig(value: unknown, field: string): Parsed<SpecialistConfig> {
  const base = parseModelConfig(value, field);
  if (!base.ok) return base;
  const rawAllowed = isRecord(value) ? (value.allowedModels ?? []) : [];
  if (!Array.isArray(rawAllowed) || rawAllowed.length > LIMITS.allowedModels)
    return fail(
      `${field}.allowedModels must be an array of at most ${LIMITS.allowedModels} models`,
    );
  const allowedModels: ModelSelection[] = [];
  for (const item of rawAllowed) {
    const model = parseModelSelection(item);
    if (!model) return fail(`${field}.allowedModels entries must be {provider, modelId}`);
    const duplicate = allowedModels.some(
      (known) => known.provider === model.provider && known.modelId === model.modelId,
    );
    if (!duplicate) allowedModels.push(model);
  }
  return { ok: true, value: { ...base.value, allowedModels } };
}

function parseSpecialistDefaults(value: unknown, field: string): Parsed<SpecialistDefaults> {
  const config = parseSpecialistConfig(value, field);
  if (!config.ok) return config;
  const enabledByDefault = isRecord(value) ? value.enabledByDefault : undefined;
  if (typeof enabledByDefault !== "boolean")
    return fail(`${field}.enabledByDefault must be a boolean`);
  return { ok: true, value: { ...config.value, enabledByDefault } };
}

function parseOptionalName(value: unknown, field: string): Parsed<string | null | undefined> {
  if (value === undefined || value === null) return { ok: true, value };
  const text = nonEmpty(value)?.trim();
  if (!text || text.length > LIMITS.providerChars)
    return fail(`${field} must be a non-empty string or null`);
  return { ok: true, value: text };
}

export function parseUpdateAgentSettings(body: unknown): Parsed<UpdateAgentSettingsRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  const value: UpdateAgentSettingsRequest = {};
  if (body.director !== undefined) {
    const director = parseModelConfig(body.director, "director");
    if (!director.ok) return director;
    value.director = director.value;
  }
  if (body.specialists !== undefined) {
    if (!isRecord(body.specialists)) return fail("specialists must be an object");
    const specialists: Partial<Record<SpecialistId, SpecialistDefaults>> = {};
    for (const [id, raw] of Object.entries(body.specialists)) {
      if (!isSpecialistId(id)) return fail(`unknown specialist: ${id}`);
      const defaults = parseSpecialistDefaults(raw, `specialists.${id}`);
      if (!defaults.ok) return defaults;
      specialists[id] = defaults.value;
    }
    value.specialists = specialists;
  }
  if (body.jev !== undefined) {
    const raw = body.jev;
    if (!isRecord(raw)) return fail("jev must be an object");
    const jev: NonNullable<UpdateAgentSettingsRequest["jev"]> = {};
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== "boolean") return fail("jev.enabled must be a boolean");
      jev.enabled = raw.enabled;
    }
    const provider = parseOptionalName(raw.provider, "jev.provider");
    if (!provider.ok) return provider;
    if (provider.value !== undefined) jev.provider = provider.value;
    const modelId = parseOptionalName(raw.modelId, "jev.modelId");
    if (!modelId.ok) return modelId;
    if (modelId.value !== undefined) jev.modelId = modelId.value;
    const thinking = parseOptionalThinking(raw.thinking);
    if (!thinking.ok) return fail(`jev: ${thinking.message}`);
    if (thinking.value !== undefined) jev.thinking = thinking.value;
    if (raw.credentials !== undefined) {
      const mode = JEV_CREDENTIAL_MODES.find((known) => known === raw.credentials);
      if (!mode) return fail(`jev.credentials must be one of: ${JEV_CREDENTIAL_MODES.join(", ")}`);
      jev.credentials = mode;
    }
    value.jev = jev;
  }
  if (body.executionQuality !== undefined) {
    const quality = parseExecutionQuality(body.executionQuality);
    if (!quality.ok) return quality;
    value.executionQuality = quality.value;
  }
  if (body.autonomy !== undefined) {
    const autonomy = parseAutonomy(body.autonomy);
    if (!autonomy.ok) return autonomy;
    value.autonomy = autonomy.value;
  }
  return Object.keys(value).length > 0 ? { ok: true, value } : fail("nothing to update");
}

function parseAutonomy(raw: unknown): Parsed<Partial<AutonomySettings>> {
  if (!isRecord(raw)) return fail("autonomy must be an object");
  const autonomy: Partial<AutonomySettings> = {};
  if (raw.defaultIntent !== undefined) {
    if (!isChatIntent(raw.defaultIntent))
      return fail(`autonomy.defaultIntent must be one of: ${CHAT_INTENTS.join(", ")}`);
    autonomy.defaultIntent = raw.defaultIntent;
  }
  if (raw.askBeforeLockedEdits !== undefined) {
    if (typeof raw.askBeforeLockedEdits !== "boolean")
      return fail("autonomy.askBeforeLockedEdits must be a boolean");
    autonomy.askBeforeLockedEdits = raw.askBeforeLockedEdits;
  }
  if (raw.askBeforeDownloads !== undefined) {
    if (typeof raw.askBeforeDownloads !== "boolean")
      return fail("autonomy.askBeforeDownloads must be a boolean");
    autonomy.askBeforeDownloads = raw.askBeforeDownloads;
  }
  return { ok: true, value: autonomy };
}

function parseApiKeyBody(body: unknown): Parsed<{ apiKey: string | null }> {
  if (!isRecord(body)) return fail("body must be an object");
  if (body.apiKey === null) return { ok: true, value: { apiKey: null } };
  const key = nonEmpty(body.apiKey)?.trim();
  if (!key || key.length > LIMITS.apiKeyChars || /\s/.test(key))
    return fail("apiKey must be a non-empty string without whitespace, or null");
  return { ok: true, value: { apiKey: key } };
}

export function parseSetJevApiKey(body: unknown): Parsed<SetJevApiKeyRequest> {
  return parseApiKeyBody(body);
}

export function parseSetProviderApiKey(body: unknown): Parsed<SetProviderApiKeyRequest> {
  return parseApiKeyBody(body);
}

/** Provider ids are short slugs (`anthropic`, `openai-codex`, `llama.cpp`); this also keeps path traversal and `__proto__` out. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

/** A sign-in id as the runtime issues it (32 lowercase hex characters); also what a proxy may let into a path. */
const OAUTH_LOGIN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isOAuthLoginId(value: unknown): value is string {
  return typeof value === "string" && OAUTH_LOGIN_ID_PATTERN.test(value);
}

/** The body of `POST /providers/:provider/oauth/login`: absent, empty, or `{flow}`. */
export function parseStartOAuthLogin(body: unknown): Parsed<StartOAuthLoginRequest> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isRecord(body)) return fail("body must be an object");
  if (body.flow === undefined || body.flow === null) return { ok: true, value: {} };
  const flow = OAUTH_FLOWS.find((known) => known === body.flow);
  return flow
    ? { ok: true, value: { flow } }
    : fail(`flow must be one of: ${OAUTH_FLOWS.join(", ")}`);
}

/** The pasted answer of a sign-in prompt (a code or a full redirect URL). The text is never echoed in a message. */
export function parseSubmitOAuthLoginInput(body: unknown): Parsed<SubmitOAuthLoginInputRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  // A blank answer is an answer: some prompts take it as their default (GitHub Copilot's Enterprise domain).
  if (typeof body.text !== "string" || body.text.length > LIMITS.oauthInputChars)
    return fail(`text must be a string of at most ${LIMITS.oauthInputChars} characters`);
  return { ok: true, value: { text: body.text.trim() } };
}

/** Whether a runtime answer is a well-formed sign-in state (for clients that check what they receive). */
export function isOAuthLoginState(value: unknown): value is OAuthLoginState {
  if (!isRecord(value)) return false;
  const nullableText = (field: unknown) => field === null || typeof field === "string";
  const prompt = value.prompt;
  return (
    isOAuthLoginId(value.id) &&
    typeof value.provider === "string" &&
    OAUTH_LOGIN_STATUSES.some((status) => status === value.status) &&
    OAUTH_FLOWS.some((flow) => flow === value.flow) &&
    nullableText(value.authUrl) &&
    nullableText(value.instructions) &&
    nullableText(value.deviceCode) &&
    nullableText(value.progress) &&
    nullableText(value.error) &&
    typeof value.startedAt === "number" &&
    typeof value.expiresAt === "number" &&
    (prompt === null ||
      (isRecord(prompt) &&
        typeof prompt.message === "string" &&
        nullableText(prompt.placeholder) &&
        typeof prompt.secret === "boolean" &&
        typeof prompt.optional === "boolean"))
  );
}

function parseReferences(value: unknown): Parsed<MessageReference[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return fail("references must be an array");
  if (value.length > LIMITS.references) return fail(`at most ${LIMITS.references} references`);
  const references: MessageReference[] = [];
  for (const item of value) {
    const reference = parseReference(item);
    if (!reference.ok) return reference;
    references.push(reference.value);
  }
  return { ok: true, value: references };
}

function parseOptionalContext(value: unknown): Parsed<EditorContext | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  return parseEditorContext(value);
}

function parsePromptText(value: unknown, field: string): Parsed<string> {
  const text = nonEmpty(value);
  if (!text) return fail(`${field} must be a non-empty string`);
  if (text.length > LIMITS.promptChars)
    return fail(`${field} is longer than ${LIMITS.promptChars} characters`);
  return { ok: true, value: text };
}

export function parseStartTurn(body: unknown): Parsed<StartTurnRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  const prompt = parsePromptText(body.prompt, "prompt");
  if (!prompt.ok) return prompt;
  const references = parseReferences(body.references);
  if (!references.ok) return references;
  const editorContext = parseOptionalContext(body.editorContext);
  if (!editorContext.ok) return editorContext;
  let mode: StartTurnRequest["mode"];
  if (body.mode !== undefined) {
    mode = CHAT_MODES.find((known) => known === body.mode);
    if (!mode) return fail(`mode must be one of: ${CHAT_MODES.join(", ")}`);
  }
  let storyAction: StartTurnRequest["storyAction"];
  if (body.storyAction !== undefined) {
    storyAction = STORY_ACTIONS.find((known) => known === body.storyAction);
    if (!storyAction) return fail(`storyAction must be one of: ${STORY_ACTIONS.join(", ")}`);
  }
  let intent: StartTurnRequest["intent"];
  if (body.intent !== undefined) {
    if (!isChatIntent(body.intent))
      return fail(`intent must be one of: ${CHAT_INTENTS.join(", ")}`);
    if (storyAction && body.intent !== "edit") return fail("a story action always runs as edit");
    intent = body.intent;
  }
  let storyOptions: StoryActionOptions | undefined;
  if (body.storyOptions !== undefined) {
    if (storyAction !== "build" && storyAction !== "rebuild" && storyAction !== "resolve")
      return fail("storyOptions need storyAction build, rebuild or resolve");
    const parsed = parseStoryActionOptions(body.storyOptions);
    if (!parsed.ok) return parsed;
    if (storyAction === "build" && (parsed.value.chapters || parsed.value.manualEdits))
      return fail("a build rebuilds every chapter: only allowLocked applies");
    if (storyAction !== "resolve" && parsed.value.missing)
      return fail("storyOptions.missing applies to a resolve action only");
    if (
      storyAction === "resolve" &&
      (parsed.value.chapters || parsed.value.manualEdits || parsed.value.allowLocked)
    )
      return fail("a resolve action takes only storyOptions.missing");
    storyOptions = parsed.value;
  }
  return {
    ok: true,
    value: {
      prompt: prompt.value,
      ...(references.value && { references: references.value }),
      ...(editorContext.value && { editorContext: editorContext.value }),
      ...(mode && { mode }),
      ...(intent && { intent }),
      ...(storyAction && { storyAction }),
      ...(storyOptions && { storyOptions }),
    },
  };
}

const STORY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STORY_OPTION_IDS = 300;

function storyIds(value: unknown, field: string): Parsed<string[]> {
  if (!Array.isArray(value) || value.length > STORY_OPTION_IDS)
    return fail(`${field} must be an array of at most ${STORY_OPTION_IDS} node ids`);
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !STORY_ID.test(entry))
      return fail(`${field} must hold node ids`);
    if (!ids.includes(entry)) ids.push(entry);
  }
  return { ok: true, value: ids };
}

export function parseStoryActionOptions(value: unknown): Parsed<StoryActionOptions> {
  if (!isRecord(value)) return fail("storyOptions must be an object");
  const extra = Object.keys(value).find(
    (key) =>
      key !== "chapters" && key !== "manualEdits" && key !== "allowLocked" && key !== "missing",
  );
  if (extra) return fail(`storyOptions: unknown field "${extra}"`);
  const options: StoryActionOptions = {};
  if (value.chapters !== undefined) {
    const chapters = storyIds(value.chapters, "storyOptions.chapters");
    if (!chapters.ok) return chapters;
    options.chapters = chapters.value;
  }
  if (value.manualEdits !== undefined) {
    const policy = MANUAL_EDIT_POLICIES.find((known) => known === value.manualEdits);
    if (!policy)
      return fail(`storyOptions.manualEdits must be one of: ${MANUAL_EDIT_POLICIES.join(", ")}`);
    options.manualEdits = policy;
  }
  if (value.allowLocked !== undefined) {
    const allowed = storyIds(value.allowLocked, "storyOptions.allowLocked");
    if (!allowed.ok) return allowed;
    options.allowLocked = allowed.value;
  }
  if (value.missing !== undefined) {
    const missing = storyIds(value.missing, "storyOptions.missing");
    if (!missing.ok) return missing;
    options.missing = missing.value;
  }
  return { ok: true, value: options };
}

export function parseSteerTurn(body: unknown): Parsed<SteerTurnRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  const text = parsePromptText(body.text, "text");
  if (!text.ok) return text;
  const editorContext = parseOptionalContext(body.editorContext);
  if (!editorContext.ok) return editorContext;
  return {
    ok: true,
    value: { text: text.value, ...(editorContext.value && { editorContext: editorContext.value }) },
  };
}

export function parseRevertTurn(body: unknown): Parsed<RevertTurnRequest> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isRecord(body)) return fail("body must be an object");
  if (body.mode === undefined) return { ok: true, value: {} };
  const mode = REVERT_MODES.find((known) => known === body.mode);
  return mode ? { ok: true, value: { mode } } : fail("unknown revert mode");
}

const INTAKE_FILES = 200;

/** A model written as `{provider, modelId}` or as the `provider/modelId` string the Projects page may use. */
function parseIntakeModel(value: unknown): Parsed<ModelSelection | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    const provider = value.slice(0, slash).trim();
    const modelId = value.slice(slash + 1).trim();
    return slash > 0 && provider && modelId
      ? { ok: true, value: { provider, modelId } }
      : fail("model must be {provider, modelId} or provider/modelId");
  }
  const model = parseModelSelection(value);
  return model ? { ok: true, value: model } : fail("model must be {provider, modelId}");
}

function parseIntakeFile(value: unknown, index: number): Parsed<AgentIntakeFile> {
  const field = `files[${index}]`;
  if (!isRecord(value)) return fail(`${field} must be an object`);
  const path = nonEmpty(value.path)?.replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").includes(".."))
    return fail(`${field}.path must be a project-relative path`);
  const kind = INTAKE_FILE_KINDS.find((known) => known === value.kind) ?? "other";
  const size = typeof value.size === "number" && value.size >= 0 ? value.size : 0;
  const name = nonEmpty(value.name) ?? path.slice(path.lastIndexOf("/") + 1);
  return { ok: true, value: { path, name, size, kind } };
}

/** The intake file Home writes for a project started from the Projects page chat (see {@link AgentIntake}). */
export function parseAgentIntake(value: unknown): Parsed<AgentIntake> {
  if (!isRecord(value)) return fail("intake must be an object");
  if (value.version !== 1) return fail("unsupported intake version");
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (prompt.length > LIMITS.promptChars)
    return fail(`prompt is longer than ${LIMITS.promptChars} characters`);
  const intent = value.intent === undefined ? "edit" : value.intent;
  if (!isChatIntent(intent)) return fail(`intent must be one of: ${CHAT_INTENTS.join(", ")}`);
  const model = parseIntakeModel(value.model);
  if (!model.ok) return model;
  const thinking = parseOptionalThinking(value.thinking);
  if (!thinking.ok) return thinking;
  const agents = value.agents ?? [];
  if (!Array.isArray(agents) || !agents.every(isSpecialistId))
    return fail(`agents must list specialists from: ${SPECIALIST_IDS.join(", ")}`);
  let agentOverrides: Partial<Record<SpecialistId, SpecialistConfig>> | undefined;
  if (value.agentOverrides !== undefined && value.agentOverrides !== null) {
    if (!isRecord(value.agentOverrides)) return fail("agentOverrides must be an object");
    agentOverrides = {};
    for (const [id, raw] of Object.entries(value.agentOverrides)) {
      if (!isSpecialistId(id)) return fail(`unknown specialist: ${id}`);
      const config = parseSpecialistConfig(raw, `agentOverrides.${id}`);
      if (!config.ok) return config;
      agentOverrides[id] = config.value;
    }
  }
  const rawFiles = value.files ?? [];
  if (!Array.isArray(rawFiles) || rawFiles.length > INTAKE_FILES)
    return fail(`files must be an array of at most ${INTAKE_FILES} files`);
  const files: AgentIntakeFile[] = [];
  for (const [index, raw] of rawFiles.entries()) {
    const file = parseIntakeFile(raw, index);
    if (!file.ok) return file;
    files.push(file.value);
  }
  if (!prompt && files.length === 0) return fail("an intake needs a prompt or files");
  return {
    ok: true,
    value: {
      version: 1,
      prompt,
      intent,
      model: model.value,
      thinking: thinking.value ?? null,
      agents: SPECIALIST_IDS.filter((id) => agents.includes(id)),
      ...(agentOverrides && { agentOverrides }),
      files,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    },
  };
}
