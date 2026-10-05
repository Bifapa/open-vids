import { useEffect, useState } from "react";
import type { QaAcceptedIssue } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import type { Loadable } from "../../agent/agentSettingsSlice";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { chatLink } from "./chatStyles";
import { QA_ISSUE_KIND_LABELS, formatQaRange } from "./qaLabels";

/**
 * The issues of this project the user marked intentional, which QA leaves out of every pass: "2 issues left out of
 * this pass". Opening the list shows what they are and lets the user have QA check one again.
 */
export function QaAcceptedList({
  composition,
  suppressed,
}: {
  composition: string;
  suppressed: number;
}) {
  const { t } = useTranslation();
  const loadQaAccepted = useAgentStore((state) => state.loadQaAccepted);
  const removeQaAccepted = useAgentStore((state) => state.removeQaAccepted);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Loadable<QaAcceptedIssue[]>>({ status: "loading" });
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadQaAccepted().then((result) => {
      if (live) setItems(result);
    });
    return () => {
      live = false;
    };
  }, [open, loadQaAccepted]);

  const remove = async (acceptedId: string) => {
    setRemoving(acceptedId);
    setFailure(null);
    const result = await removeQaAccepted(acceptedId);
    setRemoving(null);
    if (result.status === "ready") setItems(result);
    else if (result.status === "failed") setFailure(result.message);
  };

  const entries =
    items.status === "ready"
      ? items.value.filter((entry) => entry.composition === composition)
      : [];
  return (
    <div data-testid="qa-suppressed" className="flex flex-col gap-1 px-1.5">
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-fg-3">
        {t("chat.qa.suppressed", { count: suppressed })}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(chatLink, "text-xs")}
        >
          {open ? t("chat.qa.suppressedHide") : t("chat.qa.suppressedReview")}
        </button>
      </p>
      {open && items.status === "loading" && (
        <p className="text-xs text-fg-3">{t("chat.qa.loadingReport")}</p>
      )}
      {open && items.status === "failed" && (
        <p role="alert" className="text-xs text-error">
          {items.message}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-xs text-error">
          {failure}
        </p>
      )}
      {open && items.status === "ready" && entries.length === 0 && (
        <p className="text-xs text-fg-3">{t("chat.qa.acceptedNone")}</p>
      )}
      {open && entries.length > 0 && (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-accepted-id={entry.id}
              className="flex flex-col gap-0.5 rounded-sm px-1 py-1 hover:bg-surface-1"
            >
              <span className="flex flex-wrap items-center gap-x-1.5 text-2xs text-fg-3">
                <span className="text-xs font-medium text-fg-2">
                  {t(QA_ISSUE_KIND_LABELS[entry.kind])}
                </span>
                <span className="font-mono text-num tabular-nums">
                  {formatQaRange(entry.start, entry.end)}
                </span>
                <button
                  type="button"
                  data-testid="qa-accepted-remove"
                  disabled={removing !== null}
                  onClick={() => void remove(entry.id)}
                  className={cn(
                    chatLink,
                    "ml-auto text-2xs disabled:cursor-default disabled:text-fg-disabled disabled:no-underline",
                  )}
                >
                  {t("chat.qa.acceptedRemove")}
                </button>
              </span>
              <span className="text-xs leading-[15px] text-fg-3">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
