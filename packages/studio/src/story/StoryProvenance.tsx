import type { ReactNode } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import type {
  AssetSearchMode,
  MissingAssetNode,
  StoryMaterialNode,
} from "@hyperframes/agent-protocol";
import { Button } from "../components/ui";
import { CONFIDENCE_LABELS, retrievedByLabel, urlHost } from "../research/licenseLabels";
import { useSourcesStore } from "../research/researchContext";
import { ExternalLink } from "../research/researchUi";
import { Section } from "./inspectorFields";
import { formatAge } from "./storyFormat";
import { MISSING_KIND_LABELS } from "./storyKinds";
import {
  FindWithResearchButton,
  SourceLicenseChip,
  assetOf,
  findBlocker,
  resolutionOf,
  useStoryResearch,
} from "./storyResearch";

const MODE_LABELS: Record<AssetSearchMode, string> = {
  trusted: "trusted sources only",
  any: "any public source",
};

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-3">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-fg">
        {children}
      </dd>
    </>
  );
}

/** A Missing Asset node's way to Research: one turn that looks for this material and resolves the node with it. */
export function MissingResearchSection({ node }: { node: MissingAssetNode }) {
  const research = useStoryResearch();
  const mode = useSourcesStore((state) => state.view?.mode ?? null);
  if (!research) return null;
  const blocker = findBlocker(research, node);
  return (
    <Section title="Research">
      <p className="text-sm leading-[17px] text-fg-3">
        Research looks for this {MISSING_KIND_LABELS[node.mediaKind].toLowerCase()}
        {mode ? ` in ${MODE_LABELS[mode]}` : ""}, imports it with its license and replaces this node
        with it. Revert the turn to undo it all.
      </p>
      <FindWithResearchButton node={node} research={research} />
      {blocker && <p className="text-xs text-fg-3">{blocker}</p>}
      <button
        type="button"
        onClick={() => research.showInSources(null)}
        className="self-start rounded-sm text-sm text-fg-2 underline decoration-border-strong underline-offset-2 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
      >
        Open Sources & Licenses
      </button>
    </Section>
  );
}

/** Where a node's material came from when it resolved a Missing Asset node: the need, the turn, the provenance. */
export function ResolutionSection({ node }: { node: StoryMaterialNode }) {
  const research = useStoryResearch();
  const resolution = resolutionOf(node);
  if (!resolution) return null;
  const asset = assetOf(node);
  const source = research?.sourceOf(asset) ?? null;
  return (
    <Section title={resolution.turnId ? "Found by Research" : "Resolved"}>
      <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-sm">
        <Line label="Needed">{resolution.need || MISSING_KIND_LABELS[resolution.mediaKind]}</Line>
        <Line label="Resolved">
          {formatAge(resolution.at, Date.now())}
          {resolution.turnId && <span className="text-fg-3">· turn {resolution.turnId}</span>}
        </Line>
        {source && (
          <>
            <Line label="License">
              <SourceLicenseChip source={source} />
            </Line>
            <Line label="Confidence">
              {CONFIDENCE_LABELS[source.licenseConfidence]}
              {source.licenseBasis && <span className="text-fg-3">· {source.licenseBasis}</span>}
            </Line>
            <Line label="Author">
              {source.author && source.authorUrl ? (
                <ExternalLink href={source.authorUrl}>{source.author}</ExternalLink>
              ) : (
                (source.author ?? "Not stated")
              )}
            </Line>
            <Line label="Links">
              <ExternalLink href={source.originalUrl}>
                Original · {urlHost(source.originalUrl)}
              </ExternalLink>
              {source.pageUrl && (
                <ExternalLink href={source.pageUrl}>Page · {urlHost(source.pageUrl)}</ExternalLink>
              )}
              {source.licenseUrl && <ExternalLink href={source.licenseUrl}>License</ExternalLink>}
            </Line>
            <Line label="Retrieved">
              {new Date(source.retrievedAt).toLocaleDateString()} by{" "}
              {retrievedByLabel(source.retrievedBy)}
            </Line>
          </>
        )}
      </dl>
      {source && source.issues.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs font-medium text-warning">
          {source.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {!source && asset && (
        <p className="text-xs text-fg-3">
          No provenance record: this file came from the project, not from a search.
        </p>
      )}
      {research && source && (
        <Button
          size="sm"
          variant="secondary"
          icon={<ArrowSquareOut size={11} aria-hidden />}
          onClick={() => research.showInSources(asset)}
          className="self-start"
        >
          Show in Sources & Licenses
        </Button>
      )}
    </Section>
  );
}
