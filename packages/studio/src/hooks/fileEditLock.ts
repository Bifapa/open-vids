import { isAgentTurnRunning } from "../agent/agentTurnLock";
import { t } from "../i18n";

/**
 * Why hand changes to the project's files are refused right now, or null while they are allowed: an agent turn is
 * running for this project, and it may be rewriting the very file the user would touch. This is the file side of
 * the timeline's lock (`timelineEditLockReason`): the code editor goes read-only and the file tree's create /
 * rename / move / duplicate / delete stop. Importing files only adds new ones, so it stays open (the chat attaches
 * files mid-turn through the same path). The agent's own writes are server-side and never pass through here.
 */
export function fileEditLockReason(): string | null {
  return isAgentTurnRunning() ? t("files.lock.agentEditing") : null;
}
