/**
 * Agent prompt builder for HyperFrames element edit requests made from the runtime picker.
 */
import type { HyperframePickerElementInfo } from "@hyperframes/core";

/**
 * The subset of an element selection a picker prompt prints (`HyperframePickerElementInfo` is one source);
 * a field absent from a caller's type is simply omitted.
 */
export interface AgentPromptElementInfo {
  id: string | null;
  selector?: string | null;
  tagName: string;
  label?: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  textContent: string | null;
  src?: string | null;
}

const GUARDRAIL_LINES = [
  "Guardrails:",
  "- Make a targeted change to this element only, unless the request is a timeline edit.",
  "- Preserve the rest of the composition and its timing, except what a timeline edit changes.",
  "- Do not modify other elements' data-* attributes or positioning, except where the requested timeline edit requires it (split, retime, reorder, copy a group, swap media).",
  "- For timeline edits (trim, split, speed, volume, copy, swap), follow the creator-editing-recipes reference of the hyperframes-core skill and use its exact attribute forms.",
  "- Prefer existing inline styles or existing CSS rules for this element over adding unrelated selectors.",
];

function formatBoundingBox(bounds: AgentPromptElementInfo["boundingBox"]): string {
  return `x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}, width=${Math.round(bounds.width)}, height=${Math.round(bounds.height)}`;
}

function formatSelectorTagLine(info: Pick<AgentPromptElementInfo, "selector" | "tagName">): string {
  return `Selector: ${info.selector ?? "(none)"}  Tag: <${info.tagName}>`;
}

function formatTextLine(textContent: string | null): string {
  return textContent ? `Text: ${textContent}` : "";
}

/** Core identity fields, plus the text line when the element has text content. */
function buildElementInfoLines(info: AgentPromptElementInfo): string[] {
  const lines = [
    `DOM id: ${info.id ?? "(none)"}`,
    `Selector: ${info.selector ?? "(none)"}`,
    "Selector index: 0", // the picker names one node, never a candidate list
    `Tag: <${info.tagName}>`,
  ];
  if (info.label) lines.push(`Label: ${info.label}`);
  lines.push(`Bounds: ${formatBoundingBox(info.boundingBox)}`);
  if (info.src) lines.push(`Source (media): ${info.src}`);
  if (info.textContent) lines.push(`Text: ${info.textContent}`);
  return lines;
}

function buildSelectorAndTextLines(
  info: Pick<AgentPromptElementInfo, "selector" | "tagName" | "textContent">,
): string[] {
  return [formatSelectorTagLine(info), formatTextLine(info.textContent)];
}

/**
 * For a host app embedding only the player: built from the runtime picker's own payload. Null selection
 * yields a bare prompt, no guardrails.
 */
export function buildPickerAgentPrompt({
  selection,
  userInstruction,
}: {
  selection: HyperframePickerElementInfo | null;
  userInstruction?: string;
}): string {
  const lines = [
    "## HyperFrames element edit request v1",
    "Schema version: 1",
    "",
    userInstruction?.trim() || "Edit this selected HyperFrames element.",
  ];

  if (!selection) return lines.join("\n");

  const info: AgentPromptElementInfo = {
    id: selection.id,
    selector: selection.selector,
    tagName: selection.tagName,
    label: selection.label,
    boundingBox: selection.boundingBox,
    textContent: selection.textContent,
    src: selection.src,
  };

  lines.push("", ...buildElementInfoLines(info), "", ...GUARDRAIL_LINES);

  return lines.join("\n");
}

export function buildPickerAgentContextPreview(
  selection: HyperframePickerElementInfo | null,
): string {
  if (!selection) return "";
  return buildSelectorAndTextLines(selection).filter(Boolean).join("\n");
}
