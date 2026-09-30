import { useId, useRef, useState } from "react";
import { Check, Copy, WarningCircle, X } from "@phosphor-icons/react";
import type { ExportLicenseCheck } from "@hyperframes/agent-protocol";
import { Button, IconButton } from "../components/ui";
import { useDialogBehavior } from "../components/ui/useDialogBehavior";
import { copyTextToClipboard } from "../utils/clipboard";
import { LicenseChip } from "./LicenseChip";
import { useExportLicenseGate, type ExportDecision } from "./exportLicenseGate";
import { SectionHeading } from "./researchUi";

function ExportLicenseModal({
  check,
  onDecide,
}: {
  check: ExportLicenseCheck;
  onDecide: (decision: ExportDecision) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const { requestClose } = useDialogBehavior({
    open: true,
    onClose: () => onDecide("cancel"),
    containerRef,
  });
  const count = check.warnings.length;
  return (
    <div
      className="hf-backdrop-in fixed inset-0 z-100 flex items-center justify-center bg-bg-0/70 px-4 backdrop-blur-xs"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="export-license-dialog"
        className="flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-border-input bg-surface text-text-1 shadow-popover outline-hidden"
      >
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <WarningCircle
            size={18}
            weight="fill"
            className="mt-0.5 shrink-0 text-container"
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={titleId} className="text-step-13 font-semibold text-text-0">
              {count === 1
                ? "1 asset needs a license check"
                : `${count} assets need a license check`}
            </h2>
            <p className="text-step-11 text-text-2">
              This export uses researched material whose license is unknown or restricted. You can
              still export; check the licenses before you publish.
            </p>
          </div>
          <IconButton
            aria-label="Close"
            size="sm"
            icon={<X size={12} aria-hidden />}
            onClick={() => onDecide("cancel")}
          />
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <ul className="flex flex-col gap-1.5" aria-label="License warnings">
            {check.warnings.map((warning) => (
              <li
                key={warning.asset}
                className="flex flex-col gap-0.5 rounded-md border border-border bg-bg-2 px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-step-10 text-text-1"
                    title={warning.asset}
                  >
                    {warning.asset}
                  </span>
                  <LicenseChip status={warning.status} label={warning.license} />
                </div>
                <span className="text-step-10 text-text-3">
                  {/* The server's message names the asset for agents too; the row above already does. */}
                  {warning.message.startsWith(`${warning.asset}: `)
                    ? warning.message.slice(warning.asset.length + 2)
                    : warning.message}
                </span>
              </li>
            ))}
          </ul>
          {check.credits.length > 0 && (
            <section className="flex flex-col gap-1.5" aria-label="Credits">
              <SectionHeading
                title="Credits this export needs"
                aside={
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    onClick={async () => {
                      if (await copyTextToClipboard(check.credits.join("\n"))) setCopied(true);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                }
              />
              <div className="flex flex-col gap-1 rounded-md border border-border-input bg-bg-2 px-2.5 py-2 text-step-10 text-text-1 select-text">
                {check.credits.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </section>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={() => onDecide("cancel")}>
            Cancel
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onDecide("review")}>
            Review sources
          </Button>
          <Button size="sm" variant="primary" onClick={() => onDecide("export")}>
            Export anyway
          </Button>
        </footer>
      </div>
    </div>
  );
}

/** Studio's one export license dialog: shown while `startRender` waits on a check with warnings. */
export function ExportLicenseDialog() {
  const pending = useExportLicenseGate((state) => state.pending);
  const decide = useExportLicenseGate((state) => state.decide);
  if (!pending) return null;
  return <ExportLicenseModal check={pending} onDecide={decide} />;
}
