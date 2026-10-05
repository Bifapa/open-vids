import { useState } from "react";
import { Stop } from "@phosphor-icons/react";
import { isAgentRunTerminal, type AgentRun } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { chatAgentName } from "./AgentMonogram";

/**
 * Stops one delegated run while the rest of the turn goes on ("Stop" on a Working-list row, "Stop task" in the
 * agent's own thread). Shown only while the run is queued or running; the run's new state arrives on the chat
 * stream, a refusal (it just ended) arrives as the chat's notice.
 */
export function CancelRunButton({
  run,
  labelled = false,
  className,
}: {
  run: AgentRun;
  /** A text button ("Stop task") instead of the icon alone. */
  labelled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const cancelRun = useAgentStore((state) => state.cancelRun);
  const [busy, setBusy] = useState(false);
  if (isAgentRunTerminal(run.status)) return null;

  const name = chatAgentName(run.agent);
  const label = t("chat.run.stop", { name, title: run.title });
  const stop = async () => {
    if (busy) return;
    setBusy(true);
    await cancelRun(run.turnId, run.id);
    setBusy(false);
  };

  if (labelled) {
    return (
      <Button
        size="xs"
        variant="ghost"
        aria-label={label}
        icon={<Stop aria-hidden weight="fill" className="size-icon-sm" />}
        loading={busy}
        disabled={busy}
        data-testid="cancel-run"
        onClick={() => void stop()}
        className={className}
      >
        {t("chat.run.stopTask")}
      </Button>
    );
  }
  return (
    <IconButton
      size="xs"
      aria-label={label}
      title={t("chat.run.stopHint")}
      icon={<Stop aria-hidden weight="fill" className="size-icon-sm" />}
      disabled={busy}
      data-testid="cancel-run"
      onClick={() => void stop()}
      className={className}
    />
  );
}
