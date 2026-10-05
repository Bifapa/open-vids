import { useId, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { PermissionDecision, PermissionRequest } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { Trans, formatDuration, useTranslation } from "../../i18n";
import { Button, Tooltip, cn } from "../ui";
import { chatAgentName } from "./AgentMonogram";
import { chatMeasureWide, noteBox, noteBoxWarn } from "./chatStyles";
import { KIND_VIEWS, SENTENCE_KEYS, STATE_ICONS, STATE_TONES } from "./permissionKinds";

const NAMED = "font-medium text-fg [overflow-wrap:anywhere]";

interface FailedAnswer {
  decision: PermissionDecision;
  message: string;
}

/** Which parts of "download <title> from <source>" the request can fill in; the message words each case itself. */
function sentenceShape(title: string, source: string): "titleSource" | "title" | "source" | "none" {
  if (title && source) return "titleSource";
  if (title) return "title";
  return source ? "source" : "none";
}

/** What a request about outside material says about it, trimmed; an empty string counts as not known. */
function assetFacts(request: PermissionRequest) {
  const title = request.asset?.title.trim() ?? "";
  const source = request.asset?.source?.trim() || request.site || "";
  const license = request.asset?.license?.trim() ?? "";
  return {
    title,
    source,
    license,
    shape: sentenceShape(title, source),
    known: request.asset !== undefined,
  };
}

/** "<agent> wants to download/import <title> from <source>", with what is not known left out instead of guessed. */
function AssetSentence({
  request,
  i18nKey,
}: {
  request: PermissionRequest;
  i18nKey: "chat.permission.assetDownload" | "chat.permission.assetImport";
}) {
  const { title, source, shape } = assetFacts(request);
  return (
    <Trans
      i18nKey={i18nKey}
      values={{ agent: chatAgentName(request.agent), shape }}
      // The title and the source come from outside web pages: they are children of the placeholders, never
      // part of the message, so nothing in them is read as markup.
      components={{
        b: <b className="font-medium text-fg" />,
        asset: <b className={NAMED}>{title}</b>,
        source: <b className={NAMED}>{source}</b>,
      }}
    />
  );
}

/** "<agent> wants to render <composition> (4 min 12 s)": the composition and its length when the request has them. */
function LongRenderSentence({ request }: { request: PermissionRequest }) {
  const render = request.render;
  return (
    <Trans
      i18nKey="chat.permission.longRender"
      values={{
        agent: chatAgentName(request.agent),
        shape: render ? "named" : "none",
        duration: render ? formatDuration(render.seconds) : "",
      }}
      components={{
        b: <b className="font-medium text-fg" />,
        composition: <b className={NAMED}>{render?.composition ?? ""}</b>,
      }}
    />
  );
}

function WebsiteSentence({ request }: { request: PermissionRequest }) {
  return (
    <Trans
      // A render is never about a website; reading is the quietest wording if a request ever says otherwise.
      i18nKey={SENTENCE_KEYS[request.action === "render" ? "read" : request.action]}
      values={{
        agent: chatAgentName(request.agent),
        known: request.site === null ? "no" : "yes",
        site: request.site ?? "",
      }}
      components={{ b: <b className="font-medium text-fg" /> }}
    />
  );
}

function RequestSentence({ request }: { request: PermissionRequest }) {
  switch (request.kind) {
    case "asset_download":
      return <AssetSentence request={request} i18nKey="chat.permission.assetDownload" />;
    case "restricted_asset":
      return <AssetSentence request={request} i18nKey="chat.permission.assetImport" />;
    case "long_render":
      return <LongRenderSentence request={request} />;
    case "read_linked_pages":
    case "website_full_access":
      return <WebsiteSentence request={request} />;
  }
}

/**
 * An agent needs something the user has not allowed: a website setting that is off, downloading outside material
 * while the agents ask first, importing restricted material, or a render that would run for minutes. The card names
 * who asked, what for and (when a setting is involved) which one, and offers the answers — allow for the turn /
 * change the setting / don't allow, or just allow / don't allow for a one-off consent — while the tool call waits.
 * Once answered (or expired) it is a one-line record. The chat stream carries the new state; the answer only keeps
 * the card busy until the runtime has taken it.
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
  const view = KIND_VIEWS[current.kind];
  const KindIcon = view.icon;
  const facts = view.showsAsset ? assetFacts(current) : null;

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
  const onceHint =
    current.site && view.once.siteHint
      ? t(view.once.siteHint, { site: current.site })
      : t(view.once.hint);

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
          {/* "… is off" only while it asks; once answered the status line says what happened. */}
          {t(open ? view.title : view.settledTitle)}
        </span>
      </div>
      <p data-testid="permission-sentence" className="text-sm leading-[17px] text-fg-2">
        <RequestSentence request={current} />
      </p>
      {open && facts?.known && (
        <p data-testid="permission-license" className="text-xs leading-[15px] text-fg-3">
          {facts.license
            ? t("chat.permission.license", { license: facts.license })
            : t("chat.permission.licenseUnknown")}
        </p>
      )}
      {open && view.detail.type === "setting" && (
        <div
          data-testid="permission-setting"
          className="grid gap-px rounded-sm bg-surface-1 px-2 py-1.5"
        >
          <span className="text-xs font-medium text-fg">{t(view.detail.setting.name)}</span>
          <span className="text-xs leading-[15px] text-fg-3 [text-wrap:pretty]">
            {t(view.detail.setting.hint)}
          </span>
          <span className="text-2xs leading-[14px] text-fg-3">
            {t("chat.permission.where", {
              section: t(view.detail.setting.section),
              group: t(view.detail.setting.group),
            })}
          </span>
        </div>
      )}
      {open && view.detail.type === "note" && (
        <p
          data-testid="permission-note"
          className="text-xs leading-[15px] text-fg-3 [text-wrap:pretty]"
        >
          {t(view.detail.text)}
        </p>
      )}
      {open ? (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tooltip label={onceHint}>
              <Button
                size="sm"
                variant={view.once.variant}
                loading={busy === "once"}
                disabled={busy !== null}
                onClick={() => void answer("once")}
              >
                {t(view.once.label)}
              </Button>
            </Tooltip>
            {view.always && (
              <Tooltip label={t(view.always.hint)}>
                <Button
                  size="sm"
                  variant={view.always.variant}
                  loading={busy === "always"}
                  disabled={busy !== null}
                  onClick={() => void answer("always")}
                >
                  {t(view.always.label)}
                </Button>
              </Tooltip>
            )}
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "deny"}
              disabled={busy !== null}
              onClick={() => void answer("deny")}
            >
              {t(view.deny)}
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
            {t(view.states[settled])}
          </p>
        )
      )}
    </section>
  );
}
