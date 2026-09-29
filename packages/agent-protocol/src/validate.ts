import type {
  CreateChatRequest,
  RevertTurnRequest,
  StartTurnRequest,
  SteerTurnRequest,
  UpdateChatRequest,
} from "./api.js";
import { REVERT_MODES } from "./api.js";
import {
  THINKING_EFFORTS,
  type EditorClipSummary,
  type EditorContext,
  type EditorPreviewElement,
  type MediaSource,
  type MessageReference,
  type ModelSelection,
  type ThinkingEffort,
} from "./types.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export const LIMITS = {
  promptChars: 100_000,
  titleChars: 200,
  references: 32,
  contextElements: 200,
  contextSelectedClips: 64,
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
      storyGraph: null,
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
  return Object.keys(parsed.value).length > 0 ? parsed : fail("nothing to update");
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
  return {
    ok: true,
    value: {
      prompt: prompt.value,
      ...(references.value && { references: references.value }),
      ...(editorContext.value && { editorContext: editorContext.value }),
    },
  };
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
