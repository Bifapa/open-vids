import { createContext, useContext } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type {
  MissingAssetNode,
  MissingResolution,
  ProjectSourceEntry,
  StoryGraph,
  StoryNode,
} from "@hyperframes/agent-protocol";
import { Button, cn } from "../components/ui";
import { LicenseChip } from "../research/LicenseChip";
import { t as translate, useTranslation } from "../i18n";
import { LICENSE_STATUS_LABELS } from "../research/licenseLabels";

/**
 * What the Story workspace knows about Research: whether it can be asked to find material now, how to ask, and the
 * provenance of the material it found (the project's Sources view, matched by asset path).
 */
export interface StoryResearch {
  /** Why Research cannot be asked now for any node (a turn runs, Research is off in the chat), or null. */
  blocker: string | null;
  /** Starts a `resolve` story turn for these Missing Asset nodes; null means every unlocked one. */
  find(missing: string[] | null): void;
  sourceOf(asset: string | null): ProjectSourceEntry | null;
  /** Brings the Sources panel forward on this asset's record. */
  showInSources(asset: string | null): void;
}

const StoryResearchContext = createContext<StoryResearch | null>(null);
export const StoryResearchProvider = StoryResearchContext.Provider;

/** Null outside the Story workspace (a card rendered on its own shows no Research controls). */
export function useStoryResearch(): StoryResearch | null {
  return useContext(StoryResearchContext);
}

/** The Missing Asset nodes Research may resolve: agents never change a locked node. */
export function unlockedMissing(graph: StoryGraph | null): MissingAssetNode[] {
  return (graph?.nodes ?? []).filter(
    (node): node is MissingAssetNode => node.kind === "missing" && !node.locked,
  );
}

/** Why Research cannot resolve this node now, or null. */
export function findBlocker(research: StoryResearch, node: MissingAssetNode): string | null {
  if (node.locked) return translate("story.research.lockedBlocker");
  return research.blocker;
}

/** The Missing Asset node a material node resolved, when it resolved one. */
export function resolutionOf(node: StoryNode): MissingResolution | null {
  if (node.kind === "video" || node.kind === "picture" || node.kind === "music") {
    return node.resolvedFrom ?? null;
  }
  return null;
}

export function assetOf(node: StoryNode): string | null {
  if (node.kind === "video" || node.kind === "picture" || node.kind === "music") return node.asset;
  return null;
}

/** "Wikimedia Commons · CC BY 4.0", with the status in the tooltip. */
export function SourceLicenseChip({
  source,
  className,
}: {
  source: ProjectSourceEntry;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <LicenseChip
      status={source.licenseStatus}
      label={`${source.source.name} · ${source.license}`}
      title={t(
        source.source.trusted ? "story.research.chipTitleTrusted" : "story.research.chipTitleWeb",
        {
          name: source.source.name,
          license: source.license,
          status: t(LICENSE_STATUS_LABELS[source.licenseStatus]),
        },
      )}
      className={className}
    />
  );
}

/** "Find with Research" on a Missing Asset card or in its inspector; the reason shows when it cannot run. */
export function FindWithResearchButton({
  node,
  research,
  className,
  block,
}: {
  node: MissingAssetNode;
  research: StoryResearch;
  className?: string;
  /** Full width, as on a Missing Asset card. */
  block?: boolean;
}) {
  const { t } = useTranslation();
  const blocker = findBlocker(research, node);
  return (
    <span
      className={cn("hf-story-nodrag flex", block ? "w-full" : "self-start", className)}
      title={blocker ?? t("story.research.findTip")}
    >
      <Button
        size="sm"
        variant="secondary"
        disabled={blocker !== null}
        icon={<MagnifyingGlass size={12} className="text-fg-2" aria-hidden />}
        data-story-find={node.id}
        className={block ? "w-full" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          research.find([node.id]);
        }}
      >
        {t("story.research.find")}
      </Button>
    </span>
  );
}

/** A resolved node's card line: who found it, for what, and under which license. */
export function ResolvedCardLine({
  node,
  resolution,
  research,
}: {
  node: StoryNode;
  resolution: MissingResolution;
  research: StoryResearch | null;
}) {
  const { t } = useTranslation();
  const source = research?.sourceOf(assetOf(node)) ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-1" data-story-resolved={resolution.missing}>
      <span className="flex items-center gap-1 text-2xs font-medium text-fg-2">
        <MagnifyingGlass size={10} weight="bold" className="text-success" aria-hidden />
        {resolution.turnId ? t("story.research.foundBy") : t("story.research.resolvedByYou")}
      </span>
      {resolution.need && (
        <span className="truncate text-2xs text-fg-3" title={resolution.need}>
          {t("story.research.cardFor", { need: resolution.need })}
        </span>
      )}
      {source && (
        <span className="flex min-w-0 items-center gap-1 text-2xs text-fg-3">
          <LicenseChip
            status={source.licenseStatus}
            label={source.license}
            title={t("story.research.cardLicenseTitle", {
              license: source.license,
              status: t(LICENSE_STATUS_LABELS[source.licenseStatus]),
              name: source.source.name,
            })}
            className="shrink-0"
          />
          <span className="truncate" title={source.source.name}>
            {source.source.trusted
              ? source.source.name
              : t("story.research.webSource", { name: source.source.name })}
          </span>
        </span>
      )}
    </div>
  );
}
