import { useId, useRef, useState } from "react";
import { Check, Copy, WarningCircle, X } from "@phosphor-icons/react";
import type { ExportLicenseCheck } from "@hyperframes/agent-protocol";
import { Button, IconButton } from "../components/ui";
import { useTranslation } from "../i18n";
import { useDialogBehavior } from "../components/ui/useDialogBehavior";
import { copyTextToClipboard } from "../utils/clipboard";
import { LicenseChip } from "./LicenseChip";
import { useExportLicenseGate, type ExportDecision } from "./exportLicenseGate";
import { NoteBox, SectionHeading } from "./researchUi";

function ExportLicenseModal({
  check,
  onDecide,
}: {
  check: ExportLicenseCheck;
  onDecide: (decision: ExportDecision) => void;
}) {
  const { t } = useTranslation();
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
      className="hf-backdrop-in fixed inset-0 z-100 flex items-center justify-center bg-scrim px-4"
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
        className="flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-border bg-bg-1 text-sm text-fg shadow-pop outline-hidden"
      >
        <header className="flex h-head shrink-0 items-center gap-1.5 border-b border-border-subtle pr-1 pl-3 select-none">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
            {t("research.export.title", { count })}
          </h2>
          <IconButton
            aria-label={t("common.close")}
            size="sm"
            icon={<X size={14} aria-hidden />}
            onClick={() => onDecide("cancel")}
          />
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 [scrollbar-color:var(--color-surface-3)_transparent]">
          <NoteBox warn icon={<WarningCircle size={12} weight="fill" />}>
            {t("research.export.note")}
          </NoteBox>
          <ul
            className="overflow-hidden rounded-md border border-border-subtle bg-bg-0"
            aria-label={t("research.export.warningsLabel")}
          >
            {check.warnings.map((warning) => (
              <li
                key={warning.asset}
                className="flex flex-col gap-1 border-border-subtle px-2.5 py-2 not-first:border-t"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-num text-fg"
                    title={warning.asset}
                  >
                    {warning.asset}
                  </span>
                  <LicenseChip status={warning.status} label={warning.license} size="md" />
                </div>
                <span className="text-xs leading-[15px] text-fg-3">
                  {/* The server's message names the asset for agents too; the row above already does. */}
                  {warning.message.startsWith(`${warning.asset}: `)
                    ? warning.message.slice(warning.asset.length + 2)
                    : warning.message}
                </span>
              </li>
            ))}
          </ul>
          {check.credits.length > 0 && (
            <section
              className="flex flex-col gap-1.5"
              aria-label={t("research.export.creditsLabel")}
            >
              <SectionHeading
                title={t("research.export.creditsTitle")}
                aside={
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    onClick={async () => {
                      if (await copyTextToClipboard(check.credits.join("\n"))) setCopied(true);
                    }}
                  >
                    {copied ? t("common.copied") : t("common.copy")}
                  </Button>
                }
              />
              <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-bg-0 px-2.5 py-2 text-sm leading-[17px] text-fg select-text">
                {check.credits.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </section>
          )}
        </div>
        <footer className="flex min-h-11 shrink-0 items-center justify-end gap-1.5 border-t border-border-subtle py-2 pr-2.5 pl-3">
          <Button size="sm" variant="ghost" onClick={() => onDecide("cancel")}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onDecide("review")}>
            {t("research.export.review")}
          </Button>
          <Button size="sm" variant="primary" onClick={() => onDecide("export")}>
            {t("research.export.anyway")}
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
