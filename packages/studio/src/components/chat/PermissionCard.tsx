import { useId, useState } from "react";
import {
  CheckCircle,
  Clock,
  Globe,
  ShieldWarning,
  WarningCircle,
  XCircle,
  type Icon,
} from "@phosphor-icons/react";
import type {
  PermissionAction,
  PermissionDecision,
  PermissionKind,
  PermissionRequest,
  PermissionState,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { Trans, useTranslation, type TranslationKey } from "../../i18n";
import { Button, Tooltip, cn } from "../ui";
import { chatAgentName } from "./AgentMonogram";
import { chatMeasureWide, noteBox, noteBoxWarn } from "./chatStyles";

const KIND_ICONS: Record<PermissionKind, Icon> = {
  read_linked_pages: Globe,
  website_full_access: ShieldWarning,
};

const TITLE_KEYS: Record<PermissionKind, TranslationKey> = {
  read_linked_pages: "chat.permission.title.read_linked_pages",
  website_full_access: "chat.permission.title.website_full_access",
};

/** The setting as Settings → Asset Search → Websites words it: the same name and hint, never a second copy. */
const SETTING_KEYS: Record<PermissionKind, { name: TranslationKey; hint: TranslationKey }> = {
  read_linked_pages: {
    name: "research.policy.readLinked",
    hint: "research.policy.readLinked.hint",
  },
  website_full_access: {
    name: "research.policy.fullAccess",
    hint: "research.policy.fullAccess.hint",
  },
};

/** What the agent was about to do; the sentence names the site when the request has one. */
const SENTENCE_KEYS = {
  read: "chat.permission.read",
  download: "chat.permission.download",
  read_code: "chat.permission.read_code",
  record: "chat.permission.record",
} as const satisfies Record<PermissionAction, TranslationKey>;

type AnsweredState = Exclude<PermissionState, "pending">;

const STATE_KEYS: Record<AnsweredState, TranslationKey> = {
  allowed_once: "chat.permission.state.allowed_once",
  enabled: "chat.permission.state.enabled",
  denied: "chat.permission.state.denied",
  expired: "chat.permission.state.expired",
};

const STATE_ICONS: Record<AnsweredState, Icon> = {
  allowed_once: CheckCircle,
  enabled: CheckCircle,
  denied: XCircle,
  expired: Clock,
};

const STATE_TONES: Record<AnsweredState, string> = {
  allowed_once: "text-success",
  enabled: "text-success",
  denied: "text-fg-2",
  expired: "text-fg-3",
};

interface FailedAnswer {
  decision: PermissionDecision;
  message: string;
}

/**
 * An agent needs a website setting that is off: the card names who asked, what for and which setting, and offers
 * Allow once / Turn on / Don't allow while the tool call waits. Once answered (or expired) it is a one-line record.
 * The chat stream carries the new state; the answer only keeps the card busy until the runtime has taken it.
 */
export function PermissionCard({
  turnId,
  permission,
}: {
  turnId: string;
  permission: PermissionRequest;
}) {
  const { t } = useTranslation();
  const answerPermission = useAgentStore((state) => state.answerPermission);
  const titleId = useId();
  const [busy, setBusy] = useState<PermissionDecision | null>(null);
  const [failed, setFailed] = useState<FailedAnswer | null>(null);
  // The runtime's answer stands in until the stream delivers the same state (it is not replayed after a drop).
  const [answered, setAnswered] = useState<PermissionRequest | null>(null);

  const current =
    permission.state === "pending" && answered?.id === permission.id ? answered : permission;
  const KindIcon = KIND_ICONS[current.kind];
  const setting = SETTING_KEYS[current.kind];

  const answer = async (decision: PermissionDecision) => {
    if (busy) return;
    setBusy(decision);
    setFailed(null);
    const result = await answerPermission(turnId, permission.id, decision);
    setBusy(null);
    if (result.ok) setAnswered(result.permission);
    else setFailed({ decision, message: result.message });
  };

  const settled = current.state === "pending" ? null : current.state;
  const open = settled === null;
  const StateIcon = settled === null ? null : STATE_ICONS[settled];

  return (
    <section
      aria-labelledby={titleId}
      data-testid="permission-card"
      data-permission-state={current.state}
      data-permission-kind={current.kind}
      className={cn("mt-1.5", open ? noteBoxWarn : noteBox, chatMeasureWide)}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <KindIcon
          aria-hidden
          weight={open ? "fill" : "regular"}
          className={cn("size-icon-sm shrink-0", open ? "text-warning" : "text-fg-3")}
        />
        <span id={titleId} className="min-w-0 font-semibold text-fg">
          {/* "… is off" only while it asks; once answered the status line says what happened to the setting. */}
          {t(open ? TITLE_KEYS[current.kind] : setting.name)}
        </span>
      </div>
      <p data-testid="permission-sentence" className="text-sm leading-[17px] text-fg-2">
        <Trans
          i18nKey={SENTENCE_KEYS[current.action]}
          values={{
            agent: chatAgentName(current.agent),
            known: current.site === null ? "no" : "yes",
            site: current.site ?? "",
          }}
          components={{ b: <b className="font-medium text-fg" /> }}
        />
      </p>
      {open && (
        <div
          data-testid="permission-setting"
          className="grid gap-px rounded-sm bg-surface-1 px-2 py-1.5"
        >
          <span className="text-xs font-medium text-fg">{t(setting.name)}</span>
          <span className="text-xs leading-[15px] text-fg-3 [text-wrap:pretty]">
            {t(setting.hint)}
          </span>
          <span className="text-2xs leading-[14px] text-fg-3">
            {t("chat.permission.where", {
              section: t("settings.section.assets"),
              group: t("research.policy.groupWebsites"),
            })}
          </span>
        </div>
      )}
      {open ? (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tooltip label={t("chat.permission.onceHint")}>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "once"}
                disabled={busy !== null}
                onClick={() => void answer("once")}
              >
                {t("chat.permission.once")}
              </Button>
            </Tooltip>
            <Tooltip label={t("chat.permission.alwaysHint")}>
              <Button
                size="sm"
                variant="primary"
                loading={busy === "always"}
                disabled={busy !== null}
                onClick={() => void answer("always")}
              >
                {t("chat.permission.always")}
              </Button>
            </Tooltip>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "deny"}
              disabled={busy !== null}
              onClick={() => void answer("deny")}
            >
              {t("chat.permission.deny")}
            </Button>
          </div>
          {failed && (
            <div
              role="alert"
              data-testid="permission-error"
              className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-[15px] text-error"
            >
              <WarningCircle aria-hidden className="size-icon-sm shrink-0" />
              <span className="min-w-0 flex-1 [text-wrap:pretty]">
                {t("chat.permission.error", { message: failed.message })}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void answer(failed.decision)}
              >
                {t("common.tryAgain")}
              </Button>
            </div>
          )}
        </div>
      ) : (
        StateIcon && (
          <p
            role="status"
            data-testid="permission-status"
            className={cn("flex items-center gap-1 text-xs", STATE_TONES[settled])}
          >
            <StateIcon aria-hidden weight="fill" className="size-icon-sm shrink-0" />
            {t(STATE_KEYS[settled])}
          </p>
        )
      )}
    </section>
  );
}
