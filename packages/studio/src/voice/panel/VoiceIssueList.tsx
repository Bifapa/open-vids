import { Warning, WarningCircle } from "@phosphor-icons/react";
import type { VoiceScriptIssue } from "@hyperframes/agent-protocol";
import { cn } from "../../components/ui";
import { describeVoiceIssue } from "./voiceIssues";

/**
 * The dialect findings of a line (or of the whole script), under the text they are about: an error stops the
 * generation and is drawn in the error colour, a warning only says what may go wrong.
 */
export function VoiceIssueList({
  issues,
  testId = "voice-issues",
}: {
  issues: readonly VoiceScriptIssue[];
  testId?: string;
}) {
  if (issues.length === 0) return null;
  return (
    <ul data-testid={testId} className="m-0 grid list-none gap-0.5 p-0">
      {issues.map((issue, index) => {
        const error = issue.severity === "error";
        const Icon = error ? WarningCircle : Warning;
        return (
          <li
            key={`${issue.code}:${index}`}
            data-voice-issue={issue.code}
            data-severity={issue.severity}
            className={cn(
              "flex items-start gap-1 text-xs leading-[15px] [overflow-wrap:anywhere]",
              error ? "text-error" : "text-warning",
            )}
          >
            <Icon aria-hidden weight="fill" className="mt-px size-icon-sm shrink-0" />
            <span className="min-w-0 [text-wrap:pretty]">{describeVoiceIssue(issue)}</span>
          </li>
        );
      })}
    </ul>
  );
}
