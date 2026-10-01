import { useState } from "react";
import { CheckCircle, Copy, FileCode, Lightning, Terminal, Warning } from "@phosphor-icons/react";
import { formatNumber, useTranslation } from "../i18n";
import { copyTextToClipboard } from "../utils/clipboard";
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

/** The prototype's Checks dialog: findings grouped by file, each a card with severity, message and fix. */
export function LintModal({
  findings,
  projectId,
  projectDir,
  kind = "checks",
  promptIntro = "Fix these lint issues",
  onClose,
}: {
  findings: LintFinding[];
  projectId: string;
  /** Real on-disk project directory for the agent prompt (not the browser URL). */
  projectDir?: string | null;
  /** Which findings these are — console errors must not masquerade as lint results. */
  kind?: "checks" | "console";
  /** First line of the copied agent prompt. */
  promptIntro?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  // Console errors carry no file: their group is the runtime, not a source file.
  const title = kind === "checks" ? t("shell.lint.title.checks") : t("shell.lint.title.console");
  const looseLabel =
    kind === "checks" ? t("shell.lint.group.composition") : t("shell.lint.group.runtime");

  const handleCopyToAgent = async () => {
    const lines = findings.map((f) => {
      let line = `[${f.severity}] ${f.message}`;
      if (f.file) line += `\n  File: ${f.file}`;
      if (f.fixHint) line += `\n  Fix: ${f.fixHint}`;
      return line;
    });
    const pathLine = projectDir ? `Project path: ${projectDir}\n\n` : "";
    const text = `${promptIntro} for project "${projectId}":\n\n${pathLine}${lines.join("\n\n")}`;
    const ok = await copyTextToClipboard(text);
    setCopyState(ok ? "copied" : "failed");
    setTimeout(() => setCopyState("idle"), ok ? 2000 : 3000);
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
          <>
            {copyState === "failed" && (
              <span role="alert" className="mr-auto text-xs text-error">
                {t("shell.lint.copyFailed")}
              </span>
            )}
            <Button
              variant="primary"
              size="sm"
              icon={<Copy size={12} aria-hidden />}
              onClick={() => void handleCopyToAgent()}
            >
              {copyState === "copied" ? t("shell.lint.copied") : t("shell.lint.copyToAgent")}
            </Button>
          </>
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
