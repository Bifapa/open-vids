import { useState } from "react";
import type { ChatSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { ChatDialog } from "./ChatDialog";

/**
 * Asks before a chat and everything it said is removed from the project (its history cannot be brought back; the
 * project's files and the turns' checkpoints are not touched by it). A refusal — the chat started working in the
 * meantime — stays in the dialog, in plain language.
 */
export function DeleteChatDialog({ chat, onClose }: { chat: ChatSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const deleteChat = useAgentStore((state) => state.deleteChat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await deleteChat(chat.id);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.message);
  };

  return (
    <ChatDialog
      open
      onClose={onClose}
      title={t("chat.delete.title")}
      description={chat.title}
      footer={
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            disabled={busy}
            data-testid="confirm-delete-chat"
            onClick={() => void confirm()}
          >
            {t("chat.delete.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-[17px] text-fg-2">{t("chat.delete.body")}</p>
      {error && (
        <p role="alert" data-testid="delete-chat-error" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </ChatDialog>
  );
}
