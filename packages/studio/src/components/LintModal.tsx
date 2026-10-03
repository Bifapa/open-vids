import {
  CheckCircle,
  FileCode,
  Lightning,
  Sparkle,
  Terminal,
  Warning,
} from "@phosphor-icons/react";
import { useComposerRequestStore } from "../agent/composerRequest";
import { formatNumber, t as translate, useTranslation } from "../i18n";
import { useDockLayoutStore } from "./dock/dockLayoutStore";
import { Badge, Button, Dialog } from "./ui";

export interface LintFinding {
  severity: "error" | "warning";
  message: string;
  file?: string;
  fixHint?: string;
}

/** Findings grouped by file, in first-seen order; file-less findings share one group. */
function groupByFile(findings: LintFinding[]): Array<[string | null, LintFinding[]]> {
  const groups = new Map<string | null, LintFinding[]>();
  for (const finding of findings) {
    const key = finding.file ?? null;
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  return [...groups];
}

/** The chat message that hands the findings to the agent: an instruction, then one entry per finding. */
export function findingsAgentMessage(findings: LintFinding[], kind: "checks" | "console"): string {
  const intro =
    kind === "checks"
      ? translate("shell.lint.agentMessage.checks")
      : translate("shell.lint.agentMessage.console");
  const entries = findings.map((finding) => {
    const severity =
      finding.severity === "error"
        ? translate("shell.lint.severity.error")
        : translate("shell.lint.severity.warning");
    let entry = `- ${severity}${finding.file ? ` (${finding.file})` : ""}: ${finding.message}`;
    if (finding.fixHint)
      entry += `\n  ${translate("shell.lint.agentMessage.fix")}: ${finding.fixHint}`;
    return entry;
  });
  return `${intro}\n\n${entries.join("\n")}`;
}

/**
 * The prototype's Checks dialog: findings grouped by file, each a card with severity, message and fix. "Fix with
 * Agent" closes it and sends the findings to the open chat (into the composer instead when a turn is running or
 * the user has typed something there).
 */
export function LintModal({
  findings,
  kind = "checks",
  onClose,
}: {
  findings: LintFinding[];
  /** Which findings these are — console errors must not masquerade as lint results. */
  kind?: "checks" | "console";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  // Console errors carry no file: their group is the runtime, not a source file.
  const title = kind === "checks" ? t("shell.lint.title.checks") : t("shell.lint.title.console");
  const looseLabel =
    kind === "checks" ? t("shell.lint.group.composition") : t("shell.lint.group.runtime");

  const handleFixWithAgent = () => {
    useComposerRequestStore.getState().ask(findingsAgentMessage(findings, kind), { send: true });
    useDockLayoutStore.getState().activatePanel("chat");
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      meta={
        findings.length > 0
          ? t("shell.lint.summary", { errors, warnings })
          : t("shell.lint.noIssues")
      }
      className="w-[min(640px,calc(100vw-2rem))] max-h-[min(720px,calc(100vh-6rem))]"
      footer={
        findings.length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            icon={<Sparkle size={12} aria-hidden />}
            onClick={handleFixWithAgent}
          >
            {t("shell.lint.fixWithAgent")}
          </Button>
        ) : undefined
      }
    >
      {findings.length === 0 ? (
        <div className="grid justify-items-center gap-1.5 py-8 text-center">
          <CheckCircle size={20} weight="fill" className="text-success" aria-hidden />
          <p className="m-0 font-semibold text-fg">{t("shell.lint.allPassed")}</p>
          <p className="m-0 text-xs text-fg-3">{t("shell.lint.noneFound")}</p>
        </div>
      ) : (
        <div className="-mx-3 -my-3 pb-2 pt-1">
          {groupByFile(findings).map(([file, group]) => (
            <section
              key={file ?? ""}
              className="border-t border-border-subtle px-3 pb-1 pt-2 first:border-t-0"
            >
              <h3 className="m-0 flex h-[22px] items-center gap-1.5 text-xs font-semibold text-fg-2">
                {file ? (
                  <FileCode size={12} className="text-fg-3" aria-hidden />
                ) : (
                  <Terminal size={12} className="text-fg-3" aria-hidden />
                )}
                <span className={file ? "font-mono text-num font-medium" : undefined}>
                  {file ?? looseLabel}
                </span>
                <span className="font-normal text-fg-3">{formatNumber(group.length)}</span>
              </h3>
              {group.map((finding, index) => (
                <article
                  key={index}
                  className="my-1 grid gap-1.5 rounded-md border border-border-subtle bg-bg-0 py-2 pl-2.5 pr-2"
                >
                  <Badge
                    tone={finding.severity === "error" ? "error" : "warning"}
                    className="justify-self-start"
                  >
                    <Warning size={11} weight="bold" aria-hidden />
                    {finding.severity === "error"
                      ? t("shell.lint.severity.error")
                      : t("shell.lint.severity.warning")}
                  </Badge>
                  <p className="m-0 text-sm leading-[17px] text-fg text-pretty">
                    {finding.message}
                  </p>
                  {finding.fixHint && (
                    <p className="m-0 flex items-start gap-1.5 text-xs leading-[15px] text-fg-3 text-pretty">
                      <Lightning size={12} className="mt-px shrink-0" aria-hidden />
                      {finding.fixHint}
                    </p>
                  )}
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
