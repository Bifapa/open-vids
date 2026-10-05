import { useState } from "react";
import { Globe, X } from "@phosphor-icons/react";
import type { ChatSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ChatDialog } from "./ChatDialog";

/** The sites the chat reads from: the runtime's list without the ones the user removed, and those removed ones. */
export function chatSites(chat: Pick<ChatSummary, "linkedSites" | "excludedSites">) {
  const excluded = chat.excludedSites ?? [];
  const linked = (chat.linkedSites ?? []).filter((site) => !excluded.includes(site));
  return { linked, excluded };
}

function SiteRow({
  site,
  busy,
  action,
  onAct,
}: {
  site: string;
  busy: boolean;
  /** `remove`: an active site the agents may use; `restore`: one the user removed. */
  action: "remove" | "restore";
  onAct: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      data-testid="linked-site"
      data-site={site}
      className="flex min-h-ctl items-center gap-2 rounded-sm px-1.5 hover:bg-surface-1"
    >
      <Globe aria-hidden className="size-icon-sm shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 truncate font-mono text-num text-fg" title={site}>
        {site}
      </span>
      {action === "remove" ? (
        <IconButton
          size="xs"
          aria-label={t("chat.sites.remove", { site })}
          title={t("chat.sites.removeHint")}
          icon={<X aria-hidden className="size-icon-sm" />}
          disabled={busy}
          onClick={onAct}
        />
      ) : (
        <Button
          size="xs"
          variant="ghost"
          aria-label={t("chat.sites.restoreLabel", { site })}
          disabled={busy}
          onClick={onAct}
        >
          {t("chat.sites.restore")}
        </Button>
      )}
    </li>
  );
}

/**
 * The websites this chat counts as linked (domains from the user's own messages), which the agents may read when
 * the Asset Search → Websites settings allow it. Removing one makes the agents refuse it in this chat from now on;
 * "Allow again" takes it back. The list is read-only while the chat works.
 */
export function LinkedSitesDialog({ chat, onClose }: { chat: ChatSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const setExcludedSites = useAgentStore((state) => state.setExcludedSites);
  const locked = useAgentStore((state) =>
    state.chat?.turns.some((turn) => turn.status === "running"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { linked, excluded } = chatSites(chat);

  const change = async (next: string[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await setExcludedSites(next);
    setBusy(false);
    if (!result.ok) setError(result.message);
  };

  return (
    <ChatDialog
      open
      onClose={onClose}
      title={t("chat.sites.title")}
      description={t("chat.sites.description")}
      footer={
        <Button size="sm" variant="secondary" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      <div className="grid gap-3">
        {locked === true && (
          <p data-testid="linked-sites-locked" className="text-xs leading-4 text-fg-3">
            {t("chat.sites.locked")}
          </p>
        )}
        {linked.length === 0 && excluded.length === 0 ? (
          <p data-testid="linked-sites-empty" className="text-sm leading-[17px] text-fg-3">
            {t("chat.sites.empty")}
          </p>
        ) : (
          <>
            <ul aria-label={t("chat.sites.listLabel")} className="grid gap-px">
              {linked.map((site) => (
                <SiteRow
                  key={site}
                  site={site}
                  busy={busy || locked === true}
                  action="remove"
                  onAct={() => void change([...excluded, site])}
                />
              ))}
              {linked.length === 0 && (
                <li className="px-1.5 text-xs text-fg-3">{t("chat.sites.noneActive")}</li>
              )}
            </ul>
            {excluded.length > 0 && (
              <div className="grid gap-1">
                <h3 className="text-xs font-semibold text-fg-2">{t("chat.sites.removedTitle")}</h3>
                <ul aria-label={t("chat.sites.removedLabel")} className="grid gap-px">
                  {excluded.map((site) => (
                    <SiteRow
                      key={site}
                      site={site}
                      busy={busy || locked === true}
                      action="restore"
                      onAct={() => void change(excluded.filter((other) => other !== site))}
                    />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" data-testid="linked-sites-error" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </ChatDialog>
  );
}
