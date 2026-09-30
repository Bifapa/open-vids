import { useState } from "react";
import { Books, Check, Copy } from "@phosphor-icons/react";
import { LICENSE_STATUSES, type LicenseStatus } from "@hyperframes/agent-protocol";
import { Button, cn } from "../components/ui";
import { copyTextToClipboard } from "../utils/clipboard";
import { LICENSE_STATUS_HINTS, LICENSE_STATUS_LABELS, LICENSE_STATUS_TONES } from "./licenseLabels";
import { useResearchServices, useSourcesStore } from "./researchContext";
import { InlineError, SectionHeading } from "./researchUi";
import { SourceRecord } from "./SourceRecord";

type StatusFilter = LicenseStatus | "all";

const FILTERS: readonly StatusFilter[] = ["all", ...LICENSE_STATUSES];

function Credits({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="flex flex-col gap-1.5" aria-label="Credits">
      <SectionHeading
        title="Credits"
        aside={
          <Button
            size="sm"
            variant="ghost"
            icon={copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            onClick={async () => {
              if (await copyTextToClipboard(lines.join("\n"))) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        }
      />
      <div className="flex flex-col gap-1 rounded-md border border-border-input bg-bg-2 px-2.5 py-2 text-step-10 text-text-1 select-text">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <p className="text-step-10 text-text-4">
        Put these in the video's description or end credits.
      </p>
    </section>
  );
}

function EmptySources({ onOpenPolicy }: { onOpenPolicy: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <Books size={26} className="text-text-4" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="text-step-12 font-semibold text-text-1">No researched assets yet</p>
        <p className="text-step-11 text-text-3">
          When the Research agent imports video, pictures or audio from outside the project, each
          asset appears here with its source, author and license.
        </p>
      </div>
      <Button size="sm" variant="secondary" onClick={onOpenPolicy}>
        Asset Search settings
      </Button>
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
        <div className="flex flex-col gap-2 px-3 py-3">
          <InlineError message={`Couldn't load the project's sources. ${error ?? ""}`.trim()} />
          <Button size="sm" variant="secondary" onClick={() => void store.getState().reload()}>
            Retry
          </Button>
        </div>
      );
    }
    return (
      <p role="status" className="px-3 py-3 text-step-11 text-text-3">
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

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {error && <InlineError message={`Couldn't refresh the sources. ${error}`} />}
      <p className="text-step-11 text-text-2" data-testid="sources-summary">
        <span className="font-semibold text-text-0">
          {summary.total} {summary.total === 1 ? "asset" : "assets"}
        </span>
        {warned > 0 && (
          <span className="text-container">
            {" "}
            · {warned} {warned === 1 ? "needs" : "need"} a license check
          </span>
        )}
        {summary.missingFiles > 0 && (
          <span className="text-danger">
            {" "}
            · {summary.missingFiles} missing {summary.missingFiles === 1 ? "file" : "files"}
          </span>
        )}
      </p>
      <p className="text-step-10 text-text-3">
        Research searches {view.mode === "any" ? "any public source" : "trusted sources only"}.{" "}
        <button
          type="button"
          onClick={onOpenPolicy}
          className="rounded-xs text-selection underline-offset-2 outline-hidden hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          Change
        </button>
      </p>
      <div role="group" aria-label="Filter by license status" className="flex flex-wrap gap-1">
        {FILTERS.map((option) => {
          // The chip counts what its filter shows: every record, present or not.
          const count =
            option === "all"
              ? view.records.length
              : view.records.filter((record) => record.licenseStatus === option).length;
          const pressed = filter === option;
          let tone = "border-border-input text-text-3 hover:text-text-1";
          if (pressed) {
            tone =
              option === "all"
                ? "border-border-strong bg-hover text-text-0"
                : LICENSE_STATUS_TONES[option];
          }
          return (
            <button
              key={option}
              type="button"
              aria-pressed={pressed}
              title={option === "all" ? "Every researched asset" : LICENSE_STATUS_HINTS[option]}
              onClick={() => setFilter(option)}
              className={cn(
                "flex h-ctl-sm items-center gap-1 rounded-sm border px-1.5 text-step-10 font-medium outline-hidden transition-colors duration-hover",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
                tone,
              )}
            >
              {option === "all" ? "All" : LICENSE_STATUS_LABELS[option]}
              <span className="tabular-nums opacity-80">{count}</span>
            </button>
          );
        })}
      </div>
      {shown.length === 0 ? (
        <p className="text-step-11 text-text-3">No assets with this status.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Researched assets">
          {shown.map((record) => (
            <SourceRecord
              key={record.id}
              record={record}
              projectId={projectId ?? ""}
              highlighted={record.asset === revealed}
            />
          ))}
        </ul>
      )}
      {view.credits.length > 0 && <Credits lines={view.credits} />}
    </div>
  );
}
