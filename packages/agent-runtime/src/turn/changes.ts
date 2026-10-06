import { isRecord } from "@hyperframes/agent-protocol";
import { ANALYSIS_TOOL_NAMES } from "../analysis/tools.js";
import type { HostToolResult } from "../backend.js";
import { EDITING_TOOL_NAMES } from "../editing/tools.js";
import { RESEARCH_TOOL_NAMES } from "../research/tools.js";
import { CROSS_PROJECT_TOOL_NAMES } from "../crossProject/tools.js";
import { STORY_TOOL_NAMES } from "../story/tools.js";
import { savesWebsiteFiles } from "../intent.js";

/** The kinds `TurnSummary.changes` reports; `count` is the number of successful operations of that kind. */
const TIMELINE_KIND: Record<string, string> = {
  add_clip: "add_clip",
  add_sequence: "add_clip",
  add_text: "add_clip",
  add_component: "add_clip",
  mount_composition: "add_clip",
  remove_clip: "remove_clip",
  move_clip: "move_clip",
  arrange_track: "move_clip",
  trim_clip: "trim_clip",
  split_clip: "trim_clip",
  apply_captions: "captions",
  retime_captions: "captions",
  captions_from_transcript: "captions",
  set_audio_fx: "audio",
  set_volume_automation: "audio",
  duck_audio: "audio",
  set_canvas: "canvas",
  set_composition: "canvas",
};

/** What the turn's tools applied to the project, by kind, in the order each kind first happened. */
export class ChangeTally {
  private readonly counts = new Map<string, number>();

  note(kind: string, count = 1): void {
    if (count <= 0) return;
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + count);
  }

  list(): { kind: string; count: number }[] {
    return [...this.counts].map(([kind, count]) => ({ kind, count }));
  }

  /**
   * Records what a finished host-tool call changed. Only calls that succeeded count; a dry run changes nothing.
   * Raw file writes (`edit`/`write`) are counted by the file guard when it lets one through, see {@link noteFileWrite}.
   */
  noteToolCall(name: string, args: unknown, result: HostToolResult): void {
    if (result.isError) return;
    const record = isRecord(args) ? args : {};
    switch (name) {
      case EDITING_TOOL_NAMES.edit: {
        if (record.dryRun === true) return;
        const operations = Array.isArray(record.operations) ? record.operations : [];
        for (const operation of operations) {
          const op = isRecord(operation) && typeof operation.op === "string" ? operation.op : null;
          if (op) this.note(TIMELINE_KIND[op] ?? "update_clip");
        }
        return;
      }
      case EDITING_TOOL_NAMES.render:
        this.note("render");
        return;
      case ANALYSIS_TOOL_NAMES.build:
        this.note("rough_cut");
        return;
      case STORY_TOOL_NAMES.edit:
        this.note("story_edit", Array.isArray(record.operations) ? record.operations.length : 1);
        return;
      case STORY_TOOL_NAMES.build:
      case STORY_TOOL_NAMES.rebuild:
        this.note("story_build");
        return;
      case RESEARCH_TOOL_NAMES.import:
      case RESEARCH_TOOL_NAMES.resolve:
      case CROSS_PROJECT_TOOL_NAMES.import:
        this.note("import");
        return;
      case RESEARCH_TOOL_NAMES.record:
        this.note("web_save");
        return;
      default:
        if (savesWebsiteFiles(name, args)) this.note("web_save");
    }
  }

  /** A harness file write (`edit`/`write`) was let through the guard. */
  noteFileWrite(): void {
    this.note("file_edit");
  }
}
