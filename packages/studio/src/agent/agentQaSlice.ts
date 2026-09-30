import type { QaReport } from "@hyperframes/agent-protocol";
import { AgentApiError, type AgentClient } from "./agentClient";
import type { Loadable } from "./agentSettingsSlice";

/** Render QA reports as the chat shows them. */
export interface AgentQaSlice {
  /**
   * One stored QA pass, read fresh every time: `current` is derived when read, so a cached report would keep
   * claiming it matches a project that a revert has since changed. Never rejects.
   */
  loadQaReport(reportId: string): Promise<Loadable<QaReport>>;
  /** Where a QA pass's render (`renders/<file>`) can be opened. */
  qaRenderUrl(renderPath: string): string;
}

/** Reports come from the Studio server, not the agent: its failures read differently. */
function describeQaReportError(error: unknown): string {
  if (error instanceof AgentApiError) {
    if (error.status === 404) return "This report is no longer stored.";
    if (error.code === "network") return "Can't reach Studio right now.";
    if (error.code === "bad_response") return "Studio sent a report it couldn't read.";
    if (error.message) return error.message;
  }
  return "The report couldn't be loaded.";
}

export function createAgentQaSlice({ client }: { client: AgentClient }): AgentQaSlice {
  return {
    async loadQaReport(reportId) {
      try {
        return { status: "ready", value: await client.getQaReport(reportId) };
      } catch (error) {
        return { status: "failed", message: describeQaReportError(error) };
      }
    },
    qaRenderUrl: (renderPath) => client.renderFileUrl(renderPath),
  };
}
