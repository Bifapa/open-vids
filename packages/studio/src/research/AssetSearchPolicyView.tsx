import { useState } from "react";
import {
  ArrowCounterClockwise,
  Globe,
  Plus,
  ShieldCheck,
  Trash,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import {
  ASSET_SEARCH_MODES,
  type AssetSearchMode,
  type TrustedSource,
} from "@hyperframes/agent-protocol";
import { Badge, Button, IconButton, Toggle, Tooltip, cn } from "../components/ui";
import { Trans, useTranslation, type TranslationKey } from "../i18n";
import { AddTrustedSourceForm } from "./AddTrustedSourceForm";
import { MEDIA_KIND_LABELS } from "./licenseLabels";
import { useResearchServices } from "./researchContext";
import { ExternalLink, InlineError, NoteBox, SectionHeading } from "./researchUi";
import { SourceApiKeyControl } from "./SourceApiKeyControl";
import { useAssetSearchPolicy, type AssetSearchPolicyState } from "./useAssetSearchPolicy";

const MODE_KEYS = {
  trusted: {
    label: "research.policy.mode.trusted",
    description: "research.policy.mode.trusted.hint",
  },
  any: {
    label: "research.policy.mode.any",
    description: "research.policy.mode.any.hint",
  },
} as const satisfies Record<
  AssetSearchMode,
  { label: TranslationKey; description: TranslationKey }
>;

const MODE_ICONS: Record<AssetSearchMode, Icon> = { trusted: ShieldCheck, any: Globe };

/** The prototype's `.st-box`: one bordered group of rows on the chrome surface. */
const BOX = "overflow-hidden rounded-md border border-border-subtle bg-bg-1";

/** Search mode as the prototype's radio list: a dot, a bold label with its glyph, and what the mode means. */
function ModeSwitch({ state }: { state: AssetSearchPolicyState }) {
  const { t } = useTranslation();
  const mode = state.policy?.mode ?? "trusted";
  return (
    <div role="radiogroup" aria-label={t("research.policy.modeAria")} className={BOX}>
      {ASSET_SEARCH_MODES.map((option) => {
        const checked = option === mode;
        const ModeIcon = MODE_ICONS[option];
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={state.policy === null || state.pending !== null}
            onClick={() => {
              if (!checked) void state.change("mode", (client) => client.setMode(option));
            }}
            className={cn(
              "group/radio grid w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 px-3 py-2 text-left",
              "border-border-subtle not-first:border-t",
              "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
              "disabled:cursor-not-allowed",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "row-span-2 mt-px size-3.5 rounded-full",
                checked
                  ? "border-4 border-fg bg-bg-1"
                  : "border border-border-strong bg-surface-1 group-enabled/radio:group-hover/radio:border-fg-3",
              )}
            />
            <span className="flex items-center gap-1 text-base leading-4 text-fg">
              <ModeIcon size={12} className="shrink-0 text-fg-3" aria-hidden />
              {t(MODE_KEYS[option].label)}
            </span>
            <span
              className="col-start-2 text-xs leading-[14px] text-fg-3 [text-wrap:pretty]"
              data-testid={checked ? "asset-search-mode-description" : undefined}
            >
              {t(MODE_KEYS[option].description)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SourceRow({ source, state }: { source: TrustedSource; state: AssetSearchPolicyState }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const busy = state.pending !== null;
  const notes = [source.description, source.licenseNote].filter(Boolean).join(" ");
  // A keyed source the user switched on still searches nothing until their key is saved.
  const needsKey = source.apiKey !== null && !source.apiKey.configured;
  const searched = source.enabled && !needsKey;
  return (
    <li
      data-source-id={source.id}
      className="flex flex-col gap-1.5 border-border-subtle px-3 py-2 not-first:border-t"
    >
      <div className="grid grid-cols-[28px_minmax(0,1fr)_28px] items-center gap-2.5">
        <Toggle
          label={t("research.policy.use", { name: source.name })}
          checked={source.enabled}
          disabled={busy}
          onCommit={(enabled) =>
            void state.change(source.id, (client) => client.updateSource(source.id, { enabled }))
          }
        />
        <div className="grid min-w-0 gap-px">
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-base leading-4 font-medium",
              searched ? "text-fg" : "text-fg-3",
            )}
          >
            <span className="truncate">{source.name}</span>
            {source.builtIn && <Badge size="sm">{t("research.policy.builtIn")}</Badge>}
            {source.enabled && needsKey && (
              <Badge size="sm" className="border border-border bg-transparent text-fg-3">
                {t("research.policy.key.badge")}
              </Badge>
            )}
          </span>
          <span className="truncate text-xs leading-[14px] text-fg-3">
            {source.domains.length > 0 && (
              <span className="font-mono text-num">{source.domains.join(", ")} · </span>
            )}
            {source.kinds.map((kind) => t(MEDIA_KIND_LABELS[kind])).join(" · ")}
          </span>
        </div>
        <Tooltip label={t("research.policy.removeTip")} side="bottom">
          <IconButton
            aria-label={t("research.policy.remove", { name: source.name })}
            size="md"
            disabled={busy}
            icon={<Trash size={14} aria-hidden />}
            onClick={() => setConfirming(true)}
          />
        </Tooltip>
      </div>
      {(notes || source.homepage) && (
        <p className="flex flex-wrap items-center gap-x-1.5 pl-[38px] text-xs leading-[15px] text-fg-3">
          {notes && <span className="[text-wrap:pretty]">{notes}</span>}
          {source.homepage && (
            <ExternalLink href={source.homepage}>
              {source.homepage.replace(/^https?:\/\//, "")}
            </ExternalLink>
          )}
        </p>
      )}
      {source.apiKey && (
        <SourceApiKeyControl source={source} apiKey={source.apiKey} state={state} />
      )}
      {confirming && (
        <div
          role="group"
          aria-label={t("research.policy.confirmAria", { name: source.name })}
          className="ml-[38px] flex flex-wrap items-center justify-between gap-2 rounded-sm bg-surface-1 px-2 py-1.5 text-xs text-fg-2"
        >
          <span>
            <Trans
              i18nKey={
                source.builtIn
                  ? "research.policy.confirmRemoveBuiltIn"
                  : "research.policy.confirmRemove"
              }
              values={{ name: source.name }}
              components={{ b: <b className="font-semibold text-fg" /> }}
            />
          </span>
          <span className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {t("research.policy.keep")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={state.pending === source.id}
              onClick={async () => {
                const failure = await state.change(source.id, (client) =>
                  client.removeSource(source.id),
                );
                if (failure === null) setConfirming(false);
              }}
            >
              {t("common.remove")}
            </Button>
          </span>
        </div>
      )}
    </li>
  );
}

/**
 * What agents may do with the pages the user links in chat, as switch rows on the prototype's box: read them, and
 * (only while reading is on) take any file of the site, read its code and record its pages.
 */
function WebsitesBox({
  state,
  readLinkedPages,
  fullAccess,
}: {
  state: AssetSearchPolicyState;
  readLinkedPages: boolean;
  fullAccess: boolean;
}) {
  const { t } = useTranslation();
  const fullAccessOn = readLinkedPages && fullAccess;
  return (
    <div className={BOX} data-websites-group>
      <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2.5 px-3 py-2.5">
        <Toggle
          className="mt-0.5"
          label={t("research.policy.readLinked")}
          checked={readLinkedPages}
          disabled={state.pending !== null}
          onCommit={(next) =>
            void state.change("websites", (client) => client.setReadLinkedPages(next))
          }
        />
        <div className="grid min-w-0 gap-px">
          <span
            className={cn(
              "text-base leading-4 font-medium",
              readLinkedPages ? "text-fg" : "text-fg-3",
            )}
          >
            {t("research.policy.readLinked")}
          </span>
          <span className="text-xs leading-[15px] text-fg-3 [text-wrap:pretty]">
            {t("research.policy.readLinked.hint")}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2.5 border-t border-border-subtle px-3 py-2.5">
        <Toggle
          className="mt-0.5"
          label={t("research.policy.fullAccess")}
          checked={fullAccessOn}
          disabled={!readLinkedPages || state.pending !== null}
          onCommit={(next) => void state.change("websites", (client) => client.setFullAccess(next))}
        />
        <div className="grid min-w-0 gap-px">
          <span
            className={cn(
              "text-base leading-4 font-medium",
              readLinkedPages ? "text-fg" : "text-fg-3",
            )}
          >
            {t("research.policy.fullAccess")}
          </span>
          <span className="text-xs leading-[15px] text-fg-3 [text-wrap:pretty]">
            {t("research.policy.fullAccess.hint")}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The global Asset Search policy: where the Research agent may search and download, for every project. The Studio
 * server enforces it; this is only where the user sets it. Mounted by the Sources panel and the Settings window.
 */
export function AssetSearchPolicyView({
  className,
  variant = "panel",
}: {
  className?: string;
  /**
   * `panel` (the Sources panel) opens with the "applies to all projects" note. `settings` is the Settings window's
   * section: that sentence is the page's lede there, and the group labels sit on the window's tighter rhythm.
   */
  variant?: "panel" | "settings";
} = {}) {
  const inSettings = variant === "settings";
  const section = cn("flex flex-col", !inSettings && "gap-1.5");
  const heading = inSettings ? "min-h-0 pb-1.5" : undefined;
  const { t } = useTranslation();
  const { client } = useResearchServices();
  const state = useAssetSearchPolicy(client);
  const [adding, setAdding] = useState(false);
  const { policy } = state;
  const removed = policy?.removedBuiltIns.length ?? 0;
  const onCount = policy?.sources.filter((source) => source.enabled).length ?? 0;
  const onCountKey =
    policy?.mode === "any"
      ? "research.policy.onCountAny"
      : onCount > 0
        ? "research.policy.onCountTrusted"
        : "research.policy.onCount";

  return (
    <div className={cn("flex flex-col gap-5 px-3 py-3", className)}>
      {!inSettings && (
        <NoteBox icon={<Globe size={12} />}>
          <Trans
            i18nKey="research.policy.appliesNote"
            components={{ b: <b className="font-semibold" /> }}
          />
        </NoteBox>
      )}
      {state.error && <InlineError message={state.error} onDismiss={state.dismissError} />}
      {state.loading && !policy ? (
        <p role="status" className="text-sm text-fg-3">
          {t("research.policy.loading")}
        </p>
      ) : !policy ? (
        <Button
          className="self-start"
          size="sm"
          variant="secondary"
          onClick={() => void state.reload()}
        >
          {t("common.retry")}
        </Button>
      ) : (
        <>
          <section className={section}>
            <SectionHeading title={t("research.policy.groupMode")} className={heading} />
            <ModeSwitch state={state} />
          </section>
          <section className={section}>
            <SectionHeading
              className={heading}
              title={t("research.policy.groupSources")}
              note={t(onCountKey, { on: onCount, total: policy.sources.length })}
            />
            <div className={BOX}>
              {policy.sources.length === 0 ? (
                <p className="px-3 py-2.5 text-sm text-fg-3">{t("research.policy.empty")}</p>
              ) : (
                <ul aria-label={t("research.policy.groupSources")}>
                  {policy.sources.map((source) => (
                    <SourceRow key={source.id} source={source} state={state} />
                  ))}
                </ul>
              )}
              <div className="border-t border-border-subtle px-3 py-2">
                {adding ? (
                  <AddTrustedSourceForm
                    pending={state.pending === "add"}
                    onCancel={() => setAdding(false)}
                    onAdd={async (request) => {
                      const failure = await state.change(
                        "add",
                        (research) => research.addSource(request),
                        { inline: true },
                      );
                      if (failure === null) setAdding(false);
                      return failure;
                    }}
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Plus size={12} aria-hidden />}
                      disabled={state.pending !== null}
                      onClick={() => setAdding(true)}
                    >
                      {t("research.policy.addSource")}
                    </Button>
                    {removed > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<ArrowCounterClockwise size={12} aria-hidden />}
                        loading={state.pending === "restore"}
                        disabled={state.pending !== null}
                        onClick={() =>
                          void state.change("restore", (research) => research.restoreSources())
                        }
                      >
                        {t("research.policy.restore", { count: removed })}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
            {policy.sources.some((source) => source.apiKey !== null) && (
              <p className="px-0.5 text-xs leading-[15px] text-fg-3 [text-wrap:pretty]">
                {t("research.policy.keysFoot")}
              </p>
            )}
            {policy.mode === "trusted" && onCount === 0 && (
              <p className="flex items-center gap-1 px-0.5 text-xs font-medium text-warning">
                <WarningCircle size={12} weight="fill" aria-hidden />
                {t("research.policy.allOff")}
              </p>
            )}
          </section>
          <section className={section}>
            <SectionHeading title={t("research.policy.groupWebsites")} className={heading} />
            <WebsitesBox
              state={state}
              readLinkedPages={policy.websites.readLinkedPages}
              fullAccess={policy.websites.fullAccess}
            />
          </section>
        </>
      )}
    </div>
  );
}
