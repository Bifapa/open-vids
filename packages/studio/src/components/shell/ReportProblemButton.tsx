import { Bug } from "@phosphor-icons/react";
import { useTranslation } from "../../i18n";
import { IconButton, Tooltip } from "../ui";

/**
 * Opens the desktop shell's "Report a problem" window (or focuses it when it is already open). Studio
 * has no home token, so this is the one call the home server accepts without it: a simple cross-origin
 * POST (text/plain, no-cors, opaque answer) that only opens a window — no data goes in or out. The
 * report itself is written and sent from that window.
 */
export function openReportWindow(homeOrigin: string): void {
  void fetch(`${homeOrigin}/api/report/open`, {
    method: "POST",
    mode: "no-cors",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ context: "studio" }),
  }).catch(() => {
    // The shell is gone or busy: nothing useful to tell the user from here.
  });
}

export function ReportProblemButton({ homeOrigin }: { homeOrigin: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("shell.header.reportProblem")} side="bottom">
      <IconButton
        aria-label={t("shell.header.reportProblem")}
        data-testid="header-report-problem"
        icon={<Bug size={14} />}
        onClick={() => openReportWindow(homeOrigin)}
      />
    </Tooltip>
  );
}
