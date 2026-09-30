import { useState } from "react";
import { ArrowCounterClockwise, Globe, Plus, Trash } from "@phosphor-icons/react";
import {
  ASSET_SEARCH_MODES,
  type AssetSearchMode,
  type TrustedSource,
} from "@hyperframes/agent-protocol";
import { Button, IconButton, Toggle, Tooltip, cn } from "../components/ui";
import { AddTrustedSourceForm } from "./AddTrustedSourceForm";
import { MEDIA_KIND_LABELS } from "./licenseLabels";
import { useResearchServices } from "./researchContext";
import { ExternalLink, InlineError, SectionHeading } from "./researchUi";
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

function ModeSwitch({ state }: { state: AssetSearchPolicyState }) {
  const mode = state.policy?.mode ?? "trusted";
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-label="Asset Search mode"
        className="flex h-ctl items-center gap-0.5 rounded-md border border-border-strong bg-bg-2 p-0.5"
      >
        {ASSET_SEARCH_MODES.map((option) => {
          const checked = option === mode;
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
                "h-full flex-1 rounded-sm px-2 text-step-11 font-medium outline-hidden transition-colors duration-hover",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
                "disabled:cursor-not-allowed",
                checked ? "bg-hover text-text-0" : "text-text-3 enabled:hover:text-text-1",
              )}
            >
              {MODE_COPY[option].label}
            </button>
          );
        })}
      </div>
      <p className="text-step-10 text-text-3" data-testid="asset-search-mode-description">
        {MODE_COPY[mode].description}
      </p>
    </div>
  );
}

function SourceRow({ source, state }: { source: TrustedSource; state: AssetSearchPolicyState }) {
  const [confirming, setConfirming] = useState(false);
  const busy = state.pending !== null;
  return (
    <li
      data-source-id={source.id}
      className="flex flex-col gap-1 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-step-11 font-semibold text-text-0">
          {source.name}
        </span>
        {source.builtIn && (
          <span className="shrink-0 rounded-sm border border-border-input bg-bg-2 px-1 text-step-10 text-text-3">
            Built-in
          </span>
        )}
        <Toggle
          label={`Use ${source.name}`}
          checked={source.enabled}
          disabled={busy}
          onCommit={(enabled) =>
            void state.change(source.id, (client) => client.updateSource(source.id, { enabled }))
          }
        />
        <Tooltip label="Remove source" side="bottom">
          <IconButton
            aria-label={`Remove ${source.name}`}
            size="sm"
            disabled={busy}
            icon={<Trash size={12} aria-hidden />}
            onClick={() => setConfirming(true)}
          />
        </Tooltip>
      </div>
      <p className="text-step-10 text-text-3">
        {source.kinds.map((kind) => MEDIA_KIND_LABELS[kind]).join(" · ")}
        {source.domains.length > 0 && <> · {source.domains.join(", ")}</>}
      </p>
      {(source.description || source.licenseNote) && (
        <p className="text-step-10 text-text-4">
          {[source.description, source.licenseNote].filter(Boolean).join(" ")}
        </p>
      )}
      {source.homepage && (
        <ExternalLink href={source.homepage} className="self-start text-step-10">
          {source.homepage.replace(/^https?:\/\//, "")}
        </ExternalLink>
      )}
      {confirming && (
        <div
          role="group"
          aria-label={`Confirm removing ${source.name}`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-bg-2 px-2 py-1.5 text-step-10 text-text-2"
        >
          <span>
            Remove {source.name}?{source.builtIn && " Restore built-in sources brings it back."}
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

/**
 * The global Asset Search policy: where the Research agent may search and download, for every project. The Studio
 * server enforces it; this is only where the user sets it.
 */
export function AssetSearchPolicyView() {
  const { client } = useResearchServices();
  const state = useAssetSearchPolicy(client);
  const [adding, setAdding] = useState(false);
  const { policy } = state;
  const removed = policy?.removedBuiltIns.length ?? 0;

  return (
    <div className="flex flex-col gap-4 px-3 py-3">
      <div className="flex items-start gap-2 rounded-md border border-border-input bg-bg-2 px-2.5 py-2 text-step-11 text-text-2">
        <Globe size={14} className="mt-px shrink-0 text-text-3" aria-hidden />
        <span>
          <span className="font-semibold text-text-1">Applies to all projects.</span> The Research
          agent is the only one that searches outside the project, and only as allowed here.
        </span>
      </div>
      {state.error && <InlineError message={state.error} onDismiss={state.dismissError} />}
      {state.loading && !policy ? (
        <p role="status" className="text-step-11 text-text-3">
          Loading Asset Search settings…
        </p>
      ) : !policy ? (
        <Button size="sm" variant="secondary" onClick={() => void state.reload()}>
          Retry
        </Button>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <SectionHeading title="Asset Search" />
            <ModeSwitch state={state} />
          </section>
          <section className="flex flex-col gap-2">
            <SectionHeading
              title={`Trusted sources (${policy.sources.filter((source) => source.enabled).length} on)`}
            />
            {policy.sources.length === 0 ? (
              <p className="text-step-11 text-text-3">
                No trusted sources. Add a website, or restore the built-in sources.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5" aria-label="Trusted sources">
                {policy.sources.map((source) => (
                  <SourceRow key={source.id} source={source} state={state} />
                ))}
              </ul>
            )}
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
          </section>
        </>
      )}
    </div>
  );
}
