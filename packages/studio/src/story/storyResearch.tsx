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
  if (node.locked) return "Locked: unlock it to let Research resolve it";
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
  return (
    <LicenseChip
      status={source.licenseStatus}
      label={`${source.source.name} · ${source.license}`}
      title={`${source.source.trusted ? "Trusted source" : "Web"}: ${source.source.name} · ${source.license} (${LICENSE_STATUS_LABELS[source.licenseStatus]})`}
      className={className}
    />
  );
}

/** "Find with Research" on a Missing Asset card or in its inspector; the reason shows when it cannot run. */
export function FindWithResearchButton({
  node,
  research,
  className,
}: {
  node: MissingAssetNode;
  research: StoryResearch;
  className?: string;
}) {
  const blocker = findBlocker(research, node);
  return (
    <span
      className={cn("hf-story-nodrag flex self-start", className)}
      title={
        blocker ?? "Research looks for this material and resolves the node with what it imports"
      }
    >
      <Button
        size="sm"
        variant="secondary"
        disabled={blocker !== null}
        icon={<MagnifyingGlass size={11} aria-hidden />}
        data-story-find={node.id}
        onClick={(event) => {
          event.stopPropagation();
          research.find([node.id]);
        }}
      >
        Find with Research
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
  const source = research?.sourceOf(assetOf(node)) ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 pt-0.5" data-story-resolved={resolution.missing}>
      <span className="flex items-center gap-1 text-step-10 font-medium text-accent">
        <MagnifyingGlass size={10} weight="bold" aria-hidden />
        {resolution.turnId ? "Found by Research" : "Resolved by you"}
      </span>
      {resolution.need && (
        <span className="truncate text-step-10 text-text-3" title={resolution.need}>
          For: {resolution.need}
        </span>
      )}
      {source && (
        <span className="flex min-w-0 items-center gap-1 text-step-10 text-text-3">
          <LicenseChip
            status={source.licenseStatus}
            label={source.license}
            title={`${source.license} (${LICENSE_STATUS_LABELS[source.licenseStatus]}) from ${source.source.name}`}
            className="shrink-0"
          />
          <span className="truncate" title={source.source.name}>
            {source.source.trusted ? "" : "Web · "}
            {source.source.name}
          </span>
        </span>
      )}
    </div>
  );
}
