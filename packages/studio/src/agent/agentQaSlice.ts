import {
  findAcceptedQaIssue,
  type QaAcceptedIssue,
  type QaIssue,
  type QaReport,
} from "@hyperframes/agent-protocol";
import { t, type TranslationKey } from "../i18n";
import { describeServerError } from "./agentErrors";
import { AgentApiError, type AgentClient } from "./agentClient";
import type { Loadable } from "./agentSettingsSlice";

/** Render QA reports as the chat shows them. */
export interface AgentQaSlice {
  /**
   * One stored QA pass, read fresh every time: `current` is derived when read, so a cached report would keep
   * claiming it matches a project that a revert has since changed. Never rejects.
   */
  loadQaReport(reportId: string): Promise<Loadable<QaReport>>;
  /**
   * Marks an open issue of a stored pass intentional: QA leaves it out of every later pass and never asks for it to
   * be fixed. Answers the pass as it reads now. Never rejects.
   */
  acceptQaIssue(reportId: string, issueId: string): Promise<Loadable<QaReport>>;
  /** Takes an issue back out of the intentional list (what matches it is removed). Answers the pass as it reads now. */
  unacceptQaIssue(report: QaReport, issue: QaIssue): Promise<Loadable<QaReport>>;
  /** Every issue the user marked intentional in this project, oldest first. Never rejects. */
  loadQaAccepted(): Promise<Loadable<QaAcceptedIssue[]>>;
  /** Stops ignoring one marked issue; the entries that remain. Never rejects. */
  removeQaAccepted(acceptedId: string): Promise<Loadable<QaAcceptedIssue[]>>;
  /** Where a QA pass's render (`renders/<file>`) can be opened. */
  qaRenderUrl(renderPath: string): string;
}

/** Reports come from the Studio server, not the agent: its failures read differently. */
function describeQaReportError(
  error: unknown,
  fallback: TranslationKey = "agent.qa.loadFailed",
): string {
  if (error instanceof AgentApiError) {
    if (error.status === 404) return t("agent.qa.notStored");
    if (error.code === "network") return t("agent.qa.unreachable");
    if (error.code === "bad_response") return t("agent.qa.unreadable");
    if (error.message) return describeServerError(error.code, error.message, error.params);
  }
  return t(fallback);
}

/** The accepted entries that hide `issue` of a report's composition (more than one when marks overlap). */
function matchingAccepted(
  issue: QaIssue,
  composition: string,
  items: readonly QaAcceptedIssue[],
): QaAcceptedIssue[] {
  return items.filter((entry) => findAcceptedQaIssue(issue, composition, [entry]) !== null);
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
    async acceptQaIssue(reportId, issueId) {
      try {
        const { report } = await client.acceptQaIssue(reportId, issueId);
        return { status: "ready", value: report };
      } catch (error) {
        return { status: "failed", message: describeQaReportError(error, "agent.qa.acceptFailed") };
      }
    },
    async unacceptQaIssue(report, issue) {
      try {
        const { items } = await client.listQaAccepted();
        for (const entry of matchingAccepted(issue, report.composition, items)) {
          await client.removeQaAccepted(entry.id);
        }
        return { status: "ready", value: await client.getQaReport(report.id) };
      } catch (error) {
        return { status: "failed", message: describeQaReportError(error, "agent.qa.acceptFailed") };
      }
    },
    async loadQaAccepted() {
      try {
        return { status: "ready", value: (await client.listQaAccepted()).items };
      } catch (error) {
        return { status: "failed", message: describeQaReportError(error, "agent.qa.acceptFailed") };
      }
    },
    async removeQaAccepted(acceptedId) {
      try {
        return { status: "ready", value: (await client.removeQaAccepted(acceptedId)).items };
      } catch (error) {
        return { status: "failed", message: describeQaReportError(error, "agent.qa.acceptFailed") };
      }
    },
    qaRenderUrl: (renderPath) => client.renderFileUrl(renderPath),
  };
}
