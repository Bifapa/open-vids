import { Warning } from "@phosphor-icons/react";
import type { DesignLicenseFacts } from "@hyperframes/agent-protocol";
import { useTranslation } from "../i18n";
import { cn } from "../components/ui";
import { designChips } from "./designFacts";

/** A strip of palette colours; decorative besides its label, which lists the colours. */
export function Swatches({ colors, className }: { colors: readonly string[]; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={
        colors.length > 0
          ? t("studio.design.swatches", { colors: colors.join(", ") })
          : t("studio.design.swatches.none")
      }
      className={cn(
        "flex h-5 w-14 shrink-0 overflow-hidden rounded-sm border border-border bg-surface-2",
        className,
      )}
    >
      {colors.map((color) => (
        <span key={color} className="flex-1" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

/**
 * What the user should know about a system before relying on it: a font or logo whose licence nobody recorded (it is
 * checked before export) and a font installed on the author's machine but not stored with the system.
 */
export function DesignChips({ facts }: { facts: DesignLicenseFacts }) {
  const { t } = useTranslation();
  const chips = designChips(facts);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <ul
        aria-label={t("studio.design.chips.label")}
        className="m-0 flex list-none flex-wrap gap-1 p-0"
      >
        {chips.map((chip) => (
          <li
            key={chip.id}
            className="inline-flex max-w-full items-center gap-1 rounded-xs bg-warning-soft px-1.5 py-0.5 text-xs leading-[14px] font-medium text-warning"
          >
            <Warning size={10} weight="fill" aria-hidden className="shrink-0" />
            <span className="min-w-0 truncate">{chip.label}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-2xs leading-[13px] text-fg-3">
        {facts.unknownLicenses.length > 0 ? t("studio.design.chips.licenseNote") : null}{" "}
        {facts.nonPortableFonts.length > 0 ? t("studio.design.chips.portableNote") : null}
      </p>
    </div>
  );
}
