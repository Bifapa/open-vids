import { useEffect, useRef, useState, type ReactNode } from "react";
import { FilmStrip, Image, MusicNotes, WarningCircle, type Icon } from "@phosphor-icons/react";
import type { ProjectSourceEntry, ResearchMediaKind } from "@hyperframes/agent-protocol";
import { cn } from "../components/ui";
import { projectFileUrl, storyFrameUrl } from "../story/storyClient";
import { LicenseChip } from "./LicenseChip";
import { CONFIDENCE_LABELS, retrievedByLabel, urlHost } from "./licenseLabels";
import { ExternalLink } from "./researchUi";

const KIND_ICONS: Record<ResearchMediaKind, Icon> = {
  video: FilmStrip,
  picture: Image,
  audio: MusicNotes,
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
    <div className="flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-bg-2">
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          className="h-full w-full object-cover"
        />
      ) : (
        <KindIcon size={16} className="text-text-3" aria-hidden />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-4">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-text-2">
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
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  const retrieved = new Date(record.retrievedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <li
      ref={ref}
      data-source-record={record.asset}
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-surface px-2.5 py-2",
        highlighted ? "border-selection ring-1 ring-selection" : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <Thumbnail projectId={projectId} record={record} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-step-11 font-semibold text-text-0">
              {record.title}
            </span>
            <LicenseChip status={record.licenseStatus} />
          </div>
          <span className="truncate font-mono text-step-10 text-text-4" title={record.asset}>
            {record.asset}
          </span>
          {!record.present && (
            <span className="flex items-center gap-1 text-step-10 font-medium text-danger">
              <WarningCircle size={10} weight="fill" aria-hidden />
              File missing from the project
            </span>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1 text-step-10">
        <Row label="License">
          {record.licenseUrl ? (
            <ExternalLink href={record.licenseUrl}>{record.license}</ExternalLink>
          ) : (
            <span className="text-text-1">{record.license}</span>
          )}
          <span className="text-text-4">· {CONFIDENCE_LABELS[record.licenseConfidence]}</span>
        </Row>
        {record.licenseBasis && <Row label="Found in">{record.licenseBasis}</Row>}
        <Row label="Source">
          <span
            className={cn(
              "rounded-sm border px-1 font-medium",
              record.source.trusted
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border-input bg-bg-2 text-text-2",
            )}
            title={
              record.source.trusted
                ? "Found on a trusted source"
                : "Found on the open web (Any source mode)"
            }
          >
            {record.source.trusted ? "Trusted" : "Web"}
          </span>
          <span className="truncate text-text-1">{record.source.name}</span>
        </Row>
        <Row label="Author">
          {record.author && record.authorUrl ? (
            <ExternalLink href={record.authorUrl}>{record.author}</ExternalLink>
          ) : (
            <span>{record.author ?? "Not stated"}</span>
          )}
        </Row>
        <Row label="Links">
          <ExternalLink href={record.originalUrl}>
            Original · {urlHost(record.originalUrl)}
          </ExternalLink>
          {record.pageUrl && (
            <ExternalLink href={record.pageUrl}>Page · {urlHost(record.pageUrl)}</ExternalLink>
          )}
        </Row>
        <Row label="Retrieved">
          <span>
            {retrieved} by {retrievedByLabel(record.retrievedBy)}
          </span>
        </Row>
        {record.converted && <Row label="Converted">{record.converted}</Row>}
        {record.need && <Row label="Needed for">{record.need}</Row>}
        <Row label="Used in">
          {record.usedIn.length > 0 ? (
            record.usedIn.map((composition) => (
              <span key={composition} className="font-mono text-text-1">
                {composition}
              </span>
            ))
          ) : (
            <span>Not on a timeline yet</span>
          )}
        </Row>
      </dl>
      {record.issues.length > 0 && (
        <ul className="flex flex-col gap-0.5" aria-label="Issues">
          {record.issues.map((issue) => (
            <li
              key={issue}
              className="flex items-start gap-1 text-step-10 font-medium text-container"
            >
              <WarningCircle size={10} weight="fill" className="mt-px shrink-0" aria-hidden />
              {issue}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
