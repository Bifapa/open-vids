import type { QaReport } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
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
    if (error.status === 404) return t("agent.qa.notStored");
    if (error.code === "network") return t("agent.qa.unreachable");
    if (error.code === "bad_response") return t("agent.qa.unreadable");
    if (error.message) return error.message;
  }
  return t("agent.qa.loadFailed");
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
