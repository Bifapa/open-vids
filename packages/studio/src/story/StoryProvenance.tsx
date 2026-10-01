import type { ReactNode } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import type { MissingAssetNode, StoryMaterialNode } from "@hyperframes/agent-protocol";
import { Button } from "../components/ui";
import { formatDate, useTranslation } from "../i18n";
import { CONFIDENCE_LABELS, retrievedByLabel, urlHost } from "../research/licenseLabels";
import { useSourcesStore } from "../research/researchContext";
import { ExternalLink } from "../research/researchUi";
import { Section } from "./inspectorFields";
import { formatAge } from "./storyFormat";
import { MISSING_KIND_KEYS } from "./storyKinds";
import {
  FindWithResearchButton,
  SourceLicenseChip,
  assetOf,
  findBlocker,
  resolutionOf,
  useStoryResearch,
} from "./storyResearch";

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
  const { t } = useTranslation();
  const research = useStoryResearch();
  const mode = useSourcesStore((state) => state.view?.mode ?? null);
  if (!research) return null;
  const blocker = findBlocker(research, node);
  return (
    <Section title={t("story.research.title")}>
      <p className="text-sm leading-[17px] text-fg-3">
        {t("story.research.intro", { kind: node.mediaKind, mode: mode ?? "none" })}
      </p>
      <FindWithResearchButton node={node} research={research} />
      {blocker && <p className="text-xs text-fg-3">{blocker}</p>}
      <button
        type="button"
        onClick={() => research.showInSources(null)}
        className="self-start rounded-sm text-sm text-fg-2 underline decoration-border-strong underline-offset-2 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t("story.research.openSources")}
      </button>
    </Section>
  );
}

/** Where a node's material came from when it resolved a Missing Asset node: the need, the turn, the provenance. */
export function ResolutionSection({ node }: { node: StoryMaterialNode }) {
  const { t } = useTranslation();
  const research = useStoryResearch();
  const resolution = resolutionOf(node);
  if (!resolution) return null;
  const asset = assetOf(node);
  const source = research?.sourceOf(asset) ?? null;
  return (
    <Section title={resolution.turnId ? t("story.research.foundBy") : t("story.research.resolved")}>
      <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-sm">
        <Line label={t("story.research.needed")}>
          {resolution.need || t(MISSING_KIND_KEYS[resolution.mediaKind])}
        </Line>
        <Line label={t("story.research.resolved")}>
          {formatAge(resolution.at, Date.now())}
          {resolution.turnId && (
            <span className="text-fg-3">· {t("research.by.turn", { id: resolution.turnId })}</span>
          )}
        </Line>
        {source && (
          <>
            <Line label={t("research.row.license")}>
              <SourceLicenseChip source={source} />
            </Line>
            <Line label={t("story.research.confidence")}>
              {t(CONFIDENCE_LABELS[source.licenseConfidence])}
              {source.licenseBasis && <span className="text-fg-3">· {source.licenseBasis}</span>}
            </Line>
            <Line label={t("research.row.author")}>
              {source.author && source.authorUrl ? (
                <ExternalLink href={source.authorUrl}>{source.author}</ExternalLink>
              ) : (
                (source.author ?? t("research.record.notStated"))
              )}
            </Line>
            <Line label={t("research.row.links")}>
              <ExternalLink href={source.originalUrl}>
                {t("research.link.original", { host: urlHost(source.originalUrl) })}
              </ExternalLink>
              {source.pageUrl && (
                <ExternalLink href={source.pageUrl}>
                  {t("research.link.page", { host: urlHost(source.pageUrl) })}
                </ExternalLink>
              )}
              {source.licenseUrl && (
                <ExternalLink href={source.licenseUrl}>{t("research.row.license")}</ExternalLink>
              )}
            </Line>
            <Line label={t("research.row.retrieved")}>
              {t("research.record.retrievedBy", {
                date: formatDate(source.retrievedAt, {
                  year: "numeric",
                  month: "numeric",
                  day: "numeric",
                }),
                by: retrievedByLabel(source.retrievedBy),
              })}
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
      {!source && asset && <p className="text-xs text-fg-3">{t("story.research.noProvenance")}</p>}
      {research && source && (
        <Button
          size="sm"
          variant="secondary"
          icon={<ArrowSquareOut size={11} aria-hidden />}
          onClick={() => research.showInSources(asset)}
          className="self-start"
        >
          {t("story.research.showInSources")}
        </Button>
      )}
    </Section>
  );
}
