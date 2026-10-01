import { useState } from "react";
import { Check, Copy, Globe, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import {
  LICENSE_STATUSES,
  type LicenseStatus,
  type ProjectSourceEntry,
} from "@hyperframes/agent-protocol";
import { Button, cn } from "../components/ui";
import { copyTextToClipboard } from "../utils/clipboard";
import {
  LICENSE_STATUS_GROUPS,
  LICENSE_STATUS_HINTS,
  LICENSE_STATUS_LABELS,
} from "./licenseLabels";
import { useResearchServices, useSourcesStore } from "./researchContext";
import { InlineError, NoteBox, SectionHeading } from "./researchUi";
import { SourceRecord } from "./SourceRecord";

type StatusFilter = LicenseStatus | "all";

const FILTERS: readonly StatusFilter[] = ["all", ...LICENSE_STATUSES];

function CopyCreditsButton({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      onClick={async () => {
        if (await copyTextToClipboard(lines.join("\n"))) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? "Copied" : "Copy Credits"}
    </Button>
  );
}

function Credits({ lines }: { lines: string[] }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label="Credits">
      <SectionHeading title="Credits" note={lines.length} />
      <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-bg-1 px-2.5 py-2 text-sm leading-[17px] text-fg select-text">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <p className="px-0.5 text-xs text-fg-3">
        Put these in the video's description or end credits.
      </p>
    </section>
  );
}

function EmptySources({ onOpenPolicy }: { onOpenPolicy: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
      <div className="mb-1.5 flex size-9 items-center justify-center rounded-lg border border-border bg-surface-1 text-fg-3">
        <ShieldCheck size={20} aria-hidden />
      </div>
      <h2 className="text-lg font-semibold text-fg">No researched assets yet</h2>
      <p className="max-w-[300px] text-sm text-fg-3 [text-wrap:pretty]">
        When the Research agent imports video, pictures or audio from outside the project, each
        asset appears here with its source, author and license.
      </p>
      <Button className="mt-2.5" size="md" variant="secondary" onClick={onOpenPolicy}>
        Asset Search settings
      </Button>
    </div>
  );
}

/** The license-status filter: the prototype's `.seg` with a count in every segment. */
function StatusFilterBar({
  records,
  value,
  onChange,
}: {
  records: ProjectSourceEntry[];
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter by license status"
      className="flex max-w-full shrink-0 items-center gap-0.5 self-start overflow-x-auto rounded-md border border-border bg-bg-0 p-0.5"
    >
      {FILTERS.map((option) => {
        // The segment counts what its filter shows: every record, present or not.
        const count =
          option === "all"
            ? records.length
            : records.filter((record) => record.licenseStatus === option).length;
        const pressed = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={pressed}
            title={option === "all" ? "Every researched asset" : LICENSE_STATUS_HINTS[option]}
            onClick={() => onChange(option)}
            className={cn(
              "inline-flex h-[18px] shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-fg-3 select-none",
              "transition-[background-color,color] duration-hover ease-standard hover:bg-surface-2 hover:text-fg",
              "aria-pressed:bg-surface-3 aria-pressed:text-fg aria-pressed:shadow-[inset_0_0_0_1px_var(--color-border-strong)]",
              "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
            )}
          >
            {option === "all" ? "All" : LICENSE_STATUS_LABELS[option]}
            <span className={cn("tabular-nums", pressed ? "text-fg-2" : "text-fg-3")}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The project's researched assets with their provenance and licenses, the credits they need, and a status filter. */
export function ProjectSources({ onOpenPolicy }: { onOpenPolicy: () => void }) {
  const { store } = useResearchServices();
  const projectId = useSourcesStore((state) => state.projectId);
  const status = useSourcesStore((state) => state.status);
  const view = useSourcesStore((state) => state.view);
  const error = useSourcesStore((state) => state.error);
  const revealed = useSourcesStore((state) => state.revealed);
  const [filter, setFilter] = useState<StatusFilter>("all");

  if (!view) {
    if (status === "error") {
      return (
        <div className="flex flex-col items-start gap-2 px-3 py-3">
          <InlineError message={`Couldn't load the project's sources. ${error ?? ""}`.trim()} />
          <Button size="sm" variant="secondary" onClick={() => void store.getState().reload()}>
            Retry
          </Button>
        </div>
      );
    }
    return (
      <p role="status" className="px-3 py-3 text-sm text-fg-3">
        Loading sources…
      </p>
    );
  }
  if (view.records.length === 0) return <EmptySources onOpenPolicy={onOpenPolicy} />;

  const { summary } = view;
  const shown =
    filter === "all"
      ? view.records
      : view.records.filter((record) => record.licenseStatus === filter);
  const warned = summary.restricted + summary.unknown;
  const groups =
    filter === "all"
      ? LICENSE_STATUS_GROUPS.map((group) => ({
          ...group,
          records: shown.filter((record) => record.licenseStatus === group.status),
        })).filter((group) => group.records.length > 0)
      : [{ status: filter, label: LICENSE_STATUS_LABELS[filter], records: shown }];

  return (
    <div className="flex flex-col gap-3 px-3 pt-3 pb-4">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <h2 className="text-md leading-4 font-semibold text-fg">Sources &amp; Licenses</h2>
          <p className="mt-0.5 text-sm text-fg-3 [text-wrap:pretty]" data-testid="sources-summary">
            <span className="text-fg-2">
              {summary.total} {summary.total === 1 ? "asset" : "assets"}
            </span>{" "}
            from outside the project
            {warned > 0 && (
              <span className="text-warning">
                {" "}
                · {warned} {warned === 1 ? "needs" : "need"} a license check
              </span>
            )}
            {summary.missingFiles > 0 && (
              <span className="text-error">
                {" "}
                · {summary.missingFiles} missing {summary.missingFiles === 1 ? "file" : "files"}
              </span>
            )}
          </p>
        </div>
        {view.credits.length > 0 && <CopyCreditsButton lines={view.credits} />}
      </header>
      {error && <InlineError message={`Couldn't refresh the sources. ${error}`} />}
      <StatusFilterBar records={view.records} value={filter} onChange={setFilter} />
      {warned > 0 && (
        <NoteBox warn icon={<WarningCircle size={12} weight="fill" />}>
          Export isn't blocked. The {warned} {warned === 1 ? "asset" : "assets"} without a clear
          license {warned === 1 ? "is" : "are"} listed when you export.
        </NoteBox>
      )}
      <NoteBox icon={view.mode === "any" ? <Globe size={12} /> : <ShieldCheck size={12} />}>
        Research searches {view.mode === "any" ? "any public source" : "trusted sources only"}.{" "}
        <button
          type="button"
          onClick={onOpenPolicy}
          className="rounded-xs text-fg-2 underline decoration-border-strong underline-offset-2 outline-hidden hover:text-fg hover:decoration-fg-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          Change
        </button>
      </NoteBox>
      {shown.length === 0 ? (
        <p className="py-[18px] text-center text-sm text-fg-3">No assets with this status.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {groups.map((group) => (
            <section key={group.status} className="flex flex-col gap-1.5">
              <SectionHeading title={group.label} note={group.records.length} />
              <ul
                className="flex flex-col gap-1.5"
                aria-label={`Researched assets: ${group.label}`}
              >
                {group.records.map((record) => (
                  <SourceRecord
                    key={record.id}
                    record={record}
                    projectId={projectId ?? ""}
                    highlighted={record.asset === revealed}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {view.credits.length > 0 && <Credits lines={view.credits} />}
    </div>
  );
}
