import {
  QA_ISSUE_KINDS,
  QA_LIMITS,
  QA_OWNERS,
  QA_SEVERITIES,
  isRecord,
  type AgentId,
} from "@hyperframes/agent-protocol";
import type { BackendToolKind, HostTool, HostToolResult } from "../backend.js";

export const QA_TOOL_NAMES = {
  inspect: "inspect_render",
  report: "report_render_findings",
} as const;

export type QaToolName = (typeof QA_TOOL_NAMES)[keyof typeof QA_TOOL_NAMES];

export function isQaToolName(name: string): name is QaToolName {
  return Object.values<string>(QA_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/**
 * Which QA tools an agent gets. Only Vision reviews a render, and only inside the runtime-started "Render QA" run:
 * the tools refuse outside an active review, so the Director never gets them (it reads the stored findings in its
 * correction prompt) and nobody can start a review of their own.
 */
export function qaToolsFor(agent: AgentId): QaToolName[] {
  return agent === "vision" ? [QA_TOOL_NAMES.inspect, QA_TOOL_NAMES.report] : [];
}

const DESCRIPTIONS: Record<QaToolName, string> = {
  inspect_render: `Look at frames of the RENDERED video being reviewed (the file named in your task, not the timeline): returns JPEG images at the given render times, in the order you asked. Times are seconds of the rendered video and are the same as timeline times. At most ${QA_LIMITS.framesPerRequest} frames per call; the task states how many frames and how many calls (rounds) you have in total — a call beyond them is refused. Start with the sample times from your task (they sit just after cuts, at B-roll, captions and graphics, at suspects and at even coverage); use a later round only to look closer at something suspicious. Works only during a Render QA review.`,
  report_render_findings: `Report what the review found, once, after you have looked: one entry per distinct problem on the rendered video (an empty list means you looked and found nothing wrong). Each finding has a kind, severity, start/end seconds of the rendered video, a message that says what is wrong and what is on screen, whether it is fixable by editing the project, who owns the correction (editor: cuts, B-roll choice, timing; motion: titles, captions, graphics, layout; audio: music/sound; research: missing or wrong outside material) and, where you can, the timeline clip ids and a concrete suggestion. Report only what you actually saw in the frames; the deterministic checks already cover black and frozen frames, audio gaps and flash clips, so do not repeat them unless you see something they missed. Works only during a Render QA review.`,
};

const str = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength !== undefined && { maxLength }),
});

const PARAMETERS: Record<QaToolName, Record<string, unknown>> = {
  inspect_render: {
    type: "object",
    properties: {
      times: {
        type: "array",
        minItems: 1,
        maxItems: QA_LIMITS.framesPerRequest,
        description: `Render times in seconds, at most ${QA_LIMITS.framesPerRequest}.`,
        items: { type: "number", minimum: 0, description: "Seconds of the rendered video." },
      },
    },
    required: ["times"],
    additionalProperties: false,
  },
  report_render_findings: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...QA_ISSUE_KINDS] },
            severity: {
              type: "string",
              enum: [...QA_SEVERITIES],
              description: "error = clearly broken, warning = looks wrong, info = worth knowing.",
            },
            start: { type: "number", minimum: 0, description: "Seconds of the rendered video." },
            end: { type: "number", minimum: 0, description: "Seconds; not before start." },
            message: str(
              "What is wrong and what you saw, in one or two sentences.",
              QA_LIMITS.messageChars,
            ),
            fixable: {
              type: "boolean",
              description:
                "An edit of the project (timeline, captions, graphics, audio) can fix it.",
            },
            owner: {
              type: ["string", "null"],
              enum: [...QA_OWNERS, null],
              description: "Who corrects it; null when nobody can.",
            },
            clipIds: {
              type: "array",
              maxItems: QA_LIMITS.clipIds,
              items: str("A clip id from the timeline or from the sample context.", 120),
            },
            subject: {
              type: ["string", "null"],
              description:
                "What it is about, stable across passes: a clip id, a caption text or an asset path. null when only the time identifies it.",
            },
            suggestion: str("A concrete fix.", QA_LIMITS.suggestionChars),
          },
          required: ["kind", "severity", "start", "end", "message", "fixable"],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
    additionalProperties: false,
  },
};

const clock = (seconds: number): string => `${Number(seconds.toFixed(1))} s`;

function activity(
  name: QaToolName,
  args: unknown,
): { category: BackendToolKind; label: string } | null {
  const record = isRecord(args) ? args : {};
  if (name === QA_TOOL_NAMES.inspect) {
    const times = Array.isArray(record.times) ? record.times : [];
    const first = typeof times[0] === "number" ? clock(times[0]) : null;
    return {
      category: "inspect",
      label: `Looking at ${times.length} rendered ${times.length === 1 ? "frame" : "frames"}${first ? ` · from ${first}` : ""}`,
    };
  }
  const findings = Array.isArray(record.findings) ? record.findings.length : 0;
  return {
    category: "other",
    label: findings === 0 ? "Reporting: nothing wrong found" : `Reporting ${findings} findings`,
  };
}

/** The QA tools of one agent; every call goes to `execute` (the running turn's QA executor). */
export function buildQaTools(agent: AgentId, execute: Executor): HostTool[] {
  return qaToolsFor(agent).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    execute: (args, signal) => execute(name, args, signal),
    activity: (args) => activity(name, args),
  }));
}
