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
import { AddTrustedSourceForm } from "./AddTrustedSourceForm";
import { MEDIA_KIND_LABELS } from "./licenseLabels";
import { useResearchServices } from "./researchContext";
import { ExternalLink, InlineError, NoteBox, SectionHeading } from "./researchUi";
import { useAssetSearchPolicy, type AssetSearchPolicyState } from "./useAssetSearchPolicy";

const MODE_COPY: Record<AssetSearchMode, { label: string; description: string }> = {
  trusted: {
    label: "Trusted sources only",
    description: "Research searches and downloads only from the enabled sources below.",
  },
  any: {
    label: "Any source",
    description:
      "Any public web page may be searched and downloaded (trusted sources first). Provenance is still recorded.",
  },
};

const MODE_ICONS: Record<AssetSearchMode, Icon> = { trusted: ShieldCheck, any: Globe };

/** The prototype's `.st-box`: one bordered group of rows on the chrome surface. */
const BOX = "overflow-hidden rounded-md border border-border-subtle bg-bg-1";

/** Search mode as the prototype's radio list: a dot, a bold label with its glyph, and what the mode means. */
function ModeSwitch({ state }: { state: AssetSearchPolicyState }) {
  const mode = state.policy?.mode ?? "trusted";
  return (
    <div role="radiogroup" aria-label="Asset Search mode" className={BOX}>
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
              {MODE_COPY[option].label}
            </span>
            <span
              className="col-start-2 text-xs leading-[14px] text-fg-3 [text-wrap:pretty]"
              data-testid={checked ? "asset-search-mode-description" : undefined}
            >
              {MODE_COPY[option].description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SourceRow({ source, state }: { source: TrustedSource; state: AssetSearchPolicyState }) {
  const [confirming, setConfirming] = useState(false);
  const busy = state.pending !== null;
  const notes = [source.description, source.licenseNote].filter(Boolean).join(" ");
  return (
    <li
      data-source-id={source.id}
      className="flex flex-col gap-1.5 border-border-subtle px-3 py-2 not-first:border-t"
    >
      <div className="grid grid-cols-[28px_minmax(0,1fr)_28px] items-center gap-2.5">
        <Toggle
          label={`Use ${source.name}`}
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
              source.enabled ? "text-fg" : "text-fg-3",
            )}
          >
            <span className="truncate">{source.name}</span>
            {source.builtIn && <Badge size="sm">Built-in</Badge>}
          </span>
          <span className="truncate text-xs leading-[14px] text-fg-3">
            {source.domains.length > 0 && (
              <span className="font-mono text-num">{source.domains.join(", ")} · </span>
            )}
            {source.kinds.map((kind) => MEDIA_KIND_LABELS[kind]).join(" · ")}
          </span>
        </div>
        <Tooltip label="Remove source" side="bottom">
          <IconButton
            aria-label={`Remove ${source.name}`}
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
      {confirming && (
        <div
          role="group"
          aria-label={`Confirm removing ${source.name}`}
          className="ml-[38px] flex flex-wrap items-center justify-between gap-2 rounded-sm bg-surface-1 px-2 py-1.5 text-xs text-fg-2"
        >
          <span>
            Remove <b className="font-semibold text-fg">{source.name}</b>?
            {source.builtIn && " Restore built-in sources brings it back."}
          </span>
          <span className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
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
              Remove
            </Button>
          </span>
        </div>
      )}
    </li>
  );
}

/** Whether agents may open the pages the user links in chat, as one switch row on the prototype's box. */
function WebsitesBox({ state, enabled }: { state: AssetSearchPolicyState; enabled: boolean }) {
  return (
    <div className={BOX} data-websites-group>
      <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2.5 px-3 py-2.5">
        <Toggle
          className="mt-0.5"
          label="Open links you send in chat"
          checked={enabled}
          disabled={state.pending !== null}
          onCommit={(next) =>
            void state.change("websites", (client) => client.setReadLinkedPages(next))
          }
        />
        <div className="grid min-w-0 gap-px">
          <span
            className={cn("text-base leading-4 font-medium", enabled ? "text-fg" : "text-fg-3")}
          >
            Open links you send in chat
          </span>
          <span className="text-xs leading-[15px] text-fg-3 [text-wrap:pretty]">
            Agents can read the pages you link — colors, fonts, logo, screenshots — to match a
            site's style. Only links from your own messages, plus other pages on the same site.
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
  const { client } = useResearchServices();
  const state = useAssetSearchPolicy(client);
  const [adding, setAdding] = useState(false);
  const { policy } = state;
  const removed = policy?.removedBuiltIns.length ?? 0;
  const onCount = policy?.sources.filter((source) => source.enabled).length ?? 0;
  const searchNote =
    policy?.mode === "any"
      ? "Searched first, then the rest of the web"
      : onCount > 0
        ? "Only these are searched"
        : null;

  return (
    <div className={cn("flex flex-col gap-5 px-3 py-3", className)}>
      {!inSettings && (
        <NoteBox icon={<Globe size={12} />}>
          <b className="font-semibold">Applies to all projects.</b> The Research agent is the only
          one that searches outside the project, and only as allowed here.
        </NoteBox>
      )}
      {state.error && <InlineError message={state.error} onDismiss={state.dismissError} />}
      {state.loading && !policy ? (
        <p role="status" className="text-sm text-fg-3">
          Loading Asset Search settings…
        </p>
      ) : !policy ? (
        <Button
          className="self-start"
          size="sm"
          variant="secondary"
          onClick={() => void state.reload()}
        >
          Retry
        </Button>
      ) : (
        <>
          <section className={section}>
            <SectionHeading title="Search mode" className={heading} />
            <ModeSwitch state={state} />
          </section>
          <section className={section}>
            <SectionHeading
              className={heading}
              title="Trusted sources"
              note={`${onCount} of ${policy.sources.length} on${searchNote ? ` · ${searchNote}` : ""}`}
            />
            <div className={BOX}>
              {policy.sources.length === 0 ? (
                <p className="px-3 py-2.5 text-sm text-fg-3">
                  No trusted sources. Add a website, or restore the built-in sources.
                </p>
              ) : (
                <ul aria-label="Trusted sources">
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
                      Add trusted source
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
                        Restore built-in sources ({removed})
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
            {policy.mode === "trusted" && onCount === 0 && (
              <p className="flex items-center gap-1 px-0.5 text-xs font-medium text-warning">
                <WarningCircle size={12} weight="fill" aria-hidden />
                All sources are off, so asset search will find nothing.
              </p>
            )}
          </section>
          <section className={section}>
            <SectionHeading title="Websites" className={heading} />
            <WebsitesBox state={state} enabled={policy.websites.readLinkedPages} />
          </section>
        </>
      )}
    </div>
  );
}
