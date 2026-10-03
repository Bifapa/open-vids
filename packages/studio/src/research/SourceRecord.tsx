import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  File,
  FilmStrip,
  Image,
  MusicNotes,
  Sparkle,
  TextAa,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import {
  WEBSITE_SOURCE_ID,
  type ProjectSourceEntry,
  type ProvenanceMediaKind,
} from "@hyperframes/agent-protocol";
import { Badge, cn } from "../components/ui";
import { formatDate, useTranslation } from "../i18n";
import { projectFileUrl, storyFrameUrl } from "../story/storyClient";
import { LicenseChip } from "./LicenseChip";
import { CONFIDENCE_LABELS, MEDIA_KIND_LABELS, retrievedByLabel, urlHost } from "./licenseLabels";
import { ExternalLink } from "./researchUi";

const KIND_ICONS: Record<ProvenanceMediaKind, Icon> = {
  video: FilmStrip,
  picture: Image,
  audio: MusicNotes,
  font: TextAa,
  animation: Sparkle,
  file: File,
};

function thumbnailUrl(projectId: string, record: ProjectSourceEntry): string | null {
  if (!record.present) return null;
  if (record.mediaKind === "picture") return projectFileUrl(projectId, record.asset);
  if (record.mediaKind === "video") return storyFrameUrl(projectId, record.asset, 0, 160);
  return null;
}

function Thumbnail({ projectId, record }: { projectId: string; record: ProjectSourceEntry }) {
  const src = thumbnailUrl(projectId, record);
  const [failed, setFailed] = useState<string | null>(null);
  const KindIcon = KIND_ICONS[record.mediaKind];
  return (
    <div
      className={cn(
        "relative flex aspect-video w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-xs bg-stage",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_var(--color-edge-hi)] after:content-['']",
      )}
    >
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          className="size-full object-cover"
        />
      ) : (
        <KindIcon size={14} className="text-fg-3" aria-hidden />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-3">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-fg">
        {children}
      </dd>
    </>
  );
}

/** One researched asset: what it is, where it came from, under which license, who brought it in, where it is used. */
export function SourceRecord({
  record,
  projectId,
  highlighted,
}: {
  record: ProjectSourceEntry;
  projectId: string;
  highlighted: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  const retrieved = formatDate(record.retrievedAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <li
      ref={ref}
      data-source-record={record.asset}
      className={cn(
        "flex flex-col gap-2 rounded-md border px-2 py-2",
        highlighted ? "border-accent-line bg-accent-soft" : "border-border-subtle bg-bg-1",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Thumbnail projectId={projectId} record={record} />
        <div className="grid min-w-0 flex-1 gap-px">
          <span className="truncate text-sm text-fg" title={record.title}>
            {record.title}
          </span>
          <span className="truncate text-xs text-fg-3" title={record.asset}>
            {t(MEDIA_KIND_LABELS[record.mediaKind])} ·{" "}
            <span className="font-mono text-num">{record.asset}</span>
          </span>
        </div>
        <LicenseChip status={record.licenseStatus} size="md" />
      </div>
      {!record.present && (
        <span className="flex items-center gap-1 text-xs font-medium text-error">
          <WarningCircle size={12} weight="fill" aria-hidden />
          {t("research.record.missingFile")}
        </span>
      )}
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 px-0.5 text-sm">
        <Row label={t("research.row.license")}>
          {record.licenseUrl ? (
            <ExternalLink href={record.licenseUrl}>{record.license}</ExternalLink>
          ) : (
            <span>{record.license}</span>
          )}
          <span className="text-xs text-fg-3">
            · {t(CONFIDENCE_LABELS[record.licenseConfidence])}
          </span>
        </Row>
        {record.licenseBasis && <Row label={t("research.row.foundIn")}>{record.licenseBasis}</Row>}
        <Row label={t("research.row.source")}>
          {record.source.id === WEBSITE_SOURCE_ID ? (
            <>
              <Badge size="sm" title={t("research.record.siteTitle")}>
                {t("research.record.siteBadge")}
              </Badge>
              <span className="truncate">
                {t("research.record.fromSite", { name: record.source.name })}
              </span>
            </>
          ) : (
            <>
              <Badge
                size="sm"
                tone={record.source.trusted ? "success" : "neutral"}
                title={
                  record.source.trusted
                    ? t("research.record.trustedTitle")
                    : t("research.record.webTitle")
                }
              >
                {record.source.trusted ? t("research.record.trusted") : t("research.record.web")}
              </Badge>
              <span className="truncate">{record.source.name}</span>
            </>
          )}
        </Row>
        <Row label={t("research.row.author")}>
          {record.author && record.authorUrl ? (
            <ExternalLink href={record.authorUrl}>{record.author}</ExternalLink>
          ) : (
            <span className={cn(!record.author && "text-fg-3")}>
              {record.author ?? t("research.record.notStated")}
            </span>
          )}
        </Row>
        <Row label={t("research.row.links")}>
          <ExternalLink href={record.originalUrl}>
            {t("research.link.original", { host: urlHost(record.originalUrl) })}
          </ExternalLink>
          {record.pageUrl && (
            <ExternalLink href={record.pageUrl}>
              {t("research.link.page", { host: urlHost(record.pageUrl) })}
            </ExternalLink>
          )}
        </Row>
        <Row label={t("research.row.retrieved")}>
          <span>
            {t("research.record.retrievedBy", {
              date: retrieved,
              by: retrievedByLabel(record.retrievedBy),
            })}
          </span>
        </Row>
        {record.converted && <Row label={t("research.row.converted")}>{record.converted}</Row>}
        {record.need && <Row label={t("research.row.neededFor")}>{record.need}</Row>}
        <Row label={t("research.row.usedIn")}>
          {record.usedIn.length > 0 ? (
            record.usedIn.map((composition) => (
              <span key={composition} className="font-mono text-num text-fg-2">
                {composition}
              </span>
            ))
          ) : (
            <span className="text-fg-3">{t("research.record.notOnTimeline")}</span>
          )}
        </Row>
      </dl>
      {record.issues.length > 0 && (
        <ul
          className="flex flex-col gap-1 rounded-sm bg-warning-soft px-2 py-1.5"
          aria-label={t("research.record.issues")}
        >
          {record.issues.map((issue) => (
            <li key={issue} className="flex items-start gap-1.5 text-xs text-warning">
              <WarningCircle size={12} weight="fill" className="mt-px shrink-0" aria-hidden />
              {issue}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
